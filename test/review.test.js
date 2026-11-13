import assert from 'node:assert/strict'
import test from 'node:test'
import { createReview, pickReviewers, tallyReviews } from '../src/review.js'

const AUTHOR = 'm-author'

function review(reviewerId, verdict, evidence = ['npm test: 12 passed'], comments = []) {
  return createReview({
    patchId: 'p1',
    reviewerId,
    authorId: AUTHOR,
    verdict,
    evidence,
    comments,
    now: 1,
    requireEvidence: true,
  })
}

test('an author cannot review their own patch', () => {
  assert.throws(
    () => createReview({ patchId: 'p1', reviewerId: AUTHOR, authorId: AUTHOR, verdict: 'approve' }),
    (error) => error.code === 'SELF_REVIEW',
  )
})

test('approval without evidence is weak and does not count toward quorum', () => {
  const weak = review('m1', 'approve', [])
  assert.equal(weak.weak, true)
  const tally = tallyReviews([weak], { eligibleCount: 2, quorum: 2 / 3 })
  assert.equal(tally.approvals, 0)
  assert.equal(tally.weak, 1)
  assert.equal(tally.passed, false)
})

test('quorum requires the configured share of eligible reviewers', () => {
  const tally = tallyReviews([review('m1', 'approve'), review('m2', 'approve')], { eligibleCount: 3, quorum: 2 / 3 })
  assert.equal(tally.needed, 2)
  assert.equal(tally.passed, true)
  const short = tallyReviews([review('m1', 'approve')], { eligibleCount: 3, quorum: 2 / 3 })
  assert.equal(short.passed, false)
  assert.equal(short.pending, 1)
})

test('a blocking comment rejects even with enough approvals', () => {
  const tally = tallyReviews(
    [
      review('m1', 'approve'),
      review('m2', 'request_changes', ['npm test failed'], [{ kind: 'blocking', body: 'breaks export' }]),
    ],
    { eligibleCount: 2, quorum: 2 / 3 },
  )
  assert.equal(tally.passed, false)
  assert.equal(tally.failed, true)
  assert.equal(tally.blocking.length, 1)
})

test('the latest vote from a reviewer replaces their earlier vote', () => {
  const first = review('m1', 'request_changes', ['x'], [{ kind: 'blocking', body: 'bug' }])
  const second = { ...review('m1', 'approve'), id: 'review-2' }
  const tally = tallyReviews([first, second], { eligibleCount: 2, quorum: 0.5 })
  assert.equal(tally.approvals, 1)
  assert.equal(tally.rejections, 0)
  assert.equal(tally.blocking.length, 0)
})

test('reviewer selection prefers a different model tier when possible', () => {
  const members = [
    { id: 'author', model: 'fast', load: 0 },
    { id: 'fast-a', model: 'fast', load: 0 },
    { id: 'fast-b', model: 'fast', load: 0 },
    { id: 'strong', model: 'strong', load: 0 },
  ]
  const picked = pickReviewers(members, 'author', 2)
  assert.equal(picked.length, 2)
  assert.equal(picked.includes('strong'), true)
})

test('reviewer selection excludes the author and prefers idle members', () => {
  const members = [
    { id: AUTHOR, load: 0 },
    { id: 'busy', load: 2 },
    { id: 'idle-a', load: 0 },
    { id: 'idle-b', load: 0 },
  ]
  const picked = pickReviewers(members, AUTHOR, 2)
  assert.equal(picked.length, 2)
  assert.equal(picked.includes(AUTHOR), false)
  assert.equal(picked.includes('busy'), false)
})
