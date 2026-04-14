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
