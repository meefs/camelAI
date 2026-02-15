# Sandbox Host (Go)

The sandbox host runs on the Azure VM and manages:

- Docker + gVisor sandbox lifecycle
- Overlay-backed workspace filesystem operations
- Control-plane proxying (`/health`, `/chat`)
- Worker API proxying via `/proxy/:threadId/*`

Requires Go 1.24+.

Runtime ports:

- `PORT` (default `80`): control/API listener used by Workers VPC binding
- `SANDBOX_PROXY_PORT` (default `8081`): proxy-only listener used by containers (`/proxy/*`)

VM firewall rules block `docker0` traffic to `PORT` and only allow `docker0` to `SANDBOX_PROXY_PORT`.

## Run locally

```bash
go run ./cmd/sandbox-host
```

## Test

```bash
go test ./...
```
