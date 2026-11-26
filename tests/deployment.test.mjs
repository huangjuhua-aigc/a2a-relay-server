import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderVke } from '../deploy/render-vke.mjs'
import { renderPostgres } from '../deploy/render-postgres.mjs'

test('VKE bootstrap only allocates a dedicated public entrance', () => {
  assert.throws(() => renderVke({ stage: 'bootstrap' }), /subnet/)
  const { items } = renderVke({ stage: 'bootstrap', subnetId: 'subnet-example' })
  const svc = items.find(x => x.kind === 'Service')
  assert.equal(svc.spec.type, 'LoadBalancer')
  assert.equal(svc.metadata.annotations['service.beta.kubernetes.io/volcengine-loadbalancer-id'], undefined)
  assert.deepEqual(svc.spec.ports.map(x => x.port), [80, 443])
  assert.equal(items.some(x => x.kind === 'Deployment'), false)
})

test('PostgreSQL workload references private Secrets, separates migrations and probes, and has no SQLite disk or public entry',()=>{
  const opts={origin:'https://relay.example.test',image:'registry.example/relay:release-1',caSecret:'database-ca'}
  const {items}=renderPostgres(opts),deployment=items.find(x=>x.kind==='Deployment'),pod=deployment.spec.template.spec,c=pod.containers[0]
  assert.equal(items.find(x=>x.kind==='Service').spec.type,'ClusterIP')
  assert.equal(items.some(x=>['Ingress','PersistentVolumeClaim','Secret'].includes(x.kind)),false)
  assert.equal(deployment.spec.replicas,1)
  assert.equal(c.readinessProbe.httpGet.path,'/ready');assert.equal(c.livenessProbe.httpGet.path,'/health')
  assert.equal(c.env.find(x=>x.name==='RELAY_STORE').value,'postgres')
  assert.equal(c.env.find(x=>x.name==='RELAY_REGISTRATION').value,'closed')
  assert.equal(pod.volumes[0].secret.secretName,'a2a-relay-db')
  assert.equal(c.env.some(x=>x.name==='RELAY_DATABASE_URL'),false)
  const job=renderPostgres({...opts,stage:'migrate'}).items.find(x=>x.kind==='Job')
  assert.equal(job.spec.template.spec.volumes[0].secret.secretName,'a2a-relay-db-migration')
  assert.deepEqual(job.spec.template.spec.containers[0].command,['node','src/database.mjs','migrate'])
})

test('independent PostgreSQL relays keep every resource and credential reference in their selected namespace', () => {
  const opts={origin:'https://relay.example.test',image:'registry.example/relay:release-1',namespace:'huangjuhua-relay',imagePullSecret:'relay-registry'}
  for (const stage of ['migrate','workload']) {
    const {items}=renderPostgres({...opts,stage})
    for (const item of items) assert.equal(item.kind==='Namespace'?item.metadata.name:item.metadata.namespace,opts.namespace)
    const workload=items.find(x=>['Deployment','Job'].includes(x.kind))
    assert.deepEqual(workload.spec.template.spec.imagePullSecrets,[{name:'relay-registry'}])
  }
  for (const namespace of ['', '../a2a-relay', 'Uppercase', '-relay', 'relay-', 'a'.repeat(64)]) assert.throws(()=>renderPostgres({...opts,namespace}),/namespace/)
  assert.throws(()=>renderPostgres({...opts,imagePullSecret:'../credentials'}),/image pull/)
})

test('VKE workload preserves identity storage and keeps the HTTP listener private', () => {
  const opts = { stage: 'workload', publicIP: '203.0.113.7', image: 'registry.example/relay:release-1', httpsImage: 'registry.example/relay-https:release-1' }
  for (const ip of ['localhost', 'http://1.2.3.4', '127.0.0.1', '192.168.1.3', '172.16.1.2', '10.0.0.1']) assert.throws(() => renderVke({ ...opts, publicIP: ip }), /IPv4/)
  assert.throws(() => renderVke({ ...opts, image: 'relay:latest' }), /latest/)
  const { items } = renderVke(opts)
  const deployment = items.find(x => x.kind === 'Deployment'), pod = deployment.spec.template.spec
  assert.equal(deployment.spec.replicas, 1)
  assert.equal(deployment.spec.strategy.type, 'Recreate')
  assert.equal(items.find(x => x.kind === 'StorageClass').reclaimPolicy, 'Retain')
  const config = items.find(x => x.kind === 'ConfigMap').data
  assert.equal(config.RELAY_ORIGIN, 'https://203.0.113.7')
  assert.equal(config.RELAY_REGISTRATION, 'closed')
  assert.equal(config.RELAY_BIND, '127.0.0.1')
  assert.equal(config.RELAY_TRUSTED_PROXY_IPS, '127.0.0.1')
  assert.match(config.Caddyfile, /profile shortlived/)
  assert.match(config.Caddyfile, /default_sni/)
  assert.match(config.Caddyfile, /header_up X-Forwarded-For \{http.request.remote.host\}/)
  assert.equal(pod.automountServiceAccountToken, false)
  for (const container of pod.containers) assert.equal(container.securityContext.readOnlyRootFilesystem, true)
  assert.equal(pod.containers.find(x=>x.name==='https').env.find(x=>x.name==='RELAY_TLS_NAME').value, opts.publicIP)
})
