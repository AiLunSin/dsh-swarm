import assert from 'node:assert/strict'
import test from 'node:test'
import { parseTokenBudget, redact, scrub, stableStringify } from '../src/util.js'

test('redact removes recognizable credentials without leaking them', () => {
  const input = [
    'key sk-abcdefghijklmnop1234567890',
    'github ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'aws AKIAABCDEFGHIJKLMNOP',
    'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345',
    '-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----',
  ].join('\n')
  const result = redact(input)
  assert.equal(result.text.includes('sk-abcdefghijklmnop'), false)
  assert.equal(result.text.includes('ghp_'), false)
  assert.equal(result.text.includes('AKIAABCDEFGHIJKLMNOP'), false)
  assert.equal(result.text.includes('MIIE'), false)
  assert.ok(result.hits.includes('openai-key'))
  assert.ok(result.hits.includes('github-token'))
  assert.ok(result.hits.includes('aws-key'))
  assert.ok(result.hits.includes('private-key'))
})

test('redact scans without using the global regex lastIndex state', () => {
  const first = redact('sk-aaaaaaaaaaaaaaaaaaaa')
  const second = redact('sk-bbbbbbbbbbbbbbbbbbbb')
  assert.equal(first.text, '[redacted:openai-key]')
  assert.equal(second.text, '[redacted:openai-key]')
})

test('scrub redacts credential-named object keys and nested strings', () => {
  const result = scrub({ apiKey: 'plain-value', nested: { note: 'AKIAABCDEFGHIJKLMNOP' } })
  assert.equal(result.value.apiKey, '[redacted:key]')
  assert.equal(result.value.nested.note, '[redacted:aws-key]')
  assert.ok(result.hits.includes('key:apiKey'))
})

test('redact leaves filesystem paths intact', () => {
  const path = 'C:/Users/Example/AppData/Local/Temp/dsh-swarm-ws-AbCdEf1234567890/worktrees/run'
  const result = redact(path)
  assert.equal(result.text, path)
  const relative = 'swarm/swarm_AbCdEf123456/task/task_AbCdEf1234567890'
  assert.equal(redact(relative).text, relative)
})

test('stableStringify sorts keys recursively', () => {
  assert.equal(stableStringify({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}')
  assert.equal(stableStringify({ a: undefined, b: null }), '{"b":null}')
})

test('parseTokenBudget accepts compact forms', () => {
  assert.equal(parseTokenBudget('2m', 0), 2_000_000)
  assert.equal(parseTokenBudget('1.5k', 0), 1500)
  assert.equal(parseTokenBudget(42, 0), 42)
  assert.equal(parseTokenBudget('nope', 7), 7)
})
