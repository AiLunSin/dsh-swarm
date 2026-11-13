/**
 * Pheromone field: three signal kinds (success / warning / heat) deposited on
 * topics and evaporating with a configurable half-life.
 *
 * Storage keeps only `w0` and `t0`; the current weight is computed on read. That
 * makes ticks cheap (no full rewrite) and keeps the event log tiny.
 */
import { newId } from './util.js'

export const PHEROMONE_KINDS = /** @type {const} */ (['success', 'warning', 'heat'])

/**
 * @typedef {object} Pheromone
 * @property {string} id
 * @property {string} topic
 * @property {string} kind
 * @property {number} w0
 * @property {number} t0
 */

/** @param {string} topic @param {string} kind */
export function pheromoneKey(topic, kind) {
  return `${topic}\u0000${kind}`
}

/**
 * Current weight after evaporation.
 * @param {Pheromone} pheromone
 * @param {number} [now]
 * @param {number} [halfLifeMs]
 */
export function weightAt(pheromone, now = Date.now(), halfLifeMs = 30 * 60_000) {
  const age = Math.max(0, now - pheromone.t0)
  return pheromone.w0 * Math.exp((-Math.LN2 * age) / Math.max(1, halfLifeMs))
}

/**
 * Deposit (or reinforce) a signal. Existing weight is first evaporated to now,
 * then incremented, so repeated deposits do not double-count stale mass.
 * @param {Map<string, Pheromone>} field
 * @param {object} input
 * @param {string} input.topic
 * @param {string} input.kind
 * @param {number} input.delta
 * @param {number} [input.now]
 * @param {number} [input.halfLifeMs]
 * @param {number} [input.maxWeight]
 * @returns {{ pheromone: Pheromone, previous: number }}
 */
export function deposit(field, input) {
  if (!PHEROMONE_KINDS.includes(/** @type {any} */ (input.kind))) {
    throw new Error(`unknown pheromone kind '${input.kind}'`)
  }
  const now = input.now ?? Date.now()
  const halfLife = input.halfLifeMs ?? 30 * 60_000
  const maxWeight = input.maxWeight ?? 10
  const key = pheromoneKey(input.topic, input.kind)
  const existing = field.get(key)
  const previous = existing ? weightAt(existing, now, halfLife) : 0
  const nextWeight = Math.min(maxWeight, previous + Math.max(0, input.delta))
  const pheromone = existing
    ? { ...existing, w0: nextWeight, t0: now }
    : { id: newId('pher'), topic: input.topic, kind: input.kind, w0: nextWeight, t0: now }
  field.set(key, pheromone)
  return { pheromone, previous }
}

/**
 * Spread a fraction of each topic's signal to adjacent topics. Returns the new
 * deposits only; the caller emits them as events.
 * @param {Map<string, Pheromone>} field
 * @param {Map<string, string[]>} adjacency
 * @param {{ alpha?: number, now?: number, halfLifeMs?: number }} [options]
 * @returns {Array<{ topic: string, kind: string, delta: number }>}
 */
export function diffuse(field, adjacency, options = {}) {
  const alpha = options.alpha ?? 0.05
  const now = options.now ?? Date.now()
  const halfLife = options.halfLifeMs ?? 30 * 60_000
  /** @type {Map<string, number>} */
  const pending = new Map()
  for (const pheromone of field.values()) {
    const neighbours = adjacency.get(pheromone.topic)
    if (!neighbours?.length) continue
    const current = weightAt(pheromone, now, halfLife)
    const share = (current * alpha) / neighbours.length
    if (share < 1e-6) continue
    for (const topic of neighbours) {
      const key = pheromoneKey(topic, pheromone.kind)
      pending.set(key, (pending.get(key) ?? 0) + share)
    }
  }
  /** @type {Array<{ topic: string, kind: string, delta: number }>} */
  const deposits = []
  for (const [key, delta] of pending) {
    const [topic, kind] = key.split('\u0000')
    deposits.push({ topic, kind, delta })
  }
  return deposits
}

/**
 * Highest current weight over all kinds for one topic.
 * @param {Map<string, Pheromone>} field
 * @param {string} topic
 * @param {number} [now]
 * @param {number} [halfLifeMs]
 */
export function topicWeight(field, topic, now = Date.now(), halfLifeMs = 30 * 60_000) {
  let max = 0
  for (const kind of PHEROMONE_KINDS) {
    const pheromone = field.get(pheromoneKey(topic, kind))
    if (pheromone) max = Math.max(max, weightAt(pheromone, now, halfLifeMs))
  }
  return max
}

/**
 * Snapshot of the field with evaporated weights.
 * @param {Map<string, Pheromone>} field
 * @param {{ now?: number, halfLifeMs?: number, topic?: string }} [options]
 */
export function snapshot(field, options = {}) {
  const now = options.now ?? Date.now()
  const halfLife = options.halfLifeMs ?? 30 * 60_000
  /** @type {Array<{ id: string, topic: string, kind: string, weight: number, updatedAt: number }>} */
  const out = []
  for (const pheromone of field.values()) {
    if (options.topic && pheromone.topic !== options.topic) continue
    const weight = weightAt(pheromone, now, halfLife)
    if (weight < 1e-4) continue
    out.push({
      id: pheromone.id,
      topic: pheromone.topic,
      kind: pheromone.kind,
      weight: Number(weight.toFixed(6)),
      updatedAt: pheromone.t0,
    })
  }
  out.sort((a, b) => b.weight - a.weight)
  return out
}
