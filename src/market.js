/**
 * Task market: bid scoring, deterministic ranking, and fenced leases.
 *
 * The market deliberately does a single comparison round. A central auctioneer
 * that keeps re-pricing becomes the bottleneck the swarm was meant to remove,
 * so ties and low scores fall back to assignment instead of another round.
 */
import { clamp, SwarmError } from './util.js'

export const BID_WEIGHTS = Object.freeze({
  capability: 0.35,
  idle: 0.2,
  successRate: 0.25,
  aging: 0.1,
  cost: 0.3,
})

/**
 * Bayesian-smoothed success rate. A member with no history starts at 0.5.
 * @param {{ won?: number, done?: number, failed?: number }} stats
 */
export function successRate(stats = {}) {
  const wins = Math.max(0, stats.done ?? 0)
  const attempts = Math.max(wins, (stats.done ?? 0) + (stats.failed ?? 0))
  return (wins + 2 * 0.5) / (attempts + 2)
}

/**
 * Anti-starvation factor: a member waiting `agingRounds` rounds scores 1.
 * @param {number} waitingRounds
 * @param {number} agingRounds
 */
export function agingFactor(waitingRounds, agingRounds = 5) {
  return clamp(waitingRounds / Math.max(1, agingRounds), 0, 1)
}

/**
 * How well a member can handle a task's declared scope.
 * @param {{ role?: string, skills?: string[] }} member
 * @param {{ tags?: string[], scope?: { files?: string[] } }} task
 */
export function capabilityScore(member, task) {
  const tags = Array.isArray(task.tags) ? task.tags : []
  const skills = Array.isArray(member.skills) ? member.skills : []
  const files = Array.isArray(task.scope?.files) ? task.scope.files : []
  const extensions = new Set(files.map((file) => file.slice(file.lastIndexOf('.')).toLowerCase()).filter(Boolean))
  if (extensions.size === 0 && tags.length === 0) return 0.6
  let matched = 0
  let considered = 0
  for (const tag of tags) {
    considered += 1
    if (member.role === tag || skills.includes(tag)) matched += 1
  }
  for (const extension of extensions) {
    considered += 1
    if (skills.includes(extension) || skills.includes(extension.slice(1))) matched += 1
  }
  if (considered === 0) return 0.6
  return clamp(0.3 + 0.7 * (matched / considered), 0, 1)
}

/**
 * @param {object} input
 * @param {number} input.capability 0..1
 * @param {number} input.idle 0..1
 * @param {number} input.successRate 0..1
 * @param {number} input.aging 0..1
 * @param {number} input.normalizedCost 0..1+
 * @param {typeof BID_WEIGHTS} [input.weights]
 */
export function scoreBid(input) {
  const weights = input.weights ?? BID_WEIGHTS
  const raw =
    weights.capability * clamp(input.capability, 0, 1) +
    weights.idle * clamp(input.idle, 0, 1) +
    weights.successRate * clamp(input.successRate, 0, 1) +
    weights.aging * clamp(input.aging, 0, 1) -
    weights.cost * clamp(input.normalizedCost, 0, 2)
  return Number(clamp(raw, -2, 1).toFixed(6))
}

/**
 * Score one member for one task using live member/task state.
 * @param {any} member
 * @param {any} task
 * @param {{ round?: number, maxWip?: number, taskBudgetTokens?: number }} [options]
 */
export function evaluateMember(member, task, options = {}) {
  const maxWip = Math.max(1, options.maxWip ?? 2)
  const round = options.round ?? 0
  const idle = clamp(1 - (member.load ?? 0) / maxWip, 0, 1)
  const estimate = Math.max(1, task.estimate?.tokens ?? task.budget?.tokens ?? 50_000)
  const taskBudgetTokens = Math.max(1, options.taskBudgetTokens ?? task.budget?.tokens ?? estimate)
  const normalizedCost = clamp(estimate / taskBudgetTokens, 0, 2)
  const waitingRounds = Math.max(0, round - (member.lastWinRound ?? 0))
  return {
    capability: capabilityScore(member, task),
    idle,
    successRate: successRate(member.stats),
    aging: agingFactor(waitingRounds, options.agingRounds ?? 5),
    normalizedCost,
  }
}

/**
 * @param {any} member
 * @param {any} task
 * @param {{ round?: number, maxWip?: number, agingRounds?: number, taskBudgetTokens?: number }} [options]
 */
export function autoScore(member, task, options = {}) {
  const components = evaluateMember(member, task, options)
  return { score: scoreBid(components), components }
}

/**
 * Sort bids into deterministic award order.
 * @param {Array<{ memberId: string, score: number, at: number }>} bids
 * @param {number} minScore
 */
export function rankBids(bids, minScore = 0.3) {
  return bids
    .filter((bid) => bid.score >= minScore)
    .slice()
    .sort((a, b) => b.score - a.score || a.at - b.at || a.memberId.localeCompare(b.memberId))
}

/**
 * Create a time-boxed lease with a monotonically increasing fencing token.
 * @param {{ memberId: string, taskId: string, fence: number, now: number, leaseMs: number }} input
 */
export function createLease(input) {
  return {
    memberId: input.memberId,
    taskId: input.taskId,
    fence: input.fence,
    startedAt: input.now,
    expiresAt: input.now + input.leaseMs,
  }
}

/** @param {{ expiresAt: number } | undefined | null} lease @param {number} now */
export function isLeaseExpired(lease, now) {
  return Boolean(lease) && lease.expiresAt <= now
}

/**
 * Reject writes from a stale owner. This is the single guard that keeps a
 * reassigned task from being written by its previous holder.
 * @param {{ memberId: string, fence: number, expiresAt: number } | undefined | null} lease
 * @param {{ memberId?: string, fence?: number }} holder
 * @param {number} now
 */
export function assertLease(lease, holder, now) {
  if (!lease) throw new SwarmError('NO_LEASE', 'task has no active lease')
  if (lease.expiresAt <= now) throw new SwarmError('LEASE_EXPIRED', 'task lease has expired', { lease })
  if (holder.memberId && holder.memberId !== lease.memberId) {
    throw new SwarmError('STALE_LEASE', 'task is leased to another member', {
      owner: lease.memberId,
      caller: holder.memberId,
    })
  }
  if (holder.fence !== undefined && holder.fence !== lease.fence) {
    throw new SwarmError('STALE_LEASE', 'fencing token mismatch', {
      expected: lease.fence,
      received: holder.fence,
    })
  }
  return true
}
