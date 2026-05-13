# Sandbox Host (Go)

The sandbox host runs on the Azure VM and manages:

- Docker + gVisor sandbox lifecycle
- Per-sandbox host directories under `WORKSPACES_ROOT`
- Control-plane proxying (`/health`, `/chat`)
- Data proxy forwarding (`/v1/workspaces/{orgId}/{workspaceId}/data-proxy/*`)

Requires Go 1.24+.

Runtime ports:

- `PORT` (default `80` on Linux, `4400` on non-Linux): control/API listener used by Workers VPC binding
- `DATA_PROXY_PORT` (default `8090`): localhost SQL data-proxy sidecar (not exposed publicly)

Data proxy:

- Data proxy queries are handled by a dedicated Go sidecar process (`chiridion-data-proxy`) with tighter systemd resource limits.
- sandbox-host forwards `/v1/workspaces/{orgId}/{workspaceId}/data-proxy/*` to the sidecar over localhost (`DATA_PROXY_UPSTREAM_URL`, default `http://127.0.0.1:8090`).
- Query responses are JSON. The sidecar serializes row results incrementally to avoid materializing full recordsets in process memory.

VM firewall rules block `docker0` traffic to `PORT`.

## Storage model

Production Linux defaults:

- `WORKSPACES_ROOT=/srv/sandboxes`
- `SANDBOX_HOST_USAGE_DB_DIR=/srv/sandboxes/.sandbox-host/usage`

Each sandbox maps to a leaf directory:

- Host: `/srv/sandboxes/<sandbox-id>`
- Container bind mount: `/home/claude`
- Python env behavior: sandbox image prewarms a seed cache at `/opt/uv-cache-seed`; entrypoint syncs that into persistent workspace cache at `/home/claude/.cache/uv`; runtime uses `UV_LINK_MODE=hardlink` so installs are fast while both cache and `.venv` survive container restarts. The BigQuery client stack (`google-cloud-bigquery`, `google-cloud-bigquery-storage`, `google-auth`) is cached for fast `uv add`, but not installed into the shared base interpreter.

Recommended host mount options:

- XFS on Premium SSD v2
- `defaults,noatime,prjquota`

Use `services/sandbox-host/scripts/xfs-project-quota.sh` to inspect or override per-sandbox project quotas.

Default quota behavior:

- `SANDBOX_ENABLE_PROJECT_QUOTA=1` on Linux host deployments
- `SANDBOX_DEFAULT_BHARD=100g`
- `SANDBOX_DEFAULT_IHARD=0` (no inode cap unless you set one)

## Local development

Local-mode defaults (non-Linux):

- `CONTAINER_RUNTIME=runc`
- `WORKSPACES_ROOT=.sandbox-host/workspaces`
- `SANDBOX_HOST_USAGE_DB_DIR=.sandbox-host/usage`
- `CONTAINER_IDLE_TIMEOUT_MS=300000` by default. Workspace containers are stopped after five minutes without host-side tool work; open chat websockets alone do not keep a container alive. `IDLE_TIMEOUT_MS` remains supported as a legacy alias.

Run locally:

```bash
bun run dev:sandbox-host
```

`bun run dev:sandbox-host`:

- builds `chiridion-sandbox:latest` before launch
- starts both Go services: `sandbox-host` and `data-proxy`
- watches sandbox image inputs and rebuilds on change by default (`SANDBOX_WATCH_IMAGE=0` to disable)
- loads local secrets from process env first, then `.dev.vars`, then `infra/terraform.tfvars`/`infra/*.auto.tfvars` when present
- `publish` builds the renderer bundle at runtime inside the container (no prebuilt `sandbox/create-worker/renderer-dist` required)

The agent loop, model calls, and web tools run in `ChatThreadDO`. Sandbox-host remains responsible for Docker
workspace lifecycle, filesystem operations, container exec, and data proxy forwarding.

Force local image refresh options:

- `SANDBOX_IMAGE_VERSION=dev-2 bun run dev:sandbox-host` to bump the local image tag (`chiridion-sandbox:dev-2`).
- `SANDBOX_BUILD_NO_CACHE=1 bun run dev:sandbox-host` to force Docker rebuild without layer cache.
- `SANDBOX_IMAGE=<custom-tag> bun run dev:sandbox-host` to use a fully custom image ref.

When the configured image ref changes, sandbox-host now recreates workspace containers instead of reusing stale ones.

For in-container R2 FUSE mounts, set `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID`, and `R2_BUCKET_NAME`.
The sandbox-host derives short-lived R2 temporary credentials scoped to `org/workspace/user-uploads/` (read-only) and `org/workspace/user-outputs/` (read/write), writes root-only credential files under `R2_CREDENTIALS_ROOT` (default `/run/chiridion-r2-creds`), and bind-mounts those files into the container.
The sandbox image uses `goofys` to mount the scoped prefixes at `/mnt/user-uploads` and `/mnt/user-outputs` with stat/type metadata TTLs set to zero.
Credentials default to a 24 hour TTL; override with `R2_TEMP_CREDENTIAL_TTL_SECONDS`.

## VM scripts

- Provision/upgrade host: `services/sandbox-host/scripts/setup-host.sh`
- XFS project quota helper: `services/sandbox-host/scripts/xfs-project-quota.sh`

## Test

```bash
go test ./...
```
