import { openRelay } from '../src/runtime.mjs'
import deployment from '../vercel.json' with { type: 'json' }

// Vercel accepts exported Node HTTP servers, including their upgrade listener.
// An HTTP request need not land on the instance holding its Connector socket.
const relay = await openRelay(process.env, { vercel: true, maxDurationSeconds: deployment.functions['api/relay.mjs'].maxDuration })
export default relay.server
