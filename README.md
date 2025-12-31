# Chiridion App Starter

Starter template for Chiridion: Next.js UI + Cloudflare Workers + Containers, with streaming AI over WebSockets.

## Getting Started

Read the OpenNext Cloudflare docs at https://opennext.js.org/cloudflare.

## Develop

Run the local dev stack (wrangler dev + next dev + proxy):

```bash
npm run dev
# or similar package manager command
```

The proxy routes `/ws/*` and `/client/v4/*` to Wrangler and everything else to Next:

- App: http://localhost:3100
- Wrangler: http://localhost:8787
- Next: http://localhost:3001

Override ports with `PROXY_DEV_PORT`, `WRANGLER_DEV_PORT`, `NEXT_DEV_PORT`.

You can start editing the UI in `src/app/`.

## Preview

Preview the application locally on the Cloudflare runtime:

```bash
npm run preview
# or similar package manager command
```

## Deploy

Deploy the application to Cloudflare:

```bash
npm run deploy:prod
# or similar package manager command
```

Staging:

```bash
npm run deploy:staging
```

## R2 Mount (Sandbox Home Dir)

The sandbox container mounts an R2 bucket via FUSE at `$HOME/r2` (defaults to `/root/r2`) before running `sandbox/driver.mjs`.

- Bucket: `chiridion-sandbox` (created via `wrangler r2 bucket create chiridion-sandbox`)
- Required secrets (R2 S3 API keys): `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`
- Required vars: `R2_ACCOUNT_ID`, `R2_BUCKET_NAME` (set in `wrangler.jsonc`)
- Optional: `R2_MOUNT_DIR`, `R2_MOUNT_READONLY=1`

Set secrets:

```bash
npx wrangler secret put AWS_ACCESS_KEY_ID
npx wrangler secret put AWS_SECRET_ACCESS_KEY
```

## Sandbox Starter Worker (WFP)

On first run, the sandbox seeds a starter Workers for Platforms project into `$HOME/project` from `sandbox/starter-worker` (the template is baked into the container image via `Dockerfile`).

Inside the sandbox, you can deploy it via the app’s proxy endpoint:

```bash
cd "$HOME/project"
npm run deploy
```

This runs `wrangler deploy` inside the sandbox. The app injects:

- `CLOUDFLARE_API_TOKEN` as a per-sandbox deploy token that maps to a fixed `script_name` in KV (the proxy overrides the script name)

The sandbox runs Wrangler directly against the app’s Cloudflare API proxy by setting `CLOUDFLARE_API_BASE_URL` to `${CHIRIDION_BASE_URL}/client/v4`. The app proxy requires a deploy token (currently provided via Wrangler’s `Authorization: Bearer ...` header).

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!
