import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'
import { createNodeHandler } from '../src/http.js'

function responseRecorder() {
  const captured = { status: 0, headers: null, body: '' }
  return {
    captured,
    writeHead(status, headers) {
      captured.status = status
      captured.headers = headers
    },
    end(body) {
      captured.body = Buffer.isBuffer(body) ? body.toString('utf8') : String(body ?? '')
    },
  }
}

test('the local API serves the cost report as a CSV attachment', async () => {
  const service = {
    runs: new Map(),
    logger: {},
    costReport(runId) {
      assert.equal(runId, 'swarm_1')
      return { filename: 'swarm_1-cost.csv', csv: 'scope,key,tokens\nrun,run,10\n' }
    },
  }
  const handler = createNodeHandler(service)
  const request = {
    method: 'GET',
    url: '/swarm/api/runs/swarm_1/report.csv',
    headers: { host: '127.0.0.1' },
    socket: { remoteAddress: '127.0.0.1' },
  }
  const response = responseRecorder()
  await handler(request, response)
  assert.equal(response.captured.status, 200)
  assert.match(response.captured.headers['content-type'], /text\/csv/)
  assert.match(response.captured.headers['content-disposition'], /swarm_1-cost\.csv/)
  assert.match(response.captured.body, /^scope,key,tokens/)
})

test('the local API serves event pages for the timeline', async () => {
  const service = {
    runs: new Map(),
    logger: {},
    events(runId, options) {
      assert.equal(runId, 'swarm_1')
      assert.equal(options.limit, 10)
      return [{ seq: 1, type: 'swarm/created' }]
    },
  }
  const handler = createNodeHandler(service)
  const response = responseRecorder()
  await handler(
    {
      method: 'GET',
      url: '/swarm/api/runs/swarm_1/events?limit=10',
      headers: { host: '127.0.0.1' },
      socket: { remoteAddress: '127.0.0.1' },
    },
    response,
  )
  assert.equal(response.captured.status, 200)
  assert.equal(JSON.parse(response.captured.body).events.length, 1)
})

function postRequest(url, body, headers = {}) {
  const stream = Readable.from([Buffer.from(JSON.stringify(body))])
  stream.method = 'POST'
  stream.url = url
  stream.headers = { host: '127.0.0.1', 'content-type': 'application/json', ...headers }
  stream.socket = { remoteAddress: '127.0.0.1' }
  return stream
}

test('write endpoints require the configured token', async () => {
  const service = {
    runs: new Map(),
    logger: {},
    async intervene(runId, body) {
      assert.equal(runId, 'swarm_1')
      assert.equal(body.action, 'pause')
      return { status: 'paused' }
    },
  }
  const handler = createNodeHandler(service, { token: 'secret-token' })

  const denied = responseRecorder()
  await handler(postRequest('/swarm/api/runs/swarm_1/intervene', { action: 'pause' }), denied)
  assert.equal(denied.captured.status, 401)

  const accepted = responseRecorder()
  await handler(
    postRequest(
      '/swarm/api/runs/swarm_1/intervene',
      { action: 'pause' },
      { 'x-swarm-token': 'secret-token' },
    ),
    accepted,
  )
  assert.equal(accepted.captured.status, 200)
  assert.equal(JSON.parse(accepted.captured.body).status, 'paused')
})

test('writes are disabled when no token is configured', async () => {
  const handler = createNodeHandler({ runs: new Map(), logger: {}, async intervene() {} })
  const response = responseRecorder()
  await handler(postRequest('/swarm/api/runs/swarm_1/intervene', { action: 'pause' }), response)
  assert.equal(response.captured.status, 403)
  assert.equal(JSON.parse(response.captured.body).error.code, 'WRITE_DISABLED')
})

test('the local API rejects non-loopback peers', async () => {  const handler = createNodeHandler({ runs: new Map(), logger: {} })
  const response = responseRecorder()
  await handler(
    {
      method: 'GET',
      url: '/swarm/api/health',
      headers: { host: 'example.test' },
      socket: { remoteAddress: '10.0.0.5' },
    },
    response,
  )
  assert.equal(response.captured.status, 403)
})
