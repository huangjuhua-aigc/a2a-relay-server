#!/usr/bin/env node
// Starts a disposable local PostgreSQL. Never uses production connection files.
import { execFile,spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID,randomBytes } from 'node:crypto'
const exec=promisify(execFile), name=`relay-pg-test-${randomUUID()}`, volume=`${name}-data`
const password=randomBytes(24).toString('hex')
const env={...process.env,POSTGRES_PASSWORD:password}
const docker=async(...args)=>(await exec('docker',args,{env,windowsHide:true,timeout:60000})).stdout.trim()
let exit=1
try {
  await docker('volume','create',volume)
  await docker('run','-d','--name',name,'-e','POSTGRES_PASSWORD','--mount',`type=volume,source=${volume},target=/var/lib/postgresql/data`,'-p','127.0.0.1::5432','postgres:17-alpine')
  let ready=false
  for(let i=0;i<60;i++){try{await docker('exec',name,'pg_isready','-U','postgres');ready=true;break}catch{await new Promise(r=>setTimeout(r,250))}}
  if(!ready)throw new Error('Temporary PostgreSQL did not become ready')
  const port=Number((await docker('port',name,'5432')).split(':').at(-1))
  const child=spawn(process.execPath,['--test','tests/postgres.integration.mjs'],{windowsHide:true,stdio:'inherit',env:{...process.env,
    RELAY_TEST_POSTGRES_URL:`postgresql://postgres:${password}@127.0.0.1:${port}/postgres?sslmode=disable`}})
  exit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>resolve(code??1))})
} catch {console.error('Local PostgreSQL tests could not finish; check Docker availability. Credentials were not logged.')}
finally {await docker('rm','-f',name).catch(()=>{});await docker('volume','rm',volume).catch(()=>{})}
process.exitCode=exit
