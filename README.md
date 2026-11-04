# A2A Relay Server

[English](README.md) · [简体中文](README.zh-CN.md)

A self-hosted reverse relay for local HTTP A2A agents. A Connector opens an outbound WebSocket, registers an agent and exposes only its public Agent Card and JSON-RPC endpoint. The local Portal and owner APIs are never forwarded. MIT licensed; this repository runs independently of Talk2MyAgent.

## Run

Requires Node.js **22.13+** (tested on 24.19) and pnpm. SQLite uses Node's built-in `node:sqlite`; there is no native addon build.

```sh
pnpm install --frozen-lockfile
RELAY_ORIGIN=https://relay.example.com pnpm start
```

`relay.example.com` is a placeholder: provide your own DNS and HTTPS reverse proxy. The process listens on `127.0.0.1:8787`; see [nginx example](deploy/nginx.conf.example). Use a process supervisor, keep WebSocket upgrades enabled, disable response buffering, and retain the `data/` directory. A single server process owns the database and all live tunnels; do not run multiple replicas against the same deployment.

PowerShell local development (loopback HTTP is explicitly opt-in):

```powershell
$env:RELAY_ORIGIN='http://127.0.0.1:8787'
$env:RELAY_ALLOW_LOOPBACK_HTTP='1'
pnpm start
```

In a separate Talk2MyAgent shell:

```powershell
$env:A2A_RELAY_DEFAULT_HOST='http://127.0.0.1:8787'
$env:A2A_RELAY_ALLOW_LOOPBACK_HTTP='1'
pnpm --filter @talk2myagent/a2a-host start
```

Save an Agent, select public relay and obtain its address in Portal. Registration allocates a stable route and contact number without starting the local Agent. Prepare invitations, then start the Agent to connect at the same route. Production uses HTTPS/WSS without either development flag.

## Configuration

Managed PostgreSQL/RDS is supported alongside SQLite. See the [PostgreSQL guide](deploy/postgres.md) for strict TLS, separate migration/runtime roles, SQLite import and internal VKE manifests. For multiple Relay instances, add Redis coordination as described in the [Vercel + Supabase guide](deploy/vercel.md). Sharing PostgreSQL alone does not route active tunnels between instances.

For Kubernetes on Volcengine with direct public-IP access, see the [VKE deployment guide](deploy/vke.md). It includes reproducible container images, single-replica persistent storage, and an HTTPS sidecar with automatic IP-certificate renewal. The manifest generator does not create cloud resources by itself.

| Variable | Default | Purpose |
| --- | --- | --- |
| `RELAY_ORIGIN` | required | Canonical HTTPS origin; generated URLs never use the request Host header |
| `RELAY_BIND`, `PORT` | `127.0.0.1`, `8787` | Local listener |
| `RELAY_DATABASE` | `data/relay.db` | SQLite metadata; preserve across restarts |
| `RELAY_STORE` | SQLite, or PostgreSQL when a URL is supplied | `sqlite` or `postgres` |
| `RELAY_DATABASE_URL_FILE` / `RELAY_DATABASE_URL` | unset | PostgreSQL private URL file or environment value; mutually exclusive |
| `RELAY_PG_CA_FILE` | system trust roots | Optional PostgreSQL CA PEM; strict TLS verification stays enabled |
| `RELAY_PG_CA` | unset | Inline CA PEM for managed environment variables; mutually exclusive with the CA file |
| `RELAY_PG_POOL_SIZE` | 10; 2 on Vercel | Per-process PostgreSQL connection cap, from 1 to 20 |
| `RELAY_REDIS_URL_FILE` / `RELAY_REDIS_URL` | unset | Enable multi-instance routing using native Redis TLS; requires explicit PostgreSQL |
| `RELAY_REDIS_NAMESPACE` | required with Redis | Isolates ownership, limits and request IDs between environments |
| `RELAY_REGISTRATION` | open | Set `closed` to stop new registration requests |
| `RELAY_MAX_REGISTRATIONS` | 10000 | Total registration capacity |
| `RELAY_REGISTRATIONS_PER_HOUR` | 20 | Registration requests per client IP, including retries |
| `RELAY_REQUESTS_PER_MINUTE` | 120 | HTTP requests per client IP |
| `RELAY_TRUSTED_PROXY_IPS` | empty | Comma-separated exact IPs permitted to supply a **single** `X-Forwarded-For` address |
| `RELAY_ALLOW_LOOPBACK_HTTP` | off | Development only, accepts loopback HTTP origin |

The reverse proxy must overwrite `X-Forwarded-For`, never append untrusted values. Without explicit trust, rate limits apply to the immediate TCP peer. The sample proxy disables request access logging. Neither Relay nor Connector logs conversation payloads or bearer credentials. TLS terminates at the Relay/proxy, so a Relay operator can see forwarded content and visitor bearer credentials: this is not end-to-end encryption.

## Surface and limits

- `POST /v1/agents/register`: idempotent `registrationId` + SHA-256 device credential hash. Accepts an optional `contactId` matching `1[3-9]` plus nine digits. An occupied number returns HTTP 409 with `code: CONTACT_ID_TAKEN`; retrying the same identity and number is idempotent. New publications start disabled.
- `GET /v1/publication`, `PUT /v1/publication/enabled`: device Bearer credential; monotonic revisions reject stale enable/disable operations.
- `GET /v1/connect`: authenticated WebSocket upgrade. A ready handshake is required before routing.
- `GET /r/:id/.well-known/agent-card.json`, `POST /r/:id/a2a`: the only forwarded paths. Visitor authentication remains the local agent's responsibility.
- `GET /health`: liveness only; exempt from client quotas so load cannot cause probe-driven restart loops.
- `GET /ready`: database/schema and configured Redis readiness, also exempt from client quotas.

### Contact numbers

Users can supply their own 11-digit mobile number as a public Agent ID. It is visible in invitations and `/r/<contactId>/a2a`; **phone ownership is not verified**, and the number is never an authentication credential. One number identifies one Agent per Relay. Numbers become immutable after registration, including for the same device; conflicts never overwrite another registration. Retries and restarts retain the number, and disabling/revoking/resetting a device does not release it.

Legacy clients that omit `contactId` still receive an automatic number from `13800000000` through `13999999999`, skipping occupied numbers. Registration uses a transaction (`BEGIN IMMEDIATE` in SQLite; an allocator row lock in PostgreSQL) plus a unique index, including across instances. Exhaustion fails instead of wrapping. The response keeps legacy UUID URLs and adds `contactRpcUrl` and `contactCardUrl`; updated Connectors select the numeric URLs for user-chosen numbers. Both routes resolve to the same internal publication, with unchanged visitor authentication. Run `pnpm db:migrate` with the migration role to apply PostgreSQL schema version 2 before accepting all mobile prefixes. SQLite upgrades its old constraint atomically on open.

Startup migrates existing SQLite databases transactionally, adding numbers without changing routes, device credentials or publication state. PostgreSQL requires an explicit `pnpm db:migrate` step before startup; optional SQLite import is described in the [PostgreSQL guide](deploy/postgres.md). Preserve the full database and `contact_number_sequence`; a reset or stale backup loses allocation history. Upgrade Relay before Connector/Portal. Legacy Connectors must restart to load the new code and fetch metadata via authenticated `GET /v1/publication`. Previously generated local numbers are replaced by Relay-issued numbers in new invitations.

The uniqueness boundary is this Relay database. Independent self-hosted Relays do not have globally unique numbers without a shared registry or assigned non-overlapping ranges. No global lookup-by-number service is provided. Multi-instance routing requires a shared PostgreSQL registry and Redis namespace; SQLite and PostgreSQL without Redis remain single-process deployments.

Only unsigned, single-interface A2A 1.0 JSONRPC cards are supported. Connector rewrites the interface URL in public and extended cards. Streaming responses are passed as raw byte chunks with per-request credit, preserving UTF-8 across split chunks. A disconnected request is **never replayed**; delivery may be unknown, and clients should query an already-known task ID.

Limits: request body 1,000,000 bytes; headers 16 KiB; JSON tunnel frame 128 KiB; decoded chunk 48 KiB; per-stream response window 256 KiB; WebSocket send queue 1 MiB; eight concurrent requests per publication and 64 per deployment (shared through Redis in distributed mode). Body deadline 15 s, first response 90 s, idle response 45 s, container total lifetime 10 min; heartbeat 20 s with a 45 s liveness threshold. Vercel request and connection lifetimes depend on the configured Function cap; see its deployment guide. Local HTTP redirects and compressed responses are rejected. No offline queue, chat persistence, generic TCP tunnel or accounts/billing is included.

## Revocation and recovery

```sh
node src/admin.mjs revoke PUBLICATION_ID
```

This is a local operator command against the configured store (`RELAY_DATABASE` for SQLite, or the PostgreSQL URL/file). New requests are immediately rejected; existing tunnels are closed by the server's next heartbeat (20-second interval, plus bounded database query time). Restart the server to close all tunnels immediately. Device credentials have no automatic expiry by default; `expiresAt` metadata is enforced when set by the operator. A device cannot clear an operator revocation. Preserve the registry database when restarting: deleting it would lose stable identities.

## Tests and shared protocol

```sh
pnpm test
```

With Docker running and `A2A_CONNECTOR_SOURCE` pointing to Talk2MyAgent's `packages/a2a-connector`, run `pnpm test:postgres` and `pnpm test:cluster` for disposable database and cross-process transport tests. These use the real Connector with controlled local HTTP responses, not paid model calls.

The small wire library is vendored in `vendor/a2a-relay-protocol`, including its license. Its source of truth is Talk2MyAgent's `packages/a2a-relay-protocol`. To update the snapshot:

```sh
node scripts/sync-protocol.mjs /path/to/Talk2MyAgent/packages/a2a-relay-protocol
pnpm install
```

Run cross-repository tests from Talk2MyAgent with `A2A_RELAY_SOURCE` pointing at this repository:

```sh
A2A_RELAY_SOURCE=/path/to/a2a-relay-server pnpm --filter @talk2myagent/a2a-connector test:integration
A2A_RELAY_SOURCE=/path/to/a2a-relay-server pnpm --filter @talk2myagent/a2a-host test:ui
```

These tests use isolated temporary data and dynamically allocated ports. Real DSH integration is provided in the dsh-a2a repository, with a deterministic model adapter rather than paid model calls. Public DNS, a deployed TLS proxy, Linux process lifecycle and Internet reachability still need environment-specific acceptance testing.
