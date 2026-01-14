# App Preview Screenshot Generation Plan

## Goals

- Generate a 16:9 preview screenshot for each deployed app.
- Trigger screenshots automatically after deploys without blocking deploy latency.
- Store screenshots in R2 and associate them with the app record for the Apps page.
- Support private apps safely (no public access bypass).
- Provide a clean fallback (gradient placeholder) when a screenshot is missing or failed.

## Non-Goals

- Live, auto-refreshing previews.
- Per-user screenshots or user-controlled styling.
- Screenshotting during local dev (optional, can be disabled).

## Current Hooks and Context

- Deploys flow through the Cloudflare API proxy in `workers/main/src/index.ts`.
  - Successful deploys are detected in `proxyCloudflareApi` on `PUT` to the dispatch script path.
  - This block already has `orgId`, `workspaceId`, `scriptName`, and `threadId` (from deploy token).
- App metadata is stored in `OrgDO` inside the `worker_scripts` table in `workers/main/src/auth.ts`.
- Apps list uses `getOrgApps()` in `src/lib/server-actions/apps.ts`.

## Proposed Architecture

### Overview

1. **Deploy completes** -> enqueue screenshot job.
2. **Queue consumer** renders screenshot with Browser Rendering.
3. **Store in R2** with a stable key.
4. **Update OrgDO** with screenshot metadata.
5. **Apps page** loads the image via a new API route or signed URL.

### Components

- **Queue producer:** main worker (`workers/main/src/index.ts`), near the deploy success path.
- **Queue consumer:** new `workers/screenshot` worker (recommended to keep Puppeteer out of main worker).
- **Storage:** R2 bucket or prefix dedicated to app previews.
- **Metadata:** new fields on `worker_scripts` (preview key, status, timestamps).
- **Serving:** Next.js API route that reads from R2 and enforces org membership.

## Queue and Job Model

### Queue binding

- Add a Cloudflare Queue binding in `wrangler.jsonc` for main worker and screenshot worker.
- Producer: `APP_SCREENSHOT_QUEUE`.
- Consumer: `APP_SCREENSHOT_QUEUE` bound in `workers/screenshot`.

### Message payload

```json
{
  "script_name": "my-app",
  "org_id": "org_123",
  "workspace_id": "ws_456",
  "deploy_ts": 1700000000000,
  "env_prefix": "staging",
  "is_public": true
}
```

Notes:
- `deploy_ts` lets the consumer ignore stale jobs if a newer deploy happened.
- `env_prefix` can be derived from `WORKER_BASE_URL` or passed explicitly.
- Consider setting the queue message id to `${script_name}:${deploy_ts}` to reduce duplicates.

## Screenshot Rendering Worker

### Worker choice

Create a new worker at `workers/screenshot/` with:
- `@cloudflare/puppeteer`
- Browser Rendering binding (`browser = { binding = "MYBROWSER" }`)
- `nodejs_compat` enabled

### Rendering steps (queue consumer)

1. **Build the target URL**
   - Prefer same-site domain: `https://${script}.apps.${env}.chiridion.ai`
   - This avoids the redirect flow used for cross-site vanity URLs.
2. **Authenticate for private apps**
   - Add a short-lived screenshot token (see next section).
   - Pass token via header or query param.
3. **Set viewport**
   - 1280x720 or 1920x1080 (16:9). Use device scale factor 2 for clarity.
4. **Navigate**
   - `page.goto(url, { waitUntil: "networkidle0", timeout: 30000 })`
   - Optional: wait an extra 500-1000 ms for fonts and layout.
5. **Capture**
   - `page.screenshot({ type: "jpeg", quality: 80, fullPage: false })`
6. **Store**
   - Write to R2 with content-type `image/jpeg`.
7. **Update OrgDO**
   - Save preview key and status for the app.

### Suggested screenshot tuning

- Inject CSS to hide scrollbars and stabilize layout:
  - `body { overflow: hidden; }`
- Optionally honor a `data-chiridion-ready` flag for apps that want a stable capture moment.
- Timeouts and error logging should be strict to avoid queue backlog.

## Access Control for Private Apps

### Problem

Dispatcher protects private apps using cookies and redirects. A screenshot worker has no user cookies.

### Solution: screenshot access token

- Add a new token type in `workers/main/src/worker-auth.ts`.
  - Stored in `API_TOKENS` KV.
  - Fields: `script_name`, `org_id`, `purpose: "screenshot"`, `expires_at`.
- Add a dispatcher check before normal auth:
  - If `Authorization: Bearer <token>` or `x-chiridion-screenshot-token` is present,
    validate token and allow dispatch.
- Token should be single-use and short TTL (1-5 minutes).
- The queue payload can include a token issued at enqueue time, or the screenshot worker can request one from main worker.

## Data Model Updates

### OrgDO schema changes

Add columns to `worker_scripts`:

- `preview_key TEXT`
- `preview_updated_at INTEGER`
- `preview_status TEXT` (`pending`, `ready`, `failed`)
- `preview_error TEXT` (optional)

Migration plan:
- Bump schema version in `workers/main/src/auth.ts`.
- Backfill existing rows with `preview_status = "pending"` or `NULL`.

### Type updates

Update types in:
- `workers/main/src/auth.ts` (WorkerScript)
- `src/lib/auth-do.ts` (WorkerScript interface)
- `src/types.ts` (WorkerScript and AdminAppSummary if needed)
- `src/lib/server-actions/apps.ts` mapping

## R2 Storage Strategy

### Bucket and key structure

Option A (recommended): reuse existing `R2_BUCKET` with a prefix.

```
app-previews/{orgId}/{workspaceId}/{scriptName}/{deployTs}.jpg
app-previews/{orgId}/{workspaceId}/{scriptName}/current.jpg
```

Store `current.jpg` for simple lookup, and keep the versioned key for rollback or history.

### Metadata and caching

- Set `contentType: image/jpeg`
- Set `cacheControl`:
  - `current.jpg`: `public, max-age=300`
  - versioned: `public, max-age=31536000, immutable`

## Serving Screenshots to the UI

### API route (recommended)

Add `GET /api/apps/[scriptName]/preview`:
- Requires org membership.
- Reads `preview_key` from OrgDO.
- Streams the image from R2 with `Cache-Control` and `ETag`.

Benefits:
- No public bucket needed.
- Private apps stay private.

### Alternative

Return a signed R2 URL and let the client load directly. This reduces server load but adds URL management.

## UI Integration

- Extend `getOrgApps()` response to include `preview_status` and `preview_key`.
- App card uses:
  - If `preview_status === "ready"` -> render image.
  - Else -> gradient placeholder (from `app-page-restyle-plan.md`).

## Failure Handling and Retries

- On failure, set `preview_status = "failed"` and log `preview_error`.
- Add a retry policy:
  - Re-enqueue with backoff (ex: 1m, 5m, 30m) up to N retries.
- Provide a manual "Regenerate screenshot" admin action (future).

## Backfill and Cleanup

- Add a one-off admin CLI command to enqueue screenshots for existing apps.
- On app deletion, delete `app-previews/...` objects (best-effort).
- Optionally prune old versioned screenshots after N days.

## Observability

- Log job start, duration, and outcome with `script_name`.
- Optional: write success/fail counts to Analytics Engine.
- Add a `preview_status` column to admin apps table for debugging.

## Rollout Plan

1. **Phase 0**: Add schema fields, update types, and keep UI fallback.
2. **Phase 1**: Implement queue + screenshot worker in dev; manual trigger.
3. **Phase 2**: Enable enqueue on deploy in staging; monitor logs.
4. **Phase 3**: Enable in production; backfill existing apps.

## Testing Plan

- Unit: OrgDO migrations and `preview_status` updates.
- Integration: queue -> screenshot worker -> R2 -> metadata update (mock Puppeteer).
- Manual: deploy a test app and verify preview renders in Apps page.

## Full docs for reference
---
title: Deploy a Browser Rendering Worker · Cloudflare Browser Rendering docs
description: By following this guide, you will create a Worker that uses the
  Browser Rendering API to take screenshots from web pages. This is a common use
  case for browser automation.
lastUpdated: 2025-09-23T16:44:41.000Z
chatbotDeprioritize: false
source_url:
  html: https://developers.cloudflare.com/browser-rendering/workers-bindings/screenshots/
  md: https://developers.cloudflare.com/browser-rendering/workers-bindings/screenshots/index.md
---

By following this guide, you will create a Worker that uses the Browser Rendering API to take screenshots from web pages. This is a common use case for browser automation.

1. Sign up for a [Cloudflare account](https://dash.cloudflare.com/sign-up/workers-and-pages).
2. Install [`Node.js`](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm).

Node.js version manager

Use a Node version manager like [Volta](https://volta.sh/) or [nvm](https://github.com/nvm-sh/nvm) to avoid permission issues and change Node.js versions. [Wrangler](https://developers.cloudflare.com/workers/wrangler/install-and-update/), discussed later in this guide, requires a Node version of `16.17.0` or later.

#### 1. Create a Worker project

[Cloudflare Workers](https://developers.cloudflare.com/workers/) provides a serverless execution environment that allows you to create new applications or augment existing ones without configuring or maintaining infrastructure. Your Worker application is a container to interact with a headless browser to do actions, such as taking screenshots.

Create a new Worker project named `browser-worker` by running:

* npm

  ```sh
  npm create cloudflare@latest -- browser-worker
  ```

* yarn

  ```sh
  yarn create cloudflare browser-worker
  ```

* pnpm

  ```sh
  pnpm create cloudflare@latest browser-worker
  ```

For setup, select the following options:

* For *What would you like to start with?*, choose `Hello World example`.
* For *Which template would you like to use?*, choose `Worker only`.
* For *Which language do you want to use?*, choose `JavaScript / TypeScript`.
* For *Do you want to use git for version control?*, choose `Yes`.
* For *Do you want to deploy your application?*, choose `No` (we will be making some changes before deploying).

#### 2. Install Puppeteer

In your `browser-worker` directory, install Cloudflare’s [fork of Puppeteer](https://developers.cloudflare.com/browser-rendering/puppeteer/):

* npm

  ```sh
  npm i -D @cloudflare/puppeteer
  ```

* yarn

  ```sh
  yarn add -D @cloudflare/puppeteer
  ```

* pnpm

  ```sh
  pnpm add -D @cloudflare/puppeteer
  ```

#### 3. Create a KV namespace

Browser Rendering can be used with other developer products. You might need a [relational database](https://developers.cloudflare.com/d1/), an [R2 bucket](https://developers.cloudflare.com/r2/) to archive your crawled pages and assets, a [Durable Object](https://developers.cloudflare.com/durable-objects/) to keep your browser instance alive and share it with multiple requests, or [Queues](https://developers.cloudflare.com/queues/) to handle your jobs asynchronously.

For the purpose of this example, we will use a [KV store](https://developers.cloudflare.com/kv/concepts/kv-namespaces/) to cache your screenshots.

Create two namespaces, one for production and one for development.

```sh
npx wrangler kv namespace create BROWSER_KV_DEMO
npx wrangler kv namespace create BROWSER_KV_DEMO --preview
```

Take note of the IDs for the next step.

#### 4. Configure the Wrangler configuration file

Configure your `browser-worker` project's [Wrangler configuration file](https://developers.cloudflare.com/workers/wrangler/configuration/) by adding a browser [binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/) and a [Node.js compatibility flag](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#nodejs-compatibility-flag). Bindings allow your Workers to interact with resources on the Cloudflare developer platform. Your browser `binding` name is set by you, this guide uses the name `MYBROWSER`. Browser bindings allow for communication between a Worker and a headless browser which allows you to do actions such as taking a screenshot, generating a PDF, and more.

Update your [Wrangler configuration file](https://developers.cloudflare.com/workers/wrangler/configuration/) with the Browser Rendering API binding and the KV namespaces you created:

* wrangler.jsonc

  ```jsonc
  {
    "$schema": "./node_modules/wrangler/config-schema.json",
    "name": "browser-worker",
    "main": "src/index.js",
    "compatibility_date": "2023-03-14",
    "compatibility_flags": [
      "nodejs_compat"
    ],
    "browser": {
      "binding": "MYBROWSER"
    },
    "kv_namespaces": [
      {
        "binding": "BROWSER_KV_DEMO",
        "id": "22cf855786094a88a6906f8edac425cd",
        "preview_id": "e1f8b68b68d24381b57071445f96e623"
      }
    ]
  }
  ```

* wrangler.toml

  ```toml
  name = "browser-worker"
  main = "src/index.js"
  compatibility_date = "2023-03-14"
  compatibility_flags = [ "nodejs_compat" ]


  browser = { binding = "MYBROWSER" }
  kv_namespaces = [
    { binding = "BROWSER_KV_DEMO", id = "22cf855786094a88a6906f8edac425cd", preview_id = "e1f8b68b68d24381b57071445f96e623" }
  ]
  ```

#### 5. Code

* JavaScript

  Update `src/index.js` with your Worker code:

  ```js
  import puppeteer from "@cloudflare/puppeteer";


  export default {
    async fetch(request, env) {
      const { searchParams } = new URL(request.url);
      let url = searchParams.get("url");
      let img;
      if (url) {
        url = new URL(url).toString(); // normalize
        img = await env.BROWSER_KV_DEMO.get(url, { type: "arrayBuffer" });
        if (img === null) {
          const browser = await puppeteer.launch(env.MYBROWSER);
          const page = await browser.newPage();
          await page.goto(url);
          img = await page.screenshot();
          await env.BROWSER_KV_DEMO.put(url, img, {
            expirationTtl: 60 * 60 * 24,
          });
          await browser.close();
        }
        return new Response(img, {
          headers: {
            "content-type": "image/jpeg",
          },
        });
      } else {
        return new Response("Please add an ?url=https://example.com/ parameter");
      }
    },
  };
  ```

* TypeScript

  Update `src/index.ts` with your Worker code:

  ```ts
  import puppeteer from "@cloudflare/puppeteer";


  interface Env {
    MYBROWSER: Fetcher;
    BROWSER_KV_DEMO: KVNamespace;
  }


  export default {
    async fetch(request, env): Promise<Response> {
      const { searchParams } = new URL(request.url);
      let url = searchParams.get("url");
      let img: Buffer;
      if (url) {
        url = new URL(url).toString(); // normalize
        img = await env.BROWSER_KV_DEMO.get(url, { type: "arrayBuffer" });
        if (img === null) {
          const browser = await puppeteer.launch(env.MYBROWSER);
          const page = await browser.newPage();
          await page.goto(url);
          img = (await page.screenshot()) as Buffer;
          await env.BROWSER_KV_DEMO.put(url, img, {
            expirationTtl: 60 * 60 * 24,
          });
          await browser.close();
        }
        return new Response(img, {
          headers: {
            "content-type": "image/jpeg",
          },
        });
      } else {
        return new Response("Please add an ?url=https://example.com/ parameter");
      }
    },
  } satisfies ExportedHandler<Env>;
  ```

This Worker instantiates a browser using Puppeteer, opens a new page, navigates to the location of the 'url' parameter, takes a screenshot of the page, stores the screenshot in KV, closes the browser, and responds with the JPEG image of the screenshot.

If your Worker is running in production, it will store the screenshot to the production KV namespace. If you are running `wrangler dev`, it will store the screenshot to the dev KV namespace.

If the same `url` is requested again, it will use the cached version in KV instead, unless it expired.

#### 6. Test

Run `npx wrangler dev` to test your Worker locally.

Use real headless browser during local development

To interact with a real headless browser during local development, set `"remote" : true` in the Browser binding configuration. Learn more in our [remote bindings documentation](https://developers.cloudflare.com/workers/development-testing/#remote-bindings).

To test taking your first screenshot, go to the following URL:

`<LOCAL_HOST_URL>/?url=https://example.com`

#### 7. Deploy

Run `npx wrangler deploy` to deploy your Worker to the Cloudflare global network.

To take your first screenshot, go to the following URL:

`<YOUR_WORKER>.<YOUR_SUBDOMAIN>.workers.dev/?url=https://example.com`

## Related resources

* Other [Puppeteer examples](https://github.com/cloudflare/puppeteer/tree/main/examples)
