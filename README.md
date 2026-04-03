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

## Desktop Prototype

There is now a separate local-first desktop scaffold under [`desktop/`](./desktop).

```bash
bun run desktop:dev
bun run desktop:check
bun run desktop:vm-helper:build
```

The current desktop path is macOS-focused, uses Electron + a local Bun backend, reads `ANTHROPIC_API_KEY` from the environment, and does not depend on Cloudflare login or app deployment.

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

See `AGENTS.md` for full architecture documentation.
