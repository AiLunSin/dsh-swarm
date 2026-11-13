/**
 * Event-sourced run state. `applyEvent` is the only place that mutates a run,
 * so live execution and recovery replay obey exactly the same rules.
 *
 * Time-dependent facts are always stored in the event payload (lease expiry,
 * reservation amounts, timestamps); the reducer never calls `Date.now()`.
 */
import { charge, createBudgetState, release, reserve, settle } from './budget.js'
import { newId } from './util.js'

/** @param {string} id */
export function emptyRunState(id) {
  return {
    id,
    goal: '',
    repo: '',
    topology: 'mesh',
    mode: 'swarm',
    status: 'created',
    createdAt: 0,
    updatedAt: 0,
    endedAt: 0,
    round: 1,
    tickCount: 0,
    lastProgressAt: 0,
    maxMembers: 8,
    baseCommit: '',
    gateCommands: [],
    workspaceDegraded: [],
    mergeConflicts: [],
    config: {},
    members: new Map(),
    tasks: new Map(),
    patches: new Map(),
    reviews: new Map(),
    reviewersByPatch: new Map(),
    reviewOpened: new Map(),
    reviewTimeouts: [],
    judgements: [],
    roundHistory: [],
    scaleHistory: [],
    concurrencyLimit: 0,
    roundStats: {
      startedAt: 0,
      merges: 0,
      gateFailures: 0,
      conflicts: 0,
      awarded: 0,
      submitted: 0,
      votes: 0,
      spendStart: 0,
    },
    board: new Map(),
    pheromones: new Map(),
    messages: new Map(),
    budget: createBudgetState({
      budget: { tokens: 0, usd: 0, wallMs: 0 },
      taskBudget: { tokens: 0 },
      memberBudget: { tokens: 0 },
    }),
    fence: 0,
    recovered: false,
    convergedReason: null,
  }
}

/** Events that count as forward progress for stall detection. */
const PROGRESS_EVENTS = new Set([
  'swarm/task/created',
  'swarm/task/advertised',
  'swarm/bid/submitted',
  'swarm/task/awarded',
  'swarm/task/working',
  'swarm/task/submitted',
  'swarm/review/opened',
  'swarm/vote/cast',
  'swarm/task/merged',
  'swarm/dispatch/started',
  'swarm/dispatch/finished',
  'swarm/board/written',
  'swarm/pheromone/updated',
])

/**
 * @param {any} state
 * @param {import('./events.js').SwarmEvent} event
 */
export function applyEvent(state, event) {
  // Clone before storing anything: reducers keep nested arrays/objects (task.bids,
  // member lists) that later commands mutate, and the event's hash must never
  // change after it was written.
  const payload = structuredClone(/** @type {any} */ (event.payload ?? {}))
  state.updatedAt = Math.max(state.updatedAt, event.at)
  if (PROGRESS_EVENTS.has(event.type)) state.lastProgressAt = event.at
  switch (event.type) {
    case 'swarm/created': {
      state.goal = payload.goal
      state.repo = payload.repo
      state.topology = payload.topology
      state.mode = payload.mode
      state.maxMembers = payload.maxMembers
      state.baseCommit = payload.baseCommit ?? ''
      state.gateCommands = Array.isArray(payload.gateCommands) ? [...payload.gateCommands] : []
      state.concurrencyLimit = payload.concurrencyLimit ?? 3
      state.config = payload.config
      state.preflight = payload.preflight ?? null
      state.status = 'created'
      state.createdAt = event.at
      state.lastProgressAt = event.at
      state.roundStats.startedAt = event.at
      state.budget = createBudgetState({
        budget: payload.limits.run,
        taskBudget: { tokens: payload.limits.taskTokens },
        memberBudget: { tokens: payload.limits.memberTokens },
      })
      break
    }
    case 'swarm/status/changed': {
      state.status = payload.to
      if (['converged', 'aborted', 'failed'].includes(payload.to)) state.endedAt = event.at
      break
    }
    case 'swarm/member/joined': {
      const member = payload.member
      state.members.set(member.id, { ...member })
      break
    }
    case 'swarm/member/updated': {
      const member = state.members.get(payload.memberId)
      if (member) Object.assign(member, payload.changes)
      break
    }
    case 'swarm/member/left': {
      const member = state.members.get(payload.memberId)
      if (member) member.status = payload.status ?? 'left'
      break
    }
    case 'swarm/task/created': {
      state.tasks.set(payload.task.id, { ...payload.task })
      break
    }
    case 'swarm/task/advertised': {
      const task = state.tasks.get(payload.taskId)
      if (task) {
        task.state = 'advertised'
        task.updatedAt = event.at
      }
      break
    }
    case 'swarm/bid/submitted': {
      const task = state.tasks.get(payload.taskId)
      if (task) {
        const existing = task.bids.findIndex((bid) => bid.memberId === payload.bid.memberId)
        if (existing >= 0) task.bids[existing] = { ...payload.bid }
        else task.bids.push({ ...payload.bid })
        task.updatedAt = event.at
      }
      break
    }
    case 'swarm/task/awarded': {
      const task = state.tasks.get(payload.taskId)
      if (task) {
        const previousId = payload.fromMemberId ?? task.assignee
        if (previousId && previousId !== payload.memberId) {
          const previous = state.members.get(previousId)
          if (previous) {
            previous.load = Math.max(0, previous.load - 1)
            previous.status = previous.load > 0 ? 'busy' : 'idle'
          }
        }
        task.state = 'awarded'
        task.assignee = payload.memberId
        task.lease = { ...payload.lease }
        if (payload.worktree !== undefined) task.worktree = payload.worktree ? { ...payload.worktree } : null
        task.updatedAt = event.at
      }
      const member = state.members.get(payload.memberId)
      if (member) {
        member.load = Math.max(0, member.load ?? 0) + 1
        member.status = 'busy'
      }
      state.fence = Math.max(state.fence ?? 0, payload.lease?.fence ?? 0)
      state.roundStats.awarded += 1
      break
    }
    case 'swarm/task/working': {
      const task = state.tasks.get(payload.taskId)
      if (task) {
        task.state = 'working'
        task.updatedAt = event.at
      }
      break
    }
    case 'swarm/task/lease': {
      const task = state.tasks.get(payload.taskId)
      if (task && payload.lease) {
        task.lease = { ...payload.lease }
        task.updatedAt = event.at
      }
      break
    }
    case 'swarm/task/state': {
      const task = state.tasks.get(payload.taskId)
      if (task) {
        task.state = payload.to
        task.updatedAt = event.at
        if (payload.reason) task.lastReason = payload.reason
        if (['failed', 'cancelled', 'expired', 'merged', 'blocked'].includes(payload.to)) {
          const member = state.members.get(task.assignee ?? '')
          if (member && payload.release !== false) {
            member.load = Math.max(0, member.load - 1)
            member.status = member.load > 0 ? 'busy' : 'idle'
          }
          task.assignee = null
          task.lease = null
        }
      }
      break
    }
    case 'swarm/task/submitted': {
      const task = state.tasks.get(payload.taskId)
      if (task) {
        task.state = 'submitted'
        task.patchId = payload.patch.id
        task.artifacts = [...(task.artifacts ?? []), payload.patch.id]
        task.attempts = (task.attempts ?? 0) + 1
        task.updatedAt = event.at
      }
      state.patches.set(payload.patch.id, { ...payload.patch })
      state.roundStats.submitted += 1
      break
    }
    case 'swarm/task/merged': {
      const task = state.tasks.get(payload.taskId)
      if (task) {
        task.state = 'merged'
        task.updatedAt = event.at
        task.lease = null
        task.mergeCommit = payload.mergeCommit ?? ''
        task.integrationBranch = payload.integrationBranch ?? ''
        if (payload.gate) task.gate = { ...payload.gate }
        const member = state.members.get(task.assignee ?? '')
        if (member) {
          member.load = Math.max(0, member.load - 1)
          member.status = member.load > 0 ? 'busy' : 'idle'
          member.stats.done = (member.stats.done ?? 0) + 1
          member.lastWinRound = state.round
        }
        task.assignee = null
      }
      const patch = state.patches.get(payload.patchId)
      if (patch) {
        patch.state = 'merged'
        patch.mergeCommit = payload.mergeCommit ?? ''
      }
      state.roundStats.merges += 1
      break
    }
    case 'swarm/task/gate': {
      const task = state.tasks.get(payload.taskId)
      if (task) {
        task.gate = { ...payload.gate }
        task.updatedAt = event.at
      }
      if (payload.gate?.passed === false) state.roundStats.gateFailures += 1
      break
    }
    case 'swarm/merge/conflict': {
      const task = state.tasks.get(payload.taskId)
      if (task) {
        task.lastConflict = {
          files: [...(payload.files ?? [])],
          reason: payload.reason ?? 'conflict',
          at: event.at,
        }
      }
      state.mergeConflicts.push({ ...payload, at: event.at })
      state.roundStats.conflicts += 1
      break
    }
    case 'swarm/workspace/degraded': {
      state.workspaceDegraded.push({ ...payload, at: event.at })
      break
    }
    case 'swarm/dispatch/started': {
      const task = state.tasks.get(payload.taskId)
      if (task) {
        task.dispatch = {
          childId: payload.childId,
          memberId: payload.memberId,
          status: 'running',
          at: event.at,
        }
      }
      break
    }
    case 'swarm/dispatch/finished': {
      const task = state.tasks.get(payload.taskId)
      if (task && task.dispatch) {
        task.dispatch = {
          ...task.dispatch,
          status: 'finished',
          stopReason: payload.stopReason,
          summary: payload.summary,
          at: event.at,
        }
      }
      break
    }
    case 'swarm/dispatch/failed': {
      const task = state.tasks.get(payload.taskId)
      if (task && task.dispatch) {
        task.dispatch = {
          ...task.dispatch,
          status: 'failed',
          reason: payload.reason,
          code: payload.code,
          at: event.at,
        }
      }
      break
    }
    case 'swarm/review/opened': {
      state.reviewersByPatch.set(payload.patchId, [...payload.reviewers])
      state.reviewOpened.set(payload.patchId, {
        taskId: payload.taskId,
        reviewers: [...payload.reviewers],
        at: event.at,
      })
      const task = state.tasks.get(payload.taskId)
      if (task) {
        task.state = 'reviewing'
        task.updatedAt = event.at
      }
      break
    }
    case 'swarm/review/timeout': {
      state.reviewTimeouts.push({ ...payload, at: event.at })
      break
    }
    case 'swarm/judge': {
      state.judgements.push({ ...payload, at: event.at })
      break
    }
    case 'swarm/round': {
      state.roundHistory.push({
        round: state.round,
        action: payload.action,
        metrics: payload.metrics,
        at: event.at,
      })
      state.round = payload.round
      state.roundStats = {
        startedAt: event.at,
        merges: 0,
        gateFailures: 0,
        conflicts: 0,
        awarded: 0,
        submitted: 0,
        votes: 0,
        spendStart: payload.spentTokens ?? state.budget.run.tokens,
      }
      break
    }
    case 'swarm/scale': {
      state.concurrencyLimit = payload.limit
      state.scaleHistory.push({ ...payload, at: event.at })
      break
    }
    case 'swarm/review/escalated': {
      if (!state.reviewEscalations) state.reviewEscalations = []
      state.reviewEscalations.push({ ...payload, at: event.at })
      break
    }
    case 'swarm/vote/cast': {
      state.reviews.set(payload.review.id, { ...payload.review })
      state.roundStats.votes += 1
      break
    }
    case 'swarm/board/written': {
      state.board.set(payload.entry.id, { ...payload.entry })
      break
    }
    case 'swarm/board/removed': {
      for (const id of payload.ids ?? []) state.board.delete(id)
      break
    }
    case 'swarm/pheromone/updated': {
      const item = payload.pheromone
      state.pheromones.set(`${item.topic}\u0000${item.kind}`, { ...item })
      break
    }
    case 'swarm/message/sent': {
      const message = { ...payload.message, deliveredTo: [], status: 'sent' }
      state.messages.set(message.id, message)
      break
    }
    case 'swarm/message/delivered': {
      const message = state.messages.get(payload.messageId)
      if (message && !message.deliveredTo.includes(payload.memberId)) {
        message.deliveredTo.push(payload.memberId)
        message.status = 'delivered'
      }
      break
    }
    case 'swarm/message/expired': {
      for (const id of payload.ids ?? []) {
        const message = state.messages.get(id)
        if (message) message.status = 'expired'
      }
      break
    }
    case 'swarm/budget/reserved': {
      reserve(state.budget, payload.reservation)
      break
    }
    case 'swarm/budget/settled': {
      settle(state.budget, payload.reservationId, payload.usage)
      break
    }
    case 'swarm/budget/released': {
      release(state.budget, payload.reservationId)
      break
    }
    case 'swarm/budget/adjusted': {
      state.budget.limits.runTokens = Math.max(
        state.budget.run.tokens,
        state.budget.limits.runTokens + Math.trunc(payload.tokens ?? 0),
      )
      break
    }
    case 'swarm/budget/charged': {
      charge(state.budget, payload)
      break
    }
    case 'swarm/tick': {
      state.tickCount = payload.tick ?? state.tickCount + 1
      if (payload.round) state.round = payload.round
      break
    }
    case 'swarm/recovered': {
      state.recovered = true
      break
    }
    case 'swarm/converged': {
      state.status = 'converged'
      state.convergedReason = payload.reason
      state.endedAt = event.at
      break
    }
    case 'swarm/aborted': {
      state.status = 'aborted'
      state.convergedReason = payload.reason
      state.endedAt = event.at
      break
    }
    case 'swarm/intervened': {
      if (!state.interventions) state.interventions = []
      state.interventions.push({ action: payload.action, actor: event.actor, reason: payload.reason, at: event.at })
      break
    }
    case 'swarm/message/expired':
    case 'swarm/security/rejected': {
      if (!state.securityEvents) state.securityEvents = []
      state.securityEvents.push(payload)
      break
    }
    // Unknown event types are ignored on replay so a newer writer does not make
    // an older reader fail. They still count toward the sequence.
    default:
      break
  }
  return state
}

/**
 * @param {import('./events.js').SwarmEvent[]} events
 * @param {string} runId
 */
export function replay(events, runId) {
  const state = emptyRunState(runId)
  for (const event of events) applyEvent(state, event)
  return state
}

/** Fresh member object. @param {{ role: string, name: string, model?: string, id?: string, at: number }} input */
export function makeMember(input) {
  return {
    id: input.id ?? newId('member'),
    name: input.name,
    role: input.role,
    model: input.model ?? 'inherit',
    status: 'joining',
    load: 0,
    stats: { won: 0, done: 0, failed: 0 },
    joinedAt: input.at,
    lastWinRound: 0,
    skills: input.role === 'worker' ? ['.js', '.ts', '.tsx', '.jsx', '.py', '.md'] : [],
  }
}

/**
 * Fresh task object. Validation of acceptance criteria and dependencies belongs
 * to the service, which has the full task graph.
 * @param {object} input
 * @param {number} at
 */
export function makeTask(input, at) {
  return {
    id: input.id ?? newId('task'),
    title: input.title,
    acceptance: [...input.acceptance],
    scope: { files: [...(input.scope?.files ?? [])], symbols: [...(input.scope?.symbols ?? [])] },
    deps: [...(input.deps ?? [])],
    priority: input.priority ?? 50,
    budget: { tokens: input.budget?.tokens ?? 0 },
    estimate: { tokens: input.estimate?.tokens ?? 50_000, minutes: input.estimate?.minutes ?? 30 },
    tags: [...(input.tags ?? [])],
    state: 'draft',
    assignee: null,
    lease: null,
    worktree: null,
    gate: null,
    mergeCommit: null,
    integrationBranch: null,
    lastConflict: null,
    dispatch: null,
    bids: [],
    artifacts: [],
    attempts: 0,
    createdAt: at,
    updatedAt: at,
  }
}
