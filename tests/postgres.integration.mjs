import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Pool } from 'pg'
import { randomUUID,randomBytes } from 'node:crypto'
import { mkdtemp,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PostgresStore } from '../src/postgres-store.mjs'
import { postgresConfig } from '../src/pg-config.mjs'
import { Store,digest } from '../src/store.mjs'
import { sqliteSnapshot } from '../src/database.mjs'
import { createRelay } from '../src/server.mjs'

const input=()=>({registrationId:randomUUID(),deviceTokenHash:digest(randomUUID()),displayName:'同名 Agent',protocolVersion:'1.0'})
const connection=process.env.RELAY_TEST_POSTGRES_URL
const pgTest=(name,fn)=>test(name,{skip:!connection},fn)
async function fixture(max=10000) {
  const url=new URL(connection)
  if(url.hostname!=='127.0.0.1')throw new Error('Integration tests require a disposable loopback PostgreSQL server')
  const config=postgresConfig({RELAY_DATABASE_URL:connection,RELAY_PG_ALLOW_INSECURE_LOOPBACK:'1'})
  const admin=new Pool(config), database=`relay_test_${randomUUID().replaceAll('-','')}`
  const stores=[]
  await admin.query(`CREATE DATABASE ${database}`)
  const create=()=>{const store=new PostgresStore({...config,database},max);stores.push(store);return store}
  const store=create();await store.migrate()
  return {store,create,config:{...config,database},async close(){await Promise.all(stores.map(s=>s.close()));await admin.query(`DROP DATABASE ${database}`);await admin.end()}}
}
async function listening(store) {
  const relay=createRelay({origin:'https://relay.example.test',store,registrationPerHour:1000,requestsPerMinute:10000})
  await new Promise(r=>relay.server.listen(0,'127.0.0.1',r))
  return {relay,base:`http://127.0.0.1:${relay.server.address().port}`}
}
async function until(fn,timeout=10000){const start=Date.now();while(!await fn()){if(Date.now()-start>timeout)throw new Error('Condition timed out');await new Promise(r=>setTimeout(r,25))}}

pgTest('PostgreSQL transactions serialize independent allocators, idempotence and capacity',async()=>{
  const f=await fixture(200)
  try {
    const stores=[f.store,f.create(),f.create(),f.create()]
    await Promise.all(stores.map(s=>s.migrate()))
    const shared=input()
    const retry=await Promise.all(Array.from({length:32},(_,i)=>stores[i%4].register(shared)))
    assert.equal(new Set(retry.map(r=>r.contactId)).size,1)
    const users=await Promise.all(Array.from({length:120},(_,i)=>stores[i%4].register(input())))
    assert.equal(new Set(users.map(r=>r.contactId)).size,120)
    assert.equal(Number((await f.store.pool.query('SELECT count(*) n FROM a2a_relay.agents')).rows[0].n),121)
    await assert.rejects(f.store.register({...shared,deviceTokenHash:digest('wrong')}),e=>e.status===409)
    await assert.rejects(f.store.pool.query('UPDATE a2a_relay.agents SET contact_id=$1 WHERE publication_id=$2',['13911111111',users[0].publicationId]),/immutable/)
    await assert.rejects(f.store.pool.query('INSERT INTO a2a_relay.agents(registration_id,publication_id,device_id,token_hash,display_name,created_at,contact_id) VALUES($1,$2,$3,$4,$5,1,$6)',[randomUUID(),randomUUID(),randomUUID(),digest(randomUUID()),'duplicate',users[0].contactId]),e=>e.code==='23505')
    const tiny=f.create();tiny.maxRegistrations=122
    const capacity=await Promise.allSettled(Array.from({length:8},()=>tiny.register(input())))
    assert.equal(capacity.filter(r=>r.status==='fulfilled').length,1)
    assert.ok(capacity.filter(r=>r.status==='rejected').every(r=>r.reason.status===429))
  } finally {await f.close()}
})

pgTest('PostgreSQL upgrades the old constraint and reserves chosen numbers across competing connections',async()=>{
  const f=await fixture()
  try {
    const original=await f.store.register(input())
    await f.store.pool.query("ALTER TABLE a2a_relay.agents DROP CONSTRAINT agents_contact_id_check; ALTER TABLE a2a_relay.agents ADD CONSTRAINT agents_contact_id_check CHECK (contact_id ~ '^13[89][0-9]{8}$'); DELETE FROM a2a_relay.schema_migrations WHERE version=2")
    const stores=[f.store,f.create(),f.create(),f.create()]
    await Promise.all(stores.map(s=>s.migrate()))
    assert.equal((await f.store.get(original.publicationId)).contactId,original.contactId)
    const chosen={...input(),contactId:'18612345678'}
    const same=await Promise.all(stores.map(s=>s.register(chosen)))
    assert.equal(new Set(same.map(r=>r.publicationId)).size,1)
    const collision=await Promise.allSettled(Array.from({length:16},(_,i)=>stores[i%4].register({...input(),contactId:'19912345678'})))
    assert.equal(collision.filter(r=>r.status==='fulfilled').length,1)
    assert(collision.filter(r=>r.status==='rejected').every(r=>r.reason.status===409&&r.reason.code==='CONTACT_ID_TAKEN'))
    await assert.rejects(f.store.register({...chosen,contactId:'18512345678'}),e=>e.code==='CONTACT_ID_IMMUTABLE')
    await assert.rejects(f.store.register({...input(),contactId:'../18612345678'}),e=>e.status===400)
    await f.store.register({...input(),contactId:'13800000001'})
    assert.equal((await f.store.register(input())).contactId,'13800000002')
    assert.equal((await f.store.getByContactId(chosen.contactId)).publicationId,same[0].publicationId)
  } finally {await f.close()}
})

pgTest('PostgreSQL number boundaries, atomic revisions, revocation and durable reopen',async()=>{
  const f=await fixture()
  try {
    await f.store.pool.query('UPDATE a2a_relay.contact_number_sequence SET next=13899999999')
    const a=await f.store.register(input());assert.equal(a.contactId,'13899999999')
    const b=await f.store.register(input());assert.equal(b.contactId,'13900000000')
    const outcomes=await Promise.allSettled(Array.from({length:20},(_,i)=>f.store.intent(b,i%2===0,i+1,randomUUID())))
    assert.ok(outcomes.some(r=>r.status==='fulfilled'))
    assert.equal((await f.store.get(b.publicationId)).revision,20)
    await f.store.revoke(b.publicationId)
    await assert.rejects(f.store.intent(b,true,21,randomUUID()),e=>e.status===403)
    await f.store.pool.query('UPDATE a2a_relay.contact_number_sequence SET next=13999999999')
    assert.equal((await f.store.register(input())).contactId,'13999999999')
    await assert.rejects(f.store.register(input()),e=>e.status===503)
    await f.store.close()
    const reopened=f.create();await reopened.health()
    assert.equal((await reopened.get(b.publicationId)).blocked,1)
    assert.equal((await reopened.get(a.publicationId)).contactId,a.contactId)
    assert.equal(Number((await reopened.pool.query('SELECT count(*) n FROM a2a_relay.agents')).rows[0].n),3)
  } finally {await f.close()}
})

pgTest('SQLite import preserves identity and never rolls back the allocation sequence',async()=>{
  const f=await fixture(),dir=await mkdtemp(join(tmpdir(),'relay-import-')),path=join(dir,'source.db')
  const sqlite=new Store(path)
  let sourceClosed=false
  try {
    const token=randomBytes(32).toString('hex'),user={...input(),deviceTokenHash:digest(token)}
    const row=sqlite.register(user);sqlite.intent(row,true,7,randomUUID());sqlite.generation(row.publicationId)
    sqlite.db.prepare('UPDATE contact_number_sequence SET next=?').run(13988888888)
    sqlite.close();sourceClosed=true
    const snapshot=sqliteSnapshot(path)
    assert.equal(await f.store.importSnapshot(snapshot),1)
    const imported=await f.store.authenticate(`Bearer ${token}`)
    assert.deepEqual(imported,{...snapshot.rows[0]})
    assert.equal((await f.store.register(user)).publicationId,row.publicationId)
    assert.equal((await f.store.register(input())).contactId,'13988888888')
    await assert.rejects(f.store.importSnapshot(snapshot),e=>e.status===409)
  } finally {if(!sourceClosed)sqlite.close();await f.close();await rm(dir,{recursive:true,force:true})}
})

pgTest('HTTP with PostgreSQL protects credentials and keeps liveness during a database failure',async()=>{
  const f=await fixture(),{relay,base}=await listening(f.store)
  try {
    const token=randomBytes(32).toString('hex'),body={...input(),deviceTokenHash:digest(token)}
    const reg=await fetch(`${base}/v1/agents/register`,{method:'POST',body:JSON.stringify(body)})
    assert.equal(reg.status,200);const publication=await reg.json()
    assert.match(publication.contactId,/^13[89]\d{8}$/)
    assert.equal((await fetch(`${base}/v1/publication`)).status,401)
    assert.equal((await fetch(`${base}/ready`)).status,200)
    // Close the real pool to model unavailable persistence; no raw SQL/credentials leak.
    await f.store.close()
    assert.equal((await fetch(`${base}/health`)).status,200)
    assert.equal((await fetch(`${base}/ready`)).status,503)
    const failed=await fetch(`${base}/v1/publication`,{headers:{authorization:`Bearer ${token}`}})
    assert.equal(failed.status,503)
    assert.deepEqual(await failed.json(),{error:'Database unavailable; operation outcome may be unknown'})
  } finally {await relay.close();await f.close()}
})

pgTest('PostgreSQL runtime works with DML-only privileges and refuses an unencrypted remote connection by default',async()=>{
  const f=await fixture(),role=`relay_app_${randomUUID().replaceAll('-','')}`
  let runtime
  try {
    // Generated role name contains no user input. Permission tests do not need a password login.
    await f.store.pool.query(`CREATE ROLE ${role}`)
    await f.store.pool.query(`GRANT USAGE ON SCHEMA a2a_relay TO ${role}; GRANT SELECT,INSERT,UPDATE ON a2a_relay.agents,a2a_relay.contact_number_sequence TO ${role}; GRANT SELECT ON a2a_relay.schema_migrations TO ${role}`)
    const client=await f.store.pool.connect()
    try {await client.query(`SET ROLE ${role}`);await client.query('SELECT * FROM a2a_relay.schema_migrations');await assert.rejects(client.query('CREATE TABLE a2a_relay.forbidden(id int)'),e=>e.code==='42501')}
    finally {await client.query('RESET ROLE');client.release()}
    runtime=new PostgresStore({...f.config,options:`-c role=${role}`})
    await runtime.health();const row=await runtime.register(input());await runtime.intent(row,true,1,randomUUID());await runtime.generation(row.publicationId);await runtime.revoke(row.publicationId)
    const tls=new PostgresStore({...f.config,ssl:{rejectUnauthorized:true}})
    try {await assert.rejects(tls.health(),e=>e.status===503)}finally{await tls.close()}
  } finally {
    await runtime?.close()
    await f.store.pool.query(`DROP OWNED BY ${role}; DROP ROLE ${role}`).catch(()=>{})
    await f.close()
  }
})

pgTest('real Connector over PostgreSQL: stream, reconnect without replay, offline identity and revocation',async t=>{
  if(!process.env.A2A_CONNECTOR_SOURCE){t.skip('Set A2A_CONNECTOR_SOURCE for the cross-repository Connector test');return}
  const {Connector}=await import(pathToFileURL(join(process.env.A2A_CONNECTOR_SOURCE,'src','connector.mjs')))
  const {createServer}=await import('node:http')
  const f=await fixture();let calls=0,snapshot,c
  const local=createServer(async(req,res)=>{
    if(req.url==='/.well-known/agent-card.json') {
      res.setHeader('content-type','application/json');res.end(JSON.stringify({name:'PG test agent',supportedInterfaces:[{url:'http://127.0.0.1/a2a',protocolBinding:'JSONRPC',protocolVersion:'1.0'}],capabilities:{streaming:true},skills:[]}));return
    }
    calls++;if(req.headers.authorization!=='Bearer visitor'){res.writeHead(401);res.end();return}
    for await(const _ of req){};res.writeHead(200,{'content-type':'text/event-stream'})
    res.write('data: 你好\n\n');setTimeout(()=>res.end('data: 🌈\n\n'),25)
  })
  await new Promise(r=>local.listen(0,'127.0.0.1',r))
  const reserve=createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r))
  const origin=`http://127.0.0.1:${port}`,r=createRelay({origin,allowHttp:true,store:f.store,requestsPerMinute:1000})
  await new Promise(done=>r.server.listen(port,'127.0.0.1',done))
  const state={registrations:{},desiredEnabled:true,revision:1,operationId:randomUUID(),cloudSyncPending:true}
  try {
    const base=`http://127.0.0.1:${local.address().port}`
    c=new Connector({config:{relayOrigin:origin,localRpcUrl:`${base}/a2a`,localCardUrl:`${base}/.well-known/agent-card.json`,displayName:'PG Connector',allowHttp:true},state,save:async()=>{},onStatus:s=>{snapshot=s}})
    void c.start();await until(()=>snapshot?.state==='online')
    const info=state.registrations[origin].info
    const request=()=>fetch(info.publicRpcUrl,{method:'POST',headers:{authorization:'Bearer visitor'},body:'{}'})
    assert.equal(await(await request()).text(),'data: 你好\n\ndata: 🌈\n\n')
    const previous=r.sessions.get(info.publicationId).connectionId
    for(const s of r.sessions.values())s.ws.terminate()
    await until(()=>snapshot?.state==='online'&&r.sessions.get(info.publicationId)?.ready&&r.sessions.get(info.publicationId)?.connectionId!==previous)
    assert.equal(calls,1)
    assert.equal(snapshot.contactId,info.contactId)
    assert.equal((await request()).status,200)
    await r.revoke(info.publicationId);await until(()=>snapshot?.state==='blocked')
    assert.equal((await request()).status,503)
  } finally {c?.stop();local.closeAllConnections();await new Promise(r=>local.close(r));await r.close();await f.close()}
})
