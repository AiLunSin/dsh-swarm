/**
 * Append-only event log with a SHA-256 hash chain.
 *
 * One run owns one `events.jsonl`. Every event carries a monotonic `seq`, the
 * previous event's hash, and its own hash over the canonical event body, so
 * truncation or tampering is detectable on recovery. Appends are serialized and
 * fsynced before they resolve: a command that returned success has a durable
 * event behind it.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { newId, sha256, stableStringify, scrub, SwarmError } from './util.js'

const FORMAT_VERSION = 1
const GENESIS = 'genesis'

/**
 * @typedef {object} SwarmEvent
 * @property {number} v
 * @property {number} seq
 * @property {string} id
 * @property {string} runId
 * @property {string} type
 * @property {number} at
 * @property {string} actor
 * @property {string|null} causationId
 * @property {unknown} payload
 * @property {string} prev
 * @property {string} hash
 */

/** @param {Omit<SwarmEvent, 'hash'>} event */
export function hashEvent(event) {
  return sha256(stableStringify(event))
}

/**
 * Verify every link in a parsed event list.
 * @param {SwarmEvent[]} events
 * @param {{ runId?: string }} [options]
 */
export function verifyChain(events, options = {}) {
  let prev = GENESIS
  let seq = 0
  for (const event of events) {
    seq += 1
    if (event.seq !== seq) {
      throw new SwarmError('EVENT_LOG_CORRUPT', `event seq gap at line ${seq}: expected ${seq}, got ${event.seq}`, {
        line: seq,
      })
    }
    if (options.runId && event.runId !== options.runId) {
      throw new SwarmError('EVENT_LOG_CORRUPT', `event ${event.seq} belongs to run '${event.runId}'`, {
        line: seq,
      })
    }
    if (event.prev !== prev) {
      throw new SwarmError('EVENT_LOG_CORRUPT', `hash chain broken at event ${event.seq}`, { line: seq })
    }
    const { hash, ...body } = event
    if (hashEvent(body) !== hash) {
      throw new SwarmError('EVENT_LOG_CORRUPT', `event ${event.seq} hash mismatch`, { line: seq })
    }
    prev = event.hash
  }
  return true
}

export class EventLog {
  /**
   * @param {{ dir: string, runId: string, logger?: { warn?: (message: string) => void }, clock?: () => number }} options
   */
  constructor({ dir, runId, logger, clock = Date.now }) {
    this.dir = dir
    this.runId = runId
    this.logger = logger
    this.clock = clock
    this.file = path.join(dir, 'events.jsonl')
    /** @type {SwarmEvent[]} */
    this.events = []
    /** @type {Set<(event: SwarmEvent) => void>} */
    this.listeners = new Set()
    /** @type {import('node:fs/promises').FileHandle | null} */
    this.handle = null
    this.queue = Promise.resolve()
    this.closed = false
  }

  async open() {
    await fsp.mkdir(this.dir, { recursive: true })
    let raw = ''
    try {
      raw = await fsp.readFile(this.file, 'utf8')
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error
    }
    if (raw.trim()) {
      /** @type {SwarmEvent[]} */
      const parsed = []
      const lines = raw.split('\n')
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index].trim()
        if (!line) continue
        try {
          parsed.push(JSON.parse(line))
        } catch {
          throw new SwarmError('EVENT_LOG_CORRUPT', `invalid JSON at line ${index + 1}`, { line: index + 1 })
        }
      }
      verifyChain(parsed, { runId: this.runId })
      this.events = parsed
    }
    this.handle = await fsp.open(this.file, 'a')
    if (!raw.endsWith('\n') && raw.length > 0) {
      // A crash mid-write leaves a partial last line; it cannot be parsed and is
      // already rejected above, so reaching here means the file simply lacked a
      // trailing newline. Repair it before appending.
      await this.handle.write('\n')
    }
    return this
  }

  get lastSeq() {
    return this.events.length
  }

  /**
   * @param {string} type
   * @param {unknown} payload
   * @param {{ actor?: string, causationId?: string | null }} [meta]
   * @returns {Promise<SwarmEvent>}
   */
  async append(type, payload, meta = {}) {
    const operation = this.queue.then(() => this.#append(type, payload, meta))
    this.queue = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
  }

  /**
   * @param {string} type
   * @param {unknown} payload
   * @param {{ actor?: string, causationId?: string | null }} meta
   */
  async #append(type, payload, meta) {
    if (this.closed) throw new SwarmError('EVENT_LOG_CLOSED', 'event log is closed')
    if (!this.handle) throw new SwarmError('EVENT_LOG_CLOSED', 'event log is not open')
    const scrubbed = scrub(payload)
    const previous = this.events.at(-1)
    /** @type {Omit<SwarmEvent, 'hash'>} */
    const body = {
      v: FORMAT_VERSION,
      seq: this.events.length + 1,
      id: newId('evt'),
      runId: this.runId,
      type,
      at: this.clock(),
      actor: meta.actor ?? 'system',
      causationId: meta.causationId ?? null,
      payload: scrubbed.value,
      prev: previous ? previous.hash : GENESIS,
    }
    /** @type {SwarmEvent} */
    const event = { ...body, hash: hashEvent(body) }
    await this.handle.write(`${JSON.stringify(event)}\n`)
    await this.handle.sync()
    this.events.push(event)
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        this.logger?.warn?.(`[swarm] event listener failed: ${String(error)}`)
      }
    }
    return event
  }

  /** @param {(event: SwarmEvent) => void} listener */
  onAppend(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async close() {
    if (this.closed) return
    this.closed = true
    await this.queue.catch(() => undefined)
    const handle = this.handle
    this.handle = null
    if (handle) await handle.close()
  }
}

/**
 * Write a snapshot atomically (temp file + rename).
 * @param {string} dir
 * @param {unknown} snapshot
 */
export async function writeSnapshot(dir, snapshot) {
  await fsp.mkdir(dir, { recursive: true })
  const target = path.join(dir, 'snapshot.json')
  const temp = `${target}.${process.pid}.tmp`
  await fsp.writeFile(temp, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
  await fsp.rename(temp, target)
}

/**
 * @param {string} dir
 * @returns {Promise<unknown | null>}
 */
export async function readSnapshot(dir) {
  try {
    return JSON.parse(await fsp.readFile(path.join(dir, 'snapshot.json'), 'utf8'))
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return null
    throw error
  }
}
