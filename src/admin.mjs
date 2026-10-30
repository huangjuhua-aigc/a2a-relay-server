#!/usr/bin/env node
// Local operator command. No administration surface is exposed over HTTP.
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { Store } from './store.mjs'
const [action,id] = process.argv.slice(2), path = resolve(process.env.RELAY_DATABASE ?? 'data/relay.db')
if (action !== 'revoke' || !id || !existsSync(path)) throw new Error('Usage: node src/admin.mjs revoke <publicationId>; set RELAY_DATABASE to an existing database')
const store = new Store(path)
try {
  if (!store.get(id)) throw new Error('Publication not found')
  store.revoke(id)
  console.log('Revoked. New requests are rejected; active tunnels close at the next heartbeat (within 20 seconds).')
} finally { store.close() }
