import assert from 'node:assert/strict'
import test from 'node:test'
import { canTransition, assertTransition, isTerminalTaskState, isTerminalSwarmState } from '../src/state.js'

test('swarm lifecycle transitions are explicit', () => {
  assert.equal(canTransition('swarm', 'created', 'running'), true)
  assert.equal(canTransition('swarm', 'running', 'paused'), true)
  assert.equal(canTransition('swarm', 'paused', 'running'), true)
  assert.equal(canTransition('swarm', 'running', 'converged'), true)
  assert.equal(canTransition('swarm', 'converged', 'running'), false)
  assert.equal(canTransition('swarm', 'aborted', 'running'), false)
})

test('task transitions reject shortcuts and allow rework', () => {
  assert.equal(canTransition('task', 'draft', 'advertised'), true)
  assert.equal(canTransition('task', 'advertised', 'awarded'), true)
  assert.equal(canTransition('task', 'awarded', 'working'), true)
  assert.equal(canTransition('task', 'working', 'submitted'), true)
  assert.equal(canTransition('task', 'submitted', 'reviewing'), true)
  assert.equal(canTransition('task', 'reviewing', 'approved'), true)
  assert.equal(canTransition('task', 'reviewing', 'working'), true)
  assert.equal(canTransition('task', 'working', 'merged'), false)
  assert.equal(canTransition('task', 'merged', 'working'), false)
})

test('assertTransition throws a coded error for illegal jumps', () => {
  assert.throws(
    () => assertTransition('task', 'draft', 'merged'),
    (error) => error.code === 'INVALID_TRANSITION' && /draft -> merged/.test(error.message),
  )
  assert.throws(() => assertTransition('task', 'working', 'working'), (error) => error.code === 'INVALID_TRANSITION')
})

test('terminal predicates', () => {
  assert.equal(isTerminalTaskState('merged'), true)
  assert.equal(isTerminalTaskState('reviewing'), false)
  assert.equal(isTerminalSwarmState('converged'), true)
  assert.equal(isTerminalSwarmState('draining'), false)
})
