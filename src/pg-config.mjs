import { readFileSync } from 'node:fs'

export function postgresConfig(env = process.env) {
  if (env.RELAY_DATABASE_URL && env.RELAY_DATABASE_URL_FILE) throw new Error('Set only one database URL source')
  let value = env.RELAY_DATABASE_URL
  if (env.RELAY_DATABASE_URL_FILE) {
    try { value = readFileSync(env.RELAY_DATABASE_URL_FILE, 'utf8').trim() }
    catch { throw new Error('Cannot read RELAY_DATABASE_URL_FILE') }
  }
  let url
  try { url = new URL(value) } catch { throw new Error('A valid PostgreSQL database URL is required') }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.password || !url.pathname.slice(1) || url.hash) {
    throw new Error('Database URL must contain PostgreSQL host, database, user and password')
  }
  // Parse fields explicitly: pg connectionString SSL parameters can overwrite
  // a supplied ssl object and silently discard its CA/verification settings.
  for (const key of url.searchParams.keys()) if (key !== 'sslmode') throw new Error('Unsupported database URL option; configure TLS using RELAY_PG_CA_FILE')
  if (url.searchParams.getAll('sslmode').length > 1) throw new Error('Only one sslmode is allowed')
  const mode = url.searchParams.get('sslmode') ?? 'verify-full'
  if (mode !== 'verify-full' && !(mode === 'disable' && env.RELAY_PG_ALLOW_INSECURE_LOOPBACK === '1' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))) {
    throw new Error('PostgreSQL requires sslmode=verify-full; plaintext is allowed only for explicit loopback tests')
  }
  if (env.RELAY_PG_CA && env.RELAY_PG_CA_FILE) throw new Error('Set only one PostgreSQL CA source')
  let ca = env.RELAY_PG_CA
  if (env.RELAY_PG_CA_FILE) {
    try { ca = readFileSync(env.RELAY_PG_CA_FILE, 'utf8') }
    catch { throw new Error('Cannot read RELAY_PG_CA_FILE') }
  }
  let user, password, database
  try { user=decodeURIComponent(url.username); password=decodeURIComponent(url.password); database=decodeURIComponent(url.pathname.slice(1)) }
  catch { throw new Error('Database URL has invalid escaping') }
  const port = Number(url.port || 5432)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid database port')
  const poolSize = Number(env.RELAY_PG_POOL_SIZE ?? (env.VERCEL === '1' ? 2 : 10))
  if (!Number.isSafeInteger(poolSize) || poolSize < 1 || poolSize > 20) throw new Error('Invalid PostgreSQL pool size')
  return { host: url.hostname.replace(/^\[|\]$/g, ''), port, user, password, database,
    ssl: mode === 'disable' ? false : { rejectUnauthorized: true, ...(ca ? { ca } : {}) },
    max: poolSize, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000,
    statement_timeout: 5000, query_timeout: 6000, application_name: 'a2a-relay' }
}
