/**
 * SwarmService: lifecycle, market, hive, reviews, and budget for one process.
 *
 * All public methods serialize per run and commit an event before returning.
 * The service never spawns model calls in M0; agent execution plugs into the
 * same commands through the member tools in M1.
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createEntry, evict, queryEntries } from './blackboard.js'
import { budgetSnapshot, remainingTokens, runBudgetState } from './budget.js'
import { EventLog, writeSnapshot } from './events.js'
import { assertLease, autoScore, createLease, rankBids } from './market.js'
import { deposit, snapshot as pheromoneSnapshot, topicWeight } from './pheromone.js'
import { applyEvent, emptyRunState, makeMember, makeTask, replay } from './project.js'
import { createReview, pickReviewers, tallyReviews } from './review.js'
import { SubagentRunner, buildTaskCard } from './runner.js'
import { assertTransition, isTerminalTaskState, ROLES } from './state.js'
import { asInt, asString, clamp, newId, SwarmError, truncate } from './util.js'
import { WorkspaceManager, git, preflightRepo } from './workspace.js'

/** @returns {string} */
function defaultBaseDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'swarm')
}

/** @param {unknown} value */
function stringArray(value) {
  if (Array.isArray(value)) return value.map(String).filter((item) => item.trim())
  if (typeof value === 'string' && value.trim()) return [value.trim()]
  return []
}

export class SwarmService {
  /**
   * @param {{ config: any, logger?: any, clock?: () => number, baseDir?: string }} options
   */
  constructor(options) {
    this.config = options.config
    this.logger = options.logger
    this.clock = options.clock ?? Date.now
    this.baseDir = options.baseDir ?? (this.config.dataDir || defaultBaseDir())
    this.runsDir = path.join(this.baseDir, 'runs')
    this.workspaceRoot = this.config.workspace?.root || ''
    this.hostCtx = options.hostCtx ?? null
    this.runner = options.runner ?? new SubagentRunner({ provider: this.config.dispatch?.provider ?? 'spawn' })
    /** @type {Map<string, any>} */
    this.runs = new Map()
    /** Dispatch child session id -> { runId, taskId, memberId } for usage attribution. */
    this.childRuns = new Map()
    this.errors = []
    this.opened = false
  }

  async open() {
    await fsp.mkdir(this.runsDir, { recursive: true })
    let entries = []
    try {
      entries = await fsp.readdir(this.runsDir, { withFileTypes: true })
    } catch (error) {
      this.logger?.warn?.(`[swarm] cannot read runs dir: ${String(error)}`)
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      try {
        await this.#loadRun(entry.name)
      } catch (error) {
        this.errors.push({ runId: entry.name, error: String(error?.message ?? error) })
        this.logger?.warn?.(`[swarm] failed to recover ${entry.name}: ${String(error)}`)
      }
    }
    this.opened = true
    this.logger?.info?.(`[swarm] service ready: ${this.runs.size} run(s), base=${this.baseDir}`)
    return this
  }

  /** @param {string} runId */
  async #loadRun(runId) {
    const dir = path.join(this.runsDir, runId)
    const log = new EventLog({ dir, runId, logger: this.logger, clock: this.clock })
    await log.open()
    if (log.events.length === 0) {
      await log.close()
      return
    }
    const state = replay(log.events, runId)
    const run = {
      id: runId,
      dir,
      log,
      state,
      lock: Promise.resolve(),
      lastSnapshotSeq: log.events.length,
      activeDispatches: new Map(),
      parentAgent: null,
    }
    this.runs.set(runId, run)
    if (state.status === 'running') {
      await this.#append(run, 'swarm/recovered', { from: 'running' }, { actor: 'system' })
      await this.#append(run, 'swarm/status/changed', { from: 'running', to: 'paused', reason: 'recovered' }, { actor: 'system' })
      await writeSnapshot(dir, this.#snapshotState(state, false))
    }
  }

  async close() {
    for (const run of this.runs.values()) {
      for (const dispatch of run.activeDispatches?.values() ?? []) {
        try {
          dispatch.controller.abort()
          await dispatch.activation?.dispose?.()
        } catch {
          // best effort during teardown
        }
      }
      run.activeDispatches?.clear()
      await run.log.close()
    }
    this.runs.clear()
    this.childRuns.clear()
    this.opened = false
  }

  /**
   * @param {string} runId
   * @param {(run: any) => Promise<any>} operation
   */
  #withRun(runId, operation) {
    const run = this.runs.get(runId)
    if (!run) throw new SwarmError('RUN_NOT_FOUND', `swarm run '${runId}' not found`, { runId })
    const next = run.lock.then(() => operation(run))
    run.lock = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  /**
   * @param {any} run
   * @param {string} type
   * @param {unknown} payload
   * @param {{ actor?: string, causationId?: string | null }} [meta]
   */
  async #append(run, type, payload, meta = {}) {
    if (run.state.endedAt && type !== 'swarm/tick') {
      // Terminal runs are immutable except for reads; recovery never appends.
      throw new SwarmError('RUN_ENDED', `swarm run '${run.id}' already ended`, { status: run.state.status })
    }
    const event = await run.log.append(type, payload, {
      actor: meta.actor ?? 'system',
      causationId: meta.causationId ?? null,
    })
    applyEvent(run.state, event)
    if (run.log.lastSeq - run.lastSnapshotSeq >= 100) {
      await writeSnapshot(run.dir, this.#snapshotState(run.state, false))
      run.lastSnapshotSeq = run.log.lastSeq
    }
    return event
  }

  #requireOpen(run) {
    if (!['created', 'running', 'paused', 'draining'].includes(run.state.status)) {
      throw new SwarmError('RUN_ENDED', `swarm is ${run.state.status}`, { status: run.state.status })
    }
  }

  #requireActive(run) {
    if (run.state.status !== 'running') {
      throw new SwarmError('RUN_NOT_RUNNING', `swarm is ${run.state.status}; resume it first`, {
        status: run.state.status,
      })
    }
  }

  /**
   * @param {string} runId
   * @param {string} taskId
   */
  #task(run, taskId) {
    const task = run.state.tasks.get(taskId)
    if (!task) throw new SwarmError('TASK_NOT_FOUND', `task '${taskId}' not found`, { taskId })
    return task
  }

  /**
   * @param {string} runId
   * @param {string} memberId
   */
  #member(run, memberId) {
    const member = run.state.members.get(memberId)
    if (!member) throw new SwarmError('MEMBER_NOT_FOUND', `member '${memberId}' not found`, { memberId })
    if (member.status === 'left' || member.status === 'lost') {
      throw new SwarmError('MEMBER_GONE', `member '${memberId}' is ${member.status}`, { memberId })
    }
    return member
  }

  /**
   * @param {any} run
   * @param {string} role
   */
  #nextMemberName(run, role) {
    const names = new Set([...run.state.members.values()].map((member) => member.name))
    let index = 1
    while (names.has(`${role}-${index}`)) index += 1
    return `${role}-${index}`
  }

  /**
   * Count tasks that currently hold a live worktree (awarded through approved).
   * @param {any} run
   */
  #activeWorktreeCount(run) {
    const active = new Set(['awarded', 'working', 'submitted', 'reviewing', 'approved'])
    let count = 0
    for (const task of run.state.tasks.values()) {
      if (task.worktree && active.has(task.state)) count += 1
    }
    return count
  }

  /**
   * Lazily construct the per-run worktree pool. Returns null when the run is not
   * in a git repository, has no base commit, or isolation is disabled.
   * @param {any} run
   */
  async #workspaceFor(run) {
    const enabled = run.state.config?.workspace?.enabled ?? this.config.workspace?.enabled ?? false
    if (!enabled) return null
    if (!run.state.baseCommit) return null
    if (!run.workspace) {
      run.workspace = new WorkspaceManager({
        repo: run.state.repo,
        runId: run.id,
        root: run.state.config?.workspace?.root || this.workspaceRoot,
        gitRoot: run.state.preflight?.gitRoot,
        baseCommit: run.state.baseCommit,
        logger: this.logger,
        clock: this.clock,
      })
    }
    await run.workspace.init()
    return run.workspace
  }

  /** Remove worktrees at the end of a run when `workspace.keep` is false. @param {any} run */
  async #cleanupWorkspace(run) {
    const keep = run.state.config?.workspace?.keep ?? this.config.workspace.keep
    if (keep) return null
    try {
      const workspace = await this.#workspaceFor(run)
      if (!workspace) return null
      const taskPaths = [...run.state.tasks.values()]
        .filter((task) => task.worktree?.path)
        .map((task) => task.worktree.path)
      const result = await workspace.cleanup({ taskPaths })
      if (result.removed.length > 0) {
        this.logger?.info?.(`[swarm] cleaned ${result.removed.length} worktree(s) for ${run.id}`)
      }
      return result
    } catch (error) {
      this.logger?.warn?.(`[swarm] worktree cleanup failed: ${String(error?.message ?? error)}`)
      return null
    }
  }

  /* ------------------------------------------------------------------ */
  /* Lifecycle                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * @param {{
   *   goal: string, repo: string, topology?: string, members?: number, mode?: string,
   *   budget?: { tokens?: number, usd?: number, wallMs?: number },
   *   roster?: Array<{ role?: string, name?: string, model?: string }>,
   *   force?: boolean, actor?: string,
   * }} request
   */
  async createRun(request, options = {}) {
    const goal = asString(request.goal)
    if (!goal) throw new SwarmError('INVALID_GOAL', 'swarm_start requires a non-empty goal')
    const repo = path.resolve(asString(request.repo) || process.cwd())
    const mode = request.mode === 'single' ? 'single' : 'swarm'
    const topology = request.topology ?? this.config.topology
    const requestedMembers = mode === 'single' ? 1 : asInt(request.members, this.config.members, 1, this.config.maxMembers)
    if (requestedMembers > this.config.maxMembers) {
      throw new SwarmError('TOO_MANY_MEMBERS', `members must be <= ${this.config.maxMembers}`, {
        members: requestedMembers,
      })
    }

    let preflight = { ok: true, checks: [], fixes: [] }
    if (this.config.preflight.enabled && !request.force) {
      preflight = await preflightRepo(repo, { minFreeMb: this.config.preflight.minFreeMb })
      if (!preflight.ok) {
        throw new SwarmError('PREFLIGHT_FAILED', `repository preflight failed: ${preflight.fixes.join('; ')}`, {
          preflight,
        })
      }
    }
    if (!preflight.baseCommit && this.config.workspace.enabled) {
      // Preflight can be disabled (or skipped with force); worktree isolation
      // still needs a git root and a base commit, so resolve them quietly.
      try {
        const top = await git(['rev-parse', '--show-toplevel'], repo)
        const head = await git(['rev-parse', 'HEAD'], repo)
        preflight = { ...preflight, gitRoot: top.stdout, baseCommit: head.stdout }
      } catch {
        // non-git repository: workspace stays in degraded patch-only mode
      }
    }

    const limits = {
      run: {
        tokens: asInt(request.budget?.tokens, this.config.budget.tokens, 1_000, 1_000_000_000),
        usd: Math.max(0, Number(request.budget?.usd ?? this.config.budget.usd)),
        wallMs: asInt(request.budget?.wallMs, this.config.budget.wallMs, 0, 30 * 24 * 3600_000),
      },
      taskTokens: this.config.taskBudget.tokens,
      memberTokens: this.config.memberBudget.tokens,
    }
    const roster = this.#buildRoster(requestedMembers, mode, request.roster)
    const gateCommands =
      this.config.gate.commands.length > 0
        ? [...this.config.gate.commands]
        : this.config.gate.autoDetect && preflight.testCommand
          ? [preflight.testCommand]
          : []
    const autoDispatch = request.autoDispatch === undefined ? this.config.dispatch.auto : request.autoDispatch === true

    const runId = newId('swarm')
    const dir = path.join(this.runsDir, runId)
    const log = new EventLog({ dir, runId, logger: this.logger, clock: this.clock })
    await log.open()
    const run = {
      id: runId,
      dir,
      log,
      state: emptyRunState(runId),
      lock: Promise.resolve(),
      lastSnapshotSeq: 0,
      activeDispatches: new Map(),
      parentAgent: options.agent ?? null,
    }
    this.runs.set(runId, run)
    try {
      await this.#append(
        run,
        'swarm/created',
        {
          goal,
          repo,
          topology,
          mode,
          maxMembers: this.config.maxMembers,
          baseCommit: preflight.baseCommit ?? '',
          gateCommands,
          concurrencyLimit:
            mode === 'single'
              ? 1
              : Math.min(3, this.config.maxMembers, this.config.workspace.maxConcurrent),
          limits,
          preflight,
          config: {
            members: requestedMembers,
            maxMembers: this.config.maxMembers,
            topology,
            mode,
            market: this.config.market,
            review: this.config.review,
            board: this.config.board,
            pheromone: this.config.pheromone,
            convergence: this.config.convergence,
            workspace: this.config.workspace,
            gate: this.config.gate,
            merge: this.config.merge,
            dispatch: { ...this.config.dispatch, auto: autoDispatch },
          },
        },
        { actor: request.actor ?? 'human' },
      )
      for (const member of roster) {
        await this.#append(run, 'swarm/member/joined', { member: { ...member, status: 'idle' } }, { actor: 'system' })
      }
      if (this.config.orchestrator.autoStart) {
        await this.#append(run, 'swarm/status/changed', { from: 'created', to: 'running' }, { actor: 'system' })
      }
      await writeSnapshot(dir, this.#snapshotState(run.state, false))
      return this.snapshot(runId, true)
    } catch (error) {
      this.runs.delete(runId)
      await log.close().catch(() => undefined)
      throw error
    }
  }

  /**
   * @param {number} count
   * @param {string} mode
   * @param {Array<{ role?: string, name?: string, model?: string }>} [roster]
   */
  #buildRoster(count, mode, roster) {
    if (Array.isArray(roster) && roster.length > 0) {
      if (roster.length > this.config.maxMembers) {
        throw new SwarmError('TOO_MANY_MEMBERS', `roster size ${roster.length} exceeds maxMembers`)
      }
      const names = new Set()
      return roster.map((item, index) => {
        const role = ROLES.includes(/** @type {any} */ (item.role)) ? item.role : 'worker'
        const name = asString(item.name, `${role}-${index + 1}`)
        if (names.has(name)) throw new SwarmError('DUPLICATE_MEMBER', `duplicate member name '${name}'`)
        names.add(name)
        return makeMember({ role, name, model: item.model, at: this.clock() })
      })
    }
    if (mode === 'single') {
      return [makeMember({ role: 'worker', name: 'solo', model: 'inherit', at: this.clock() })]
    }
    const members = [makeMember({ role: 'queen', name: 'queen', model: 'strong', at: this.clock() })]
    for (let index = 1; index < count; index += 1) {
      members.push(makeMember({ role: 'worker', name: `worker-${index}`, model: 'fast', at: this.clock() }))
    }
    return members
  }

  /**
   * @param {string} [runId]
   * @returns {Promise<any>}
   */
  async status(runId, detail = false) {
    if (!runId) {
      const runs = [...this.runs.values()].map((run) => ({
        swarmId: run.id,
        goal: run.state.goal,
        status: run.state.status,
        tasks: run.state.tasks.size,
        createdAt: run.state.createdAt,
      }))
      return { runs, active: runs.filter((run) => ['created', 'running', 'paused', 'draining'].includes(run.status)).length }
    }
    return this.snapshot(runId, detail)
  }

  /** @param {string} runId @param {boolean} [detail] */
  snapshot(runId, detail = false) {
    const run = this.runs.get(runId)
    if (!run) throw new SwarmError('RUN_NOT_FOUND', `swarm run '${runId}' not found`, { runId })
    return this.#snapshotState(run.state, detail, run.log)
  }

  /**
   * @param {string} runId
   * @param {{ since?: number, limit?: number }} [options]
   */
  events(runId, options = {}) {
    const run = this.runs.get(runId)
    if (!run) throw new SwarmError('RUN_NOT_FOUND', `swarm run '${runId}' not found`, { runId })
    const since = Math.max(0, Math.trunc(options.since ?? 0))
    const limit = Math.min(1000, Math.max(1, Math.trunc(options.limit ?? 200)))
    return run.log.events.filter((event) => event.seq > since).slice(0, limit)
  }

  /**
   * @param {any} state
   * @param {boolean} detail
   * @param {any} [log]
   */
  #snapshotState(state, detail, log) {
    const budget = budgetSnapshot(state.budget)
    const now = this.clock()
    const tasks = [...state.tasks.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((task) => ({
        ...task,
        lease: task.lease ? { ...task.lease } : null,
        bids: task.bids.slice().sort((a, b) => b.score - a.score),
      }))
    const members = [...state.members.values()].sort((a, b) => a.joinedAt - b.joinedAt).map((member) => ({ ...member }))
    const stats = {
      members: members.length,
      tasks: tasks.length,
      merged: tasks.filter((task) => task.state === 'merged').length,
      failed: tasks.filter((task) => task.state === 'failed').length,
      active: tasks.filter((task) => !isTerminalTaskState(task.state)).length,
      boardEntries: state.board.size,
      events: log?.events.length ?? 0,
    }
    const base = {
      swarmId: state.id,
      runId: state.id,
      goal: state.goal,
      repo: state.repo,
      topology: state.topology,
      mode: state.mode,
      status: state.status,
      round: state.round,
      concurrencyLimit: state.concurrencyLimit,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      endedAt: state.endedAt,
      recovered: state.recovered,
      convergedReason: state.convergedReason,
      baseCommit: state.baseCommit ?? '',
      gateCommands: state.gateCommands ?? [],
      workspace: {
        enabled: Boolean(state.config?.workspace?.enabled),
        integrationBranch: state.baseCommit ? `swarm/${state.id}/integration` : null,
        degraded: state.workspaceDegraded?.length ?? 0,
        conflicts: state.mergeConflicts?.length ?? 0,
      },
      dispatch: {
        auto: Boolean(state.config?.dispatch?.auto),
        active: this.runs.get(state.id)?.activeDispatches?.size ?? 0,
        parentBound: Boolean(this.runs.get(state.id)?.parentAgent),
      },
      preflight: state.preflight ?? null,
      convergence: this.#convergenceView(state, now),
      stats,
      budget,
      members,
      tasks,
    }
    if (!detail) return base
    return {
      ...base,
      board: [...state.board.values()].sort((a, b) => b.updatedAt - a.updatedAt),
      pheromones: pheromoneSnapshot(state.pheromones, {
        now,
        halfLifeMs: state.config?.pheromone?.halfLifeMs ?? this.config.pheromone.halfLifeMs,
      }),
      reviews: [...state.reviews.values()],
      reviewers: Object.fromEntries(state.reviewersByPatch),
      reviewTimeouts: [...(state.reviewTimeouts ?? [])],
      judgements: [...(state.judgements ?? [])],
      roundHistory: [...(state.roundHistory ?? [])],
      scaleHistory: [...(state.scaleHistory ?? [])],
      reviewEscalations: [...(state.reviewEscalations ?? [])],
      topologyGraph: this.#topologyView(state),
      messages: [...state.messages.values()].slice(-100).map((message) => ({
        id: message.id,
        from: message.from,
        to: message.to,
        kind: message.kind,
        topic: message.topic,
        correlationId: message.correlationId,
        sentAt: message.sentAt,
        expiresAt: message.expiresAt,
        status: message.status,
        deliveredTo: [...message.deliveredTo],
        bytes: Buffer.byteLength(message.payload ?? '', 'utf8'),
      })),
      patches: [...state.patches.values()],
      events: log ? log.events.slice(-50).map((event) => ({ seq: event.seq, type: event.type, at: event.at })) : [],
    }
  }

  /** @param {any} state */
  #topologyView(state) {
    const nodes = [...state.members.values()].map((member) => ({
      id: member.id,
      name: member.name,
      role: member.role,
      status: member.status,
      load: member.load ?? 0,
      done: member.stats?.done ?? 0,
      failed: member.stats?.failed ?? 0,
    }))
    const authorOf = (task) =>
      task?.assignee ?? (task?.patchId ? state.patches.get(task.patchId)?.author : null)
    /** @type {Map<string, { from: string, to: string, kind: string, weight: number }>} */
    const edges = new Map()
    const addEdge = (from, to, kind) => {
      if (!from || !to || from === to) return
      const key = `${kind}\u0000${from}\u0000${to}`
      const edge = edges.get(key) ?? { from, to, kind, weight: 0 }
      edge.weight += 1
      edges.set(key, edge)
    }
    for (const review of state.reviews.values()) {
      const patch = state.patches.get(review.patchId)
      if (patch) addEdge(patch.author, review.reviewerId, 'review')
    }
    for (const task of state.tasks.values()) {
      for (const depId of task.deps ?? []) {
        addEdge(authorOf(state.tasks.get(depId)), authorOf(task), 'dependency')
      }
    }
    return {
      nodes,
      edges: [...edges.values()].sort((a, b) => b.weight - a.weight).slice(0, 200),
    }
  }

  /**
   * CSV of the three-level ledger for one run.
   * @param {string} runId
   */
  costReport(runId) {
    const run = this.runs.get(runId)
    if (!run) throw new SwarmError('RUN_NOT_FOUND', `swarm run '${runId}' not found`, { runId })
    const budget = budgetSnapshot(run.state.budget)
    /** @type {Array<Array<unknown>>} */
    const rows = [['scope', 'key', 'tokens', 'reserved_tokens', 'calls', 'usd']]
    rows.push(['run', 'run', budget.run.tokens, budget.run.reservedTokens, budget.run.calls, budget.run.usd])
    for (const [key, ledger] of Object.entries(budget.tasks)) {
      rows.push(['task', key, ledger.tokens, ledger.reservedTokens, ledger.calls, ledger.usd])
    }
    for (const [key, ledger] of Object.entries(budget.members)) {
      rows.push(['member', key, ledger.tokens, ledger.reservedTokens, ledger.calls, ledger.usd])
    }
    /** @type {Map<string, { tokens: number, reservedTokens: number, calls: number, usd: number }>} */
    const roles = new Map()
    for (const member of run.state.members.values()) {
      const ledger = budget.members[member.id]
      if (!ledger) continue
      const aggregate = roles.get(member.role) ?? { tokens: 0, reservedTokens: 0, calls: 0, usd: 0 }
      aggregate.tokens += ledger.tokens
      aggregate.reservedTokens += ledger.reservedTokens
      aggregate.calls += ledger.calls
      aggregate.usd += ledger.usd
      roles.set(member.role, aggregate)
    }
    for (const [role, ledger] of roles) {
      rows.push(['role', role, ledger.tokens, ledger.reservedTokens, ledger.calls, ledger.usd])
    }
    const escape = (value) => {
      const text = String(value)
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
    }
    const csv = rows.map((row) => row.map(escape).join(',')).join('\n')
    return { filename: `${runId}-cost.csv`, csv: `${csv}\n` }
  }

  /** @param {any} state */
  #convergenceView(state, now) {
    if (state.status === 'converged') return { converged: true, reason: state.convergedReason }
    const budget = runBudgetState(state.budget, { now, startedAt: state.createdAt })
    const open = [...state.tasks.values()].filter((task) => !isTerminalTaskState(task.state))
    return {
      converged: false,
      openTasks: open.length,
      budgetRatio: Number(budget.ratio.toFixed(3)),
      budgetExhausted: budget.exhausted || budget.wallExhausted,
    }
  }

  /**
   * @param {string} runId
   * @param {{ action: string, reason?: string, actor?: string, text?: string, tokens?: number }} input
   */
  async intervene(runId, input) {
    return this.#withRun(runId, async (run) => {
      const action = input.action
      const actor = input.actor ?? 'human'
      const reason = input.reason ?? ''
      this.#requireOpen(run)
      if (action === 'pause') {
        assertTransition('swarm', run.state.status, 'paused')
        await this.#append(run, 'swarm/status/changed', { from: run.state.status, to: 'paused', reason }, { actor })
      } else if (action === 'resume' || action === 'start') {
        assertTransition('swarm', run.state.status, 'running')
        await this.#append(run, 'swarm/status/changed', { from: run.state.status, to: 'running', reason }, { actor })
      } else if (action === 'drain') {
        assertTransition('swarm', run.state.status, 'draining')
        await this.#append(run, 'swarm/status/changed', { from: run.state.status, to: 'draining', reason }, { actor })
      } else if (action === 'abort') {
        await this.#append(run, 'swarm/aborted', { reason: reason || 'human' }, { actor })
        await this.#cleanupWorkspace(run)
      } else if (action === 'steer') {
        await this.#append(
          run,
          'swarm/intervened',
          { action: 'steer', text: asString(input.text), reason, target: input.target ?? null },
          { actor },
        )
      } else if (action === 'budget') {
        const tokens = Math.trunc(Number(input.tokens ?? 0))
        if (!Number.isFinite(tokens) || tokens <= 0) {
          throw new SwarmError('INVALID_BUDGET', 'budget action requires a positive tokens delta')
        }
        await this.#append(run, 'swarm/budget/adjusted', { tokens, reason }, { actor })
      } else if (action === 'add_member') {
        const role = input.role === 'reviewer' ? 'reviewer' : 'worker'
        const activeMembers = [...run.state.members.values()].filter(
          (member) => member.status !== 'left' && member.status !== 'lost',
        )
        if (activeMembers.length >= this.config.maxMembers) {
          throw new SwarmError('TOO_MANY_MEMBERS', `member limit ${this.config.maxMembers} reached`)
        }
        const name = asString(input.name) || this.#nextMemberName(run, role)
        if ([...run.state.members.values()].some((member) => member.name === name)) {
          throw new SwarmError('MEMBER_DUPLICATE', `member name '${name}' already exists`)
        }
        const model = ['fast', 'strong', 'inherit'].includes(input.model)
          ? input.model
          : role === 'worker'
            ? 'fast'
            : 'inherit'
        const member = makeMember({ role, name, model, at: this.clock() })
        await this.#append(
          run,
          'swarm/member/joined',
          { member: { ...member, status: 'idle' } },
          { actor },
        )
      } else if (action === 'remove_member') {
        const member = this.#member(run, input.memberId)
        if (member.role === 'queen') {
          throw new SwarmError('QUEEN_REQUIRED', 'the queen cannot be removed from a run')
        }
        const busy = [...run.state.tasks.values()].find(
          (task) =>
            task.assignee === member.id &&
            ['awarded', 'working', 'submitted', 'reviewing', 'approved', 'blocked'].includes(task.state),
        )
        if (busy) {
          throw new SwarmError('MEMBER_BUSY', `member still owns task ${busy.id}`, { taskId: busy.id })
        }
        const reviewing = [...run.state.tasks.values()].some(
          (task) =>
            ['reviewing', 'approved'].includes(task.state) &&
            (run.state.reviewersByPatch.get(task.patchId) ?? []).includes(member.id),
        )
        if (reviewing) {
          throw new SwarmError('MEMBER_BUSY', 'member still has an open review assignment', {
            memberId: member.id,
          })
        }
        await this.#append(
          run,
          'swarm/member/left',
          { memberId: member.id, status: 'left', reason },
          { actor },
        )
      } else if (action === 'converge') {
        await this.#append(run, 'swarm/converged', { reason: reason || 'human' }, { actor })
        await this.#cleanupWorkspace(run)
      } else {
        throw new SwarmError('INVALID_ACTION', `unknown intervene action '${action}'`, { action })
      }
      return this.#snapshotState(run.state, true, run.log)
    })
  }

  /* ------------------------------------------------------------------ */
  /* Task market                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * @param {string} runId
   * @param {any} input
   */
  async createTask(runId, input) {
    return this.#withRun(runId, async (run) => {
      this.#requireActive(run)
      const title = asString(input.title)
      if (!title) throw new SwarmError('TASK_INVALID', 'task requires a title')
      const acceptance = stringArray(input.acceptance)
      if (acceptance.length === 0) {
        throw new SwarmError('TASK_INVALID', 'task requires at least one machine-checkable acceptance criterion')
      }
      const deps = stringArray(input.deps)
      for (const dep of deps) this.#task(run, dep)
      const scopeFiles = stringArray(input.scope?.files ?? input.files)
      const budgetTokens = asInt(input.budget?.tokens ?? input.budgetTokens, this.config.taskBudget.tokens, 1, 1_000_000_000)
      const task = makeTask(
        {
          title,
          acceptance,
          scope: { files: scopeFiles, symbols: stringArray(input.scope?.symbols ?? input.symbols) },
          deps,
          priority: asInt(input.priority, 50, 0, 100),
          budget: { tokens: budgetTokens },
          estimate: input.estimate,
          tags: stringArray(input.tags),
        },
        this.clock(),
      )
      const warnings = []
      if (scopeFiles.length > 10) warnings.push(`scope touches ${scopeFiles.length} files (>10); consider splitting`)
      if (budgetTokens > run.state.budget.limits.runTokens * 0.3) {
        warnings.push('task budget exceeds 30% of the run budget; consider splitting')
      }
      await this.#append(run, 'swarm/task/created', { task }, { actor: input.actor ?? 'queen' })
      return { task: run.state.tasks.get(task.id), warnings }
    })
  }

  /**
   * @param {string} runId
   * @param {string} taskId
   * @param {{ actor?: string }} [options]
   */
  async advertiseTask(runId, taskId, options = {}) {
    return this.#withRun(runId, async (run) => {
      this.#requireActive(run)
      const task = this.#task(run, taskId)
      if (!['draft', 'expired', 'failed', 'blocked'].includes(task.state)) {
        throw new SwarmError('TASK_INVALID_STATE', `cannot advertise a task in state '${task.state}'`)
      }
      await this.#append(run, 'swarm/task/advertised', { taskId }, { actor: options.actor ?? 'queen' })
      return run.state.tasks.get(taskId)
    })
  }

  /**
   * @param {string} runId
   * @param {string} taskId
   * @param {{ memberId: string, estimate?: { tokens?: number, minutes?: number }, reason?: string, actor?: string }} input
   */
  async bid(runId, taskId, input) {
    return this.#withRun(runId, async (run) => {
      this.#requireActive(run)
      const task = this.#task(run, taskId)
      if (!['advertised', 'bidding'].includes(task.state)) {
        throw new SwarmError('TASK_INVALID_STATE', `task is '${task.state}', not open for bids`)
      }
      const member = this.#member(run, input.memberId)
      if (task.bids.some((bid) => bid.memberId === member.id)) {
        throw new SwarmError('DUPLICATE_BID', 'member already bid on this task', { memberId: member.id })
      }
      const scored = autoScore(member, task, {
        round: run.state.round,
        maxWip: this.config.market.wipPerMember,
        agingRounds: this.config.market.agingRounds,
        taskBudgetTokens: this.config.taskBudget.tokens,
      })
      const bid = {
        memberId: member.id,
        memberName: member.name,
        at: this.clock(),
        score: scored.score,
        components: scored.components,
        estimate: {
          tokens: asInt(input.estimate?.tokens, task.estimate.tokens, 1, 1_000_000_000),
          minutes: asInt(input.estimate?.minutes, task.estimate.minutes, 1, 100_000),
        },
        reason: asString(input.reason, ''),
      }
      await this.#append(run, 'swarm/bid/submitted', { taskId, bid }, { actor: member.id })
      return { accepted: true, score: bid.score, components: bid.components }
    })
  }

  /**
   * Award a task to a bidder, or fall back to the best evaluated member.
   * @param {string} runId
   * @param {string} taskId
   * @param {{ memberId?: string, force?: boolean, reason?: string, actor?: string }} [input]
   */
  async awardTask(runId, taskId, input = {}) {
    return this.#withRun(runId, async (run) => {
      this.#requireActive(run)
      const task = this.#task(run, taskId)
      if (!['draft', 'advertised', 'bidding', 'expired', 'failed', 'blocked', 'awarded'].includes(task.state)) {
        throw new SwarmError('TASK_INVALID_STATE', `cannot award a task in state '${task.state}'`)
      }
      if (task.state === 'awarded' && !input.force) {
        throw new SwarmError('TASK_ALREADY_AWARDED', 'task is already awarded; pass force to reassign')
      }
      if (input.force && !asString(input.reason)) {
        throw new SwarmError('REASON_REQUIRED', 'forced assignment requires a reason')
      }
      const maxWip = this.config.market.wipPerMember
      /** @type {{ memberId: string, score: number }} */
      let winner
      if (input.memberId) {
        this.#member(run, input.memberId)
        winner = { memberId: input.memberId, score: task.bids.find((bid) => bid.memberId === input.memberId)?.score ?? 0 }
      } else {
        const ranked = rankBids(task.bids, this.config.market.minScore)
        if (ranked.length > 0) {
          winner = ranked[0]
        } else if (task.bids.length > 0) {
          // Bids below the market threshold still express willingness; the queen
          // may award the best of them instead of declaring the task unsellable.
          winner = task.bids.slice().sort((a, b) => b.score - a.score || a.at - b.at)[0]
        } else {
          const candidates = [...run.state.members.values()]
            .filter((member) => member.role !== 'queen' && member.load < maxWip)
            .map((member) => {
              const scored = autoScore(member, task, {
                round: run.state.round,
                maxWip,
                agingRounds: this.config.market.agingRounds,
                taskBudgetTokens: this.config.taskBudget.tokens,
              })
              return { memberId: member.id, score: scored.score }
            })
            .sort((a, b) => b.score - a.score)
          if (candidates.length === 0) {
            throw new SwarmError(
              'NO_BIDS',
              'no eligible member can take this task; free WIP capacity or assign explicitly with force+reason',
            )
          }
          winner = candidates[0]
        }
      }
      const member = this.#member(run, winner.memberId)
      if (member.load >= maxWip) {
        throw new SwarmError('WIP_LIMIT', `member '${member.name}' already holds ${member.load} tasks`, {
          memberId: member.id,
        })
      }
      const fence = (run.state.fence ?? 0) + 1
      const lease = createLease({
        memberId: member.id,
        taskId,
        fence,
        now: this.clock(),
        leaseMs: this.config.market.leaseMs,
      })
      let worktree = null
      /** @type {{ code: string, message: string } | null} */
      let degraded = null
      try {
        const workspace = await this.#workspaceFor(run)
        if (workspace) {
          const limit = run.state.config?.workspace?.maxConcurrent ?? this.config.workspace.maxConcurrent
          if (this.#activeWorktreeCount(run) >= limit) {
            throw new SwarmError('WORKTREE_LIMIT', `worktree concurrency limited to ${limit}`, { limit })
          }
          const floor = run.state.config?.workspace?.diskThresholdMb ?? this.config.workspace.diskThresholdMb
          if (floor > 0) await workspace.checkDisk(floor)
          worktree = await workspace.createTaskWorktree({ taskId })
        }
      } catch (error) {
        if (error?.code === 'WORKTREE_LIMIT' || error?.code === 'DISK_LOW') throw error
        degraded = {
          code: String(error?.code ?? 'WORKTREE_FAILED'),
          message: String(error?.message ?? error),
        }
        this.logger?.warn?.(`[swarm] worktree degraded for ${taskId}: ${degraded.message}`)
      }
      await this.#append(
        run,
        'swarm/task/awarded',
        {
          taskId,
          memberId: member.id,
          fromMemberId: task.assignee && task.assignee !== member.id ? task.assignee : null,
          lease,
          worktree,
          score: winner.score,
          forced: Boolean(input.force),
          reason: input.reason ?? '',
        },
        { actor: input.actor ?? 'queen' },
      )
      if (degraded) {
        await this.#append(run, 'swarm/workspace/degraded', { taskId, ...degraded }, { actor: 'system' })
      }
      return run.state.tasks.get(taskId)
    })
  }

  /**
   * @param {string} runId
   * @param {string} taskId
   * @param {{ reason?: string, actor?: string }} [options]
   */
  async cancelTask(runId, taskId, options = {}) {
    return this.#withRun(runId, async (run) => {
      this.#requireActive(run)
      const task = this.#task(run, taskId)
      if (isTerminalTaskState(task.state)) {
        throw new SwarmError('TASK_INVALID_STATE', `task is already ${task.state}`)
      }
      assertTransition('task', task.state, 'cancelled')
      await this.#append(
        run,
        'swarm/task/state',
        { taskId, to: 'cancelled', reason: options.reason ?? 'cancelled' },
        { actor: options.actor ?? 'queen' },
      )
      return run.state.tasks.get(taskId)
    })
  }

  /**
   * @param {string} runId
   * @param {string} taskId
   * @param {{ memberId: string, fence: number, actor?: string }} input
   */
  async startTask(runId, taskId, input) {
    return this.#withRun(runId, async (run) => {
      this.#requireActive(run)
      const task = this.#task(run, taskId)
      if (task.state === 'working') return task
      if (task.state !== 'awarded') {
        throw new SwarmError('TASK_INVALID_STATE', `task is '${task.state}', not awarded`)
      }
      assertLease(task.lease, { memberId: input.memberId, fence: input.fence }, this.clock())
      await this.#append(run, 'swarm/task/working', { taskId }, { actor: input.memberId })
      return run.state.tasks.get(taskId)
    })
  }

  /**
   * @param {string} runId
   * @param {string} taskId
   * @param {any} input
   */
  async submitPatch(runId, taskId, input) {    return this.#withRun(runId, async (run) => {
      this.#requireActive(run)
      const task = this.#task(run, taskId)
      if (!['working', 'awarded'].includes(task.state)) {
        throw new SwarmError('TASK_INVALID_STATE', `task is '${task.state}', not working`)
      }
      assertLease(task.lease, { memberId: input.memberId, fence: input.fence }, this.clock())
      const patchId = newId('patch')
      /** @type {any} */
      let collected = null
      if (task.worktree) {
        const workspace = await this.#workspaceFor(run)
        if (workspace) {
          collected = await workspace.collectTaskPatch({
            taskId,
            diffFile: path.join(run.dir, 'patches', `${patchId}.diff`),
          })
        }
      }
      const branch = collected?.branch ?? asString(input.branch)
      if (!branch) throw new SwarmError('PATCH_INVALID', 'patch requires a branch name')
      const tests = Array.isArray(input.tests)
        ? input.tests.map((test) =>
            typeof test === 'string'
              ? { name: test, passed: null }
              : {
                  name: String(test.name ?? 'test'),
                  passed: test.passed === true ? true : test.passed === false ? false : null,
                  output: typeof test.output === 'string' ? test.output.slice(0, 2000) : '',
                },
          )
        : []
      const patch = {
        id: patchId,
        taskId,
        branch,
        commit: collected?.commit ?? asString(input.commit),
        files: collected?.files ?? stringArray(input.files),
        diffStat: collected?.diffStat ?? input.diffStat ?? null,
        diffPath: collected ? `patches/${patchId}.diff` : null,
        diffBytes: collected?.diffBytes ?? 0,
        worktree: task.worktree?.path ?? null,
        tests,
        notes: asString(input.notes).slice(0, 4000),
        author: task.assignee,
        state: 'submitted',
        createdAt: this.clock(),
      }
      await this.#append(run, 'swarm/task/submitted', { taskId, patch }, { actor: task.assignee ?? 'worker' })
      const review = await this.#openReview(run, taskId, patch.id, { actor: 'system' })
      return { patchId: patch.id, taskState: run.state.tasks.get(taskId).state, review }
    })
  }

  /**
   * Spawn one real subagent for an awarded task, let it work in the task
   * worktree, then collect and submit the result automatically.
   *
   * Validation happens under the run lock; the child runs outside it so a long
   * model turn does not block the rest of the swarm. The lease is extended to
   * cover the dispatch timeout before the child starts.
   *
   * @param {string} runId
   * @param {string} taskId
   * @param {{ memberId: string, fence: number, agent?: any, signal?: AbortSignal, wait?: boolean, conflict?: any }} input
   */
  async dispatchTask(runId, taskId, input) {
    const prepared = await this.#withRun(runId, async (run) => {
      this.#requireActive(run)
      const task = this.#task(run, taskId)
      if (!task.worktree) {
        throw new SwarmError('NO_WORKTREE', 'dispatch requires an isolated worktree (git repository + workspace enabled)')
      }
      if (!['awarded', 'working'].includes(task.state)) {
        throw new SwarmError('TASK_INVALID_STATE', `task is '${task.state}', not ready for dispatch`)
      }
      assertLease(task.lease, { memberId: input.memberId, fence: input.fence }, this.clock())
      if (run.activeDispatches.has(taskId)) {
        throw new SwarmError('ALREADY_DISPATCHED', 'a member is already working on this task', {
          childId: run.activeDispatches.get(taskId).childId,
        })
      }
      const member = this.#member(run, input.memberId)
      const halfLife = run.state.config?.pheromone?.halfLifeMs ?? this.config.pheromone.halfLifeMs
      const board = queryEntries(run.state.board, {
        topK: 6,
        tokenBudget: 600,
        now: this.clock(),
        halfLifeMs: halfLife,
        pheromoneWeight: (entry) => topicWeight(run.state.pheromones, entry.topic, this.clock(), halfLife),
      }).entries
      const prompt = buildTaskCard({
        run: run.state,
        task,
        member,
        board,
        conflict: input.conflict ?? (task.state === 'working' ? task.lastConflict : null),
        integrationBranch: `swarm/${run.id}/integration`,
      })
      const lease = {
        ...task.lease,
        expiresAt: Math.max(task.lease.expiresAt, this.clock() + this.config.dispatch.timeoutMs + 120_000),
      }
      await this.#append(run, 'swarm/task/lease', { taskId, lease }, { actor: 'system' })
      return { run, task, member, prompt }
    })

    const { run, task, member, prompt } = prepared
    if (input.agent) run.parentAgent = input.agent
    const controller = new AbortController()
    const forwardAbort = () => controller.abort()
    if (input.signal) {
      if (input.signal.aborted) forwardAbort()
      else input.signal.addEventListener('abort', forwardAbort, { once: true })
    }
    const timer = setTimeout(() => controller.abort(), this.config.dispatch.timeoutMs)
    timer.unref?.()

    let activation
    try {
      activation = await this.runner.start({
        ctx: this.hostCtx,
        agent: input.agent,
        prompt,
        cwd: task.worktree.path,
        label: `swarm/${runId}/${taskId}`,
        signal: controller.signal,
      })
    } catch (error) {
      clearTimeout(timer)
      input.signal?.removeEventListener?.('abort', forwardAbort)
      await this.#recordDispatchFailure(runId, taskId, null, error)
      throw error
    }

    try {
      await this.#withRun(runId, async (current) => {
        await this.#append(
          current,
          'swarm/dispatch/started',
          { taskId, memberId: member.id, childId: activation.childId },
          { actor: member.id },
        )
      })
    } catch (error) {
      clearTimeout(timer)
      input.signal?.removeEventListener?.('abort', forwardAbort)
      try {
        await activation.dispose?.()
      } catch {
        // best effort when the start event cannot be recorded
      }
      throw error
    }

    const record = { controller, activation, childId: activation.childId, drive: null }
    this.childRuns.set(activation.childId, { runId, taskId, memberId: member.id })
    run.activeDispatches.set(taskId, record)
    const drive = this.#driveDispatch({
      run,
      runId,
      taskId,
      member,
      fence: input.fence,
      activation,
      controller,
      timer,
      forwardAbort,
      signal: input.signal,
    })
    record.drive = drive
    drive.catch(() => undefined)
    if (input.wait === true) return drive
    return { dispatched: true, childId: activation.childId, taskId, status: 'running' }
  }

  /**
   * @param {{ run: any, runId: string, taskId: string, member: any, fence: number, activation: any, controller: AbortController, timer: any, forwardAbort: () => void, signal?: AbortSignal }} input
   */
  async #driveDispatch(input) {
    const { run, runId, taskId, member, fence, activation } = input
    try {
      const result = await activation.result
      const structured =
        result.structured && typeof result.structured === 'object' ? result.structured : {}
      if (result.stopReason !== 'completed') {
        throw new SwarmError('DISPATCH_FAILED', `subagent stopped with '${result.stopReason}'`, {
          stopReason: result.stopReason,
          diagnostic: truncate(result.diagnostic ?? '', 1000),
        })
      }
      await this.#withRun(runId, async (current) => {
        await this.#append(
          current,
          'swarm/dispatch/finished',
          {
            taskId,
            childId: activation.childId,
            stopReason: result.stopReason,
            summary: asString(structured.summary),
            tests: Array.isArray(structured.tests) ? structured.tests : [],
          },
          { actor: member.id },
        )
      })
      if (this.config.dispatch.autoCommit) {
        const workspace = await this.#workspaceFor(run)
        if (workspace) {
          const committed = await workspace.commitDirty({
            taskId,
            message: `swarm: ${taskId} (dispatch ${activation.childId})`,
          })
          if (committed.committed) {
            await this.#withRun(runId, async (current) => {
              await this.#append(
                current,
                'swarm/intervened',
                {
                  action: 'auto_commit',
                  taskId,
                  commit: committed.commit,
                  reason: 'dispatched child left uncommitted work',
                },
                { actor: 'system' },
              )
            })
          }
        }
      }
      return await this.submitPatch(runId, taskId, {
        memberId: member.id,
        fence,
        tests: Array.isArray(structured.tests) ? structured.tests : [],
        notes: asString(structured.summary),
      })
    } catch (error) {
      await this.#recordDispatchFailure(runId, taskId, activation.childId, error)
      throw error
    } finally {
      clearTimeout(input.timer)
      input.signal?.removeEventListener?.('abort', input.forwardAbort)
      run.activeDispatches.delete(taskId)
      try {
        await activation.dispose?.()
      } catch {
        // the child is already gone
      }
    }
  }

  /**
   * @param {string} runId
   * @param {string} taskId
   * @param {string | null} childId
   * @param {any} error
   */
  async #recordDispatchFailure(runId, taskId, childId, error) {
    try {
      await this.#withRun(runId, async (run) => {
        if (!['created', 'running', 'paused', 'draining'].includes(run.state.status)) return
        await this.#append(
          run,
          'swarm/dispatch/failed',
          {
            taskId,
            childId,
            code: String(error?.code ?? 'DISPATCH_FAILED'),
            reason: truncate(String(error?.message ?? error), 1000),
          },
          { actor: 'system' },
        )
      })
    } catch {
      // failure reporting must never mask the original error
    }
  }

  /**
   * Attribute one assistant message's token usage to its dispatch, task, and
   * member. Host usage events are the only place real child spend is visible.
   * @param {string} childId
   * @param {{ inputTokens?: number, outputTokens?: number, reasoningTokens?: number }} usage
   */
  async recordUsage(childId, usage) {
    const info = this.childRuns.get(String(childId))
    if (!info) return false
    const inputTokens = Math.max(0, Math.trunc(usage?.inputTokens ?? 0))
    const outputTokens = Math.max(0, Math.trunc(usage?.outputTokens ?? 0))
    const tokens = inputTokens + outputTokens
    if (tokens <= 0) return false
    return this.#withRun(info.runId, async (run) => {
      if (!['running', 'paused', 'draining'].includes(run.state.status)) return false
      await this.#append(
        run,
        'swarm/budget/charged',
        {
          taskId: info.taskId,
          memberId: info.memberId,
          tokens,
          inputTokens,
          outputTokens,
          calls: 1,
        },
        { actor: 'usage' },
      )
      const budget = runBudgetState(run.state.budget, { now: this.clock(), startedAt: run.state.createdAt })
      if (this.config.budget.hardStop && budget.exhausted) {
        for (const dispatch of run.activeDispatches.values()) dispatch.controller.abort()
      }
      return true
    })
  }

  /**
   * @param {any} run
   * @param {string} taskId
   * @param {string} patchId
   * @param {{ reviewers?: string[], actor?: string }} [options]
   */
  async #openReview(run, taskId, patchId, options = {}) {
    const patch = run.state.patches.get(patchId)
    if (!patch) throw new SwarmError('PATCH_NOT_FOUND', `patch '${patchId}' not found`)
    const members = [...run.state.members.values()]
    const pool = members.filter((member) => member.id !== patch.author)
    const reviewers = Array.isArray(options.reviewers) && options.reviewers.length > 0
      ? options.reviewers
      : pickReviewers(members, patch.author, this.config.review.reviewersPerPatch)
    await this.#append(run, 'swarm/review/opened', { taskId, patchId, reviewers }, { actor: options.actor ?? 'system' })
    if (reviewers.length === 0) {
      // Single-agent baseline: there is nobody to review, so the patch is
      // approved without review and the event says exactly why.
      await this.#append(
        run,
        'swarm/task/state',
        { taskId, to: 'approved', reason: 'no_reviewers_available' },
        { actor: 'system' },
      )
      return { reviewers: [], approvedWithoutReview: true, eligible: pool.length }
    }
    return { reviewers, approvedWithoutReview: false, eligible: pool.length }
  }

  /**
   * @param {string} runId
   * @param {string} patchId
   * @param {{ memberId: string, verdict: string, comments?: any[], evidence?: string[], actor?: string }} input
   */
  async reviewPatch(runId, patchId, input) {
    return this.#withRun(runId, async (run) => {
      this.#requireActive(run)
      const patch = run.state.patches.get(patchId)
      if (!patch) throw new SwarmError('PATCH_NOT_FOUND', `patch '${patchId}' not found`)
      const task = this.#task(run, patch.taskId)
      if (task.state !== 'reviewing') {
        throw new SwarmError('TASK_INVALID_STATE', `task is '${task.state}', not under review`)
      }
      const reviewers = run.state.reviewersByPatch.get(patchId) ?? []
      if (!reviewers.includes(input.memberId)) {
        throw new SwarmError('NOT_REVIEWER', 'only assigned reviewers may vote on this patch', {
          reviewers,
        })
      }
      this.#member(run, input.memberId)
      const review = createReview({
        patchId,
        reviewerId: input.memberId,
        authorId: patch.author,
        verdict: input.verdict,
        comments: input.comments,
        evidence: input.evidence,
        now: this.clock(),
        requireEvidence: this.config.review.requireEvidence,
      })
      await this.#append(run, 'swarm/vote/cast', { taskId: task.id, patchId, review }, { actor: input.memberId })
      const ballots = [...run.state.reviews.values()].filter((item) => item.patchId === patchId)
      const tally = tallyReviews(ballots, {
        eligibleCount: Math.max(1, reviewers.length),
        quorum: this.config.review.quorum,
        requireEvidence: this.config.review.requireEvidence,
      })
      if (tally.passed) {
        await this.#append(run, 'swarm/task/state', { taskId: task.id, to: 'approved', reason: 'review_passed' }, { actor: 'system' })
      } else if (tally.failed) {
        await this.#append(
          run,
          'swarm/task/state',
          { taskId: task.id, to: 'working', reason: 'changes_requested' },
          { actor: 'system' },
        )
      } else if (tally.votes >= reviewers.length) {
        // Every assigned reviewer voted but the result is neither approval nor a
        // rejection (e.g. split abstentions). Escalate instead of hanging.
        await this.#append(
          run,
          'swarm/review/escalated',
          { taskId: task.id, patchId, reason: 'no_decision', tally },
          { actor: 'judge' },
        )
        await this.#append(
          run,
          'swarm/task/state',
          { taskId: task.id, to: 'blocked', reason: 'review_deadlock' },
          { actor: 'judge' },
        )
      }
      return { reviewId: review.id, tally, taskState: run.state.tasks.get(task.id).state, weak: review.weak }
    })
  }

  /**
   * @param {string} runId
   * @param {string} patchId
   * @param {{ mergeCommit?: string, gate?: { passed?: boolean, checks?: any[] }, actor?: string }} [input]
   */
  async mergePatch(runId, patchId, input = {}) {
    return this.#withRun(runId, async (run) => {
      this.#requireActive(run)
      const patch = run.state.patches.get(patchId)
      if (!patch) throw new SwarmError('PATCH_NOT_FOUND', `patch '${patchId}' not found`)
      const task = this.#task(run, patch.taskId)
      if (task.state === 'merged') return run.state.tasks.get(task.id)
      if (task.state !== 'approved') {
        throw new SwarmError('TASK_INVALID_STATE', `task is '${task.state}', not approved`)
      }
      const workspace = task.worktree ? await this.#workspaceFor(run) : null
      const commands = run.state.gateCommands ?? []
      const hasRealGate = Boolean(workspace && task.worktree && commands.length > 0)
      if (!hasRealGate && input.gate?.passed === false) {
        throw new SwarmError('GATE_FAILED', 'merge gate failed', { checks: input.gate.checks ?? [] })
      }

      if (workspace && task.worktree) {
        /** @type {any} */
        let patchGate = null
        if (commands.length > 0) {
          patchGate = await workspace.gate({
            cwd: task.worktree.path,
            commands,
            timeoutMs: this.config.gate.timeoutMs,
          })
          await this.#append(
            run,
            'swarm/task/gate',
            { taskId: task.id, patchId, scope: 'patch', gate: patchGate },
            { actor: 'gate' },
          )
          if (!patchGate.passed) {
            await this.#append(
              run,
              'swarm/task/state',
              { taskId: task.id, to: 'working', reason: 'gate_failed', release: false },
              { actor: 'system' },
            )
            throw new SwarmError('GATE_FAILED', 'merge gate failed on the task worktree', {
              gate: patchGate,
              taskState: 'working',
            })
          }
        }

        const merged = await workspace.mergeTask({
          taskId: task.id,
          branch: patch.branch,
          message: `swarm: merge ${patch.id} (${task.id})`,
        })
        if (!merged.ok) {
          await this.#append(
            run,
            'swarm/merge/conflict',
            { taskId: task.id, patchId, files: merged.files, reason: merged.reason, stderr: merged.stderr },
            { actor: 'system' },
          )
          await this.#append(
            run,
            'swarm/task/state',
            {
              taskId: task.id,
              to: 'working',
              reason: merged.reason === 'conflict' ? 'merge_conflict' : 'merge_failed',
              release: false,
            },
            { actor: 'system' },
          )
          throw new SwarmError(
            merged.reason === 'conflict' ? 'MERGE_CONFLICT' : 'MERGE_FAILED',
            merged.reason === 'conflict'
              ? 'merge conflict: the author must resolve it and resubmit'
              : 'integration merge failed',
            { files: merged.files, taskState: 'working', stderr: merged.stderr },
          )
        }

        /** @type {any} */
        let integrationGate = null
        if (commands.length > 0) {
          integrationGate = await workspace.gate({
            cwd: merged.integrationPath,
            commands,
            timeoutMs: this.config.gate.timeoutMs,
          })
          await this.#append(
            run,
            'swarm/task/gate',
            { taskId: task.id, patchId, scope: 'integration', gate: integrationGate },
            { actor: 'gate' },
          )
          if (!integrationGate.passed) {
            await workspace.rollbackIntegration(merged.previous)
            await this.#append(
              run,
              'swarm/task/state',
              { taskId: task.id, to: 'working', reason: 'integration_gate_failed', release: false },
              { actor: 'system' },
            )
            throw new SwarmError('GATE_FAILED', 'post-merge gate failed; integration was rolled back', {
              gate: integrationGate,
              rolledBackTo: merged.previous,
              taskState: 'working',
            })
          }
        }

        await this.#append(
          run,
          'swarm/task/merged',
          {
            taskId: task.id,
            patchId,
            mergeCommit: merged.commit,
            patchCommit: patch.commit,
            integrationBranch: merged.integrationBranch,
            gate: integrationGate ?? patchGate ?? { passed: true, checks: [], skipped: true },
          },
          { actor: input.actor ?? 'merger' },
        )
        return run.state.tasks.get(task.id)
      }

      await this.#append(
        run,
        'swarm/task/merged',
        {
          taskId: task.id,
          patchId,
          mergeCommit: asString(input.mergeCommit),
          gate: input.gate ?? { passed: true, checks: [], skipped: true },
        },
        { actor: input.actor ?? 'merger' },
      )
      return run.state.tasks.get(task.id)
    })
  }

  /* ------------------------------------------------------------------ */
  /* Hive                                                               */
  /* ------------------------------------------------------------------ */

  /**
   * @param {string} runId
   * @param {any} input
   */
  async board(runId, input) {
    return this.#withRun(runId, async (run) => {
      this.#requireActive(run)
      const op = input.op ?? 'query'
      const halfLife = run.state.config?.pheromone?.halfLifeMs ?? this.config.pheromone.halfLifeMs
      const weightOf = (entry) => topicWeight(run.state.pheromones, entry.topic, this.clock(), halfLife)
      if (op === 'write' || op === 'update') {
        let entry
        if (op === 'update') {
          const existing = run.state.board.get(input.id)
          if (!existing) throw new SwarmError('BOARD_NOT_FOUND', `board entry '${input.id}' not found`)
          if (input.expectedVersion !== undefined && input.expectedVersion !== existing.version) {
            throw new SwarmError('BOARD_CONFLICT', 'board entry version changed', {
              expected: input.expectedVersion,
              actual: existing.version,
            })
          }
          const content = String(input.content ?? existing.content)
          const scrubbed = createEntry({
            kind: input.kind ?? existing.kind,
            topic: input.topic ?? existing.topic,
            content,
            confidence: input.confidence ?? existing.confidence,
            author: existing.author,
            ttlMs: input.ttlMs ?? Math.max(0, existing.expiresAt - this.clock()),
            now: this.clock(),
            maxEntryBytes: run.state.config?.board?.maxEntryBytes ?? this.config.board.maxEntryBytes,
          })
          entry = {
            ...existing,
            kind: scrubbed.kind,
            topic: scrubbed.topic,
            content: scrubbed.content,
            confidence: scrubbed.confidence,
            version: existing.version + 1,
            updatedAt: this.clock(),
            expiresAt: scrubbed.expiresAt,
            bytes: scrubbed.bytes,
          }
        } else {
          entry = createEntry({
            kind: input.kind,
            topic: input.topic,
            content: input.content,
            confidence: input.confidence,
            author: input.author ?? 'agent',
            ttlMs: input.ttlMs,
            now: this.clock(),
            maxEntryBytes: run.state.config?.board?.maxEntryBytes ?? this.config.board.maxEntryBytes,
            defaultTtlMs: run.state.config?.board?.defaultTtlMs ?? this.config.board.defaultTtlMs,
          })
        }
        // Capacity control happens before the write, and eviction is its own event.
        const projected = run.state.board.size + 1
        const wouldBe = [...run.state.board.values()].reduce((sum, item) => sum + item.bytes, 0) + entry.bytes
        const maxTotal = run.state.config?.board?.maxTotalBytes ?? this.config.board.maxTotalBytes
        if (wouldBe > maxTotal || projected > 100_000) {
          // Decide eviction on a copy so a failed append cannot leave the live
          // board mutated without a matching event.
          const copy = new Map(run.state.board)
          const evicted = evict(copy, {
            maxTotalBytes: Math.max(0, maxTotal - entry.bytes),
            now: this.clock(),
            halfLifeMs: halfLife,
            pheromoneWeight: weightOf,
          })
          if (evicted.removed.length > 0) {
            await this.#append(
              run,
              'swarm/board/removed',
              { ids: evicted.removed.map((item) => item.id), reason: 'capacity' },
              { actor: 'system' },
            )
          }
        }
        await this.#append(run, 'swarm/board/written', { entry }, { actor: entry.author })
        return { entry, evicted: wouldBe > maxTotal }
      }
      if (op === 'remove' || op === 'delete') {
        const ids = stringArray(input.ids?.length ? input.ids : [input.id])
        if (ids.length === 0) throw new SwarmError('BOARD_NOT_FOUND', 'remove requires an id')
        await this.#append(run, 'swarm/board/removed', { ids, reason: asString(input.reason, 'manual') }, { actor: input.actor ?? 'agent' })
        return { removed: ids }
      }
      if (op === 'deposit') {
        const kind = input.kind === 'warning' || input.kind === 'heat' ? input.kind : 'success'
        if (!asString(input.topic)) throw new SwarmError('BOARD_INVALID_TOPIC', 'pheromone deposit requires a topic')
        const delta = input.delta ?? this.config.pheromone[kind]
        const before = topicWeight(run.state.pheromones, input.topic, this.clock(), halfLife)
        const result = deposit(run.state.pheromones, {
          topic: input.topic,
          kind,
          delta: Number(delta),
          now: this.clock(),
          halfLifeMs: halfLife,
        })
        await this.#append(
          run,
          'swarm/pheromone/updated',
          { pheromone: result.pheromone, previous: result.previous },
          { actor: input.actor ?? 'agent' },
        )
        return { pheromone: result.pheromone, previous: before, weight: topicWeight(run.state.pheromones, input.topic, this.clock(), halfLife) }
      }
      // default: query
      const result = queryEntries(run.state.board, {
        topics: stringArray(input.topics ?? (input.topic ? [input.topic] : [])),
        kinds: stringArray(input.kinds ?? (input.kind ? [input.kind] : [])),
        minConfidence: Number(input.minConfidence ?? 0),
        topK: asInt(input.topK, 10, 1, 200),
        tokenBudget: asInt(input.tokenBudget, run.state.config?.board?.queryTokenBudget ?? this.config.board.queryTokenBudget, 64, 32_000),
        includeExpired: input.includeExpired === true,
        now: this.clock(),
        halfLifeMs: halfLife,
        pheromoneWeight: weightOf,
      })
      return {
        entries: result.entries,
        truncated: result.truncated,
        tokens: result.tokens,
        total: result.total,
        pheromones: pheromoneSnapshot(run.state.pheromones, { now: this.clock(), halfLifeMs: halfLife }),
      }
    })
  }

  /* ------------------------------------------------------------------ */
  /* Messaging                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * Send a point-to-point request/response or a topic broadcast. Messages are
   * event-sourced, TTL-bounded, per-sender rate-limited, and scoped to one run.
   * @param {string} runId
   * @param {{ from: string, to?: string, topic?: string, kind?: string, content?: string, payload?: unknown, ttlMs?: number, correlationId?: string }} input
   */
  async sendMessage(runId, input) {
    return this.#withRun(runId, async (run) => {
      this.#requireActive(run)
      const sender = this.#member(run, input.from)
      const kind = ['request', 'response', 'broadcast', 'event'].includes(input.kind)
        ? input.kind
        : input.to
          ? 'request'
          : 'broadcast'
      const topic = asString(input.topic)
      let to = asString(input.to)
      if (!to && topic) to = `topic:${topic}`
      if (!to) throw new SwarmError('MESSAGE_INVALID', 'message needs a member target or a topic')
      if (to !== `topic:${topic}` || !topic) this.#member(run, to)
      if (kind === 'broadcast' && !topic) {
        throw new SwarmError('MESSAGE_INVALID', 'broadcast messages need a topic')
      }
      await this.#assertMessageRoute(run, sender, to)
      const raw =
        typeof input.content === 'string'
          ? input.content
          : input.payload === undefined
            ? ''
            : JSON.stringify(input.payload)
      if (!raw.trim()) throw new SwarmError('MESSAGE_INVALID', 'message content must not be empty')
      if (Buffer.byteLength(raw, 'utf8') > this.config.messages.maxPayloadBytes) {
        throw new SwarmError('MESSAGE_TOO_LARGE', `payload exceeds ${this.config.messages.maxPayloadBytes} bytes`)
      }
      const now = this.clock()
      const recent = [...run.state.messages.values()].filter(
        (message) => message.from === sender.id && message.sentAt >= now - 60_000,
      )
      if (recent.length >= this.config.messages.maxPerMinute) {
        const entry = createEntry({
          kind: 'fact',
          topic: 'throttled',
          content: `member ${sender.name} exceeded ${this.config.messages.maxPerMinute} messages/min; payload collapsed`,
          confidence: 0.9,
          author: sender.id,
          now,
          maxEntryBytes: run.state.config?.board?.maxEntryBytes ?? this.config.board.maxEntryBytes,
          defaultTtlMs: run.state.config?.board?.defaultTtlMs ?? this.config.board.defaultTtlMs,
        })
        await this.#append(run, 'swarm/board/written', { entry }, { actor: 'system' })
        return { throttled: true, reason: 'rate_limit', boardEntryId: entry.id }
      }
      const ttlMs = asInt(input.ttlMs, this.config.messages.defaultTtlMs, 0, 24 * 3600_000)
      const message = {
        id: newId('msg'),
        from: sender.id,
        to,
        kind,
        topic: topic || null,
        correlationId: asString(input.correlationId) || null,
        payload: raw.slice(0, this.config.messages.maxPayloadBytes),
        sentAt: now,
        expiresAt: ttlMs > 0 ? now + ttlMs : 0,
        deliveredTo: [],
        status: 'sent',
      }
      await this.#append(run, 'swarm/message/sent', { message }, { actor: sender.id })
      return { messageId: message.id, to, kind, topic: message.topic, expiresAt: message.expiresAt }
    })
  }

  /**
   * Enforce the run topology for messaging. `mesh` is unrestricted; `star` and
   * `hierarchy` only allow queen-involving edges; `pipeline` allows adjacent
   * members in roster order (plus the queen).
   * @param {any} run
   * @param {any} sender
   * @param {string} to
   */
  async #assertMessageRoute(run, sender, to) {
    const topology = run.state.topology
    if (topology === 'mesh') return true
    const target = to.startsWith('topic:') ? null : run.state.members.get(to)
    let allowed = false
    if (topology === 'pipeline') {
      if (sender.role === 'queen' || target?.role === 'queen') allowed = true
      else if (target) {
        const ordered = [...run.state.members.values()].sort((a, b) => a.joinedAt - b.joinedAt)
        const from = ordered.findIndex((member) => member.id === sender.id)
        const dest = ordered.findIndex((member) => member.id === target.id)
        allowed = from >= 0 && dest >= 0 && Math.abs(from - dest) <= 1
      }
    } else {
      allowed = sender.role === 'queen' || target?.role === 'queen'
    }
    if (!allowed) {
      await this.#append(
        run,
        'swarm/security/rejected',
        { kind: 'topology', topology, from: sender.id, to },
        { actor: sender.id },
      )
      throw new SwarmError('TOPOLOGY_FORBIDDEN', `topology '${topology}' does not allow this message`, {
        topology,
        from: sender.id,
        to,
      })
    }
    return true
  }

  /**
   * Read and optionally acknowledge messages for one member.
   * @param {string} runId
   * @param {{ memberId: string, consume?: boolean, limit?: number }} input
   */
  async inbox(runId, input) {
    return this.#withRun(runId, async (run) => {
      const member = this.#member(run, input.memberId)
      const now = this.clock()
      const limit = asInt(input.limit, 50, 1, this.config.messages.maxInbox)
      /** @type {string[]} */
      const expired = []
      /** @type {any[]} */
      const pending = []
      for (const message of run.state.messages.values()) {
        if (message.status === 'expired') continue
        if (message.expiresAt > 0 && message.expiresAt <= now) {
          expired.push(message.id)
          continue
        }
        const addressed =
          message.to === member.id ||
          (message.to.startsWith('topic:') && message.from !== member.id)
        if (!addressed) continue
        if (message.deliveredTo.includes(member.id)) continue
        pending.push(message)
      }
      if (expired.length > 0) {
        await this.#append(run, 'swarm/message/expired', { ids: expired }, { actor: 'system' })
      }
      pending.sort((a, b) => a.sentAt - b.sentAt)
      const selected = pending.slice(0, limit)
      const consume = input.consume !== false
      if (consume) {
        for (const message of selected) {
          await this.#append(
            run,
            'swarm/message/delivered',
            { messageId: message.id, memberId: member.id },
            { actor: member.id },
          )
        }
      }
      return {
        memberId: member.id,
        messages: selected.map((message) => ({
          id: message.id,
          from: message.from,
          to: message.to,
          kind: message.kind,
          topic: message.topic,
          correlationId: message.correlationId,
          payload: message.payload,
          sentAt: message.sentAt,
          expiresAt: message.expiresAt,
        })),
        delivered: consume ? selected.map((message) => message.id) : [],
        pending: Math.max(0, pending.length - selected.length),
      }
    })
  }

  /* ------------------------------------------------------------------ */
  /* Budget                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * @param {string} runId
   * @param {{ taskId?: string, memberId?: string, tokens: number, usd?: number }} input
   */
  async reserveBudget(runId, input) {
    return this.#withRun(runId, async (run) => {
      this.#requireActive(run)
      const scope = input.taskId ? 'task' : 'member'
      const key = input.taskId ?? input.memberId
      if (!key) throw new SwarmError('INVALID_BUDGET', 'reserve requires taskId or memberId')
      const tokens = Math.max(1, Math.trunc(input.tokens))
      const usd = Math.max(0, Number(input.usd ?? 0))
      const runLeft = remainingTokens(run.state.budget, 'run')
      const scopeLeft = remainingTokens(run.state.budget, scope, key)
      if (tokens > runLeft || tokens > scopeLeft) {
        throw new SwarmError('BUDGET_EXCEEDED', 'not enough remaining budget to reserve', {
          scope: tokens > runLeft ? 'run' : scope,
          remaining: Math.min(runLeft, scopeLeft),
          requested: tokens,
        })
      }
      const reservation = { id: newId('res'), scope, key, tokens, usd, at: this.clock() }
      await this.#append(run, 'swarm/budget/reserved', { reservation }, { actor: input.memberId ?? 'agent' })
      return reservation
    })
  }

  /**
   * @param {string} runId
   * @param {string} reservationId
   * @param {{ tokens?: number, usd?: number, wallMs?: number }} [usage]
   */
  async settleBudget(runId, reservationId, usage = {}) {
    return this.#withRun(runId, async (run) => {
      this.#requireActive(run)
      if (!run.state.budget.reservations.has(reservationId)) {
        throw new SwarmError('UNKNOWN_RESERVATION', `no reservation '${reservationId}'`)
      }
      const actual = {
        tokens: Math.max(0, Math.trunc(usage.tokens ?? run.state.budget.reservations.get(reservationId).tokens)),
        usd: Math.max(0, Number(usage.usd ?? 0)),
        wallMs: Math.max(0, Math.trunc(usage.wallMs ?? 0)),
      }
      await this.#append(run, 'swarm/budget/settled', { reservationId, usage: actual }, { actor: 'system' })
      return {
        settled: reservationId,
        actual,
        remaining: remainingTokens(run.state.budget, 'run'),
      }
    })
  }

  /**
   * @param {string} runId
   * @param {string} reservationId
   */
  async releaseBudget(runId, reservationId) {
    return this.#withRun(runId, async (run) => {
      this.#requireActive(run)
      if (!run.state.budget.reservations.has(reservationId)) {
        throw new SwarmError('UNKNOWN_RESERVATION', `no reservation '${reservationId}'`)
      }
      await this.#append(run, 'swarm/budget/released', { reservationId }, { actor: 'system' })
      return { released: reservationId }
    })
  }

  /* ------------------------------------------------------------------ */
  /* Orchestration                                                      */
  /* ------------------------------------------------------------------ */

  async tick() {
    for (const runId of [...this.runs.keys()]) {
      try {
        await this.tickRun(runId)
      } catch (error) {
        this.logger?.warn?.(`[swarm] tick failed for ${runId}: ${String(error?.message ?? error)}`)
      }
      try {
        await this.#autoDispatch(runId)
      } catch (error) {
        this.logger?.warn?.(`[swarm] auto dispatch failed for ${runId}: ${String(error?.message ?? error)}`)
      }
    }
  }

  /**
   * Dispatch every ready task when the run opted into auto mode and a parent
   * Agent is bound. Failed dispatches back off for two minutes so a broken child
   * cannot spin the scheduler.
   * @param {string} runId
   */
  async #autoDispatch(runId) {
    const run = this.runs.get(runId)
    if (!run) return
    const auto = run.state.config?.dispatch?.auto ?? this.config.dispatch.auto
    if (!auto || run.state.status !== 'running' || !run.parentAgent) return
    const hardCap = Math.max(
      1,
      Math.min(
        run.state.concurrencyLimit || this.config.workspace.maxConcurrent,
        run.state.config?.workspace?.maxConcurrent ?? this.config.workspace.maxConcurrent,
      ),
    )
    const free = hardCap - run.activeDispatches.size
    if (free <= 0) return
    const now = this.clock()
    const candidates = [...run.state.tasks.values()]
      .filter((task) => {
        if (run.activeDispatches.has(task.id)) return false
        if (!task.worktree || !task.assignee || !task.lease) return false
        if (task.lease.expiresAt <= now) return false
        if (task.state === 'awarded') {
          if (!task.dispatch) return true
          return task.dispatch.status === 'failed' && now - task.dispatch.at > 120_000
        }
        if (task.state === 'working' && task.lastConflict) {
          if (!task.dispatch) return true
          if (task.dispatch.status === 'failed') return now - task.dispatch.at > 120_000
          return task.lastConflict.at > (task.dispatch.at ?? 0)
        }
        return false
      })
      .slice(0, free)
    for (const task of candidates) {
      try {
        await this.dispatchTask(runId, task.id, {
          memberId: task.assignee,
          fence: task.lease.fence,
          agent: run.parentAgent,
          wait: false,
        })
      } catch (error) {
        this.logger?.warn?.(`[swarm] auto dispatch failed for ${task.id}: ${String(error?.message ?? error)}`)
      }
    }
  }

  /** @param {string} runId */
  async tickRun(runId) {
    return this.#withRun(runId, async (run) => {
      if (!['created', 'running', 'paused', 'draining'].includes(run.state.status)) return null
      const now = this.clock()
      let changed = false
      for (const task of run.state.tasks.values()) {
        if (!task.lease) continue
        if (!['awarded', 'working'].includes(task.state)) continue
        if (task.lease.expiresAt > now) continue
        const expiredFence = task.lease.fence
        await this.#append(
          run,
          'swarm/task/state',
          { taskId: task.id, to: 'expired', reason: 'lease_expired', fence: expiredFence },
          { actor: 'system' },
        )
        changed = true
        if (run.state.status === 'running' && task.state === 'expired') {
          await this.#append(run, 'swarm/task/advertised', { taskId: task.id }, { actor: 'system' })
        }
      }
      if (changed) {
        await this.#append(run, 'swarm/tick', { tick: run.state.tickCount + 1, round: run.state.round }, { actor: 'system' })
      }
      const reviewed = await this.#expireReviews(run, now)
      if (reviewed) {
        await this.#append(run, 'swarm/tick', { tick: run.state.tickCount + 1, round: run.state.round }, { actor: 'system' })
      }
      await this.#expireMessages(run, now)
      const stalled = await this.#evaluateStall(run, now)
      if (stalled) return stalled
      const converged = await this.#evaluateConvergence(run, now)
      if (converged) return converged
      const advanced = await this.#advanceRound(run, now)
      return advanced
    })
  }

  /**
   * Close a round once no dispatched work is in flight, judge the round's
   * metrics, and open the next round for the remaining queue. A round only
   * advances when it actually did something, so an idle advertised queue does
   * not spin the counter.
   * @param {any} run
   * @param {number} now
   */
  async #advanceRound(run, now) {
    if (run.state.status !== 'running') return null
    if (run.activeDispatches.size > 0) return null
    const tasks = [...run.state.tasks.values()]
    if (tasks.length === 0) return null
    const inFlight = tasks.some((task) =>
      ['awarded', 'working', 'submitted', 'reviewing'].includes(task.state),
    )
    if (inFlight) return null
    const ready = tasks.some((task) => ['draft', 'advertised', 'expired', 'failed'].includes(task.state))
    if (!ready) return null
    const stats = run.state.roundStats
    const activity =
      stats.awarded + stats.submitted + stats.votes + stats.merges + stats.gateFailures + stats.conflicts
    if (activity === 0) return null

    const terminal = tasks.filter((task) => isTerminalTaskState(task.state)).length
    const completion = terminal / tasks.length
    const budget = runBudgetState(run.state.budget, { now, startedAt: run.state.createdAt })
    const metrics = {
      round: run.state.round,
      merges: stats.merges,
      gateFailures: stats.gateFailures,
      conflicts: stats.conflicts,
      votes: stats.votes,
      awarded: stats.awarded,
      submitted: stats.submitted,
      open: tasks.length - terminal,
      ready: tasks.filter((task) => ['draft', 'advertised', 'expired', 'failed'].includes(task.state)).length,
      concurrencyLimit: run.state.concurrencyLimit,
      completion: Number(completion.toFixed(3)),
      spend: budget.used - stats.spendStart,
      budgetRatio: Number(budget.ratio.toFixed(3)),
    }

    if (budget.ratio >= 0.9 && completion < 0.5) {
      await this.#append(
        run,
        'swarm/judge',
        { action: 'converge', reasons: ['budget_risk'], evidence: metrics },
        { actor: 'judge' },
      )
      await this.#append(run, 'swarm/converged', { reason: 'budget_risk' }, { actor: 'judge' })
      await this.#cleanupWorkspace(run)
      return this.snapshotFromState(run)
    }

    const action = stats.merges > 0 ? 'continue' : 'change_strategy'
    const reasons =
      stats.merges > 0
        ? ['merged']
        : stats.gateFailures > 0
          ? ['gate_failures']
          : stats.conflicts > 0
            ? ['conflicts']
            : ['no_merge']

    const limit = run.state.concurrencyLimit || this.config.workspace.maxConcurrent
    const maxLimit = Math.max(
      1,
      Math.min(
        run.state.maxMembers ?? this.config.maxMembers,
        run.state.config?.workspace?.maxConcurrent ?? this.config.workspace.maxConcurrent,
      ),
    )
    const previousNoMerge = run.state.roundHistory
      .slice(-2)
      .filter((entry) => (entry.metrics?.merges ?? 0) === 0).length
    /** @type {{ direction: 'up'|'down', limit: number, reason: string } | null} */
    let scale = null
    if (budget.ratio < 0.7 && metrics.ready > limit && limit < maxLimit) {
      scale = { direction: 'up', limit: limit + 1, reason: 'ready_queue' }
    } else if ((budget.ratio > 0.8 || previousNoMerge >= 2) && limit > 2) {
      scale = {
        direction: 'down',
        limit: limit - 1,
        reason: budget.ratio > 0.8 ? 'budget_pressure' : 'no_merge',
      }
    }
    if (scale) {
      await this.#append(
        run,
        'swarm/scale',
        { previous: limit, ...scale, ready: metrics.ready, budgetRatio: metrics.budgetRatio },
        { actor: 'judge' },
      )
    }

    await this.#append(run, 'swarm/judge', { action, reasons, evidence: metrics }, { actor: 'judge' })
    await this.#append(
      run,
      'swarm/round',
      { round: run.state.round + 1, action, metrics, spentTokens: run.state.budget.run.tokens },
      { actor: 'judge' },
    )
    return null
  }

  /**
   * Mark undelivered messages past their TTL as expired.
   * @param {any} run
   * @param {number} now
   */
  async #expireMessages(run, now) {
    const ids = [...run.state.messages.values()]
      .filter((message) => message.status !== 'expired' && message.expiresAt > 0 && message.expiresAt <= now)
      .map((message) => message.id)
    if (ids.length === 0) return false
    await this.#append(run, 'swarm/message/expired', { ids }, { actor: 'system' })
    return true
  }

  /**
   * If a run has open tasks, no active dispatch, and no forward progress for
   * `convergence.stallMs`, the judge converges instead of waiting forever.
   * @param {any} run
   * @param {number} now
   */
  async #evaluateStall(run, now) {
    if (!['running', 'paused', 'draining'].includes(run.state.status)) return null
    if (run.activeDispatches.size > 0) return null
    const open = [...run.state.tasks.values()].filter((task) => !isTerminalTaskState(task.state))
    if (open.length === 0) return null
    const lastProgress = run.state.lastProgressAt || run.state.createdAt || now
    const idleMs = now - lastProgress
    if (idleMs < this.config.convergence.stallMs) return null
    const statuses = {}
    for (const task of open) statuses[task.state] = (statuses[task.state] ?? 0) + 1
    const evidence = { openTasks: open.length, idleMs, statuses }
    await this.#append(
      run,
      'swarm/judge',
      { action: 'converge', reasons: ['no_progress'], evidence },
      { actor: 'judge' },
    )
    await this.#append(run, 'swarm/converged', { reason: 'stalled_no_progress' }, { actor: 'judge' })
    await this.#cleanupWorkspace(run)
    return this.snapshotFromState(run)
  }

  /**
   * A review that exceeds its deadline becomes an abstention. Abstentions do not
   * block the merge, and the quorum denominator becomes the verdicts actually
   * cast; the timeout itself is still recorded.
   * @param {any} run
   * @param {number} now
   */
  async #expireReviews(run, now) {
    const timeoutMs = this.config.review.timeoutMs
    let changed = false
    for (const [patchId, opened] of run.state.reviewOpened) {
      const task = run.state.tasks.get(opened.taskId)
      if (!task || task.state !== 'reviewing') continue
      if (now - opened.at < timeoutMs) continue
      const patch = run.state.patches.get(patchId)
      if (!patch) continue
      const cast = new Set(
        [...run.state.reviews.values()]
          .filter((review) => review.patchId === patchId)
          .map((review) => review.reviewerId),
      )
      const missing = opened.reviewers.filter((reviewerId) => !cast.has(reviewerId))
      if (missing.length === 0) continue
      await this.#append(
        run,
        'swarm/review/timeout',
        {
          taskId: task.id,
          patchId,
          reviewers: missing,
          openedAt: opened.at,
          waitedMs: now - opened.at,
        },
        { actor: 'system' },
      )
      for (const reviewerId of missing) {
        const review = createReview({
          patchId,
          reviewerId,
          authorId: patch.author,
          verdict: 'abstain',
          evidence: [],
          now,
          requireEvidence: false,
        })
        await this.#append(run, 'swarm/vote/cast', { taskId: task.id, patchId, review }, { actor: reviewerId })
      }
      const ballots = [...run.state.reviews.values()].filter((review) => review.patchId === patchId)
      const tally = tallyReviews(ballots, {
        eligibleCount: Math.max(1, opened.reviewers.length),
        quorum: this.config.review.quorum,
        requireEvidence: this.config.review.requireEvidence,
        base: 'cast',
      })
      if (tally.passed) {
        await this.#append(
          run,
          'swarm/task/state',
          { taskId: task.id, to: 'approved', reason: 'review_timeout_passed' },
          { actor: 'system' },
        )
      } else {
        await this.#append(
          run,
          'swarm/task/state',
          { taskId: task.id, to: 'blocked', reason: 'review_timeout' },
          { actor: 'system' },
        )
      }
      changed = true
    }
    return changed
  }

  /** @param {any} run */
  async #evaluateConvergence(run, now) {
    const state = run.state
    if (!['created', 'running', 'paused', 'draining'].includes(state.status)) return null
    const budget = runBudgetState(state.budget, { now, startedAt: state.createdAt })
    const tasks = [...state.tasks.values()]
    const open = tasks.filter((task) => !isTerminalTaskState(task.state))
    if (this.config.budget.hardStop && (budget.exhausted || budget.wallExhausted)) {
      await this.#append(
        run,
        'swarm/aborted',
        { reason: budget.wallExhausted ? 'wall_clock' : 'budget' },
        { actor: 'system' },
      )
      await this.#cleanupWorkspace(run)
      return this.snapshotFromState(run)
    }
    if (state.status === 'draining' && open.length === 0) {
      await this.#append(run, 'swarm/converged', { reason: 'drained' }, { actor: 'system' })
      await this.#cleanupWorkspace(run)
      return this.snapshotFromState(run)
    }
    if (state.round >= this.config.convergence.maxRounds && open.length > 0) {
      await this.#append(
        run,
        'swarm/judge',
        {
          action: 'converge',
          reasons: ['max_rounds'],
          evidence: { round: state.round, maxRounds: this.config.convergence.maxRounds, openTasks: open.length },
        },
        { actor: 'judge' },
      )
      await this.#append(run, 'swarm/converged', { reason: 'max_rounds' }, { actor: 'judge' })
      await this.#cleanupWorkspace(run)
      return this.snapshotFromState(run)
    }
    if (tasks.length > 0 && open.length === 0) {
      await this.#append(run, 'swarm/converged', { reason: 'all_tasks_terminal' }, { actor: 'system' })
      await this.#cleanupWorkspace(run)
      return this.snapshotFromState(run)
    }
    return null
  }

  /** @param {any} run */
  snapshotFromState(run) {
    return this.#snapshotState(run.state, false, run.log)
  }
}
