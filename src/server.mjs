import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import { WebSocketServer } from 'ws'
import { Store } from './store.mjs'
import { isContactId, validateContactId } from './contact-id.mjs'
import { LIMIT, originOf, idPattern, hashPattern, decodeFrame, bytesOf, headersOf, wire, sameSession, readLimited } from '@talk2myagent/a2a-relay-protocol'

const fail = (status, message) => Object.assign(new Error(message), { status })
function json(res, status, body) {
  if (res.destroyed || res.writableEnded) return
  if (res.headersSent) { res.destroy(); return }
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body))
}
export function createRelay({ origin, database = ':memory:', store: suppliedStore, allowHttp = false, registrationEnabled = true,
  maxRegistrations = 10000, maxConcurrent = 64, registrationPerHour = 20, requestsPerMinute = 120, trustedProxyIPs = [],
  cluster, requestTimeout = LIMIT.total, connectionMaxAge = 0, trustedVercelProxy = false } = {}) {
  const canonical = originOf(origin, allowHttp)
  const store = suppliedStore ?? new Store(database, maxRegistrations)
  const sessions = new Map(), rates = new Map()
  const upgrades = new Map(), pending = new Set(), upgradeSockets = new Set()
  let active = 0, closing = false, closePromise, heartbeatWork
  for (const n of [maxRegistrations, maxConcurrent, registrationPerHour, requestsPerMinute]) if (!Number.isSafeInteger(n) || n < 1) throw new Error('Relay limits must be positive integers')
  if (!Number.isSafeInteger(requestTimeout) || requestTimeout < 1000 || requestTimeout > LIMIT.total ||
      !Number.isSafeInteger(connectionMaxAge) || connectionMaxAge < 0 || connectionMaxAge > 0 && connectionMaxAge < 1000) throw new Error('Invalid relay lifecycle limits')
  const clientIP = req => {
    const remote = req.socket.remoteAddress ?? 'unknown', forwarded = req.headers['x-forwarded-for']
    if (trustedVercelProxy) {
      const verified = req.headers['x-vercel-forwarded-for']
      if (typeof verified !== 'string' || !isIP(verified)) throw fail(400, 'Missing verified client address')
      return verified
    }
    return trustedProxyIPs.includes(remote) && typeof forwarded === 'string' && isIP(forwarded) ? forwarded : remote
  }
  const rate = (ip, kind, max, period) => {
    if (cluster) return cluster.rate(ip, kind, max, period)
    const key = `${kind}:${ip}`, now = Date.now()
    let r = rates.get(key)
    if (!r || r.until <= now) { if (rates.size >= 10000 && !r) throw fail(429, 'Rate capacity reached'); r = { count: 0, until: now + period }; rates.set(key, r) }
    if (++r.count > max) throw fail(429, 'Rate limit exceeded')
  }
  const publicInfo = row => ({ publicationId: row.publicationId, deviceId: row.deviceId, contactId: row.contactId,
    publicRpcUrl: `${canonical}/r/${row.publicationId}/a2a`, publicCardUrl: `${canonical}/r/${row.publicationId}/.well-known/agent-card.json`,
    contactRpcUrl: `${canonical}/r/${row.contactId}/a2a`, contactCardUrl: `${canonical}/r/${row.contactId}/.well-known/agent-card.json`,
    connectUrl: `${canonical.replace(/^http/, 'ws')}/v1/connect`, enabled: !!row.enabled, revision: row.revision })
  const drop = (s, reason) => {
    if (sessions.get(s.publicationId) === s) sessions.delete(s.publicationId)
    if (cluster) void cluster.release(s)
    clearTimeout(s.lifetime)
    for (const f of [...s.flows.values()]) f.finish(502, reason)
    s.ws.terminate()
  }
  if (cluster) {
    cluster.dispatch = (req, res, context, accepted) => dispatchLocal(req, res, context.publicationId, context.route, context, accepted)
    cluster.on('unavailable', () => { for (const s of [...sessions.values()]) drop(s, 'Coordination interrupted; delivery may be unknown') })
    cluster.on('invalidate', context => {
      const s = sessions.get(context.publicationId)
      if (s && sameSession(context, s)) drop(s, 'Publication changed; delivery may be unknown')
    })
  }
  const server = createServer({ maxHeaderSize: LIMIT.headers, requestTimeout: 15000 }, (req, res) => {
    const op = handle(req, res); pending.add(op)
    void op.catch(error => json(res, error.status ?? (error instanceof SyntaxError ? 400 : 502), { error: error.status ? error.message : error instanceof SyntaxError ? 'Invalid JSON' : 'Relay transport failed; delivery may be unknown', ...(error.code?.startsWith('CONTACT_ID_') ? { code: error.code } : {}) })).finally(()=>pending.delete(op))
  })
  server.on('clientError', (_err, socket) => { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n') })
  async function handle(req, res) {
    const path = new URL(req.url, canonical).pathname
    if (req.url.includes('?')) throw fail(404, 'Unknown route')
    // Orchestrator probes must not share client rate buckets: traffic spikes
    // must never turn a healthy process into a restart loop.
    if (path === '/health' && req.method === 'GET') { json(res, 200, { ok: true }); return }
    if (closing) throw fail(503,'Relay stopping')
    if (path === '/ready' && req.method === 'GET') {
      try { await store.health(); if (cluster) await cluster.health(); json(res,200,{ok:true}) } catch { json(res,503,{ok:false}) }
      return
    }
    const ip = clientIP(req) // A trusted proxy must overwrite X-Forwarded-For with a single address.
    await rate(ip, 'http', requestsPerMinute, 60000)
    if (path === '/v1/agents/register' && req.method === 'POST') {
      if (!registrationEnabled) throw fail(403, 'Registration disabled')
      await rate(ip, 'register', registrationPerHour, 3600000)
      const body = JSON.parse((await readLimited(req, 4096)).toString())
      validateContactId(body?.contactId)
      if (typeof body?.registrationId !== 'string' || typeof body.deviceTokenHash !== 'string' || !idPattern.test(body.registrationId) || !hashPattern.test(body.deviceTokenHash) ||
          typeof body.displayName !== 'string' || body.displayName.length > 128 || body.protocolVersion !== '1.0') throw fail(400, 'Invalid registration')
      json(res, 200, publicInfo(await store.register(body))); return
    }
    if (path === '/v1/publication' || path === '/v1/publication/enabled') {
      let row = await store.authenticate(req.headers.authorization)
      if (path === '/v1/publication' && req.method === 'GET') {
        json(res, 200, { ...publicInfo(row), online: cluster ? await cluster.online(row) : sessions.get(row.publicationId)?.ready === true }); return
      }
      if (path === '/v1/publication/enabled' && req.method === 'PUT') {
        const body = JSON.parse((await readLimited(req, 4096)).toString())
        if (typeof body?.enabled !== 'boolean' || !Number.isSafeInteger(body.revision) || body.revision < 1 || typeof body.operationId !== 'string' || !idPattern.test(body.operationId)) throw fail(400, 'Invalid intent')
        // Re-read after awaiting input: revocation and newer intents may have arrived.
        row = await store.intent(await store.authenticate(req.headers.authorization), body.enabled, body.revision, body.operationId)
        const s = sessions.get(row.publicationId)
        if (!row.enabled && s) drop(s, 'Publication disabled; delivery may be unknown')
        if (!row.enabled && cluster) await cluster.invalidate(row.publicationId)
        json(res, 200, publicInfo(row)); return
      }
      throw fail(405, 'Method not allowed')
    }
    const match = /^\/r\/([a-zA-Z0-9_-]{16,80}|1[3-9]\d{9})\/(a2a|\.well-known\/agent-card\.json)$/.exec(path)
    if (!match) throw fail(404, 'Unknown route')
    const route = match[2] === 'a2a' ? 'rpc' : 'card'
    if (req.method !== (route === 'rpc' ? 'POST' : 'GET')) throw fail(405, 'Method not allowed')
    const publicationId = isContactId(match[1]) ? (await store.getByContactId(match[1]))?.publicationId : match[1]
    if (!publicationId) throw fail(503, 'Agent offline')
    if (cluster) { await cluster.forward(req, res, publicationId, route); return }
    await dispatchLocal(req, res, publicationId, route)
  }
  async function dispatchLocal(req, res, publicationId, route, expected, accepted) {
    const row = await store.get(publicationId), s = sessions.get(publicationId)
    if (closing || res.destroyed) return
    if (!row || row.blocked || !row.enabled || row.expiresAt && row.expiresAt <= Date.now() || !s?.ready ||
        row.generation !== s.generation || expected && !sameSession(expected, s)) throw fail(503, 'Agent offline')
    if (active >= maxConcurrent || s.flows.size >= LIMIT.concurrent) throw fail(429, 'Agent busy')
    if (Number(req.headers['content-length'] ?? 0) > LIMIT.body) throw fail(413, 'Body too large')
    const headers = headersOf(req.headers), requestId = expected?.requestId ?? randomUUID()
    const remaining = connectionMaxAge ? connectionMaxAge - (Date.now() - s.createdAt) - 250 : requestTimeout
    if (remaining <= 250) throw fail(503, 'Connector rotating; request was not dispatched')
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
    f.deadline = setTimeout(() => { f.finish(504, 'Relay lifetime exceeded; delivery may be unknown'); sendAbort(s, requestId) }, Math.min(requestTimeout, remaining))
    f.touch(15000)
    res.once('close', () => { if (!f.done) { f.finish(); sendAbort(s, requestId) } })
    try {
      if (accepted) await accepted()
      const body = await readLimited(req)
      if (route === 'card' && body.length) throw fail(400, 'Card GET must not have a body')
      if (f.done || sessions.get(row.publicationId) !== s || !s.ready) throw fail(503, 'Agent disconnected before dispatch')
      // Input can arrive after a cross-instance disable/replacement. Validate
      // again immediately before dispatch, including the shared ownership lease.
      const current = await store.get(row.publicationId)
      if (!current || !current.enabled || current.blocked || current.generation !== s.generation || current.expiresAt && current.expiresAt <= Date.now()) throw fail(503, 'Publication changed before dispatch')
      if (cluster) await cluster.refresh(s)
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
    upgradeSockets.add(socket)
    const op = upgrade(req,socket,head); pending.add(op)
    void op.catch(error=>{if(!socket.destroyed)socket.end(`HTTP/1.1 ${error.status ?? 400} Rejected\r\nConnection: close\r\n\r\n`)}).finally(()=>{pending.delete(op);upgradeSockets.delete(socket)})
  })
  async function upgrade(req,socket,head) {
    // Socket can fail while awaiting database authentication.
    const ignoreSocketError=()=>{}; socket.on('error',ignoreSocketError)
    try {
      if (closing) throw fail(503,'Relay stopping')
      if (req.url !== '/v1/connect' || req.headers.origin) throw fail(403, 'Invalid connector handshake')
      await rate(clientIP(req), 'connect', 120, 60000)
      if (cluster) await cluster.health()
      const identity = await store.authenticate(req.headers.authorization)
      // Serialize same-device handshakes, including async generation updates.
      const prior=upgrades.get(identity.publicationId)??Promise.resolve()
      const connection=prior.catch(()=>{}).then(async()=>{
      if (closing || socket.destroyed) return
      const row=await store.authenticate(req.headers.authorization)
      if (!row.enabled) throw fail(403,'Publication disabled')
      const generation=await store.generation(row.publicationId)
      if (closing || socket.destroyed) return
      wss.handleUpgrade(req, socket, head, ws => {
        const previous = sessions.get(row.publicationId)
        if (previous) drop(previous, 'Connector replaced; delivery may be unknown')
        const s = { ws, publicationId: row.publicationId, connectionId: randomUUID(), generation,
          ready: false, flows: new Map(), lastPong: Date.now(), createdAt: Date.now() }
        sessions.set(row.publicationId, s)
        if (connectionMaxAge) s.lifetime = setTimeout(() => drop(s, 'Connector lifetime exceeded; delivery may be unknown'), connectionMaxAge)
        ws.on('pong', () => { s.lastPong = Date.now() })
        ws.on('error', () => drop(s, 'Tunnel failed; delivery may be unknown'))
        ws.on('close', () => drop(s, 'Tunnel disconnected; delivery may be unknown'))
        ws.on('message', (raw, binary) => {
          try {
            if (binary) throw new Error('JSON frames required')
            const m = decodeFrame(raw)
            if (sessions.get(s.publicationId) !== s || !sameSession(m, s)) return
            if (m.type === 'ready') {
              if (s.ready || s.readyPending) throw new Error('Not available')
              s.readyPending=true
              const ready=(async()=>{
                const fresh=await store.get(s.publicationId)
                if(closing || sessions.get(s.publicationId)!==s || ws.readyState!==1) return
                if(!fresh || !fresh.enabled || fresh.blocked || fresh.generation!==s.generation || fresh.expiresAt && fresh.expiresAt<=Date.now()) throw new Error('Not available')
                if (cluster) await cluster.claim(s)
                if (closing || sessions.get(s.publicationId)!==s || ws.readyState!==1) { if (cluster) await cluster.release(s); return }
                s.ready=true; await wire(ws,s,{type:'ready_ack'})
              })()
              pending.add(ready)
              void ready.catch(()=>drop(s,'Handshake failed')).finally(()=>pending.delete(ready)); return
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
      })
      upgrades.set(identity.publicationId,connection)
      try { await connection } finally { if(upgrades.get(identity.publicationId)===connection)upgrades.delete(identity.publicationId) }
    } finally {
      // Keep the guard for rejected/aborted upgrades until the socket closes.
      // Removing it before socket.end() can turn a client reset into a process error.
      socket.once('close',()=>socket.removeListener('error',ignoreSocketError))
    }
  }
  async function heartbeat() {
    const snapshot=[...sessions.values()]
    if(!snapshot.length) return
    try {
      const rows=new Map((await store.getMany(snapshot.map(s=>s.publicationId))).map(row=>[row.publicationId,row]))
      if(closing) return
      const now=Date.now()
      for(const s of snapshot) {
        if(sessions.get(s.publicationId)!==s) continue
        const row=rows.get(s.publicationId)
        if(now-s.lastPong>LIMIT.idle || !s.ready&&now-s.createdAt>LIMIT.idle || !row || !row.enabled || row.blocked || row.generation!==s.generation || row.expiresAt&&row.expiresAt<=now) drop(s,'Tunnel expired')
        else if (connectionMaxAge && !s.flows.size && now - s.createdAt >= Math.max(1000, connectionMaxAge * 0.8)) drop(s, 'Idle connector rotation')
        else { if (cluster && s.ready) await cluster.refresh(s); s.ws.ping() }
      }
    } catch { for(const s of snapshot) if(sessions.get(s.publicationId)===s)drop(s,'Database unavailable; delivery may be unknown') }
  }
  const timer = setInterval(() => {
    const now = Date.now()
    for (const [key, r] of rates) if (r.until < now) rates.delete(key)
    if(!closing&&!heartbeatWork)heartbeatWork=heartbeat().finally(()=>{heartbeatWork=undefined})
  }, LIMIT.heartbeat); timer.unref()
  return { server, store, sessions, get active() { return active },
    async revoke(id) { await store.revoke(id); const s = sessions.get(id); if (s) drop(s, 'Publication revoked'); if (cluster) await cluster.invalidate(id) },
    close() { return closePromise??=(async()=>{
      closing=true; clearInterval(timer); for(const s of sessions.values())drop(s,'Relay stopping')
      for(const socket of upgradeSockets)socket.destroy()
      wss.close(); const stopped=new Promise(resolve=>server.close(resolve)); server.closeAllConnections()
      await Promise.allSettled([...pending,...upgrades.values(),...(heartbeatWork?[heartbeatWork]:[])])
      await stopped; if (cluster) await cluster.close(); await store.close()
    })() },
  }
}
