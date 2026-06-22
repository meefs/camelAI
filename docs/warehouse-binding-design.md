# WAREHOUSE binding — per-tenant cross-source analytical compute

**Status:** Draft / proposal
**Origin:** SecLock `freight-analyzer` escalation (workspace `1d83d721-…`). See also PR #889 (data-proxy `timeoutMs`).

## Problem

Deployed apps that join data *across two sources* are forced to do the join inside a **Durable Object** — the only stateful/compute primitive available to user apps in our dispatch namespace. `freight-analyzer` reconciles **D365/Dynamics charges** (via `DATA_PROXY` MySQL) against **BigQuery legacy freight**, matched by `tracking_number`, inside `FreightDO` using `json_each(?)` over thousands of IDs. DO-SQLite is single-threaded, 30 s CPU / 128 MB, billed on active-duration **and** rows-read — so the join hits CPU/memory resets and is expensive. The cross-source join genuinely needs a tier that holds *both* sources; neither D365 nor BigQuery alone can do it.

## Goal / non-goals

**Goal:** a virtualized `WAREHOUSE` binding — a place to run heavy cross-source SQL on real CPU/RAM, scoped per workspace, with **data staying inside Cloudflare**. A **primitive** (compute + query), not a managed-warehouse product: apps keep owning their own extract/ETL logic.

**Non-goals:** managed ETL / connectors / scheduling / freshness; a shared multi-tenant database; replacing the transactional **write** path of `DATA_PROXY`.

## Architecture (data flow)

```
 caller (deployed app  ·  or agent via js_exec)
   │ 1. exportConnection({connection, query})          2. runCode({ code })
   ▼                                                    ▼
 warehouse Worker (platform-owned, tenant-scoped via props)
   │ resolve creds server-side + presign R2 PUT          │ getSandbox(workspaceId) → fresh session
   ▼                                                      ▼
 sandbox-host VM  ── runs read query, streams ──►  R2   ◄── mounted/pre-loaded ──  Cloudflare Container
   (static egress 20.46.233.68)        NDJSON/Parquet         (SEALED: enableInternet=false,
        ▼                              warehouse/<ws>/…         no egress) Python + DuckDB reads R2,
   customer source (D365 / ClickHouse / Stripe / …)            cross-source join → results → caller
```

Key properties:
- **The container has NO network** (`enableInternet=false`) — pure compute. It never sees a credential or reaches a connection; it only reads staged R2 objects.
- **Extraction is an async task on the VM**, with no Worker wall-clock limit — long extracts stream straight to R2 via a presigned PUT.
- DuckDB **never connects to customer DBs.** SQL extracts run in the data proxy, so the customer-facing egress stays on the **static IP `20.46.233.68`** (firewall allowlists unaffected) and there is no per-GB container egress for source data.
- Compute runs in a **Cloudflare Container** (Sandbox SDK), **one instance per workspace** (`sandboxId = workspaceId`), gVisor microVM isolation, **fresh session per call**. Cloudflare owns the sandboxing.

## Key new capability: `DATA_PROXY` columnar export (the linchpin)

Today `DATA_PROXY` returns JSON capped at 8 MB — a query tool, not a bulk loader. Add a **streaming columnar export** so DuckDB can read it directly:

- `POST /v1/.../data-proxy/export` runs the SQL on the existing tenant-scoped, static-egress path and **streams the result set** as:
  - **Parquet** (primary — compact, typed, supports projection/predicate pushdown on read), or
  - **Arrow IPC stream** (alternative — naturally sequential/streaming, lowest latency).
- **No 8 MB cap**; backpressured stream; the `timeoutMs` clamp from PR #889 applies.
- Covers MySQL/Postgres/MSSQL **and** BigQuery (a durable BigQuery method here also resolves the background-auth gap from the escalation's issue #4).

## Sealed container + async export-to-R2

The container has **NO network at all** (`enableInternet = false`, no egress proxy, no bridge) — pure compute, the strongest isolation posture. All data movement is an explicit **server-side async export task** that stages the result in R2; the container only ever reads R2. This supersedes the earlier connections-bridge/egress-proxy approach: it removes the read-only network gate, the `orgId`-in-egress-handler problem, and any path for the container to reach a credential.

**Export is a first-class connection method, not a warehouse tool.** Each connection type's handler exposes an `export` method next to `execute_sql_readonly` — `sql-database-mcp.ts` (Postgres/MySQL family) and `bigquery-mcp.ts` (BigQuery), extensible to ClickHouse/Snowflake/etc. It's discovered via `env.CONNECTIONS.methods()` and invoked through the existing connections machinery: `await connections[alias].export({ query })`. Resolution runs entirely in the Worker (creds server-side); the long-running extract runs on the **sandbox-host VM** (no Worker wall-clock limit) and streams the result **straight to R2**:

1. Worker resolves the connection — `getWorkspaceIntegrations` + `resolveIntegration`, then `createSqlDatabaseClient` (SQL) decrypts creds — and mints a **presigned R2 PUT URL** for the staging key `warehouse/<workspace>/<connection>/<hash(query)>.ndjson`.
2. Worker calls the VM's **`/export-to-r2`** with the SQL request + the presigned URL. The VM runs the read query (reusing the `/export` execution) and **streams NDJSON straight to R2** via the presigned PUT. Because this runs on the VM, it can take minutes — the original long-extract problem, solved at the root.
3. Orchestration is a **deterministic workflow** (the runtime already ships): `step(connections.d365.export)` ∥ `step(connections.bq.export)` → `step(warehouse_run_code over R2)`. The Workflow's durable steps *are* the task state — no bespoke poll/status API. Non-SQL connections export the same way via their handler's `export` method.

> **For Jon / SecLock:** this removes the need for the `FreightDO` alarm machinery entirely — a scheduled deterministic workflow (export D365 ∥ export BigQuery → reconcile) replaces `setAlarm` + `failCount` + `waitUntil` self-chaining, which also dissolves escalation issues #3 (waitUntil auth) and #4 (DO alarms). He can adopt this with the existing workflow runtime as the `export` methods land.

**`runCode` reads the staged R2 object** — `read_parquet`/`read_json_auto` over a mounted R2 path (Sandbox `mountBucket`, platform-mediated — not internet) or a file pre-loaded by the platform. No credential, no network, ever touches the container.

Read-only is inherent (an *export* only reads). The static-egress IP `20.46.233.68` is preserved (the VM still makes the source connection). R2 graduates from optional cache to the staging layer.

### Honest tradeoff of the direct path
- **Parquet over HTTP** is read most efficiently with HTTP **range requests** (footer + column chunks). On-the-fly generation can't easily serve ranges, so the container either (a) downloads the whole Parquet object, or (b) consumes an **Arrow stream**. For moderate extracts both are fine; range-optimized reads want a *materialized* object — which is exactly where the optional R2 cache (below) earns its place. Recommendation: **Arrow stream for the pure-direct path, Parquet when caching to R2.**
- The pure-direct path **re-extracts on every join** (re-runs the source query). Fine for ad-hoc; for repeated re-syncs over snapshot data the optional R2 cache avoids re-hammering the customer DB.

## `WAREHOUSE` API (two call sites, one service)

A thin wrapper over the Sandbox SDK code interpreter — the caller runs its **own Python** in the workspace container. **Python-only** (no JS): DuckDB's first-class API is Python and this tier exists for DuckDB-via-Python analytics. **DuckDB is pre-installed and heavily encouraged.** No bespoke query DSL.

```ts
const res = await env.WAREHOUSE.runCode({
  code: `
import duckdb
con = duckdb.connect()
con.install_extension("json"); con.load_extension("json")
# credential-free via the connections bridge (resolves the connection BY NAME, server-side)
con.execute("CREATE TABLE d365 AS SELECT * FROM read_json_auto('http://connections.internal/export?connection=Infinity-D365&q=' || ...)")
con.execute("CREATE TABLE bq   AS SELECT * FROM read_json_auto('http://connections.internal/export?connection=legacy-bq&q=' || ...)")
rows = con.execute("SELECT * FROM d365 JOIN bq USING(tracking_number) WHERE d365.customer_charged <> bq.freight").fetchall()
print(rows)
`,
});
```

- `runCode({ code })` — run Python in a **fresh, isolated session** of the workspace's container; returns the interpreter result (stdout / rich outputs).
- The caller owns everything inside the code (its SQL, its joins); the platform owns the container, isolation, and credential injection.

**Two call sites, same `WarehouseService` (scoped to the workspace):**
- **Deployed user apps** → the virtualized binding `env.WAREHOUSE.runCode({ code })`.
- **Agent / chat (`js_exec`)** → the codemode tool `await tools.warehouse_run_code({ code })`, wired in `chat-thread-do.ts` via `ctx.exports.WarehouseService({ props })` (mirrors `take_screenshot` → `AppScreenshotBinding`). Lets the agent run warehouse analytics during a session, not just deployed apps.

### Which connections are reachable + discovery
**All** workspace connections are reachable from the warehouse via the bridge. They split two ways:
- **Streamable** (the `/export` verb, uncapped into DuckDB): the SQL data-proxy family — `postgres`, `mysql`, `neon`, `planetscale` — per `isSqlDatabaseMcpIntegration`. (MSSQL: `/export` supports it but `createSqlDatabaseClient` doesn't yet emit an mssql client — resolver fix pending. ClickHouse/Snowflake/BigQuery: streamable once they get export resolvers.)
- **Invoke-only** (the `/invoke` verb, JSON, method's own limits): everything else — ClickHouse/Snowflake/Mongo today, plus Stripe/Slack/HTTP "other" — same as `env.CONNECTIONS` in js_exec.

Discover them with `WarehouseService.listConnections()`:
- Deployed apps → `await env.WAREHOUSE.listConnections()`
- js_exec → `await tools.warehouse_list_connections()`

Returns `[{ id, name, type, displayName, streamable }]` — the full connection catalog (`listConnections` from `connections-runtime`) annotated by `annotateWarehouseConnections` (`streamable = isSqlDatabaseMcpIntegration(type)`).

## Container / Sandbox lifecycle

- `sandboxId = workspaceId` → one warm container per tenant; strong microVM isolation.
- **Session per call** (`createSession({ id, cwd: /sessions/<uuid> })`): each call gets its own working directory, so concurrent calls on the same workspace never clobber each other's files; the session is `deleteSession`'d when the call finishes.
- **DuckDB + `httpfs` pre-installed** in the image; executed via the SDK's `runCode` (Python interpreter).
- Cold start ~1–3 s; `sleepAfter` keeps active workspaces warm; **disk is ephemeral**.
- Default instance `standard-2` (1 vCPU / 6 GiB / 12 GB disk); ceiling `standard-4` (**4 vCPU / 12 GiB / 20 GB — hard, even custom types**). DuckDB spills to disk.

## R2 — optional write-through cache, not a middleman

D365 is **snapshot-based** (the app resolves a snapshot prefix `P`), so the warehouse *may* cache the materialized Parquet to R2 keyed by `(workspace, source, snapshot)`. Warm path: read from R2 if the snapshot is current, else re-export from `DATA_PROXY` and refresh. R2 access from the container is via the **R2 Worker binding (no creds in the container)**. This is a perf/cost optimization layer — the direct-data-proxy path works **without** it.

## `cf-api-proxy` changes

- Add `WAREHOUSE` to `ALLOWED_VIRTUAL_SERVICE_BINDINGS`.
- At deploy, rewrite the user's `WAREHOUSE` binding → service binding to the platform warehouse Worker with injected `props { orgId, workspaceId, userId }` — identical to the `DATA_PROXY` / `CONNECTIONS` path.
- User scripts never get a raw container binding; the container holds only an opaque single-use ref. All tenant scoping is server-side.

## Security / isolation

- One container per workspace (`sandboxId = workspaceId`); the egress proxy authenticates by the unforgeable container identity (`ctx.containerId`) — no token the container can present or leak.
- **No customer-DB creds in the container** — creds are resolved and applied in the Worker-runtime connections bridge, keyed on the unforgeable container identity; the container only ever references connections by name. R2 via Worker binding, no creds in container.

## Limits & escape hatch

- Hard ceiling **12 GiB RAM / 20 GB disk** per container → good for tens-of-GB joins with spill, not hundreds-of-GB resident. Tenants whose working set exceeds this fall back to a dedicated VM path (out of scope; flag at provisioning).
- Account concurrency (6 TiB mem / 1,500 vCPU) is hundreds of concurrent instances — comfortable for bursty, mostly-idle workspaces.

## Cost

- ~$0.002 per 60 s join (standard-2), **scale-to-zero** — idle workspaces cost nothing; optional warm tail per active session. R2 cache trades storage $ for fewer re-extracts. Beats an always-on VM pool for bursty multi-tenant use.

## Rollout

1. **Shipped:** PR #889 — per-request `timeoutMs` (30 → 120 s). Immediate relief.
2. **Done in this PR:** `DATA_PROXY` streaming `/export` (NDJSON); `WAREHOUSE` virtualized binding + `WarehouseService` (`runCode` + `listConnections`); per-call sessions; `js_exec` tools; connection listing.
3. **Done in this PR — `export` connection method (surface + plan):** `export` added to the SQL (`sql-database-mcp.ts`) and BigQuery (`bigquery-mcp.ts`) method catalogs, next to `execute_sql_readonly` — discoverable via `env.CONNECTIONS.methods()`. `warehouse-export.ts` holds the deterministic plan (`buildSqlExportPlan` / `sqlClientToExportBody` / `warehouseExportKey`). Execution is **deploy-gated and fails loud** (501) until the VM/R2 infra exists. Unit-tested. (Container is sealed — supersedes the network bridge.)
4. **Remaining — VM export-to-R2 + sealed container** (deploy-gated):
   - **VM (Go):** `/export-to-r2` — run the read query (reuse the `/export` execution) and stream NDJSON straight to a presigned R2 PUT URL.
   - **Worker:** wire `runSqlWarehouseExport` (presign R2 PUT for `plan.r2Key` + POST to the VM) + the `WAREHOUSE_EXPORT_BUCKET` binding; same for the BigQuery `export` handler (BQ → R2).
   - **Container:** `WAREHOUSE_SANDBOX` image (Python + DuckDB), **`enableInternet = false`**, no egress proxy; reads the staged R2 object via `mountBucket` (platform-mediated) or a pre-loaded file.
5. **Phase 3 (optional):** R2 staging lifecycle/TTL; warm-pool tuning; ClickHouse/Snowflake export methods.
6. **Proving ground:** migrate `freight-analyzer`'s consignee billing audit + D365 sync off `FreightDO` onto `WAREHOUSE`.

## Open questions

- Arrow-stream (direct) vs Parquet-in-R2 (cached, range-optimized) as the default interchange — likely both, by phase.
- Result return: inline rows vs result object in R2 for large outputs.
- Warm-pool policy and per-tenant concurrency caps.
- BigQuery extract via a durable `DATA_PROXY` method (also fixes the escalation's background-auth issue) vs the app's existing token path.
