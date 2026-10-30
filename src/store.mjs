import { DatabaseSync } from 'node:sqlite'
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto'
export const digest = value => createHash('sha256').update(value).digest('hex')
export class Store {
  constructor(path, maxRegistrations = 10000) {
    this.db = new DatabaseSync(path); this.maxRegistrations = maxRegistrations
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS agents (registrationId TEXT PRIMARY KEY, publicationId TEXT UNIQUE, deviceId TEXT UNIQUE,
      tokenHash TEXT, displayName TEXT, enabled INTEGER DEFAULT 0, revision INTEGER DEFAULT 0, operationId TEXT,
      blocked INTEGER DEFAULT 0, generation INTEGER DEFAULT 0, expiresAt INTEGER, createdAt INTEGER);
      CREATE UNIQUE INDEX IF NOT EXISTS agents_token_hash ON agents(tokenHash);`)
  }
  register(input) {
    const existing = this.db.prepare('SELECT * FROM agents WHERE registrationId=?').get(input.registrationId)
    if (existing) {
      if (existing.tokenHash !== input.deviceTokenHash) throw Object.assign(new Error('Registration conflict'), { status: 409 })
      return existing
    }
    if (this.db.prepare('SELECT count(*) AS n FROM agents').get().n >= this.maxRegistrations) throw Object.assign(new Error('Registration capacity reached'), { status: 429 })
    if (this.db.prepare('SELECT publicationId FROM agents WHERE tokenHash=?').get(input.deviceTokenHash)) throw Object.assign(new Error('Credential already registered'), { status: 409 })
    this.db.prepare('INSERT INTO agents(registrationId,publicationId,deviceId,tokenHash,displayName,createdAt) VALUES(?,?,?,?,?,?)')
      .run(input.registrationId, randomUUID(), randomUUID(), input.deviceTokenHash, input.displayName, Date.now())
    return this.db.prepare('SELECT * FROM agents WHERE registrationId=?').get(input.registrationId)
  }
  get(id) { return this.db.prepare('SELECT * FROM agents WHERE publicationId=?').get(id) }
  authenticate(header) {
    const token = /^Bearer ([a-f0-9]{64})$/.exec(header ?? '')?.[1]
    if (!token) throw Object.assign(new Error('Device authentication required'), { status: 401 })
    const hash = digest(token)
    const row = this.db.prepare('SELECT * FROM agents WHERE tokenHash=?').get(hash)
    if (!row || !timingSafeEqual(Buffer.from(row.tokenHash), Buffer.from(hash))) throw Object.assign(new Error('Invalid device credential'), { status: 401 })
    if (row.blocked || row.expiresAt && row.expiresAt <= Date.now()) throw Object.assign(new Error('Publication revoked or expired'), { status: 403 })
    return row
  }
  intent(row, enabled, revision, operationId) {
    if (revision < row.revision || revision === row.revision && (operationId !== row.operationId || Number(enabled) !== row.enabled)) throw Object.assign(new Error('Stale publication intent'), { status: 409 })
    this.db.prepare('UPDATE agents SET enabled=?,revision=?,operationId=? WHERE publicationId=?').run(Number(enabled),revision,operationId,row.publicationId)
    return this.get(row.publicationId)
  }
  generation(id) {
    this.db.prepare('UPDATE agents SET generation=generation+1 WHERE publicationId=?').run(id)
    return this.get(id).generation
  }
  revoke(id) { this.db.prepare('UPDATE agents SET blocked=1, enabled=0 WHERE publicationId=?').run(id) }
  close() { this.db.close() }
}
