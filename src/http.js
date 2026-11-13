/**
 * Local HTTP surface for the swarm Web panel, CI, and external control.
 *
 * Reads are loopback-only. Writes (intervene/create task/merge) additionally
 * require `http.token`; an empty token disables writes entirely rather than
 * silently allowing them.
 */
import { timingSafeEqual } from 'node:crypto'

export const API_PREFIX = '/swarm/api'

class HttpError extends Error {
  /** @param {number} status @param {string} code @param {string} message */
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

/** @param {string | undefined} address */
function isLoopback(address) {
  if (!address) return false
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

/** @param {string} expected @param {import('node:http').IncomingMessage} req */
function authorized(req, expected) {
  if (!expected) return 'disabled'
  const direct = req.headers['x-swarm-token']
  const bearer = req.headers.authorization
  const supplied =
    typeof direct === 'string'
      ? direct
      : typeof bearer === 'string' && bearer.toLowerCase().startsWith('bearer ')
        ? bearer.slice(7).trim()
        : ''
  if (!supplied) return false
  const left = Buffer.from(supplied)
  const right = Buffer.from(expected)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [maxBytes]
 */
async function readJson(req, maxBytes = 256 * 1024) {
  const contentType = String(req.headers['content-type'] ?? '').toLowerCase()
  if (!contentType.startsWith('application/json')) {
    throw new HttpError(400, 'INVALID_CONTENT_TYPE', 'content-type must be application/json')
  }
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) throw new HttpError(413, 'BODY_TOO_LARGE', 'request body is too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) return {}
  let value
  try {
    value = JSON.parse(text)
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'request body is not valid JSON')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'INVALID_JSON', 'request body must be a JSON object')
  }
  return value
}

/** @param {any} error */
function statusFor(error) {
  if (error instanceof HttpError) return error.status
  const code = String(error?.code ?? '')
  if (code.endsWith('NOT_FOUND')) return 404
  if (
    code === 'RUN_NOT_RUNNING' ||
    code === 'RUN_ENDED' ||
    code.includes('LIMIT') ||
    code.includes('EXCEEDED') ||
    code.includes('CONFLICT') ||
    code.includes('EXPIRED') ||
    code.includes('STALE') ||
    code === 'GATE_FAILED' ||
    code === 'SELF_REVIEW' ||
    code === 'NOT_REVIEWER'
  ) {
    return 409
  }
  if (
    code.startsWith('INVALID') ||
    code.startsWith('TASK_INVALID') ||
    code.startsWith('BOARD_') ||
    code.startsWith('MESSAGE_') ||
    code === 'CONFIG_INVALID' ||
    code === 'PATCH_INVALID'
  ) {
    return 400
  }
  return 500
}

/**
 * @param {import('./service.js').SwarmService} service
 * @param {{ token?: string }} [options]
 */
export function createNodeHandler(service, options = {}) {
  const token = options.token ?? ''
  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  return async function swarmNodeHandler(req, res) {
    try {
      if (!isLoopback(req.socket?.remoteAddress)) {
        sendJson(res, 403, { error: { code: 'LOOPBACK_ONLY', message: 'swarm API is local-only' } })
        return
      }
      const method = (req.method ?? 'GET').toUpperCase()
      const origin = `http://${req.headers.host ?? '127.0.0.1'}`
      const url = new URL(req.url ?? '/', origin)
      const pathname = url.pathname

      if (method === 'POST') {
        if (req.headers.origin && req.headers.origin !== origin) {
          throw new HttpError(403, 'CROSS_ORIGIN', 'cross-origin writes are not allowed')
        }
        if (authorized(req, token) !== true) {
          throw token
            ? new HttpError(401, 'UNAUTHORIZED', 'missing or invalid swarm API token')
            : new HttpError(403, 'WRITE_DISABLED', 'write API is disabled; configure http.token')
        }
        const body = await readJson(req)
        const writeMatch = /^\/swarm\/api\/runs\/([A-Za-z0-9_-]+)\/(intervene|tasks|merge)$/.exec(pathname)
        if (!writeMatch) throw new HttpError(404, 'NOT_FOUND', `no write route ${pathname}`)
        const runId = writeMatch[1]
        const action = writeMatch[2]
        let result
        if (action === 'intervene') {
          result = await service.intervene(runId, body)
        } else if (action === 'tasks') {
          result = await service.createTask(runId, body)
        } else {
          if (!body.patchId) throw new HttpError(400, 'INVALID_BODY', 'merge requires patchId')
          result = await service.mergePatch(runId, body.patchId, body)
        }
        sendJson(res, 200, result)
        return
      }

      if (method !== 'GET' && method !== 'HEAD') {
        sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'use GET or POST' } })
        return
      }

      if (pathname === `${API_PREFIX}/health`) {
        sendJson(res, 200, { ok: true, runs: service.runs.size, baseDir: service.baseDir })
        return
      }
      if (pathname === `${API_PREFIX}/runs`) {
        const runs = [...service.runs.values()].map((run) => ({
          swarmId: run.id,
          goal: run.state.goal,
          status: run.state.status,
          tasks: run.state.tasks.size,
          members: run.state.members.size,
          createdAt: run.state.createdAt,
          updatedAt: run.state.updatedAt,
        }))
        sendJson(res, 200, { runs })
        return
      }
      const reportMatch = /^\/swarm\/api\/runs\/([A-Za-z0-9_-]+)\/report\.csv$/.exec(pathname)
      if (reportMatch) {
        const report = service.costReport(reportMatch[1])
        const body = Buffer.from(report.csv, 'utf8')
        res.writeHead(200, {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="${report.filename}"`,
          'cache-control': 'no-store',
          'content-length': body.byteLength,
        })
        res.end(body)
        return
      }
      const match = /^\/swarm\/api\/runs\/([A-Za-z0-9_-]+)(\/events)?$/.exec(pathname)
      if (!match) {
        sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `no route ${pathname}` } })
        return
      }
      const runId = match[1]
      if (match[2]) {
        const events = service.events(runId, {
          since: Number(url.searchParams.get('since') ?? 0),
          limit: Number(url.searchParams.get('limit') ?? 200),
        })
        sendJson(res, 200, { runId, events })
        return
      }
      const detail = url.searchParams.get('detail') !== 'false'
      sendJson(res, 200, service.snapshot(runId, detail))
    } catch (error) {
      const status = statusFor(error)
      if (status >= 500) service.logger?.error?.(`[swarm] http failed: ${String(error?.stack ?? error)}`)
      sendJson(res, status, {
        error: { code: String(error?.code ?? 'INTERNAL'), message: String(error?.message ?? error) },
      })
    }
  }
}
