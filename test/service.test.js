import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { resolveConfig } from '../src/config.js'
import { verifyChain } from '../src/events.js'
import { SwarmService } from '../src/service.js'

async function makeService(t) {
  const baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-swarm-service-'))
  const repo = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-swarm-repo-'))
  const config = resolveConfig({
    members: 3,
    budget: { tokens: 100_000, usd: 0 },
    taskBudget: { tokens: 50_000 },
    memberBudget: { tokens: 60_000 },
    orchestrator: { autoStart: true, tickMs: 600_000 },
    preflight: { enabled: true, minFreeMb: 0 },
    review: { reviewersPerPatch: 2, quorum: 2 / 3, requireEvidence: true },
  })
  const service = new SwarmService({ config, baseDir })
  await service.open()
  t.after(async () => {
    await service.close()
    await fsp.rm(baseDir, { recursive: true, force: true })
    await fsp.rm(repo, { recursive: true, force: true })
  })
  return { service, repo, baseDir, config }
}

async function createRun(service, repo) {
  return service.createRun({ goal: 'Add CSV export with tests', repo, members: 3 })
}

async function setupAwardedTask(service, runId) {
  const created = await service.status(runId)
  const worker = created.members.find((member) => member.role === 'worker')
  const { task } = await service.createTask(runId, {
    title: 'Implement CSV writer',
    acceptance: ['npm test -- csv', 'exports 3 columns'],
    files: ['src/export.js'],
    tags: ['javascript'],
  })
  await service.advertiseTask(runId, task.id)
  await service.bid(runId, task.id, { memberId: worker.id, reason: 'owner of export module' })
  const awarded = await service.awardTask(runId, task.id)
  return { created, worker, task: awarded }
}

test('a swarm runs the full market -> work -> review -> merge -> converge path', async (t) => {
  const { service, repo } = await makeService(t)
  const run = await createRun(service, repo)
  assert.equal(run.swarmId.startsWith('swarm_'), true)
  assert.deepEqual(run.members.map((member) => member.name), ['queen', 'worker-1', 'worker-2'])
  assert.equal(run.members.every((member) => member.status === 'idle'), true)
  assert.equal(run.status, 'running')

  const { worker, task } = await setupAwardedTask(service, run.swarmId)
  assert.equal(task.state, 'awarded')
  assert.equal(task.assignee, worker.id)
  assert.equal(task.lease.fence, 1)

  const started = await service.startTask(run.swarmId, task.id, { memberId: worker.id, fence: task.lease.fence })
  assert.equal(started.state, 'working')

  const submitted = await service.submitPatch(run.swarmId, task.id, {
    memberId: worker.id,
    fence: task.lease.fence,
    branch: 'swarm/run/task',
    commit: 'abc123',
    files: ['src/export.js'],
    tests: [{ name: 'csv writer', passed: true, output: 'ok' }],
    notes: 'uses streaming rows',
  })
  assert.equal(submitted.taskState, 'reviewing')
  assert.equal(submitted.review.reviewers.length, 2)
  assert.equal(submitted.review.reviewers.includes(worker.id), false)

  const first = submitted.review.reviewers[0]
  const second = submitted.review.reviewers[1]
  const voteOne = await service.reviewPatch(run.swarmId, submitted.patchId, {
    memberId: first,
    verdict: 'approve',
    evidence: ['npm test -- csv: 12 passed'],
  })
  assert.equal(voteOne.taskState, 'reviewing')
  assert.equal(voteOne.tally.approvals, 1)
  const voteTwo = await service.reviewPatch(run.swarmId, submitted.patchId, {
    memberId: second,
    verdict: 'approve',
    evidence: ['src/export.js:1 exported function'],
  })
  assert.equal(voteTwo.taskState, 'approved')
  assert.equal(voteTwo.tally.passed, true)

  const merged = await service.mergePatch(run.swarmId, submitted.patchId, { mergeCommit: 'def456' })
  assert.equal(merged.state, 'merged')
  assert.equal(merged.assignee, null)

  await service.tickRun(run.swarmId)
  const final = await service.status(run.swarmId)
  assert.equal(final.status, 'converged')
  assert.equal(final.convergedReason, 'all_tasks_terminal')
  assert.equal(final.stats.merged, 1)
  assert.equal(final.budget.run.calls >= 0, true)
  verifyChain(service.runs.get(run.swarmId).log.events, { runId: run.swarmId })
})

test('recovery replays the same state and pauses a live run', async (t) => {
  const { service, repo, baseDir, config } = await makeService(t)
  const run = await createRun(service, repo)
  const { task, worker } = await setupAwardedTask(service, run.swarmId)
  await service.startTask(run.swarmId, task.id, { memberId: worker.id, fence: task.lease.fence })
  const before = await service.status(run.swarmId)
  const eventCount = service.runs.get(run.swarmId).log.events.length
  await service.close()

  const reopened = new SwarmService({ config, baseDir })
  await reopened.open()
  const after = await reopened.status(run.swarmId)
  assert.equal(after.status, 'paused')
  assert.equal(after.recovered, true)
  assert.equal(after.tasks.length, before.tasks.length)
  assert.equal(after.tasks[0].state, 'working')
  assert.ok(reopened.runs.get(run.swarmId).log.events.length >= eventCount + 2)
  verifyChain(reopened.runs.get(run.swarmId).log.events, { runId: run.swarmId })
  // 必须在用例体内关闭：t.after 是先进先出，makeService 的清理钩子会先删目录，
  // 此时重开的日志句柄仍占用文件，Windows 下会报 ENOTEMPTY。
  await reopened.close()
})

test('budget reserve/settle is reflected in the run snapshot', async (t) => {
  const { service, repo } = await makeService(t)
  const run = await createRun(service, repo)
  const worker = run.members.find((member) => member.role === 'worker')
  const reservation = await service.reserveBudget(run.swarmId, { memberId: worker.id, tokens: 10_000 })
  assert.equal(reservation.scope, 'member')
  await service.settleBudget(run.swarmId, reservation.id, { tokens: 8_000, wallMs: 120 })
  const snapshot = await service.status(run.swarmId)
  assert.equal(snapshot.budget.run.tokens, 8_000)
  assert.equal(snapshot.budget.run.calls, 1)
  assert.equal(snapshot.budget.run.reservedTokens, 0)
  await assert.rejects(
    () => service.reserveBudget(run.swarmId, { memberId: worker.id, tokens: 200_000 }),
    (error) => error.code === 'BUDGET_EXCEEDED',
  )
})

test('blackboard writes are redacted and ranked; pheromones decay on read', async (t) => {
  const { service, repo } = await makeService(t)
  const run = await createRun(service, repo)
  const written = await service.board(run.swarmId, {
    op: 'write',
    kind: 'fact',
    topic: 'export',
    content: 'The writer needs sk-abcdefghijklmnop123456 to call the API',
    confidence: 0.9,
    author: 'worker-1',
  })
  assert.equal(written.entry.content.includes('sk-abcdefghijklmnop'), false)
  await service.board(run.swarmId, {
    op: 'write',
    kind: 'warstory',
    topic: 'export',
    content: 'streaming rows avoids buffering the whole file',
    confidence: 0.8,
  })
  await service.board(run.swarmId, { op: 'deposit', topic: 'export', kind: 'success', delta: 1 })
  const query = await service.board(run.swarmId, { op: 'query', topic: 'export', topK: 5 })
  assert.equal(query.entries.length, 2)
  assert.ok(query.pheromones.length >= 1)
  assert.equal(query.entries[0].topic, 'export')
  assert.ok(query.tokens > 0)
})

test('pause blocks task writes and resume restores them', async (t) => {
  const { service, repo } = await makeService(t)
  const run = await createRun(service, repo)
  await service.intervene(run.swarmId, { action: 'pause', reason: 'review the plan' })
  assert.equal((await service.status(run.swarmId)).status, 'paused')
  await assert.rejects(
    () => service.createTask(run.swarmId, { title: 'x', acceptance: ['a'], files: [] }),
    (error) => error.code === 'RUN_NOT_RUNNING',
  )
  await service.intervene(run.swarmId, { action: 'resume', reason: 'go' })
  assert.equal((await service.status(run.swarmId)).status, 'running')
  const { task } = await service.createTask(run.swarmId, { title: 'x', acceptance: ['a'], files: [] })
  assert.equal(task.state, 'draft')
})

test('illegal task graphs, stale leases, and premature merges are rejected', async (t) => {
  const { service, repo } = await makeService(t)
  const run = await createRun(service, repo)
  await assert.rejects(
    () => service.createTask(run.swarmId, { title: 'x', acceptance: [], files: [] }),
    (error) => error.code === 'TASK_INVALID',
  )
  await assert.rejects(
    () => service.createTask(run.swarmId, { title: 'x', acceptance: ['a'], deps: ['missing'], files: [] }),
    (error) => error.code === 'TASK_NOT_FOUND',
  )

  const { task, worker } = await setupAwardedTask(service, run.swarmId)
  const other = (await service.status(run.swarmId)).members.find(
    (member) => member.role === 'worker' && member.id !== worker.id,
  )
  await assert.rejects(
    () =>
      service.submitPatch(run.swarmId, task.id, {
        memberId: other.id,
        fence: task.lease.fence,
        branch: 'swarm/other',
      }),
    (error) => error.code === 'TASK_INVALID_STATE' || error.code === 'STALE_LEASE',
  )
  await service.startTask(run.swarmId, task.id, { memberId: worker.id, fence: task.lease.fence })
  const submitted = await service.submitPatch(run.swarmId, task.id, {
    memberId: worker.id,
    fence: task.lease.fence,
    branch: 'swarm/run/task',
    files: ['src/export.js'],
  })
  await assert.rejects(
    () => service.mergePatch(run.swarmId, submitted.patchId, {}),
    (error) => error.code === 'TASK_INVALID_STATE',
  )
})

test('a timed-out review becomes an abstention and does not block the merge', async (t) => {
  const baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-swarm-timeout-'))
  const repo = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-swarm-timeout-repo-'))
  let now = 1_800_000_000_000
  const config = resolveConfig({
    members: 3,
    budget: { tokens: 100_000 },
    orchestrator: { autoStart: true, tickMs: 600_000 },
    preflight: { enabled: true, minFreeMb: 0 },
    review: { reviewersPerPatch: 2, quorum: 2 / 3, timeoutMs: 10_000, requireEvidence: true },
  })
  const service = new SwarmService({ config, baseDir, clock: () => now })
  await service.open()
  t.after(async () => {
    await service.close()
    await fsp.rm(baseDir, { recursive: true, force: true })
    await fsp.rm(repo, { recursive: true, force: true })
  })

  const run = await service.createRun({ goal: 'timeout run', repo, members: 3 })
  const worker = run.members.find((member) => member.role === 'worker')
  const { task } = await service.createTask(run.swarmId, {
    title: 'Timeout review',
    acceptance: ['npm test passes'],
    files: ['src/x.js'],
  })
  await service.advertiseTask(run.swarmId, task.id)
  await service.bid(run.swarmId, task.id, { memberId: worker.id })
  const awarded = await service.awardTask(run.swarmId, task.id)
  const submitted = await service.submitPatch(run.swarmId, task.id, {
    memberId: worker.id,
    fence: awarded.lease.fence,
    branch: 'swarm/timeout',
    files: ['src/x.js'],
  })
  assert.equal(submitted.review.reviewers.length, 2)
  const [approver, silent] = submitted.review.reviewers
  await service.reviewPatch(run.swarmId, submitted.patchId, {
    memberId: approver,
    verdict: 'approve',
    evidence: ['npm test: 1 passed'],
  })

  now += 11_000
  await service.tickRun(run.swarmId)
  const snapshot = await service.status(run.swarmId, true)
  const taskAfter = snapshot.tasks.find((item) => item.id === task.id)
  assert.equal(taskAfter.state, 'approved')
  assert.equal(snapshot.reviewTimeouts.length, 1)
  assert.deepEqual(snapshot.reviewTimeouts[0].reviewers, [silent])
  const abstain = snapshot.reviews.find(
    (review) => review.patchId === submitted.patchId && review.reviewerId === silent,
  )
  assert.equal(abstain.verdict, 'abstain')
})

test('a timed-out review with no approval blocks the task', async (t) => {  const baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-swarm-timeout2-'))
  const repo = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-swarm-timeout2-repo-'))
  let now = 1_800_000_000_000
  const config = resolveConfig({
    members: 3,
    budget: { tokens: 100_000 },
    orchestrator: { autoStart: true, tickMs: 600_000 },
    preflight: { enabled: true, minFreeMb: 0 },
    review: { reviewersPerPatch: 2, quorum: 2 / 3, timeoutMs: 10_000, requireEvidence: true },
  })
  const service = new SwarmService({ config, baseDir, clock: () => now })
  await service.open()
  t.after(async () => {
    await service.close()
    await fsp.rm(baseDir, { recursive: true, force: true })
    await fsp.rm(repo, { recursive: true, force: true })
  })

  const run = await service.createRun({ goal: 'timeout block', repo, members: 3 })
  const worker = run.members.find((member) => member.role === 'worker')
  const { task } = await service.createTask(run.swarmId, {
    title: 'Nobody reviews',
    acceptance: ['a'],
    files: [],
  })
  await service.advertiseTask(run.swarmId, task.id)
  await service.bid(run.swarmId, task.id, { memberId: worker.id })
  const awarded = await service.awardTask(run.swarmId, task.id)
  await service.submitPatch(run.swarmId, task.id, {
    memberId: worker.id,
    fence: awarded.lease.fence,
    branch: 'swarm/timeout2',
  })
  now += 11_000
  await service.tickRun(run.swarmId)
  const snapshot = await service.status(run.swarmId, true)
  assert.equal(snapshot.tasks.find((item) => item.id === task.id).state, 'blocked')
})

test('the judge converges a run that stopped making progress', async (t) => {
  const baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-swarm-stall-'))
  const repo = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-swarm-stall-repo-'))
  let now = 1_800_000_000_000
  const config = resolveConfig({
    members: 3,
    budget: { tokens: 100_000 },
    orchestrator: { autoStart: true, tickMs: 600_000 },
    preflight: { enabled: true, minFreeMb: 0 },
    convergence: { idleRounds: 3, maxRounds: 50, stallMs: 600_000 },
  })
  const service = new SwarmService({ config, baseDir, clock: () => now })
  await service.open()
  t.after(async () => {
    await service.close()
    await fsp.rm(baseDir, { recursive: true, force: true })
    await fsp.rm(repo, { recursive: true, force: true })
  })

  const run = await service.createRun({ goal: 'stalled', repo, members: 3 })
  await service.createTask(run.swarmId, { title: 'Nobody picks this up', acceptance: ['a'], files: [] })
  now += 610_000
  await service.tickRun(run.swarmId)
  const snapshot = await service.status(run.swarmId, true)
  assert.equal(snapshot.status, 'converged')
  assert.equal(snapshot.convergedReason, 'stalled_no_progress')
  assert.equal(snapshot.judgements.length, 1)
  assert.equal(snapshot.judgements[0].action, 'converge')
  assert.equal(snapshot.judgements[0].evidence.openTasks, 1)
})

test('a settled batch advances the round and records the judge decision', async (t) => {
  const { service, repo } = await makeService(t)
  const run = await service.createRun({ goal: 'rounds', repo, members: 3 })
  const worker = run.members.find((member) => member.role === 'worker')
  const { task: doneTask } = await service.createTask(run.swarmId, {
    title: 'First batch',
    acceptance: ['npm test passes'],
    files: ['src/a.js'],
  })
  await service.advertiseTask(run.swarmId, doneTask.id)
  await service.bid(run.swarmId, doneTask.id, { memberId: worker.id })
  const awarded = await service.awardTask(run.swarmId, doneTask.id)
  const submitted = await service.submitPatch(run.swarmId, doneTask.id, {
    memberId: worker.id,
    fence: awarded.lease.fence,
    branch: 'swarm/round-a',
    files: ['src/a.js'],
  })
  for (const reviewerId of submitted.review.reviewers) {
    await service.reviewPatch(run.swarmId, submitted.patchId, {
      memberId: reviewerId,
      verdict: 'approve',
      evidence: ['npm test: 1 passed'],
    })
  }
  await service.mergePatch(run.swarmId, submitted.patchId, {})

  const { task: queued } = await service.createTask(run.swarmId, {
    title: 'Next round work',
    acceptance: ['b'],
    files: ['src/b.js'],
  })
  await service.advertiseTask(run.swarmId, queued.id)
  await service.tickRun(run.swarmId)
  const snapshot = await service.status(run.swarmId, true)
  assert.equal(snapshot.round, 2)
  assert.equal(snapshot.roundHistory.length, 1)
  assert.equal(snapshot.roundHistory[0].action, 'continue')
  assert.equal(snapshot.roundHistory[0].metrics.merges, 1)
  assert.equal(snapshot.judgements.at(-1).action, 'continue')
})

test('a split review with no decision escalates instead of hanging', async (t) => {
  const { service, repo } = await makeService(t)
  const run = await service.createRun({ goal: 'deadlock', repo, members: 3 })
  const worker = run.members.find((member) => member.role === 'worker')
  const { task } = await service.createTask(run.swarmId, {
    title: 'Split review',
    acceptance: ['a'],
    files: [],
  })
  await service.advertiseTask(run.swarmId, task.id)
  await service.bid(run.swarmId, task.id, { memberId: worker.id })
  const awarded = await service.awardTask(run.swarmId, task.id)
  const submitted = await service.submitPatch(run.swarmId, task.id, {
    memberId: worker.id,
    fence: awarded.lease.fence,
    branch: 'swarm/deadlock',
  })
  assert.equal(submitted.review.reviewers.length, 2)
  for (const reviewerId of submitted.review.reviewers) {
    await service.reviewPatch(run.swarmId, submitted.patchId, {
      memberId: reviewerId,
      verdict: 'abstain',
    })
  }
  const snapshot = await service.status(run.swarmId, true)
  assert.equal(snapshot.tasks.find((item) => item.id === task.id).state, 'blocked')
  assert.equal(snapshot.reviewEscalations.length, 1)
  assert.equal(snapshot.reviewEscalations[0].reason, 'no_decision')
})

test('the judge scales concurrency up when the ready queue exceeds the limit', async (t) => {
  const baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-swarm-scale-'))
  const repo = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-swarm-scale-repo-'))
  const config = resolveConfig({
    members: 4,
    budget: { tokens: 100_000 },
    orchestrator: { autoStart: true, tickMs: 600_000 },
    preflight: { enabled: true, minFreeMb: 0 },
    workspace: { maxConcurrent: 4 },
  })
  const service = new SwarmService({ config, baseDir })
  await service.open()
  t.after(async () => {
    await service.close()
    await fsp.rm(baseDir, { recursive: true, force: true })
    await fsp.rm(repo, { recursive: true, force: true })
  })

  const run = await service.createRun({ goal: 'scale', repo, members: 4 })
  assert.equal(run.concurrencyLimit, 3)
  const worker = run.members.find((member) => member.role === 'worker')
  const { task: doneTask } = await service.createTask(run.swarmId, {
    title: 'Done work',
    acceptance: ['a'],
    files: [],
  })
  await service.advertiseTask(run.swarmId, doneTask.id)
  await service.bid(run.swarmId, doneTask.id, { memberId: worker.id })
  const awarded = await service.awardTask(run.swarmId, doneTask.id)
  const submitted = await service.submitPatch(run.swarmId, doneTask.id, {
    memberId: worker.id,
    fence: awarded.lease.fence,
    branch: 'swarm/scale-a',
  })
  for (const reviewerId of submitted.review.reviewers) {
    await service.reviewPatch(run.swarmId, submitted.patchId, {
      memberId: reviewerId,
      verdict: 'approve',
      evidence: ['test: ok'],
    })
  }
  await service.mergePatch(run.swarmId, submitted.patchId, {})

  for (let index = 0; index < 4; index += 1) {
    const { task } = await service.createTask(run.swarmId, {
      title: `Queued ${index}`,
      acceptance: ['a'],
      files: [],
    })
    await service.advertiseTask(run.swarmId, task.id)
  }
  await service.tickRun(run.swarmId)
  const snapshot = await service.status(run.swarmId)
  assert.equal(snapshot.concurrencyLimit, 4)
  const detail = await service.status(run.swarmId, true)
  assert.equal(detail.scaleHistory[0].direction, 'up')
  assert.equal(detail.scaleHistory[0].reason, 'ready_queue')
})

test('quorum counts assigned reviewers, not the whole roster', async (t) => {  const { service, repo } = await makeService(t)
  const run = await service.createRun({ goal: 'large roster', repo, members: 6 })
  const worker = run.members.find((member) => member.role === 'worker')
  const { task } = await service.createTask(run.swarmId, {
    title: 'Large roster review',
    acceptance: ['a'],
    files: [],
  })
  await service.advertiseTask(run.swarmId, task.id)
  await service.bid(run.swarmId, task.id, { memberId: worker.id })
  const awarded = await service.awardTask(run.swarmId, task.id)
  const submitted = await service.submitPatch(run.swarmId, task.id, {
    memberId: worker.id,
    fence: awarded.lease.fence,
    branch: 'swarm/large',
  })
  assert.equal(submitted.review.reviewers.length, 2)
  for (const reviewerId of submitted.review.reviewers) {
    await service.reviewPatch(run.swarmId, submitted.patchId, {
      memberId: reviewerId,
      verdict: 'approve',
      evidence: ['test: ok'],
    })
  }
  const snapshot = await service.status(run.swarmId)
  assert.equal(snapshot.tasks.find((item) => item.id === task.id).state, 'approved')
})

test('topology exposes review and dependency edges between members', async (t) => {  const { service, repo } = await makeService(t)
  const run = await service.createRun({ goal: 'topology', repo, members: 3 })
  const workers = run.members.filter((member) => member.role === 'worker')
  const first = await service.createTask(run.swarmId, {
    title: 'Foundation',
    acceptance: ['a'],
    files: [],
  })
  await service.advertiseTask(run.swarmId, first.task.id)
  await service.bid(run.swarmId, first.task.id, { memberId: workers[0].id })
  const firstAward = await service.awardTask(run.swarmId, first.task.id)
  const firstPatch = await service.submitPatch(run.swarmId, first.task.id, {
    memberId: workers[0].id,
    fence: firstAward.lease.fence,
    branch: 'swarm/topo-a',
  })
  await service.reviewPatch(run.swarmId, firstPatch.patchId, {
    memberId: firstPatch.review.reviewers[0],
    verdict: 'approve',
    evidence: ['test: ok'],
  })

  const second = await service.createTask(run.swarmId, {
    title: 'Dependent',
    acceptance: ['b'],
    files: [],
    deps: [first.task.id],
  })
  await service.advertiseTask(run.swarmId, second.task.id)
  await service.bid(run.swarmId, second.task.id, { memberId: workers[1].id })
  const secondAward = await service.awardTask(run.swarmId, second.task.id)
  await service.submitPatch(run.swarmId, second.task.id, {
    memberId: workers[1].id,
    fence: secondAward.lease.fence,
    branch: 'swarm/topo-b',
  })

  const detail = await service.status(run.swarmId, true)
  assert.equal(detail.topologyGraph.nodes.length, 3)
  const kinds = new Set(detail.topologyGraph.edges.map((edge) => edge.kind))
  assert.equal(kinds.has('review'), true)
  assert.equal(kinds.has('dependency'), true)
  const dependency = detail.topologyGraph.edges.find((edge) => edge.kind === 'dependency')
  assert.equal(dependency.from, workers[0].id)
  assert.equal(dependency.to, workers[1].id)
})

test('cost report exports the three-level ledger as CSV', async (t) => {
  const { service, repo } = await makeService(t)
  const run = await service.createRun({ goal: 'csv', repo, members: 3 })
  const worker = run.members.find((member) => member.role === 'worker')
  const { task } = await service.createTask(run.swarmId, {
    title: 'Costed',
    acceptance: ['a'],
    files: [],
  })
  const taskReservation = await service.reserveBudget(run.swarmId, {
    taskId: task.id,
    tokens: 1_000,
  })
  await service.settleBudget(run.swarmId, taskReservation.id, { tokens: 800 })
  const memberReservation = await service.reserveBudget(run.swarmId, {
    memberId: worker.id,
    tokens: 1_000,
  })
  await service.settleBudget(run.swarmId, memberReservation.id, { tokens: 800 })
  const report = service.costReport(run.swarmId)
  assert.match(report.filename, /-cost\.csv$/)
  const lines = report.csv.trim().split('\n')
  assert.equal(lines[0], 'scope,key,tokens,reserved_tokens,calls,usd')
  assert.equal(lines.some((line) => line.startsWith(`task,${task.id},800`)), true)
  assert.equal(lines.some((line) => line.startsWith(`member,${worker.id},800`)), true)
  assert.equal(lines.some((line) => line.startsWith('role,worker,800')), true)
  assert.equal(lines.some((line) => line.startsWith('run,run,1600')), true)
})

test('messages deliver once, fan out by topic, and scrub secrets', async (t) => {
  const { service, repo } = await makeService(t)
  const run = await service.createRun({ goal: 'messages', repo, members: 3 })
  const queen = run.members.find((member) => member.role === 'queen')
  const workers = run.members.filter((member) => member.role === 'worker')
  const sent = await service.sendMessage(run.swarmId, {
    from: queen.id,
    to: workers[0].id,
    content: 'please check export; token sk-abcdefghijklmnop123456',
  })
  assert.equal(sent.kind, 'request')
  const first = await service.inbox(run.swarmId, { memberId: workers[0].id })
  assert.equal(first.messages.length, 1)
  assert.equal(first.messages[0].payload.includes('sk-abcdefghijklmnop'), false)
  assert.equal(first.delivered.length, 1)
  const second = await service.inbox(run.swarmId, { memberId: workers[0].id })
  assert.equal(second.messages.length, 0)
  const other = await service.inbox(run.swarmId, { memberId: workers[1].id })
  assert.equal(other.messages.length, 0)

  const broadcast = await service.sendMessage(run.swarmId, {
    from: queen.id,
    topic: 'status',
    content: 'round started',
  })
  assert.equal(broadcast.kind, 'broadcast')
  assert.equal((await service.inbox(run.swarmId, { memberId: workers[0].id })).messages.length, 1)
  assert.equal((await service.inbox(run.swarmId, { memberId: workers[1].id })).messages.length, 1)
  assert.equal((await service.inbox(run.swarmId, { memberId: queen.id })).messages.length, 0)
})

test('messages expire after TTL and rate limits collapse to a board fact', async (t) => {
  const baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-swarm-msg-'))
  const repo = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-swarm-msg-repo-'))
  let now = 1_800_000_000_000
  const config = resolveConfig({
    members: 3,
    preflight: { enabled: true, minFreeMb: 0 },
    orchestrator: { autoStart: true, tickMs: 600_000 },
    messages: { maxPerMinute: 1, defaultTtlMs: 1_000, maxPayloadBytes: 256 },
  })
  const service = new SwarmService({ config, baseDir, clock: () => now })
  await service.open()
  t.after(async () => {
    await service.close()
    await fsp.rm(baseDir, { recursive: true, force: true })
    await fsp.rm(repo, { recursive: true, force: true })
  })
  const run = await service.createRun({ goal: 'ttl', repo, members: 3 })
  const queen = run.members.find((member) => member.role === 'queen')
  const workers = run.members.filter((member) => member.role === 'worker')
  await service.sendMessage(run.swarmId, { from: queen.id, to: workers[0].id, content: 'one' })
  const throttled = await service.sendMessage(run.swarmId, {
    from: queen.id,
    to: workers[1].id,
    content: 'two',
  })
  assert.equal(throttled.throttled, true)

  now += 2_000
  await service.tickRun(run.swarmId)
  const inbox = await service.inbox(run.swarmId, { memberId: workers[0].id })
  assert.equal(inbox.messages.length, 0)
  const snapshot = await service.status(run.swarmId, true)
  assert.equal(snapshot.messages[0].status, 'expired')
  assert.equal(snapshot.board.some((entry) => entry.topic === 'throttled'), true)
})

test('star topology forbids worker-to-worker messages but allows queen edges', async (t) => {  const { service, repo } = await makeService(t)
  const run = await service.createRun({ goal: 'star', repo, members: 3, topology: 'star' })
  const queen = run.members.find((member) => member.role === 'queen')
  const workers = run.members.filter((member) => member.role === 'worker')
  await assert.rejects(
    () =>
      service.sendMessage(run.swarmId, {
        from: workers[0].id,
        to: workers[1].id,
        content: 'peer to peer',
      }),
    (error) => error.code === 'TOPOLOGY_FORBIDDEN',
  )
  const toQueen = await service.sendMessage(run.swarmId, {
    from: workers[0].id,
    to: queen.id,
    content: 'report',
  })
  assert.match(toQueen.messageId, /^msg_/)
  const broadcast = await service.sendMessage(run.swarmId, {
    from: queen.id,
    topic: 'status',
    content: 'round start',
  })
  assert.equal(broadcast.kind, 'broadcast')
  assert.equal(service.runs.get(run.swarmId).state.securityEvents.length, 1)
})

test('members can be added and retired with queen and busy protection', async (t) => {
  const { service, repo } = await makeService(t)
  const run = await service.createRun({ goal: 'roster', repo, members: 3 })
  const queen = run.members.find((member) => member.role === 'queen')
  const workers = run.members.filter((member) => member.role === 'worker')

  await service.intervene(run.swarmId, {
    action: 'add_member',
    name: 'worker-3',
    role: 'worker',
    model: 'strong',
  })
  let snapshot = await service.status(run.swarmId, true)
  const added = snapshot.members.find((member) => member.name === 'worker-3')
  assert.equal(added.role, 'worker')
  assert.equal(added.model, 'strong')
  assert.equal(added.status, 'idle')
  assert.equal(snapshot.members.length, 4)

  await assert.rejects(
    () => service.intervene(run.swarmId, { action: 'add_member', name: 'worker-3' }),
    (error) => error.code === 'MEMBER_DUPLICATE',
  )
  await assert.rejects(
    () => service.intervene(run.swarmId, { action: 'remove_member', memberId: queen.id }),
    (error) => error.code === 'QUEEN_REQUIRED',
  )

  const { task } = await service.createTask(run.swarmId, {
    title: 'busy member',
    acceptance: ['ok'],
    files: [],
  })
  await service.advertiseTask(run.swarmId, task.id)
  await service.bid(run.swarmId, task.id, { memberId: workers[0].id })
  await service.awardTask(run.swarmId, task.id)
  await assert.rejects(
    () => service.intervene(run.swarmId, { action: 'remove_member', memberId: workers[0].id }),
    (error) => error.code === 'MEMBER_BUSY',
  )

  await service.intervene(run.swarmId, { action: 'remove_member', memberId: workers[1].id })
  snapshot = await service.status(run.swarmId, true)
  assert.equal(snapshot.members.find((member) => member.id === workers[1].id).status, 'left')
  await assert.rejects(
    () => service.inbox(run.swarmId, { memberId: workers[1].id }),
    (error) => error.code === 'MEMBER_GONE',
  )
})
