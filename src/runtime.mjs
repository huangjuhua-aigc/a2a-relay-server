import { createRelay } from './server.mjs'
import { openStore } from './open-store.mjs'
import { RedisBus, redisConfig } from './redis-bus.mjs'
import { ClusterForwarder } from './cluster.mjs'

export function relayLifecycle(env = process.env, { vercel = false, maxDurationSeconds = 300 } = {}) {
  if (vercel && ![300, 800].includes(maxDurationSeconds)) throw new Error('Unsupported Vercel duration; use a documented 300 or 800 second limit')
  const requestTimeout = Number(env.RELAY_REQUEST_TIMEOUT_MS ?? (vercel ? Math.min(600000, (maxDurationSeconds - 30) * 1000) : 600000))
  const connectionMaxAge = Number(env.RELAY_CONNECTION_MAX_AGE_MS ?? (vercel ? (maxDurationSeconds - 20) * 1000 : 0))
  if (!Number.isSafeInteger(requestTimeout) || requestTimeout < 1000 || requestTimeout > 600000 ||
      !Number.isSafeInteger(connectionMaxAge) || connectionMaxAge < 0 ||
      vercel && (requestTimeout > (maxDurationSeconds - 30) * 1000 || connectionMaxAge > (maxDurationSeconds - 20) * 1000 || connectionMaxAge < 1000)) {
    throw new Error('Relay lifecycle exceeds the configured function limit')
  }
  return { requestTimeout, connectionMaxAge }
}

export async function openRelay(env = process.env, { vercel = false, maxDurationSeconds = 300 } = {}) {
  if (!env.RELAY_ORIGIN) throw new Error('Set RELAY_ORIGIN to the canonical public HTTPS origin')
  const redisEnabled = !!(env.RELAY_REDIS_URL || env.RELAY_REDIS_URL_FILE)
  if ((vercel || redisEnabled) && (env.RELAY_STORE !== 'postgres' || !(env.RELAY_DATABASE_URL || env.RELAY_DATABASE_URL_FILE))) {
    throw new Error('Distributed deployment requires an explicit shared PostgreSQL database')
  }
  if (vercel && (!redisEnabled || env.VERCEL !== '1')) throw new Error('Vercel deployment requires Redis coordination and the Vercel runtime')
  const { requestTimeout, connectionMaxAge } = relayLifecycle(env, { vercel, maxDurationSeconds })
  const maxConcurrent = Number(env.RELAY_MAX_CONCURRENT ?? 64)
  let store, bus
  try {
    store = await openStore({ env })
    if (redisEnabled) bus = await new RedisBus(redisConfig(env)).start()
    const cluster = bus ? new ClusterForwarder({ bus, store, maxConcurrent, requestTimeout }) : undefined
    const relay = createRelay({ origin: env.RELAY_ORIGIN, store, cluster, requestTimeout, connectionMaxAge, maxConcurrent,
      allowHttp: env.RELAY_ALLOW_LOOPBACK_HTTP === '1', registrationEnabled: env.RELAY_REGISTRATION !== 'closed',
      maxRegistrations: Number(env.RELAY_MAX_REGISTRATIONS ?? 10000),
      registrationPerHour: Number(env.RELAY_REGISTRATIONS_PER_HOUR ?? 20),
      requestsPerMinute: Number(env.RELAY_REQUESTS_PER_MINUTE ?? 120), trustedVercelProxy: vercel,
      trustedProxyIPs: (env.RELAY_TRUSTED_PROXY_IPS ?? '').split(',').map(x => x.trim()).filter(Boolean) })
    return Object.assign(relay, { cluster })
  } catch {
    bus?.close(); await store?.close()
    throw new Error('Relay initialization failed. Check database, Redis, TLS, migrations and lifecycle configuration; credentials were not logged.')
  }
}
