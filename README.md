# Chiridion App

Chiridion is an AI coding assistant platform built on Cloudflare Workers + Durable Objects with per-workspace Fly Sprites runtimes.

## Prerequisites

- Node.js 22+
- Bun
- Cloudflare account
- Fly Sprites token (`SPRITES_TOKEN`)

## Local Development

```bash
bun run dev
```

This runs React Router dev with Cloudflare bindings.
Default app URL: `http://localhost:3001` (override with `VITE_DEV_PORT`).

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

```bash
bun run deploy:main:prod
bun run deploy:main:staging
bun run deploy:main:dev-miguel
bun run deploy:main:dev-illiana
```

Dispatcher deploys:

```bash
bun run deploy:dispatcher:prod
bun run deploy:dispatcher:staging
```

## Sprites Runtime Notes

- The workspace runtime is implemented in `workers/main/src/workspace-container.ts`.
- The runner source at `sandbox/claude-runner.mjs` is embedded into the worker via:

```bash
bun run gen:embedded-runner
```

This generation step is already included in `dev`, `build`, `typecheck`, and worker test scripts.

## Core Environment Variables

Set in `.dev.vars` (and secrets/vars for deployed environments):

- `SPRITES_TOKEN`
- `SPRITES_API_BASE_URL` (optional)
- `SPRITES_NAME_PREFIX` (optional)
- `WORKER_BASE_URL` (must be publicly reachable from sprites)
- `OPENROUTER_API_KEY`
- `OPENROUTER_PROVISIONING_KEY`
- `TOKEN_SIGNING_SECRET`
- `INTEGRATION_SECRET_KEY`
