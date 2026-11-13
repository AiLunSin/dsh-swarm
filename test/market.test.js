import assert from 'node:assert/strict'
import test from 'node:test'
import {
  agingFactor,
  assertLease,
  autoScore,
  capabilityScore,
  createLease,
  evaluateMember,
  isLeaseExpired,
  rankBids,
  scoreBid,
  successRate,
} from '../src/market.js'

test('score follows the published weights', () => {
  const score = scoreBid({ capability: 1, idle: 1, successRate: 1, aging: 0, normalizedCost: 0 })
  assert.equal(score, 0.8)
  const penalized = scoreBid({ capability: 1, idle: 1, successRate: 1, aging: 0, normalizedCost: 1 })
  assert.ok(penalized < score)
})

test('success rate is bayesian-smoothed from 0.5', () => {
  assert.equal(successRate({}), 0.5)
  assert.ok(successRate({ done: 8, failed: 0 }) > 0.8)
  assert.ok(successRate({ done: 0, failed: 8 }) < 0.2)
})

test('aging saturates at one after the configured rounds', () => {
  assert.equal(agingFactor(0, 5), 0)
  assert.equal(agingFactor(2, 5), 0.4)
  assert.equal(agingFactor(5, 5), 1)
  assert.equal(agingFactor(50, 5), 1)
})

test('capability prefers matching tags and file extensions', () => {
  const member = { role: 'worker', skills: ['.ts', 'typescript'] }
  assert.ok(capabilityScore(member, { tags: ['typescript'], scope: { files: ['src/a.ts'] } }) > 0.9)
  assert.ok(capabilityScore(member, { tags: ['design'], scope: { files: ['a.psd'] } }) < 0.5)
  assert.equal(capabilityScore(member, {}), 0.6)
})

test('evaluateMember rewards idle and penalizes expensive estimates', () => {
  const member = { role: 'worker', skills: [], load: 0, stats: { done: 1, failed: 0 }, lastWinRound: 0 }
  const cheap = evaluateMember(member, { estimate: { tokens: 10_000 }, scope: {} }, { round: 5, maxWip: 2, taskBudgetTokens: 100_000 })
  const busy = evaluateMember({ ...member, load: 2 }, { estimate: { tokens: 10_000 }, scope: {} }, { round: 5, maxWip: 2 })
  assert.ok(cheap.idle > busy.idle)
  const scored = autoScore(member, { estimate: { tokens: 10_000 }, scope: {} }, { round: 5, maxWip: 2 })
  assert.ok(scored.score > 0)
})

test('rankBids filters by min score and is deterministic', () => {
  const ranked = rankBids(
    [
      { memberId: 'b', score: 0.5, at: 2 },
      { memberId: 'a', score: 0.5, at: 1 },
      { memberId: 'c', score: 0.1, at: 0 },
    ],
    0.3,
  )
  assert.deepEqual(ranked.map((bid) => bid.memberId), ['a', 'b'])
})

test('leases expire and stale fences are rejected', () => {
  const lease = createLease({ memberId: 'm1', taskId: 't1', fence: 3, now: 1000, leaseMs: 500 })
  assert.equal(isLeaseExpired(lease, 1499), false)
  assert.equal(isLeaseExpired(lease, 1500), true)
  assert.equal(assertLease(lease, { memberId: 'm1', fence: 3 }, 1200), true)
  assert.throws(() => assertLease(lease, { memberId: 'm2', fence: 3 }, 1200), (e) => e.code === 'STALE_LEASE')
  assert.throws(() => assertLease(lease, { memberId: 'm1', fence: 2 }, 1200), (e) => e.code === 'STALE_LEASE')
  assert.throws(() => assertLease(lease, { memberId: 'm1', fence: 3 }, 2000), (e) => e.code === 'LEASE_EXPIRED')
  assert.throws(() => assertLease(null, { memberId: 'm1' }, 1000), (e) => e.code === 'NO_LEASE')
})
