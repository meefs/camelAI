# camelAI - Agent Documentation

> **Note to agents:** Keep this file up to date. When you add new features, workers, API routes, or make significant architectural changes, update the relevant sections of this document.

## Overview

camelAI is an AI coding assistant built on Cloudflare's edge infrastructure. Users chat with a Claude-powered agent that has a persistent workspace where files survive across sessions. Users create applications by having the agent write code, then publish them to live `*.camelai.app` URLs. The app supports integrations (connections) to external services.

## Architecture

```
┌─────────────────┐     ┌──────────────────────┐  VPC Tunnel  ┌──────────────────────┐
│  React Router   │────▶│   Cloudflare Worker  │─────────────▶│   Sandbox Host       │
│   (SSR + WS)    │◀────│   (Durable Objects)  │◀─────────────│  (Docker + gVisor)   │
└─────────────────┘     └──────────────────────┘              └──────────────────────┘
         │                        │                                      │
         │                        ▼                                      ▼
         │              ┌──────────────────┐                   ┌─────────────────┐
         │              │  Dispatcher WfP  │                   │ Premium SSD v2  │
         │              │ (User App Hosts) │                   │ (XFS + prjquota)│
         │              └──────────────────┘                   └─────────────────┘
         │                        │
         ▼                        ▼
┌─────────────────┐     ┌──────────────────┐
│   R2 Storage    │     │ Cloudflare AI GW │
│  (Files/Assets) │     │ (LLM Access)     │
└─────────────────┘     └──────────────────┘
```

### Components

1. **Frontend** (`src/`)
   - React Router 7 with React 19 SSR in **framework mode** (successor to Remix)
   - Imperative route configuration in `src/routes.ts`
   - Prefer server-driven data flow (`loader`, `action`, `<Form>`, `useFetcher`) over SPA-style client fetching in `useEffect`
   - WebSocket client for real-time streaming
   - Tailwind CSS v4 + shadcn/ui components
   - Cloudflare Workers SSR via `@cloudflare/vite-plugin`

2. **Workers** (`workers/`)
   - `main/` - Main camelAI app worker (SSR, Durable Objects, WebSocket routing, OAuth, MCP, admin CLI API)
   - `dispatcher/` - Routes `*.camelai.app` to user workers (Workers for Platforms)

3. **Sandbox Host** (`services/sandbox-host/`)
   - Go HTTP server managing Docker + gVisor container lifecycle on Azure VM
   - Accessed via Workers VPC binding (Cloudflare Tunnel) — not exposed to public internet
   - Host FS operations on a Premium SSD v2 managed disk mounted as XFS at `/srv/sandboxes`
   - Proxies control plane traffic (health, env, chat WebSocket) to containers

4. **Sandbox** (`sandbox/`)
   - `control-plane.mjs` - In-sandbox control plane server + Claude Agent SDK session runner
   - `memory-logger.mjs` - Runner helper for loading user profile context
   - `create-worker/` - Project scaffolders (`create-worker` for starter apps, `publish` for deploying files as standalone apps)
   - `skills/` - Agent skills (data-analysis, developing-software, file-sharing, testing-debugging)

## UI Components (shadcn/ui)

This project uses [shadcn/ui](https://ui.shadcn.com). **When doing ANY UI work, the `shadcn-components` skill will auto-activate.**

- **Style:** radix-mira, zinc, Figtree font, 0.5rem radius, Lucide icons
- **Install:** `npx shadcn@latest add <component>`
- **Styling:** Use `cn()` from `@/lib/utils`, theme vars in `globals.css`
- **Catalog:** `docs/shadcn-components.md` has the full component list by category
- **Installed components:** `src/components/ui/`

## Data Flow

### Authentication
1. User signs up/logs in via `/api/auth/login` or `/api/auth/signup`
2. Passwords are hashed/verified with PBKDF2 (100k iterations, SHA-256)
3. Password-based signups receive an email verification link (`/api/auth/verify-email`), and onboarding completion is blocked until verified (`/api/auth/verify-email/send` for resend)
4. Session stored in KV (`SESSIONS`), cookie set with `httpOnly`, `sameSite: lax`
5. Route loaders call `requireAuthContext()` to validate session and load user/org/workspace data

### OAuth State Storage
Google/GitHub OAuth `state` is stored in a dedicated per-state Durable Object (`OAuthStateDO`) keyed by `state` value (`idFromName(state)`). This avoids KV eventual-consistency issues for callback validation and avoids a single DO bottleneck because each login state is isolated to its own DO instance. Callback handling uses an atomic consume-and-read DO RPC before token exchange so each `state` is single-use.

### Onboarding
Incomplete users are redirected to `/onboarding` before accessing `_app` routes. OAuth signups (non-team) auto-complete onboarding with no UI, then redirect to first chat. Password signups stay on the onboarding welcome screen until email verification is complete, then proceed. Team invitation users see the team welcome screen before proceeding. `POST /api/onboarding/complete` now marks `completed_at`, creates the first thread, and returns a hidden onboarding system message plus redirect target. The client seeds `pendingMessage:newThread` and `showBootModal` in sessionStorage before navigating to `/chat/{threadId}?newThread=1`. Preference capture now happens in-chat through `AskUserQuestion`; `~/.chiridion/profile.md` is maintained by the profile-writer subagent.

### Get Help Requests
Users can open an in-app help dialog from the sidebar footer (`Get Help`, `CircleHelp` icon). The form posts to `POST /api/help` with category, severity, description, and client context (`pageUrl`, `screenSize`). The route validates with zod/Conform, returns success immediately, and uses `waitUntil()` to:
1. Generate a concise subject line with Workers AI (`@cf/google/gemma-3-12b-it`)
2. Send a user confirmation email (CC + Reply-To: `support@camelai.com`)
3. Send an internal support-triage email to `support@camelai.com` with user/org/workspace/browser context
4. Log non-`sent` email delivery results (`failed`/`skipped`) for observability

### Dev Email Outbox
When `NEXTJS_ENV=development`, sent email payloads are captured into a dev outbox (KV-backed) with delivery status and provider metadata. Inspect via:
- `GET /api/dev/sent-emails?format=html` for a browsable list
- `GET /api/dev/sent-emails/:id?format=html` for full rendered HTML preview

### Message Sending
1. WebSocket connects to `/ws/{workspace}` → Worker validates access → forwards to `ChatThreadDO`
2. `ChatThreadDO` opens WebSocket to sandbox `control-plane.mjs`
3. `control-plane.mjs` calls Claude SDK `query()` and streams events back with monotonic `seq` numbers
4. On reconnects, `ChatThreadDO` sends `lastSeq`, replays missed events, dedupes, resumes streaming
5. Browser user messages are author-attributed inside `ChatThreadDO` by serializing each WebSocket's `{ userId, userName, userEmail }` as a socket attachment on upgrade and reading that attachment when the socket sends `type: "message"`. This keeps multiplayer threads from reusing a thread-global author identity across collaborators.
6. Claude SDK stores messages in JSONL at `/home/claude/.claude/projects/-home-claude/{threadId}.jsonl`
7. `Chat.tsx` discloses compaction progress in-flight: `CompactingIndicator` turns on for manual `/compact` and auto-compaction (`system/status` with `status: "compacting"`, plus `stream_event/content_block_start(type=compaction)` fallback) and clears on summary capture, `status: null`, turn `result`/`error`, reconnect reset, or reconnect-exhausted close.
8. `ChatThreadDO` computes context usage from `stream_event.message_start` usage and now broadcasts live `context_usage_state` updates during a turn when a model-scoped `contextWindow` cache is available (`chatContextWindowByModel`, persisted in DO KV). On `result`, it computes and persists the canonical value (`chatContextUsedPercent`) and replays `transientContextUsedPercent ?? contextUsedPercent` on chat init so reconnects can resume from the freshest value. The composer `ContextIndicator` (left toolbar, after Mic) appears when usage is `>= 50%`, shows `"XX% used"`, and can trigger `/compact` without mutating unsent draft text.

### Agent Teams Polling
- `sandbox/team-poll-controller.mjs` owns TeamCreate tracking and teammate inbox polling for a thread; `control-plane.mjs` delegates SDK events/results to this controller.
- The controller stores canonical owned-team names per thread in `~/.claude/projects/<projectPath>/<threadId>.team-poll-state.json`.
- Teammate inbox polling only considers teams owned by the current thread and skips entries already marked `read` or previously consumed (persisted per team), preventing duplicate teammate message injection after control-plane restarts.

### Thread Message History Retrieval
`getMessages()` no longer parses JSONL in the Worker runtime. It now calls sandbox-host `GET /v1/workspaces/{orgId}/{workspaceId}/chat/messages?threadId={threadId}`, and sandbox-host reads + parses the JSONL file into `Message[]` before returning it. For large histories, the app can request `GET /api/workspaces/:id/chat/:threadId/messages/stream`, and the Worker streams the JSON response body through from sandbox-host without buffering the full payload in Worker memory.

### QAML Backdoor Read-Only Thread View
Superusers can open `/chat/:threadId?adminReadonly=1` from qaml-backdoor thread list/detail via **View as User** (opens in a new tab). Read-only mode:
- loads messages from `GET /api/admin/threads/:id/messages` (which proxies sandbox-host parsed JSONL response)
- disables composer/send and chat websocket connection
- keeps preview panel enabled for QC inspection of generated files/apps

### QAML Backdoor Org Detail Panels
Org detail (`/qaml-backdoor/orgs/:id`) includes:
- **Recent Threads**: latest 10 by `updated_at` (newest first)
- **Recent Apps**: latest 10 by `updated_at` (newest first)
- Counts are shown only when cheap to derive (no heavy count queries on page load)

### Slack Chat Ingress
1. Slack Events API posts to `/api/integrations/slack/events` (signature-verified with `SLACK_SIGNING_SECRET`)
2. Worker dedupes by Slack `event_id` and message identity (`team/channel/user/ts`), enqueues to `SLACK_EVENTS_QUEUE`, and returns `200` immediately
3. Queue consumer resolves workspace/integration by Slack `team_id` from KV index (`slack_team:{teamId}`)
4. Queue consumer maps Slack thread (`team/channel/root_ts`) to camelAI thread ID (`slack_thread:*`) and creates thread if needed
5. `ChatThreadDO` ingests Slack turns through `externalMessage(...)` Durable Object RPC
6. `AskUserQuestion` is interactive only when a browser chat websocket is connected for the thread; without a browser session, `ChatThreadDO` auto-answers unavailable to the model
7. Slack replies receive final assistant output, busy, or error text

### Email Chat Ingress
1. Cloudflare Email Routing delivers inbound messages to Worker `email()` (non-HTTP handler)
2. A single registered inbox local-part is used (for example `chat@<domain>`), and workspace addresses are subaddressed as `{local-part}+{orgSlug}.{workspaceSlug}@<domain>` (e.g., `chat+acme-corp-85b.default-workspace@camelai.dev`)
3. Sender is authorized by email (`EMAIL_TO_USER` lookup) plus workspace access check (org member + workspace access not `none`)
4. Follow-ups are routed to existing threads using email reply headers (`In-Reply-To` / `References`) mapped in KV (`email_reply_ref:*`)
5. MIME attachments are uploaded to workspace-scoped R2 keys under `user-uploads/` and appended to the inbound turn as `(user uploaded file to /mnt/user-uploads/<filename>)` lines (same format as web chat uploads)
6. `ChatThreadDO` ingests email turns through `externalMessage(...)` Durable Object RPC
7. `AskUserQuestion` follows the same browser-presence rule as Slack/web: interactive only when a browser chat websocket is connected; otherwise the model gets an unavailable response
8. Replies are sent from workspace-scoped subaddresses (`{local-part}+{orgSlug}.{workspaceSlug}@<domain>`) with explicit `Message-ID` so clients include references on subsequent replies, and outbound bodies are sent as `multipart/alternative` (`text/plain` + markdown-rendered `text/html`)

### Sandbox Proxy Auth
- Container egress calls go through sandbox-host `/proxy/:threadId/*`.
- Sandbox-host injects `x-sandbox-secret`, `x-chiridion-org-id`, `x-chiridion-workspace-id`, and `x-chiridion-thread-id` on upstream worker requests.
- `claude-proxy` (`/api/claude/v1/messages` and `/api/claude/v1/messages/count_tokens`) and OpenAI proxy (`/api/openai/v1/*`) accept only sandbox-host injected auth (no signed-token fallback path).
- Proxy thread mappings are session-based: active while chat WS is open; on close they enter close-grace (`PROXY_SESSION_CLOSE_GRACE_MS`) and then are cleaned up.

### Data Proxy (SQL Server, PostgreSQL, MySQL)
- User uploaded workers declare a `service` binding named `DATA_PROXY`; during deploy, `cf-api-proxy` rewrites it to an internal service entrypoint (`DataProxyService`) scoped with `{orgId, workspaceId}` props.
- `DataProxyService` methods (`mssqlQuery`, `postgresQuery`, `mysqlQuery`, `health`) return plain JSON objects (`{ ok, data }` / `{ ok, error }`) rather than `Response`.
- Worker-side JSON parsing enforces a configurable max response body size (`DATA_PROXY_MAX_RESPONSE_BYTES`, default `8 MiB`) to prevent unbounded memory usage.
- `DataProxyService` forwards through the existing `SANDBOX_HOST` VPC binding to workspace-scoped control routes (`/v1/workspaces/{orgId}/{workspaceId}/data-proxy/*`).
- sandbox-host forwards those routes to a dedicated localhost `chiridion-data-proxy` Go process (separate systemd service with tighter resource limits).
- `chiridion-data-proxy` returns JSON responses and streams row serialization internally to avoid materializing full recordsets in sidecar memory.
- Sandbox containers receive `DATA_PROXY_URL` (no token). Requests are authenticated by sandbox-host injected headers (`x-sandbox-secret`, org/workspace/thread IDs), same model used by other container proxy routes.

### OpenAI-Compatible Gateway Proxy
- Sandbox containers call OpenAI-compatible routes at `OPENAI_PROXY_URL` / `OPENAI_BASE_URL` (no real API key required; `OPENAI_API_KEY=proxy`).
- Worker route `/api/openai/v1/*` validates sandbox proxy headers, derives org/workspace/thread identity, and forwards through sandbox-host control route `/v1/workspaces/{orgId}/{workspaceId}/openai-proxy/v1/*`.
- sandbox-host control route forwards to Cloudflare AI Gateway and injects `cf-aig-metadata` with tenant context (`uid`, `chiridion.orgId`, `chiridion.workspaceId`, `chiridion.threadId`) so gateway-side rate limits/spend policies can be scoped per tenant.
- For `/v1/chat/completions`, sandbox-host enforces `model: "dynamic/auto"` to mirror virtual AI binding behavior.

### Virtual AI Binding
- User uploaded workers can declare a native `ai` binding (for example `AI`) and the deploy pipeline rewrites it to an internal service entrypoint (`AIVirtualBinding`) scoped with `{orgId, workspaceId}` props.
- `AIVirtualBinding.run(model, input, options?)` routes through Cloudflare AI Gateway over HTTP (`/compat/chat/completions`) when gateway config is present (`CF_ACCOUNT_ID` + `CF_GATEWAY_NAME` + `CF_GATEWAY_TOKEN`/`AI_GATEWAY_AUTH_TOKEN`).
- Virtual binding model selection is configured by `AI_VIRTUAL_MODEL` (default `dynamic/auto`). Caller-supplied model arguments and top-level `input.model` values are ignored.
- Streaming requests (`stream: true`) are passed through as a streaming response body (SSE) instead of JSON parsing.
- Gateway requests include `cf-aig-metadata` with tenant context (`uid=orgId:workspaceId`, plus structured `chiridion` fields) so gateway-side spend/rate-limit policies can be scoped per tenant.
- If gateway config is absent, `AIVirtualBinding` fails fast (no non-gateway fallback path).

### Slash Commands
Users send Claude SDK slash commands as their entire message. `ChatThreadDO.formatAttributedUserMessage()` strips the author prefix. Supported: `/compact`, `/context`, `/debug`, `/insights`, `/security-review`. Allowlist in `ChatThreadDO.SLASH_COMMANDS` (`workers/main/src/durable-objects.ts`).

### Pending-Message Handoff Pattern
Several features (onboarding first-thread, custom connection "Other") use the same pattern: seed `sessionStorage` key `pendingMessage:newThread` with a `<camelai system message>...</camelai system message>` payload, navigate to `/chat/{threadId}?newThread=1`, and `Chat.tsx` consumes and sends the hidden message.

### Chat Attachment Uploads
Multipart-only R2 uploads via `/api/workspaces/:id/upload` with actions: `mpu-create`, `mpu-uploadpart`, `mpu-complete`, `mpu-abort`.

### Computer Tab File Search
- The file tree API route (`/api/workspaces/:id/fs/list`) supports `recursive` + `includeHidden` query params and returns `relativePath` for entries.
- Recursive list requests are handled in one sandbox-host call (host-side walk) instead of per-directory worker recursion.
- `WorkspaceContainer.listFiles()` keeps a compatibility fallback to legacy per-directory recursion when sandbox-host responses do not include `recursive: true`.

### Todo State Persistence
`control-plane.mjs` emits `todo_state` on `TodoWrite` tool calls. `ChatThreadDO` persists it and replays on WebSocket init. Cleared on turn completion (`result` event).

### Task Notifications
SDK `<task-notification>` user-role payloads are parsed client-side, merged into the nearest assistant message as `task_notification` content blocks, and rendered inline as tool-call rows. If no assistant message exists yet, Chat synthesizes an assistant message so raw XML is never shown.

### MCP Prompt Replay
MCP-driven prompts (connection setup, bug reports) are persisted in `ChatThreadDO` and replayed to newly connected clients. Prompts expire (30m for connections, 5m for bug reports).

### MCP App Logs Tool
The MCP server exposes `get_latest_logs`, which retrieves recent tail-captured runtime logs for a deployed app in the current workspace. It validates script ownership, resolves the dispatch script key (`{script}--{org-slug}`), and reads from `WorkerLogsDO` (with legacy key fallback).

### Integration Token Refresh
OAuth integrations with expiring tokens are refreshed by `WorkspaceDO` alarms. Updated credentials are pushed to both sandbox runtimes and deployed workers.

### Scheduled Prompts (Workspace Cron)
Each workspace has a `WorkspaceCronDO` scheduler that stores cron-style prompt jobs (5-field UTC cron expressions) and triggers them via DO alarms. When a job fires, `WorkspaceCronDO` sends the configured prompt into the target thread through `ChatThreadDO`’s `/external-message` endpoint, so it runs as an automated agent turn. Jobs are managed through MCP tools (`list_scheduled_prompts`, `create_scheduled_prompt`, `update_scheduled_prompt`, `delete_scheduled_prompt`, `run_scheduled_prompt_now`).

### App Previews
Deploy enqueues screenshot job → Browser Rendering → JPEG stored in R2 at `app-previews/{orgId}/{workspaceId}/{scriptName}/current.jpg` → served via `/api/apps/:scriptName/preview`.

### Notebook File Previews
Notebook previews render in the chat preview panel with two modes: **Report** (editorial rendering with TOC, hidden code, styled outputs) and **Notebook** (full cell-by-cell with execution gutters). Supports Vega/Vega-Lite, Plotly, DataFrame tables (inline rendering capped at 100 rows with CSV download), and generic HTML in sandboxed iframes. Chart outputs support fullscreen expansion with viewport-height layout; Plotly fullscreen enables the mode bar for zoom/pan/select/autoscale tools while preserving SVG/PNG/CSV export actions. Report-level PDF export is not supported.
Sandbox notebook execution preloads pandas display defaults through IPython startup (`display.max_rows=200`, `display.max_columns=50`, `display.max_colwidth=1000`, `display.width=None`) so notebook HTML outputs include richer table content without per-notebook `pd.set_option` boilerplate.
Table outputs (notebook DataFrame renders and standalone CSV/TSV previews) also support fullscreen expansion via `TableViewer`: 500-row cap, sortable columns, column resizing, global row filtering, sticky index columns, text-wrap toggle, and full-table CSV export. Report and notebook modes remain width-capped and centered on wide screens (`max-w-5xl` for report, `max-w-[1800px]` for notebook) while remaining full-width on narrow panels. Markdown file previews render inside a centered `max-w-3xl` container with consistent padding. Source-code file previews (`.py`, `.ts`, `.js`, `.go`, `.rs`, `.sql`, etc.) use Shiki highlighting with line numbers and a copy button in an IDE-like full-panel layout; plain text (`.txt`, `.log`) remains a raw `<pre>` preview.

### SDK Event Types
- `system` (subtypes: `init`, `status`, `compact_boundary`) - Session initialization, compaction status transitions, compaction boundary markers
- `stream_event` - Real-time: `content_block_start`, `content_block_delta`, `message_delta`
- `assistant` - Full/partial assistant message
- `user` - Tool results
- `result` - Query complete
- `context_usage_state` - DO-computed per-thread context usage update (`usedPercent`) for live per-call updates plus canonical result-time replay

## API Routes

Routes are defined as React Router routes in `src/routes/api/`. See `src/routes.ts` for the full route configuration.

| Area | Key Routes |
|------|------------|
| Auth | `/api/auth/login`, `/api/auth/signup`, `/api/auth/verify-email`, `/api/auth/verify-email/send`, `/api/auth/logout`, `/api/auth/switch-org`, `/api/auth/switch-workspace` |
| OAuth | `/api/auth/google[/callback]`, `/api/auth/github[/callback]` |
| Slack | `/api/integrations/slack/oauth`, `/api/integrations/slack/callback`, `/api/integrations/slack/events` |
| Orgs | `/api/orgs/:id/invite`, `/api/orgs/:id/check-slug`, `/api/orgs/:id/update-slug` |
| Onboarding | `/api/onboarding/complete` |
| Support | `/api/help` |
| Dev tooling | `/api/dev/sent-emails`, `/api/dev/sent-emails/:id` |
| Admin troubleshooting | `/api/admin/threads/:id/jsonl`, `/api/admin/threads/:id/messages` |
| Admin REST API | `/api/admin/{stats,users,orgs,threads,kv,r2}` (Bearer `ADMIN_API_KEY` auth) |
| Invitations | `/api/invitations/:orgId/:invitationId` (GET/POST) |
| Workspace FS | `/api/workspaces/:id/fs/{list,read,content/*,write,upload,create,mkdir,move,delete}` |
| Workspace chat | `/api/workspaces/:id/chat/:threadId/messages/stream` |
| Workspace files | `/api/workspaces/:id/{upload,download,uploads/*,outputs/*}` |
| Sandbox container proxy APIs | `/api/{mssql,postgres,mysql}/query`, `/api/openai/v1/*` |
| Apps | `/api/apps/:scriptName/preview` |
| WebSocket | `/ws/{workspace}` (chat), `/ws/logs?scriptName={name}` (worker logs) |
| Email | Worker `email()` handler (Cloudflare Email Routing, workspace inbox format `{local-part}+{orgSlug}.{workspaceSlug}@...`) |
| MCP | `/mcp` (streamable HTTP), `/mcp/health` |

## Durable Objects

| DO | Scope | Purpose |
|----|-------|---------|
| `UserDO` | per user | Profile, password, OAuth providers, org memberships, onboarding state |
| `OrgDO` | per org | Members, invitations, threads, worker scripts, integrations, API tokens |
| `OrgSlugDO` | per slug | Atomic slug ownership (`claim`/`getOwner`/`release`) |
| `WorkspaceDO` | per workspace | Metadata, members, integrations, audit logs, token refresh alarms |
| `WorkspaceCronDO` | per workspace | Scheduled prompt definitions, next-run calculation, alarm-based prompt dispatch to chat threads |
| `ChatThreadDO` | per thread | WebSocket state, preview target, todo/prompt persistence |
| `WorkerLogsDO` | per script | Deployed worker logs (up to 10k entries), real-time WebSocket streaming |

Thread records are treated uniformly across web, Slack, and email ingress. History and admin queries do not filter by thread source.

**Workspace Runtime** (per workspace): Docker + gVisor sandbox provisioned eagerly on workspace creation. Workers reach sandbox host via VPC service binding (`env.SANDBOX_HOST`). Runtime startup is on-demand from chat/API paths.

### Storage APIs

Durable Objects use SQLite-backed storage with two APIs:

```typescript
// SQLite for relational data
this.ctx.storage.sql.exec("SELECT * FROM users WHERE org_id = ?", orgId);

// Sync KV for simple key-value (no await needed)
this.ctx.storage.kv.put("config", { theme: "dark" });
const config = this.ctx.storage.kv.get("config");
```

**Important:** Always use the sync KV API (`ctx.storage.kv`). Never use the legacy async API (`await ctx.storage.get/put`).

### Background Tasks

```typescript
import { waitUntil } from 'cloudflare:workers';

waitUntil(
  someAsyncOperation().catch(err => console.error('Background task failed:', err))
);
```

**Important:** Import `waitUntil` directly — don't pass `ctx` through function calls.

## Anti-Patterns

### No Module-Level Mutable State

Never use module-level `Map`, `Set`, or mutable variables to cache instances across requests in Workers code. Cloudflare Workers reuse module-level state across requests within the same isolate, causing stale data bugs.

```typescript
// BAD: shared mutable state across requests
const cache = new Map<string, MyClass>();

// GOOD: fresh instance per request
const instance = new MyClass(id);
```

If you need caching, use `ctx.storage.kv` which is scoped per DO instance.

## Development

### Prerequisites
- Node.js 22+, Bun (always use `bun` instead of `npm`), Go 1.24+ (for sandbox-host), Cloudflare account

### Local Development
```bash
bun run dev          # Full Cloudflare dev (recommended), default port 3001
bun run build        # Production build → build/client/ + build/server/
```

### Environment Variables

Create `.dev.vars`:
```
CF_GATEWAY_TOKEN=your_gateway_token_here
WORKER_BASE_URL=https://your-ngrok-subdomain.ngrok-free.app
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
GITHUB_CLIENT_ID=your_github_client_id
GITHUB_CLIENT_SECRET=your_github_client_secret
```

Other env vars: `INTEGRATION_SECRET_KEY`, `TOKEN_SIGNING_SECRET`, `EMAIL_FROM_ADDRESS`, `RESEND_API_KEY`, `DISPATCHER_MISSING_REGISTRY_MODE`.

Sandbox debug vars (optional): `CHIRIDION_TRACE_EVENTS`, `CHIRIDION_DEBUG_STARTUP`, `CHIRIDION_DEBUG_SDK`, `CHIRIDION_DEBUG_FS`.

### KV Namespaces
`EMAIL_TO_USER` (email→userId), `SESSIONS` (session storage), `API_TOKENS` (API token storage).

### Testing
```bash
bun run test          # Unit tests (Vitest + jsdom)
bun run test:run      # CI mode (run once)
bun run test:all      # Unit + workers tests
bun run test:workers  # Workers runtime tests (Miniflare + DOs)
bun run test:e2e      # E2E tests (Playwright)
```

### Build & Deploy
```bash
bun run build:cf                    # Build for Cloudflare
bun run deploy:main:prod            # Deploy main worker
bun run deploy:main:staging
bun run deploy:dispatcher:prod      # Deploy dispatcher
bun run deploy:tail:prod            # Deploy tail worker (user worker logs)
```

### Admin REST API

Admin endpoints are served by the main worker at `/api/admin/*` and require `ADMIN_API_KEY` Bearer auth (set via `wrangler secret put ADMIN_API_KEY`). Requests without a Bearer token fall through to React Router for session-auth admin routes (e.g. `/api/admin/threads/:id/messages`).

```bash
curl -H "Authorization: Bearer <key>" https://<host>/api/admin/stats
curl -H "Authorization: Bearer <key>" https://<host>/api/admin/users
curl -H "Authorization: Bearer <key>" https://<host>/api/admin/orgs
curl -H "Authorization: Bearer <key>" https://<host>/api/admin/threads
curl -H "Authorization: Bearer <key>" https://<host>/api/admin/kv?prefix=email:
curl -H "Authorization: Bearer <key>" https://<host>/api/admin/r2?prefix=abc
curl -X POST -d '{"user_id":"..."}' -H "Authorization: Bearer <key>" https://<host>/api/admin/orgs/:id/members
curl -X PATCH -d '{"title":"..."}' -H "Authorization: Bearer <key>" https://<host>/api/admin/threads/:id
```

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/stats` | Aggregate counts (user_count, org_count, membership_count) |
| GET | `/users` | All users |
| GET | `/users/:id/orgs` | User's org memberships |
| GET | `/orgs` | All orgs (enriched with members + workspaces) |
| GET | `/threads` | All threads across orgs |
| POST | `/orgs/:id/members` | Add member to org (`{ user_id, role? }`) |
| PATCH | `/threads/:id` | Update thread (`{ title?, created_by? }`) |
| GET | `/kv` | List KV keys (`?prefix=` supported) |
| GET | `/kv/:key` | Get KV value |
| GET | `/r2` | List R2 objects (`?prefix=` supported) |
| GET | `/r2/:key+` | R2 object head metadata |

### Sandbox Host Deployment

The sandbox host runs on an Azure VM (`ssh chiridion-vm`, user `chiridion`, IP `20.46.233.68`). Deploy via rsync + SSH build + systemctl restart. Rebuild Docker image on VM and push to ACR (`crchiridionprod`).

Sandbox names: `chiridion-{workspaceId}`. Host dir: `/srv/sandboxes/{sandboxName}` → container `/home/claude`. Image: Ubuntu 24.04 with bun, node 22, git, rclone, uv. Containers use gVisor (`--runtime=runsc`).

**Network:** Two listeners — `PORT` (80, worker control traffic) and `SANDBOX_PROXY_PORT` (8081, container egress only). VM firewall blocks containers from reaching control port.

**Storage:** Premium SSD v2 managed disk mounted as XFS at `/srv/sandboxes` with `prjquota` enabled. Default sandbox quota is `100g` via XFS project quotas. Docker data-root also lives on the data disk at `/srv/sandboxes/.docker`.

**R2 FUSE mounts:** Set up automatically when env vars are pushed. Uses permanent R2 credentials from sandbox-host env.

### Observability

SSR errors logged to Workers Analytics Engine (`ERROR_ANALYTICS` binding, `chiridion_errors` dataset). Live logs: `npx wrangler tail --env <env>`. Superusers can also inspect recent tail-captured app logs in QAML Backdoor at `/qaml-backdoor/logs`.

## Known Issues

1. **Durable Objects not working locally**: Use `bun run dev` (wrangler-based dev)
2. **Streaming not working**: Ensure `includePartialMessages: true` in `sandbox/control-plane.mjs`
3. **Gateway token not found**: Check `.dev.vars` has `CF_GATEWAY_TOKEN`
4. **Session not persisting**: Check cookies and DO worker is running
5. **Type errors after route changes**: Run `bun run typecheck` to regenerate types
