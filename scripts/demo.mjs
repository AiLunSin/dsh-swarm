import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { resolveConfig } from '../src/config.js'
import { SwarmService } from '../src/service.js'
import { git } from '../src/workspace.js'

const root = path.resolve(import.meta.dirname, '..')
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-swarm-demo-'))
const repo = path.join(work, 'toy-repo')
await fsp.cp(path.join(root, 'examples', 'toy-repo'), repo, { recursive: true })

// The demo is a real git repository: worktrees, commits, gates, and the
// integration branch are exercised exactly as in production.
await git(['init'], repo)
await git(['checkout', '-b', 'main'], repo)
await git(['config', 'user.email', 'demo@dsh-swarm.local'], repo)
await git(['config', 'user.name', 'dsh-swarm demo'], repo)
await git(['add', '-A'], repo)
await git(['commit', '-m', 'toy repository'], repo)

const config = resolveConfig({
  members: 3,
  budget: { tokens: 200_000 },
  taskBudget: { tokens: 60_000 },
  memberBudget: { tokens: 100_000 },
  orchestrator: { autoStart: true, tickMs: 600_000 },
  preflight: { enabled: true, minFreeMb: 0 },
  workspace: { enabled: true, root: path.join(work, 'worktrees') },
  gate: { commands: ['npm test'], autoDetect: false, timeoutMs: 120_000 },
})

const service = new SwarmService({ config, baseDir: path.join(work, 'data') })
await service.open()

const line = (label) => console.log(`\n=== ${label} ===`)

try {
  line('1. 启动 3 人蜂群')
  const swarm = await service.createRun({
    goal: '给导出功能加 CSV 格式，并补测试',
    repo,
    members: 3,
  })
  console.log(`${swarm.swarmId}  members=${swarm.members.map((m) => `${m.name}/${m.role}`).join(', ')}`)
  console.log(
    `budget=${swarm.budget.limits.runTokens} tokens  base=${swarm.baseCommit.slice(0, 8)}  gate=${swarm.gateCommands.join(', ')}`,
  )

  line('2. 规划者拆出一个可验收任务')
  const { task } = await service.createTask(swarm.swarmId, {
    title: '实现 toCsv 并导出到 src/export.js',
    acceptance: ['npm test 通过', '输出包含表头 id,title'],
    files: ['src/export.js'],
    tags: ['javascript'],
    priority: 80,
  })
  await service.advertiseTask(swarm.swarmId, task.id)
  console.log(`${task.id} [${task.state}] ${task.title}`)

  line('3. 工蜂竞价，蜂后授标并创建独立 worktree')
  const worker = swarm.members.find((member) => member.role === 'worker')
  const bid = await service.bid(swarm.swarmId, task.id, {
    memberId: worker.id,
    estimate: { tokens: 30_000, minutes: 20 },
    reason: '熟悉 export 模块',
  })
  console.log(`bid score=${bid.score}  components=${JSON.stringify(bid.components)}`)
  const awarded = await service.awardTask(swarm.swarmId, task.id)
  console.log(`awarded to ${awarded.assignee}  fence=${awarded.lease.fence}`)
  console.log(`worktree=${awarded.worktree.path}`)
  console.log(`branch=${awarded.worktree.branch}`)
  await service.startTask(swarm.swarmId, task.id, { memberId: worker.id, fence: awarded.lease.fence })

  line('4. 工蜂在 worktree 内改码并提交')
  const implementation = `/**
 * CSV export used by the demo.
 */
export function toCsv(rows) {
  if (!rows || rows.length === 0) return ''
  const headers = Object.keys(rows[0])
  const lines = [headers.join(',')]
  for (const row of rows) lines.push(headers.map((key) => String(row[key] ?? '')).join(','))
  return lines.join('\\n')
}
`
  await fsp.writeFile(path.join(awarded.worktree.path, 'src', 'export.js'), implementation, 'utf8')
  await git(['add', '-A'], awarded.worktree.path)
  await git(['commit', '-m', 'feat: implement toCsv'], awarded.worktree.path)
  const head = await git(['rev-parse', '--short', 'HEAD'], awarded.worktree.path)
  console.log(`committed ${head.stdout} in the task worktree`)

  line('5. 预算预留 / 结算')
  const reservation = await service.reserveBudget(swarm.swarmId, {
    taskId: task.id,
    memberId: worker.id,
    tokens: 20_000,
  })
  await service.settleBudget(swarm.swarmId, reservation.id, { tokens: 18_000, wallMs: 1_500 })
  console.log(`reserved ${reservation.tokens}, settled 18000`)

  line('6. 提交补丁：服务自动收集 commit / diff / 文件')
  const submitted = await service.submitPatch(swarm.swarmId, task.id, {
    memberId: worker.id,
    fence: awarded.lease.fence,
    tests: [{ name: 'toy export test', passed: true, output: '1 passed' }],
    notes: '按行拼接，表头 id,title；不引入依赖',
  })
  console.log(`patch=${submitted.patchId}  state=${submitted.taskState}`)
  console.log(`reviewers=${submitted.review.reviewers.join(', ')}`)

  line('7. 交叉评审（必须带证据）')
  for (const reviewerId of submitted.review.reviewers) {
    const vote = await service.reviewPatch(swarm.swarmId, submitted.patchId, {
      memberId: reviewerId,
      verdict: 'approve',
      evidence: ['npm test: 1 passed', 'src/export.js: toCsv'],
    })
    console.log(`reviewer ${reviewerId}: approvals=${vote.tally.approvals}/${vote.tally.needed} task=${vote.taskState}`)
  }

  line('8. 合并：门禁在 worktree 与集成分支各跑一次')
  const merged = await service.mergePatch(swarm.swarmId, submitted.patchId, {})
  console.log(`task=${merged.state}  mergeCommit=${merged.mergeCommit.slice(0, 8)}`)
  console.log(`branch=${merged.integrationBranch}  gate=${merged.gate.passed ? 'passed' : 'failed'}`)
  for (const check of merged.gate.checks) {
    console.log(`  [${check.passed ? 'ok' : 'FAIL'}] ${check.command} (${check.durationMs}ms)`)
  }

  line('9. 集成分支内容与收敛')
  const integrationPath = path.join(work, 'worktrees', swarm.swarmId, 'integration')
  console.log(`integration worktree: ${integrationPath}`)
  console.log((await fsp.readFile(path.join(integrationPath, 'src', 'export.js'), 'utf8')).split('\n').slice(0, 6).join('\n'))
  await service.tickRun(swarm.swarmId)
  const final = await service.status(swarm.swarmId, true)
  console.log(`status=${final.status}  reason=${final.convergedReason}`)
  console.log(`tasks=${final.stats.tasks} merged=${final.stats.merged} events=${final.stats.events}`)
  console.log(`spent=${final.budget.run.tokens} tokens  calls=${final.budget.run.calls}`)
  console.log('\ndemo ok')
} finally {
  await service.close()
  await fsp.rm(work, { recursive: true, force: true })
}
