import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import { WebSocketServer } from 'ws'
import { Store } from './store.mjs'
import { LIMIT, originOf, idPattern, hashPattern, decodeFrame, bytesOf, headersOf, wire, sameSession, readLimited } from '@talk2myagent/a2a-relay-protocol'

const fail = (status, message) => Object.assign(new Error(message), { status })
function json(res, status, body) {
  if (res.destroyed || res.writableEnded) return
  if (res.headersSent) { res.destroy(); return }
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body))
}
export function createRelay({ origin, database = ':memory:', allowHttp = false, registrationEnabled = true,
  maxRegistrations = 10000, maxConcurrent = 64, registrationPerHour = 20, requestsPerMinute = 120, trustedProxyIPs = [] } = {}) {
  const canonical = originOf(origin, allowHttp)
  const store = new Store(database, maxRegistrations)
  const sessions = new Map(), rates = new Map()
  let active = 0
  for (const n of [maxRegistrations, maxConcurrent, registrationPerHour, requestsPerMinute]) if (!Number.isSafeInteger(n) || n < 1) throw new Error('Relay limits must be positive integers')
  const clientIP = req => {
    const remote = req.socket.remoteAddress ?? 'unknown', forwarded = req.headers['x-forwarded-for']
    return trustedProxyIPs.includes(remote) && typeof forwarded === 'string' && isIP(forwarded) ? forwarded : remote
  }
  const rate = (ip, kind, max, period) => {
    const key = `${kind}:${ip}`, now = Date.now()
    let r = rates.get(key)
    if (!r || r.until <= now) { if (rates.size >= 10000 && !r) throw fail(429, 'Rate capacity reached'); r = { count: 0, until: now + period }; rates.set(key, r) }
    if (++r.count > max) throw fail(429, 'Rate limit exceeded')
  }
  const publicInfo = row => ({ publicationId: row.publicationId, deviceId: row.deviceId,
    publicRpcUrl: `${canonical}/r/${row.publicationId}/a2a`, publicCardUrl: `${canonical}/r/${row.publicationId}/.well-known/agent-card.json`,
    connectUrl: `${canonical.replace(/^http/, 'ws')}/v1/connect`, enabled: !!row.enabled, revision: row.revision })
  const drop = (s, reason) => {
    if (sessions.get(s.publicationId) === s) sessions.delete(s.publicationId)
    for (const f of [...s.flows.values()]) f.finish(502, reason)
    s.ws.terminate()
  }
  const server = createServer({ maxHeaderSize: LIMIT.headers, requestTimeout: 15000 }, (req, res) => {
    void handle(req, res).catch(error => json(res, error.status ?? (error instanceof SyntaxError ? 400 : 502), { error: error.status ? error.message : error instanceof SyntaxError ? 'Invalid JSON' : 'Relay transport failed; delivery may be unknown' }))
  })
  server.on('clientError', (_err, socket) => { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n') })
  async function handle(req, res) {
    const path = new URL(req.url, canonical).pathname
    if (req.url.includes('?')) throw fail(404, 'Unknown route')
    const ip = clientIP(req) // A trusted proxy must overwrite X-Forwarded-For with a single address.
    rate(ip, 'http', requestsPerMinute, 60000)
    if (path === '/health' && req.method === 'GET') { json(res, 200, { ok: true }); return }
    if (path === '/v1/agents/register' && req.method === 'POST') {
      if (!registrationEnabled) throw fail(403, 'Registration disabled')
      rate(ip, 'register', registrationPerHour, 3600000)
      const body = JSON.parse((await readLimited(req, 4096)).toString())
      if (typeof body?.registrationId !== 'string' || typeof body.deviceTokenHash !== 'string' || !idPattern.test(body.registrationId) || !hashPattern.test(body.deviceTokenHash) ||
          typeof body.displayName !== 'string' || body.displayName.length > 128 || body.protocolVersion !== '1.0') throw fail(400, 'Invalid registration')
      json(res, 200, publicInfo(store.register(body))); return
    }
    if (path === '/v1/publication' || path === '/v1/publication/enabled') {
      let row = store.authenticate(req.headers.authorization)
      if (path === '/v1/publication' && req.method === 'GET') {
        json(res, 200, { ...publicInfo(row), online: sessions.get(row.publicationId)?.ready === true }); return
      }
      if (path === '/v1/publication/enabled' && req.method === 'PUT') {
        const body = JSON.parse((await readLimited(req, 4096)).toString())
        if (typeof body?.enabled !== 'boolean' || !Number.isSafeInteger(body.revision) || body.revision < 1 || typeof body.operationId !== 'string' || !idPattern.test(body.operationId)) throw fail(400, 'Invalid intent')
        // Re-read after awaiting input: revocation and newer intents may have arrived.
        row = store.intent(store.authenticate(req.headers.authorization), body.enabled, body.revision, body.operationId)
        const s = sessions.get(row.publicationId)
        if (!row.enabled && s) drop(s, 'Publication disabled; delivery may be unknown')
        json(res, 200, publicInfo(row)); return
      }
      throw fail(405, 'Method not allowed')
    }
    const match = /^\/r\/([a-zA-Z0-9_-]{16,80})\/(a2a|\.well-known\/agent-card\.json)$/.exec(path)
    if (!match) throw fail(404, 'Unknown route')
    const route = match[2] === 'a2a' ? 'rpc' : 'card'
    if (req.method !== (route === 'rpc' ? 'POST' : 'GET')) throw fail(405, 'Method not allowed')
    const row = store.get(match[1]), s = sessions.get(match[1])
    if (!row || row.blocked || !row.enabled || row.expiresAt && row.expiresAt <= Date.now() || !s?.ready) throw fail(503, 'Agent offline')
    if (active >= maxConcurrent || s.flows.size >= LIMIT.concurrent) throw fail(429, 'Agent busy')
    if (Number(req.headers['content-length'] ?? 0) > LIMIT.body) throw fail(413, 'Body too large')
    const headers = headersOf(req.headers), requestId = randomUUID()
    const f = { res, received: 0, consumed: 0, seq: 0, started: false, done: false,
      finish(status, message) {
        if (f.done) return; f.done = true; clearTimeout(f.timer); clearTimeout(f.deadline)
        s.flows.delete(requestId); active--
        if (status) {
          if (!req.complete) res.once('finish', () => req.destroy())
          json(res, status, { error: message })
        }
      },
      touch(ms = LIMIT.idle) { clearTimeout(f.timer); f.timer = setTimeout(() => {
        f.finish(504, 'Relay timeout; delivery may be unknown'); sendAbort(s, requestId)
      }, ms) },
    }
    active++; s.flows.set(requestId, f)
    f.deadline = setTimeout(() => { f.finish(504, 'Relay lifetime exceeded'); sendAbort(s, requestId) }, LIMIT.total)
    f.touch(15000)
    res.once('close', () => { if (!f.done) { f.finish(); sendAbort(s, requestId) } })
    try {
      const body = await readLimited(req)
      if (route === 'card' && body.length) throw fail(400, 'Card GET must not have a body')
      if (f.done || sessions.get(row.publicationId) !== s || !s.ready) throw fail(503, 'Agent disconnected before dispatch')
      f.touch(LIMIT.first)
      await wire(s.ws, s, { type: 'request_begin', requestId, route, headers, length: body.length })
      let seq = 0
      for (let offset = 0; offset < body.length; offset += LIMIT.chunk) await wire(s.ws, s, { type: 'request_data', requestId, seq: seq++, data: body.subarray(offset, offset + LIMIT.chunk).toString('base64') })
      await wire(s.ws, s, { type: 'request_end', requestId, seq })
    } catch (error) { f.finish(error.status ?? 502, error.status ? error.message : 'Tunnel failed; delivery may be unknown'); sendAbort(s, requestId) }
  }
  function sendAbort(s, requestId) { void wire(s.ws, s, { type: 'abort', requestId }).catch(() => {}) }
  const wss = new WebSocketServer({ noServer: true, maxPayload: LIMIT.frame, perMessageDeflate: false })
  server.on('upgrade', (req, socket, head) => {
    try {
      if (req.url !== '/v1/connect' || req.headers.origin) throw fail(403, 'Invalid connector handshake')
      rate(clientIP(req), 'connect', 120, 60000)
      const row = store.authenticate(req.headers.authorization)
      if (!row.enabled) throw fail(403, 'Publication disabled')
      wss.handleUpgrade(req, socket, head, ws => {
        const previous = sessions.get(row.publicationId)
        if (previous) drop(previous, 'Connector replaced; delivery may be unknown')
        const s = { ws, publicationId: row.publicationId, connectionId: randomUUID(), generation: store.generation(row.publicationId),
          ready: false, flows: new Map(), lastPong: Date.now(), createdAt: Date.now() }
        sessions.set(row.publicationId, s)
        ws.on('pong', () => { s.lastPong = Date.now() })
        ws.on('error', () => drop(s, 'Tunnel failed; delivery may be unknown'))
        ws.on('close', () => drop(s, 'Tunnel disconnected; delivery may be unknown'))
        ws.on('message', (raw, binary) => {
          try {
            if (binary) throw new Error('JSON frames required')
            const m = decodeFrame(raw)
            if (sessions.get(s.publicationId) !== s || !sameSession(m, s)) return
            if (m.type === 'ready') {
              const fresh = store.get(s.publicationId)
              if (s.ready || !fresh.enabled || fresh.blocked || fresh.expiresAt && fresh.expiresAt <= Date.now()) throw new Error('Not available')
              s.ready = true
              void wire(ws, s, { type: 'ready_ack' }).catch(() => drop(s, 'Handshake failed')); return
            }
            if (!s.ready) throw new Error('Not ready')
            const f = s.flows.get(m.requestId)
            if (!f) return // Late frames after abort never attach to another request.
            f.touch()
            if (m.type === 'abort') { f.finish(502, 'Local transport failed; delivery may be unknown'); return }
            if (m.type === 'response_begin') {
              if (f.started || !Number.isInteger(m.status) || m.status < 200 || m.status > 599 || m.status >= 300 && m.status < 400) throw new Error('Invalid response')
              f.started = true; f.res.writeHead(m.status, { ...headersOf(m.headers, true), 'x-accel-buffering': 'no' }); f.res.flushHeaders(); return
            }
            if (m.type === 'response_data') {
              const bytes = bytesOf(m)
              if (!f.started || m.seq !== f.seq++ || f.received + bytes.length - f.consumed > LIMIT.window) throw new Error('Response flow violation')
              f.received += bytes.length
              f.res.write(bytes, error => {
                if (error || f.done) return
                f.consumed += bytes.length
                void wire(ws, s, { type: 'credit', requestId: m.requestId, consumed: f.consumed }).catch(() => drop(s, 'Tunnel congested'))
              }); return
            }
            if (m.type === 'response_end') {
              if (!f.started || m.seq !== f.seq) throw new Error('Invalid response end')
              f.res.end(); f.finish(); return
            }
            throw new Error('Unexpected frame')
          } catch { drop(s, 'Tunnel protocol violation') }
        })
        void wire(ws, s, { type: 'hello' }).catch(() => drop(s, 'Handshake failed'))
      })
    } catch (error) { socket.end(`HTTP/1.1 ${error.status ?? 400} Rejected\r\nConnection: close\r\n\r\n`) }
  })
  const timer = setInterval(() => {
    const now = Date.now()
    for (const [key, r] of rates) if (r.until < now) rates.delete(key)
    for (const s of sessions.values()) {
      const row = store.get(s.publicationId)
      if (now - s.lastPong > LIMIT.idle || !s.ready && now - s.createdAt > LIMIT.idle || !row.enabled || row.blocked || row.expiresAt && row.expiresAt <= now) drop(s, 'Tunnel expired')
      else s.ws.ping()
    }
  }, LIMIT.heartbeat); timer.unref()
  return { server, store, sessions, get active() { return active },
    revoke(id) { store.revoke(id); const s = sessions.get(id); if (s) drop(s, 'Publication revoked') },
    async close() { clearInterval(timer); for (const s of sessions.values()) drop(s, 'Relay stopping'); wss.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close() },
  }
}
