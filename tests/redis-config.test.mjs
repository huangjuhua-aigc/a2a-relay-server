import { test } from 'node:test'
import assert from 'node:assert/strict'
import { redisConfig } from '../src/redis-bus.mjs'
import { openRelay, relayLifecycle } from '../src/runtime.mjs'

test('Redis requires TLS, credentials and an explicit environment namespace', () => {
  const base = { RELAY_REDIS_URL: 'rediss://default:secret@redis.example.test:6379', RELAY_REDIS_NAMESPACE: 'production' }
  assert.equal(redisConfig(base).namespace, 'production')
  for (const value of ['redis://default:secret@redis.example.test', 'https://redis.example.test', 'rediss://redis.example.test', 'rediss://default:secret@redis.example.test?tls=false']) {
    assert.throws(() => redisConfig({ ...base, RELAY_REDIS_URL: value }))
  }
  assert.throws(() => redisConfig({ ...base, RELAY_REDIS_NAMESPACE: '' }))
  assert.throws(() => redisConfig({ ...base, RELAY_REDIS_URL_FILE: 'not-read' }))
  assert.throws(() => redisConfig({ ...base, RELAY_REDIS_URL: 'redis://127.0.0.1:6379' }))
  assert.ok(redisConfig({ ...base, RELAY_REDIS_URL: 'redis://127.0.0.1:6379', RELAY_REDIS_ALLOW_INSECURE_LOOPBACK: '1' }))
})

test('Vercel cannot silently create an ephemeral SQLite registry or run without coordination', async () => {
  await assert.rejects(openRelay({ RELAY_ORIGIN: 'https://relay.example.test' }, { vercel: true }), /shared PostgreSQL/)
  await assert.rejects(openRelay({ RELAY_ORIGIN: 'https://relay.example.test', RELAY_STORE: 'postgres', RELAY_DATABASE_URL: 'redacted' }, { vercel: true }), /Redis coordination/)
})

test('function duration sets conservative request and connector lifetimes without silently dropping the configured cap', () => {
  assert.deepEqual(relayLifecycle({}, { vercel: true }), { requestTimeout: 270000, connectionMaxAge: 280000 })
  assert.deepEqual(relayLifecycle({}, { vercel: true, maxDurationSeconds: 800 }), { requestTimeout: 600000, connectionMaxAge: 780000 })
  assert.deepEqual(relayLifecycle({}), { requestTimeout: 600000, connectionMaxAge: 0 })
  assert.throws(() => relayLifecycle({ RELAY_CONNECTION_MAX_AGE_MS: '0' }, { vercel: true }))
  assert.throws(() => relayLifecycle({ RELAY_REQUEST_TIMEOUT_MS: '600000' }, { vercel: true }))
  assert.throws(() => relayLifecycle({}, { vercel: true, maxDurationSeconds: 1800 }))
})
