/**
 * Repository preflight, git worktree isolation, gate execution, and the serial
 * integration queue.
 *
 * Worktrees live outside the user's repository (under the swarm data root), so
 * running a swarm never adds `.dsh-swarm/` noise to `git status`. One task owns
 * one branch and one checkout; every merge into the integration branch is
 * serialized through a per-repository queue.
 */
import { exec, execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { SwarmError, truncate } from './util.js'

const execFileAsync = promisify(execFile)
const execAsync = promisify(exec)

/** @type {Map<string, Promise<unknown>>} */
const repoLocks = new Map()

/**
 * Serialize git writes per repository. `index.lock` contention is the main
 * source of flaky worktree/merge failures on Windows.
 * @template T
 * @param {string} key
 * @param {() => Promise<T>} operation
 * @returns {Promise<T>}
 */
function withRepoLock(key, operation) {
  const previous = repoLocks.get(key) ?? Promise.resolve()
  const next = previous.then(operation, operation)
  repoLocks.set(
    key,
    next.then(
      () => undefined,
      () => undefined,
    ),
  )
  return next
}

/**
 * @param {string[]} args
 * @param {string} cwd
 * @param {{ timeoutMs?: number, maxBuffer?: number }} [options]
 */
export async function git(args, cwd, options = {}) {
  const { stdout, stderr } = await execFileAsync('git', args, {
    cwd,
    timeout: options.timeoutMs ?? 20_000,
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
    windowsHide: true,
  })
  return { stdout: stdout.trim(), stderr: stderr.trim() }
}

/**
 * Non-throwing git call for probes and for expected failures (conflicts).
 * @param {string[]} args
 * @param {string} cwd
 * @param {{ timeoutMs?: number, maxBuffer?: number }} [options]
 */
export async function safeGit(args, cwd, options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      timeout: options.timeoutMs ?? 20_000,
      maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
      windowsHide: true,
    })
    return { ok: true, code: 0, stdout: stdout.trim(), stderr: stderr.trim() }
  } catch (error) {
    return {
      ok: false,
      code: typeof error?.code === 'number' ? error.code : 1,
      stdout: String(error?.stdout ?? '').trim(),
      stderr: String(error?.stderr ?? error?.message ?? '').trim(),
    }
  }
}

/** @param {string} command @param {string} cwd @param {number} timeoutMs */
export async function runShell(command, cwd, timeoutMs) {
  const started = Date.now()
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    })
    return { ok: true, code: 0, stdout: stdout.trim(), stderr: stderr.trim(), durationMs: Date.now() - started }
  } catch (error) {
    return {
      ok: false,
      code: typeof error?.code === 'number' ? error.code : 1,
      stdout: String(error?.stdout ?? '').trim(),
      stderr: String(error?.stderr ?? error?.message ?? '').trim(),
      durationMs: Date.now() - started,
    }
  }
}

/** @param {string} target */
async function pathExists(target) {
  try {
    await fsp.access(target)
    return true
  } catch {
    return false
  }
}

/** @param {string} command @param {string[]} args @param {string} cwd */
async function run(command, args, cwd) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    })
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() }
  } catch (error) {
    return {
      ok: false,
      stdout: String(error?.stdout ?? '').trim(),
      stderr: String(error?.stderr ?? error?.message ?? '').trim(),
      code: error?.code,
    }
  }
}

/**
 * Detect a verification command the swarm can run as a gate.
 * @param {string} repo
 */
export async function detectTestCommand(repo) {
  try {
    const raw = await fsp.readFile(path.join(repo, 'package.json'), 'utf8')
    // Windows editors and PowerShell often write a UTF-8 BOM; JSON.parse rejects it.
    const pkg = JSON.parse(raw.replace(/^\uFEFF/, ''))
    if (pkg.scripts?.test) return 'npm test'
    if (pkg.scripts?.check) return 'npm run check'
  } catch {
    // no package.json or invalid JSON
  }
  for (const [file, command] of [
    ['pyproject.toml', 'pytest'],
    ['pytest.ini', 'pytest'],
    ['Cargo.toml', 'cargo test'],
    ['go.mod', 'go test ./...'],
    ['Makefile', 'make test'],
  ]) {
    try {
      await fsp.access(path.join(repo, file))
      return command
    } catch {
      // keep looking
    }
  }
  return ''
}

/**
 * Preflight: can a swarm run in this repository at all?
 * Git is reported but not required; a non-git directory runs in degraded
 * "patch only" mode instead of writing to the user's tree.
 * @param {string} repo
 * @param {{ minFreeMb?: number }} [options]
 */
export async function preflightRepo(repo, options = {}) {
  const checks = []
  /** @type {string[]} */
  const fixes = []
  const target = path.resolve(repo)

  let stats = null
  try {
    stats = await fsp.stat(target)
  } catch {
    checks.push({ name: 'directory', ok: false, detail: `not found: ${target}` })
    fixes.push(`创建目录或修正 repo 路径：${target}`)
    return { ok: false, checks, fixes, repo: target }
  }
  const isDirectory = stats.isDirectory()
  checks.push({ name: 'directory', ok: isDirectory, detail: target })
  if (!isDirectory) fixes.push(`repo 必须是目录：${target}`)

  let writable = false
  if (isDirectory) {
    const probe = path.join(target, `.dsh-swarm-probe-${process.pid}-${Date.now()}`)
    try {
      await fsp.writeFile(probe, 'ok')
      await fsp.unlink(probe)
      writable = true
    } catch (error) {
      checks.push({ name: 'writable', ok: false, detail: String(error?.message ?? error) })
      fixes.push('目录不可写：检查权限，或在可写位置使用 --repo')
    }
  }
  if (writable) checks.push({ name: 'writable', ok: true, detail: 'ok' })

  let gitRoot = ''
  let branch = ''
  let baseCommit = ''
  if (isDirectory) {
    const result = await run('git', ['rev-parse', '--show-toplevel'], target)
    if (result.ok) {
      gitRoot = result.stdout
      const head = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], target)
      branch = head.ok ? head.stdout : 'HEAD'
      const commit = await run('git', ['rev-parse', 'HEAD'], target)
      baseCommit = commit.ok ? commit.stdout : ''
    }
    checks.push({
      name: 'git',
      ok: Boolean(gitRoot),
      detail: gitRoot ? `${gitRoot} (${branch}@${baseCommit.slice(0, 8) || 'unborn'})` : 'not a git repository (degraded: patch-only mode)',
    })
    if (!gitRoot) fixes.push('`git init` 后蜂群可启用 worktree 隔离；当前会降级为只产出补丁')
    else if (!baseCommit) fixes.push('仓库还没有首个提交；worktree 隔离从首次提交开始可用')
  }

  let freeMb = null
  try {
    const fsStats = await fsp.statfs(target)
    freeMb = Math.round((fsStats.bavail * fsStats.bsize) / (1024 * 1024))
    const min = options.minFreeMb ?? 256
    const ok = freeMb >= min
    checks.push({ name: 'disk', ok, detail: `${freeMb} MB free (need ${min} MB)` })
    if (!ok) fixes.push(`磁盘余量不足 ${min} MB：清理后重试`)
  } catch {
    checks.push({ name: 'disk', ok: true, detail: 'statfs unavailable' })
  }

  const testCommand = isDirectory ? await detectTestCommand(target) : ''
  checks.push({
    name: 'acceptance-command',
    ok: Boolean(testCommand),
    detail: testCommand || 'no test command detected (gates will require an explicit command)',
  })
  if (!testCommand) fixes.push('在任务或配置中提供验收命令，否则只能人工验收')

  const required = checks.filter((check) => ['directory', 'writable', 'disk'].includes(check.name))
  return {
    ok: required.every((check) => check.ok),
    repo: target,
    gitRoot,
    branch,
    baseCommit,
    testCommand,
    freeMb,
    checks,
    fixes,
  }
}

/**
 * One worktree pool per swarm run. Safe to construct after recovery: `init()`
 * re-resolves the repository root and the base commit from git.
 */
export class WorkspaceManager {
  /**
   * @param {{ repo: string, runId: string, root: string, gitRoot?: string, baseCommit?: string, logger?: any, clock?: () => number }} options
   */
  constructor(options) {
    this.repo = options.repo
    this.runId = options.runId
    this.root = options.root ?? ''
    this.gitRoot = options.gitRoot ?? ''
    this.baseCommit = options.baseCommit ?? ''
    this.logger = options.logger
    this.clock = options.clock ?? Date.now
    this.mergeQueue = Promise.resolve()
    this.initialized = false
    /** @type {string} */
    this.rootPath = ''
  }

  async init() {
    if (this.initialized) return this
    if (!this.gitRoot) {
      const result = await git(['rev-parse', '--show-toplevel'], this.repo)
      this.gitRoot = result.stdout
    }
    if (!this.baseCommit) {
      const result = await git(['rev-parse', 'HEAD'], this.gitRoot)
      this.baseCommit = result.stdout
    }
    // A subagent's sandbox is anchored to the repository workspace, so the
    // default pool lives inside the repo but is kept out of `git status` via
    // `.git/info/exclude`. An explicit root may point elsewhere.
    this.rootPath = this.root || path.join(this.gitRoot, '.dsh-swarm', 'worktrees')
    await fsp.mkdir(this.rootPath, { recursive: true })
    if (!this.root) await this.#excludeFromStatus()
    this.initialized = true
    return this
  }

  async #excludeFromStatus() {
    try {
      const exclude = path.join(this.gitRoot, '.git', 'info', 'exclude')
      await fsp.mkdir(path.dirname(exclude), { recursive: true })
      let content = ''
      try {
        content = await fsp.readFile(exclude, 'utf8')
      } catch {
        // new repository without an exclude file
      }
      if (!content.split('\n').some((line) => line.trim() === '.dsh-swarm/')) {
        await fsp.appendFile(exclude, `${content.endsWith('\n') || content === '' ? '' : '\n'}.dsh-swarm/\n`, 'utf8')
      }
    } catch (error) {
      this.logger?.warn?.(`[swarm] cannot update .git/info/exclude: ${String(error?.message ?? error)}`)
    }
  }

  get runRoot() {
    return path.join(this.rootPath || this.root, this.runId)
  }

  get integrationBranch() {
    return `swarm/${this.runId}/integration`
  }

  get integrationPath() {
    return path.join(this.runRoot, 'integration')
  }

  /** @param {string} taskId */
  taskBranch(taskId) {
    return `swarm/${this.runId}/task/${taskId}`
  }

  /** @param {string} taskId */
  taskPath(taskId) {
    return path.join(this.runRoot, taskId)
  }

  /** @param {string} branch */
  async #branchExists(branch) {
    const result = await safeGit(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], this.gitRoot)
    return result.ok
  }

  /**
   * Create or reuse the isolated checkout for a task.
   * @param {{ taskId: string, branch?: string }} input
   */
  async createTaskWorktree(input) {
    await this.init()
    return withRepoLock(this.gitRoot, async () => {
      const branch = input.branch ?? this.taskBranch(input.taskId)
      const worktreePath = this.taskPath(input.taskId)
      if (await pathExists(worktreePath)) {
        return { path: worktreePath, branch, baseCommit: this.baseCommit, reused: true }
      }
      const hasBranch = await this.#branchExists(branch)
      const args = hasBranch
        ? ['worktree', 'add', worktreePath, branch]
        : ['worktree', 'add', '-b', branch, worktreePath, this.baseCommit]
      const result = await safeGit(args, this.gitRoot)
      if (!result.ok) {
        throw new SwarmError('WORKTREE_FAILED', 'git worktree add failed', {
          branch,
          path: worktreePath,
          stderr: truncate(result.stderr, 2000),
        })
      }
      return { path: worktreePath, branch, baseCommit: this.baseCommit, reused: false }
    })
  }

  /**
   * Turn committed work in a task worktree into patch metadata plus a diff file.
   * Uncommitted changes are rejected: a patch must be reproducible from a commit.
   * @param {{ taskId: string, diffFile: string }} input
   */
  async collectTaskPatch(input) {
    await this.init()
    const cwd = this.taskPath(input.taskId)
    const branch = this.taskBranch(input.taskId)
    const status = await git(['status', '--porcelain'], cwd)
    if (status.stdout) {
      // `git()` trims stdout, so do not rely on fixed column offsets; strip the
      // two-letter status plus its separating space instead.
      const files = status.stdout
        .split('\n')
        .map((line) => line.replace(/^.{1,2}\s+/, '').trim())
        .filter(Boolean)
        .slice(0, 50)
      throw new SwarmError('WORKTREE_DIRTY', 'worktree has uncommitted changes; commit them before submitting', {
        files,
      })
    }
    const head = await git(['rev-parse', 'HEAD'], cwd)
    if (!this.baseCommit || head.stdout === this.baseCommit) {
      throw new SwarmError('NO_CHANGES', 'worktree has no commits beyond the base revision')
    }
    const filesOutput = await git(['diff', '--name-only', `${this.baseCommit}..HEAD`], cwd)
    const files = filesOutput.stdout ? filesOutput.stdout.split('\n').filter(Boolean) : []
    const stat = await git(['diff', '--stat', `${this.baseCommit}..HEAD`], cwd)
    const diff = await safeGit(['diff', `${this.baseCommit}..HEAD`], cwd, { maxBuffer: 32 * 1024 * 1024 })
    if (!diff.ok) {
      throw new SwarmError('PATCH_TOO_LARGE', 'diff exceeds the 32 MB capture limit', { branch })
    }
    await fsp.mkdir(path.dirname(input.diffFile), { recursive: true })
    await fsp.writeFile(input.diffFile, `${diff.stdout}\n`, 'utf8')
    return {
      branch,
      commit: head.stdout,
      files,
      diffStat: stat.stdout || null,
      diffBytes: Buffer.byteLength(diff.stdout, 'utf8'),
      worktree: cwd,
    }
  }

  /**
   * Commit whatever a dispatched child left uncommitted, so a patch can always
   * be collected. The commit message records that this was an automatic commit.
   * @param {{ taskId: string, message?: string }} input
   */
  async commitDirty(input) {
    await this.init()
    const cwd = this.taskPath(input.taskId)
    const status = await git(['status', '--porcelain'], cwd)
    if (!status.stdout) return { committed: false }
    await git(['add', '-A'], cwd)
    await git(['commit', '-m', input.message ?? `swarm: ${input.taskId} (auto-commit)`], cwd)
    const head = await git(['rev-parse', 'HEAD'], cwd)
    return { committed: true, commit: head.stdout }
  }

  /**
   * Free megabytes at the repository filesystem.
   */
  async diskFreeMb() {
    await this.init()
    const stats = await fsp.statfs(this.gitRoot)
    return Math.round((stats.bavail * stats.bsize) / (1024 * 1024))
  }

  /**
   * Refuse a new worktree when the repository filesystem is below the threshold.
   * @param {number} minFreeMb
   */
  async checkDisk(minFreeMb) {
    const freeMb = await this.diskFreeMb()
    if (freeMb < minFreeMb) {
      throw new SwarmError('DISK_LOW', `only ${freeMb} MB free; worktree floor is ${minFreeMb} MB`, {
        freeMb,
        minFreeMb,
      })
    }
    return freeMb
  }

  /**
   * Remove task and integration worktrees. Branches are retained so merged work
   * can still be inspected; only the checkouts are reclaimed.
   * @param {{ taskPaths?: string[] }} [options]
   */
  async cleanup(options = {}) {
    await this.init()
    const removed = []
    return withRepoLock(this.gitRoot, async () => {
      for (const worktreePath of options.taskPaths ?? []) {
        const result = await safeGit(['worktree', 'remove', '--force', worktreePath], this.gitRoot)
        if (result.ok) removed.push(worktreePath)
      }
      if (await pathExists(this.integrationPath)) {
        const result = await safeGit(['worktree', 'remove', '--force', this.integrationPath], this.gitRoot)
        if (result.ok) removed.push(this.integrationPath)
      }
      await safeGit(['worktree', 'prune'], this.gitRoot)
      return { removed }
    })
  }

  async ensureIntegration() {    await this.init()
    return withRepoLock(this.gitRoot, async () => {
      if (!(await this.#branchExists(this.integrationBranch))) {
        const created = await safeGit(['branch', this.integrationBranch, this.baseCommit], this.gitRoot)
        if (!created.ok) {
          throw new SwarmError('INTEGRATION_FAILED', 'cannot create integration branch', {
            stderr: truncate(created.stderr, 2000),
          })
        }
      }
      if (!(await pathExists(this.integrationPath))) {
        const added = await safeGit(['worktree', 'add', this.integrationPath, this.integrationBranch], this.gitRoot)
        if (!added.ok) {
          throw new SwarmError('INTEGRATION_FAILED', 'cannot create integration worktree', {
            stderr: truncate(added.stderr, 2000),
          })
        }
      }
      return { path: this.integrationPath, branch: this.integrationBranch }
    })
  }

  /**
   * Merge one task branch into the integration branch. Serialized per run.
   * @param {{ taskId: string, branch?: string, message?: string }} input
   */
  async mergeTask(input) {
    const operation = this.mergeQueue.then(async () => {
      const integration = await this.ensureIntegration()
      const branch = input.branch ?? this.taskBranch(input.taskId)
      const previous = await git(['rev-parse', 'HEAD'], integration.path)
      const message = input.message ?? `swarm: merge ${input.taskId}`
      const merged = await safeGit(['merge', '--no-ff', '-m', message, branch], integration.path)
      if (!merged.ok) {
        const conflicts = await safeGit(['diff', '--name-only', '--diff-filter=U'], integration.path)
        await safeGit(['merge', '--abort'], integration.path)
        return {
          ok: false,
          reason: conflicts.stdout ? 'conflict' : 'error',
          files: conflicts.stdout ? conflicts.stdout.split('\n').filter(Boolean) : [],
          stderr: truncate(merged.stderr || merged.stdout, 2000),
          previous: previous.stdout,
          integrationPath: integration.path,
        }
      }
      const commit = await git(['rev-parse', 'HEAD'], integration.path)
      return {
        ok: true,
        commit: commit.stdout,
        previous: previous.stdout,
        branch,
        integrationPath: integration.path,
        integrationBranch: integration.branch,
      }
    })
    this.mergeQueue = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
  }

  /**
   * Undo a merge on the integration branch (used when the post-merge gate fails).
   * @param {string} commit
   */
  async rollbackIntegration(commit) {
    return withRepoLock(this.gitRoot, async () => {
      const result = await safeGit(['reset', '--hard', commit], this.integrationPath)
      if (!result.ok) {
        throw new SwarmError('ROLLBACK_FAILED', 'cannot reset the integration branch', {
          stderr: truncate(result.stderr, 2000),
        })
      }
      return { resetTo: commit }
    })
  }

  /**
   * Run gate commands in a directory. Every command runs; the first failure does
   * not hide evidence from later checks.
   * @param {{ cwd: string, commands: string[], timeoutMs?: number }} input
   */
  async gate(input) {
    /** @type {Array<Record<string, unknown>>} */
    const checks = []
    for (const command of input.commands) {
      const result = await runShell(command, input.cwd, input.timeoutMs ?? 5 * 60_000)
      checks.push({
        name: command,
        command,
        passed: result.ok,
        exitCode: result.code,
        durationMs: result.durationMs,
        output: truncate([result.stdout, result.stderr].filter(Boolean).join('\n'), 4000),
      })
    }
    return {
      passed: checks.every((check) => check.passed === true),
      checks,
      at: this.clock(),
      cwd: input.cwd,
    }
  }
}
