#!/usr/bin/env node
// All containers and volumes belong to this invocation. No cloud credentials
// or production databases are used, and Redis is only exposed on loopback.
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID, randomBytes } from 'node:crypto'
import net from 'node:net'
const exec = promisify(execFile)
const name = `relay-cluster-test-${randomUUID()}`, pgName = `${name}-pg`, redisName = `${name}-redis`, volume = `${name}-data`
const password = randomBytes(24).toString('hex')
const docker = async (...args) => (await exec('docker', args, { windowsHide: true, timeout: 60000,
  env: { ...process.env, POSTGRES_PASSWORD: password } })).stdout.trim()
let exit = 1
try {
  if (!process.env.A2A_CONNECTOR_SOURCE) throw new Error('Set A2A_CONNECTOR_SOURCE to the real Connector source')
  await docker('volume', 'create', volume)
  await docker('run', '-d', '--name', pgName, '-e', 'POSTGRES_PASSWORD', '--mount', `type=volume,source=${volume},target=/var/lib/postgresql/data`, '-p', '127.0.0.1::5432', 'postgres:17-alpine')
  const reservation = net.createServer()
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve))
  const reservedPort = reservation.address().port
  await new Promise(resolve => reservation.close(resolve))
  await docker('run', '-d', '--name', redisName, '-p', `127.0.0.1:${reservedPort}:6379`, 'redis:7.4.7-alpine', 'redis-server', '--save', '', '--appendonly', 'no')
  let ready = false
  for (let i = 0; i < 60; i++) {
    try { await docker('exec', pgName, 'pg_isready', '-U', 'postgres'); await docker('exec', redisName, 'redis-cli', 'ping'); ready = true; break }
    catch { await new Promise(resolve => setTimeout(resolve, 250)) }
  }
  if (!ready) throw new Error('Disposable databases did not become ready')
  const pgPort = Number((await docker('port', pgName, '5432')).split(':').at(-1))
  const redisPort = Number((await docker('port', redisName, '6379')).split(':').at(-1))
  const child = spawn(process.execPath, ['--test', ...process.argv.slice(2), 'tests/cluster.integration.mjs'], { windowsHide: true, stdio: 'inherit',
    env: { ...process.env, RELAY_TEST_POSTGRES_URL: `postgresql://postgres:${password}@127.0.0.1:${pgPort}/postgres?sslmode=disable`,
      RELAY_TEST_REDIS_URL: `redis://127.0.0.1:${redisPort}`, RELAY_TEST_REDIS_CONTAINER: redisName } })
  exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)) })
} catch (error) {
  console.error(error.message === 'Set A2A_CONNECTOR_SOURCE to the real Connector source' ? error.message : 'Cluster tests could not finish. Check Docker; credentials were not logged.')
} finally {
  await docker('rm', '-f', pgName).catch(() => {})
  await docker('rm', '-f', redisName).catch(() => {})
  await docker('volume', 'rm', volume).catch(() => {})
}
process.exitCode = exit
