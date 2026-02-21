# Sandbox Host (Go)

The sandbox host runs on the Azure VM and manages:

- Docker + gVisor sandbox lifecycle
- Per-sandbox host directories under `WORKSPACES_ROOT`
- Control-plane proxying (`/health`, `/chat`)
- Worker API proxying via `/proxy/:threadId/*`

Requires Go 1.24+.

Runtime ports:

- `PORT` (default `80` on Linux, `4400` on non-Linux): control/API listener used by Workers VPC binding
- `SANDBOX_PROXY_PORT` (default `8081` on Linux, `4401` on non-Linux): proxy-only listener used by containers (`/proxy/*`)

VM firewall rules block `docker0` traffic to `PORT` and only allow `docker0` to `SANDBOX_PROXY_PORT`.

## Storage model

Production Linux defaults:

- `WORKSPACES_ROOT=/srv/sandboxes`
- `SANDBOX_HOST_STATE_DB=/srv/sandboxes/.sandbox-host/state.db`

Each sandbox maps to a leaf directory:

- Host: `/srv/sandboxes/<sandbox-id>`
- Container bind mount: `/home/claude`

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
- `SANDBOX_HOST_STATE_DB=.sandbox-host/state.db`
- `CONTAINER_PROXY_BASE_URL=http://host.docker.internal:${SANDBOX_PROXY_PORT}/proxy` (override if your Docker gateway differs)

Run locally:

```bash
bun run dev:sandbox-host
```

`bun run dev:sandbox-host`:

- builds `chiridion-sandbox:latest` before launch
- starts the Go sandbox-host service
- watches sandbox image inputs and rebuilds on change by default (`SANDBOX_WATCH_IMAGE=0` to disable)
- loads local secrets from process env first, then `.dev.vars`, then `infra/terraform.tfvars`/`infra/*.auto.tfvars` when present
- `publish` builds the renderer bundle at runtime inside the container (no prebuilt `sandbox/create-worker/renderer-dist` required)

For R2 host-level FUSE mounts, set `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID`, and `R2_BUCKET_NAME`.
The sandbox-host mounts R2 on the host and bind-mounts per-workspace directories into containers.

`SANDBOX_PROXY_SECRET` must match between the main worker and sandbox-host. If it is missing,
container proxy calls (for example `/api/claude/v1/messages`) are rejected.

## VM scripts

- Provision/upgrade host: `services/sandbox-host/scripts/setup-host.sh`
- XFS project quota helper: `services/sandbox-host/scripts/xfs-project-quota.sh`

## Test

```bash
go test ./...
```
