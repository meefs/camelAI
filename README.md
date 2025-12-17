# OpenNext Starter

This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

Read the documentation at https://opennext.js.org/cloudflare.

## Develop

Run the Next.js development server:

```bash
npm run dev
# or similar package manager command
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

## Preview

Preview the application locally on the Cloudflare runtime:

```bash
npm run preview
# or similar package manager command
```

## Deploy

Deploy the application to Cloudflare:

```bash
npm run deploy
# or similar package manager command
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

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!
