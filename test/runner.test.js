import assert from 'node:assert/strict'
import test from 'node:test'
import { SubagentRunner } from '../src/runner.js'

test('runner passes a flat activation spec with the calling agent as parent', async () => {
  /** @type {any} */
  let captured
  const agent = { id: 'parent-agent' }
  const ctx = {
    get(name) {
      assert.equal(name, 'subagents')
      return {
        async startActivation(spec) {
          captured = spec
          return {
            childId: 'child-1',
            result: Promise.resolve({ stopReason: 'completed', structured: { summary: 'ok' } }),
            dispose: async () => undefined,
          }
        },
      }
    },
  }
  const runner = new SubagentRunner({ provider: 'spawn' })
  const controller = new AbortController()
  const started = await runner.start({
    ctx,
    agent,
    prompt: 'do the task',
    cwd: 'C:/work/repo',
    label: 'swarm/run/task',
    signal: controller.signal,
  })
  assert.equal(captured.provider, 'spawn')
  assert.equal(captured.parent, agent)
  assert.equal(captured.cwd, 'C:/work/repo')
  assert.equal(captured.prompt[0].text, 'do the task')
  assert.equal(captured.delivery, 'caller')
  assert.equal(captured.maxDepth, 1)
  assert.equal(captured.request, undefined)
  assert.equal(started.childId, 'child-1')
  assert.equal((await started.result).stopReason, 'completed')
})
