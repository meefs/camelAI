# Sandbox Host Infrastructure

This Terraform module provisions one Azure sandbox-host environment:

- resource group, VNet, subnet, NSG, public IP, and NIC
- Ubuntu VM that runs the **project runtime service** (and related host agents)
  from the external **`qaml-ai/project-runtime-service`** repo
- Premium SSD v2 data disk mounted at `/srv/sandboxes`
- Azure Container Registry for sandbox images
- cloud-init bootstrap for host setup

Use one Terraform workspace/state per environment. Do not apply staging and prod
from the same state file.

> **Note:** The in-repo Go `services/sandbox-host` tree and `bun run deploy:go:*`
> scripts were removed from this app repo. Host binaries (including data-proxy)
> live in `project-runtime-service`. Deploy and host-setup scripts for the shared
> Azure VMs are owned there — do not reintroduce an in-repo copy.
>
> `main.tf` still references `../services/sandbox-host/scripts/setup-host.sh` for
> cloud-init. That path is stale in this checkout; treat Terraform apply from
> this tree as needing a sibling checkout or an updated setup-script source
> before use. Prefer Tailscale SSH + the runtime-service deploy path for day-to-day
> host changes. Self-host cloud infra (separate from these shared VMs) lives in
> [`selfhost/`](./selfhost/) — see [`selfhost/README.md`](./selfhost/README.md)
> and [`docs/self-hosting.md`](../docs/self-hosting.md).

## Environments

Prod currently runs in Central US and is intentionally large:

```bash
terraform workspace select prod || terraform workspace new prod
terraform apply -var-file=prod.tfvars
```

Staging should run on its own VM and Cloudflare VPC service so host deploys and
runtime state do not affect prod:

```bash
terraform workspace select staging || terraform workspace new staging
terraform apply -var-file=staging.tfvars
```

Examples are provided in:

- `prod.tfvars.example`
- `staging.tfvars.example`

Copy the relevant example to `prod.tfvars` or `staging.tfvars`, fill in secrets,
and keep those real tfvars files out of git.

## Host access

For interactive access, use Tailscale SSH as user `[REDACTED]`; normal access
should not require shared private keys:

```bash
tailscale ssh [REDACTED]@[REDACTED]-sandbox-staging
tailscale ssh [REDACTED]@[REDACTED]-sandbox-prod
```

Tailscale host IPs: staging `100.115.221.105`, prod `100.112.135.2`.

Public SSH ingress is intentionally not opened by Terraform. Administrative and
deploy SSH should go through Tailscale. Keep `sshd` running on the host so
Tailscale clients can reach it, but do not add Azure NSG port 22 rules except
as a temporary break-glass action.

GitHub Actions deploys join the tailnet with `tailscale/github-action`.
Configure the repository with a Tailscale OAuth client (`TS_OAUTH_CLIENT_ID` and
`TS_OAUTH_SECRET`) that can create ephemeral `tag:ci` nodes. The OAuth client
needs writable `auth_keys` scope for `tag:ci`, and the tailnet policy must allow
that tag to reach the prod and staging VMs on TCP/22.

## Cloudflare Wiring

After provisioning a new staging VM, create a separate Cloudflare Tunnel/VPC
service for that VM and update `wrangler.staging.jsonc` so the
`PROJECT_RUNTIME_HOST` binding points at the staging service ID. Production
should keep its existing service ID.

The `SANDBOX_HOST` VPC binding and the VM Go data-proxy are retired: SQL
queries/exports now run in the `DbQuerySandbox` Cloudflare container with a
static egress IP via the on-host gost SOCKS relay (`infra/db-egress-relay/`,
`docs/db-egress-relay.md`). Worker-side entrypoints (`data-proxy.ts`,
`data-proxy-service.ts`) remain but dispatch to the container, not the VM.

## Egress-relay era (2026-07-10)

The sandbox VMs were decommissioned down to **static-IP database egress
relays**: gost SOCKS5 (docker compose in `db-egress-relay/`) + cloudflared +
tailscaled on `Standard_E2as_v7`, OS disk only. The legacy project-runtime /
sandbox-host services and both data disks are gone (final backups retained:
prod in the `bv-chiridion-sandbox-prod` vault, staging as
`*-final-20260710` snapshots).

**The public IPs must never be released** — they are allowlisted in customer
database firewalls. Protections: `prevent_destroy` on the Terraform resource
and an out-of-band Azure `CanNotDelete` lock named `protect-static-egress-ip`
on each `pip-chiridion-sandbox-*` (created via az cli; not in Terraform state).
