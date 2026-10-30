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

Start the local agent, select public relay and enable publication in Portal. The Connector registers automatically and Portal displays an address and a complete visitor invitation. Production uses HTTPS/WSS without either development flag.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `RELAY_ORIGIN` | required | Canonical HTTPS origin; generated URLs never use the request Host header |
| `RELAY_BIND`, `PORT` | `127.0.0.1`, `8787` | Local listener |
| `RELAY_DATABASE` | `data/relay.db` | SQLite metadata; preserve across restarts |
| `RELAY_REGISTRATION` | open | Set `closed` to stop new registration requests |
| `RELAY_MAX_REGISTRATIONS` | 10000 | Total registration capacity |
| `RELAY_REGISTRATIONS_PER_HOUR` | 20 | Registration requests per client IP, including retries |
| `RELAY_REQUESTS_PER_MINUTE` | 120 | HTTP requests per client IP |
| `RELAY_TRUSTED_PROXY_IPS` | empty | Comma-separated exact IPs permitted to supply a **single** `X-Forwarded-For` address |
| `RELAY_ALLOW_LOOPBACK_HTTP` | off | Development only, accepts loopback HTTP origin |

The reverse proxy must overwrite `X-Forwarded-For`, never append untrusted values. Without explicit trust, rate limits apply to the immediate TCP peer. The sample proxy disables request access logging. Neither Relay nor Connector logs conversation payloads or bearer credentials. TLS terminates at the Relay/proxy, so a Relay operator can see forwarded content and visitor bearer credentials: this is not end-to-end encryption.

## Surface and limits

- `POST /v1/agents/register`: idempotent `registrationId` + SHA-256 device credential hash. New publications start disabled.
- `GET /v1/publication`, `PUT /v1/publication/enabled`: device Bearer credential; monotonic revisions reject stale enable/disable operations.
- `GET /v1/connect`: authenticated WebSocket upgrade. A ready handshake is required before routing.
- `GET /r/:id/.well-known/agent-card.json`, `POST /r/:id/a2a`: the only forwarded paths. Visitor authentication remains the local agent's responsibility.
- `GET /health`: liveness only.

Only unsigned, single-interface A2A 1.0 JSONRPC cards are supported. Connector rewrites the interface URL in public and extended cards. Streaming responses are passed as raw byte chunks with per-request credit, preserving UTF-8 across split chunks. A disconnected request is **never replayed**; delivery may be unknown, and clients should query an already-known task ID.

Limits: request body 1,000,000 bytes; headers 16 KiB; JSON tunnel frame 128 KiB; decoded chunk 48 KiB; per-stream response window 256 KiB; WebSocket send queue 1 MiB; eight concurrent requests per publication and 64 globally. Body deadline 15 s, first response 90 s, idle response 45 s, total lifetime 10 min; heartbeat 20 s with a 45 s liveness threshold. Local HTTP redirects and compressed responses are rejected. No offline queue, message persistence, generic TCP tunnel, accounts/billing or multi-node routing is included.

## Revocation and recovery

```sh
node src/admin.mjs revoke PUBLICATION_ID
```

This is a local operator command against `RELAY_DATABASE`. New requests are immediately rejected; existing tunnels are closed by the server's next heartbeat (within 20 seconds). Restart the server to close all tunnels immediately. Device credentials have no automatic expiry by default; `expiresAt` metadata is enforced when set by the operator. A device cannot clear an operator revocation. Do not delete the SQLite database to restart the server: it would lose stable identities.

## Tests and shared protocol

```sh
pnpm test
```

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
