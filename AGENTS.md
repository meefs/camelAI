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
- `services/sandbox-host/` - Go sandbox host and data proxy services.
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
bun run test:sandbox-host   # Go tests for services/sandbox-host
```

Common deploy commands:

```bash
bun run deploy:main:prod
bun run deploy:main:staging
bun run deploy:dispatcher:prod
bun run deploy:dispatcher:staging
bun run deploy:bedrock-provider:prod
bun run deploy:go:sandbox-host
bun run deploy:go:sandbox-host:staging
bun run deploy:go:data-proxy
bun run deploy:go:data-proxy:staging
```

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
- `durable-objects.ts` - `ChatThreadDO`, chat WebSocket state and agent turn coordination.
- `workspace-cron.ts` - `WorkspaceCronDO`, scheduled prompt storage and dispatch.
- `worker-logs-do.ts` - `WorkerLogsDO`, deployed app log storage/streaming.
- `admin-index-do.ts` - `AdminIndexDO`, admin indexes and dashboard-style aggregates.
- `org-slug-registry.ts` - `OrgSlugDO`, atomic org slug ownership.
- `email-handle-registry.ts` - `EmailHandleDO`, email handle ownership.
- `mcp-handler.ts` - Internal MCP agent/tools.

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
- Computer tab file mutations may be intentionally blocked during beta; check `src/routes/api/workspaces.utils.ts` before changing write behavior.
- File safety logic lives in `workers/main/src/file-safety.ts` and is applied before agent turns for suspicious uploaded-file/deploy/bridge workflows.
- The Pi system prompt is assembled in `workers/main/src/durable-objects.ts`; keep security-relevant prompt changes explicit and tested.

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
- Admin and moderation flows often involve durable tombstones in KV plus destructive cleanup. Avoid changing ordering without tests.

## Integrations And Ingress

- Slack ingress starts in `workers/main/src/slack-events-queue.ts` and routes turns into `ChatThreadDO`.
- Email ingress starts in `workers/main/src/email-ingress.ts`; workspace addresses are subaddressed by org/workspace slug.
- OAuth integration code is split across `workers/main/src/services/oauth.ts`, `external-api-oauth.ts`, route files, and workspace integration storage.
- Scheduled prompts are owned by `WorkspaceCronDO` and exposed through MCP tools.

## Sandbox Host

- Go service code lives in `services/sandbox-host/`.
- The host manages Docker + gVisor lifecycle, workspace filesystem operations, chat transcript retrieval, OpenAI proxying/usage tracking, and data proxy forwarding.
- Prod and staging sandbox-hosts should be separate VMs/VPC services. GitHub Actions deploy SSH goes through Tailscale: prod `100.112.135.2` (`chiridion-sandbox-prod`) and staging `100.115.221.105` (`chiridion-sandbox-staging`). Direct public SSH should remain closed except for temporary break-glass. Keep deploys explicit with `bun run deploy:go:sandbox-host:prod` or `bun run deploy:go:sandbox-host:staging`.
- GitHub Actions sandbox-host deploys join Tailscale as ephemeral `tag:ci` nodes using `TS_OAUTH_CLIENT_ID` and `TS_OAUTH_SECRET`; the OAuth client needs writable `auth_keys` scope for `tag:ci`, and the tailnet policy must allow `tag:ci` to reach prod and staging TCP/22.
- Terraform examples for the Azure sandbox-host environments live in `infra/`; see `infra/README.md`, `infra/prod.tfvars.example`, and `infra/staging.tfvars.example`.
- Run `bun run test:sandbox-host` for Go changes.
- Local sandbox-host development uses `bun run dev:sandbox-host`.

## Testing Guidance

- For UI route/component changes, run at least `bun run typecheck` and the most relevant Vitest test(s).
- For Worker/DO behavior, prefer focused `bun run test:workers -- <test-file>` or `bun run test:workers` when the surface is shared.
- For sandbox-host changes, run `bun run test:sandbox-host`.
- For changes crossing browser chat, worker routing, and sandbox behavior, test the smallest representative path plus typecheck.
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
- `services/sandbox-host/README.md` for host-specific setup/deploy details.

Useful local variables include `CF_GATEWAY_TOKEN`, OAuth client IDs/secrets, `INTEGRATION_SECRET_KEY`, `TOKEN_SIGNING_SECRET`, email provider settings, and sandbox debug flags such as `TRACE_SANDBOX_HOST` and `TRACE_SANDBOX_LIFECYCLE`.

## Maintenance Rules

- Keep this guide short. Prefer pointers to files and tests over duplicating implementation details.
- When adding a major subsystem, add a short map entry and the canonical test command.
- When removing or renaming a subsystem, update this file in the same change.
- If a detail is likely to drift quickly, document where to verify it instead of freezing it here.
