#!/usr/bin/env node
// Explicit live deployment acceptance. Creates or reuses a disabled QA registration;
// keeps its device credential only in the caller-supplied private state file.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import https from 'node:https'
import dns from 'node:dns'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const origin = new URL(process.env.RELAY_QA_ORIGIN ?? '').origin
assert.ok(origin.startsWith('https://'), 'Live QA requires verified HTTPS')
assert.ok(process.env.A2A_CONNECTOR_SOURCE && process.env.RELAY_QA_STATE_FILE)
const { Connector, control } = await import(pathToFileURL(join(process.env.A2A_CONNECTOR_SOURCE, 'src/connector.mjs')))
const existingState = process.env.RELAY_QA_EXISTING_STATE_FILE
const state = existingState ? JSON.parse(await readFile(existingState, 'utf8'))
  : { registrations: {}, desiredEnabled: true, revision: 1, operationId: randomUUID(), cloudSyncPending: true }
if (existingState) {
  assert.ok(state.registrations?.[origin]?.info, 'Existing QA state must belong to this origin')
  assert.equal(state.desiredEnabled, true, 'Existing QA state must request publication')
}
const visitor = randomBytes(32).toString('hex')
const report = { origin, startedAt: new Date().toISOString(), checks: [] }
if (process.env.RELAY_QA_LOOPBACK_TUNNEL === '1') {
  // The caller owns a temporary 127.0.0.1:443 tunnel to the ALB public IP.
  // Change DNS only in this process; preserve the origin, TLS SNI and hostname
  // verification. This is NOT evidence of ordinary client Internet routing.
  assert.equal(new URL(origin).port, '')
  const lookup = dns.lookup.bind(dns), host = new URL(origin).hostname
  dns.lookup = (hostname, options, callback) => {
    if (hostname !== host) return lookup(hostname, options, callback)
    if (typeof options === 'function') { callback = options; options = {} }
    process.nextTick(callback, null, options?.all ? [{ address: '127.0.0.1', family: 4 }] : '127.0.0.1', 4)
  }
  report.networkPath = 'test-process loopback tunnel via VKE to ALB public IP; TLS verification enabled'
} else report.networkPath = 'ordinary client HTTPS connection'
const save = () => writeFile(process.env.RELAY_QA_STATE_FILE, JSON.stringify(state), { mode: 0o600 })
let connector, snapshot, info, accepted = 0, responseFinished = false, restarted = false
const local = createServer(async (req, res) => {
  if (req.url === '/.well-known/agent-card.json') {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ name: 'Deployment transport QA', supportedInterfaces: [{ url: 'http://127.0.0.1/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }], capabilities: { streaming: true }, skills: [] }))
    return
  }
  if (req.headers.authorization !== `Bearer ${visitor}`) { res.writeHead(401); res.end('Unauthorized'); return }
  let text = ''; for await (const chunk of req) text += chunk
  accepted++; responseFinished = false
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  res.write(`data: ${JSON.stringify({ echo: text, text: '你好🌈' })}\n\n`)
  setTimeout(() => { responseFinished = true; res.end('data: done\n\n') }, 1200)
})
function request(url, { method = 'GET', body, token, onChunk } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, timeout: 15000, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) } }, res => {
      let text = ''
      res.on('data', chunk => { text += chunk; onChunk?.(chunk) })
      res.on('error', reject)
      res.on('end', () => resolve({ status: res.statusCode, text }))
    })
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('Request timeout; request was not replayed')))
    req.end(body)
  })
}
async function until(fn, timeout = 90000) {
  const deadline = Date.now() + timeout
  while (!await fn()) { if (Date.now() > deadline) throw new Error(`Timed out; connector state ${snapshot?.state}`); await new Promise(r => setTimeout(r, 500)) }
}
try {
  for (const p of ['/health', '/ready']) assert.equal((await request(origin + p)).status, 200)
  assert.equal((await request(origin + '/v1/publication')).status, 401)
  report.checks.push('verified HTTPS, health/readiness, device authentication')
  await new Promise(r => local.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${local.address().port}`
  connector = new Connector({ config: { relayOrigin: origin, localRpcUrl: base + '/a2a', localCardUrl: base + '/.well-known/agent-card.json', displayName: 'Deployment transport QA',
    ...(process.env.RELAY_QA_CONTACT_ID ? { contactId:process.env.RELAY_QA_CONTACT_ID } : {}) }, state, save, onStatus: s => { snapshot = s } })
  await connector.register()
  info = state.registrations[origin].info
  assert.match(info.contactId, /^1[3-9]\d{9}$/)
  if (process.env.RELAY_QA_CONTACT_ID) assert.equal(info.publicRpcUrl, `${origin}/r/${process.env.RELAY_QA_CONTACT_ID}/a2a`)
  assert.equal((await request(info.publicRpcUrl, { method: 'POST', body: '{}' })).status, 503)
  report.checks.push(existingState ? 'existing 11-digit identity preserved; offline address verified'
    : 'server-allocated 11-digit ID and offline address reservation')
  void connector.start(); await until(() => snapshot?.state === 'online')
  const card = await request(info.publicCardUrl)
  assert.equal(card.status, 200)
  assert.equal(JSON.parse(card.text).supportedInterfaces[0].url, info.publicRpcUrl)
  assert.equal((await request(info.publicRpcUrl, { method: 'POST', body: '{}', token: 'wrong' })).status, 401)
  let streamed = false
  const nonce = randomUUID()
  const response = await request(info.publicRpcUrl, { method: 'POST', body: JSON.stringify({ nonce }), token: visitor, onChunk: () => { if (!responseFinished) streamed = true } })
  assert.equal(response.status, 200); assert.ok(streamed, 'ALB must flush SSE before the response ends')
  assert.ok(response.text.includes(nonce) && response.text.includes('你好🌈'))
  assert.equal(accepted, 1)
  report.checks.push('real Connector WSS, rewritten Agent Card, visitor auth, unbuffered UTF-8 SSE')
  const oldSocket = connector.ws
  connector.ws.terminate()
  await until(() => snapshot?.state === 'online' && connector.ws !== oldSocket)
  assert.equal(accepted, 1)
  report.checks.push('Connector reconnect without replaying completed requests')
  if (process.env.RELAY_QA_KUBECONFIG) {
    const exec = promisify(execFile), args = ['--kubeconfig', process.env.RELAY_QA_KUBECONFIG, '-n', 'a2a-relay']
    const socketBefore = connector.ws
    await exec('kubectl', [...args, 'rollout', 'restart', 'deployment/a2a-relay'], { windowsHide: true, timeout: 30000 })
    await exec('kubectl', [...args, 'rollout', 'status', 'deployment/a2a-relay', '--timeout=90s'], { windowsHide: true, timeout: 95000 })
    await until(() => snapshot?.state === 'online' && connector.ws !== socketBefore)
    const recovered = await control(origin, '/v1/publication', state.registrations[origin].token)
    assert.equal(recovered.contactId, info.contactId); assert.equal(recovered.publicRpcUrl, info.publicRpcUrl)
    assert.equal(accepted, 1)
    assert.equal((await request(info.publicRpcUrl, { method: 'POST', body: '{}', token: visitor })).status, 200)
    restarted = true
    report.checks.push('Kubernetes application restart preserves address/ID and reconnects without replay')
  }
} finally {
  connector?.stop()
  if (info) {
    const token = state.registrations[origin].token
    const current = await control(origin, '/v1/publication', token)
    await control(origin, '/v1/publication/enabled', token, 'PUT', { enabled: false, revision: current.revision + 1, operationId: randomUUID() })
    assert.equal((await request(info.publicRpcUrl, { method: 'POST', body: '{}' })).status, 503)
    report.checks.push('QA publication disabled and inaccessible after cleanup')
  }
  local.closeAllConnections(); await new Promise(r => local.close(r))
}
report.passed = true; report.restarted = restarted; report.contactId = info.contactId; report.publicRpcUrl = info.publicRpcUrl
report.finishedAt = new Date().toISOString()
if (process.env.RELAY_QA_REPORT_FILE) await writeFile(process.env.RELAY_QA_REPORT_FILE, JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
