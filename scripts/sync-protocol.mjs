import { copyFile, mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
if (!process.argv[2]) throw new Error('Usage: node scripts/sync-protocol.mjs <Talk2MyAgent>/packages/a2a-relay-protocol')
const source = resolve(process.argv[2]), destination = new URL('../vendor/a2a-relay-protocol/', import.meta.url)
await mkdir(destination, { recursive: true })
for (const name of ['index.mjs','package.json','LICENSE']) await copyFile(join(source, name), new URL(name, destination))
console.log('Protocol snapshot updated; run pnpm install and integration tests before committing.')
