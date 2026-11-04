import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { Worker } from 'node:worker_threads'
import { Store, digest } from '../src/store.mjs'
import { createRelay } from '../src/server.mjs'

const input = () => ({ registrationId: randomUUID(), deviceTokenHash: digest(randomUUID()), displayName: '同名 Agent', protocolVersion: '1.0' })
async function temporary(check) {
  const root = await mkdtemp(join(tmpdir(), 'relay-numbers-'))
  try { await check(join(root, 'relay.db')) }
  finally { if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unsafe cleanup'); await rm(root, { recursive: true, force: true }) }
}

test('Relay allocates legacy numbers and atomically reserves client-selected mobile numbers', async () => {
  const relay = createRelay({ origin: 'https://relay.test', registrationPerHour: 200, requestsPerMinute: 1000 })
  try {
    await new Promise(r => relay.server.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${relay.server.address().port}`
    const register = body => fetch(`${base}/v1/agents/register`, { method: 'POST', body: JSON.stringify(body) })
    const users = Array.from({ length: 64 }, input)
    const results = await Promise.all(users.map(async u => { const r = await register(u); assert.equal(r.status, 200); return r.json() }))
    assert.equal(new Set(results.map(r => r.contactId)).size, 64)
    assert(results.every(r => /^13[89]\d{8}$/.test(r.contactId)))
    const retries = await Promise.all(Array.from({ length: 8 }, async () => (await register(users[0])).json()))
    assert(retries.every(r => r.contactId === results[0].contactId && r.publicationId === results[0].publicationId))
    const chosen = { ...input(), contactId: '18612345678' }
    const reserved = await (await register(chosen)).json()
    assert.equal(reserved.contactId, chosen.contactId)
    assert.equal(reserved.contactRpcUrl, 'https://relay.test/r/18612345678/a2a')
    assert.equal((await (await register(chosen)).json()).publicationId, reserved.publicationId)
    const changed = await register({ ...chosen, contactId: '18612345679' })
    assert.equal(changed.status, 409); assert.equal((await changed.json()).code, 'CONTACT_ID_IMMUTABLE')
    for (const contactId of ['', null, 13812345678, '12812345678', '1861234567', '186123456789', '../18612345678']) assert.equal((await register({ ...input(), contactId })).status, 400)
    const collisions = await Promise.all(Array.from({ length: 16 }, () => register({ ...input(), contactId: '13988888888' })))
    assert.equal(collisions.filter(r => r.status === 200).length, 1)
    assert.equal(collisions.filter(r => r.status === 409).length, 15)
    assert.equal((await collisions.find(r => r.status === 409).json()).code, 'CONTACT_ID_TAKEN')
    assert.equal((await fetch(`${base}/r/18612345678/.well-known/agent-card.json`)).status, 503)
    relay.store.revoke(results[0].publicationId)
    assert.notEqual((await (await register(input())).json()).contactId, results[0].contactId)
  } finally { await relay.close() }
})

test('custom numbers do not exhaust the automatic pool and are skipped by its allocator', () => {
  const store = new Store(':memory:')
  try {
    store.register({ ...input(), contactId: '19999999999' })
    store.register({ ...input(), contactId: '13800000000' })
    assert.equal(store.register(input()).contactId, '13800000001')
    assert.equal(store.getByContactId('19999999999').contactId, '19999999999')
  } finally { store.close() }
})

test('SQLite widens the previous 138/139 constraint without losing credentials, routes or unique indexes', () => temporary(async database => {
  const old = new DatabaseSync(database), u = input(), publicationId = randomUUID(), deviceId = randomUUID()
  old.exec(`CREATE TABLE agents (registrationId TEXT PRIMARY KEY, publicationId TEXT UNIQUE, deviceId TEXT UNIQUE,
    tokenHash TEXT, displayName TEXT, enabled INTEGER DEFAULT 0, revision INTEGER DEFAULT 0, operationId TEXT,
    blocked INTEGER DEFAULT 0, generation INTEGER DEFAULT 0, expiresAt INTEGER, createdAt INTEGER,
    contactId TEXT CHECK(contactId IS NULL OR (length(contactId)=11 AND substr(contactId,1,3) IN ('138','139') AND contactId NOT GLOB '*[^0-9]*')))`)
  old.prepare('INSERT INTO agents(registrationId,publicationId,deviceId,tokenHash,displayName,enabled,revision,generation,createdAt,contactId) VALUES(?,?,?,?,?,1,9,3,123,?)')
    .run(u.registrationId, publicationId, deviceId, u.deviceTokenHash, u.displayName, '13800000000')
  old.close()
  let store = new Store(database)
  try {
    assert.equal(store.register(u).publicationId, publicationId)
    assert.equal(store.register(u).revision, 9)
    assert.equal(store.register(u).generation, 3)
    const chosen = { ...input(), contactId: '18612345678' }, row = store.register(chosen)
    assert.equal(store.register(input()).contactId, '13800000001')
    store.close(); store = new Store(database)
    assert.equal(store.register(chosen).publicationId, row.publicationId)
    assert.throws(() => store.register({ ...input(), contactId: chosen.contactId }), e => e.code === 'CONTACT_ID_TAKEN')
    assert.throws(() => store.db.prepare('UPDATE agents SET contactId=? WHERE publicationId=?').run('18611111111', publicationId), /immutable/)
  } finally { store.close() }
}))

test('database transactions serialize independent writers; duplicate numbers violate the unique index', () => temporary(async database => {
  const initialized = new Store(database); initialized.close()
  const shared = input()
  const outcomes = await Promise.allSettled(Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./support/number-worker.mjs', import.meta.url), { workerData: { database, shared } })
    let result, error
    worker.once('message', value => { result = value })
    worker.once('error', value => { error = value })
    worker.once('exit', code => code === 0 && result ? resolve(result) : reject(error ?? new Error(`Worker exited ${code}`)))
  })))
  const failed = outcomes.find(r => r.status === 'rejected')
  if (failed) throw failed.reason
  const batches = outcomes.map(r => r.value)
  assert.equal(new Set(batches.map(rows => rows[0].contactId)).size, 1)
  const store = new Store(database)
  try {
    const rows = store.db.prepare('SELECT * FROM agents').all()
    assert.equal(rows.length, 101); assert.equal(new Set(rows.map(r => r.contactId)).size, 101)
    const other = input()
    assert.throws(() => store.db.prepare('INSERT INTO agents(registrationId,publicationId,deviceId,tokenHash,displayName,contactId) VALUES(?,?,?,?,?,?)')
      .run(other.registrationId, randomUUID(), randomUUID(), other.deviceTokenHash, other.displayName, rows[0].contactId), /UNIQUE/)
    assert.throws(() => store.db.prepare('UPDATE agents SET contactId=? WHERE registrationId=?').run('13999999999', shared.registrationId), /immutable/)
  } finally { store.close() }
}))

test('legacy database migration preserves routes, credentials and state, then reuses numbers after restart', () => temporary(async database => {
  const old = new DatabaseSync(database), u = input(), publicationId = randomUUID(), deviceId = randomUUID()
  old.exec(`CREATE TABLE agents (registrationId TEXT PRIMARY KEY, publicationId TEXT UNIQUE, deviceId TEXT UNIQUE,
    tokenHash TEXT, displayName TEXT, enabled INTEGER DEFAULT 0, revision INTEGER DEFAULT 0, operationId TEXT,
    blocked INTEGER DEFAULT 0, generation INTEGER DEFAULT 0, expiresAt INTEGER, createdAt INTEGER)`)
  old.prepare('INSERT INTO agents(registrationId,publicationId,deviceId,tokenHash,displayName,enabled,revision,generation,createdAt) VALUES(?,?,?,?,?,1,9,3,123)')
    .run(u.registrationId, publicationId, deviceId, u.deviceTokenHash, u.displayName)
  old.close()
  let store = new Store(database)
  try {
    const migrated = store.register(u)
    assert.match(migrated.contactId, /^13[89]\d{8}$/)
    assert.equal(migrated.publicationId, publicationId); assert.equal(migrated.deviceId, deviceId)
    assert.equal(migrated.tokenHash, u.deviceTokenHash); assert.equal(migrated.revision, 9)
    assert.equal(migrated.generation, 3); assert.equal(migrated.enabled, 1)
    store.close(); store = new Store(database)
    assert.deepEqual(store.register(u), migrated)
    const next = store.register(input()); assert.notEqual(next.contactId, migrated.contactId)
  } finally { store.close() }
}))

test('allocation crosses 138/139, never wraps and rolls back when exhausted', () => {
  const store = new Store(':memory:')
  try {
    store.db.prepare('UPDATE contact_number_sequence SET next=?').run(13899999999)
    assert.equal(store.register(input()).contactId, '13899999999')
    assert.equal(store.register(input()).contactId, '13900000000')
    store.db.prepare('UPDATE contact_number_sequence SET next=?').run(13999999999)
    assert.equal(store.register(input()).contactId, '13999999999')
    assert.throws(() => store.register(input()), e => e.status === 503)
    assert.equal(store.db.prepare('SELECT count(*) n FROM agents').get().n, 3)
    assert.equal(store.db.prepare('SELECT next FROM contact_number_sequence').get().next, 14000000000)
  } finally { store.close() }
})
