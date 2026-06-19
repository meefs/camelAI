# camelAI Agent Guide

Keep this file concise and durable. Add details here only when they help future agents navigate the repo or avoid common mistakes. Feature-specific behavior should usually live near the code or in tests.

## What This Is

camelAI is an AI coding assistant platform on Cloudflare Workers + Durable Objects with Docker/gVisor sandbox runtimes on Azure VMs. Users chat with persistent coding workspaces, run either Claude SDK or Codex app-server backed threads, and publish generated apps to `*.camelai.app` / environment-specific app hosts.

## High-Level Architecture

```text
React Router SSR + browser WS
        |
        v
Cloudflare main Worker + Durable Objects
        |
        | VPC service binding / tunnel
        v
Sandbox host on Azure VM
        |
        v
Docker + gVisor workspace containers

Dispatcher Worker routes published user apps.
R2 stores uploads/assets/previews.
Cloudflare AI Gateway and BYOK credentials back model access.
```

## Repository Map

- `src/` - React Router 7 app, routes, loaders/actions, UI components, shared server/client libraries.
- `src/routes.ts` - Imperative React Router route config. Add page/API routes here.
- `src/routes/api/` - React Router API routes served by the main app worker.
- `src/components/ui/` - shadcn/ui components.
- `workers/main/` - Main Cloudflare Worker, Durable Objects, WebSocket routing, auth helpers, MCP, admin APIs, proxies.
- `workers/dispatcher/` - Workers for Platforms dispatcher for deployed user apps.
- `workers/bedrock-provider/` - AI Gateway custom provider translating Anthropic-style requests to Bedrock.
- `workers/user-logs-tail/` - Tail worker for deployed app logs.
- `services/sandbox-host/` - Legacy Go code retained for the data-proxy container build path.
- `sandbox/` - In-container control plane, Codex/Claude harness integration, MCP helpers, scaffold/publish tooling, sandbox skills.
- `scripts/` - Deploy and maintenance scripts.
- `docs/` - Supporting documentation, including shadcn component catalog.

## Development Commands

Use Bun for JS commands.

```bash
bun run dev                 # React Router dev with Cloudflare bindings, default localhost:3001
bun run build               # Production React Router build
bun run typecheck           # Generate route types, then tsc
bun run lint                # ESLint
bun run test                # Vitest watch mode
bun run test:run            # Vitest run once
bun run test:workers        # Worker/Miniflare tests
bun run test:all            # Unit + worker tests
bun run test:e2e            # Playwright
```

Common deploy commands:

```bash
bun run deploy:main:prod
bun run deploy:main:staging
bun run deploy:dispatcher:prod
bun run deploy:dispatcher:staging
bun run deploy:dispatcher:evals       # testing-grounds dispatcher for real-deploy evals
bun run deploy:bedrock-provider:prod
```

### Real-deploy evals (testing grounds)

Agent evals deploy apps for real to a dedicated testing-grounds namespace so they are
actually usable. The eval sandbox runs inside Miniflare, so `eval-sandbox.ts` intercepts the
container's Cloudflare API traffic and forwards it to the production `proxyCloudflareApi`
in-process (identity via `trustedIdentity` from the per-container eval deploy context in
`eval-deploy-context.ts`). The deploy then publishes to the `chiridion-platform-evals`
dispatch namespace and registers in OrgDO exactly like production — so `list_apps` /
`set_preview` and `AgentEvalSessionResult.deployedApps` surface the app through the normal
app path with no eval-specific branches in `mcp-handler`/`chat-thread-do`. The testing-grounds
host comes from the eval env's `WORKER_BASE_URL` / `LOCAL_APP_VANITY_DOMAIN`
(`*.evals.camelai.app`), and virtual bindings resolve against the staging main worker
(`CF_WORKER_NAME`); these are pinned in `wrangler.test.jsonc`. Real deploy is the default for
agent eval runs whenever `CF_API_TOKEN` is set; `EVAL_REAL_DEPLOY=0` disables it (deploy evals
then skip). Served by the evals dispatcher (`workers/dispatcher/wrangler.evals.jsonc`); the
namespace + DNS routes are created out-of-band. Eval apps are kept (no cleanup). Live-data
bindings (`DATA_PROXY`/`CONNECTIONS`) won't resolve to the eval's local workspace;
self-contained apps render fully.

## Frontend Conventions

- React Router is in framework mode. Prefer `loader`, `action`, `<Form>`, and `useFetcher` over client-only fetching in `useEffect`.
- Route definitions live in `src/routes.ts`; route modules live in `src/routes/`.
- Tailwind CSS v4 and shadcn/ui are the default UI stack.
- For UI work, use the `shadcn-components` skill and existing primitives in `src/components/ui/`.
- Use `cn()` from `@/lib/utils` for class composition.
- Use Lucide icons where appropriate.
- Keep app surfaces work-focused and dense. Avoid marketing-style pages unless the task explicitly asks for one.

## Worker And Durable Object Conventions

Important DOs and runtime classes live primarily in `workers/main/src/`:

- `auth.ts` - `UserDO`, `OrgDO`, auth-related org/user behavior.
- `workspace.ts` - `WorkspaceDO`, workspace metadata, integration state, token refresh alarms.
- `chat-thread-do.ts` - `ChatThreadDO`, chat WebSocket state and agent turn coordination.
- `workspace-cron.ts` - `WorkspaceCronDO`, scheduled prompt storage and dispatch.
- `worker-logs-do.ts` - `WorkerLogsDO`, deployed app log storage/streaming.
- `admin-index-do.ts` - `AdminIndexDO`, admin indexes and dashboard-style aggregates.
- `org-slug-registry.ts` - `OrgSlugDO`, atomic org slug ownership.
- `email-handle-registry.ts` - `EmailHandleDO`, email handle ownership.
- `mcp-handler.ts` - Internal MCP agent/tools.
- `observability.ts` - Shared Cloudflare Analytics Engine event/error writer. New structured instrumentation should go through this helper instead of calling `writeDataPoint` directly.

Durable Objects use SQLite-backed storage. Prefer:

```ts
this.ctx.storage.sql.exec("SELECT * FROM table WHERE id = ?", id);
this.ctx.storage.kv.put("key", value);
const value = this.ctx.storage.kv.get("key");
```

Do not use legacy async DO storage (`await ctx.storage.get/put`) in new code. Do not use module-level mutable `Map`, `Set`, or singleton instance caches in Worker code; isolate reuse can leak stale state across requests.

For background work in Workers, import `waitUntil` from `cloudflare:workers` and catch/log failures:

```ts
import { waitUntil } from "cloudflare:workers";

waitUntil(
  task().catch((error) => console.error("Background task failed", error)),
);
```

## Observability

- Cloudflare Workers Observability and source-map uploads are enabled in deployed Wrangler configs.
- Structured operational events go to `OBSERVABILITY_EVENTS`; structured errors are mirrored through `ERROR_ANALYTICS`. Use `recordObservabilityEvent` / `recordErrorEvent` from `workers/main/src/observability.ts` for new instrumentation.
- Keep observability payloads diagnostic but not transcript-like: include ids, counts, status, durations, routes, and error metadata; do not store chat message contents, secrets, request bodies, or auth headers.
- The main app workers attach Tail Consumers to `workers/user-logs-tail/`, which forwards raw Worker trace/log/exception events into `WorkerLogsDO`.
- Production datasets are `chiridion_observability_prod` and `chiridion_errors_prod`; staging uses the corresponding `_staging` datasets. Verify bindings in the environment-specific `wrangler*.jsonc` files before changing collection paths.
- Query Analytics Engine through Cloudflare's SQL API with an account token that has Account Analytics Read. The account id is `CF_ACCOUNT_ID` in Wrangler vars. Example:

```bash
curl "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/analytics_engine/sql" \
  --header "Authorization: Bearer $CF_API_TOKEN" \
  --data "SELECT timestamp, blob1 AS event, blob3 AS component, blob5 AS status, blob9 AS thread_id, double2 AS duration_ms FROM chiridion_observability_staging WHERE timestamp > NOW() - INTERVAL '1' HOUR ORDER BY timestamp DESC LIMIT 100 FORMAT JSON"
```

- `OBSERVABILITY_EVENTS` schema: `blob1 event`, `blob2 severity`, `blob3 component`, `blob4 operation`, `blob5 status`, `blob6 route`, `blob7 method`, `blob8 path`, `blob9 threadId`, `blob10 workspaceId`, `blob11 orgId`, `blob12 userId`, `blob13 requestId`, `blob14 provider`, `blob15 model`, `blob16 errorName`, `blob17 errorMessage`, `blob18 errorStack`; `double1 timestamp_ms`, `double2 duration_ms`, `double3 status_code`, `double4 count`, `double5 size`; `index1 sample key`.
- `ERROR_ANALYTICS` has the error-focused subset: `blob1 event`, `blob2 component`, `blob3 operation`, `blob4 status`, `blob5 errorName`, `blob6 errorMessage`, `blob7 threadId`, `blob8 workspaceId`, `blob9 orgId`, `blob10 userId`, `blob11 requestId`, `blob12 route`, `blob13 path`, `blob14 errorStack`; doubles match the same timestamp/duration/status/count/size order.
- For aggregate counts/sums, account for sampling with `_sample_interval`, for example `SUM(_sample_interval)` instead of `COUNT()`.

## Chat And Runtime Flow

- Browser chat connects to `/ws/{workspace}`.
- The main worker validates access and routes to `ChatThreadDO`.
- `ChatThreadDO` runs the Pi coding agent in the Durable Object. File, shell, and container operations are forwarded to the sandbox-host control plane.
- Thread records store provider/model state on org thread data. Verify current fields in `OrgDO` before changing related behavior.
- Active message history is stored in `ChatThreadDO`; sandbox-host chat message APIs are retained for legacy session migration.
- Slash commands are allowlisted in `ChatThreadDO`; check `SLASH_COMMANDS` before adding or changing one.
- Clarifying questions use the Pi `AskUserQuestion`/`ask_user_question` tools.

### Adding a new chat model

When adding a new model (Claude, OpenAI, OpenRouter), follow the checklist at
the top of `src/lib/model-catalog.ts`. The picker, pricing, and harness routing
live in separate files, and the catalog tests fail if any of them drift apart.

## Uploads, Files, And Safety

- Chat uploads use multipart R2 upload APIs under `/api/workspaces/:id/upload`.
- Workspace file API routes live under `/api/workspaces/:id/fs/*`.
- File safety logic lives in `workers/main/src/file-safety.ts` and is applied before agent turns for suspicious uploaded-file/deploy/bridge workflows.
- The Pi system prompt is assembled in `workers/main/src/chat-thread-do.ts`; keep security-relevant prompt changes explicit and tested.

## Proxies And Bindings

- Sandbox containers do not get a generic Worker API proxy. File, shell, and runtime operations go through explicit sandbox-host control-plane APIs.
- BYOK credentials are scoped by org/thread and should not be placed into container environment variables.
- User app deploys can rewrite internal service bindings such as the data proxy, virtual AI binding, and virtual R2 bucket. Relevant files include `workers/main/src/cf-api-proxy.ts`, `data-proxy-service.ts`, `ai-virtual-binding.ts`, and `r2-virtual-bucket.ts`.
- Outbound database traffic from the data proxy egresses from the sandbox host VM IP `20.46.233.68`. This IP is surfaced in direct database connection setup UIs (postgres, mysql, clickhouse, mongodb, redis, snowflake) for firewall/VPC allowlisting; constant lives in `src/lib/sandbox-network.ts`.

## Stripe Billing And Credits

- Org billing state lives on `org_info` JSON. Key fields include `billing_status`, Stripe customer/subscription ids, purchased credit cents, included/granted credit cents, trial credit grant metadata, and the last included-credit invoice id.
- Hosted model access is enforced in the Worker/DO inference path. Hosted `trialing` and `active` usage requires positive included/purchased credits; BYOK can be used from the free onboarding path and does not consume camelAI credits; `enterprise` bypasses Stripe subscription and credits.
- Hosted credit allowances come from `src/lib/billing-plans.ts`: Starter includes $10/month, Pro includes $30/month, and Team includes $10/month per paid seat. `BILLING_TRIAL_CREDIT_CENTS` and `BILLING_SUBSCRIPTION_INCLUDED_CREDIT_CENTS` are global emergency overrides; do not set them for normal tier-specific pricing.
- Admins can grant credits manually with `POST /api/admin/orgs/:id/credits`; credits add to `billing_credit_grant_total_cents` and can use an idempotency key.
- `STRIPE_MODE` can be set to `test` or `live`; Stripe API calls reject secret keys whose `sk_`/`rk_` prefix does not match. Staging should use `STRIPE_MODE=test`, and production should use `STRIPE_MODE=live`.
- Stripe webhooks land on `POST /api/billing/stripe/webhook`. Subscription events sync status and grant the one-time trial cap; `invoice.payment_succeeded` grants recurring included credits idempotently; credit checkout sessions increment purchased credits.
- Credit balance is purchased credits plus included/granted credits minus sandbox-host usage rows marked `credit_chargeable = 1`.

## Auth, Onboarding, And Admin

- Session/auth helpers are split between app-side loaders/actions in `src/lib/` and Worker-side helpers in `workers/main/src/helpers/`.
- Password auth, OAuth account creation, email verification, onboarding, bans, and blocked signup policies all have tests in `workers/main/tests/`; update or add focused tests when touching these flows.
- Superuser UI routes live under `/qaml-backdoor`.
- Bearer-auth admin APIs live under `/api/admin/*`; implementation is in `workers/main/src/routes/admin/` and related route modules in `src/routes/api/`.
- Admin MCP is served at `/api/admin/mcp` (`https://staging.camelai.dev/api/admin/mcp` in staging) and uses OAuth scope `admin:mcp`. Staging is also behind Cloudflare Access; pass `CF-Access-Token: $(cloudflared access token -app=https://staging.camelai.dev)` when connecting with `mcporter`. If an MCP client opens an authorize URL with `scope=openid+email+profile`, the flow will fail with `invalid_scope`; force `admin:mcp` with `oauthScope` or a pre-registered static OAuth client.
- A reliable staging smoke path for admin MCP is: register or provide an OAuth client for the chosen localhost callback with `scope: "admin:mcp"`, set `ACCESS_TOKEN=$(cloudflared access token -app=https://staging.camelai.dev)`, then add a private `mcporter` config entry with `baseUrl: "https://staging.camelai.dev/api/admin/mcp"`, `auth: "oauth"`, `oauthScope: "admin:mcp"`, and `headers: { "CF-Access-Token": "$env:ACCESS_TOKEN" }`. Run `npx mcporter auth <server-name>` followed by `npx mcporter list <server-name> --json`. The browser session must be a camelAI superuser, otherwise authorization fails with `Admin access required`.
- Admin and moderation flows often involve durable tombstones in KV plus destructive cleanup. Avoid changing ordering without tests.

## Integrations And Ingress

- Slack ingress starts in `workers/main/src/slack-events-queue.ts` and routes turns into `ChatThreadDO`.
- Email ingress starts in `workers/main/src/email-ingress.ts`; workspace addresses are subaddressed by org/workspace slug.
- Local Email Worker ingress can be simulated with `POST /cdn-cgi/handler/email` on the local dev server, passing `from` and `to` query params plus a raw RFC 822-style body. Real MX-routed inbound email always reaches the deployed Worker route, not localhost.
- Local outbound email uses the `send_email` binding from Wrangler config. For agent email, sender addresses must resolve to workspace email handles on `WORKSPACE_EMAIL_DOMAIN`; do not fall back to `EMAIL_FROM_ADDRESS`/`no-reply` for agent sends.
- OAuth integration code is split across `workers/main/src/services/oauth.ts`, `external-api-oauth.ts`, route files, and workspace integration storage.
- Scheduled prompts are owned by `WorkspaceCronDO` and exposed through MCP tools.

## Project Runtime

- Projects run through the external project runtime service via the `PROJECT_RUNTIME_HOST` VPC binding and `ProjectRuntimeServiceVmBridge`.
- Project metadata and DO-backed workspace files live in `WorkspaceFilesystemDO`; project files and shell execution live in the runtime service.
- The old app-owned sandbox-host deploy/dev scripts have been removed. Do not add new project VM behavior through the retired sandbox-host binding.

## Testing Guidance

- For UI route/component changes, run at least `bun run typecheck` and the most relevant Vitest test(s).
- For Worker/DO behavior, prefer focused `bun run test:workers -- <test-file>` or `bun run test:workers` when the surface is shared.
- For changes crossing browser chat, worker routing, and project runtime behavior, test the smallest representative path plus typecheck.
- Add tests when changing auth, billing/usage, admin purge/ban behavior, proxy auth, file safety, or persistence semantics.

## Error Handling Culture

- Prefer failing loudly and early over silently swallowing errors or falling back to unclear behavior. Hidden failures make production bugs much harder to debug.
- Only add fallbacks when they preserve a clearly defined user experience and still expose enough signal through errors, logs, or tests to diagnose the original failure.
- Do not convert unexpected persistence, auth, upload, billing, or runtime/tool failures into empty data unless the caller explicitly treats "not found" as a valid state.

## Local Environment Notes

Minimal prerequisites: Node.js 22+, Bun, Go 1.24+ for sandbox-host, and Cloudflare credentials for deployed/bound services.

Common local secret/config files:

- `.dev.vars` for Worker/dev secrets.
- `wrangler*.jsonc` for environment-specific Cloudflare config.
Useful local variables include `CF_GATEWAY_TOKEN`, OAuth client IDs/secrets, `INTEGRATION_SECRET_KEY`, `TOKEN_SIGNING_SECRET`, and email provider settings.

For exe.dev-specific admin MCP setup with mcporter, see `docs/exedev-admin-mcp.md`.

## Maintenance Rules

- Keep this guide short. Prefer pointers to files and tests over duplicating implementation details.
- When adding a major subsystem, add a short map entry and the canonical test command.
- When removing or renaming a subsystem, update this file in the same change.
- If a detail is likely to drift quickly, document where to verify it instead of freezing it here.
