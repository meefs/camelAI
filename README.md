# camelAI

camelAI is an AI coding assistant platform built on Cloudflare Workers + Durable Objects with Docker + gVisor sandbox runtimes on Azure VMs.

## Prerequisites

- Node.js 22+
- Bun
- Cloudflare account

## Local Development

```bash
bun run dev
```

This runs React Router dev with Cloudflare bindings.
Default app URL: `http://localhost:3001` (override with `VITE_DEV_PORT`).

For local testing without OAuth, run:

```bash
bun run dev:local-auth
```

This sets `LOCAL_AUTH_BYPASS=1`, which only works on the Vite dev server and seeds a default `Local Dev` user, organization, and workspace.

## Build

```bash
bun run build
```

## Test

```bash
bun run test
bun run test:run
bun run test:workers
bun run test:e2e
```

## Deploy

Production deploys go through the `production` branch (Cloudflare Git
integration). To deploy the main worker manually, build then run wrangler
against the environment config:

```bash
bun run build
wrangler deploy -c wrangler.prod.jsonc
wrangler deploy -c wrangler.staging.jsonc
wrangler deploy -c wrangler.dev-miguel.jsonc
wrangler deploy -c wrangler.dev-illiana.jsonc
```

Dispatcher deploys:

```bash
bun run deploy:dispatcher:prod
bun run deploy:dispatcher:staging
```

See `AGENTS.md` for full architecture documentation.

## Self-Hosting

See [docs/self-hosting.md](docs/self-hosting.md) for the Docker Compose stack:

```bash
bun run selfhost:init
bun run selfhost:doctor
bun run selfhost:up
```
