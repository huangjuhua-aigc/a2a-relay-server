#!/usr/bin/env node
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createRelay } from './server.mjs'
const database = resolve(process.env.RELAY_DATABASE ?? 'data/relay.db')
if (!process.env.RELAY_ORIGIN) throw new Error('Set RELAY_ORIGIN to the canonical public HTTPS origin')
process.umask(0o077)
mkdirSync(dirname(database), { recursive: true, mode: 0o700 })
const relay = createRelay({ origin: process.env.RELAY_ORIGIN, database,
  allowHttp: process.env.RELAY_ALLOW_LOOPBACK_HTTP === '1', registrationEnabled: process.env.RELAY_REGISTRATION !== 'closed',
  maxRegistrations: Number(process.env.RELAY_MAX_REGISTRATIONS ?? 10000),
  registrationPerHour: Number(process.env.RELAY_REGISTRATIONS_PER_HOUR ?? 20),
  requestsPerMinute: Number(process.env.RELAY_REQUESTS_PER_MINUTE ?? 120),
  trustedProxyIPs: (process.env.RELAY_TRUSTED_PROXY_IPS ?? '').split(',').filter(Boolean) })
relay.server.listen(Number(process.env.PORT ?? 8787), process.env.RELAY_BIND ?? '127.0.0.1', () => console.log('A2A Relay listening'))
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => { void relay.close().then(() => process.exit(0)) })
