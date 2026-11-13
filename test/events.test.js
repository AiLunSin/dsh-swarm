import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { EventLog, hashEvent, verifyChain, writeSnapshot } from '../src/events.js'

async function tempDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-swarm-events-'))
}

test('appends a contiguous hash-chained log and reopens it', async (t) => {
  const dir = await tempDir()
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  const log = await new EventLog({ dir, runId: 'run-1' }).open()
  await log.append('swarm/created', { goal: 'g' })
  await log.append('swarm/status/changed', { to: 'running' })
  await log.append('swarm/board/written', { entry: { id: 'e1', content: 'fact' } })
  assert.deepEqual(log.events.map((event) => event.seq), [1, 2, 3])
  assert.equal(log.events[1].prev, log.events[0].hash)
  verifyChain(log.events, { runId: 'run-1' })
  await log.close()

  const reopened = await new EventLog({ dir, runId: 'run-1' }).open()
  assert.equal(reopened.events.length, 3)
  assert.equal(reopened.lastSeq, 3)
  const next = await reopened.append('swarm/tick', { tick: 1 })
  assert.equal(next.seq, 4)
  await reopened.close()
})

test('event hashes cover the canonical body', async (t) => {
  const dir = await tempDir()
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  const log = await new EventLog({ dir, runId: 'run-2' }).open()
  const event = await log.append('swarm/created', { goal: 'g' })
  const { hash, ...body } = event
  assert.equal(hashEvent(body), hash)
  await log.close()
})

test('tampering with a stored line is detected on open', async (t) => {
  const dir = await tempDir()
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  const log = await new EventLog({ dir, runId: 'run-3' }).open()
  await log.append('swarm/created', { goal: 'original' })
  await log.append('swarm/tick', { tick: 1 })
  await log.close()
  const file = path.join(dir, 'events.jsonl')
  const lines = (await fsp.readFile(file, 'utf8')).trim().split('\n')
  lines[0] = lines[0].replace('original', 'tampered')
  await fsp.writeFile(file, `${lines.join('\n')}\n`, 'utf8')
  const broken = new EventLog({ dir, runId: 'run-3' })
  await assert.rejects(() => broken.open(), (error) => error.code === 'EVENT_LOG_CORRUPT')
})

test('truncated or partial final lines are rejected rather than silently dropped', async (t) => {
  const dir = await tempDir()
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  const log = await new EventLog({ dir, runId: 'run-4' }).open()
  await log.append('swarm/created', { goal: 'g' })
  await log.close()
  await fsp.appendFile(path.join(dir, 'events.jsonl'), '{"seq":2,"type":"brok', 'utf8')
  const broken = new EventLog({ dir, runId: 'run-4' })
  await assert.rejects(() => broken.open(), (error) => error.code === 'EVENT_LOG_CORRUPT')
})

test('snapshot writes are atomic and readable', async (t) => {
  const dir = await tempDir()
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  await writeSnapshot(dir, { status: 'running', events: 3 })
  const raw = JSON.parse(await fsp.readFile(path.join(dir, 'snapshot.json'), 'utf8'))
  assert.equal(raw.status, 'running')
})
