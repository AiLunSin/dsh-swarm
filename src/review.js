/**
 * Review rules: non-author reviewers, evidence-backed approvals, quorum tally.
 * Votes only decide whether a patch may proceed; gates decide whether it is
 * correct, and a failing gate blocks the merge even with unanimous votes.
 */
import { newId, SwarmError } from './util.js'

export const VERDICTS = /** @type {const} */ (['approve', 'request_changes', 'abstain'])

/**
 * @param {object} input
 * @param {string} input.patchId
 * @param {string} input.reviewerId
 * @param {string} input.authorId
 * @param {string} input.verdict
 * @param {Array<{ kind: string, body: string }>} [input.comments]
 * @param {string[]} [input.evidence]
 * @param {number} [input.now]
 * @param {boolean} [input.requireEvidence]
 */
export function createReview(input) {
  if (input.reviewerId === input.authorId) {
    throw new SwarmError('SELF_REVIEW', 'the author of a patch cannot review it', {
      reviewerId: input.reviewerId,
    })
  }
  if (!VERDICTS.includes(/** @type {any} */ (input.verdict))) {
    throw new SwarmError('INVALID_VERDICT', `unknown verdict '${input.verdict}'`, { verdict: input.verdict })
  }
  const comments = Array.isArray(input.comments) ? input.comments : []
  for (const comment of comments) {
    if (!['blocking', 'nit', 'question'].includes(comment.kind)) {
      throw new SwarmError('INVALID_COMMENT', `unknown comment kind '${comment.kind}'`, { comment })
    }
  }
  const evidence = (Array.isArray(input.evidence) ? input.evidence : []).map(String).filter(Boolean)
  const requireEvidence = input.requireEvidence ?? true
  const weak = input.verdict === 'approve' && requireEvidence && evidence.length === 0
  return {
    id: newId('review'),
    patchId: input.patchId,
    reviewerId: input.reviewerId,
    verdict: input.verdict,
    comments,
    evidence,
    weak,
    at: input.now ?? Date.now(),
  }
}

/**
 * Pick reviewers from the non-author pool, preferring idle members and, when
 * possible, at least one reviewer whose model tier differs from the author's.
 * @param {Array<{ id: string, status?: string, load?: number, model?: string }>} members
 * @param {string} authorId
 * @param {number} count
 * @param {string[]} [exclude]
 */
export function pickReviewers(members, authorId, count, exclude = []) {
  const excluded = new Set([authorId, ...exclude])
  const pool = members
    .filter((member) => !excluded.has(member.id) && member.status !== 'left' && member.status !== 'lost')
    .slice()
    .sort((a, b) => (a.load ?? 0) - (b.load ?? 0) || a.id.localeCompare(b.id))
  const selected = pool.slice(0, Math.max(0, count))
  const author = members.find((member) => member.id === authorId)
  if (selected.length > 1 && author?.model && author.model !== 'inherit') {
    const hasDifferent = selected.some((member) => member.model && member.model !== author.model)
    if (!hasDifferent) {
      const alternate = pool.find(
        (member) => !selected.includes(member) && member.model && member.model !== author.model,
      )
      if (alternate) selected[selected.length - 1] = alternate
    }
  }
  return selected.map((member) => member.id)
}

/**
 * @param {Array<{ reviewerId: string, verdict: string, weak: boolean, comments: Array<{ kind: string, body: string }> }>} reviews
 * @param {{ eligibleCount: number, quorum?: number, requireEvidence?: boolean, base?: 'eligible'|'cast' }} options
 */
export function tallyReviews(reviews, options) {
  const quorum = options.quorum ?? 2 / 3
  const eligibleCount = Math.max(1, options.eligibleCount)
  const latest = new Map()
  for (const review of reviews) latest.set(review.reviewerId, review)
  let approvals = 0
  let rejections = 0
  let abstentions = 0
  let weak = 0
  /** @type {Array<{ reviewerId: string, body: string }>} */
  const blocking = []
  for (const review of latest.values()) {
    if (review.verdict === 'approve') {
      if (review.weak && options.requireEvidence !== false) weak += 1
      else approvals += 1
    } else if (review.verdict === 'request_changes') {
      rejections += 1
      for (const comment of review.comments ?? []) {
        if (comment.kind === 'blocking') blocking.push({ reviewerId: review.reviewerId, body: comment.body })
      }
    } else {
      abstentions += 1
    }
  }
  // A timed-out review is an abstention that must not block the merge. For that
  // path the quorum denominator is the set of verdicts actually cast.
  const baseCount = options.base === 'cast' ? Math.max(0, approvals + rejections) : eligibleCount
  const needed = Math.max(1, Math.ceil(baseCount * quorum))
  const votes = latest.size
  const passed = approvals >= needed && blocking.length === 0 && rejections === 0
  const failed = rejections > 0 || blocking.length > 0 || (votes >= needed && approvals < needed && abstentions < eligibleCount)
  return {
    needed,
    eligibleCount,
    baseCount,
    approvals,
    rejections,
    abstentions,
    weak,
    blocking,
    votes,
    pending: Math.max(0, needed - votes),
    passed,
    failed: failed && !passed,
  }
}
