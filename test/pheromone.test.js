import assert from 'node:assert/strict'
import test from 'node:test'
import { deposit, diffuse, pheromoneKey, snapshot, topicWeight, weightAt } from '../src/pheromone.js'

const HALF_LIFE = 30 * 60_000

test('weight halves after one half-life and decreases monotonically', () => {
  const field = new Map()
  const { pheromone } = deposit(field, { topic: 'api', kind: 'success', delta: 1, now: 0, halfLifeMs: HALF_LIFE })
  assert.equal(weightAt(pheromone, 0, HALF_LIFE), 1)
  assert.ok(Math.abs(weightAt(pheromone, HALF_LIFE, HALF_LIFE) - 0.5) < 1e-9)
  assert.ok(Math.abs(weightAt(pheromone, 2 * HALF_LIFE, HALF_LIFE) - 0.25) < 1e-9)
  let previous = Infinity
  for (let minute = 0; minute <= 120; minute += 10) {
    const weight = weightAt(pheromone, minute * 60_000, HALF_LIFE)
    assert.ok(weight <= previous)
    previous = weight
  }
})

test('deposit evaporates stale mass before reinforcing', () => {
  const field = new Map()
  deposit(field, { topic: 'api', kind: 'success', delta: 1, now: 0, halfLifeMs: HALF_LIFE })
  const second = deposit(field, { topic: 'api', kind: 'success', delta: 0.3, now: HALF_LIFE, halfLifeMs: HALF_LIFE })
  assert.ok(Math.abs(second.previous - 0.5) < 1e-9)
  assert.ok(Math.abs(second.pheromone.w0 - 0.8) < 1e-9)
  assert.equal(field.size, 1)
})

test('warning and success signals are tracked independently', () => {
  const field = new Map()
  deposit(field, { topic: 'api', kind: 'success', delta: 1, now: 0 })
  deposit(field, { topic: 'api', kind: 'warning', delta: 0.5, now: 0 })
  assert.equal(field.size, 2)
  assert.equal(field.has(pheromoneKey('api', 'success')), true)
  assert.equal(topicWeight(field, 'api', 0), 1)
  assert.equal(snapshot(field, { now: 0 }).length, 2)
})

test('diffusion moves a fraction of weight to adjacent topics', () => {
  const field = new Map()
  deposit(field, { topic: 'api', kind: 'success', delta: 1, now: 0 })
  const deposits = diffuse(field, new Map([['api', ['tests', 'docs']]]), { alpha: 0.1, now: 0 })
  assert.equal(deposits.length, 2)
  assert.ok(Math.abs(deposits[0].delta - 0.05) < 1e-9)
  assert.deepEqual(deposits.map((item) => item.topic).sort(), ['docs', 'tests'])
})

test('unknown pheromone kinds are rejected', () => {
  assert.throws(() => deposit(new Map(), { topic: 't', kind: 'alarm', delta: 1 }), /unknown pheromone kind/)
})
