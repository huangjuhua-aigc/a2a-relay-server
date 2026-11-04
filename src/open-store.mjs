import { dirname, resolve } from 'node:path'
import { mkdirSync, existsSync } from 'node:fs'
import { Store } from './store.mjs'
import { PostgresStore } from './postgres-store.mjs'
import { postgresConfig } from './pg-config.mjs'

export async function openStore({ env = process.env, migrate = false, create = true } = {}) {
  const hasURL = !!(env.RELAY_DATABASE_URL || env.RELAY_DATABASE_URL_FILE)
  const kind = env.RELAY_STORE ?? (hasURL ? 'postgres' : 'sqlite')
  const max = Number(env.RELAY_MAX_REGISTRATIONS ?? 10000)
  if (!Number.isSafeInteger(max) || max < 1) throw new Error('Invalid registration limit')
  if (kind === 'sqlite') {
    if (hasURL) throw new Error('SQLite configuration conflicts with a PostgreSQL URL')
    const database = resolve(env.RELAY_DATABASE ?? 'data/relay.db')
    if (!create && !existsSync(database)) throw new Error('Existing SQLite database required')
    mkdirSync(dirname(database), { recursive: true, mode: 0o700 })
    return new Store(database,max)
  }
  if (kind !== 'postgres') throw new Error('RELAY_STORE must be sqlite or postgres')
  const store = new PostgresStore(postgresConfig(env),max)
  try { if (migrate) await store.migrate(); await store.health(); return store }
  catch (error) { await store.close(); throw error }
}
