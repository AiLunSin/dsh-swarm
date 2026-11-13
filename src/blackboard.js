/**
 * The hive blackboard: typed entries with TTL, confidence, size limits, and
 * secret redaction. Entries are stored as a Map<id, entry> on the run state;
 * every mutation arrives through an event, so this module stays pure.
 */
import { approxTokens, clamp, newId, nowMs, redact, SwarmError, truncate } from './util.js'

export const BOARD_KINDS = /** @type {const} */ ([
  'fact',
  'decision',
  'hypothesis',
  'warstory',
  'lock',
  'artifact',
])

/**
 * @typedef {object} BoardEntry
 * @property {string} id
 * @property {string} kind
 * @property {string} topic
 * @property {string} content
 * @property {number} confidence
 * @property {string} author
 * @property {number} version
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {number} expiresAt  0 means never
 * @property {number} bytes
 */

/**
 * @param {object} input
 * @param {string} input.kind
 * @param {string} input.topic
 * @param {string} input.content
 * @param {number} [input.confidence]
 * @param {string} [input.author]
 * @param {number} [input.ttlMs]
 * @param {number} [input.now]
 * @param {number} [input.maxEntryBytes]
 * @param {number} [input.defaultTtlMs]
 * @returns {BoardEntry}
 */
export function createEntry(input) {
  const kind = input.kind
  if (!BOARD_KINDS.includes(/** @type {any} */ (kind))) {
    throw new SwarmError('BOARD_INVALID_KIND', `unknown board kind '${kind}'`, { kind })
  }
  const topic = String(input.topic ?? '').trim()
  if (!topic) throw new SwarmError('BOARD_INVALID_TOPIC', 'board entry requires a topic')
  if (topic.length > 200) throw new SwarmError('BOARD_INVALID_TOPIC', 'topic must be <= 200 chars')
  const raw = String(input.content ?? '')
  if (!raw.trim()) throw new SwarmError('BOARD_EMPTY', 'board entry content must not be empty')
  const maxBytes = input.maxEntryBytes ?? 8 * 1024
  if (Buffer.byteLength(raw, 'utf8') > maxBytes) {
    throw new SwarmError('BOARD_ENTRY_TOO_LARGE', `entry exceeds ${maxBytes} bytes`, { maxBytes })
  }
  const scrubbed = redact(raw)
  const now = input.now ?? nowMs()
  const ttl = Math.max(0, input.ttlMs ?? input.defaultTtlMs ?? 0)
  const content = truncate(scrubbed.text, 8 * 1024)
  return {
    id: newId('board'),
    kind,
    topic,
    content,
    confidence: clamp(input.confidence ?? 0.7, 0, 1),
    author: input.author ?? 'unknown',
    version: 1,
    createdAt: now,
    updatedAt: now,
    expiresAt: ttl > 0 ? now + ttl : 0,
    bytes: Buffer.byteLength(content, 'utf8') + Buffer.byteLength(topic, 'utf8'),
  }
}

/** @param {BoardEntry} entry @param {number} now */
export function isExpired(entry, now = nowMs()) {
  return entry.expiresAt > 0 && entry.expiresAt <= now
}

/**
 * Weight used by query ranking and capacity eviction.
 * @param {BoardEntry} entry
 * @param {number} now
 * @param {number} halfLifeMs
 * @param {(entry: BoardEntry) => number} pheromoneWeight
 */
export function entryWeight(entry, now, halfLifeMs, pheromoneWeight) {
  const age = Math.max(0, now - entry.updatedAt)
  const recency = Math.exp((-Math.LN2 * age) / Math.max(1, halfLifeMs))
  return clamp(entry.confidence, 0, 1) * recency * (0.5 + 0.5 * clamp(pheromoneWeight(entry), 0, 4))
}

/**
 * @param {Map<string, BoardEntry>} entries
 * @param {object} query
 * @param {string[]} [query.topics]
 * @param {string[]} [query.kinds]
 * @param {number} [query.minConfidence]
 * @param {number} [query.topK]
 * @param {number} [query.tokenBudget]
 * @param {boolean} [query.includeExpired]
 * @param {number} [query.now]
 * @param {number} [query.halfLifeMs]
 * @param {(entry: BoardEntry) => number} [query.pheromoneWeight]
 */
export function queryEntries(entries, query = {}) {
  const now = query.now ?? nowMs()
  const halfLife = query.halfLifeMs ?? 30 * 60_000
  const topicSet = query.topics?.length ? new Set(query.topics) : null
  const kindSet = query.kinds?.length ? new Set(query.kinds) : null
  const minConfidence = query.minConfidence ?? 0
  const topK = Math.max(1, query.topK ?? 10)
  const tokenBudget = query.tokenBudget ?? 800
  const weightOf = query.pheromoneWeight ?? (() => 1)

  /** @type {Array<{ entry: BoardEntry, weight: number }>} */
  const candidates = []
  for (const entry of entries.values()) {
    if (!query.includeExpired && isExpired(entry, now)) continue
    if (topicSet && !topicSet.has(entry.topic)) continue
    if (kindSet && !kindSet.has(entry.kind)) continue
    if (entry.confidence < minConfidence) continue
    candidates.push({ entry, weight: entryWeight(entry, now, halfLife, weightOf) })
  }
  candidates.sort((a, b) => b.weight - a.weight || b.entry.updatedAt - a.entry.updatedAt)

  /** @type {BoardEntry[]} */
  const selected = []
  let tokens = 0
  let truncated = false
  for (const { entry } of candidates) {
    if (selected.length >= topK) {
      truncated = true
      break
    }
    const cost = approxTokens(entry.content) + 8
    if (tokens + cost > tokenBudget) {
      truncated = true
      continue
    }
    selected.push(entry)
    tokens += cost
  }
  return { entries: selected, truncated, tokens, total: candidates.length }
}

/**
 * Remove lowest-weight entries until the board fits `maxTotalBytes`.
 * Expired entries are removed first regardless of weight.
 * @param {Map<string, BoardEntry>} entries
 * @param {{ maxTotalBytes: number, now?: number, halfLifeMs?: number, pheromoneWeight?: (entry: BoardEntry) => number }} options
 * @returns {{ removed: BoardEntry[], totalBytes: number }}
 */
export function evict(entries, options) {
  const now = options.now ?? nowMs()
  const halfLife = options.halfLifeMs ?? 30 * 60_000
  const weightOf = options.pheromoneWeight ?? (() => 1)
  /** @type {BoardEntry[]} */
  const removed = []
  let totalBytes = 0
  for (const entry of entries.values()) totalBytes += entry.bytes

  /** @type {BoardEntry[]} */
  const ordered = [...entries.values()].sort((a, b) => {
    const expiredA = isExpired(a, now) ? 0 : 1
    const expiredB = isExpired(b, now) ? 0 : 1
    if (expiredA !== expiredB) return expiredA - expiredB
    return entryWeight(a, now, halfLife, weightOf) - entryWeight(b, now, halfLife, weightOf)
  })
  for (const entry of ordered) {
    if (totalBytes <= options.maxTotalBytes) break
    entries.delete(entry.id)
    totalBytes -= entry.bytes
    removed.push(entry)
  }
  return { removed, totalBytes }
}

/** @param {Map<string, BoardEntry>} entries */
export function boardBytes(entries) {
  let total = 0
  for (const entry of entries.values()) total += entry.bytes
  return total
}
