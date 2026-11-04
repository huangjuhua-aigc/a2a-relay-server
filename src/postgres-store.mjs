import { Pool } from 'pg'
import { readFileSync } from 'node:fs'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { digest } from './store.mjs'
import { isContactId, validateContactId, contactError } from './contact-id.mjs'

const fail = (status, message) => Object.assign(new Error(message), { status })
const columns = { registrationId:'registration_id', publicationId:'publication_id', deviceId:'device_id', tokenHash:'token_hash',
  displayName:'display_name', enabled:'enabled', revision:'revision', operationId:'operation_id', blocked:'blocked',
  generation:'generation', expiresAt:'expires_at', createdAt:'created_at', contactId:'contact_id' }
const fields = Object.entries(columns).map(([key,value])=>`${value} AS "${key}"`).join(',')
const normalize = row => {
  if (!row) return undefined
  for (const key of ['revision','generation','expiresAt','createdAt']) if (row[key] !== null) {
    row[key] = Number(row[key]); if (!Number.isSafeInteger(row[key])) throw new Error('Invalid database integer')
  }
  return row
}
function live(row) {
  if (!row) throw fail(401, 'Invalid device credential')
  if (row.blocked || row.expiresAt && row.expiresAt <= Date.now()) throw fail(403, 'Publication revoked or expired')
  return row
}
function databaseError(error) {
  if (error.status) return error
  return fail(503, 'Database unavailable; operation outcome may be unknown')
}

export class PostgresStore {
  constructor(config, maxRegistrations = 10000) {
    if (!Number.isSafeInteger(maxRegistrations) || maxRegistrations < 1) throw new Error('Invalid registration limit')
    this.pool = new Pool(config); this.maxRegistrations = maxRegistrations
    // Idle connection errors must not crash the relay or print credentials.
    this.pool.on('error', () => {})
  }
  async query(text, values) {
    try { return await this.pool.query(text, values) } catch (error) { throw databaseError(error) }
  }
  async transaction(work) {
    let client, broken = false
    try {
      client = await this.pool.connect(); await client.query('BEGIN')
      await client.query("SET LOCAL lock_timeout = '5s'")
      const value = await work(client); await client.query('COMMIT'); return value
    } catch (error) {
      if (client) { try { await client.query('ROLLBACK') } catch { broken = true } }
      throw databaseError(error)
    } finally { client?.release(broken) }
  }
  async migrate() {
    await this.transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(109381,1)')
      const exists = (await client.query("SELECT to_regclass('a2a_relay.schema_migrations') AS name")).rows[0].name
      let version = exists ? (await client.query('SELECT max(version) AS version FROM a2a_relay.schema_migrations')).rows[0].version : null
      if (version !== null && ![1, 2].includes(version)) throw fail(503, 'Unsupported database schema version')
      if (version === null) {
        await client.query(readFileSync(new URL('migrations/001-postgres.sql', import.meta.url), 'utf8'))
        version = 1
      }
      if (version === 1) await client.query(readFileSync(new URL('migrations/002-mobile-contact.sql', import.meta.url), 'utf8'))
    })
  }
  async health() {
    const { rows } = await this.query('SELECT max(version) AS version FROM a2a_relay.schema_migrations')
    if (![1, 2].includes(rows[0]?.version)) throw fail(503, 'Database migration required')
    return true
  }
  async register(input) {
    validateContactId(input.contactId)
    return this.transaction(async client => {
      // The shared row lock serializes capacity, idempotence and allocation
      // across connections/processes, including retries for the same identity.
      const counter = (await client.query('SELECT next FROM a2a_relay.contact_number_sequence WHERE id=1 FOR UPDATE')).rows[0]
      if (!counter) throw fail(503, 'Database migration required')
      const existing = normalize((await client.query(`SELECT ${fields} FROM a2a_relay.agents WHERE registration_id=$1`, [input.registrationId])).rows[0])
      if (existing) {
        if (existing.tokenHash !== input.deviceTokenHash) throw fail(409, 'Registration conflict')
        if (input.contactId !== undefined && input.contactId !== existing.contactId) throw contactError('CONTACT_ID_IMMUTABLE', 'Registered contact ID cannot be changed')
        return existing
      }
      if (Number((await client.query('SELECT count(*) AS n FROM a2a_relay.agents')).rows[0].n) >= this.maxRegistrations) throw fail(429, 'Registration capacity reached')
      if ((await client.query('SELECT 1 FROM a2a_relay.agents WHERE token_hash=$1', [input.deviceTokenHash])).rowCount) throw fail(409, 'Credential already registered')
      let next = Number(counter.next)
      if (input.contactId === undefined) {
        while (next <= 13999999999 && (await client.query('SELECT 1 FROM a2a_relay.agents WHERE contact_id=$1', [String(next)])).rowCount) next++
        if (next > 13999999999) throw fail(503, 'Contact number capacity reached')
      }
      const contactId = input.contactId ?? String(next)
      if ((await client.query('SELECT 1 FROM a2a_relay.agents WHERE contact_id=$1', [contactId])).rowCount) throw contactError('CONTACT_ID_TAKEN', 'Contact ID is already registered')
      const result = await client.query(`INSERT INTO a2a_relay.agents
        (registration_id,publication_id,device_id,token_hash,display_name,created_at,contact_id)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING ${fields}`,
      [input.registrationId,randomUUID(),randomUUID(),input.deviceTokenHash,input.displayName,Date.now(),contactId])
      if (input.contactId === undefined) await client.query('UPDATE a2a_relay.contact_number_sequence SET next=$1 WHERE id=1', [next + 1])
      return normalize(result.rows[0])
    })
  }
  async get(id) { return normalize((await this.query(`SELECT ${fields} FROM a2a_relay.agents WHERE publication_id=$1`,[id])).rows[0]) }
  async getByContactId(id) { return normalize((await this.query(`SELECT ${fields} FROM a2a_relay.agents WHERE contact_id=$1`,[id])).rows[0]) }
  async getMany(ids) { return (await this.query(`SELECT ${fields} FROM a2a_relay.agents WHERE publication_id=ANY($1::text[])`,[ids])).rows.map(normalize) }
  async authenticate(header) {
    const token = /^Bearer ([a-f0-9]{64})$/.exec(header ?? '')?.[1]
    if (!token) throw fail(401, 'Device authentication required')
    const hash = digest(token)
    const row = normalize((await this.query(`SELECT ${fields} FROM a2a_relay.agents WHERE token_hash=$1`,[hash])).rows[0])
    if (!row || !timingSafeEqual(Buffer.from(row.tokenHash),Buffer.from(hash))) throw fail(401,'Invalid device credential')
    return live(row)
  }
  async intent(authenticated, enabled, revision, operationId) {
    return this.transaction(async client => {
      const row = live(normalize((await client.query(`SELECT ${fields} FROM a2a_relay.agents WHERE publication_id=$1 FOR UPDATE`,[authenticated.publicationId])).rows[0]))
      if (row.tokenHash !== authenticated.tokenHash) throw fail(401,'Invalid device credential')
      if (revision < row.revision || revision === row.revision && (operationId !== row.operationId || Number(enabled) !== row.enabled)) throw fail(409,'Stale publication intent')
      return normalize((await client.query(`UPDATE a2a_relay.agents SET enabled=$1,revision=$2,operation_id=$3 WHERE publication_id=$4 RETURNING ${fields}`,
        [Number(enabled),revision,operationId,row.publicationId])).rows[0])
    })
  }
  async generation(id) {
    const { rows } = await this.query('UPDATE a2a_relay.agents SET generation=generation+1 WHERE publication_id=$1 AND enabled=1 AND blocked=0 AND (expires_at IS NULL OR expires_at>$2) RETURNING generation',[id,Date.now()])
    if (!rows[0]) throw fail(403,'Publication disabled, revoked or expired')
    return Number(rows[0].generation)
  }
  async revoke(id) { await this.query('UPDATE a2a_relay.agents SET blocked=1,enabled=0 WHERE publication_id=$1',[id]) }
  async importSnapshot({ rows, next }) {
    return this.transaction(async client => {
      await client.query('SELECT next FROM a2a_relay.contact_number_sequence WHERE id=1 FOR UPDATE')
      if (Number((await client.query('SELECT count(*) AS n FROM a2a_relay.agents')).rows[0].n) !== 0) throw fail(409,'Import requires an empty target registry')
      if (!Number.isSafeInteger(next) || next < 13800000000 || next > 14000000000) throw fail(400,'Invalid source allocation counter')
      for (const row of rows) {
        if (!isContactId(row.contactId)) throw fail(400,'Upgrade the source SQLite database before import')
        const keys = Object.keys(columns)
        await client.query(`INSERT INTO a2a_relay.agents (${Object.values(columns).join(',')}) VALUES (${keys.map((_,i)=>`$${i+1}`).join(',')})`,keys.map(key=>row[key]))
      }
      await client.query('UPDATE a2a_relay.contact_number_sequence SET next=GREATEST(next,$1) WHERE id=1',[next])
      return rows.length
    })
  }
  close() { return this.closing ??= this.pool.end() }
}
