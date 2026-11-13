import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { resolveConfig } from '../src/config.js'
import { SwarmService } from '../src/service.js'
import { git, safeGit } from '../src/workspace.js'

const PASS_GATE = 'node -e "process.exit(0)"'

async function initRepo() {
  const repo = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-swarm-dispatch-'))
  await git(['init'], repo)
  await git(['checkout', '-b', 'main'], repo)
  await git(['config', 'user.email', 'dispatch-test@example.com'], repo)
  await git(['config', 'user.name', 'Dispatch Test'], repo)
  await fsp.mkdir(path.join(repo, 'src'), { recursive: true })
  await fsp.writeFile(path.join(repo, 'src', 'app.js'), "export const base = true\n", 'utf8')
  await git(['add', '-A'], repo)
  await git(['commit', '-m', 'initial'], repo)
  return repo
}

/** Deterministic stand-in for a real model child. */
class FakeRunner {
  constructor(behavior = 'commit') {
    this.behavior = behavior
    this.prompts = []
    this.disposed = false
  }

  async start({ cwd, prompt }) {
    this.prompts.push(prompt)
    const self = this
    const result = new Promise((resolve) => {
      setImmediate(async () => {
        try {
          if (self.behavior === 'fail') {
            resolve({ stopReason: 'error', diagnostic: 'fake failure', structured: null })
            return
          }
          if (self.behavior === 'resolve') {
            const runId = path.basename(path.dirname(cwd))
            await safeGit(['merge', `swarm/${runId}/integration`], cwd)
            await fsp.writeFile(path.join(cwd, 'src', 'app.js'), 'export const resolved = true\n', 'utf8')
            await git(['add', '-A'], cwd)
            await git(['commit', '-m', 'resolve integration conflict'], cwd)
          }
          if (self.behavior === 'commit' || self.behavior === 'dirty') {
            await fsp.writeFile(
              path.join(cwd, 'src', 'dispatched.js'),
              'export const dispatched = true\n',
              'utf8',
            )
            if (self.behavior === 'commit') {
              await git(['add', '-A'], cwd)
              await git(['commit', '-m', 'dispatched change'], cwd)
            }
          }
          resolve({
            stopReason: 'completed',
            structured: {
              summary: 'implemented the dispatched change',
              tests: [{ name: 'fake check', passed: true, output: 'ok' }],
              risks: '',
            },
          })
        } catch (error) {
          resolve({ stopReason: 'error', diagnostic: String(error), structured: null })
        }
      })
    })
    return {
      childId: `child_${this.behavior}`,
      result,
      dispose: () => {
        self.disposed = true
      },
    }
  }
}

async function harness(t, behavior = 'commit', options = {}) {
  const baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-swarm-dispatch-base-'))
  const repo = await initRepo()
  const runner = new FakeRunner(behavior)
  const config = resolveConfig({
    members: 3,
    budget: { tokens: 100_000 },
    orchestrator: { autoStart: true, tickMs: 600_000 },
    preflight: { enabled: true, minFreeMb: 0 },
    gate: { commands: [PASS_GATE], autoDetect: false, timeoutMs: 30_000 },
    dispatch: { autoCommit: true, timeoutMs: 60_000, auto: options.auto === true },
  })
  const service = new SwarmService({ config, baseDir, runner })
  await service.open()
  t.after(async () => {
    await service.close()
    await fsp.rm(baseDir, { recursive: true, force: true })
    await fsp.rm(repo, { recursive: true, force: true })
  })
  const run = await service.createRun(
    { goal: 'dispatch flow', repo, members: 3 },
    { agent: { id: 'parent-agent' } },
  )
  const worker = run.members.find((member) => member.role === 'worker')
  const { task } = await service.createTask(run.swarmId, {
    title: 'Ship the dispatched change',
    acceptance: ['src/dispatched.js exists', 'git commit exists'],
    files: ['src/dispatched.js'],
  })
  await service.advertiseTask(run.swarmId, task.id)
  await service.bid(run.swarmId, task.id, { memberId: worker.id })
  const awarded = await service.awardTask(run.swarmId, task.id)
  return { service, repo, run, worker, task: awarded, runner }
}

test('dispatch runs a child, auto-collects the commit, and opens review', async (t) => {
  const { service, repo, run, worker, task, runner } = await harness(t)
  assert.match(task.worktree.path, /\.dsh-swarm[\\/]worktrees/)
  const dispatched = await service.dispatchTask(run.swarmId, task.id, {
    memberId: worker.id,
    fence: task.lease.fence,
    wait: true,
  })
  assert.equal(dispatched.taskState, 'reviewing')
  assert.equal(runner.prompts.length, 1)
  assert.match(runner.prompts[0], /acceptance criteria/)
  assert.match(runner.prompts[0], /git commit/)
  assert.match(runner.prompts[0], /src\/dispatched\.js/)
  assert.equal(runner.disposed, true)

  const detail = await service.status(run.swarmId, true)
  const patch = detail.patches.find((item) => item.id === dispatched.patchId)
  assert.deepEqual(patch.files, ['src/dispatched.js'])
  assert.match(patch.diffPath, /\.diff$/)
  const taskAfter = detail.tasks.find((item) => item.id === task.id)
  assert.equal(taskAfter.dispatch.status, 'finished')

  for (const reviewerId of dispatched.review.reviewers) {
    await service.reviewPatch(run.swarmId, dispatched.patchId, {
      memberId: reviewerId,
      verdict: 'approve',
      evidence: ['fake check: ok'],
    })
  }
  const merged = await service.mergePatch(run.swarmId, dispatched.patchId, {})
  assert.equal(merged.state, 'merged')
  await service.tickRun(run.swarmId)
  assert.equal((await service.status(run.swarmId)).status, 'converged')
  const status = await git(['status', '--porcelain'], repo)
  assert.equal(status.stdout, '')
})

test('dispatch auto-commits work the child left dirty', async (t) => {
  const { service, run, worker, task } = await harness(t, 'dirty')
  const dispatched = await service.dispatchTask(run.swarmId, task.id, {
    memberId: worker.id,
    fence: task.lease.fence,
    wait: true,
  })
  assert.equal(dispatched.taskState, 'reviewing')
  const detail = await service.status(run.swarmId, true)
  const patch = detail.patches.find((item) => item.id === dispatched.patchId)
  assert.deepEqual(patch.files, ['src/dispatched.js'])
  const events = service.runs.get(run.swarmId).log.events
  assert.equal(events.some((event) => event.type === 'swarm/intervened' && event.payload.action === 'auto_commit'), true)
})

test('a failed child records dispatch failure without submitting', async (t) => {
  const { service, run, worker, task } = await harness(t, 'fail')
  await assert.rejects(
    () =>
      service.dispatchTask(run.swarmId, task.id, {
        memberId: worker.id,
        fence: task.lease.fence,
        wait: true,
      }),
    (error) => error.code === 'DISPATCH_FAILED',
  )
  const detail = await service.status(run.swarmId, true)
  const taskAfter = detail.tasks.find((item) => item.id === task.id)
  assert.equal(taskAfter.state, 'awarded')
  assert.equal(taskAfter.dispatch.status, 'failed')
  assert.equal(detail.patches.length, 0)
})

async function waitFor(check, timeoutMs = 15_000) {
  const started = Date.now()
  let last
  while (Date.now() - started < timeoutMs) {
    last = await check()
    if (last) return last
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for condition (last=${JSON.stringify(last)})`)
}

async function approveAll(service, runId, patchId) {
  const snapshot = await service.status(runId, true)
  const reviewers = snapshot.reviewers[patchId] ?? []
  for (const reviewerId of reviewers) {
    await service.reviewPatch(runId, patchId, {
      memberId: reviewerId,
      verdict: 'approve',
      evidence: ['fake check: ok'],
    })
  }
}

test('the tick loop auto-dispatches awarded tasks when enabled', async (t) => {
  const { service, run, task } = await harness(t, 'commit', { auto: true })
  assert.equal((await service.status(run.swarmId)).dispatch.auto, true)

  await service.tick()
  const reviewing = await waitFor(async () => {
    const snapshot = await service.status(run.swarmId, true)
    return snapshot.tasks[0]?.state === 'reviewing' ? snapshot : null
  })
  const patch = reviewing.patches[0]
  assert.deepEqual(patch.files, ['src/dispatched.js'])
  await approveAll(service, run.swarmId, patch.id)
  await service.mergePatch(run.swarmId, patch.id, {})
  await service.tickRun(run.swarmId)
  assert.equal((await service.status(run.swarmId)).status, 'converged')
})

test('a conflict is auto-dispatched back to the author with the conflict card', async (t) => {
  const { service, run, worker, task } = await harness(t, 'resolve', { auto: true })
  const secondWorker = run.members.find((member) => member.role === 'worker' && member.id !== worker.id)
  const { task: otherTask } = await service.createTask(run.swarmId, {
    title: 'Edit the same file',
    acceptance: ['resolved file exists'],
    files: ['src/app.js'],
  })
  await service.advertiseTask(run.swarmId, otherTask.id)
  await service.bid(run.swarmId, otherTask.id, { memberId: secondWorker.id })
  const other = await service.awardTask(run.swarmId, otherTask.id)

  await fsp.writeFile(path.join(task.worktree.path, 'src/app.js'), 'export const first = true\n', 'utf8')
  await git(['add', '-A'], task.worktree.path)
  await git(['commit', '-m', 'first change'], task.worktree.path)
  await fsp.writeFile(path.join(other.worktree.path, 'src/app.js'), 'export const second = true\n', 'utf8')
  await git(['add', '-A'], other.worktree.path)
  await git(['commit', '-m', 'second change'], other.worktree.path)

  const submittedFirst = await service.submitPatch(run.swarmId, task.id, {
    memberId: worker.id,
    fence: task.lease.fence,
  })
  const submittedSecond = await service.submitPatch(run.swarmId, otherTask.id, {
    memberId: secondWorker.id,
    fence: other.lease.fence,
  })
  await approveAll(service, run.swarmId, submittedFirst.patchId)
  await approveAll(service, run.swarmId, submittedSecond.patchId)
  await service.mergePatch(run.swarmId, submittedFirst.patchId, {})
  await assert.rejects(
    () => service.mergePatch(run.swarmId, submittedSecond.patchId, {}),
    (error) => error.code === 'MERGE_CONFLICT',
  )

  // The scheduler notices the conflicted task and brings the author back with
  // the integration branch in the task card.
  await service.tick()
  const reviewing = await waitFor(async () => {
    const snapshot = await service.status(run.swarmId, true)
    const current = snapshot.tasks.find((item) => item.id === otherTask.id)
    return current?.state === 'reviewing' ? snapshot : null
  })
  const taskAfter = reviewing.tasks.find((item) => item.id === otherTask.id)
  assert.equal(taskAfter.lastConflict.files.includes('src/app.js'), true)
  const newPatch = [...reviewing.patches].reverse().find((patch) => patch.taskId === otherTask.id)
  assert.equal(newPatch.files.includes('src/app.js'), true)
  const prompt = service.runner.prompts.at(-1)
  assert.match(prompt, /## Conflict to resolve/)
  assert.match(prompt, new RegExp(`swarm/${run.swarmId}/integration`))

  await approveAll(service, run.swarmId, newPatch.id)
  const merged = await service.mergePatch(run.swarmId, newPatch.id, {})
  assert.equal(merged.state, 'merged')
  const integrationPath = path.join(path.dirname(task.worktree.path), 'integration')
  assert.match(await fsp.readFile(path.resolve(integrationPath, 'src/app.js'), 'utf8'), /resolved = true/)
})

test('child token usage is charged to the run, task, and member', async (t) => {
  const { service, run, worker, task } = await harness(t)
  await service.dispatchTask(run.swarmId, task.id, {
    memberId: worker.id,
    fence: task.lease.fence,
    wait: true,
  })
  const before = await service.status(run.swarmId)
  assert.equal(before.budget.run.tokens, 0)
  const recorded = await service.recordUsage('child_commit', { inputTokens: 1200, outputTokens: 300 })
  assert.equal(recorded, true)
  const snapshot = await service.status(run.swarmId, true)
  assert.equal(snapshot.budget.run.tokens, 1500)
  assert.equal(snapshot.budget.run.calls, 1)
  assert.equal(snapshot.budget.tasks[task.id].tokens, 1500)
  assert.equal(snapshot.budget.members[worker.id].tokens, 1500)
  assert.equal(
    service.runs.get(run.swarmId).log.events.some((event) => event.type === 'swarm/budget/charged'),
    true,
  )
  assert.equal(await service.recordUsage('unknown-child', { inputTokens: 10 }), false)
})

test('dispatch rejects tasks without a worktree', async (t) => {
  const baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-swarm-dispatch-nogit-'))
  const repo = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-swarm-dispatch-plain-'))
  const config = resolveConfig({
    members: 2,
    preflight: { enabled: true, minFreeMb: 0 },
    orchestrator: { autoStart: true },
    dispatch: { timeoutMs: 30_000 },
  })
  const service = new SwarmService({ config, baseDir, runner: new FakeRunner() })
  await service.open()
  t.after(async () => {
    await service.close()
    await fsp.rm(baseDir, { recursive: true, force: true })
    await fsp.rm(repo, { recursive: true, force: true })
  })
  const run = await service.createRun({ goal: 'plain', repo, members: 2 })
  const worker = run.members.find((member) => member.role === 'worker')
  const { task } = await service.createTask(run.swarmId, { title: 'x', acceptance: ['a'], files: [] })
  await service.advertiseTask(run.swarmId, task.id)
  const awarded = await service.awardTask(run.swarmId, task.id, { memberId: worker.id })
  assert.equal(awarded.worktree, null)
  await assert.rejects(
    () =>
      service.dispatchTask(run.swarmId, task.id, {
        memberId: worker.id,
        fence: awarded.lease.fence,
        wait: true,
      }),
    (error) => error.code === 'NO_WORKTREE',
  )
})
