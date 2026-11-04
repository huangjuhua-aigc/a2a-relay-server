#!/usr/bin/env node
// Render only. Never invokes kubectl or changes cloud resources.
import { isIP } from 'node:net'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const ns = 'a2a-relay'
const labels = { 'app.kubernetes.io/name': 'a2a-relay' }
const meta = name => ({ name, namespace: ns, labels })
export function renderVke({ stage, subnetId, image, httpsImage, publicIP, registration = 'closed' }) {
  if (!['bootstrap', 'workload'].includes(stage)) throw new Error('stage must be bootstrap or workload')
  if (stage === 'bootstrap') {
    if (!/^subnet-[a-z0-9]+$/.test(subnetId ?? '')) throw new Error('Set VKE_SUBNET_ID to the target VPC subnet')
    return { apiVersion: 'v1', kind: 'List', items: [
      { apiVersion: 'v1', kind: 'Namespace', metadata: { name: ns, labels } },
      // New independent CLB. Do not reuse a CLB owned by another Service.
      { apiVersion: 'v1', kind: 'Service', metadata: { ...meta('a2a-relay-public'), annotations: {
        'service.beta.kubernetes.io/volcengine-loadbalancer-address-type': 'PUBLIC',
        'service.beta.kubernetes.io/volcengine-loadbalancer-subnet-id': subnetId,
        'service.beta.kubernetes.io/volcengine-loadbalancer-pass-through': 'true',
        'service.beta.kubernetes.io/volcengine-loadbalancer-established-timeout': '900',
      } }, spec: { type: 'LoadBalancer', selector: labels, ports: [
        { name: 'http-acme', port: 80, targetPort: 'http-acme', protocol: 'TCP' },
        { name: 'https', port: 443, targetPort: 'https', protocol: 'TCP' },
      ] } },
    ] }
  }
  if (isIP(publicIP ?? '') !== 4 || /^(0|10|127)\.|^169\.254\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(publicIP)) throw new Error('Set RELAY_PUBLIC_IP to the assigned public IPv4 address')
  if (!image || image.endsWith(':latest') || !/@sha256:[a-f0-9]{64}$|:[a-zA-Z0-9_.-]+$/.test(image)) throw new Error('Set RELAY_IMAGE to an immutable release tag or digest (not latest)')
  if (!httpsImage || httpsImage.endsWith(':latest') || !/@sha256:[a-f0-9]{64}$|:[a-zA-Z0-9_.-]+$/.test(httpsImage)) throw new Error('Set RELAY_HTTPS_IMAGE to the image built with --target https (not latest)')
  if (!['open', 'closed'].includes(registration)) throw new Error('RELAY_REGISTRATION must be open or closed')
  const origin = `https://${publicIP}`
  const probe = { exec: { command: ['node', '-e', "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"] }, timeoutSeconds: 5 }
  const secure = { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } }
  return { apiVersion: 'v1', kind: 'List', items: [
    { apiVersion: 'storage.k8s.io/v1', kind: 'StorageClass', metadata: { name: 'a2a-relay-ebs-retain', labels },
      provisioner: 'ebs.csi.volcengine.com', parameters: { type: 'ESSD_PL0', ChargeType: 'PostPaid', fsType: 'ext4' },
      reclaimPolicy: 'Retain', volumeBindingMode: 'WaitForFirstConsumer', allowVolumeExpansion: true },
    { apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: meta('a2a-relay-data'), spec: {
      accessModes: ['ReadWriteOnce'], storageClassName: 'a2a-relay-ebs-retain', resources: { requests: { storage: '20Gi' } },
    } },
    { apiVersion: 'v1', kind: 'ConfigMap', metadata: meta('a2a-relay-config'), data: {
      RELAY_ORIGIN: origin, RELAY_BIND: '127.0.0.1', PORT: '8787', RELAY_DATABASE: '/data/relay.db',
      RELAY_TRUSTED_PROXY_IPS: '127.0.0.1', RELAY_REGISTRATION: registration,
      Caddyfile: readFileSync(new URL('Caddyfile', import.meta.url), 'utf8'),
    } },
    { apiVersion: 'apps/v1', kind: 'Deployment', metadata: meta('a2a-relay'), spec: {
      // SQLite plus process-local tunnels: never use HPA or rolling surge.
      replicas: 1, strategy: { type: 'Recreate' }, selector: { matchLabels: labels },
      template: { metadata: { labels }, spec: {
        automountServiceAccountToken: false, terminationGracePeriodSeconds: 30,
        securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000, fsGroupChangePolicy: 'OnRootMismatch', seccompProfile: { type: 'RuntimeDefault' } },
        containers: [
          { name: 'relay', image, imagePullPolicy: 'IfNotPresent', securityContext: secure,
            envFrom: [{ configMapRef: { name: 'a2a-relay-config' } }],
            resources: { requests: { cpu: '250m', memory: '256Mi' }, limits: { cpu: '1', memory: '512Mi' } },
            startupProbe: { ...probe, periodSeconds: 3, failureThreshold: 20 },
            readinessProbe: { ...probe, periodSeconds: 10 }, livenessProbe: { ...probe, periodSeconds: 30 },
            volumeMounts: [{ name: 'data', mountPath: '/data' }] },
          { name: 'https', image: httpsImage,
            securityContext: secure, env: [{ name: 'RELAY_ORIGIN', value: origin }, { name: 'RELAY_TLS_NAME', value: publicIP }],
            ports: [{ name: 'http-acme', containerPort: 8080 }, { name: 'https', containerPort: 8443 }],
            resources: { requests: { cpu: '50m', memory: '64Mi' }, limits: { cpu: '500m', memory: '256Mi' } },
            readinessProbe: { tcpSocket: { port: 'https' }, periodSeconds: 10 },
            volumeMounts: [{ name: 'data', mountPath: '/data' }, { name: 'caddy-config', mountPath: '/etc/caddy', readOnly: true }, { name: 'caddy-runtime', mountPath: '/config' }] },
        ],
        volumes: [{ name: 'data', persistentVolumeClaim: { claimName: 'a2a-relay-data' } },
          { name: 'caddy-config', configMap: { name: 'a2a-relay-config', items: [{ key: 'Caddyfile', path: 'Caddyfile' }] } },
          { name: 'caddy-runtime', emptyDir: { sizeLimit: '16Mi' } }],
      } },
    } },
  ] }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(renderVke({ stage: process.argv[2], subnetId: process.env.VKE_SUBNET_ID,
    image: process.env.RELAY_IMAGE, httpsImage: process.env.RELAY_HTTPS_IMAGE, publicIP: process.env.RELAY_PUBLIC_IP,
    registration: process.env.RELAY_REGISTRATION ?? 'closed' }), null, 2)) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
