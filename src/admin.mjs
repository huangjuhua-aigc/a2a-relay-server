#!/usr/bin/env node
// Local operator command. No administration surface is exposed over HTTP.
import { openStore } from './open-store.mjs'
const [action,id] = process.argv.slice(2)
if (action !== 'revoke' || !id) throw new Error('Usage: node src/admin.mjs revoke <publicationId>; configure the existing Relay database')
let store
try {
  store=await openStore({create:false})
  if (!await store.get(id)) throw new Error('Publication not found')
  await store.revoke(id)
  console.log('Revoked. New requests are rejected; active tunnels close at the next heartbeat (within 20 seconds).')
} catch { console.error('Revocation failed. Check the publication ID, database configuration, TLS and permissions; no credentials were logged.');process.exitCode=1 }
finally { await store?.close() }
