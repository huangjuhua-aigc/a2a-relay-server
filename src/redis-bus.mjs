import { EventEmitter } from 'node:events'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import Redis from 'ioredis'
import { idPattern, LIMIT } from '@talk2myagent/a2a-relay-protocol'

const unavailable = () => Object.assign(new Error('Relay coordination unavailable; delivery may be unknown'), { status: 503 })

export function redisConfig(env = process.env) {
  if (env.RELAY_REDIS_URL && env.RELAY_REDIS_URL_FILE) throw new Error('Set only one Redis URL source')
  let value = env.RELAY_REDIS_URL
  if (env.RELAY_REDIS_URL_FILE) {
    try { value = readFileSync(env.RELAY_REDIS_URL_FILE, 'utf8').trim() }
    catch { throw new Error('Cannot read RELAY_REDIS_URL_FILE') }
  }
  let url
  try { url = new URL(value) } catch { throw new Error('A Redis URL is required') }
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
  if (!(url.protocol === 'rediss:' || url.protocol === 'redis:' && loopback && env.RELAY_REDIS_ALLOW_INSECURE_LOOPBACK === '1') ||
      url.search || url.hash || !['', '/', '/0'].includes(url.pathname) || !url.password && !loopback) {
    throw new Error('Redis requires a credentialed TLS URL; plaintext is only allowed for explicit loopback tests')
  }
  const namespace = env.RELAY_REDIS_NAMESPACE
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(namespace ?? '')) throw new Error('Set a separate RELAY_REDIS_NAMESPACE for each environment')
  return { url: url.toString(), namespace }
}

// Pub/Sub carries transient bytes only. Redis keys contain leases, counters and
// request IDs, never visitor tokens, chat bodies or response content.
export class RedisBus extends EventEmitter {
  constructor({ url, namespace, leaseMs = 60000, commandTimeout = 5000 }) {
    super()
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(namespace ?? '') || !Number.isSafeInteger(leaseMs) || leaseMs < 1000) throw new Error('Invalid Redis coordination settings')
    this.id = randomUUID()
    this.prefix = `a2a-relay:{${namespace}}:`
    this.leaseMs = leaseMs
    const options = { lazyConnect: true, connectTimeout: 5000, commandTimeout,
      enableOfflineQueue: false, maxRetriesPerRequest: 0, autoResendUnfulfilledCommands: false,
      retryStrategy: attempt => Math.min(3000, 100 * attempt) }
    this.command = new Redis(url, options)
    this.subscriber = new Redis(url, options)
    this.channel = this.nodeChannel(this.id)
    this.subscribed = false
    for (const client of [this.command, this.subscriber]) {
      client.on('error', () => {}) // Never log Redis URLs or credentials.
      client.on('close', () => {
        if (client === this.subscriber) this.subscribed = false
        this.emit('unavailable')
      })
    }
    this.subscriber.on('ready', () => {
      void this.subscriber.subscribe(this.channel).then(() => {
        this.subscribed = true
        if (this.ready) this.emit('ready')
      }).catch(() => this.emit('unavailable'))
    })
    this.subscriber.on('message', (channel, raw) => {
      if (channel !== this.channel || Buffer.byteLength(raw) > LIMIT.frame + 4096) return
      try {
        const message = JSON.parse(raw)
        if (message && idPattern.test(message.from ?? '')) this.emit('message', message)
      } catch { /* malformed coordinator messages never reach a connector */ }
    })
  }
  get ready() { return !this.closed && this.command.status === 'ready' && this.subscriber.status === 'ready' && this.subscribed }
  nodeChannel(id) {
    if (!idPattern.test(id)) throw new Error('Invalid coordinator ID')
    return `${this.prefix}node:${id}`
  }
  ownerKey(id) { return `${this.prefix}owner:${id}` }
  async start() {
    try {
      await Promise.all([this.command.connect(), this.subscriber.connect()])
      await this.subscriber.subscribe(this.channel)
      this.subscribed = true
      await this.health()
      return this
    } catch { this.close(); throw unavailable() }
  }
  async run(fn) {
    if (!this.ready) throw unavailable()
    try { return await fn(this.command) } catch { throw unavailable() }
  }
  async health() { await this.run(client => client.ping()); return true }
  async send(node, message) {
    const raw = JSON.stringify({ ...message, from: this.id })
    if (Buffer.byteLength(raw) > LIMIT.frame + 4096) throw new Error('Coordinator frame too large')
    const count = await this.run(client => client.publish(this.nodeChannel(node), raw))
    if (!count) throw unavailable()
  }
  async rate(ip, kind, maximum, period) {
    const hash = createHash('sha256').update(ip).digest('hex')
    const count = await this.run(client => client.eval(`
      local n=redis.call('INCR',KEYS[1])
      if n==1 then redis.call('PEXPIRE',KEYS[1],ARGV[1]) end
      return n`, 1, `${this.prefix}rate:${kind}:${hash}`, period))
    if (count > maximum) throw Object.assign(new Error('Rate limit exceeded'), { status: 429 })
  }
  descriptor(session) {
    return { node: this.id, publicationId: session.publicationId, connectionId: session.connectionId, generation: session.generation }
  }
  async lookup(publicationId) {
    const raw = await this.run(client => client.get(this.ownerKey(publicationId)))
    if (!raw) return undefined
    let owner
    try { owner = JSON.parse(raw) } catch { throw unavailable() }
    if (!idPattern.test(owner.node ?? '') || owner.publicationId !== publicationId ||
        !idPattern.test(owner.connectionId ?? '') || !Number.isSafeInteger(owner.generation) || owner.generation < 1) throw unavailable()
    return owner
  }
  async claim(session) {
    const descriptor = this.descriptor(session), value = JSON.stringify(descriptor)
    const prior = await this.run(client => client.eval(`
      local old=redis.call('GET',KEYS[1])
      if old then
        local o=cjson.decode(old)
        if o.generation>tonumber(ARGV[2]) or (o.generation==tonumber(ARGV[2]) and old~=ARGV[1]) then return false end
      end
      redis.call('SET',KEYS[1],ARGV[1],'PX',ARGV[3])
      return old or ''`, 1, this.ownerKey(session.publicationId), value, session.generation, this.leaseMs))
    if (prior === null) throw unavailable()
    return prior && prior !== value ? JSON.parse(prior) : undefined
  }
  async refresh(session) {
    const ok = await this.run(client => client.eval(`
      if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end
      redis.call('PEXPIRE',KEYS[1],ARGV[2]);return 1`, 1, this.ownerKey(session.publicationId), JSON.stringify(this.descriptor(session)), this.leaseMs))
    if (!ok) throw unavailable()
  }
  release(session) {
    return this.run(client => client.eval(`
      if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end
      return 0`, 1, this.ownerKey(session.publicationId), JSON.stringify(this.descriptor(session))))
  }
  async reserve(publicationId, requestId, maximum, lifetime) {
    const ok = await this.run(client => client.eval(`
      local now=tonumber(ARGV[1]);local expires=now+tonumber(ARGV[2])
      redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',now)
      redis.call('ZREMRANGEBYSCORE',KEYS[2],'-inf',now)
      if redis.call('ZCARD',KEYS[1])>=tonumber(ARGV[3]) or redis.call('ZCARD',KEYS[2])>=tonumber(ARGV[4]) then return 0 end
      redis.call('ZADD',KEYS[1],expires,ARGV[5]);redis.call('ZADD',KEYS[2],expires,ARGV[5])
      redis.call('PEXPIRE',KEYS[1],ARGV[2]);redis.call('PEXPIRE',KEYS[2],ARGV[2]);return 1`,
    2, `${this.prefix}active`, `${this.prefix}active:${publicationId}`, Date.now(), lifetime, maximum, LIMIT.concurrent, requestId))
    if (!ok) throw Object.assign(new Error('Agent busy'), { status: 429 })
  }
  unreserve(publicationId, requestId) {
    return this.run(client => client.eval(`
      redis.call('ZREM',KEYS[1],ARGV[1]);redis.call('ZREM',KEYS[2],ARGV[1]);return 1`,
    2, `${this.prefix}active`, `${this.prefix}active:${publicationId}`, requestId))
  }
  async accept(owner, requestId, lifetime) {
    const ok = await this.run(client => client.eval(`
      if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end
      local expires=redis.call('ZSCORE',KEYS[2],ARGV[2])
      if not expires or tonumber(expires)<=tonumber(ARGV[3]) then return 0 end
      return redis.call('SET',KEYS[3],'1','PX',ARGV[4],'NX') and 1 or 0`,
    3, this.ownerKey(owner.publicationId), `${this.prefix}active`, `${this.prefix}seen:${requestId}`,
    JSON.stringify(owner), requestId, Date.now(), lifetime))
    if (!ok) throw Object.assign(new Error('Tunnel changed or request already dispatched'), { status: 503 })
  }
  close() {
    if (this.closed) return
    this.closed = true
    this.emit('unavailable')
    this.command.disconnect()
    this.subscriber.disconnect()
  }
}
