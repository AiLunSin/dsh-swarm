import assert from 'node:assert/strict'
import test from 'node:test'
import { boardBytes, createEntry, evict, isExpired, queryEntries } from '../src/blackboard.js'

const NOW = 1_700_000_000_000

test('entries validate kind, topic, and size', () => {
  assert.throws(() => createEntry({ kind: 'rumor', topic: 't', content: 'x', now: NOW }), (e) => e.code === 'BOARD_INVALID_KIND')
  assert.throws(() => createEntry({ kind: 'fact', topic: '', content: 'x', now: NOW }), (e) => e.code === 'BOARD_INVALID_TOPIC')
  assert.throws(() => createEntry({ kind: 'fact', topic: 't', content: '', now: NOW }), (e) => e.code === 'BOARD_EMPTY')
  assert.throws(
    () => createEntry({ kind: 'fact', topic: 't', content: 'x'.repeat(100), now: NOW, maxEntryBytes: 10 }),
    (e) => e.code === 'BOARD_ENTRY_TOO_LARGE',
  )
})

test('writes scrub secrets before they reach the board', () => {
  const entry = createEntry({ kind: 'fact', topic: 'auth', content: 'token sk-abcdefghijklmnop123456', now: NOW })
  assert.equal(entry.content.includes('sk-abcdefghijklmnop'), false)
  assert.match(entry.content, /\[redacted:openai-key\]/)
})

test('TTL expires entries from default queries but keeps history', () => {
  const entry = createEntry({ kind: 'fact', topic: 'build', content: 'flaky', ttlMs: 1000, now: NOW })
  const board = new Map([[entry.id, entry]])
  assert.equal(isExpired(entry, NOW + 500), false)
  assert.equal(isExpired(entry, NOW + 1000), true)
  assert.equal(queryEntries(board, { now: NOW + 2000 }).entries.length, 0)
  assert.equal(queryEntries(board, { now: NOW + 2000, includeExpired: true }).entries.length, 1)
})

test('query ranks confidence and recency and truncates to the token budget', () => {
  const strong = createEntry({ kind: 'fact', topic: 'api', content: 'alpha', confidence: 0.9, now: NOW })
  const stale = createEntry({ kind: 'fact', topic: 'api', content: 'beta', confidence: 0.9, now: NOW - 60 * 60_000 })
  const board = new Map([
    [strong.id, strong],
    [stale.id, stale],
  ])
  const ranked = queryEntries(board, { now: NOW, halfLifeMs: 30 * 60_000, topK: 2 })
  assert.equal(ranked.entries[0].id, strong.id)
  const limited = queryEntries(board, { now: NOW, topK: 2, tokenBudget: 8 })
  assert.equal(limited.truncated, true)
  assert.ok(limited.entries.length <= 1)
})

test('capacity eviction removes the lowest weight first', () => {
  const low = createEntry({ kind: 'fact', topic: 'old', content: 'x'.repeat(100), confidence: 0.2, now: NOW - 3600_000 })
  const high = createEntry({ kind: 'decision', topic: 'new', content: 'y'.repeat(100), confidence: 0.9, now: NOW })
  const board = new Map([
    [low.id, low],
    [high.id, high],
  ])
  const total = boardBytes(board)
  const result = evict(board, { maxTotalBytes: total - low.bytes + 10, now: NOW })
  assert.deepEqual(result.removed.map((entry) => entry.id), [low.id])
  assert.equal(board.has(high.id), true)
})
