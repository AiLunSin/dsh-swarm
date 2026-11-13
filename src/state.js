/**
 * Explicit state machines. Every transition in the service goes through
 * `assertTransition`, so an illegal jump is a hard error rather than a silent
 * corruption of the snapshot.
 */
import { SwarmError } from './util.js'

export const SWARM_STATUSES = /** @type {const} */ ([
  'created',
  'running',
  'paused',
  'draining',
  'converged',
  'aborted',
  'failed',
])

export const TASK_STATES = /** @type {const} */ ([
  'draft',
  'advertised',
  'bidding',
  'awarded',
  'working',
  'submitted',
  'reviewing',
  'approved',
  'merged',
  'blocked',
  'failed',
  'cancelled',
  'expired',
])

export const MEMBER_STATUSES = /** @type {const} */ ([
  'joining',
  'idle',
  'busy',
  'draining',
  'left',
  'lost',
])

export const ROLES = /** @type {const} */ (['queen', 'scout', 'worker', 'reviewer', 'judge', 'human'])
export const TOPOLOGIES = /** @type {const} */ (['mesh', 'pipeline', 'star', 'hierarchy'])

/** @type {Record<string, Record<string, readonly string[]>>} */
const TRANSITIONS = {
  swarm: {
    created: ['running', 'aborted', 'failed'],
    running: ['paused', 'draining', 'converged', 'aborted', 'failed'],
    paused: ['running', 'draining', 'aborted', 'failed'],
    draining: ['converged', 'aborted', 'failed'],
    converged: [],
    aborted: [],
    failed: [],
  },
  task: {
    draft: ['advertised', 'cancelled'],
    advertised: ['bidding', 'awarded', 'cancelled', 'expired'],
    bidding: ['awarded', 'advertised', 'cancelled', 'failed', 'expired'],
    awarded: ['working', 'advertised', 'cancelled', 'failed', 'expired'],
    working: ['submitted', 'blocked', 'failed', 'cancelled', 'expired'],
    submitted: ['reviewing', 'working', 'failed', 'cancelled'],
    reviewing: ['approved', 'working', 'blocked', 'failed', 'cancelled'],
    approved: ['merged', 'working', 'failed', 'cancelled'],
    merged: [],
    blocked: ['working', 'advertised', 'failed', 'cancelled'],
    failed: ['advertised', 'cancelled'],
    cancelled: [],
    expired: ['advertised', 'cancelled'],
  },
  member: {
    joining: ['idle', 'left', 'lost'],
    idle: ['busy', 'draining', 'left', 'lost'],
    busy: ['idle', 'draining', 'left', 'lost'],
    draining: ['left', 'lost'],
    left: [],
    lost: [],
  },
}

/** @param {'swarm'|'task'|'member'} kind @param {string} from @param {string} to */
export function canTransition(kind, from, to) {
  const allowed = TRANSITIONS[kind]?.[from]
  if (!allowed) return false
  return allowed.includes(to)
}

/**
 * @param {'swarm'|'task'|'member'} kind
 * @param {string} from
 * @param {string} to
 */
export function assertTransition(kind, from, to) {
  if (from === to) {
    throw new SwarmError('INVALID_TRANSITION', `${kind} is already in state '${to}'`, { kind, from, to })
  }
  if (!canTransition(kind, from, to)) {
    throw new SwarmError('INVALID_TRANSITION', `illegal ${kind} transition: ${from} -> ${to}`, {
      kind,
      from,
      to,
    })
  }
}

/** @param {string} state */
export function isTerminalTaskState(state) {
  return state === 'merged' || state === 'cancelled' || state === 'failed'
}

/** @param {string} state */
export function isTerminalSwarmState(state) {
  return state === 'converged' || state === 'aborted' || state === 'failed'
}

/** @param {string} state */
export function isOpenSwarmState(state) {
  return !isTerminalSwarmState(state)
}
