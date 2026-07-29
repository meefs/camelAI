# Self-hosting camelAI

The supported self-host target is a single Linux VM running Docker Compose. The
application runs under workerd, and workerd starts isolated Docker containers
for project builds, notebook analysis, and database queries.

## Release images and source builds

Production installations should use the release Compose file with immutable
image references. At minimum, `.env.selfhost` must set `SELFHOST_APP_IMAGE` to
the camelAI application image published for the selected release. The
local-artifacts, project-build, analysis, database-query, and container-egress
image variables must refer to the matching release as well. Prefer
digest-pinned values:

```dotenv
SELFHOST_APP_IMAGE=ghcr.io/your-org/camelai-selfhost-app@sha256:...
SELFHOST_LOCAL_ARTIFACTS_IMAGE=ghcr.io/your-org/camelai-selfhost-local-artifacts@sha256:...
SELFHOST_PROJECT_BUILD_IMAGE=ghcr.io/your-org/camelai-selfhost-project-build@sha256:...
SELFHOST_ANALYSIS_IMAGE=ghcr.io/your-org/camelai-selfhost-analysis@sha256:...
SELFHOST_DB_QUERY_IMAGE=ghcr.io/your-org/camelai-selfhost-db-query@sha256:...
SELFHOST_CONTAINER_EGRESS_IMAGE=ghcr.io/your-org/camelai-selfhost-container-egress@sha256:...
SELFHOST_POMERIUM_IMAGE=pomerium/pomerium@sha256:...
```

Pin all seven dependency references from the same release manifest. Six are
camelAI images; Pomerium is the tested upstream image. The container-egress
wrapper is required for the known Docker 29 bridge-interception bug and is
covered by the attached-container functional smoke.

Release mode does not build application code on the VM and does not mount a
mutable repository checkout into the application container. This is the
recommended enterprise deployment mode.

For development or release validation from a checkout, set:

```dotenv
SELFHOST_DEPLOYMENT_MODE=source
```

The self-host scripts then add `docker-compose.selfhost.source.yml`, which
builds the application and sandbox images from the current checkout. Source
mode is slower, consumes substantially more disk, CPU, and memory, and should
not be used as a production update strategy.

Initialize and validate the installation with:

```bash
bun run selfhost:init
# Edit .env.selfhost and install the TLS certificate/key described below.
bun run selfhost:configure
bun run selfhost:doctor
bun run selfhost:up
```

`SELFHOST_AUTH_MODE=bundled-pomerium` is the default production path.
`selfhost:up` automatically adds the Pomerium overlay and, when HTTPS
terminates on the VM, its loopback-JWKS overlay.
External Pomerium and Cloudflare Access remain supported for enterprises that
already operate an identity-aware proxy.

The application container has read-write access to the Docker socket so workerd
can manage sandbox containers. Anyone who can control that container should be
treated as having root-equivalent control of the VM.

On Linux the app service intentionally uses host networking. workerd's
`localDocker` engine assigns loopback addresses to the sandbox egress
sidecars, which are unreachable through a nested Compose bridge. The app still
listens on `SELFHOST_BIND_ADDRESS` (default `127.0.0.1`), so keep that loopback
default and put the deployment behind the documented reverse proxy.

## Capability contract

`GET /api/selfhost/health` is both the readiness endpoint and the
machine-readable self-host capability contract. The response contains a
versioned `capabilities` object:

```json
{
  "ok": true,
  "mode": "selfhost",
  "status": "ok",
  "checks": [],
  "capabilities": {
    "version": 2,
    "features": {
      "project_builds": {
        "state": "configured",
        "available": null,
        "configured": true,
        "implementation": "workerd-local-docker",
        "verification": {
          "status": "not_checked",
          "command": "bun run selfhost:container:smoke:project"
        }
      },
      "project_deploys": {
        "state": "configured",
        "available": null,
        "configured": true,
        "implementation": "workerd-local-docker",
        "verification": {
          "status": "not_checked",
          "command": "bun run selfhost:container:smoke:project"
        }
      },
      "notebooks": {
        "state": "configured",
        "available": null,
        "configured": true,
        "implementation": "workerd-local-docker",
        "verification": {
          "status": "not_checked",
          "command": "bun run selfhost:container:smoke:analysis"
        }
      },
      "sql": {
        "state": "configured",
        "available": null,
        "configured": true,
        "implementation": "workerd-local-docker",
        "verification": {
          "status": "not_checked",
          "command": "bun run selfhost:container:smoke:db-query"
        }
      },
      "outbound_email": {
        "state": "disabled",
        "available": false,
        "reason": "Outbound email is disabled in self-host mode. No SMTP transport is implemented."
      },
      "smtp": {
        "state": "disabled",
        "available": false,
        "reason": "SMTP is reserved as a future self-host transport and is not implemented."
      }
    }
  }
}
```

Intentionally disabled capabilities do not make the service unhealthy. Failed
runtime checks still return HTTP 503 and `status: "fail"`. In particular,
`PROJECT_BUILD_SANDBOX`, `ANALYSIS_SANDBOX`, and `DB_QUERY_SANDBOX` are required
bindings. If one is missing, its dependent features report
`state: "unavailable"` instead of claiming local-Docker parity.
For a present binding, `configured` means the namespace and image were wired;
it does not claim Docker execution was tested by the lightweight HTTP probe.
Run the named deep-smoke command in `verification.command` for that evidence.

## Authentication and email-dependent flows

Self-host mode has no outbound email transport. Setting
`EMAIL_FROM_ADDRESS` or `WORKSPACE_EMAIL_DOMAIN` does not enable delivery, and
there is no supported SMTP configuration today.

The recommended Compose deployment includes Pomerium Core in all-in-one mode:

```dotenv
SELFHOST_AUTH_MODE=bundled-pomerium
SELFHOST_MAIN_HOSTNAME=camel.example.com
SELFHOST_POMERIUM_TLS_MODE=direct
SELFHOST_POMERIUM_LOOPBACK_HTTPS=1
POMERIUM_AUTHENTICATE_URL=https://authenticate.example.com
POMERIUM_AUTHENTICATE_HOSTNAME=authenticate.example.com
POMERIUM_IDP_PROVIDER=oidc
POMERIUM_IDP_PROVIDER_URL=https://idp.example.com/application/o/camelai/
POMERIUM_IDP_CLIENT_ID=camelai
POMERIUM_IDP_CLIENT_SECRET=...
POMERIUM_DEFAULT_ORG_NAME=Your Organization
POMERIUM_ISSUER=camel.example.com
POMERIUM_AUDIENCE=camel.example.com
```

Register `https://authenticate.example.com/oauth2/callback` with the OIDC
provider. The authenticate hostname must be distinct from the camelAI hostname.
For direct Compose TLS, install a certificate chain and key at
`.selfhost/pomerium/tls.crt` and `.selfhost/pomerium/tls.key`; it must cover the
main hostname, authenticate hostname, and deployed-app wildcard domains.
`selfhost:configure` writes Pomerium's Docker-mounted secret files with
restrictive permissions so the client, cookie, and shared secrets are not
visible in `docker inspect`.

Set `SELFHOST_POMERIUM_LOOPBACK_HTTPS=0` only when an external load balancer
terminates TLS. In that mode, the VM must be able to reach its public camelAI
HTTPS hostname through the load balancer so the app can retrieve Pomerium's
JWKS.

Set `SELFHOST_AUTH_MODE=external-pomerium` or `cloudflare-access` to use an
existing enterprise proxy instead. Password signup is rejected before creating
a user because its verification email cannot be delivered.
Verification-email resend and the email-backed help
form return explicit unavailable errors. Organization invitations are still
created so an administrator can copy and deliver the invitation URL through an
approved channel; the API and UI report that the email itself was not sent.
The coding agent's `send_email` tool is omitted from discovery and rejected at
the server boundary.

Do not add a fake local SMTP service, silently discard messages, or accept
unencrypted SMTP credentials merely to make these flows appear successful.

### Future internal SMTP transport

A future implementation should add a real, operator-selected transport rather
than reusing the Cloudflare Email Sending binding. A proposed configuration
surface is:

```dotenv
SELFHOST_EMAIL_TRANSPORT=smtp
SELFHOST_SMTP_HOST=smtp.corp.example
SELFHOST_SMTP_PORT=465
SELFHOST_SMTP_TLS=implicit
SELFHOST_SMTP_USERNAME=...
SELFHOST_SMTP_PASSWORD=...
SELFHOST_SMTP_FROM=camelai@corp.example
```

These variables are design placeholders and have no effect today. Before they
become supported, the implementation must provide required TLS with certificate
verification, secret handling that avoids logs and generated config files,
connection and delivery timeouts, recipient/header validation, bounded
attachments, auditable delivery results, and tests for verification,
invitation, support, and agent-originated messages. The health contract should
only mark `smtp` and `outbound_email` available after a live transport check
succeeds.

## Operational validation

After startup, verify:

```bash
curl --fail --silent http://127.0.0.1:3001/api/selfhost/health
bun run selfhost:doctor
```

For a release upgrade, use the digest manifest produced by the self-host release
workflow:

```bash
bun run selfhost:upgrade -- \
  --release selfhost-vX.Y.Z \
  --manifest /secure/path/selfhost-release.json
```

For every installation whose current upgrader predates the target-code handoff,
use the `selfhost-upgrade-bootstrap.mjs` shipped beside the manifest once. This
includes older upgraders that already recognize `--release` but do not
re-execute the target release:

```bash
node /secure/path/selfhost-upgrade-bootstrap.mjs \
  --repo "$PWD" \
  --release selfhost-vX.Y.Z \
  --manifest /secure/path/selfhost-release.json
```

The helper verifies the manifest against the selected checkout, backs up durable
volumes, and snapshots the previous checkout and `.env.selfhost`. Failures
before the new runtime starts restore that runtime configuration automatically.
Once startup begins, D1 migrations may have run, so failures leave the new
checkout and image configuration in place. Restore the matching pre-upgrade
volume backup before using the printed explicit rollback command. Before
declaring success the helper waits for Compose health, runs the doctor, and
executes the project, analysis, and database-query deep smokes.
Normal upgrades re-exec the target checkout's upgrader before applying images,
so the target release owns its manifest and migration rules.

The detailed Compose variables, reverse-proxy examples, backups, and provider
configuration remain in [`infra/selfhost/README.md`](infra/selfhost/README.md).
