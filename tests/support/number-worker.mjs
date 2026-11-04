import { parentPort, workerData } from 'node:worker_threads'
import { randomUUID } from 'node:crypto'
import { Store, digest } from '../../src/store.mjs'
const store = new Store(workerData.database)
try {
  const rows = [store.register(workerData.shared)]
  for (let i = 0; i < 25; i++) rows.push(store.register({ registrationId: randomUUID(), deviceTokenHash: digest(randomUUID()), displayName: 'Same name' }))
  parentPort.postMessage(rows.map(({ registrationId, contactId }) => ({ registrationId, contactId })))
} finally { store.close() }
