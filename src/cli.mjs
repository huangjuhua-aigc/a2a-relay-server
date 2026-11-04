#!/usr/bin/env node
import { openRelay } from './runtime.mjs'
process.umask(0o077)
let relay
try { relay = await openRelay() }
catch { console.error('Relay initialization failed. Check database, Redis, TLS and configuration; credentials were not logged.'); process.exit(1) }
relay.server.listen(Number(process.env.PORT ?? 8787), process.env.RELAY_BIND ?? '127.0.0.1', () => console.log('A2A Relay listening'))
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => { void relay.close().then(() => process.exit(0),()=>process.exit(1)) })
