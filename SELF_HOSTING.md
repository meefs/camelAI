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
```

Pin all six references from the same release. The container-egress wrapper is
required for the known Docker 29 bridge-interception bug and is covered by the
attached-container functional smoke.

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
bun run selfhost:doctor
bun run selfhost:up
```

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

Use Cloudflare Access or Pomerium as the enterprise identity provider.
Password signup is rejected before creating a user because its verification
email cannot be delivered. Verification-email resend and the email-backed help
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

The helper verifies the manifest against the selected checkout, backs up durable
volumes, snapshots the previous checkout and `.env.selfhost`, and restores that
runtime configuration automatically if the update fails. Before declaring
success it waits for Compose health, runs the doctor, and executes the project,
analysis, and database-query deep smokes. It prints an explicit rollback
command after success. Runtime rollback cannot reverse D1 migrations; restore
the matching pre-upgrade volume backup when a schema rollback is required.

The detailed Compose variables, reverse-proxy examples, backups, and provider
configuration remain in [`infra/selfhost/README.md`](infra/selfhost/README.md).
