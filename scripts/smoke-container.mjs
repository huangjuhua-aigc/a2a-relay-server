#!/usr/bin/env node
// Local Linux Docker acceptance only; no cloud changes or public ACME requests.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request } from 'node:https'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'
import { digest } from '../src/store.mjs'

const exec = promisify(execFile)
const docker = async (...args) => (await exec('docker', args, { windowsHide: true, timeout: 60000 })).stdout.trim()
const suffix = randomUUID(), relayName = `relay-qa-${suffix}`, proxyName = `proxy-qa-${suffix}`, volume = `relay-qa-${suffix}`
const dir = await mkdtemp(join(tmpdir(), 'relay-container-'))
const image = process.argv[2] ?? 'a2a-relay-server:vke-check'
const httpsImage = process.argv[3] ?? 'a2a-relay-https:vke-check'
const token = randomBytes(32).toString('hex')
let port, ca, ws
const http = (path, { method = 'GET', body, headers = {}, onChunk } = {}) => new Promise((resolve, reject) => {
  const req = request({ hostname: '127.0.0.1', port, path, method, ca, headers: { host: '127.0.0.1', ...headers } }, res => {
    let text = ''
    res.on('data', chunk => { text += chunk; onChunk?.(String(chunk)) })
    res.on('error', reject); res.on('end', () => resolve({ status: res.statusCode, text }))
  })
  req.setTimeout(10000, () => req.destroy(new Error('TLS request timed out')))
  req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body))
})
const start = async () => {
  await docker('run', '-d', '--name', relayName, '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--memory=512m', '--cpus=1',
    '-e', 'RELAY_ORIGIN=https://127.0.0.1', '-e', 'RELAY_TRUSTED_PROXY_IPS=127.0.0.1', '-e', 'RELAY_REQUESTS_PER_MINUTE=12',
    '-v', `${volume}:/data`, '-p', '127.0.0.1::8443', image)
  port = Number((await docker('port', relayName, '8443')).split(':').at(-1))
  await docker('run', '-d', '--name', proxyName, '--network', `container:${relayName}`, '--read-only', '--user', '1000:1000',
    '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--memory=256m', '--tmpfs', '/config:uid=1000,gid=1000,mode=0700',
    '-e', 'RELAY_ORIGIN=https://127.0.0.1', '-e', 'RELAY_TLS_NAME=127.0.0.1', '-v', `${volume}:/data`, '--mount', `type=bind,source=${join(dir, 'Caddyfile')},target=/etc/caddy/Caddyfile,readonly`,
    httpsImage)
  let lastError
  for (let i=0; i<50; i++) {
    try {
      await docker('cp', `${proxyName}:/data/caddy/pki/authorities/local/root.crt`, join(dir, 'root.crt'))
      ca = await readFile(join(dir, 'root.crt'))
      const health=await http('/health')
      if (health.status === 200) return
      lastError=new Error(`Health returned ${health.status}`)
    } catch (error) { lastError=error }
    await new Promise(r => setTimeout(r, 200))
  }
  const relayLog=await docker('logs',relayName).catch(()=>''), proxyLog=await docker('logs',proxyName).catch(()=>'')
  throw new Error(`Container HTTPS startup failed: ${lastError?.message}; relay=${relayLog}; proxy=${proxyLog}`)
}
const stop = async () => {
  await docker('stop', '-t', '10', proxyName)
  await docker('stop', '-t', '10', relayName)
  assert.equal(await docker('inspect', '-f', '{{.State.ExitCode}}', relayName), '0', 'SIGTERM must flush and exit cleanly')
  await docker('rm', proxyName, relayName)
}
try {
  const source = await readFile(new URL('../deploy/Caddyfile', import.meta.url), 'utf8')
  const local = source.replace(/\ttls \{[\s\S]*?\n\t\}\n/, '\ttls internal\n')
  assert.ok(!local.includes('issuer acme'), 'Local test must not contact an ACME CA')
  await writeFile(join(dir, 'Caddyfile'), local)
  await docker('volume', 'create', volume)
  const started = performance.now(); await start()
  const readyMs = Math.round(performance.now() - started)
  const register = await http('/v1/agents/register', { method: 'POST', body: {
    registrationId: randomUUID(), deviceTokenHash: digest(token), displayName: 'Container QA', protocolVersion: '1.0',
  } })
  assert.equal(register.status, 200)
  const identity = JSON.parse(register.text)
  assert.match(identity.contactId, /^13[89]\d{8}$/)
  assert.equal((await http('/v1/publication/enabled', { method: 'PUT', headers: { authorization: `Bearer ${token}` },
    body: { enabled: true, revision: 1, operationId: randomUUID() } })).status, 200)
  let sseEnded = false, firstChunkBeforeEnd = false
  const tunnelReady = new Promise((resolve, reject) => {
    ws = new WebSocket(`wss://127.0.0.1:${port}/v1/connect`, { ca, headers: { host: '127.0.0.1', authorization: `Bearer ${token}` } })
    let session
    const send = frame => ws.send(JSON.stringify({ v: 1, ...session, ...frame }))
    ws.on('error', reject)
    ws.on('close', () => reject(new Error('WSS closed before handshake completed')))
    ws.on('message', raw => {
      const m = JSON.parse(raw)
      if (m.type === 'hello') { session = { connectionId: m.connectionId, generation: m.generation }; send({ type: 'ready' }) }
      if (m.type === 'ready_ack') resolve()
      if (m.type === 'request_end') {
        send({ type: 'response_begin', requestId: m.requestId, status: 200, headers: { 'content-type': 'text/event-stream' } })
        send({ type: 'response_data', requestId: m.requestId, seq: 0, data: Buffer.from('data: first\n\n').toString('base64') })
        setTimeout(() => {
          send({ type: 'response_data', requestId: m.requestId, seq: 1, data: Buffer.from('data: done\n\n').toString('base64') })
          sseEnded = true; send({ type: 'response_end', requestId: m.requestId, seq: 2 })
        }, 300)
      }
    })
  })
  let readyTimer
  try { await Promise.race([tunnelReady, new Promise((_, reject) => { readyTimer = setTimeout(() => reject(new Error('WSS handshake timed out')), 10000) })]) }
  finally { clearTimeout(readyTimer) }
  const response = await http(`/r/${identity.publicationId}/a2a`, { method: 'POST', body: { method: 'SendMessage' },
    onChunk: chunk => { if (chunk.includes('first')) firstChunkBeforeEnd = !sseEnded } })
  assert.equal(response.status, 200)
  assert.equal(response.text, 'data: first\n\ndata: done\n\n')
  assert.ok(firstChunkBeforeEnd, 'TLS reverse proxy must flush SSE before response completion')
  ws.terminate(); ws = undefined
  for (let i=0; i<15; i++) await http('/unknown')
  assert.equal((await http('/unknown', { headers: { 'x-forwarded-for': '198.51.100.27' } })).status, 429)
  assert.equal((await http('/health')).status, 200)
  const resources = await docker('stats', '--no-stream', '--format', '{{.Name}} {{.MemUsage}} {{.CPUPerc}}', relayName, proxyName)
  await stop(); await start()
  const recovered = await http('/v1/publication', { headers: { authorization: `Bearer ${token}` } })
  assert.equal(recovered.status, 200)
  const saved = JSON.parse(recovered.text)
  assert.equal(saved.contactId, identity.contactId); assert.equal(saved.publicRpcUrl, identity.publicRpcUrl); assert.equal(saved.enabled, true)
  await stop()
  console.log(JSON.stringify({ passed: true, readyMs, checks: ['non-root/read-only Linux containers', 'verified IP TLS without SNI', 'WSS', 'unbuffered SSE', 'forwarded-IP spoof rejected', 'health under rate limiting', 'SIGTERM', 'persistent identity after recreation'], resources }))
} finally {
  ws?.terminate()
  await docker('rm', '-f', proxyName, relayName).catch(() => {})
  await docker('volume', 'rm', volume).catch(() => {})
  await rm(dir, { recursive: true, force: true })
}
