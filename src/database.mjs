#!/usr/bin/env node
import { DatabaseSync } from 'node:sqlite'
import { openStore } from './open-store.mjs'
import { PostgresStore } from './postgres-store.mjs'

export function sqliteSnapshot(path) {
  const db = new DatabaseSync(path,{readOnly:true})
  try {
    db.exec('BEGIN')
    const rows = db.prepare('SELECT * FROM agents ORDER BY createdAt,registrationId').all()
    const next = db.prepare('SELECT next FROM contact_number_sequence WHERE id=1').get()?.next
    db.exec('COMMIT')
    return {rows,next}
  } finally { db.close() }
}
export async function databaseCommand(action, path, env=process.env) {
  if (!['migrate','check','import-sqlite'].includes(action)) throw new Error('Usage: node src/database.mjs migrate|check|import-sqlite <backup.db>')
  if (action === 'import-sqlite' && !path) throw new Error('A stopped or consistent SQLite backup is required')
  const store = await openStore({env:{...env,RELAY_STORE:'postgres'},migrate:action==='migrate'})
  try {
    if (!(store instanceof PostgresStore)) throw new Error('PostgreSQL configuration required')
    if (action === 'import-sqlite') return { imported:await store.importSnapshot(sqliteSnapshot(path)) }
    return {ok:true}
  } finally { await store.close() }
}
import { pathToFileURL } from 'node:url'
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await databaseCommand(process.argv[2],process.argv[3]))) }
  catch { console.error('Database command failed. Check connectivity, TLS, schema permissions and the selected source/target; no credentials were logged.');process.exitCode=1 }
}
