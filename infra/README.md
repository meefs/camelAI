# Sandbox Host Infrastructure

This Terraform module provisions one Azure sandbox-host environment:

- resource group, VNet, subnet, NSG, public IP, and NIC
- Ubuntu VM for `chiridion-sandbox-host` and `chiridion-data-proxy`
- Premium SSD v2 data disk mounted at `/srv/sandboxes`
- Azure Container Registry for sandbox images
- cloud-init bootstrap that runs `services/sandbox-host/scripts/setup-host.sh`

Use one Terraform workspace/state per environment. Do not apply staging and prod
from the same state file.

## Environments

Prod currently runs in Central US and is intentionally large:

```bash
terraform workspace select prod || terraform workspace new prod
terraform apply -var-file=prod.tfvars
```

Staging should run on its own VM and Cloudflare VPC service so Go deploys and
sandbox-host state do not affect prod:

```bash
terraform workspace select staging || terraform workspace new staging
terraform apply -var-file=staging.tfvars
```

Examples are provided in:

- `prod.tfvars.example`
- `staging.tfvars.example`

Copy the relevant example to `prod.tfvars` or `staging.tfvars`, fill in secrets,
and keep those real tfvars files out of git.

## Deploying Go Services

The Go deploy script is environment-aware:

```bash
bun run deploy:go:prod
bun run deploy:go:staging
bun run deploy:go:sandbox-host:prod
bun run deploy:go:sandbox-host:staging
bun run deploy:go:data-proxy:prod
bun run deploy:go:data-proxy:staging
```

The default `bun run deploy:go` and legacy target-specific commands still deploy
to prod.

If the SSH target changes, override it without editing the script:

```bash
SANDBOX_GO_DEPLOY_HOST=chiridion@203.0.113.10 bun run deploy:go:staging
```

Default SSH targets are `chiridion-vm` for prod and `chiridion-vm-staging`
for staging.

Public SSH ingress is intentionally not opened by Terraform. Administrative SSH
and staging deploy SSH should go through Tailscale. Keep `sshd` running on the
host so Tailscale clients can reach it, but do not add Azure NSG port 22 rules
except as a temporary break-glass action.

Staging GitHub Actions deploys join the tailnet with `tailscale/github-action`
and connect to the staging VM Tailscale IP `100.115.221.105`
(`chiridion-sandbox-staging`). Configure the repository with a Tailscale
OAuth client (`TS_OAUTH_CLIENT_ID` and `TS_OAUTH_SECRET`) that can create
ephemeral `tag:ci` nodes. The OAuth client needs writable `auth_keys` scope for
`tag:ci`, and the tailnet policy must allow that tag to reach the staging VM on
TCP/22.

## Cloudflare Wiring

After provisioning a new staging VM, create a separate Cloudflare Tunnel/VPC
service for that VM and update `wrangler.staging.jsonc` so the `SANDBOX_HOST`
binding points at the staging service ID. Production should keep its existing
service ID.

The `SANDBOX_PROXY_SECRET` secret must match between the staging Worker and the
staging VM. Keep prod and staging secrets separate.
