import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { resolveConfig } from '../src/config.js'
import { SwarmService } from '../src/service.js'
import { git, detectTestCommand } from '../src/workspace.js'

const PASS_GATE = 'node -e "process.exit(0)"'
const FAIL_WHEN_FILE = 'node -e "process.exit(require(\'fs\').existsSync(\'fail.txt\')?1:0)"'

async function initRepo() {
  const repo = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-swarm-git-'))
  await git(['init'], repo)
  await git(['checkout', '-b', 'main'], repo)
  await git(['config', 'user.email', 'swarm-test@example.com'], repo)
  await git(['config', 'user.name', 'Swarm Test'], repo)
  await fsp.mkdir(path.join(repo, 'src'), { recursive: true })
  await fsp.writeFile(path.join(repo, 'package.json'), '{"name":"swarm-toy","private":true,"type":"module"}\n', 'utf8')
  await fsp.writeFile(path.join(repo, 'src', 'app.js'), "export function greet() {\n  return 'hello'\n}\n", 'utf8')
  await git(['add', '-A'], repo)
  await git(['commit', '-m', 'initial'], repo)
  return repo
}

async function harness(t, gate = PASS_GATE, overrides = {}) {
  const baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-swarm-ws-'))
  const repo = await initRepo()
  const config = resolveConfig({
    members: 3,
    budget: { tokens: 200_000 },
    orchestrator: { autoStart: true, tickMs: 600_000 },
    preflight: { enabled: true, minFreeMb: 0 },
    workspace: { enabled: true, root: path.join(baseDir, 'worktrees'), ...(overrides.workspace ?? {}) },
    gate: { commands: [gate], autoDetect: false, timeoutMs: 30_000 },
    review: overrides.review ?? {},
  })
  const service = new SwarmService({ config, baseDir })
  await service.open()
  t.after(async () => {
    await service.close()
    await fsp.rm(baseDir, { recursive: true, force: true })
    await fsp.rm(repo, { recursive: true, force: true })
  })
  return { service, repo, baseDir }
}

async function newRun(service, repo) {
  return service.createRun({ goal: 'worktree flow', repo, members: 3 })
}

async function addTask(service, runId, title, files) {
  const { task } = await service.createTask(runId, {
    title,
    acceptance: ['node --test passes'],
    files,
    tags: ['javascript'],
  })
  await service.advertiseTask(runId, task.id)
  return service.status(runId).then((snapshot) => snapshot.tasks.find((item) => item.id === task.id))
}

async function commitFile(worktree, relative, content, message) {
  await fsp.writeFile(path.join(worktree.path, relative), content, 'utf8')
  await git(['add', '-A'], worktree.path)
  await git(['commit', '-m', message], worktree.path)
}

async function approveAll(service, runId, submitted) {
  for (const reviewerId of submitted.review.reviewers) {
    await service.reviewPatch(runId, submitted.patchId, {
      memberId: reviewerId,
      verdict: 'approve',
      evidence: ['node -e process.exit(0): passed'],
    })
  }
}

test('detectTestCommand tolerates a UTF-8 BOM in package.json', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-swarm-bom-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  await fsp.writeFile(
    path.join(dir, 'package.json'),
    '\uFEFF{"name":"bom","scripts":{"test":"node --test"}}',
    'utf8',
  )
  assert.equal(await detectTestCommand(dir), 'npm test')
})

test('award creates an isolated worktree and submit collects its commit', async (t) => {
  const { service, repo, baseDir } = await harness(t)
  const run = await newRun(service, repo)
  assert.equal(run.workspace.enabled, true)
  assert.equal(run.baseCommit.length, 40)
  assert.deepEqual(run.gateCommands, [PASS_GATE])

  const worker = run.members.find((member) => member.role === 'worker')
  const task = await addTask(service, run.swarmId, 'Change greet', ['src/app.js'])
  await service.bid(run.swarmId, task.id, { memberId: worker.id })
  const awarded = await service.awardTask(run.swarmId, task.id)
  assert.ok(awarded.worktree)
  assert.equal(awarded.worktree.branch, `swarm/${run.swarmId}/task/${task.id}`)
  assert.equal((await fsp.stat(awarded.worktree.path)).isDirectory(), true)

  await commitFile(awarded.worktree, 'src/app.js', "export function greet() {\n  return 'hi'\n}\n", 'change greet')
  const submitted = await service.submitPatch(run.swarmId, task.id, {
    memberId: worker.id,
    fence: awarded.lease.fence,
    notes: 'one-line change',
  })
  assert.equal(submitted.taskState, 'reviewing')
  const detail = await service.status(run.swarmId, true)
  const patch = detail.patches.find((item) => item.id === submitted.patchId)
  assert.equal(patch.branch, awarded.worktree.branch)
  assert.equal(patch.files.includes('src/app.js'), true)
  assert.equal(patch.diffBytes > 0, true)
  const diffFile = path.join(baseDir, 'runs', run.swarmId, patch.diffPath)
  assert.match(await fsp.readFile(diffFile, 'utf8'), /return 'hi'/)

  await approveAll(service, run.swarmId, submitted)
  const merged = await service.mergePatch(run.swarmId, submitted.patchId, {})
  assert.equal(merged.state, 'merged')
  assert.equal(merged.gate.passed, true)
  assert.equal(merged.gate.checks.length, 1)
  assert.equal(merged.integrationBranch, `swarm/${run.swarmId}/integration`)

  const integrationPath = path.join(baseDir, 'worktrees', run.swarmId, 'integration')
  assert.match(await fsp.readFile(path.join(integrationPath, 'src/app.js'), 'utf8'), /return 'hi'/)
  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], integrationPath)
  assert.equal(branch.stdout, merged.integrationBranch)
})

test('uncommitted work is rejected with WORKTREE_DIRTY', async (t) => {
  const { service, repo } = await harness(t)
  const run = await newRun(service, repo)
  const worker = run.members.find((member) => member.role === 'worker')
  const task = await addTask(service, run.swarmId, 'Uncommitted', ['src/app.js'])
  const awarded = await service.awardTask(run.swarmId, task.id, { memberId: worker.id, force: true, reason: 'test' })
  await fsp.writeFile(path.join(awarded.worktree.path, 'src/app.js'), 'dirty\n', 'utf8')
  await assert.rejects(
    () => service.submitPatch(run.swarmId, task.id, { memberId: worker.id, fence: awarded.lease.fence }),
    (error) => error.code === 'WORKTREE_DIRTY' && error.details.files.includes('src/app.js'),
  )
})

test('a failing gate blocks the merge and returns the task to working', async (t) => {
  const { service, repo, baseDir } = await harness(t, FAIL_WHEN_FILE)
  const run = await newRun(service, repo)
  const worker = run.members.find((member) => member.role === 'worker')
  const task = await addTask(service, run.swarmId, 'Add failing file', ['fail.txt'])
  await service.bid(run.swarmId, task.id, { memberId: worker.id })
  const awarded = await service.awardTask(run.swarmId, task.id)
  await commitFile(awarded.worktree, 'fail.txt', 'boom\n', 'add fail file')
  const submitted = await service.submitPatch(run.swarmId, task.id, {
    memberId: worker.id,
    fence: awarded.lease.fence,
  })
  await approveAll(service, run.swarmId, submitted)
  await assert.rejects(
    () => service.mergePatch(run.swarmId, submitted.patchId, {}),
    (error) => error.code === 'GATE_FAILED' && error.details.taskState === 'working',
  )
  const snapshot = await service.status(run.swarmId, true)
  const taskAfter = snapshot.tasks.find((item) => item.id === task.id)
  assert.equal(taskAfter.state, 'working')
  assert.equal(taskAfter.gate.passed, false)
  assert.equal(snapshot.stats.merged, 0)
  const integrationPath = path.join(baseDir, 'worktrees', run.swarmId, 'integration')
  await assert.rejects(() => fsp.stat(integrationPath))
})

test('two non-conflicting patches merge serially with merge commits', async (t) => {
  const { service, repo } = await harness(t)
  const run = await newRun(service, repo)
  const workers = run.members.filter((member) => member.role === 'worker')
  const taskA = await addTask(service, run.swarmId, 'Add a', ['src/a.js'])
  const taskB = await addTask(service, run.swarmId, 'Add b', ['src/b.js'])
  const a = await service.awardTask(run.swarmId, taskA.id, { memberId: workers[0].id, force: true, reason: 'test' })
  const b = await service.awardTask(run.swarmId, taskB.id, { memberId: workers[1].id, force: true, reason: 'test' })
  await commitFile(a.worktree, 'src/a.js', 'export const a = 1\n', 'add a')
  await commitFile(b.worktree, 'src/b.js', 'export const b = 2\n', 'add b')
  const submittedA = await service.submitPatch(run.swarmId, taskA.id, { memberId: workers[0].id, fence: a.lease.fence })
  const submittedB = await service.submitPatch(run.swarmId, taskB.id, { memberId: workers[1].id, fence: b.lease.fence })
  await approveAll(service, run.swarmId, submittedA)
  await approveAll(service, run.swarmId, submittedB)
  const mergedA = await service.mergePatch(run.swarmId, submittedA.patchId, {})
  const mergedB = await service.mergePatch(run.swarmId, submittedB.patchId, {})
  assert.equal(mergedA.state, 'merged')
  assert.equal(mergedB.state, 'merged')
  const log = await git(['log', '--oneline', '--merges'], path.join(service.workspaceRoot, run.swarmId, 'integration'))
  assert.equal(log.stdout.split('\n').filter(Boolean).length, 2)
})

test('recovery reuses persisted worktrees and can still merge', async (t) => {
  const baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-swarm-ws-recover-'))
  const repo = await initRepo()
  const config = resolveConfig({
    members: 3,
    budget: { tokens: 200_000 },
    orchestrator: { autoStart: true, tickMs: 600_000 },
    preflight: { enabled: true, minFreeMb: 0 },
    workspace: { enabled: true, root: path.join(baseDir, 'worktrees') },
    gate: { commands: [PASS_GATE], autoDetect: false, timeoutMs: 30_000 },
  })
  let service = new SwarmService({ config, baseDir })
  t.after(async () => {
    await service.close()
    await fsp.rm(baseDir, { recursive: true, force: true })
    await fsp.rm(repo, { recursive: true, force: true })
  })
  await service.open()
  const run = await newRun(service, repo)
  const worker = run.members.find((member) => member.role === 'worker')
  const task = await addTask(service, run.swarmId, 'Recover me', ['src/app.js'])
  await service.bid(run.swarmId, task.id, { memberId: worker.id })
  const awarded = await service.awardTask(run.swarmId, task.id)
  await commitFile(awarded.worktree, 'src/app.js', "export const recovered = true\n", 'recover')
  const submitted = await service.submitPatch(run.swarmId, task.id, {
    memberId: worker.id,
    fence: awarded.lease.fence,
  })
  const worktreePath = awarded.worktree.path
  await service.close()

  service = new SwarmService({ config, baseDir })
  await service.open()
  const paused = await service.status(run.swarmId)
  assert.equal(paused.status, 'paused')
  assert.equal(paused.tasks[0].worktree.path, worktreePath)
  await service.intervene(run.swarmId, { action: 'resume' })
  await approveAll(service, run.swarmId, submitted)
  const merged = await service.mergePatch(run.swarmId, submitted.patchId, {})
  assert.equal(merged.state, 'merged')
  const integrationPath = path.join(baseDir, 'worktrees', run.swarmId, 'integration')
  assert.match(await fsp.readFile(path.join(integrationPath, 'src/app.js'), 'utf8'), /recovered = true/)
})

test('a failing post-merge gate rolls the integration branch back', async (t) => {
  const integrationOnlyGate =
    'node -e "const{execSync}=require(\'child_process\');process.exit(execSync(\'git rev-parse --abbrev-ref HEAD\').toString().trim().includes(\'integration\')?1:0)"'
  const { service, repo, baseDir } = await harness(t, integrationOnlyGate)
  const run = await newRun(service, repo)
  const worker = run.members.find((member) => member.role === 'worker')
  const task = await addTask(service, run.swarmId, 'Break integration', ['src/app.js'])
  await service.bid(run.swarmId, task.id, { memberId: worker.id })
  const awarded = await service.awardTask(run.swarmId, task.id)
  await commitFile(awarded.worktree, 'src/app.js', "export const changed = true\n", 'change')
  const submitted = await service.submitPatch(run.swarmId, task.id, {
    memberId: worker.id,
    fence: awarded.lease.fence,
  })
  await approveAll(service, run.swarmId, submitted)
  await assert.rejects(
    () => service.mergePatch(run.swarmId, submitted.patchId, {}),
    (error) => error.code === 'GATE_FAILED' && error.details.rolledBackTo === run.baseCommit,
  )
  const snapshot = await service.status(run.swarmId)
  assert.equal(snapshot.tasks[0].state, 'working')
  const integrationPath = path.join(baseDir, 'worktrees', run.swarmId, 'integration')
  const head = await git(['rev-parse', 'HEAD'], integrationPath)
  assert.equal(head.stdout, run.baseCommit)
  assert.match(await fsp.readFile(path.join(integrationPath, 'src/app.js'), 'utf8'), /hello/)
})

test('conflicting patches surface files and return the author to working', async (t) => {
  const { service, repo } = await harness(t)
  const run = await newRun(service, repo)
  const workers = run.members.filter((member) => member.role === 'worker')
  const taskA = await addTask(service, run.swarmId, 'Edit left', ['src/app.js'])
  const taskB = await addTask(service, run.swarmId, 'Edit right', ['src/app.js'])
  const a = await service.awardTask(run.swarmId, taskA.id, { memberId: workers[0].id, force: true, reason: 'test' })
  const b = await service.awardTask(run.swarmId, taskB.id, { memberId: workers[1].id, force: true, reason: 'test' })
  await commitFile(a.worktree, 'src/app.js', "export function greet() {\n  return 'left'\n}\n", 'left')
  await commitFile(b.worktree, 'src/app.js', "export function greet() {\n  return 'right'\n}\n", 'right')
  const submittedA = await service.submitPatch(run.swarmId, taskA.id, { memberId: workers[0].id, fence: a.lease.fence })
  const submittedB = await service.submitPatch(run.swarmId, taskB.id, { memberId: workers[1].id, fence: b.lease.fence })
  await approveAll(service, run.swarmId, submittedA)
  await approveAll(service, run.swarmId, submittedB)
  await service.mergePatch(run.swarmId, submittedA.patchId, {})
  await assert.rejects(
    () => service.mergePatch(run.swarmId, submittedB.patchId, {}),
    (error) => error.code === 'MERGE_CONFLICT' && error.details.taskState === 'working',
  )
  const snapshot = await service.status(run.swarmId, true)
  const taskAfter = snapshot.tasks.find((item) => item.id === taskB.id)
  assert.equal(taskAfter.state, 'working')
  assert.equal(taskAfter.lastConflict.files.includes('src/app.js'), true)
  assert.equal(snapshot.workspace.conflicts, 1)
  const integrationPath = path.join(service.workspaceRoot, run.swarmId, 'integration')
  assert.match(await fsp.readFile(path.join(integrationPath, 'src/app.js'), 'utf8'), /return 'left'/)
  const integrationStatus = await git(['status', '--porcelain'], integrationPath)
  assert.equal(integrationStatus.stdout, '')
})

test('the worktree concurrency limit rejects another award', async (t) => {
  const { service, repo } = await harness(t, PASS_GATE, { workspace: { maxConcurrent: 1 } })
  const run = await newRun(service, repo)
  const workers = run.members.filter((member) => member.role === 'worker')
  const first = await addTask(service, run.swarmId, 'First task', ['src/app.js'])
  const second = await addTask(service, run.swarmId, 'Second task', ['src/b.js'])
  await service.awardTask(run.swarmId, first.id, { memberId: workers[0].id, force: true, reason: 'test' })
  await assert.rejects(
    () =>
      service.awardTask(run.swarmId, second.id, {
        memberId: workers[1].id,
        force: true,
        reason: 'test',
      }),
    (error) => error.code === 'WORKTREE_LIMIT',
  )
  const snapshot = await service.status(run.swarmId)
  assert.equal(snapshot.tasks.find((task) => task.id === second.id).state, 'advertised')
})

test('the disk threshold blocks a new worktree', async (t) => {
  const { service, repo } = await harness(t, PASS_GATE, { workspace: { diskThresholdMb: 999_999_999 } })
  const run = await newRun(service, repo)
  const worker = run.members.find((member) => member.role === 'worker')
  const task = await addTask(service, run.swarmId, 'Too big to start', ['src/app.js'])
  await assert.rejects(
    () =>
      service.awardTask(run.swarmId, task.id, {
        memberId: worker.id,
        force: true,
        reason: 'test',
      }),
    (error) => error.code === 'DISK_LOW',
  )
})

test('workspace.keep=false removes worktrees at convergence', async (t) => {
  const { service, repo } = await harness(t, PASS_GATE, { workspace: { keep: false } })
  const run = await newRun(service, repo)
  const worker = run.members.find((member) => member.role === 'worker')
  const task = await addTask(service, run.swarmId, 'Cleanup task', ['src/app.js'])
  const awarded = await service.awardTask(run.swarmId, task.id, {
    memberId: worker.id,
    force: true,
    reason: 'test',
  })
  assert.equal((await fsp.stat(awarded.worktree.path)).isDirectory(), true)
  await service.intervene(run.swarmId, { action: 'converge', reason: 'test' })
  await assert.rejects(() => fsp.stat(awarded.worktree.path))
  const snapshot = await service.status(run.swarmId)
  assert.equal(snapshot.status, 'converged')
})
