import assert from 'node:assert/strict'
import test from 'node:test'
import {
  budgetSnapshot,
  createBudgetState,
  release,
  remainingTokens,
  reserve,
  runBudgetState,
  settle,
} from '../src/budget.js'

function state(tokens = 10_000) {
  return createBudgetState({
    budget: { tokens, usd: 10, wallMs: 0 },
    taskBudget: { tokens: 5_000 },
    memberBudget: { tokens: 6_000 },
  })
}

test('reserve holds budget and lowers what is available', () => {
  const budget = state()
  const reservation = reserve(budget, { id: 'r1', scope: 'task', key: 't1', tokens: 2_000, now: 100 })
  assert.equal(reservation.tokens, 2_000)
  assert.equal(remainingTokens(budget, 'run'), 8_000)
  assert.equal(remainingTokens(budget, 'task', 't1'), 3_000)
  assert.equal(budget.run.tokens, 0)
})

test('settle charges actual usage and releases the hold', () => {
  const budget = state()
  reserve(budget, { id: 'r1', scope: 'task', key: 't1', tokens: 2_000 })
  const result = settle(budget, 'r1', { tokens: 1_200, usd: 0.2, wallMs: 50 })
  assert.equal(result.actualTokens, 1_200)
  assert.ok(result.drift > 0.2)
  assert.equal(budget.run.tokens, 1_200)
  assert.equal(budget.run.reservedTokens, 0)
  assert.equal(budget.run.calls, 1)
  assert.equal(remainingTokens(budget, 'run'), 8_800)
  assert.equal(remainingTokens(budget, 'task', 't1'), 3_800)
})

test('reservation over the run or scope limit is rejected', () => {
  const budget = state(1_000)
  assert.throws(
    () => reserve(budget, { id: 'r1', scope: 'task', key: 't1', tokens: 1_500 }),
    (error) => error.code === 'BUDGET_EXCEEDED' && error.details.scope === 'run',
  )
  const scoped = state()
  assert.throws(
    () => reserve(scoped, { id: 'r2', scope: 'task', key: 't1', tokens: 6_000 }),
    (error) => error.code === 'BUDGET_EXCEEDED' && error.details.scope === 'task',
  )
})

test('release returns held budget without charging', () => {
  const budget = state()
  reserve(budget, { id: 'r1', scope: 'member', key: 'm1', tokens: 3_000 })
  assert.equal(release(budget, 'r1'), true)
  assert.equal(budget.run.reservedTokens, 0)
  assert.equal(remainingTokens(budget, 'run'), 10_000)
  assert.equal(release(budget, 'r1'), false)
})

test('run budget state reports exhaustion', () => {
  const budget = state(1_000)
  reserve(budget, { id: 'r1', scope: 'member', key: 'm1', tokens: 1_000 })
  const view = runBudgetState(budget, { now: 0, startedAt: 0 })
  assert.equal(view.exhausted, true)
  assert.equal(view.remaining, 0)
  assert.equal(view.ratio, 1)
})

test('snapshot is serializable', () => {
  const budget = state()
  reserve(budget, { id: 'r1', scope: 'task', key: 't1', tokens: 100 })
  const snapshot = budgetSnapshot(budget)
  assert.equal(snapshot.limits.runTokens, 10_000)
  assert.equal(snapshot.reservations, 1)
  assert.equal(snapshot.tasks.t1.reservedTokens, 100)
  assert.doesNotThrow(() => JSON.stringify(snapshot))
})
