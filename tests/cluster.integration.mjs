import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { fork, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID, randomBytes } from 'node:crypto'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { Pool } from 'pg'
import { PostgresStore } from '../src/postgres-store.mjs'
import { postgresConfig } from '../src/pg-config.mjs'
import { RedisBus, redisConfig } from '../src/redis-bus.mjs'
import { digest } from '../src/store.mjs'
import { readLimited, LIMIT } from '@talk2myagent/a2a-relay-protocol'

const enabled = process.env.RELAY_TEST_POSTGRES_URL && process.env.RELAY_TEST_REDIS_URL && process.env.A2A_CONNECTOR_SOURCE
const clusterTest = (name, fn) => test(name, { skip: !enabled, timeout: 60000 }, fn)
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(fn, timeout = 12000) {
  const end = Date.now() + timeout
  while (!await fn()) { if (Date.now() > end) throw new Error('Condition timed out'); await pause(25) }
}
async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${server.address().port}` }
function close(server) { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) }
async function fixture(options = {}) {
  const pgURL = new URL(process.env.RELAY_TEST_POSTGRES_URL), redisURL = new URL(process.env.RELAY_TEST_REDIS_URL)
  if (pgURL.hostname !== '127.0.0.1' || redisURL.hostname !== '127.0.0.1') throw new Error('Cluster tests require disposable loopback databases')
  const adminConfig = postgresConfig({ RELAY_DATABASE_URL: pgURL.toString(), RELAY_PG_ALLOW_INSECURE_LOOPBACK: '1' })
  const admin = new Pool(adminConfig), database = `cluster_${randomUUID().replaceAll('-', '')}`, namespace = database
  await admin.query(`CREATE DATABASE ${database}`)
  pgURL.pathname = `/${database}`
  const store = new PostgresStore({ ...adminConfig, database }); await store.migrate()
  const workers = [], holds = [], upgrades = new Set(), statuses = [], calls = []
  const visitorToken = randomBytes(32).toString('hex')
  const local = http.createServer(async (req, res) => {
    if (req.url === '/.well-known/agent-card.json') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ name: '真实 Connector 传输测试', supportedInterfaces: [{ url: 'http://127.0.0.1/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }] })); return
    }
    if (req.headers.authorization !== `Bearer ${visitorToken}`) { res.writeHead(401); res.end('denied'); return }
    const input = JSON.parse((await readLimited(req)).toString())
    calls.push(input)
    if (input.kind === 'hold') { holds.push(res); req.on('error', () => {}); return }
    if (input.kind === 'stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (let i = 0; i < 30 && !res.destroyed; i++) {
        const text = `data: ${JSON.stringify({ i, text: '你好🌏'.repeat(2000), nonce: input.nonce })}\n\n`
        if (!res.write(text)) await new Promise(resolve => res.once('drain', resolve))
        await pause(4)
      }
      res.end(); return
    }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ input, nonce: randomUUID() }))
  })
  const localOrigin = await listen(local)
  let owner, gateway
  const proxy = http.createServer((req, res) => {
    const upstream = http.request({ host: '127.0.0.1', port: gateway?.port, path: req.url, method: req.method, headers: req.headers }, response => {
      res.writeHead(response.statusCode, response.headers); response.pipe(res)
      response.on('error', () => res.destroy())
    })
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(503); res.end() })
    res.on('close', () => upstream.destroy())
    req.pipe(upstream)
  })
  proxy.on('upgrade', (req, socket, head) => {
    upgrades.add(socket); socket.on('close', () => upgrades.delete(socket)); socket.on('error', () => {})
    const upstream = net.connect(owner?.port ?? 1, '127.0.0.1', () => {
      upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${req.rawHeaders.reduce((a, value, i, all) => i % 2 ? a : a + `${value}: ${all[i + 1]}\r\n`, '')}\r\n`)
      if (head.length) upstream.write(head)
      socket.pipe(upstream); upstream.pipe(socket)
    })
    upstream.on('error', () => socket.destroy()); upstream.on('close', () => socket.destroy()); socket.on('close', () => upstream.destroy())
  })
  const origin = await listen(proxy)
  const env = { ...process.env, RELAY_ORIGIN: origin, RELAY_ALLOW_LOOPBACK_HTTP: '1', RELAY_STORE: 'postgres',
    RELAY_DATABASE_URL: pgURL.toString(), RELAY_DATABASE_URL_FILE: '', RELAY_PG_CA: '', RELAY_PG_CA_FILE: '', RELAY_PG_ALLOW_INSECURE_LOOPBACK: '1',
    RELAY_REDIS_URL: redisURL.toString(), RELAY_REDIS_URL_FILE: '', RELAY_REDIS_ALLOW_INSECURE_LOOPBACK: '1', RELAY_REDIS_NAMESPACE: namespace,
    RELAY_REGISTRATIONS_PER_HOUR: '1000', RELAY_REQUESTS_PER_MINUTE: '10000', ...options.env }
  async function worker(extra = {}) {
    const child = fork(fileURLToPath(new URL('support/cluster-worker.mjs', import.meta.url)), [], { env: { ...env, ...extra }, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    child.stderr.on('data', () => {})
    const item = { child }
    workers.push(item)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Relay worker startup timed out')), 12000)
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Relay worker exited: ${code}`)) })
      child.once('message', message => { clearTimeout(timer); Object.assign(item, message); resolve() })
    })
    return item
  }
  async function stop(item, force = false) {
    if (item.child.exitCode !== null || item.child.signalCode) return
    const done = new Promise(resolve => item.child.once('exit', resolve))
    if (force) item.child.kill(); else item.child.send({ kind: 'stop' })
    const timeout = setTimeout(() => item.child.kill(), 3000)
    await done; clearTimeout(timeout)
  }
  async function stats(item) {
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { item.child.removeListener('message', onMessage); reject(new Error('Stats timed out')) }, 2000)
      const onMessage = message => { if (message.id === id) { clearTimeout(timer); item.child.removeListener('message', onMessage); resolve(message) } }
      item.child.on('message', onMessage); item.child.send({ kind: 'stats', id })
    })
  }
  let connector, info, deviceToken
  const bus = await new RedisBus(redisConfig(env)).start()
  try {
    owner = await worker(); gateway = await worker()
    const { Connector, control } = await import(pathToFileURL(join(process.env.A2A_CONNECTOR_SOURCE, 'src', 'connector.mjs')).href)
    const state = { registrations: {}, desiredEnabled: true, revision: 1, operationId: randomUUID() }
    connector = new Connector({ config: { relayOrigin: origin, allowHttp: true, localRpcUrl: `${localOrigin}/a2a`, localCardUrl: `${localOrigin}/.well-known/agent-card.json`, displayName: '跨进程测试', ...(options.contactId ? { contactId:options.contactId } : {}) },
      state, save: async () => {}, onStatus: value => statuses.push(value) })
    await connector.start()
    await until(() => statuses.at(-1)?.state === 'online')
    info = connector.registration.info; deviceToken = connector.registration.token
    const send = (body, init = {}) => fetch(info.publicRpcUrl, { method: 'POST', headers: { authorization: `Bearer ${visitorToken}`, 'content-type': 'application/json' }, body: JSON.stringify(body), ...init })
    return { origin, info, send, calls, statuses, stats, store, bus, control: (path, method, body) => control(origin, path, deviceToken, method, body),
      owner: () => owner, gateway: () => gateway, env, holds,
      async replaceOwner() { await stop(owner, true); owner = await worker(); return owner },
      async extraGateway(extra = {}) { return worker(extra) },
      async close() {
        connector.stop()
        for (const res of holds) res.destroy()
        for (const socket of upgrades) socket.destroy()
        await Promise.all(workers.map(item => stop(item)))
        bus.close(); await close(proxy); await close(local); await store.close()
        await admin.query(`DROP DATABASE ${database}`); await admin.end()
      } }
  } catch (error) {
    connector?.stop(); bus.close()
    for (const socket of upgrades) socket.destroy()
    await Promise.all(workers.map(item => stop(item)))
    await close(proxy); await close(local); await store.close()
    await admin.query(`DROP DATABASE ${database}`); await admin.end()
    throw error
  }
}

clusterTest('separate owner/gateway processes route card, authenticated RPC, Unicode streaming and large request bodies', async () => {
  const f = await fixture({ contactId:'18612345678' })
  try {
    assert.equal(f.info.publicRpcUrl, `${f.origin}/r/18612345678/a2a`)
    assert.equal((await fetch(`${f.origin}/r/${f.info.publicationId}/.well-known/agent-card.json`)).status, 200)
    assert.equal((await f.stats(f.owner())).sessions, 1)
    assert.equal((await f.stats(f.gateway())).sessions, 0)
    assert.equal((await f.control('/v1/publication')).online, true)
    const card = await (await fetch(f.info.publicCardUrl)).json()
    assert.equal(card.supportedInterfaces[0].url, f.info.publicRpcUrl)
    assert.equal((await f.send({ test: 1 }, { headers: { authorization: 'Bearer wrong' } })).status, 401)
    const nonce = randomUUID(), payload = { nonce, text: '公共资料🌏'.repeat(16000) }
    assert.deepEqual((await (await f.send(payload)).json()).input, payload)
    const stream = await f.send({ kind: 'stream', nonce })
    assert.equal(stream.status, 200)
    const reader = stream.body.getReader(), parts = []
    let chunks = 0
    while (true) { const result = await reader.read(); if (result.done) break; parts.push(Buffer.from(result.value)); chunks++; await pause(8) }
    const text = Buffer.concat(parts).toString()
    assert.ok(chunks > 1)
    const events = text.trim().split('\n\n').map(line => JSON.parse(line.slice(6)))
    assert.equal(events.length, 30)
    assert.ok(events.every((event, i) => event.i === i && event.nonce === nonce && event.text === '你好🌏'.repeat(2000)))
    await until(async () => (await f.stats(f.owner())).incoming === 0 && (await f.stats(f.gateway())).outgoing === 0)
  } finally { await f.close() }
})

clusterTest('agent concurrency is shared across gateways; client cancellation frees slots and aborts local calls', async () => {
  const f = await fixture(), controllers = Array.from({ length: 8 }, () => new AbortController())
  try {
    const pending = controllers.map((controller, i) => f.send({ kind: 'hold', i }, { signal: controller.signal }).catch(() => null))
    await until(() => f.holds.length === 8)
    const other = await f.extraGateway()
    const response = await fetch(`http://127.0.0.1:${other.port}/r/${f.info.publicationId}/a2a`, { method: 'POST', body: '{}' })
    assert.equal(response.status, 429)
    controllers.forEach(controller => controller.abort())
    await Promise.all(pending)
    await until(() => f.holds.every(res => res.destroyed))
    await until(async () => (await f.stats(f.owner())).incoming === 0)
    assert.equal((await f.send({ after: 'cancel' })).status, 200)
  } finally { controllers.forEach(controller => controller.abort()); await f.close() }
})

clusterTest('owner process death reconnects without replaying an interrupted RPC or changing registered identity', async () => {
  const f = await fixture()
  try {
    const before = await f.store.get(f.info.publicationId)
    const nonce = randomUUID()
    const pending = f.send({ kind: 'hold', nonce }).catch(() => null)
    await until(() => f.calls.some(call => call.nonce === nonce))
    await f.replaceOwner()
    await until(async () => (await f.store.get(f.info.publicationId)).generation > before.generation && (await f.control('/v1/publication')).online)
    await pause(800)
    assert.equal(f.calls.filter(call => call.nonce === nonce).length, 1)
    assert.equal((await f.store.get(f.info.publicationId)).contactId, before.contactId)
    assert.equal((await f.send({ after: 'restart' })).status, 200)
    // A request pinned to the dead owner is failed, never retried against its replacement.
    const response = await Promise.race([pending, pause(17000).then(() => { throw new Error('Dead-owner request did not terminate') })])
    assert.ok(response === null || response.status >= 500)
  } finally { await f.close() }
})

clusterTest('disable from gateway closes the remote connector and prevents further requests', async () => {
  const f = await fixture()
  try {
    await f.control('/v1/publication/enabled', 'PUT', { enabled: false, revision: 2, operationId: randomUUID() })
    await until(async () => (await f.stats(f.owner())).sessions === 0)
    assert.equal((await f.control('/v1/publication')).online, false)
    assert.equal((await f.send({ disabled: true })).status, 503)
    assert.equal(f.calls.length, 0)
  } finally { await f.close() }
})

clusterTest('Redis fencing rejects old generations, duplicate dispatch, namespace leakage and rate-limit bypass', async () => {
  const f = await fixture()
  try {
    const record = await f.bus.lookup(f.info.publicationId)
    const separate = await new RedisBus(redisConfig({ ...f.env, RELAY_REDIS_NAMESPACE: `${f.env.RELAY_REDIS_NAMESPACE}-preview` })).start()
    try { assert.equal(await separate.lookup(f.info.publicationId), undefined) } finally { separate.close() }
    const stale = { ...record, node: f.bus.id, generation: record.generation - 1 }
    await assert.rejects(f.bus.claim(stale))
    const requestId = randomUUID()
    await f.bus.reserve(f.info.publicationId, requestId, 64, 10000)
    await f.bus.accept(record, requestId, 10000)
    await assert.rejects(f.bus.accept(record, requestId, 10000), /already dispatched/)
    await f.bus.unreserve(f.info.publicationId, requestId)
    const other = await new RedisBus(redisConfig(f.env)).start()
    try {
      await f.bus.rate('198.51.100.1', 'test', 1, 60000)
      await assert.rejects(other.rate('198.51.100.1', 'test', 1, 60000), error => error.status === 429)
    } finally { other.close() }
    assert.equal((await f.send({ after: 'fencing' })).status, 200)
  } finally { await f.close() }
})

clusterTest('shortened platform lifetime rotates the real Connector and does not retry timed-out tool work', async () => {
  const f = await fixture({ env: { RELAY_CONNECTION_MAX_AGE_MS: '3000', RELAY_REQUEST_TIMEOUT_MS: '1800' } })
  try {
    const original = await f.store.get(f.info.publicationId), nonce = randomUUID()
    const response = await f.send({ kind: 'hold', nonce })
    assert.equal(response.status, 504)
    await response.text()
    await until(async () => (await f.store.get(f.info.publicationId)).generation > original.generation && (await f.control('/v1/publication')).online)
    assert.equal(f.calls.filter(call => call.nonce === nonce).length, 1)
    assert.equal((await f.send({ after: 'rotation' })).status, 200)
  } finally { await f.close() }
})

clusterTest('Redis outage fails closed and recovers with fresh connector ownership', async () => {
  const container = process.env.RELAY_TEST_REDIS_CONTAINER
  if (!/^relay-cluster-test-[a-f0-9-]+-redis$/.test(container ?? '')) throw new Error('Disposable Redis container required')
  const f = await fixture(), exec = promisify(execFile)
  const docker = (...args) => exec('docker', args, { windowsHide: true, timeout: 15000 })
  try {
    const previous = await f.store.get(f.info.publicationId)
    await docker('stop', '-t', '1', container)
    await until(async () => (await f.stats(f.owner())).sessions === 0)
    assert.equal((await fetch(`${f.origin}/health`)).status, 200)
    assert.equal((await fetch(`${f.origin}/ready`)).status, 503)
    assert.equal((await f.send({ offline: true })).status, 503)
    assert.equal(f.calls.length, 0)
    await docker('start', container)
    await until(async () => {
      try { return (await f.store.get(f.info.publicationId)).generation > previous.generation && (await f.control('/v1/publication')).online } catch { return false }
    }, 20000)
    assert.equal((await f.send({ recovered: true })).status, 200)
  } finally { await docker('start', container).catch(() => {}); await f.close() }
})
