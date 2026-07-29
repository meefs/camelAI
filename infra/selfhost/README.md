# Docker self-hosting

camelAI supports a single x86_64 Linux host running Docker Compose. The release
stack runs the application with local `workerd`, persists state and project git
repositories in Docker volumes, and starts attached Docker containers for
project builds, notebook analysis, SQL queries, and container egress.

Production installations consume six version-matched release images:

```text
ghcr.io/qaml-ai/camelai-selfhost-app:<release>
ghcr.io/qaml-ai/camelai-selfhost-local-artifacts:<release>
ghcr.io/qaml-ai/camelai-selfhost-project-build:<release>
ghcr.io/qaml-ai/camelai-selfhost-analysis:<release>
ghcr.io/qaml-ai/camelai-selfhost-db-query:<release>
ghcr.io/qaml-ai/camelai-selfhost-container-egress:<release>
```

Tags named `selfhost-v*` publish all six camelAI images and a release manifest
through `.github/workflows/selfhost-images.yml`. The manifest also pins the
tested upstream Pomerium image. Use all seven dependency references from one
manifest.

## Capability status

| Capability | Single-node release |
| --- | --- |
| Web application and reverse-proxy SSO | Supported |
| Bedrock, Anthropic, OpenAI, OpenRouter, or custom key-backed chat | Supported |
| Durable Objects, KV, R2, D1, queues, and workflows | Supported by local `workerd` services |
| Workspace/project source and local git history | Supported |
| Project package installation, builds, and `deploy_project` | Supported by the project-build container |
| Notebook and analysis execution | Supported by the analysis container |
| SQL queries and exports | Supported by the db-query container; outbound database allowlists remain operator-managed |
| Browser Rendering | Supported; Chromium is bundled in the app release |
| Outbound email and password-email verification | Not included |
| Multi-node failover or managed control plane | Not included |

The application container has read-write access to the Docker socket so it can
manage attached execution containers. Treat control of that container as
root-equivalent access to the VM.

The app service also uses the Linux host network because workerd's
`localDocker` sidecars communicate over loopback addresses. A nested Compose
bridge prevents those containers from becoming ready. `SELFHOST_BIND_ADDRESS`
still controls the app listener and defaults to `127.0.0.1`; keep it on
loopback behind the reverse proxy.

## Requirements

- x86_64 Ubuntu 24.04 or a current x86_64 Linux distribution
- 4 vCPUs and 8 GiB RAM minimum
- 100 GiB recommended persistent disk
- Docker Engine and Compose v2
- Git, Node.js 22, and Bun 1.3.14
- outbound HTTPS to GHCR, the configured AI provider, and package registries
- a main hostname, Pomerium authenticate hostname, and wildcard app hostname
- an OIDC identity provider for bundled Pomerium, or an existing Cloudflare
  Access/Pomerium deployment

Keep the application and local-artifacts ports on loopback. The bundled
Pomerium overlay is the default identity-aware proxy. It can terminate TLS
directly for a manual Compose deployment or listen only on loopback behind the
AWS Caddy configuration.

## Manual release install

Check out the same release tag or commit as the images:

```bash
git clone https://github.com/qaml-ai/camelAI.git
cd camelAI
git checkout --detach selfhost-vX.Y.Z
bun install --frozen-lockfile
bun run selfhost:init
```

Set release mode, the six version-matched image references, hostnames, and an AI
provider in `.env.selfhost`:

```dotenv
SELFHOST_DEPLOYMENT_MODE=release
SELFHOST_APP_IMAGE=ghcr.io/qaml-ai/camelai-selfhost-app:selfhost-vX.Y.Z
SELFHOST_LOCAL_ARTIFACTS_IMAGE=ghcr.io/qaml-ai/camelai-selfhost-local-artifacts:selfhost-vX.Y.Z
SELFHOST_PROJECT_BUILD_IMAGE=ghcr.io/qaml-ai/camelai-selfhost-project-build:selfhost-vX.Y.Z
SELFHOST_ANALYSIS_IMAGE=ghcr.io/qaml-ai/camelai-selfhost-analysis:selfhost-vX.Y.Z
SELFHOST_DB_QUERY_IMAGE=ghcr.io/qaml-ai/camelai-selfhost-db-query:selfhost-vX.Y.Z
SELFHOST_CONTAINER_EGRESS_IMAGE=ghcr.io/qaml-ai/camelai-selfhost-container-egress:selfhost-vX.Y.Z

SELFHOST_PUBLIC_BASE_URL=https://camel.example.com
SELFHOST_MAIN_HOSTNAME=camel.example.com
LOCAL_APP_VANITY_DOMAIN=apps.example.com
LOCAL_APP_IFRAME_DOMAIN=apps.example.com

SELFHOST_AUTH_MODE=bundled-pomerium
SELFHOST_POMERIUM_TLS_MODE=direct
SELFHOST_POMERIUM_LOOPBACK_HTTPS=1
POMERIUM_AUTHENTICATE_URL=https://authenticate.example.com
POMERIUM_AUTHENTICATE_HOSTNAME=authenticate.example.com
POMERIUM_ISSUER=camel.example.com
POMERIUM_AUDIENCE=camel.example.com
POMERIUM_DEFAULT_ORG_NAME=Example Corp
POMERIUM_IDP_PROVIDER=oidc
POMERIUM_IDP_PROVIDER_URL=https://idp.example.com/application/o/camelai/
POMERIUM_IDP_CLIENT_ID=camelai
POMERIUM_IDP_CLIENT_SECRET=...

SELFHOST_AI_PROVIDER=bedrock
SELFHOST_AI_API_KEY=bedrock-api-key-...
SELFHOST_AI_AWS_REGION=us-east-1
```

Register this callback URL with the OIDC provider:

```text
https://authenticate.example.com/oauth2/callback
```

Install an unencrypted PEM key and matching certificate chain:

```bash
install -d -m 0700 .selfhost/pomerium
install -m 0600 /secure/path/tls.crt .selfhost/pomerium/tls.crt
install -m 0600 /secure/path/tls.key .selfhost/pomerium/tls.key
bun run selfhost:configure
```

The certificate must cover `camel.example.com`,
`authenticate.example.com`, `*.apps.example.com`, and the separate iframe
wildcard when configured.

If the GHCR packages are private, authenticate Docker before starting:

```bash
printf '%s' "$GHCR_TOKEN" |
  docker login ghcr.io --username YOUR_GITHUB_USER --password-stdin
```

Route the main hostname and wildcard app domain to the reverse proxy:

```text
camel.example.com    A/AAAA  <VM address>
authenticate.example.com A/AAAA  <VM address>
*.apps.example.com   A/AAAA  <VM address>
```

Validate and start:

```bash
bun run selfhost:doctor
bun run selfhost:up
```

The lifecycle scripts select the Pomerium and source-build overlays from
`.env.selfhost`. For an operator-managed background service, use all selected
files explicitly:

```bash
docker compose \
  --env-file .env.selfhost \
  -f docker-compose.selfhost.yml \
  -f docker-compose.selfhost.pomerium.yml \
  -f docker-compose.selfhost.pomerium-loopback.yml \
  pull
docker compose \
  --env-file .env.selfhost \
  -f docker-compose.selfhost.yml \
  -f docker-compose.selfhost.pomerium.yml \
  -f docker-compose.selfhost.pomerium-loopback.yml \
  up --detach --wait
```

The defaults bind the app at `127.0.0.1:3001` and local Artifacts at
`127.0.0.1:7001`. Do not expose the Docker socket or either port directly.

## AWS single-node deployment

`infra/selfhost/terraform` and
`infra/selfhost/cloudformation/aws-single-node.yaml` implement the same release
contract. Both provision:

- an Ubuntu 24.04 EC2 instance with IMDSv2 required;
- an encrypted gp3 data volume for the checkout, Docker data root, and backups;
- a security group exposing only Caddy plus optional break-glass SSH;
- SSM Session Manager access;
- least-privilege reads for the configured Secrets Manager entries;
- an Elastic IP and optional Route53 main/authenticate/wildcard records;
- Caddy with either operator-provided PEM material or an external TLS origin;
- bundled Pomerium on a loopback-only listener, or an operator-managed
  Cloudflare Access/Pomerium proxy;
- a systemd unit that pulls the images and starts canonical Compose plus the
  selected authentication overlay; and
- upgrade and rollback commands.

The instance type defaults to `t3a.xlarge`. The selected subnet and
CloudFormation `AvailabilityZone` must match. Prefer SSM and leave SSH disabled.

### Secrets

Store each value as the raw `SecretString`, not a JSON object:

- AI provider API key;
- bundled Pomerium OIDC client secret;
- PEM certificate chain; and
- matching unencrypted PEM private key.

For bundled Pomerium the certificate must cover the main hostname,
authenticate hostname, and every configured wildcard app domain. The bootstrap
writes `.env.selfhost`, Pomerium secret files, and TLS files with restrictive
permissions. Secret values are read from Secrets Manager rather than placed in
CloudFormation parameters or Terraform state.

For `TlsMode=external`, port 80 is an origin port. Restrict
`WebIngressCidr`/`web_ingress_cidrs` to the upstream proxy; never expose that
mode directly to the internet.

### Terraform

```bash
cd infra/selfhost/terraform
cp terraform.tfvars.example terraform.tfvars
# Edit region, subnet/domain settings, secret ARNs, release ref, and six images.
terraform init
terraform plan
terraform apply
```

`vpc_id` and `subnet_id` may be omitted to select the default VPC. Use outputs
to start an SSM session and inspect bootstrap:

```bash
aws ssm start-session --target <instance-id>
sudo journalctl -u camelai-selfhost -u caddy --no-pager
sudo cloud-init status --wait
```

### CloudFormation

Create the stack in a VPC/subnet that has outbound internet access:

```bash
aws cloudformation deploy \
  --stack-name camelai-selfhost \
  --template-file infra/selfhost/cloudformation/aws-single-node.yaml \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    VpcId=vpc-... \
    SubnetId=subnet-... \
    AvailabilityZone=us-east-1a \
    RepositoryRef=selfhost-vX.Y.Z \
    AppImage=ghcr.io/qaml-ai/camelai-selfhost-app:selfhost-vX.Y.Z \
    LocalArtifactsImage=ghcr.io/qaml-ai/camelai-selfhost-local-artifacts:selfhost-vX.Y.Z \
    ProjectBuildImage=ghcr.io/qaml-ai/camelai-selfhost-project-build:selfhost-vX.Y.Z \
    AnalysisImage=ghcr.io/qaml-ai/camelai-selfhost-analysis:selfhost-vX.Y.Z \
    DbQueryImage=ghcr.io/qaml-ai/camelai-selfhost-db-query:selfhost-vX.Y.Z \
    ContainerEgressImage=ghcr.io/qaml-ai/camelai-selfhost-container-egress:selfhost-vX.Y.Z \
    MainHostname=camel.example.com \
    AppVanityDomain=apps.example.com \
    AuthProvider=bundled-pomerium \
    AuthDefaultOrgName='Example Corp' \
    PomeriumAuthenticateUrl=https://authenticate.example.com \
    PomeriumAuthenticateHostname=authenticate.example.com \
    PomeriumIdpProvider=oidc \
    PomeriumIdpProviderUrl=https://idp.example.com/application/o/camelai/ \
    PomeriumIdpClientId=camelai \
    PomeriumIdpClientSecretArn=arn:aws:secretsmanager:... \
    SelfhostAiApiKeySecretArn=arn:aws:secretsmanager:... \
    TlsCertificateSecretArn=arn:aws:secretsmanager:... \
    TlsPrivateKeySecretArn=arn:aws:secretsmanager:...
```

CloudFormation waits up to 30 minutes for the health check before completing.
Both AWS bootstraps also run the project, analysis, and db-query deep smokes
after Compose becomes healthy. Infrastructure completion therefore means all
three attached execution paths worked through the configured production egress
image, not only that the HTTP service started. CloudFormation gates completion
with its wait condition; Terraform waits for the same boot marker through an
SSM association and fails the apply if bootstrap or a smoke fails.
The data volume has a snapshot deletion policy. Confirm the snapshot and retain
the AI/TLS secrets before deleting a production stack.

## Bedrock and other providers

The Bedrock path uses a long-term Bedrock API key with the Bedrock Mantle
compatibility endpoint:

```dotenv
SELFHOST_AI_PROVIDER=bedrock
SELFHOST_AI_API_KEY=bedrock-api-key-...
SELFHOST_AI_AWS_REGION=us-east-1
```

EC2 instance-profile/IMDS SigV4 model authentication is not implemented by this
release. The instance role is for SSM and bootstrap secret reads only. Bedrock
model access and regional availability still apply.

The standalone default is the supported Bedrock model configured by the model
catalog. camelCode is a camelAI-hosted route and is not offered by this
standalone provider path.

Anthropic, OpenAI, and OpenRouter use the same key fields:

```dotenv
SELFHOST_AI_PROVIDER=openrouter
SELFHOST_AI_API_KEY=...
```

A custom compatible endpoint additionally uses:

```dotenv
SELFHOST_AI_PROVIDER=custom
SELFHOST_AI_BASE_URL=https://provider.example.com/v1
SELFHOST_AI_MODEL=provider-model-id
SELFHOST_AI_NAME=Provider name
SELFHOST_AI_API=openai-completions
SELFHOST_AI_AUTH_TYPE=bearer
```

## Authentication

Outbound email is not included, so a shared install should provision users from
Cloudflare Access or Pomerium assertions.

### Bundled Pomerium (recommended)

`SELFHOST_AUTH_MODE=bundled-pomerium` adds the Pomerium overlay. When
`SELFHOST_POMERIUM_LOOPBACK_HTTPS=1`, it also adds
`docker-compose.selfhost.pomerium-loopback.yml` so the app retrieves signing
keys through the VM's local HTTPS endpoint. Pomerium runs in all-in-one mode
with a persistent file-backed databroker. The control-plane hostname requires
an authenticated user and forwards a signed `X-Pomerium-Jwt-Assertion`;
deployed app wildcard hostnames remain public and route separately.

Pomerium is pinned by immutable digest. Its client, cookie, and shared secrets
are passed through mounted files rather than container environment values.
The container drops all Linux capabilities except `NET_BIND_SERVICE` and
`DAC_OVERRIDE`; the latter is required for Pomerium to read the operator-owned
`0600` bind mounts on Linux without making those files group- or world-readable.
Backups include the `pomerium-data` volume, but `.env.selfhost` remains a
separate operator-owned secret and must also be protected.

For manual direct TLS use `SELFHOST_POMERIUM_TLS_MODE=direct`. AWS templates use
`upstream`, where Caddy terminates TLS and Pomerium binds only to
`127.0.0.1:5444`. Never expose that plaintext loopback listener.
The AWS templates set `SELFHOST_POMERIUM_LOOPBACK_HTTPS=1` with
operator-provided VM TLS and `0` when an external load balancer terminates TLS.
External TLS must allow the VM to reach its public camelAI HTTPS hostname
through that load balancer; the app uses that path to retrieve Pomerium's JWKS.

Cloudflare Access minimum:

```dotenv
SELFHOST_AUTH_MODE=cloudflare-access
CLOUDFLARE_ACCESS_TEAM_DOMAIN=https://your-team.cloudflareaccess.com
CLOUDFLARE_ACCESS_AUD=your-access-application-aud
CLOUDFLARE_ACCESS_DEFAULT_ORG_NAME=Your Organization
```

External Pomerium minimum:

```dotenv
SELFHOST_AUTH_MODE=external-pomerium
POMERIUM_AUTHENTICATE_URL=https://authenticate.example.com
POMERIUM_ISSUER=camel.example.com
POMERIUM_AUDIENCE=camel.example.com
POMERIUM_DEFAULT_ORG_NAME=Your Organization
```

`LOCAL_AUTH_BYPASS=1` is only for a loopback smoke test. The application limits
it to localhost by default; never widen its host allowlist on a shared VM.

## Operations

Health and logs:

```bash
curl --fail http://127.0.0.1:3001/api/selfhost/health
docker compose --env-file .env.selfhost -f docker-compose.selfhost.yml ps
docker compose --env-file .env.selfhost \
  -f docker-compose.selfhost.yml \
  -f docker-compose.selfhost.pomerium.yml \
  -f docker-compose.selfhost.pomerium-loopback.yml \
  logs --tail=200 app pomerium
```

The health endpoint and Compose health checks verify configured dependencies,
service startup, and the selected AI provider. They do not execute an attached
build, notebook, or database-query container. Run all three operational smokes
after manual installs and during infrastructure validation:

Compute entries in the health capability contract use `state: "configured"`
and `verification.status: "not_checked"` until an operator runs the indicated
deep smoke. A missing compute namespace remains a readiness failure and returns
HTTP 503.

```bash
bun --env-file=.env.selfhost run selfhost:container:smoke:project
bun --env-file=.env.selfhost run selfhost:container:smoke:analysis
bun --env-file=.env.selfhost run selfhost:container:smoke:db-query
```

Each command creates a real attached container through local `workerd`, checks
its runtime-specific behavior, and destroys the smoke container afterward.

Back up durable volumes:

```bash
bun run selfhost:backup
```

`.env.selfhost` contains secrets and is intentionally excluded. Protect a
separate copy. Restore only into a stopped stack:

```bash
bun run selfhost:restore -- .selfhost/backups/<timestamp>
```

For a manual release upgrade, download `selfhost-release.json` from the release
workflow artifact, keep it outside the repository checkout, and run:

```bash
bun run selfhost:upgrade -- \
  --release selfhost-vX.Y.Z \
  --manifest /secure/path/selfhost-release.json
```

The same artifact includes a standalone `selfhost-upgrade-bootstrap.mjs`. Use it
once for every installation whose checked-out upgrader predates the target-code
handoff. This includes older upgraders that already recognize `--release` but
continue running their own loaded code after checking out the target:

```bash
node /secure/path/selfhost-upgrade-bootstrap.mjs \
  --repo "$PWD" \
  --release selfhost-vX.Y.Z \
  --manifest /secure/path/selfhost-release.json
```

The bootstrap validates the target ref against the manifest, backs up the old
installation, snapshots its checkout and environment, then hands the apply
phase to the target release's upgrader. Subsequent upgrades do this handoff
automatically.

The helper requires a clean tracked worktree. It verifies that the selected Git
ref matches the manifest revision and that all six camelAI images plus Pomerium
are digest-pinned, backs up the durable volumes, and saves the previous checkout
plus `.env.selfhost` under `.selfhost/releases/`. It then checks out the
release, updates all seven dependency references, pulls them, waits for Compose
health, and runs the doctor plus all three attached-runtime smokes. A failure
before the new runtime starts automatically restores the saved checkout and
image configuration. After startup begins, migrations may have run, so the
helper leaves the new runtime configuration in place and tells the operator to
restore the matching volume backup before rolling code back. A successful
command prints the exact explicit rollback command, which has this form:

```bash
bun run selfhost:upgrade -- --rollback .selfhost/releases/<timestamp>
```

Running `bun run selfhost:upgrade` without `--release` and `--manifest` only
backs up and refreshes the current checkout and currently configured image
references; it does not select a new release.

AWS-provisioned hosts also install:

```bash
sudo camelai-selfhost-upgrade \
  --release selfhost-vX.Y.Z \
  --manifest /secure/path/selfhost-release.json

# Use the exact rollback command printed by the successful upgrade:
sudo camelai-selfhost-upgrade \
  --rollback .selfhost/releases/<timestamp>
```

The AWS wrapper invokes the same verified repository helper; it does not offer
a mutable-tag shorthand. Runtime rollback does not reverse D1 migrations;
restore the matching pre-upgrade volume backup when schema rollback is
required.

## Source-build developer mode

The supported production Compose file never builds on the VM. For local
development only, `SELFHOST_DEPLOYMENT_MODE=source` selects
`docker-compose.selfhost.source.yml` and builds the six images from the current
checkout. This path is useful for testing changes, not for an immutable
enterprise release.

## Validation

Before publishing a release or changing this target:

```bash
bun run test:selfhost:release
bun run test:selfhost:workerd-config
bun run test:selfhost:wfp-facets
bun run test:selfhost:worker-bundle
bun --env-file=.env.selfhost run selfhost:container:smoke:project
bun --env-file=.env.selfhost run selfhost:container:smoke:analysis
bun --env-file=.env.selfhost run selfhost:container:smoke:db-query
bun run selfhost:artifacts:smoke
terraform -chdir=infra/selfhost/terraform validate
aws cloudformation validate-template \
  --template-body file://infra/selfhost/cloudformation/aws-single-node.yaml
```
