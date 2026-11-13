#!/usr/bin/env node
/**
 * Summarize one real-model run from its events.jsonl.
 * Usage: node bench/summarize-run.mjs <runDir> [mode]
 */
import fsp from 'node:fs/promises'
import path from 'node:path'

const dir = process.argv[2]
const mode = process.argv[3] ?? 'unknown'
if (!dir) {
  console.error('usage: node bench/summarize-run.mjs <runDir> [mode]')
  process.exit(1)
}
const lines = (await fsp.readFile(path.join(dir, 'events.jsonl'), 'utf8')).trim().split('\n')
const events = lines.map((line) => JSON.parse(line))
const first = events[0]
const converged = events.find((event) => event.type === 'swarm/converged')
const aborted = events.find((event) => event.type === 'swarm/aborted')
const end = converged ?? aborted
let tokens = 0
let calls = 0
for (const event of events) {
  if (event.type === 'swarm/budget/charged') {
    tokens += event.payload.tokens ?? 0
    calls += event.payload.calls ?? 1
  }
}
const dispatched = events.filter((event) => event.type === 'swarm/dispatch/started')
const submitted = events.filter((event) => event.type === 'swarm/task/submitted')
const merged = events.filter((event) => event.type === 'swarm/task/merged')
const reviews = events.filter((event) => event.type === 'swarm/vote/cast')
const report = {
  mode,
  runId: first.runId,
  outcome: end?.type === 'swarm/converged' ? 'converged' : 'not_converged',
  reason: end?.payload?.reason ?? null,
  tasks: submitted.length,
  merged: merged.length,
  dispatches: dispatched.length,
  votes: reviews.length,
  tokens,
  calls,
  events: events.length,
  createdAt: first.at,
  endedAt: end?.at ?? null,
  wallMs: end ? end.at - first.at : null,
  at: new Date().toISOString(),
}
const results = path.resolve(import.meta.dirname, 'results')
await fsp.mkdir(results, { recursive: true })
const file = path.join(results, `real-${mode}-${first.runId}.json`)
await fsp.writeFile(file, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.log(JSON.stringify(report, null, 2))
console.log(`saved ${file}`)
