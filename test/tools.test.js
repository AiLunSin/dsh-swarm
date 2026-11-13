import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { resolveConfig } from '../src/config.js'
import { SwarmService } from '../src/service.js'
import { createTools } from '../src/tools.js'

async function harness(t) {
  const baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-swarm-tools-'))
  const repo = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-swarm-tools-repo-'))
  const config = resolveConfig({
    members: 3,
    budget: { tokens: 100_000 },
    taskBudget: { tokens: 50_000 },
    orchestrator: { autoStart: true, tickMs: 600_000 },
    preflight: { enabled: true, minFreeMb: 0 },
  })
  const service = new SwarmService({ config, baseDir })
  await service.open()
  t.after(async () => {
    await service.close()
    await fsp.rm(baseDir, { recursive: true, force: true })
    await fsp.rm(repo, { recursive: true, force: true })
  })
  const tools = new Map(createTools(service).map((tool) => [tool.name, tool]))
  return { service, repo, tools }
}

test('the tool layer exposes twelve schema-complete swarm tools', async (t) => {
  const { tools } = await harness(t)
  assert.deepEqual([...tools.keys()].sort(), [
    'swarm_bid',
    'swarm_board',
    'swarm_dispatch',
    'swarm_inbox',
    'swarm_intervene',
    'swarm_merge',
    'swarm_message',
    'swarm_review',
    'swarm_start',
    'swarm_status',
    'swarm_submit',
    'swarm_task',
  ])
  for (const tool of tools.values()) {
    assert.equal(tool.parameters.type, 'object')
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.description, 'string')
    assert.ok(tool.output?.schema)
  }
})

test('tools drive a full run and render human summaries', async (t) => {
  const { service, repo, tools } = await harness(t)
  const start = await tools.get('swarm_start').execute({ goal: 'CSV export', repo, members: 3 })
  const worker = start.members.find((member) => member.role === 'worker')

  const created = await tools.get('swarm_task').execute({
    action: 'create',
    title: 'Implement toCsv',
    acceptance: ['npm test passes'],
    files: ['src/export.js'],
    tags: ['javascript'],
  })
  await tools.get('swarm_task').execute({ action: 'advertise', taskId: created.task.id })
  const bid = await tools.get('swarm_bid').execute({
    taskId: created.task.id,
    memberId: worker.id,
    estimate: { tokens: 20_000 },
    reason: 'module owner',
  })
  assert.equal(bid.accepted, true)

  const awarded = await tools.get('swarm_task').execute({ action: 'award', taskId: created.task.id })
  assert.equal(awarded.assignee, worker.id)
  const submitted = await tools.get('swarm_submit').execute({
    taskId: created.task.id,
    memberId: worker.id,
    fence: awarded.lease.fence,
    branch: 'swarm/csv',
    commit: 'abc',
    files: ['src/export.js'],
    tests: [{ name: 'csv', passed: true, output: 'ok' }],
  })
  assert.equal(submitted.taskState, 'reviewing')

  for (const reviewerId of submitted.review.reviewers) {
    await tools.get('swarm_review').execute({
      patchId: submitted.patchId,
      memberId: reviewerId,
      verdict: 'approve',
      evidence: ['npm test: 3 passed'],
    })
  }
  const merged = await tools.get('swarm_merge').execute({
    patchId: submitted.patchId,
    mergeCommit: 'def',
    gate: { passed: true, checks: [{ name: 'npm test', passed: true }] },
  })
  assert.equal(merged.state, 'merged')

  const board = await tools.get('swarm_board').execute({
    op: 'write',
    kind: 'fact',
    topic: 'export',
    content: 'toCsv streams rows',
    confidence: 0.9,
  })
  assert.equal(board.entry.topic, 'export')
  const query = await tools.get('swarm_board').execute({ op: 'query', topic: 'export' })
  assert.equal(query.entries.length, 1)

  await service.tickRun(start.swarmId)
  const status = await tools.get('swarm_status').execute({ detail: true })
  assert.equal(status.status, 'converged')
  const rendered = tools.get('swarm_status').output.render({}, status)
  assert.equal(rendered[0].type, 'text')
  assert.match(rendered[0].text, /status=converged/)
})

test('tool errors carry a stable code for the model', async (t) => {
  const { repo, tools } = await harness(t)
  await tools.get('swarm_start').execute({ goal: 'errors', repo, members: 2 })
  await assert.rejects(
    () => tools.get('swarm_task').execute({ action: 'create', title: 'no acceptance' }),
    (error) => error.code === 'TASK_INVALID' && error.info.name === 'SwarmError',
  )
})
