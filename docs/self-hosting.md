# Self-Hosting

The self-host target is a single-machine Docker Compose stack for local or private
network use. It runs the Worker directly with `workerd`, the project runtime service,
and a local git-backed replacement for Cloudflare Artifacts project repositories.

Project git storage is local. Published user apps use the self-host dynamic dispatch
path backed by local `workerd`.

## Prerequisites

- Docker with Compose v2
- Bun, for running the helper script
- The project runtime service checkout, defaulting to `~/qaml-ai/project-runtime-service`

## Start

```bash
bun run selfhost:init
bun run selfhost:doctor
bun run selfhost:up
```

`selfhost:init` writes `.env.selfhost` with generated local secrets and operator
settings. Keep that file private. Before running `selfhost:doctor`, set
`SELFHOST_PUBLIC_BASE_URL`, `LOCAL_APP_VANITY_DOMAIN`, and
`LOCAL_APP_IFRAME_DOMAIN` for your DNS or tunnel. `selfhost:doctor` verifies
Docker, required CLIs, the runtime checkout, Compose config, expected volume
names, and any live service health endpoints that are already running.

`selfhost:up` builds the project runtime container image from
`~/qaml-ai/project-runtime-service/Dockerfile.sandbox`, then starts:

- `app` on `http://127.0.0.1:3001`, served by direct `workerd`
- `project-runtime` control API on `http://127.0.0.1:4410`
- `project-runtime` docker-facing proxy on `http://127.0.0.1:4411`
- `local-artifacts` on `http://127.0.0.1:7001`

Compose binds published ports to `127.0.0.1` by default so Cloudflare Tunnel or
another local reverse proxy is the only public ingress. Set
`SELFHOST_BIND_ADDRESS=0.0.0.0` only for an explicitly firewalled private network.

Local auth is enabled for `localhost`, so the first app request creates a `Local Dev`
user, organization, and workspace.

For a real self-host deployment, put a reverse proxy or Cloudflare Tunnel in front
of the `app` service and configure both the main app URL and wildcard user-app
domain:

```bash
SELFHOST_PUBLIC_BASE_URL=https://camel.example.com
LOCAL_APP_VANITY_DOMAIN=apps.example.com
LOCAL_APP_IFRAME_DOMAIN=apps.example.com
```

Route `camel.example.com` and `*.apps.example.com` to the same self-host app
service. `WORKER_BASE_URL` is derived from `SELFHOST_PUBLIC_BASE_URL` in Compose,
and published app links are generated from `LOCAL_APP_VANITY_DOMAIN` /
`LOCAL_APP_IFRAME_DOMAIN`.

To put Cloudflare Access in front of a local Cloudflare Tunnel and automatically
log users in, configure an Access application for the app hostname and set:

```bash
LOCAL_AUTH_BYPASS=0
CLOUDFLARE_ACCESS_TEAM_DOMAIN=https://your-team.cloudflareaccess.com
CLOUDFLARE_ACCESS_AUD=your-access-application-aud
CLOUDFLARE_ACCESS_DEFAULT_ORG_NAME="Your Organization"
```

See [Cloudflare Access Auth](./cloudflare-access-auth.md) for group/claim-based
organization mapping and optional email-domain restrictions.

If port `3001` is already in use:

```bash
SELFHOST_APP_PORT=3002
SELFHOST_PUBLIC_BASE_URL=http://localhost:3002
```

If your runtime checkout lives elsewhere:

```bash
PROJECT_RUNTIME_SERVICE_DIR=/path/to/project-runtime-service
```

If you need to test a different runtime image Dockerfile:

```bash
PROJECT_RUNTIME_IMAGE_DOCKERFILE=Dockerfile.sandbox
```

The default sandbox image runs project commands as `claude`:

```bash
PROJECT_RUNTIME_CONTAINER_USER=claude
PROJECT_RUNTIME_CONTAINER_HOME=/workspace
PROJECT_RUNTIME_CONTAINER_WORKDIR=/workspace
PROJECT_RUNTIME_CONTAINER_NETWORK_MODE=camelai-selfhost_default
PROJECT_RUNTIME_DOCKER_PROXY_BASE_URL=http://project-runtime:4411
```

If you want runtime workspaces somewhere other than the checkout-local default:

```bash
PROJECT_RUNTIME_HOST_STATE_DIR=/Users/you/camelai-project-runtime
```

On macOS, keep this under a Docker Desktop file-shared path such as `/Users/...`.
The project runtime passes workspace paths to the host Docker daemon when it starts
project containers, so named Docker volumes and container-only paths such as
`/srv/project-runtime` cannot be used for local self-host project workspaces.

Put overrides in `.env.selfhost`, then rerun `bun run selfhost:doctor`.

Local Compose disables project filesystem quotas by default:

```bash
PROJECT_RUNTIME_ENABLE_PROJECT_QUOTA=0
```

That avoids requiring `xfs_quota` inside the development container. Production
Linux hosts can enable quotas by setting `PROJECT_RUNTIME_ENABLE_PROJECT_QUOTA=1`
after preparing an XFS `prjquota` mount with the project runtime host setup
script.

## AI Provider

Self-host chat can be configured entirely through environment variables. When
`SELFHOST_AI_PROVIDER` is set, the organization AI Provider settings page becomes
read-only and org-level saved keys are ignored by the chat runtime.

```bash
SELFHOST_AI_PROVIDER=openrouter
SELFHOST_AI_API_KEY=sk-or-...
```

Supported provider values are `openrouter`, `anthropic`, `openai`, `bedrock`, and
`custom`. For Bedrock, set `SELFHOST_AI_AWS_REGION` if you do not want the default
`us-east-1`.

Custom OpenAI/Anthropic-compatible endpoints require:

```bash
SELFHOST_AI_PROVIDER=custom
SELFHOST_AI_API_KEY=...
SELFHOST_AI_BASE_URL=https://provider.example.com/v1
SELFHOST_AI_MODEL=provider-model-id
SELFHOST_AI_NAME="Provider name"
SELFHOST_AI_API=openai-completions # openai-completions, openai-responses, or anthropic-messages
SELFHOST_AI_AUTH_TYPE=bearer       # bearer or x-api-key
```

`bun run selfhost:doctor` and `/api/selfhost/health` report a warning until a
self-host provider or hosted Cloudflare AI Gateway is configured.

## Manual workerd Runner

For local debugging outside Docker, build and serve the generated `workerd` config:

```bash
bun run selfhost:workerd:build
SELFHOST_WORKERD_SOCKET=127.0.0.1:3001 bun run selfhost:workerd:serve
```

This runs `node_modules/workerd/bin/workerd serve` directly against the generated
Cap'n Proto config at `.selfhost/workerd/camelai.capnp`. `selfhost:workerd:serve`
applies local D1 migrations before starting the app unless
`SELFHOST_SKIP_D1_MIGRATIONS=1` is set.

The generator reads `build/server/wrangler.json`, embeds the built Worker modules,
and wires local services for:

- SQLite-backed Durable Objects using `workerd` local disk storage
- KV, R2, D1, and Queues using Miniflare's shipped binding workers inside direct
  `workerd` services
- Workflows using Miniflare's local workflow engine Worker with SQLite-backed
  `Engine` Durable Objects
- static assets through a disk-backed `ASSETS` service
- the local git Artifacts replacement as an `ARTIFACTS` wrapped binding
- the project runtime through normal outbound fetches

Published user app bundles are served through the self-host dynamic dispatcher.
The dynamic app path currently supports plain/json/secret env bindings,
same-script Durable Objects, virtual KV namespaces, virtual R2 buckets, static
assets, AI, `DATA_PROXY`, `CONNECTIONS`, and `CAMELAI`. D1, Queue, and arbitrary
service bindings are still blocked for user app deploys unless they are translated
into platform-owned virtual bindings.

Unsupported:

- Cloudflare Email Sending is omitted; outbound email routes return the existing
  "binding not configured" error.
- Local publishing/dispatch for user apps uses `workerd --experimental` Worker Loader
  plus Durable Object Facets. Cloudflare user app publishing is not a supported
  self-host mode.
- TLS, public DNS, and reverse proxy configuration are operator-managed. Use a standard
  reverse proxy such as Caddy or Traefik in front of `app:3001` for HTTPS deployments.

Useful checks:

```bash
bun run selfhost:doctor
bun run test:selfhost:workerd-config
bun run test:selfhost:wfp-facets
bun run test:selfhost:worker-bundle
bun run selfhost:d1:migrate
bun run selfhost:artifacts:smoke
```

`test:selfhost:workerd-config` verifies the generated direct-`workerd` config shape,
`test:selfhost:wfp-facets` verifies a Worker Loader based dispatch path where a
normal dynamic Worker calls `env.COUNTER.idFromName()` and `env.COUNTER.get()`,
then reaches a Durable Object Facet with isolated SQLite-backed storage that
persists across `workerd` restart,
`test:selfhost:worker-bundle` builds a real module Worker bundle, seeds it into the
self-host worker registry, serves it through the dispatcher `SelfhostAppRunner`,
and verifies env bindings, virtual KV, virtual R2, assets, and Durable Object state
across `workerd` restart,
`selfhost:d1:migrate` applies `migrations/*.sql` idempotently, and
`selfhost:artifacts:smoke` verifies the local `ARTIFACTS` binding with a real git
clone, commit, push, and read.

## Local Workers For Platforms Emulation

The closest local match for Cloudflare Workers for Platforms is a platform-owned
dispatcher Worker with a `workerLoader` binding and an `AppRunner` Durable Object.
On request, the dispatcher resolves the app id, loads the app bundle by version key,
and calls the dynamic Worker's default entrypoint.

Durable Objects are handled through Durable Object Facets. The dynamic app bundle is
wrapped with a small module that injects namespace-shaped bindings such as
`env.COUNTER`. Calls to `env.COUNTER.idFromName()` and `env.COUNTER.get(id).fetch()`
are forwarded to the platform `AppRunner`, which creates or resumes a facet via
`this.ctx.facets.get()`. The facet runs the dynamic Worker's exported Durable Object
class and gets its own SQLite database, isolated from the platform supervisor.

This solves the important storage problem without statically configuring every user
app as its own `workerd` service. Remaining compatibility work:

- support D1, Queue, and arbitrary service bindings through explicit local bindings
  or platform-owned wrapped bindings
- add per-app limits, logs, and publish rollback/version activation
- decide whether `workerd --experimental` is acceptable for self-host releases while
  Worker Loader and Durable Object Facets remain experimental

## Secrets

The supported path uses `.env.selfhost`, generated by:

```bash
bun run selfhost:init
```

The required generated secrets are `TOKEN_SIGNING_SECRET`,
`INTEGRATION_SECRET_KEY`, `PROJECT_RUNTIME_PROXY_SECRET`, and
`LOCAL_ARTIFACTS_SECRET`. Regenerate with `bun run selfhost:init -- --force` only
when you are intentionally rotating local credentials; existing sessions and runtime
proxy credentials may stop working.

## Storage

Compose uses named volumes and one host directory:

- `app-state` for local Worker/Durable Object/KV/D1 state
- `local-artifacts-repos` for bare git repositories
- `bun-cache` for dependencies
- `PROJECT_RUNTIME_HOST_STATE_DIR`, defaulting to `.selfhost/project-runtime`, for
  runtime workspaces, usage, state, and backups

The default Compose project name is `camelai-selfhost`, so Docker volume names are:

- `camelai-selfhost_app-state`
- `camelai-selfhost_local-artifacts-repos`
- `camelai-selfhost_bun-cache`

Run `bun run selfhost:doctor` to print the volume names and project runtime state
directory for the current configuration.

## Backup And Restore

Back up the durable volumes and runtime state directory:

```bash
bun run selfhost:backup
```

By default, backups are written under `.selfhost/backups/<timestamp>`. The backup
includes app state, project runtime state, and local Artifacts repositories. It does
not include `.env.selfhost` because that file contains secrets; store it separately
with the same care as production credentials.

Restore into the configured Compose project volumes:

```bash
bun run selfhost:restore -- .selfhost/backups/<timestamp>
```

Stop the stack before restoring. Restoring clears the target volumes before extracting
the backup archives.

## Upgrade

The conservative upgrade flow is:

```bash
bun run selfhost:upgrade
```

This creates a backup, pulls/builds Compose images, applies local D1 migrations,
starts the stack in detached mode, and runs `selfhost:doctor`. Use
`bun run selfhost:upgrade -- --skip-backup` only when you have already made a
separate backup.

## Health

Self-host mode exposes:

```text
/api/selfhost/health
```

The endpoint checks local Worker bindings, D1 queryability, the project runtime
health endpoint, local Artifacts health, and the configured email/publishing support
state. It returns `404` outside self-host mode.

## Local Git Artifacts

The generated `workerd` config exposes an `ARTIFACTS` wrapped binding backed by the
local git service. The Worker code uses the same Cloudflare Artifacts-shaped API in
self-host and deployed environments. `LOCAL_ARTIFACTS_BASE_URL` and
`LOCAL_ARTIFACTS_SECRET` configure the local binding.

Project containers still use the existing runtime proxy remote:

```text
http://host.docker.internal:4411/p/camelai-artifacts/git/origin.git
```

That keeps long-lived git credentials out of project containers. The runtime injects the
project identity, the app mints a short-lived token, and the local git service validates it.

## Production Notes

- Put the app behind HTTPS before exposing it beyond localhost/private networks.
- Rotate the generated secrets before using a shared machine.
- Keep `.env.selfhost` and backup archives private.
