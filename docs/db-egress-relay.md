# Static-IP database egress for Cloudflare sandbox containers

## Why

Customer databases are firewalled to the sandbox host VM's static IP
(`SANDBOX_OUTBOUND_IP` in `src/lib/sandbox-network.ts`, surfaced in the
connection setup UIs). Cloudflare Containers egress from shared Cloudflare IP
space and offer no static egress IP, so a Cloudflare-hosted query container
cannot dial customer databases directly without breaking that contract. The
fix: the container never dials the database — it dials a SOCKS relay on the
sandbox host VM, and the VM makes the database connection from its static IP.

Since 2026-07, `DbQuerySandbox` is **the** SQL query/export path: it replaced
the Go data-proxy on the Azure VM (external `qaml-ai/project-runtime-service`
`cmd/data-proxy`) and the `SANDBOX_HOST` Workers VPC binding for all three
consumers — the connection MCP (`sql-database-mcp.ts`), the `DATA_PROXY`
service binding for deployed user apps, and the sandbox container routes
(`/api/{mssql,postgres,mysql}/query`). See "Cutover + decommission" below.

## Architecture

```text
data-proxy.ts (worker; legacy request/response contract, caller ALREADY authorized)
  └─ db-query-compat.ts (pure legacy ↔ runner mapping)
       └─ db-query-service.ts runDbQuery / runDbExport
            └─ DbQuerySandbox container (Cloudflare)
                 single stateless exec: runner piped into node over stdin
                 ├─ queries: JSON result on stdout (byte-capped)
                 ├─ exports: Snappy Parquet written straight into the mounted
                 │           warehouse R2 prefix (credential-less bucket mount)
                 └─ cloudflared access tcp ──WSS/443──▶ Cloudflare edge
                      (Access service token)   └─ sandbox-host tunnel (VM dials
                                                  out; NSG deny-all-inbound)
                                                    └─ gost SOCKS5, 127.0.0.1:1080
                                                         └─ TCP from the VM's
                                                            static IP to the DB
```

- **Legacy surface** — `workers/main/src/data-proxy.ts` keeps the Go
  data-proxy's request/response contract byte-compatible
  (`mssqlQuery`/`postgresQuery`/`mysqlQuery` + `sqlExportToWarehouse`;
  defaults, error codes `MSSQL_ERROR`/`MYSQL_ERROR`+number / postgres
  SQLSTATE, `ETIMEOUT`/`ECONNREFUSED`/`ENOTFOUND` statuses, the
  `Missing required fields` / mode messages). The pure mapping lives in
  `db-query-compat.ts` (node-tested in `tests/db-query-compat.test.ts`).
  One sandbox per workspace (`getSandbox(…, 'ws-<workspaceId>')`).
- **Worker orchestration** — `workers/main/src/db-query-service.ts`. In relay
  mode it opens the container's egress allowlist to exactly the relay hostname
  (`DbQuerySandbox.ensureRelayEgress`) and ensures the `cloudflared access
  tcp` forwarder is running (`startProcess`, relay credentials in process env —
  never baked). Then, in a **single stateless `exec`**, it pipes the runner
  into `node --input-type=module` over stdin with the request + SOCKS creds in
  the exec env, and parses the single JSON line the runner writes to stdout.
  The runner source (`db-query-sandbox-assets/runner/db-query-runner.mjs`) is
  embedded in the worker at build time via Vite `?raw`, so **changing how we
  query/export is a worker-only deploy — no image rebuild.**
- **Runner** — engines `postgres` (pg), `mysql` (mysql2), `mssql` (tedious
  with its custom `connector` socket hook). `mode: "read"` runs inside a
  transaction that is always rolled back (Go-parity safety net; postgres/mysql
  use READ ONLY transactions, which reject writes outright); `mode: "modify"`
  returns `rowsAffected`. Point queries are uncapped-rows but byte-capped
  (`maxResponseBytes`, `DATA_PROXY_MAX_RESPONSE_BYTES` parity, 413 on exceed).
  TLS modes: `disable` / `require` / `verify-ca` / `verify-full` / `prefer`
  (mysql: try TLS, fall back to plaintext when the server lacks it —
  go-sql-driver `preferred` parity).
- **Exports** — `op: "export"` streams the read-only result set row-by-row
  into a Snappy **Parquet** file written directly at `'/' + r2Key` inside the
  workspace's warehouse R2 prefix, which `DbQuerySandbox` mounts READ-WRITE
  via the SDK's credential-less bucket mount (egress interception → the
  `WAREHOUSE_EXPORT_BUCKET` binding — same mechanism as `AnalysisSandbox`'s
  read-only mounts; no S3 keys anywhere). Column typing matches the Go
  encoder: unambiguous ints/floats/bools native, everything else UTF8 for
  DuckDB to CAST (DECIMAL/unsigned-BIGINT/BIT/dates stay strings). Rows never
  pass through the Worker. On failure the runner unlinks the partial file (a
  process-level uncaught handler covers driver crashes too), and
  `sql-database-mcp.ts` HEAD-verifies the object after success.
- **Container image** — `workers/main/db-query-sandbox.Dockerfile`. Carries
  only the node runtime, the drivers
  (`pg`/`pg-cursor`/`mysql2`/`tedious`/`@dsnp/parquetjs`/`socks` at
  `/opt/db-query-runner/node_modules`), and cloudflared. No query logic, no
  long-running server. `node` runs with cwd `/opt/db-query-runner` so the
  stdin runner's bare `import "pg"` resolves against the baked `node_modules`.
- **VM side** — `infra/db-egress-relay/` (docker-compose + gost). Destination
  filtering there mirrors the guard in `db-query-runner.mjs`; keep them in sync.

### Security model

- **Authorization is worker-side.** By the time a request reaches the runner,
  the caller must already be allowed to query that database. The container is
  trusted infrastructure — no user code executes in it — so per-request
  database credentials inside it are tenant-scoped data, not a boundary break.
- **Destination filtering twice.** The runner refuses non-public targets
  (loopback, RFC1918, link-local/IMDS, CGNAT, multicast, v4-mapped v6, blocked
  hostname suffixes) and only ever sends IP literals to the relay; gost
  enforces the same list VM-side for anything else that reaches it.
- **Three auth layers to the relay:** Access service token at the edge, SOCKS
  username/password at gost, loopback-only bind on the VM.
- **Egress posture:** `enableInternet = false`, block-all `allowedHosts`
  opened per-run to exactly the relay hostname, `interceptHttps = true`
  (same posture as `AnalysisSandbox`). Export writes ride the intercepted R2
  mount, not the internet.
- **Tenancy:** one container per workspace, and the export mount is scoped to
  that workspace's `warehouse/<ws>/` prefix, so a container can never see
  another tenant's staged objects.

## Relay is optional (direct mode)

The static-IP relay is opt-in. When `DB_EGRESS_RELAY_HOSTNAME` is unset, the
system runs in **direct mode**: the container dials the database straight from
its own Cloudflare IP — no SOCKS, no cloudflared forwarder — and the database
sees whatever egress IP the container has (no static-IP guarantee). The
container's `enableInternet` flips to `true` in this mode (raw TCP to the DB
port isn't governed by the HTTP-only allowlist), decided in the
`DbQuerySandbox` constructor from the env. The runner still applies the full
SSRF guard in both modes, so internal/link-local/IMDS targets are always
refused. Use direct mode when you don't need firewall allowlisting; use the
relay when customers pin their firewall to `SANDBOX_OUTBOUND_IP`.

## Configuration

Per environment (see `infra/db-egress-relay/README.md` for the VM/Cloudflare
side): var `DB_EGRESS_RELAY_HOSTNAME`; secrets
`DB_EGRESS_RELAY_ACCESS_CLIENT_ID/SECRET` (Access service token) and
`DB_EGRESS_RELAY_SOCKS_USERNAME/PASSWORD` (gost credentials). Leave them unset
to run in direct mode.

## Smoke test

```bash
curl -X POST https://staging.camelai.dev/api/admin/db-query-sandbox/query \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"engine":"postgres","target":{"host":"<public-test-db>","port":5432,
       "user":"...","password":"...","database":"..."},"sql":"SELECT 1 AS ok"}'
```

Expected: `{"ok":true,"rows":[{"ok":1}],...}`, and the test database's logs
show the connection arriving from the VM's static IP. A target of
`169.254.169.254` (or any private IP) must fail with a `blocked IPv4 range`
error.

For a full local matrix (all three engines: read/modify/rolled-back-tx/named
params/error codes/byte cap + Parquet exports validated with DuckDB), run real
databases on a docker network with a public-looking subnet so the SSRF guard
admits them, and pipe the runner into a `node:22` container exactly like
production does — see the harness pattern used for the 2026-07-10 verification
below (`docker network create --subnet=52.55.55.0/24 …`; the runner container
joins the network and gets the request via `DB_QUERY_REQUEST`).

## Verified end-to-end

**2026-07-09 (staging, transport):** a throwaway rig proved the relay path
against the staging VM — WSS through the sandbox egress interception works,
the static-IP guarantee holds (egress observed as the VM's public IP), the
SSRF guard and SOCKS auth hold, and arbitrary TCP (not just 443) is granted.

**2026-07-10 (local, full engine matrix, direct mode):** the exact production
exec (runner piped into `node --input-type=module` over stdin, cwd = drivers
dir) ran against real postgres:16 / mysql:8.4 / mariadb:11(no-TLS) /
SQL Server 2022 containers:

- postgres: typed reads, modify `rowsAffected`, read-mode INSERT refused by
  the READ ONLY transaction (SQLSTATE `25006`), 413 byte cap, `28P01` auth
  error code, SSRF guard refusal.
- mysql: modify + read, read-mode DELETE refused (`ER_…_READ_ONLY_TRANSACTION`
  errno 1792), empty database allowed, driver errno surfaced (1146), `prefer`
  connected TLS-first against a TLS server and fell back to plaintext against
  a no-TLS server, `require` refused the no-TLS server.
- mssql (tedious custom connector): reads with named `@params`, modify,
  read-mode DELETE rolled back, driver `number` surfaced (208), multi-result
  sets keep only the first (Go parity).
- exports: all three engines produced Snappy Parquet validated by DuckDB with
  Go-parity column typing (50k-row export exercised multiple row groups);
  a failed export left no partial file.

## Cutover + decommission checklist

The legacy path (Go data-proxy on the Azure VM behind the `SANDBOX_HOST` VPC
binding) is code-removed as of this change; the wrangler configs no longer
declare `SANDBOX_HOST`. To finish decommissioning after this deploys:

1. Deploy staging → run the smoke above + a connection-MCP query + an `export`
   through a real workspace → deploy prod and re-verify.
2. Watch `chiridion_observability_*` for db-query errors for a soak window.
3. Stop/disable the VM data-proxy service (`chiridion-data-proxy.service` /
   `qaml-project-runtime-data-proxy.service`) — nothing calls it anymore.
4. Delete the two `SANDBOX_HOST` VPC service configs in the Cloudflare
   dashboard (ids were in git history of `wrangler*.jsonc`).
5. Before shrinking the VM: confirm nothing sets `DATA_PROXY_SSH_TUNNEL_*`
   (unset on staging as of 2026-07-10; feature was dropped, not ported —
   confirm on prod) and keep the **static public IP** attached through any
   resize/rebuild: `SANDBOX_OUTBOUND_IP` is the customer-facing allowlist
   contract, and gost + cloudflared are what keep it meaningful.
6. End state for the Azure box: gost SOCKS relay + cloudflared tunnel only
   (plus whatever the project-runtime decommission still needs).

## Open items / known unknowns

1. **Latency.** Every packet rides container → edge → tunnel → VM. Fine for
   agent-interactive queries; measure bulk exports (they now also carry the
   Parquet write through the R2 mount).
2. **Metering.** Production wiring should add usage rows equivalent to the
   data-proxy's `credit_chargeable` accounting; today the smoke route only
   records an observability event.
3. **Export size ceiling.** The Parquet file stages on the container's disk
   (s3fs) before the on-close upload; the container disk, not memory, bounds
   a single export. The 120s export timeout bounds it in practice.
