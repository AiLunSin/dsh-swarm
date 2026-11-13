/**
 * Three-level budget ledger with reserve-before-call and settle-after-call.
 *
 * Reservation is what makes the budget a guard instead of a report: a model call
 * cannot start unless tokens were reserved for its run, task, and member first.
 */
import { SwarmError } from './util.js'

/**
 * @typedef {object} Ledger
 * @property {number} tokens
 * @property {number} reservedTokens
 * @property {number} calls
 * @property {number} usd
 * @property {number} reservedUsd
 * @property {number} wallMs
 */

/** @returns {Ledger} */
export function emptyLedger() {
  return { tokens: 0, reservedTokens: 0, calls: 0, usd: 0, reservedUsd: 0, wallMs: 0 }
}

/**
 * @param {{ budget: { tokens: number, usd: number, wallMs: number }, taskBudget: { tokens: number }, memberBudget: { tokens: number } }} config
 */
export function createBudgetState(config) {
  return {
    limits: {
      runTokens: config.budget.tokens,
      runUsd: config.budget.usd,
      runWallMs: config.budget.wallMs,
      taskTokens: config.taskBudget.tokens,
      memberTokens: config.memberBudget.tokens,
    },
    run: emptyLedger(),
    tasks: new Map(),
    members: new Map(),
    reservations: new Map(),
  }
}

/** @param {Map<string, Ledger>} map @param {string} key */
function ledgerFor(map, key) {
  let ledger = map.get(key)
  if (!ledger) {
    ledger = emptyLedger()
    map.set(key, ledger)
  }
  return ledger
}

/**
 * Remaining tokens for a scope. `scope` is one of run/task/member.
 * @param {ReturnType<typeof createBudgetState>} budget
 * @param {'run'|'task'|'member'} scope
 * @param {string} [key]
 */
export function remainingTokens(budget, scope, key) {
  if (scope === 'run') return budget.limits.runTokens - budget.run.tokens - budget.run.reservedTokens
  const ledger = key ? budget[scope === 'task' ? 'tasks' : 'members'].get(key) : undefined
  const used = ledger ? ledger.tokens + ledger.reservedTokens : 0
  const limit = scope === 'task' ? budget.limits.taskTokens : budget.limits.memberTokens
  return limit - used
}

/**
 * Reserve budget before a model call.
 * @param {ReturnType<typeof createBudgetState>} budget
 * @param {{ id: string, scope: 'task'|'member', key: string, tokens: number, usd?: number, now?: number }} request
 */
export function reserve(budget, request) {
  const tokens = Math.max(0, Math.trunc(request.tokens))
  const usd = Math.max(0, request.usd ?? 0)
  const runAvailable = remainingTokens(budget, 'run')
  const scopeAvailable = remainingTokens(budget, request.scope, request.key)
  if (tokens > runAvailable) {
    throw new SwarmError('BUDGET_EXCEEDED', 'run token budget exhausted', {
      scope: 'run',
      requested: tokens,
      remaining: runAvailable,
    })
  }
  if (tokens > scopeAvailable) {
    throw new SwarmError('BUDGET_EXCEEDED', `${request.scope} token budget exhausted`, {
      scope: request.scope,
      key: request.key,
      requested: tokens,
      remaining: scopeAvailable,
    })
  }
  if (budget.limits.runUsd > 0 && usd > budget.limits.runUsd - budget.run.usd - budget.run.reservedUsd) {
    throw new SwarmError('BUDGET_EXCEEDED', 'run cost budget exhausted', { scope: 'run', requested: usd })
  }
  const reservation = {
    id: request.id,
    scope: request.scope,
    key: request.key,
    tokens,
    usd,
    at: request.now ?? Date.now(),
  }
  budget.reservations.set(reservation.id, reservation)
  budget.run.reservedTokens += tokens
  budget.run.reservedUsd += usd
  const scopeLedger = ledgerFor(request.scope === 'task' ? budget.tasks : budget.members, request.key)
  scopeLedger.reservedTokens += tokens
  return reservation
}

/**
 * Settle a reservation with actual usage. The reserved amount is released and
 * the actual amount is charged; a mismatch is reported for calibration.
 * @param {ReturnType<typeof createBudgetState>} budget
 * @param {string} reservationId
 * @param {{ tokens?: number, usd?: number, wallMs?: number }} [usage]
 */
export function settle(budget, reservationId, usage = {}) {
  const reservation = budget.reservations.get(reservationId)
  if (!reservation) throw new SwarmError('UNKNOWN_RESERVATION', `no reservation '${reservationId}'`)
  const actualTokens = Math.max(0, Math.trunc(usage.tokens ?? reservation.tokens))
  const actualUsd = Math.max(0, usage.usd ?? reservation.usd)
  const wallMs = Math.max(0, Math.trunc(usage.wallMs ?? 0))
  budget.reservations.delete(reservationId)
  budget.run.reservedTokens -= reservation.tokens
  budget.run.reservedUsd -= reservation.usd
  budget.run.tokens += actualTokens
  budget.run.usd += actualUsd
  budget.run.wallMs += wallMs
  budget.run.calls += 1
  const scopeLedger = ledgerFor(reservation.scope === 'task' ? budget.tasks : budget.members, reservation.key)
  scopeLedger.reservedTokens -= reservation.tokens
  scopeLedger.tokens += actualTokens
  scopeLedger.usd += actualUsd
  scopeLedger.wallMs += wallMs
  scopeLedger.calls += 1
  const requested = reservation.tokens || 1
  const drift = Math.abs(actualTokens - reservation.tokens) / requested
  return {
    reservation,
    actualTokens,
    actualUsd,
    drift,
    calibration: drift > 0.2 ? actualTokens / requested : 1,
  }
}

/**
 * Release a reservation without charging (cancelled call).
 * @param {ReturnType<typeof createBudgetState>} budget
 * @param {string} reservationId
 */
export function release(budget, reservationId) {
  const reservation = budget.reservations.get(reservationId)
  if (!reservation) return false
  budget.reservations.delete(reservationId)
  budget.run.reservedTokens -= reservation.tokens
  budget.run.reservedUsd -= reservation.usd
  const scopeLedger = ledgerFor(reservation.scope === 'task' ? budget.tasks : budget.members, reservation.key)
  scopeLedger.reservedTokens -= reservation.tokens
  return true
}

/**
 * Charge actual usage without a prior reservation. Used for model calls whose
 * size is only known after the response (subagent turn usage).
 * @param {ReturnType<typeof createBudgetState>} budget
 * @param {{ taskId?: string, memberId?: string, tokens?: number, usd?: number, calls?: number }} input
 */
export function charge(budget, input) {
  const tokens = Math.max(0, Math.trunc(input.tokens ?? 0))
  const usd = Math.max(0, Number(input.usd ?? 0))
  const calls = Math.max(0, Math.trunc(input.calls ?? 1))
  budget.run.tokens += tokens
  budget.run.usd += usd
  budget.run.calls += calls
  if (input.taskId) {
    const ledger = ledgerFor(budget.tasks, input.taskId)
    ledger.tokens += tokens
    ledger.usd += usd
    ledger.calls += calls
  }
  if (input.memberId) {
    const ledger = ledgerFor(budget.members, input.memberId)
    ledger.tokens += tokens
    ledger.usd += usd
    ledger.calls += calls
  }
  return { tokens, usd, calls }
}

/**
 * Remaining run budget as a percentage, and whether the hard stop is reached.
 * @param {ReturnType<typeof createBudgetState>} budget
 * @param {{ now?: number, startedAt?: number }} [options]
 */
export function runBudgetState(budget, options = {}) {
  const now = options.now ?? Date.now()
  const startedAt = options.startedAt ?? now
  const tokens = budget.limits.runTokens
  const used = budget.run.tokens + budget.run.reservedTokens
  const wallLimit = budget.limits.runWallMs
  const wallUsed = wallLimit > 0 ? now - startedAt : budget.run.wallMs
  return {
    tokens,
    used,
    remaining: Math.max(0, tokens - used),
    ratio: tokens > 0 ? Math.min(1, used / tokens) : 1,
    usd: budget.run.usd,
    usdLimit: budget.limits.runUsd,
    wallMs: wallUsed,
    wallLimit,
    exhausted: tokens > 0 && used >= tokens,
    wallExhausted: wallLimit > 0 && wallUsed >= wallLimit,
  }
}

/**
 * Serializable view for snapshots and tools.
 * @param {ReturnType<typeof createBudgetState>} budget
 */
export function budgetSnapshot(budget) {
  /** @param {Map<string, Ledger>} map */
  const ledgers = (map) => {
    /** @type {Record<string, Ledger>} */
    const out = {}
    for (const [key, ledger] of map) out[key] = { ...ledger }
    return out
  }
  return {
    limits: { ...budget.limits },
    run: { ...budget.run },
    tasks: ledgers(budget.tasks),
    members: ledgers(budget.members),
    reservations: budget.reservations.size,
  }
}
