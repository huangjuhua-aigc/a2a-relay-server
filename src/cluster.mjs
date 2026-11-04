import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { LIMIT, idPattern, bytesOf, headersOf, readLimited } from '@talk2myagent/a2a-relay-protocol'

const fail = (status, message) => Object.assign(new Error(message), { status })
const validRow = row => row && row.enabled && !row.blocked && (!row.expiresAt || row.expiresAt > Date.now())
const contextOf = (owner, requestId) => ({ publicationId: owner.publicationId, connectionId: owner.connectionId, generation: owner.generation, requestId })
const matches = (a, b) => a.publicationId === b.publicationId && a.connectionId === b.connectionId && a.generation === b.generation && a.requestId === b.requestId
function respond(res, status, message) {
  if (res.destroyed || res.writableEnded) return
  if (res.headersSent) { res.destroy(); return }
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify({ error: message }))
}
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  promise.catch(() => {})
  return { promise, resolve, reject }
}

// An HTTP response sink for the connector-owning process. Its write callback
// waits for the gateway's actual HTTP write callback. The existing Connector
// credit window therefore remains end-to-end, including the Redis hop.
class RemoteResponse extends Writable {
  constructor(send) {
    super({ highWaterMark: LIMIT.chunk })
    this.send = send
    this.headersSent = false
    this.statusCode = 200
    this.headers = {}
    this.seq = 0
    this.sent = 0
    this.consumed = 0
    this.on('error', () => {})
  }
  writeHead(status, headers) { this.statusCode = status; this.headers = headersOf(headers, true); return this }
  flushHeaders() { void this.begin().catch(error => this.destroy(error)) }
  begin() {
    if (!this.beginPromise) {
      this.headersSent = true
      this.beginPromise = this.send({ kind: 'response_begin', status: this.statusCode, headers: this.headers })
    }
    return this.beginPromise
  }
  _write(bytes, _encoding, callback) {
    if (bytes.length > LIMIT.chunk) { callback(new Error('Coordinator response chunk too large')); return }
    this.sent += bytes.length
    this.waiting = { end: this.sent, callback }
    void this.begin().then(() => this.send({ kind: 'response_data', seq: this.seq++, data: bytes.toString('base64') }))
      .catch(error => this.destroy(error))
  }
  credit(consumed) {
    if (!Number.isSafeInteger(consumed) || consumed < this.consumed || consumed > this.sent) throw new Error('Invalid response credit')
    this.consumed = consumed
    if (this.waiting && consumed >= this.waiting.end) {
      const { callback } = this.waiting
      this.waiting = undefined
      callback()
    }
  }
  _final(callback) { void this.begin().then(() => this.send({ kind: 'response_end', seq: this.seq })).then(() => callback(), callback) }
  _destroy(error, callback) {
    if (this.waiting) { const waiting = this.waiting; this.waiting = undefined; waiting.callback(error ?? new Error('Response closed')) }
    if (!this.writableFinished) void this.send({ kind: 'failed' }).catch(() => {})
    callback(error)
  }
}

export class ClusterForwarder extends EventEmitter {
  constructor({ bus, store, maxConcurrent = 64, requestTimeout = LIMIT.total }) {
    super()
    if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || !Number.isSafeInteger(requestTimeout) || requestTimeout < 1000 || requestTimeout > LIMIT.total) throw new Error('Invalid cluster limits')
    this.bus = bus; this.store = store; this.maxConcurrent = maxConcurrent; this.requestTimeout = requestTimeout
    this.outgoing = new Map(); this.incoming = new Map(); this.work = new Set()
    this.onMessage = message => { void this.track(this.receive(message)).catch(() => {}) }
    this.onUnavailable = () => {
      for (const f of [...this.outgoing.values()]) f.finish(503, 'Relay coordination interrupted; delivery may be unknown')
      for (const f of [...this.incoming.values()]) this.abortIncoming(f)
      this.emit('unavailable')
    }
    bus.on('message', this.onMessage)
    bus.on('unavailable', this.onUnavailable)
    this.ownerTimer = setInterval(() => {
      if (this.closed || this.ownerCheck || !this.outgoing.size) return
      this.ownerCheck = this.track(this.checkOwners()).finally(() => { this.ownerCheck = undefined })
      this.ownerCheck.catch(() => {})
    }, 5000)
    this.ownerTimer.unref()
  }
  track(promise) {
    this.work.add(promise)
    void promise.finally(() => this.work.delete(promise)).catch(() => {})
    return promise
  }
  async health() { return this.bus.health() }
  async checkOwners() {
    const snapshot = [...this.outgoing.values()]
    try {
      const ids = [...new Set(snapshot.map(f => f.context.publicationId))]
      const rows = new Map((await this.store.getMany(ids)).map(row => [row.publicationId, row]))
      const owners = new Map(await Promise.all(ids.map(async id => [id, await this.bus.lookup(id)])))
      for (const f of snapshot) {
        if (f.done) continue
        const row = rows.get(f.context.publicationId), owner = owners.get(f.context.publicationId)
        if (!validRow(row) || !owner || owner.generation !== row.generation || owner.generation !== f.owner.generation ||
            owner.connectionId !== f.owner.connectionId || owner.node !== f.owner.node) {
          f.finish(502, 'Connector ownership changed; delivery may be unknown')
          void f.send({ kind: 'cancel' }).catch(() => {})
        }
      }
    } catch {
      for (const f of snapshot) if (!f.done) {
        f.finish(503, 'Relay coordination unavailable; delivery may be unknown')
        void f.send({ kind: 'cancel' }).catch(() => {})
      }
    }
  }
  rate(...args) { return this.bus.rate(...args) }
  async online(row) {
    if (!validRow(row)) return false
    const owner = await this.bus.lookup(row.publicationId)
    return owner?.generation === row.generation
  }
  async claim(session) {
    const prior = await this.bus.claim(session)
    if (prior) await this.bus.send(prior.node, { kind: 'invalidate', ...contextOf(prior, randomUUID()) }).catch(() => {})
  }
  refresh(session) { return this.bus.refresh(session) }
  release(session) { return this.track(this.bus.release(session)).catch(() => {}) }
  async invalidate(publicationId) {
    const owner = await this.bus.lookup(publicationId)
    if (owner) await this.bus.send(owner.node, { kind: 'invalidate', ...contextOf(owner, randomUUID()) }).catch(() => {})
  }
  async forward(req, res, publicationId, route) {
    if (this.closed) throw fail(503, 'Relay stopping')
    const row = await this.store.get(publicationId)
    if (!validRow(row)) throw fail(503, 'Agent offline')
    const owner = await this.bus.lookup(publicationId)
    if (!owner || owner.generation !== row.generation) throw fail(503, 'Agent offline')
    if (Number(req.headers['content-length'] ?? 0) > LIMIT.body) throw fail(413, 'Body too large')
    const headers = headersOf(req.headers), requestId = randomUUID(), context = contextOf(owner, requestId)
    await this.bus.reserve(publicationId, requestId, this.maxConcurrent, this.requestTimeout + 30000)
    if (res.destroyed || this.closed) { await this.bus.unreserve(publicationId, requestId).catch(() => {}); return }
    const accepted = deferred(), completed = deferred()
    const f = { owner, context, res, seq: 0, received: 0, consumed: 0, started: false, done: false, accepted,
      send: message => this.bus.send(owner.node, { ...context, ...message }),
      touch: ms => { clearTimeout(f.timer); f.timer = setTimeout(() => {
        f.finish(504, 'Relay timeout; delivery may be unknown')
        void f.send({ kind: 'cancel' }).catch(() => {})
      }, ms) },
      finish: (status, message) => {
        if (f.done) return
        f.done = true; clearTimeout(f.timer); clearTimeout(f.deadline)
        this.outgoing.delete(requestId)
        res.removeListener('close', onClose)
        accepted.resolve(false)
        void this.track(this.bus.unreserve(publicationId, requestId)).catch(() => {})
        if (status) {
          if (!req.complete) res.once('finish', () => req.destroy())
          respond(res, status, message)
        }
        completed.resolve()
      },
    }
    const onClose = () => {
      if (f.done) return
      f.finish()
      req.destroy()
      void f.send({ kind: 'cancel' }).catch(() => {})
    }
    this.outgoing.set(requestId, f)
    res.once('close', onClose)
    f.deadline = setTimeout(() => {
      f.finish(504, 'Relay lifetime exceeded; delivery may be unknown')
      void f.send({ kind: 'cancel' }).catch(() => {})
    }, this.requestTimeout)
    f.touch(15000)
    try {
      const body = await readLimited(req)
      if (route === 'card' && body.length) throw fail(400, 'Card GET must not have a body')
      if (f.done) return
      await f.send({ kind: 'open', route, headers, length: body.length })
      if (await accepted.promise && !f.done) {
        f.touch(LIMIT.first)
        let seq = 0
        for (let offset = 0; offset < body.length && !f.done; offset += LIMIT.chunk) {
          await f.send({ kind: 'body', seq: seq++, data: body.subarray(offset, offset + LIMIT.chunk).toString('base64') })
        }
        if (!f.done) await f.send({ kind: 'body_end', seq })
      }
      await completed.promise
    } catch (error) {
      f.finish(error.status ?? 502, error.status ? error.message : 'Relay transport failed; delivery may be unknown')
      void f.send({ kind: 'cancel' }).catch(() => {})
    }
  }
  async receive(message) {
    if (this.closed || !idPattern.test(message.requestId ?? '') || !idPattern.test(message.publicationId ?? '') ||
        !idPattern.test(message.connectionId ?? '') || !Number.isSafeInteger(message.generation) || message.generation < 1) return
    if (message.kind === 'invalidate') { this.emit('invalidate', message); return }
    if (message.kind === 'open') { await this.open(message); return }
    const outgoing = this.outgoing.get(message.requestId)
    if (outgoing && message.from === outgoing.owner.node && matches(message, outgoing.context) &&
        ['accepted', 'response_begin', 'response_data', 'response_end', 'failed'].includes(message.kind)) {
      this.response(outgoing, message); return
    }
    const incoming = this.incoming.get(message.requestId)
    if (!incoming || message.from !== incoming.from || !matches(message, incoming.context)) return
    try {
      if (message.kind === 'cancel') { this.abortIncoming(incoming); return }
      if (message.kind === 'credit') { incoming.res.credit(message.consumed); return }
      if (message.kind === 'body') {
        const bytes = bytesOf(message)
        if (incoming.req.complete || message.seq !== incoming.seq++ || incoming.received + bytes.length > incoming.length) throw new Error('Invalid request body')
        incoming.received += bytes.length
        incoming.req.write(bytes)
        return
      }
      if (message.kind === 'body_end') {
        if (incoming.req.complete || message.seq !== incoming.seq || incoming.received !== incoming.length) throw new Error('Incomplete request body')
        incoming.req.complete = true
        incoming.req.end()
        return
      }
      throw new Error('Unexpected coordinator frame')
    } catch { this.abortIncoming(incoming) }
  }
  async open(message) {
    if (this.incoming.has(message.requestId)) return // Never dispatch the same open twice.
    const owner = { node: this.bus.id, publicationId: message.publicationId, connectionId: message.connectionId, generation: message.generation }
    const context = contextOf(owner, message.requestId)
    const send = payload => this.bus.send(message.from, { ...context, ...payload })
    if (!['card', 'rpc'].includes(message.route) || !Number.isInteger(message.length) || message.length < 0 || message.length > LIMIT.body ||
        message.route === 'card' && message.length || this.incoming.size >= this.maxConcurrent || !this.dispatch) {
      await send({ kind: 'failed' }).catch(() => {}); return
    }
    let headers
    try { headers = headersOf(message.headers) } catch { await send({ kind: 'failed' }).catch(() => {}); return }
    const req = new PassThrough({ highWaterMark: LIMIT.chunk })
    req.headers = { ...headers, 'content-length': String(message.length) }
    req.complete = false
    req.on('error', () => {})
    const res = new RemoteResponse(send)
    const f = { from: message.from, context, req, res, length: message.length, received: 0, seq: 0 }
    this.incoming.set(message.requestId, f)
    f.timer = setTimeout(() => this.abortIncoming(f), this.requestTimeout + 5000)
    res.once('close', () => {
      clearTimeout(f.timer)
      this.incoming.delete(message.requestId)
      req.destroy()
    })
    try {
      await this.bus.accept(owner, message.requestId, this.requestTimeout + 60000)
      if (this.closed || res.destroyed) return
      await this.dispatch(req, res, { ...context, route: message.route }, async () => {
        await send({ kind: 'accepted' })
      })
    } catch (error) { respond(res, error.status ?? 502, error.status ? error.message : 'Relay dispatch failed; delivery may be unknown') }
  }
  response(f, message) {
    try {
      if (message.kind === 'accepted') { f.accepted.resolve(true); return }
      if (message.kind === 'failed') { f.finish(502, 'Tunnel interrupted; delivery may be unknown'); return }
      f.touch(LIMIT.idle)
      if (message.kind === 'response_begin') {
        if (f.started || !Number.isInteger(message.status) || message.status < 200 || message.status > 599 || message.status >= 300 && message.status < 400) throw new Error('Invalid response')
        f.started = true
        f.accepted.resolve(false) // A rejected open can respond before acceptance.
        f.res.writeHead(message.status, { ...headersOf(message.headers, true), 'x-accel-buffering': 'no' })
        f.res.flushHeaders()
        return
      }
      if (message.kind === 'response_data') {
        const bytes = bytesOf(message)
        if (!f.started || message.seq !== f.seq++ || f.received + bytes.length - f.consumed > LIMIT.window) throw new Error('Response flow violation')
        f.received += bytes.length
        f.res.write(bytes, error => {
          if (error || f.done) return
          f.consumed += bytes.length
          void f.send({ kind: 'credit', consumed: f.consumed }).catch(() => f.finish(502, 'Response interrupted; delivery may be unknown'))
        })
        return
      }
      if (!f.started || message.seq !== f.seq) throw new Error('Incomplete response')
      f.res.end()
      f.finish()
    } catch {
      f.finish(502, 'Tunnel protocol violation; delivery may be unknown')
      void f.send({ kind: 'cancel' }).catch(() => {})
    }
  }
  abortIncoming(f) { f.req.destroy(); f.res.destroy() }
  async close() {
    if (this.closed) return
    this.closed = true
    clearInterval(this.ownerTimer)
    this.onUnavailable()
    this.bus.removeListener('message', this.onMessage)
    this.bus.removeListener('unavailable', this.onUnavailable)
    await Promise.allSettled([...this.work])
    this.bus.close()
  }
}
