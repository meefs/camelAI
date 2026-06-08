# Connections RPC Test Plan

This plan covers brokered workspace connection access through the unified sandbox RPC surface:

- `/rpc/connections` for in-container JS/Python/Bash clients and worker-style brokered connection calls.

## Always-On CI

Run these on every PR that touches connections, integrations, brokered providers, token refresh, or sandbox connection docs:

```bash
bun run typecheck
bun run test:run -- tests/integration-registry.test.ts
bun run test:workers -- workers/main/tests/connections-runtime.test.ts workers/main/tests/token-refresh.test.ts
node --check scripts/test-connections-rpc.mjs
```

These tests verify:

- Provider registry metadata and credential-storage decisions.
- Unified `/rpc/connections` action discovery and method invocation.
- Project VM notebook access through `CAMELAI_CONNECTIONS_RPC_URL`, routed by the project-runtime Docker proxy capability `camelai-connections-rpc`.

The project-runtime-service Docker proxy must map `/p/camelai-connections-rpc/*` to the main Worker and inject:
- `x-project-runtime-secret`
- `x-project-runtime-project`

The Worker derives workspace/org identity from the project id and verifies the project exists before serving `/rpc/connections`.
- Hosted broker request shaping for representative providers.
- SQL read-only enforcement before data-proxy calls.
- OAuth refresh behavior, including permanent failures becoming `needs_reauth`.
- The smoke-test harness parses and boots.

## Staging Smoke Test

Use a dedicated staging workspace with stored test connections. The smoke test uses the same trusted sandbox headers that sandbox-host injects, so no provider secrets need to leave the workspace. It validates the container API and brokered provider paths.

```bash
CAMELAI_WORKER_URL=https://<staging-worker-host> \
SANDBOX_PROXY_SECRET=<staging sandbox proxy secret> \
CHIRIDION_ORG_ID=<org id> \
CHIRIDION_WORKSPACE_ID=<workspace id> \
EXPECT_CONNECTIONS=stripe_test,postgres_test,bigquery_test \
bun run test:connections:rpc
```

Optional safe read-only calls can be added with JSON. Method aliases come from the `/rpc/connections` `methods` action:

```bash
CONNECTION_RPC_SAFE_CALLS='[
  {"action":"invoke","params":{"connection":"postgresMain","method":"query","input":{"query":"select 1 as ok"}}},
  {"action":"invoke","params":{"connection":"bigqueryAnalytics","method":"listDatasetIds","input":{}}}
]'
```

## Provider Matrix

Keep staging coverage representative rather than exhaustive on every run:

- First-party remote via camelAI broker: Stripe, Intercom or Typeform, Notion OAuth.
- camelAI-hosted API brokers: Sentry, Airtable, PostHog, Zendesk.
- SQL/data proxy brokers: Postgres, MySQL or PlanetScale, ClickHouse.
- Warehouse/native auth: BigQuery, Snowflake when configured.
- New batch brokers: MongoDB, Redis, Turso, Databricks, Shopify, Segment, Teams.

For each connection in the matrix, the smoke test should pass:

- `/rpc/connections` `methods`
- `/rpc/connections` `list`
- `/rpc/connections` `invoke` with representative safe read-only/idempotent connection methods
- Project VM command env includes `CAMELAI_CONNECTIONS_RPC_URL` and a Python notebook can call `find` plus `invoke` without receiving credential env vars.

Only add `invoke` checks for read-only or idempotent methods.

## Local Docker Database Smoke

For self-hosted SQL coverage, run:

```bash
bun run test:connections:local-db
```

This script starts Docker containers for Postgres, MySQL, Redis, and ClickHouse. Postgres/MySQL run through the Go data-proxy sidecar. Redis runs through a small Upstash-compatible REST shim exposed with an ngrok HTTPS tunnel, so the Redis broker still sees a remote HTTPS endpoint and the product code does not need local-URL exceptions. ClickHouse is exposed through ngrok HTTPS to exercise the broker's HTTPS-only endpoint validation. It verifies `/rpc/connections` method discovery, table listing, read-only SQL queries, and Redis key reads.

MongoDB and Turso are not plain-container tests because their brokers talk to provider HTTP APIs rather than stock database wire protocols. The local smoke test covers them with provider-compatible HTTP shims exposed through ngrok HTTPS:

- MongoDB uses an Atlas Data API-compatible shim.
- Turso uses a libSQL HTTP API-compatible shim.

## Auth And Reauth Checks

Maintain one intentionally invalid or revoked test connection per auth family in staging:

- OAuth token revoked or missing refresh token should become `auth_status = needs_reauth`.
- API key/token missing should become `auth_status = setup_incomplete`.
- Provider `403` should become `auth_status = missing_scopes`.
- Successful OAuth reauth should update the existing integration, not create a duplicate, and clear auth errors.

The user-facing check is that the `list` action on `/rpc/connections` returns a `reauthUrl` for unhealthy connections. The worker-facing check is that RPC failures include structured error data with `auth_status` and `reauth_url`.

## Release Gate

Before marking the PR ready:

1. CI tests above pass.
2. Staging smoke test passes for at least one first-party remote broker, one hosted broker, and one SQL broker.
3. One OAuth reauth flow is manually exercised end-to-end on staging.
4. One deliberately invalid token is verified to surface `needs_reauth` in `/rpc/connections` and the connections page.

## Follow-Up TODO: Harden SQL Read-Only Guard

The SQL broker's read-only preflight should be hardened before
we rely on it as the primary safety boundary. The sandbox data proxy already
runs read-mode queries inside a read-only transaction and rolls back, but the
worker-side guard should reject obvious mutations before forwarding them.

Planned fix:

- Strip or ignore comments and string literals while scanning SQL.
- Reject multiple statements via semicolons outside strings/comments.
- Reject mutating keywords outside strings/comments, including `insert`,
  `update`, `delete`, `merge`, `drop`, `alter`, `create`, `truncate`, `grant`,
  `revoke`, `call`, `execute`, and `copy`.
- Reject `EXPLAIN ANALYZE`, or only allow `EXPLAIN` when the explained statement
  is itself read-only.
- Reject lock-oriented reads like `FOR UPDATE`, `FOR SHARE`, and
  `LOCK IN SHARE MODE`.
- Preserve legitimate read-only queries such as `SELECT`, read-only `WITH`,
  `SHOW`, `DESCRIBE`, `DESC`, and `EXPLAIN SELECT`.

Add tests for:

- `WITH x AS (DELETE ... RETURNING ...) SELECT ...` rejects.
- `EXPLAIN ANALYZE DELETE ...` rejects.
- `SELECT 1; DELETE ...` rejects.
- `SELECT ... FOR UPDATE` rejects.
- `SELECT 'delete from users' AS text` still passes.
