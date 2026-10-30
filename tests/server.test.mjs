import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRelay } from '../src/server.mjs'
import { digest } from '../src/store.mjs'
test('registration, device authorization, stale intents, revocation and durable identity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-store-'))
  const opts = { origin: 'https://relay.example.test', database: join(dir, 'relay.db') }
  let relay = createRelay(opts)
  try {
    await new Promise(r => relay.server.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${relay.server.address().port}`, token = randomBytes(32).toString('hex')
    const body = { registrationId: randomUUID(), deviceTokenHash: digest(token), displayName: '中文 Agent', protocolVersion: '1.0' }
    const reg = async (b = body) => fetch(`${base}/v1/agents/register`, { method: 'POST', headers: { 'content-type': 'application/json', host: 'evil.test' }, body: JSON.stringify(b) })
    const a = await (await reg()).json(), b = await (await reg()).json()
    assert.equal(a.publicationId, b.publicationId); assert.ok(a.publicRpcUrl.startsWith(opts.origin)); assert.equal(a.enabled, false)
    assert.equal((await reg({ ...body, deviceTokenHash: digest('other') })).status, 409)
    assert.equal((await fetch(`${base}/v1/publication`)).status, 401)
    const intent = (enabled, revision, operationId = randomUUID()) => fetch(`${base}/v1/publication/enabled`, { method:'PUT', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ enabled, revision, operationId }) })
    assert.equal((await intent(true, 1)).status, 200)
    const op = randomUUID()
    assert.equal((await intent(false, 2, op)).status, 200)
    assert.equal((await intent(false, 2, op)).status, 200)
    assert.equal((await intent(true, 1)).status, 409)
    assert.equal((await fetch(`${base}/r/${a.publicationId}/a2a`, { method: 'POST', body:'{}' })).status, 503)
    assert.equal((await fetch(`${base}/r/${a.publicationId}/api/agents`)).status, 404)
    relay.revoke(a.publicationId)
    assert.equal((await intent(true, 3)).status, 403)
    await relay.close(); relay = createRelay(opts)
    assert.equal(relay.store.register(body).publicationId, a.publicationId)
    assert.equal(relay.store.get(a.publicationId).blocked, 1)
  } finally { await relay.close(); await rm(dir, { recursive: true, force: true }) }
})
test('registration switch, quotas and input validation', async () => {
  const relay = createRelay({ origin: 'https://relay.example.test', maxRegistrations: 1 })
  const body = { registrationId: randomUUID(), deviceTokenHash: digest('x'), displayName:'a' }
  try {
    relay.store.register(body)
    assert.throws(() => relay.store.register({ ...body, registrationId: randomUUID() }), /capacity/)
    assert.throws(() => createRelay({ origin: 'http://evil.test' }), /HTTPS/)
    assert.throws(() => createRelay({ origin: 'https://example.com/subpath' }), /HTTPS/)
  } finally { await relay.close() }
})

test('registration policy, malformed JSON and IP rates are enforced by HTTP', async () => {
  for (const registrationEnabled of [true, false]) {
    const relay = createRelay({ origin:'https://relay.example.test', registrationEnabled, requestsPerMinute:3 })
    try {
      await new Promise(r=>relay.server.listen(0,'127.0.0.1',r))
      const base=`http://127.0.0.1:${relay.server.address().port}`
      assert.equal((await fetch(`${base}/v1/agents/register`,{method:'POST',body:'not-json'})).status,registrationEnabled?400:403)
      assert.equal((await fetch(`${base}/health`)).status,200)
      assert.equal((await fetch(`${base}/health`)).status,200)
      // An untrusted forwarded address cannot reset the rate bucket.
      assert.equal((await fetch(`${base}/health`,{headers:{'x-forwarded-for':'1.2.3.4'}})).status,429)
    } finally {await relay.close()}
  }
})
