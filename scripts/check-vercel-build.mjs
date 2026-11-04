#!/usr/bin/env node
// Reproduce Vercel's Linux packaging without copying cloud credentials or
// relying on Windows symlink privileges. This does not publish a deployment.
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, cp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { randomUUID } from 'node:crypto'
const exec = promisify(execFile)
const source = process.cwd(), stage = await mkdtemp(join(tmpdir(), 'relay-vercel-build-'))
const name = `relay-vercel-build-${randomUUID()}`
const image = 'node:24.19.0-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df'
const docker = async (...args) => (await exec('docker', args, { windowsHide: true, timeout: 60000, maxBuffer: 8 * 1024 * 1024 })).stdout.trim()
try {
  for (const entry of ['package.json', 'pnpm-lock.yaml', 'vercel.json', 'api', 'src', 'vendor', 'public']) {
    await cp(join(source, entry), join(stage, entry), { recursive: true })
  }
  const original = JSON.parse(await readFile(join(source, '.vercel/project.json'), 'utf8'))
  await mkdir(join(stage, '.vercel'))
  await writeFile(join(stage, '.vercel/project.json'), JSON.stringify({ projectId: original.projectId, orgId: original.orgId,
    projectName: original.projectName, settings: original.settings }))
  await writeFile(join(stage, '.vercel/.env.preview.local'), '# Build validation only; no cloud credentials.\n')
  await docker('create', '--name', name, '-w', '/app', '-e', 'CI=1', '-e', 'VERCEL_TELEMETRY_DISABLED=1', image,
    'node', '-e', 'setInterval(()=>{},60000)')
  await docker('cp', `${stage}/.`, `${name}:/app`)
  await docker('start', name)
  const commands = `const {execFileSync}=require('node:child_process');
    execFileSync('npm',['install','--global','vercel@65.10.0','pnpm@9.15.9'],{stdio:'inherit'});
    execFileSync('vercel',['build','--yes','--environment','preview','--standalone'],{stdio:'inherit'});`
  const child = spawn('docker', ['exec', '-w', '/app', name, 'node', '-e', commands], { windowsHide: true, stdio: 'inherit' })
  const status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code)) })
  if (status !== 0) throw new Error('Linux Vercel packaging failed')
  const inspect = `const fs=require('node:fs'),path=require('node:path');
    const root='/app/.vercel/output';
    function files(dir){if(!fs.existsSync(dir))return [];return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(path.join(dir,e.name)):[path.join(dir,e.name)])}
    const statics=files(root+'/static').map(f=>path.relative(root+'/static',f));
    if(statics.some(f=>f!=='robots.txt'))throw Error('Unexpected public build files');
    const configs=files(root+'/functions').filter(f=>f.endsWith('/.vc-config.json')).map(f=>{
      const c=JSON.parse(fs.readFileSync(f));return {path:path.relative(root,f),runtime:c.runtime,handler:c.handler,maxDuration:c.maxDuration,supportsResponseStreaming:c.supportsResponseStreaming};});
    if(configs.length!==1||configs[0].runtime!=='nodejs24.x')throw Error('Unexpected Function runtime');
    const output=JSON.parse(fs.readFileSync(root+'/config.json'));
    console.log(JSON.stringify({passed:true,node:process.version,functions:configs,statics,routes:output.routes}));`
  const report = JSON.parse(await docker('exec', name, 'node', '-e', inspect))
  if (process.env.RELAY_BUILD_REPORT) await writeFile(resolve(process.env.RELAY_BUILD_REPORT), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
} finally {
  await docker('rm', '-f', name).catch(() => {})
  const target = resolve(stage)
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('relay-vercel-build-')) throw new Error('Refusing cleanup outside the build temporary directory')
  await rm(target, { recursive: true, force: true })
}
