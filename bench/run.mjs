#!/usr/bin/env node
/**
 * Deterministic coordination bench: single-agent baseline vs a 3-worker swarm.
 *
 * This bench uses a fake child (no model calls) so it measures the coordination
 * machinery: worktree creation, dispatch, patch collection, review, merge
 * queue, and convergence. Swap FakeRunner for a real SubagentRunner to measure
 * model cost and quality; the report labels the current mode explicitly.
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { resolveConfig } from '../src/config.js'
import { SwarmService } from '../src/service.js'
import { git } from '../src/workspace.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const RESULTS = path.join(ROOT, 'bench', 'results')

class FakeRunner {
  constructor() {
    this.starts = 0
  }

  async start({ cwd, prompt }) {
    this.starts += 1
    const id = /^id: (\S+)$/m.exec(prompt)?.[1] ?? `task_${this.starts}`
    const short = id.replace(/[^A-Za-z0-9_-]/g, '').slice(-12)
    const file = path.join(cwd, 'src', `bench-${short}.js`)
    const result = new Promise((resolve) => {
      setImmediate(async () => {
        try {
          await fsp.mkdir(path.dirname(file), { recursive: true })
          await fsp.writeFile(file, `export const task = '${short}'\n`, 'utf8')
          await git(['add', '-A'], cwd)
          await git(['commit', '-m', `bench: ${short}`], cwd)
          resolve({
            stopReason: 'completed',
            structured: {
              summary: `bench patch ${short}`,
              tests: [{ name: 'bench gate', passed: true, output: 'ok' }],
            },
          })
        } catch (error) {
          resolve({ stopReason: 'error', diagnostic: String(error), structured: null })
        }
      })
    })
    return { childId: `bench-${id}`, result, dispose: () => undefined }
  }
}

async function makeRepo(workDir) {
  const repo = path.join(workDir, 'repo')
  await fsp.mkdir(path.join(repo, 'src'), { recursive: true })
  await fsp.mkdir(path.join(repo, 'test'), { recursive: true })
  await fsp.writeFile(
    path.join(repo, 'package.json'),
    '{"name":"swarm-bench","private":true,"type":"module","scripts":{"test":"node --test"}}\n',
    'utf8',
  )
  await fsp.writeFile(
    path.join(repo, 'test', 'bench.test.js'),
    "import assert from 'node:assert/strict'\nimport test from 'node:test'\ntest('bench repo healthy', () => assert.equal(1, 1))\n",
    'utf8',
  )
  await git(['init'], repo)
  await git(['checkout', '-b', 'main'], repo)
  await git(['config', 'user.email', 'bench@dsh-swarm.local'], repo)
  await git(['config', 'user.name', 'dsh-swarm bench'], repo)
  await git(['add', '-A'], repo)
  await git(['commit', '-m', 'bench base'], repo)
  return repo
}

function config(baseDir) {
  return resolveConfig({
    members: 4,
    budget: { tokens: 200_000 },
    orchestrator: { autoStart: true, tickMs: 600_000 },
    preflight: { enabled: true, minFreeMb: 0 },
    workspace: { enabled: true, root: '', diskThresholdMb: 0, keep: false },
    gate: { commands: ['node -e "process.exit(0)"'], autoDetect: false, timeoutMs: 30_000 },
    dispatch: { autoCommit: true, timeoutMs: 30_000, auto: false },
    review: { reviewersPerPatch: 1, quorum: 0.5, requireEvidence: true },
  })
}

async function waitFor(check, timeoutMs = 20_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = await check()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('bench timed out')
}

async function approveAndMerge(service, runId, taskId, tokens = 1_200) {
  const snapshot = await waitFor(async () => {
    const detail = await service.status(runId, true)
    const task = detail.tasks.find((item) => item.id === taskId)
    return task && (task.state === 'reviewing' || task.state === 'approved') ? detail : null
  })
  const task = snapshot.tasks.find((item) => item.id === taskId)
  const patchId = task.patchId
  if (task.dispatch?.childId) {
    await service.recordUsage(task.dispatch.childId, { inputTokens: tokens - 400, outputTokens: 400 })
  }
  if (task.state === 'reviewing') {
    const reviewers = snapshot.reviewers[patchId] ?? []
    for (const reviewerId of reviewers) {
      await service.reviewPatch(runId, patchId, {
        memberId: reviewerId,
        verdict: 'approve',
        evidence: ['node -e process.exit(0): passed'],
      })
    }
  }
  await service.mergePatch(runId, patchId, {})
  return patchId
}

async function runSingle(service, repo) {
  const started = Date.now()
  const run = await service.createRun({ goal: 'bench single', repo, mode: 'single', members: 1 }, {
    agent: { id: 'bench-parent' },
  })
  const worker = run.members[0]
  const { task } = await service.createTask(run.swarmId, {
    title: 'Implement the change',
    acceptance: ['bench gate passes'],
    files: ['src/all.js'],
  })
  await service.advertiseTask(run.swarmId, task.id)
  await service.awardTask(run.swarmId, task.id, { memberId: worker.id, force: true, reason: 'single baseline' })
  await service.dispatchTask(run.swarmId, task.id, {
    memberId: worker.id,
    fence: 1,
    wait: true,
  })
  await approveAndMerge(service, run.swarmId, task.id)
  await service.tickRun(run.swarmId)
  const snapshot = await service.status(run.swarmId)
  return {
    mode: 'single',
    tasks: 1,
    merged: snapshot.stats.merged,
    wallMs: Date.now() - started,
    tokens: snapshot.budget.run.tokens,
    calls: snapshot.budget.run.calls,
    status: snapshot.status,
  }
}

async function runSwarm(service, repo) {
  const started = Date.now()
  const run = await service.createRun(
    { goal: 'bench swarm', repo, members: 4, autoDispatch: true },
    { agent: { id: 'bench-parent' } },
  )
  const workers = run.members.filter((member) => member.role === 'worker')
  const tasks = []
  for (let index = 0; index < 3; index += 1) {
    const { task } = await service.createTask(run.swarmId, {
      title: `Implement module ${index + 1}`,
      acceptance: ['bench gate passes'],
      files: [`src/module-${index + 1}.js`],
    })
    await service.advertiseTask(run.swarmId, task.id)
    await service.awardTask(run.swarmId, task.id, {
      memberId: workers[index].id,
      force: true,
      reason: 'bench assignment',
    })
    tasks.push(task)
  }
  await service.tick()
  for (const task of tasks) await approveAndMerge(service, run.swarmId, task.id)
  await service.tickRun(run.swarmId)
  const snapshot = await service.status(run.swarmId)
  return {
    mode: 'swarm',
    tasks: 3,
    merged: snapshot.stats.merged,
    wallMs: Date.now() - started,
    tokens: snapshot.budget.run.tokens,
    calls: snapshot.budget.run.calls,
    status: snapshot.status,
  }
}

async function main() {
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-swarm-bench-'))
  const repo = await makeRepo(workDir)
  const single = new SwarmService({ config: config(path.join(workDir, 'single')), baseDir: path.join(workDir, 'single') })
  const swarm = new SwarmService({ config: config(path.join(workDir, 'swarm')), baseDir: path.join(workDir, 'swarm') })
  swarm.runner = new FakeRunner()
  single.runner = new FakeRunner()
  await single.open()
  await swarm.open()
  try {
    const baseline = await runSingle(single, repo)
    const result = await runSwarm(swarm, repo)
    const report = {
      suite: 'toy-coordination',
      runner: 'fake (no model calls)',
      environment: { node: process.version, platform: process.platform },
      baseline,
      swarm: result,
      ratios: {
        wall: baseline.wallMs > 0 ? Number((result.wallMs / baseline.wallMs).toFixed(2)) : null,
        token: baseline.tokens > 0 ? Number((result.tokens / baseline.tokens).toFixed(2)) : null,
      },
      at: new Date().toISOString(),
    }
    await fsp.mkdir(RESULTS, { recursive: true })
    await fsp.writeFile(path.join(RESULTS, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    const markdown = [
      '# dsh-swarm bench (latest)',
      '',
      `- runner: ${report.runner}`,
      `- node: ${process.version} / ${process.platform}`,
      `- at: ${report.at}`,
      '',
      '| mode | tasks | merged | wall ms | tokens | calls |',
      '| --- | --- | --- | --- | --- | --- |',
      `| single | ${baseline.tasks} | ${baseline.merged} | ${baseline.wallMs} | ${baseline.tokens} | ${baseline.calls} |`,
      `| swarm | ${result.tasks} | ${result.merged} | ${result.wallMs} | ${result.tokens} | ${result.calls} |`,
      '',
      `wall ratio: ${report.ratios.wall}x · token ratio: ${report.ratios.token}x`,
      '',
      '> Deterministic coordination bench; fake children do not call models. Use a real SubagentRunner for cost/quality benchmarks.',
      '',
    ].join('\n')
    await fsp.writeFile(path.join(RESULTS, 'latest.md'), markdown, 'utf8')
    console.log(markdown)
  } finally {
    await single.close()
    await swarm.close()
    await fsp.rm(workDir, { recursive: true, force: true })
  }
}

await main()
