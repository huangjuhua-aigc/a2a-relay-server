# PostgreSQL / managed RDS

[Detailed setup and VKE commands (Chinese)](postgres.zh-CN.md)

SQLite remains the default. Set `RELAY_STORE=postgres` and either `RELAY_DATABASE_URL_FILE` (recommended: a private one-line URL file) or `RELAY_DATABASE_URL`, never both. A supplied URL also selects PostgreSQL if `RELAY_STORE` is omitted. Format: `postgresql://user:URL_ENCODED_PASSWORD@private-host:5432/a2a_relay?sslmode=verify-full`.

TLS always verifies the certificate and hostname. Optionally set `RELAY_PG_CA_FILE` to the RDS CA PEM. URL SSL options cannot override that configuration. Remote plaintext and verification bypasses are rejected. Only disposable loopback tests may explicitly use `RELAY_PG_ALLOW_INSECURE_LOOPBACK=1` plus `sslmode=disable`.

Provision RDS in the cluster region/VPC, allow the actual Pod source subnet, and configure backups. Provide private host/port, database, version, credentials and CA through private files/Secrets. Local tests use PostgreSQL 17; actual cloud networking, TLS and engine compatibility still require acceptance.

## Schema and runtime

Run `pnpm db:migrate` once with a migration role, then `pnpm db:check`. Runtime startup does not perform DDL. Objects live in schema `a2a_relay`. The runtime role needs database CONNECT, schema USAGE, SELECT/INSERT/UPDATE on `agents` and `contact_number_sequence`, SELECT on `schema_migrations`, and EXECUTE on `protect_contact_id()`. It needs no DELETE, CREATE or cloud-admin permission.

Registration, idempotence, quotas and number allocation share a row-locked transaction; indexes enforce unique numbers and credentials. Publication revisions validate against a locked current row. Revoked numbers are not recycled. The pool has 10 connections and bounded connection/statement/lock waits. Failed writes are not automatically retried; their outcome can be unknown. Raw SQL errors and credentials are not logged.

`/health` reports process liveness. `/ready` checks the database/schema and returns 503 on failure, without a liveness restart loop. New traffic fails closed. Active tunnels close when their next heartbeat cannot validate persistence (20-second interval plus bounded database wait); checks are batched.

## Optional SQLite import

Stop old writers and take a consistent backup. Initialize an empty PostgreSQL target, then run `node src/database.mjs import-sqlite /private/backup/relay.db` using the migration role. The source must contain server-issued contact IDs and its allocation counter. Import is read-only on the source, atomic on the target, refuses nonempty targets, preserves all identity/status fields and never moves counters backwards. Do not dual-write old/new stores or restore stale allocation history during code rollback.

UUID paths survive import; full URLs also depend on `RELAY_ORIGIN`. Changing the origin requires a separately planned trusted Connector identity migration: origin-scoped credential caches are not moved by database import, nor should old credentials be sent automatically to a new host.

## VKE manifests

`deploy/render-postgres.mjs migrate|workload` renders a namespace and migration Job or internal ClusterIP workload. Set `RELAY_IMAGE` to a fixed release tag/digest and `RELAY_ORIGIN` to the final HTTPS origin. Optional: `RELAY_PG_CA_SECRET`, `RELAY_MIGRATION_ID`, `RELAY_REGISTRATION` (defaults closed), verified `RELAY_TRUSTED_PROXY_IPS`.

Create Secrets `a2a-relay-db-migration` and `a2a-relay-db` with key `url` from private files. The CA Secret uses `ca.crt`. Finish the migration Job before deploying the application; configure image pull access first. Jobs do not auto-retry, and later migrations need a new ID. Restart the application after rotating mounted connection files.

The workload runs non-root with a read-only filesystem, no service-account token and no SQLite PVC. It remains single-replica/Recreate because tunnels are in memory. ALB/Ingress, DNS, TLS and trusted proxy configuration are separate steps; validate WSS, SSE, timeouts, source IP and authentication before opening registration. The old `render-vke.mjs` is the CLB/Caddy/SQLite alternative and must not be mixed with this configuration.

## Tests

`pnpm test` runs local unit/regression tests. `pnpm test:postgres` starts a disposable Docker PostgreSQL and cleans up its resources; it never uses production URL files. Set `A2A_CONNECTOR_SOURCE` to `packages/a2a-connector` to include real Connector transport tests with controlled HTTP responses, without paid model calls. Coverage includes parallel allocation, retries, limits, revisions, revocation, import, DML-only privileges, TLS configuration, readiness and reconnect without replay.

The integration suite has also passed on PostgreSQL 14.17. On managed RDS 14, the `public` schema may belong to a provider role even when the migration role owns the database. Check `has_schema_privilege` after revoking PUBLIC's CREATE permission: a command that only emits a warning has not necessarily changed the ACL. Setting a restricted default search path does not revoke explicit access to `public`.

### Live HTTPS acceptance

`scripts/smoke-public.mjs` requires explicit `RELAY_QA_ORIGIN`, `A2A_CONNECTOR_SOURCE` and `RELAY_QA_STATE_FILE` settings. The state file must be a private path outside the repository. Optionally set `RELAY_QA_REPORT_FILE` for a credential-free report. Registration must be enabled. The script creates one real QA registration, tests WSS, visitor authentication, SSE and reconnect, then disables its publication. Its number remains allocated under the normal non-recycling policy.

Only when `RELAY_QA_KUBECONFIG` is set does the script restart `deployment/a2a-relay` in namespace `a2a-relay` to verify identity persistence and reconnect. This interrupts active requests; run it during initial deployment or a maintenance window.

For a restricted client network, explicitly set `RELAY_QA_LOOPBACK_TUNNEL=1` after establishing a temporary `127.0.0.1:443` tunnel to the ALB's public port 443. The script changes DNS only within its process while retaining TLS, SNI and hostname verification. Its report identifies that path; this does not replace ordinary external-client connectivity acceptance.
