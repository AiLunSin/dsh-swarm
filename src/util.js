/**
 * Small, dependency-free helpers shared by the swarm core.
 * Everything here is deterministic except the id/time helpers, which take
 * injectable clocks where tests need reproducibility.
 */
import { createHash, randomBytes } from 'node:crypto'

/** Domain error with a stable machine-readable code. */
export class SwarmError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'SwarmError'
    this.code = code
    this.details = details
  }
}

/** @returns {number} */
export function nowMs() {
  return Date.now()
}

/**
 * Monotonic-ish, sortable id: base36 timestamp + random suffix.
 * @param {string} [prefix]
 * @returns {string}
 */
export function newId(prefix = '') {
  const stamp = Date.now().toString(36)
  const rand = randomBytes(5).toString('hex')
  return `${prefix}${prefix ? '_' : ''}${stamp}${rand}`
}

/** @param {string} text */
export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * JSON with object keys sorted recursively, so hashes and dedupe keys are stable.
 * @param {unknown} value
 * @returns {string}
 */
export function stableStringify(value) {
  return JSON.stringify(sortValue(value))
}

/** @param {unknown} value @returns {unknown} */
function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value && typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {}
    for (const key of Object.keys(value).sort()) {
      const item = /** @type {Record<string, unknown>} */ (value)[key]
      if (item !== undefined) out[key] = sortValue(item)
    }
    return out
  }
  return value
}

/** @param {unknown} value @returns {Record<string, unknown>} */
export function objectOf(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {}
}

/** @param {number} value @param {number} min @param {number} max */
export function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

/** @param {string} text @param {number} max */
export function truncate(text, max) {
  const input = String(text ?? '')
  if (input.length <= max) return input
  return `${input.slice(0, Math.max(0, max - 1))}…`
}

/** Rough token estimate used for board and context budgets. */
export function approxTokens(text) {
  return Math.ceil(String(text ?? '').length / 4)
}

/** @param {unknown} value @param {number} fallback @param {number} min @param {number} max */
export function asInt(value, fallback, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(number)) return fallback
  return clamp(Math.trunc(number), min, max)
}

/** @param {unknown} value @param {number} fallback @param {number} min @param {number} max */
export function asFloat(value, fallback, min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY) {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(number)) return fallback
  return clamp(number, min, max)
}

/** @param {unknown} value @param {boolean} fallback */
export function asBool(value, fallback) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    if (['true', '1', 'yes', 'on'].includes(value.toLowerCase())) return true
    if (['false', '0', 'no', 'off'].includes(value.toLowerCase())) return false
  }
  return fallback
}

/** @param {unknown} value @param {string} fallback */
export function asString(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

/**
 * Keep only values from a fixed set, otherwise fall back.
 * @template {string} T
 * @param {unknown} value
 * @param {readonly T[]} allowed
 * @param {T} fallback
 * @returns {T}
 */
export function asEnum(value, allowed, fallback) {
  return typeof value === 'string' && /** @type {readonly string[]} */ (allowed).includes(value)
    ? /** @type {T} */ (value)
    : fallback
}

const SECRET_PATTERNS = [
  ['openai-key', /sk-[A-Za-z0-9_-]{16,}/g],
  ['github-token', /gh[pousr]_[A-Za-z0-9]{20,}/g],
  ['github-pat', /github_pat_[A-Za-z0-9_]{20,}/g],
  ['aws-key', /AKIA[0-9A-Z]{16}/g],
  ['slack-token', /xox[baprs]-[A-Za-z0-9-]{10,}/g],
  ['bearer', /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g],
  ['private-key', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g],
]

/** Shannon entropy in bits per character. @param {string} text */
export function entropy(text) {
  if (!text) return 0
  /** @type {Map<string, number>} */
  const counts = new Map()
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1)
  let bits = 0
  for (const count of counts.values()) {
    const p = count / text.length
    bits -= p * Math.log2(p)
  }
  return bits
}

/**
 * Detect and replace secrets before anything is persisted or shown.
 * Returns the scrubbed text plus a list of matched kinds (never the secrets).
 * @param {string} text
 * @returns {{ text: string, hits: string[] }}
 */
export function redact(text) {
  let output = String(text ?? '')
  const hits = []
  for (const [kind, pattern] of SECRET_PATTERNS) {
    pattern.lastIndex = 0
    if (pattern.test(output)) {
      hits.push(kind)
      pattern.lastIndex = 0
      output = output.replace(pattern, `[redacted:${kind}]`)
    }
  }
  // High-entropy opaque tokens (long base64/hex blobs that look like credentials).
  // Deliberately excludes path separators: a long absolute path is not a secret,
  // and redacting it would break worktree/repository metadata.
  output = output.replace(/\b[A-Za-z0-9+_=-]{40,}\b/g, (token) => {
    const hasLower = /[a-z]/.test(token)
    const hasUpper = /[A-Z]/.test(token)
    const hasDigit = /\d/.test(token)
    if (hasLower && hasUpper && hasDigit && entropy(token) >= 4.2) {
      hits.push('high-entropy')
      return '[redacted:high-entropy]'
    }
    return token
  })
  return { text: output, hits }
}

/**
 * Deep-scrub every string in a JSON-like value. Cycles are rejected because
 * event payloads must be serializable.
 * @param {unknown} value
 * @returns {{ value: unknown, hits: string[] }}
 */
export function scrub(value) {
  const hits = []
  const seen = new WeakSet()
  /** @param {unknown} input @returns {unknown} */
  const walk = (input) => {
    if (typeof input === 'string') {
      const result = redact(input)
      hits.push(...result.hits)
      return result.text
    }
    if (!input || typeof input !== 'object') return input
    if (seen.has(input)) throw new SwarmError('INVALID_PAYLOAD', 'payload contains a cycle')
    seen.add(input)
    if (Array.isArray(input)) return input.map(walk)
    /** @type {Record<string, unknown>} */
    const out = {}
    for (const [key, item] of Object.entries(input)) {
      // Never persist values keyed like credentials, even if they slipped through.
      if (/^(api[_-]?key|token|secret|password|authorization)$/i.test(key) && typeof item === 'string') {
        hits.push(`key:${key}`)
        out[key] = '[redacted:key]'
      } else {
        out[key] = walk(item)
      }
    }
    return out
  }
  return { value: walk(value), hits }
}

/** @param {number} ms */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Parse an integer token budget that may be written as 2e6 or "2m".
 * @param {unknown} value
 * @param {number} fallback
 */
export function parseTokenBudget(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.trunc(value))
  if (typeof value !== 'string') return fallback
  const text = value.trim().toLowerCase()
  const match = /^([0-9]*\.?[0-9]+)\s*([km])?$/.exec(text)
  if (!match) return fallback
  const base = Number(match[1])
  const scale = match[2] === 'k' ? 1e3 : match[2] === 'm' ? 1e6 : 1
  return Math.max(0, Math.trunc(base * scale))
}
