import { DatabaseSync } from 'node:sqlite'
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto'
import { validateContactId, contactError } from './contact-id.mjs'
const agentSchema = `CREATE TABLE agents (registrationId TEXT PRIMARY KEY, publicationId TEXT UNIQUE, deviceId TEXT UNIQUE,
  tokenHash TEXT, displayName TEXT, enabled INTEGER DEFAULT 0, revision INTEGER DEFAULT 0, operationId TEXT,
  blocked INTEGER DEFAULT 0, generation INTEGER DEFAULT 0, expiresAt INTEGER, createdAt INTEGER,
  contactId TEXT CHECK(contactId IS NULL OR (length(contactId)=11 AND substr(contactId,1,1)='1'
    AND substr(contactId,2,1) BETWEEN '3' AND '9' AND contactId NOT GLOB '*[^0-9]*')))`
export const digest = value => createHash('sha256').update(value).digest('hex')
export class Store {
  constructor(path, maxRegistrations = 10000) {
    this.db = new DatabaseSync(path); this.maxRegistrations = maxRegistrations
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS agents (registrationId TEXT PRIMARY KEY, publicationId TEXT UNIQUE, deviceId TEXT UNIQUE,
      tokenHash TEXT, displayName TEXT, enabled INTEGER DEFAULT 0, revision INTEGER DEFAULT 0, operationId TEXT,
      blocked INTEGER DEFAULT 0, generation INTEGER DEFAULT 0, expiresAt INTEGER, createdAt INTEGER);
      CREATE UNIQUE INDEX IF NOT EXISTS agents_token_hash ON agents(tokenHash);`)
    // One authoritative allocator per Relay database. Numbers are never recycled.
    this.transaction(() => {
      if (!this.db.prepare('PRAGMA table_info(agents)').all().some(c => c.name === 'contactId')) {
        this.db.exec(`ALTER TABLE agents ADD COLUMN contactId TEXT CHECK(contactId IS NULL OR
          (length(contactId)=11 AND substr(contactId,1,1)='1' AND substr(contactId,2,1) BETWEEN '3' AND '9' AND contactId NOT GLOB '*[^0-9]*'))`)
      }
      // SQLite cannot alter CHECK constraints. Rebuild atomically, preserving every identity and state field.
      const definition = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='agents'").get().sql
      if (definition.includes("substr(contactId,1,3) IN ('138','139')")) {
        this.db.exec('ALTER TABLE agents RENAME TO agents_contact_v1')
        this.db.exec(agentSchema)
        this.db.exec('INSERT INTO agents SELECT * FROM agents_contact_v1; DROP TABLE agents_contact_v1')
      }
      this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS agents_token_hash ON agents(tokenHash)')
      this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS agents_contact_id ON agents(contactId);
        CREATE TABLE IF NOT EXISTS contact_number_sequence (id INTEGER PRIMARY KEY CHECK(id=1), next INTEGER NOT NULL);
        INSERT OR IGNORE INTO contact_number_sequence VALUES(1,13800000000);`)
      for (const row of this.db.prepare('SELECT registrationId FROM agents WHERE contactId IS NULL ORDER BY createdAt,registrationId').all()) {
        this.db.prepare('UPDATE agents SET contactId=? WHERE registrationId=?').run(this.nextContactId(), row.registrationId)
      }
      this.db.exec(`CREATE TRIGGER IF NOT EXISTS agents_contact_required BEFORE INSERT ON agents WHEN NEW.contactId IS NULL
        BEGIN SELECT RAISE(ABORT,'contactId required'); END;
        CREATE TRIGGER IF NOT EXISTS agents_contact_immutable BEFORE UPDATE OF contactId ON agents WHEN OLD.contactId IS NOT NULL AND NEW.contactId IS NOT OLD.contactId
        BEGIN SELECT RAISE(ABORT,'contactId immutable'); END;`)
    })
  }
  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = work(); this.db.exec('COMMIT'); return result }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  nextContactId() {
    let { next } = this.db.prepare('SELECT next FROM contact_number_sequence WHERE id=1').get()
    while (next <= 13999999999 && this.getByContactId(String(next))) next++
    if (next > 13999999999) throw Object.assign(new Error('Contact number capacity reached'), { status: 503 })
    this.db.prepare('UPDATE contact_number_sequence SET next=? WHERE id=1').run(next + 1)
    return String(next)
  }
  register(input) { return this.transaction(() => {
    validateContactId(input.contactId)
    const existing = this.db.prepare('SELECT * FROM agents WHERE registrationId=?').get(input.registrationId)
    if (existing) {
      if (existing.tokenHash !== input.deviceTokenHash) throw Object.assign(new Error('Registration conflict'), { status: 409 })
      if (input.contactId !== undefined && input.contactId !== existing.contactId) throw contactError('CONTACT_ID_IMMUTABLE', 'Registered contact ID cannot be changed')
      return existing
    }
    if (this.db.prepare('SELECT count(*) AS n FROM agents').get().n >= this.maxRegistrations) throw Object.assign(new Error('Registration capacity reached'), { status: 429 })
    if (this.db.prepare('SELECT publicationId FROM agents WHERE tokenHash=?').get(input.deviceTokenHash)) throw Object.assign(new Error('Credential already registered'), { status: 409 })
    const contactId = input.contactId ?? this.nextContactId()
    if (this.getByContactId(contactId)) throw contactError('CONTACT_ID_TAKEN', 'Contact ID is already registered')
    this.db.prepare('INSERT INTO agents(registrationId,publicationId,deviceId,tokenHash,displayName,createdAt,contactId) VALUES(?,?,?,?,?,?,?)')
      .run(input.registrationId, randomUUID(), randomUUID(), input.deviceTokenHash, input.displayName, Date.now(), contactId)
    return this.db.prepare('SELECT * FROM agents WHERE registrationId=?').get(input.registrationId)
  }) }
  get(id) { return this.db.prepare('SELECT * FROM agents WHERE publicationId=?').get(id) }
  getByContactId(id) { return this.db.prepare('SELECT * FROM agents WHERE contactId=?').get(id) }
  getMany(ids) { return ids.map(id=>this.get(id)).filter(Boolean) }
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
  health() { this.db.prepare('SELECT 1').get(); return true }
  close() { this.db.close() }
}
