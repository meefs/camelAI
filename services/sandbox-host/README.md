# Sandbox Host (Go)

The sandbox host runs on the Azure VM and manages:

- Docker + gVisor sandbox lifecycle
- Overlay-backed workspace filesystem operations
- Control-plane proxying (`/health`, `/chat`)
- Worker API proxying via `/proxy/:threadId/*`

Requires Go 1.24+.

Runtime ports:

- `PORT` (default `80` on Linux, `4400` on non-Linux): control/API listener used by Workers VPC binding
- `SANDBOX_PROXY_PORT` (default `8081` on Linux, `4401` on non-Linux): proxy-only listener used by containers (`/proxy/*`)

VM firewall rules block `docker0` traffic to `PORT` and only allow `docker0` to `SANDBOX_PROXY_PORT`.

Local-mode defaults (non-Linux):

- `CONTAINER_RUNTIME=runc`
- `OVERLAY_BACKEND=direct` (skip overlayfs/juicefs mount mechanics)
- `WORKSPACES_ROOT=.sandbox-host/workspaces`
- `SANDBOX_HOST_STATE_DB=.sandbox-host/state.db`
- `CONTAINER_PROXY_BASE_URL=http://host.docker.internal:${SANDBOX_PROXY_PORT}/proxy` (override if your Docker gateway differs)

## Run locally

```bash
bun run dev:sandbox-host
```

`bun run dev:sandbox-host`:
- builds `chiridion-sandbox:latest` before launch (fixes missing-image errors)
- starts the Go sandbox-host service
- watches sandbox image inputs and rebuilds on change by default (`SANDBOX_WATCH_IMAGE=0` to disable)
- loads local secrets from process env first, then `.dev.vars`, then `infra/terraform.tfvars`/`infra/*.auto.tfvars` when present

For R2 mounts inside containers, set `CF_API_TOKEN`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID`, and `R2_BUCKET_NAME`
in `.dev.vars` or Terraform tfvars. The sandbox-host mints scoped temporary credentials per container; permanent keys never enter containers.

Local workspace state persists on host bind mounts under `.sandbox-host/workspaces`.

`SANDBOX_PROXY_SECRET` must match between the main worker and sandbox-host. If it is missing,
container proxy calls (for example `/api/claude/v1/messages`) are rejected.

## Test

```bash
go test ./...
```
