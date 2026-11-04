# Volcengine VKE with a public IP

[Full deployment commands (Chinese)](vke.zh-CN.md)

This deployment uses a dedicated public CLB, a single Relay Pod with a Caddy sidecar, and a retained 20Gi EBS volume. No domain is required: the canonical origin is `https://<assigned-public-IPv4>`. HTTPS certificate verification remains enabled. Caddy explicitly uses Let's Encrypt's `shortlived` ACME profile for IP certificates and stores its account/certificates on the persistent volume for automatic renewal.

The renderer **only writes manifests**. It never invokes Kubernetes. `bootstrap` renders the namespace and a new paid LoadBalancer Service; `workload` renders the retained StorageClass/PVC, ConfigMap and Deployment. Keep registration closed until publicly trusted TLS, real client IP preservation and the complete A2A path have been verified.

```sh
docker build -t "$RELAY_IMAGE" .
docker build --target https -t "$RELAY_HTTPS_IMAGE" .
# Push both images to a registry accessible by the selected cluster.
VKE_SUBNET_ID=subnet-YOUR_SUBNET node deploy/render-vke.mjs bootstrap > bootstrap.json
# After reviewing and applying bootstrap.json, get the Service's assigned IP.
RELAY_PUBLIC_IP=YOUR_PUBLIC_IP RELAY_REGISTRATION=closed \
  node deploy/render-vke.mjs workload > workload.json
```

Set `RELAY_IMAGE` and `RELAY_HTTPS_IMAGE` to release tags or digests, never `latest`. Explicitly select the intended kubectl context. The new namespace must have permission to pull both images. The stock Caddy image carries a file capability that conflicts with `capabilities.drop: ALL`; use the provided `https` build target, which removes that unneeded low-port capability.

Resource requests total **300m CPU / 320Mi memory** (Relay: 250m/256Mi, HTTPS: 50m/64Mi). Limits total 1.5 CPU / 768Mi. These are starting budgets, not load-test capacity promises. The volume retains SQLite registration/number allocation data and ACME state. Run **one replica with Recreate**, without HPA or rolling surge. Restarts reconnect tunnels but can interrupt in-flight requests; requests are never replayed.

The public Service maps ports 80/443 to the sidecar's unprivileged 8080/8443 listeners. Relay listens only on Pod loopback, trusts only the loopback proxy, and the proxy overwrites forwarded IP headers. Confirm CLB Pod pass-through preserves the actual visitor IP after deployment. Port 80 must remain reachable for ACME renewal. Do not expose 8787 or relax certificate verification.

The existing business Ingress is unchanged. Volcengine does not support attaching a second Service to a CLB automatically created by another Service. This template therefore creates a separate billable CLB/IP; disk and traffic are also billable. Cloud quotas, bandwidth and costs require account-level confirmation. [Official CLB constraints](https://docs.volcengine.com/docs/vke/loadbalancer-service-usage-precautions?lang=zh)

IP certificates last 160 hours and need automated renewal. A Ready Pod or local health probe does not prove issuance succeeded: require a public `curl --fail https://<IP>/health` without insecure flags, monitor expiry, and validate renewal after deployment. [Let's Encrypt IP certificates](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability/), [Caddy ACME configuration](https://caddyserver.com/docs/caddyfile/directives/tls)

Back up SQLite consistently, including WAL state, and preserve the certificate directory. Retain protects against automatic disk deletion, not against data loss. Do not restore stale allocation history during a code rollback. Deleting the LoadBalancer Service can release its public IP; restarting the Pod does not. Configuration environment changes require a Pod restart.

Local validation:

```sh
pnpm test
docker build -t a2a-relay-server:vke-check .
docker build --target https -t a2a-relay-https:vke-check .
node scripts/smoke-container.mjs
```

The smoke test uses a local CA with strict trust verification, temporary Docker resources, and no public ACME issuance. It checks HTTPS, WSS, unbuffered SSE, forwarded-IP spoof resistance, probes under rate limiting, graceful SIGTERM and durable identity across container recreation. Real CLB provisioning, public certificate issuance/renewal and Internet A2A traffic still require deployment acceptance.
