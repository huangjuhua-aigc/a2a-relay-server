import { openRelay } from '../../src/runtime.mjs'
const relay = await openRelay()
await new Promise(resolve => relay.server.listen(0, '127.0.0.1', resolve))
process.send({ kind: 'ready', port: relay.server.address().port, node: relay.cluster.bus.id })
process.on('message', message => {
  if (message.kind === 'stats') process.send({ kind: 'stats', id: message.id, sessions: relay.sessions.size,
    active: relay.active, incoming: relay.cluster.incoming.size, outgoing: relay.cluster.outgoing.size,
    redisReady: relay.cluster.bus.ready, command: relay.cluster.bus.command.status, subscriber: relay.cluster.bus.subscriber.status,
    subscribed: relay.cluster.bus.subscribed })
  if (message.kind === 'stop') void relay.close().then(() => process.exit(0))
})
