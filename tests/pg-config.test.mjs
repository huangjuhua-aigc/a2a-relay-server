import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { postgresConfig } from '../src/pg-config.mjs'

const url='postgresql://relay:encoded%40password@db.internal:5432/a2a_relay'
test('PostgreSQL config verifies TLS and rejects URL-based TLS overrides',()=>{
  const config=postgresConfig({RELAY_DATABASE_URL:url})
  assert.equal(config.ssl.rejectUnauthorized,true)
  assert.equal(config.password,'encoded@password')
  assert.equal(config.connectionString,undefined)
  for(const query of ['sslmode=disable','sslmode=require','sslmode=no-verify','sslrootcert=bad','sslmode=verify-full&sslmode=disable']) {
    assert.throws(()=>postgresConfig({RELAY_DATABASE_URL:`${url}?${query}`}),error=>!error.message.includes('encoded'))
  }
  assert.throws(()=>postgresConfig({RELAY_DATABASE_URL:'not-a-url-with-secret'}),error=>!error.message.includes('not-a-url'))
  assert.throws(()=>postgresConfig({RELAY_DATABASE_URL:url,RELAY_DATABASE_URL_FILE:'another'}))
})
test('only explicitly enabled loopback tests can disable database TLS',()=>{
  const local='postgresql://relay:pw@127.0.0.1/test?sslmode=disable'
  assert.throws(()=>postgresConfig({RELAY_DATABASE_URL:local}))
  assert.equal(postgresConfig({RELAY_DATABASE_URL:local,RELAY_PG_ALLOW_INSECURE_LOOPBACK:'1'}).ssl,false)
  assert.throws(()=>postgresConfig({RELAY_DATABASE_URL:local.replace('127.0.0.1','10.0.0.3'),RELAY_PG_ALLOW_INSECURE_LOOPBACK:'1'}))
})
test('database URL and CA can be read from private mounted files',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'relay-pg-config-'))
  try {
    await writeFile(join(dir,'url'),url+'\n'); await writeFile(join(dir,'ca'),'example-root-ca')
    const config=postgresConfig({RELAY_DATABASE_URL_FILE:join(dir,'url'),RELAY_PG_CA_FILE:join(dir,'ca')})
    assert.equal(config.database,'a2a_relay');assert.equal(config.ssl.ca,'example-root-ca');assert.equal(config.ssl.rejectUnauthorized,true)
  } finally {await rm(dir,{recursive:true,force:true})}
})

test('serverless PostgreSQL uses a bounded pool and accepts an injected CA without disabling verification',()=>{
  const config=postgresConfig({RELAY_DATABASE_URL:url,VERCEL:'1',RELAY_PG_CA:'example-root-ca'})
  assert.equal(config.max,2);assert.equal(config.ssl.ca,'example-root-ca');assert.equal(config.ssl.rejectUnauthorized,true)
  assert.throws(()=>postgresConfig({RELAY_DATABASE_URL:url,RELAY_PG_POOL_SIZE:'0'}))
  assert.throws(()=>postgresConfig({RELAY_DATABASE_URL:url,RELAY_PG_POOL_SIZE:'1000'}))
  assert.throws(()=>postgresConfig({RELAY_DATABASE_URL:url,RELAY_PG_CA:'ca',RELAY_PG_CA_FILE:'another'}))
})
