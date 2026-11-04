# Vercel with Supabase PostgreSQL and Redis

[简体中文](vercel.zh-CN.md)

`api/relay.mjs` exports a Node HTTP server with WebSocket upgrades. Incoming visitor requests can reach a different Function instance from the one holding the Connector socket; Redis routes between them. CLI/container deployments without Redis retain single-process behavior.

The distributed implementation has been tested locally with independent Relay processes, real PostgreSQL/Redis and the Talk2MyAgent Connector. A Vercel deployment was also verified on 2026-11-03 with Supabase, Upstash, real Agent read_file calls through Microsandbox, automatic Connector rotation, and forwarding between two distinct Vercel deployments. These checks are separate from the local suite; repeat deployment acceptance for your own configuration and client networks.

## Provisioning and credentials

- Authorize a Vercel account/team that can create projects, set secrets and deploy.
- Create a dedicated Supabase project in the intended organization. Check its actual quoted cost; a new project in an existing Pro organization is not necessarily free.
- Use a dedicated Redis service supporting TLS, native TCP, Pub/Sub, Lua and sorted sets. Upstash Redis is an option; check its selected plan's command, message-size, connection and bandwidth quotas. A REST-only KV endpoint is insufficient.
- Keep compute and databases close together. The checked-in Vercel region is Tokyo (`hnd1`), matching Supabase `ap-northeast-1`; confirm the selected Redis region before provisioning.

Store secrets in environment variables or private local files outside Git and shared folders. Do not send passwords or access tokens in chat. Never disable TLS validation to make a connection succeed.

Pin the Vercel project to the tested Node 24.x runtime. Static output is limited to `public/`. If Windows symlink permissions prevent `vercel build`, pull project settings with `vercel pull`, then run `node scripts/check-vercel-build.mjs` for an isolated Linux packaging check. It copies allowlisted source and project settings with an empty build environment, never account credentials or real environment variables, and does not publish a deployment.

## Supabase setup

Inspect existing tables and exposed schemas, then run `pnpm db:migrate` with a migration account to apply `001-postgres.sql` and `002-mobile-contact.sql` (schema 2). The runtime does not run migrations. For an existing deployment, first deploy code compatible with schema 1 and 2, then run the constraint migration; existing IDs are not rewritten. Keep `a2a_relay` private and excluded from the Data API; do not grant `anon`, `authenticated` or `PUBLIC` access to its tables.

Create a separate runtime login with database CONNECT, schema USAGE, SELECT/INSERT/UPDATE on `agents` and `contact_number_sequence`, SELECT on `schema_migrations`, and required function EXECUTE privileges only. Remove unnecessary PUBLIC schema CREATE privileges. Keep migration credentials out of the Function environment; verify the actual permissions and Supabase advisors.

Use the **Shared Pooler** endpoint from the project's Connect panel with transaction port **6543**. Its hostname ends in `.pooler.supabase.com`; usernames include the project reference, for example `a2a_relay_app.<project-ref>`. The Session pooler view shows the same shared hostname with port 5432. The Dedicated Pooler (`db.<project-ref>.supabase.co:6543`) is a different endpoint and may be IPv6-only. Queries do not use named prepared statements. Each Vercel instance defaults to two pg connections.

Download the project's CA from Database Settings → SSL Configuration and retain `sslmode=verify-full`, including hostname verification. The Supabase dashboard currently links to the [Supabase Root 2021 CA](https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt); verify the current dashboard certificate when provisioning. Configure the PEM with `RELAY_PG_CA` and test the actual pooler connection. A certificate-chain error must not be resolved by disabling validation.

## Configuration

| Variable | Value |
| --- | --- |
| `RELAY_ORIGIN` | Canonical HTTPS origin for this environment |
| `RELAY_STORE` | `postgres` |
| `RELAY_DATABASE_URL` | Runtime account URL; URL-encode the password and use `sslmode=verify-full` |
| `RELAY_PG_CA` | Full CA PEM, if system roots are insufficient |
| `RELAY_PG_POOL_SIZE` | Defaults to 2 on Vercel, configurable from 1 to 20 |
| `RELAY_REDIS_URL` | Native TLS Redis URL, `rediss://<user>:<password>@<host>:<port>` |
| `RELAY_REDIS_NAMESPACE` | Explicit environment name, such as `a2a-production` |
| `RELAY_REGISTRATION` | Start with `closed` while preparing migration and acceptance |
| `RELAY_MAX_CONCURRENT` | Defaults to 64 across the namespace, with 8 per Agent |

Preview environments require both a separate Redis namespace and an isolated PostgreSQL environment. Redis namespacing alone does not isolate publication state or connection generations in PostgreSQL. Never automatically expose production credentials to arbitrary PR previews.

The Vercel entrypoint requires PostgreSQL and Redis and cannot fall back to ephemeral SQLite. It uses Vercel's overwritten `x-vercel-forwarded-for` for shared client quotas. Containers continue using the explicitly configured trusted proxy IPs.

## Routing and failure behavior

PostgreSQL retains durable identities, contact-number allocation and publication state. Redis holds expiring connection ownership, counters, concurrency permits and deduplication IDs. Pub/Sub carries transient request/response bytes; chat content and bearer credentials are not stored in Redis keys or application logs. Redis and Relay operators can still access forwarded content: this is not end-to-end encryption.

Ownership is fenced by publication ID, connection ID and generation, expires after 60 seconds and is refreshed on heartbeat. Active gateway requests check ownership and publication state every five seconds. Response credits are returned only after the gateway's HTTP write callback, retaining the Connector's bounded end-to-end response window.

Redis offline command queues and unfulfilled-command replay are disabled. Interrupted calls fail or end their response stream and are never resent to the local Agent. Redis outages close existing Connector sessions and make `/ready` fail while `/health` remains a process liveness check. Connectors establish fresh ownership on recovery without changing their durable identity.

## Function lifetime

The default `maxDuration` in `vercel.json` is 300 seconds. The entrypoint reads this setting and uses a 270-second request cap and 280-second Connector cap. Idle connections rotate after 80% of their cap; active requests are also limited by the remaining lifetime of their Connector connection.

On a plan supporting 800 seconds, set `functions["api/relay.mjs"].maxDuration` to 800 and redeploy. Defaults become 600 seconds per request and 780 seconds per connection. The unverified 1800-second beta is not included.

Reconnection cannot resume a partially delivered chat response. Even with Redis, a synchronous request is not guaranteed ten uninterrupted minutes at any point in the connection lifetime. Continue long-running work using known A2A task IDs; never automatically replay an interrupted message.

## Migration and acceptance

Keep the existing service available while testing the candidate. Freeze registrations before the final registry migration, preserving all Agent rows, credential hashes, publication IDs, contact numbers and the allocation sequence. Do not allocate numbers independently in both databases. Retaining the production hostname preserves Connector registrations keyed by origin; a hostname change requires an explicit registration-state migration.

Use the deployment's default HTTPS address for candidate tests and its exact canonical origin. Domain binding, DNS cutover and retiring the old service follow full acceptance; health checks alone are insufficient.

```powershell
$env:A2A_CONNECTOR_SOURCE='D:\code\Talk2MyAgent\packages\a2a-connector'
pnpm test
pnpm test:postgres
pnpm test:cluster
```

`test:cluster` starts disposable PostgreSQL/Redis containers and independent Relay processes. It pins Connector upgrades to A and HTTP requests to B, covering cards, authentication, large bodies, Unicode streaming, backpressure, shared concurrency, cancellation, owner death, expiry/rotation, publication disable, Redis failure, deduplication and namespace isolation. It removes only resources created by that invocation.

Deployment acceptance still includes a real Vercel build, managed PostgreSQL/Redis TLS and permissions, actual Agent chat, mobile/desktop public networking and reconnection after the real platform duration limit.

`scripts/smoke-public.mjs` can reuse a provisioned QA registration while public registration is closed: set `RELAY_QA_EXISTING_STATE_FILE` to a private Connector state file for the exact tested origin, alongside `RELAY_QA_STATE_FILE`, `RELAY_QA_ORIGIN` and `A2A_CONNECTOR_SOURCE`. The saved state must request publication. The script disables that QA publication when finished and distinguishes existing-identity verification from fresh address allocation. Keep both credential-bearing state files outside source control.

Sources: [WebSockets](https://vercel.com/docs/functions/websockets), [Function limits](https://vercel.com/docs/functions/limitations), [request headers](https://vercel.com/docs/headers/request-headers), [Supabase SSL](https://supabase.com/docs/guides/platform/ssl-enforcement), [Upstash compatibility](https://upstash.com/docs/redis/overall/rediscompatibility).
