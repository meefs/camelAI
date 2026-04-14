# camelAI - Agent Documentation

> **Note to agents:** Keep this file up to date. When you add new features, workers, API routes, or make significant architectural changes, update the relevant sections of this document.

## Overview

camelAI is an AI coding assistant built on Cloudflare's edge infrastructure. Users chat with a persistent coding agent workspace that can run either the Claude Agent SDK or Codex app-server depending on thread/provider settings. Users create applications by having the agent write code, then publish them to live `*.camelai.app` URLs. The app supports integrations (connections) to external services.

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
   - Organization settings include an Experimental page; the `codex_gpt_models` org flag controls whether GPT model options appear in Camel chat for new OpenAI-backed threads, while existing GPT threads still render their locked model

2. **Workers** (`workers/`)
   - `main/` - Main camelAI app worker (SSR, Durable Objects, WebSocket routing, OAuth, MCP, admin CLI API)
   - `dispatcher/` - Routes `*.camelai.app` to user workers (Workers for Platforms); auth/error redirects use environment-specific `MAIN_APP_URL`
   - `bedrock-provider/` - Standalone custom-provider worker for AI Gateway that translates Anthropic-style `/v1/messages` requests to Bedrock and converts Bedrock streaming event frames into Anthropic SSE

3. **Sandbox Host** (`services/sandbox-host/`)
   - Go HTTP server managing Docker + gVisor container lifecycle on Azure VM
   - Accessed via Workers VPC binding (Cloudflare Tunnel) — not exposed to public internet
   - Host FS operations on a Premium SSD v2 managed disk mounted as XFS at `/srv/sandboxes`
   - Proxies control plane traffic (health, env, chat WebSocket) to containers

4. **Sandbox** (`sandbox/`)
   - `control-plane.mjs` - In-sandbox control plane server + Claude Agent SDK session runner
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
3. New account creation rejects emails whose domain matches the KV-backed email domain blocklist (managed via admin API). The policy applies to password signups and new OAuth signups, but does not lock out existing accounts if a domain is later added.
4. Password-based signups receive an email verification link (`/api/auth/verify-email`), and onboarding completion is blocked until verified (`/api/auth/verify-email/send` for resend)
5. Email signups are gated by Cloudflare Turnstile before account creation. The public signup page loader passes the site key into the form, the client submits the widget token with the JSON signup payload, and `POST /api/auth/signup` verifies that token against Cloudflare before any user/org/session writes run. The relevant bindings are `TURNSTILE_SITE_KEY` for the widget and `TURNSTILE_SECRET_KEY` for server-side verification.
6. Password and OAuth signup flows extract the client IP from `CF-Connecting-IP` (falling back to `X-Forwarded-For`), reject new account creation when that IP exists in `AdminIndexDO.blocked_signup_ips`, and store the normalized signup IP on newly created `UserDO` records under the sqlite-backed `profile` key `signup_ip`
7. Session stored in KV (`SESSIONS`), cookie set with `httpOnly`, `sameSite: lax`
8. Route loaders call `requireAuthContext()` to validate session and load user/org/workspace data

### OAuth State Storage

Google/GitHub OAuth `state` is stored in an HMAC-signed `chiridion_oauth_state` cookie, not a Durable Object. `workers/main/src/routes/oauth.ts` sets the cookie on `/api/auth/{provider}` and validates it on `/api/auth/{provider}/callback` by checking the signed payload, provider, nonce, and 5-minute expiry. This avoids KV eventual-consistency issues during callback handling without introducing a DO hop.

### Onboarding

Incomplete users are redirected to `/onboarding` before accessing `_app` routes. OAuth signups (non-team) auto-complete onboarding with no UI, then redirect to first chat. Password signups stay on the onboarding welcome screen until email verification is complete, then proceed. Team invitation users see the team welcome screen before proceeding. `POST /api/onboarding/complete` now marks `completed_at`, creates the first thread, and returns a hidden onboarding system message plus redirect target. The client seeds `pendingMessage:newThread` and `showBootModal` in sessionStorage before navigating to `/chat/{threadId}?newThread=1`. Preference capture now happens in-chat through provider-specific question tools: Claude threads use the built-in `AskUserQuestion`, while Codex threads use the custom `ask_user_question` MCP tool.
Sales-site signups preserve `prompt_key` through password-email verification by embedding the normalized key in the signed verification token and restoring it on the `/onboarding?emailVerified=1&prompt_key=...` redirect, so the first seeded chat survives new tabs and login redirects without relying on browser storage.

### Sales Site Prompt Handoff

Prompts started on `camelai.com` arrive at `camelai.dev` as one-time `prompt_key` URL params backed by shared `APP_KV` records under `sales_prompt:{key}` (30-minute TTL, delete-after-read). Returning users land on `/chat?prompt_key=...`, where the welcome-screen loader consumes KV via `src/lib/sales-prompt.server.ts`, pre-fills the composer, and `Chat.tsx` removes the stale key from the URL after hydration. Users who are still gated to onboarding keep the `prompt_key` through `_app` redirects; `POST /api/onboarding/complete` consumes the KV prompt, swaps in a sales-site-specific onboarding system message, returns the normalized `salesPrompt`, and the client seeds `pendingMessage:newThread` with both the hidden system context and the user's original prompt so their first chat auto-starts. When that onboarding path is used, the route also triggers background thread-title generation from the sales prompt so the first thread does not keep the placeholder title.

### Legacy User Transition Banner

After `_app.tsx` passes the auth/onboarding gates, the layout loader checks `APP_KV` for `legacy_user:{normalized_email}` and `legacy_banner_dismissed:{userId}`. Matching users who have not dismissed the notice see `LegacyUserBanner`, a fixed bottom-right collapsible card that explains the `camelai.dev` transition and links them back to `https://app.camelai.com`. In local development (`NEXTJS_ENV=development`), the loader bypasses the legacy-email lookup and treats the current user as legacy so the banner is testable without seeding Miniflare KV. The collapsed-card `X` only snoozes the banner client-side for one hour via `localStorage` (`legacy_banner_snoozed_until`), while the expanded "Got it, don't show again" CTA is the permanent dismiss path and persists `legacy_banner_dismissed:{userId}` through `POST /api/legacy-banner/dismiss`. The banner header uses an animated waving emoji (`👋`) defined in `src/styles/globals.css`. The legacy-email set is seeded out-of-band with `scripts/import-legacy-emails.ts`, which bulk-imports the CSV into `APP_KV` as `legacy_user:{normalized_email}` keys and appends the founder addresses.

### Ban List + Blocked Page

Spam/fraud moderation now uses durable ban tombstones in `APP_KV` that survive user/org deletion:

- user bans: `ban:user:id:{userId}` and `ban:user:email:{normalizedEmail}`
- org bans: `ban:org:id:{orgId}` and `ban:org:slug:{slug}`
- purge jobs: `ban_purge_job:{jobId}`

Ban enforcement happens before session re-use in both React Router auth (`src/lib/auth.server.ts`) and worker-side session helpers (`workers/main/src/helpers/auth.ts`). Password login/signup checks banned emails before creating a session or account, OAuth checks the normalized email before `getOrCreateUserFromOAuth()`, and stale signed sessions redirect to `/banned` with the session cookie cleared. `WorkspaceContainer` also checks org ban state before sandbox-host requests so banned orgs cannot recreate containers.

### Ban + Purge Operations

Superusers can start ban-and-purge flows from qaml-backdoor user/org detail pages, and Bearer-authenticated admin API clients can do the same via `POST /api/admin/users/:id/ban` and `POST /api/admin/orgs/:id/ban`. Starting a ban writes the tombstone first, invalidates active sessions, creates a `ban_purge_job`, and then runs destructive cleanup in the background. Org purge reuses `hardDeleteAdminOrg*` and now also calls sandbox-host workspace deletion so containers and host workspace directories are removed before the WorkspaceDO is wiped. User ban reuses `hardDeleteAdminUser*` and cascades org ban+purge for orgs the user still owns.

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
3. `control-plane.mjs` selects the thread harness: Claude threads use Claude SDK `query()`, while Codex threads run a warm per-thread `codex app-server` over stdio against the sandbox OpenAI proxy
4. On reconnects, `ChatThreadDO` sends `lastSeq`, replays missed events, dedupes, resumes streaming
5. Browser user messages are author-attributed inside `ChatThreadDO` by serializing each WebSocket's `{ userId, userName, userEmail }` as a socket attachment on upgrade and reading that attachment when the socket sends `type: "message"`. This keeps multiplayer threads from reusing a thread-global author identity across collaborators.
6. Threads persist their harness on the org `threads` table (`provider = claude|codex`), and new web threads default to `codex` when the org AI provider is set to OpenAI
7. Claude SDK still stores messages in JSONL at `/home/claude/.claude/projects/-home-claude/{threadId}.jsonl`. `ChatThreadDO` does not persist full transcript snapshots; message history reloads go through sandbox-host storage.
8. `Chat.tsx` discloses compaction progress in-flight: `CompactingIndicator` turns on for manual `/compact` and auto-compaction (`system/status` with `status: "compacting"`, plus `stream_event/content_block_start(type=compaction)` fallback) and clears on summary capture, `status: null`, turn `result`/`error`, reconnect reset, or reconnect-exhausted close.
9. `ChatThreadDO` computes context usage from `stream_event.message_start` usage and now broadcasts live `context_usage_state` updates during a turn when a model-scoped `contextWindow` cache is available (`chatContextWindowByModel`, persisted in DO KV). On `result`, it computes and persists the canonical value (`chatContextUsedPercent`) and replays `transientContextUsedPercent ?? contextUsedPercent` on chat init so reconnects can resume from the freshest value. The composer `ContextIndicator` (left toolbar, after Mic) appears when usage is `>= 50%`, shows `"XX% used"`, and can trigger `/compact` without mutating unsent draft text.
10. Pending clarifying-question widgets are keyboard-first: the card auto-focuses on arrival, supports `1`-`9`/`0` option shortcuts, `↑`/`↓` focus movement, `Space` toggle, `Enter` next/submit, `Escape` blur-or-collapse, and returns focus to the composer after submission.
11. Chat composer drafts are stored client-side in `localStorage` under `draft:{workspaceId}:{threadId|new}`. Thread chats and the welcome screen keep separate text + completed-attachment drafts, flush pending debounced saves on unmount/navigation, preserve a backup across optimistic clears while delivery is in flight, and clear that backup only after a confirmed success path (`result` for thread sends, thread creation handoff plus first-turn result for new chats).
12. Threads created from hidden system-seeded handoff flows can start with a fallback title (for example app chats use `Working on <app>`). `ChatThreadDO` upgrades both the thread title and `first_user_message` when the first non-system, non-slash user message arrives.
13. Claude threads keep the built-in `AskUserQuestion` flow via the SDK `canUseTool` hook. Codex threads expose a command-based `ask_user_question` MCP server in the generated Codex `config.toml`, and that server calls back into `sandbox/control-plane.mjs` over localhost to mirror pending questions to browser chats and wait for the answer. The Codex tool result returns JSON answers.
14. `ChatThreadDO` scans browser and external turns for canonical `(user uploaded file to /mnt/user-uploads/...)` references, raw `/mnt/user-uploads/...` path mentions, and suspicious upload/deploy/bridge workflow cues (for example uploaded archives plus extract/deploy/init/WebSocket relay instructions), then prepends a hidden file-safety `<camelai system message>` before author attribution when anything looks unsafe.
15. Stored-name overrides treat `Dockerfile*`, `docker-compose*`, `compose*`, `Makefile*`, and `.env*` as unsafe even when the extension itself is in the safe allowlist. This currently affects web chat and email ingress; Slack is unchanged until it starts appending upload refs.
16. `sandbox/control-plane.mjs` appends a standing `<prohibited_activities>` section to the agent system prompt requiring hard refusals for reverse proxies/tunnels, relay or forwarding use, non-Cloudflare-Worker deployments, crypto mining, and malware or exploit work.
17. Browser chat tracks a per-user `localStorage` message counter and shows a one-time `FreeTierModal` on the third authored send; if the user navigates before dismissing it, the modal reopens anywhere the count is already `>= 3` until they acknowledge it.

### Agent Teams Polling

- `sandbox/team-poll-controller.mjs` owns TeamCreate tracking and teammate inbox polling for a thread; `control-plane.mjs` delegates SDK events/results to this controller.
- The controller stores canonical owned-team names per thread in `~/.claude/projects/<projectPath>/<threadId>.team-poll-state.json`.
- Teammate inbox polling only considers teams owned by the current thread and skips entries already marked `read` or previously consumed (persisted per team), preventing duplicate teammate message injection after control-plane restarts.

### Thread Message History Retrieval

`getMessages()` no longer parses JSONL in the Worker runtime and no longer reads transcript snapshots from `ChatThreadDO`. Message history is loaded from sandbox-host `GET /v1/workspaces/{orgId}/{workspaceId}/chat/messages?threadId={threadId}`. The host first parses Claude JSONL from the workspace; legacy Claude threads created before thread IDs were forced into the Claude SDK can pass the old stored `claude_session_id` as `claudeSessionId`. For Codex threads, the host starts `codex app-server` against the per-Camel-thread `CODEX_HOME`, resolves the Codex app-server thread id via `codexSessionId` or `thread/list`, calls `thread/read` with `includeTurns`, and maps returned turns/items into the shared chat message JSON shape. For large histories, the app can request `GET /api/workspaces/:id/chat/:threadId/messages/stream`, and the Worker streams the sandbox-host JSON response body through.

### QAML Backdoor Read-Only Thread View

Superusers can open `/chat/:threadId?adminReadonly=1` from qaml-backdoor thread list/detail via **View as User** (opens in a new tab). Read-only mode:

- loads messages from `GET /api/admin/threads/:id/messages` (which proxies sandbox-host parsed JSONL response and now supports either Bearer `ADMIN_API_KEY` auth or superuser session auth)
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
6. Clarifying-question tools (`AskUserQuestion` for Claude, `ask_user_question` for Codex) are interactive only when a browser chat websocket is connected for the thread; without a browser session, `ChatThreadDO` auto-answers unavailable to the model
7. Slack replies receive final assistant output, busy, or error text
8. Slack ingress no longer applies an app-level external-turn timeout; turns wait for model completion with a 30-minute safety fallback

### Email Chat Ingress

1. Cloudflare Email Routing delivers inbound messages to Worker `email()` (non-HTTP handler)
2. A single registered inbox local-part is used (for example `chat@<domain>`), and workspace addresses are subaddressed as `{local-part}+{orgSlug}.{workspaceSlug}@<domain>` (e.g., `chat+acme-corp-85b.default-workspace@camelai.dev`)
3. Sender is authorized by email (`EMAIL_TO_USER` lookup) plus workspace access check (org member + workspace access not `none`)
4. Follow-ups are routed to existing threads using email reply headers (`In-Reply-To` / `References`) mapped in KV (`email_reply_ref:*`)
5. MIME attachments are uploaded to workspace-scoped R2 keys under `user-uploads/` and appended to the inbound turn as `(user uploaded file to /mnt/user-uploads/<filename>)` lines (same format as web chat uploads)
6. `ChatThreadDO` ingests email turns through `externalMessage(...)` Durable Object RPC
7. Clarifying-question tools follow the same browser-presence rule as Slack/web: interactive only when a browser chat websocket is connected; otherwise the model gets an unavailable response
8. Replies are sent from workspace-scoped subaddresses (`{local-part}+{orgSlug}.{workspaceSlug}@<domain>`) with explicit `Message-ID` so clients include references on subsequent replies, and outbound bodies are sent as `multipart/alternative` (`text/plain` + markdown-rendered `text/html`)
9. Email ingress no longer applies an app-level external-turn timeout; turns wait for model completion with a 30-minute safety fallback

### Sandbox Proxy Auth

- Container egress calls go through sandbox-host `/proxy/:threadId/*`.
- Sandbox-host injects `x-sandbox-secret`, `x-chiridion-org-id`, `x-chiridion-workspace-id`, and `x-chiridion-thread-id` on upstream worker requests.
- `claude-proxy` (`/api/claude/v1/messages` and `/api/claude/v1/messages/count_tokens`) and OpenAI proxy (`/api/openai/v1/*`) accept only sandbox-host injected auth (no signed-token fallback path).
- Org BYOK credentials stay off the container env and are attached to the chat websocket upgrade as thread-scoped sandbox-host headers. Anthropic/Bedrock keys are used for Claude threads; OpenAI keys are used for Codex threads.
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
- When a chat websocket registered a thread-scoped OpenAI BYOK key, sandbox-host bypasses AI Gateway for that thread and forwards `/api/openai/v1/*` directly to `https://api.openai.com/v1/*` with the real key.
- sandbox-host control route forwards to Cloudflare AI Gateway and injects `cf-aig-metadata` with tenant context (`uid`, `chiridion.orgId`, `chiridion.workspaceId`, `chiridion.threadId`) so gateway-side rate limits/spend policies can be scoped per tenant.
- For `/v1/chat/completions`, sandbox-host enforces `model: "dynamic/auto"` to mirror virtual AI binding behavior.
- sandbox-host records OpenAI usage and spend for both direct BYOK and AI Gateway proxy traffic by parsing response usage fields from non-streaming JSON bodies and streamed Responses API `response.completed` events, then pricing cached vs uncached input locally.

### Anthropic Gateway Bedrock Fallback

- Anthropic Claude proxy traffic (`/api/claude/v1/messages`) goes through AI Gateway provider-specific routes with the Bedrock custom provider first and Anthropic second as fallback.
- Bedrock primary routing is implemented as a Gateway custom provider named `custom-bedrock-provider`, backed by the standalone worker in `workers/bedrock-provider/`.
- The custom worker receives Anthropic-style `/v1/messages` payloads, rewrites them for Bedrock runtime, forwards the Gateway-managed `Authorization` header to Bedrock, and converts Bedrock eventstream frames (`{"bytes":"<base64>"}`) into Anthropic SSE before returning them to Gateway.
- sandbox-host no longer performs Bedrock stream decoding or universal-endpoint provider wrapping for Claude traffic; it now does a dumb raw-body fallback from `custom-bedrock-provider` to `anthropic` on non-`2xx` responses.

### Org BYOK Claude Model Selection

- The web chat control plane now defaults Claude Agent SDK sessions to `sonnet` and does not configure a fallback model.
- Org-scoped BYOK provider config (`llm_provider_config`) stores only provider-specific settings (`aws_region` for Bedrock) plus encrypted credentials. It does not store the Claude model.
- Claude model selection (`sonnet` or `opus`) is stored per thread on the org `threads` record. The web chat welcome/composer UI can set it, qaml-backdoor thread detail can edit it, and the admin thread API exposes it on `PATCH /api/admin/threads/:id`.
- Organization Settings → `AI Provider` is written for non-technical users: provider choice renders as plain radio rows, the header explains that BYOK removes limits with zero camelAI markup, and each provider has a collapsible step-by-step key generation guide with inline outbound console links.
- Saving or deleting the org BYOK config now calls `OrgDO.notifyByokChanged()` for the matching recently active thread harnesses (`claude`, `codex`, or both when switching provider families); any live runner websocket closes with code `4001`, immediately clears transient streaming state, and reconnects with fresh sandbox-host BYOK headers so affected chats pick up the new key without a manual refresh.

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

The shared `PromptInput` composer accepts attachment-only sends (completed uploads enable Enter/Send even with empty text) and auto-converts pasted plain text longer than 8,000 characters into a `pasted-text.txt` upload so large pastes flow through the existing attachment pipeline instead of raw message text.

### Computer Tab File Search

- The file tree API route (`/api/workspaces/:id/fs/list`) supports `recursive` + `includeHidden` query params and returns `relativePath` for entries.
- Recursive list requests are handled in one sandbox-host call (host-side walk) instead of per-directory worker recursion.
- `WorkspaceContainer.listFiles()` keeps a compatibility fallback to legacy per-directory recursion when sandbox-host responses do not include `recursive: true`.

### Computer Tab File Mutations

- During beta, user-initiated Computer Tab writes are hard-blocked server-side via `blockBetaFileEdit()` in `src/routes/api/workspaces.utils.ts`.
- The block covers `/api/workspaces/:id/fs/write`, `/fs/create`, `/fs/mkdir`, `/fs/upload`, `/fs/move`, `/fs/delete`, `PUT /api/ext/files/write`, and `POST /api/ext/files/upload`.
- Computer Tab remains readable and downloadable, but the UI is forced read-only with beta messaging. Agent-initiated sandbox writes and chat attachment uploads remain enabled.

### Todo State Persistence

`control-plane.mjs` emits `todo_state` on `TodoWrite` tool calls. `ChatThreadDO` persists it and replays on WebSocket init. Cleared on turn completion (`result` event).

### Task Notifications

SDK `<task-notification>` user-role payloads are parsed client-side, merged into the nearest assistant message as `task_notification` content blocks, and rendered inline as tool-call rows. If no assistant message exists yet, Chat synthesizes an assistant message so raw XML is never shown.

### MCP Prompt Replay

MCP-driven prompts (connection setup, bug reports) are persisted in `ChatThreadDO` and replayed to newly connected clients. Prompts expire (30m for connections, 5m for bug reports).

### MCP App Logs Tool

The MCP server exposes `get_latest_logs`, which retrieves recent tail-captured runtime logs for a deployed app in the current workspace. It validates script ownership, resolves the dispatch script key (`{script}--{org-slug}`), and reads from `WorkerLogsDO`, which persists per-script logs in Durable Object SQLite storage. To protect the app from log floods, `WorkerLogsDO` also rate-limits writes per script and drops excess log events when a worker is emitting logs too quickly, inserting a warning log when sampling activates.

### External MCP Server

An OAuth 2.1-authenticated MCP server for external clients (Claude.ai, ChatGPT, etc.) at `/api/mcp/external`. Exposes workspace tools: `bash`, `list_apps`, `list_files`, `read_file`, `write_file`.

**OAuth Flow:**

1. Client discovers metadata via `GET /.well-known/oauth-authorization-server/api/mcp/external`
2. Client registers dynamically via `POST /api/mcp/external/register` (RFC 7591)
3. Authorization code flow with PKCE (`GET/POST /api/mcp/external/authorize`) — user selects workspace via consent page
4. Token exchange via `POST /api/mcp/external/token` (1h access, 30d refresh)
5. MCP protocol traffic uses `Bearer` token auth

**Key files:**

- `workers/main/src/external-mcp-handler.ts` — `ExternalMcpDO` (tools)
- `workers/main/src/external-mcp-oauth.ts` — OAuth provider (KV-backed)
- `workers/main/src/routes/external-mcp.ts` — Route handler + consent page

**OAuth state in KV (APP_KV):** `mcp_client:*`, `mcp_authcode:*` (5m TTL), `mcp_token:*` (1h TTL), `mcp_refresh:*` (30d TTL).

### Integration Token Refresh

OAuth integrations with expiring tokens are refreshed by `WorkspaceDO` alarms. Updated credentials are pushed to both sandbox runtimes and deployed workers.

### Scheduled Prompts (Workspace Cron)

Each workspace has a `WorkspaceCronDO` scheduler that stores cron-style prompt jobs (5-field UTC cron expressions) and triggers them via DO alarms. When a job fires, `WorkspaceCronDO` sends the configured prompt into the target thread through `ChatThreadDO`’s `/external-message` endpoint, so it runs as an automated agent turn. Jobs are managed through MCP tools (`list_scheduled_prompts`, `create_scheduled_prompt`, `update_scheduled_prompt`, `delete_scheduled_prompt`, `run_scheduled_prompt_now`).

### App Previews

Deploy enqueues screenshot job → Browser Rendering → JPEG stored in R2 at `app-previews/{orgId}/{workspaceId}/{scriptName}/current.jpg` → served via `/api/apps/:scriptName/preview`.

### Custom Domains

- Org custom domains are wildcard-style base domains stored at the org level (for example `apps.example.com`). New org-level records start at `status: pending`, while each deployed app tracks its own Cloudflare custom hostname lifecycle in `worker_scripts` (`custom_domain_hostname`, Cloudflare hostname id, hostname status, SSL status, error, updated timestamp).
- Cloudflare for SaaS uses a Worker-backed fallback origin in the camelAI zone. Customer-facing DNS should point at the configured SaaS DNS target (when present) and otherwise fall back to the Worker-backed fallback hostname. Normal app hostname creation relies on the zone fallback origin; `custom_origin_server` should only be used for true per-host origin overrides.
- Deployed apps only switch to `https://{script}.{orgCustomDomain}` after the per-app hostname matches the current org domain and both Cloudflare hostname status and SSL status are `active`; until then, UI, MCP, and external API responses keep returning the standard `*.camelai.app` / `*.apps.camelai.dev` URLs.
- Setting or changing `/api/orgs/:id/custom-domain` clears stored per-app hostname state, backfills Cloudflare custom hostnames for existing apps, and cleans up old-domain hostnames by exact base-domain match rather than broad substring search.
- App lists lazily refresh stale non-active hostname state from Cloudflare so domains can become ready without a dedicated polling worker.
- The dispatcher uses `MAIN_APP_URL` to choose the correct environment-specific app origin for auth redirects on custom domains; this avoids non-prod custom domains falling back to production `https://camelai.dev`.

### Notebook File Previews

Notebook previews render in the chat preview panel with two modes: **Report** (editorial rendering with TOC, hidden code, styled outputs) and **Notebook** (full cell-by-cell with execution gutters). Supports Vega/Vega-Lite, Plotly, DataFrame tables (inline rendering capped at 100 rows with CSV download), and generic HTML in sandboxed iframes. Chart outputs support fullscreen expansion with viewport-height layout; Plotly fullscreen enables the mode bar for zoom/pan/select/autoscale tools while preserving SVG/PNG/CSV export actions. The chat preview toolbar includes a notebook-only download menu with raw `.ipynb` download plus **Download report as PDF**, which exports the light-themed Report mode presentation through a client-side React PDF pipeline. Standalone published notebook pages do not expose the PDF export control yet.
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

| Area                         | Key Routes                                                                                                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Auth                         | `/api/auth/login`, `/api/auth/signup`, `/api/auth/verify-email`, `/api/auth/verify-email/send`, `/api/auth/logout`, `/api/auth/switch-org`, `/api/auth/switch-workspace` |
| OAuth                        | `/api/auth/google[/callback]`, `/api/auth/github[/callback]`                                                                                                             |
| Slack                        | `/api/integrations/slack/oauth`, `/api/integrations/slack/callback`, `/api/integrations/slack/events`                                                                    |
| Orgs                         | `/api/orgs/:id/invite`, `/api/orgs/:id/check-slug`, `/api/orgs/:id/update-slug`, `/api/orgs/:id/custom-domain`                                                         |
| Onboarding                   | `/api/onboarding/complete`                                                                                                                                               |
| Legacy transition            | `/api/legacy-banner/dismiss`                                                                                                                                            |
| Support                      | `/api/help`                                                                                                                                                              |
| Dev tooling                  | `/api/dev/sent-emails`, `/api/dev/sent-emails/:id`                                                                                                                       |
| Admin troubleshooting        | `/api/admin/threads/:id/jsonl`, `/api/admin/threads/:id/messages` (`messages` also supports Bearer `ADMIN_API_KEY`; `jsonl` remains session-auth only)                 |
| Admin REST API               | `/api/admin/{stats,users,orgs,threads,kv,r2,bans}`, `GET /api/admin/{spam/org-ids,dashboard/top-orgs,dashboard/daily-spend,dashboard/summary,dashboard/retention,dashboard/spam-summary}`, `GET /api/admin/threads/:id/messages`, `POST /api/admin/{users/:id/ban,orgs/:id/ban}`, and `PUT/DELETE /api/admin/signup-blocked-ips/:ip` (Bearer `ADMIN_API_KEY` auth) |
| Invitations                  | `/api/invitations/:orgId/:invitationId` (GET/POST)                                                                                                                       |
| Workspace FS                 | `/api/workspaces/:id/fs/{list,read,content/*,write,upload,create,mkdir,move,delete}`                                                                                     |
| Workspace chat               | `/api/workspaces/:id/chat/:threadId/messages/stream`                                                                                                                     |
| Workspace files              | `/api/workspaces/:id/{upload,download,uploads/*,outputs/*}`                                                                                                              |
| Sandbox container proxy APIs | `/api/{mssql,postgres,mysql}/query`, `/api/openai/v1/*`                                                                                                                  |
| Apps                         | `/api/apps/:scriptName/preview`                                                                                                                                          |
| WebSocket                    | `/ws/{workspace}` (chat), `/ws/logs?scriptName={name}` (worker logs)                                                                                                     |
| Email                        | Worker `email()` handler (Cloudflare Email Routing, workspace inbox format `{local-part}+{orgSlug}.{workspaceSlug}@...`)                                                 |
| MCP (internal)               | `/mcp` (streamable HTTP), `/mcp/health`                                                                                                                                  |
| MCP (external)               | `/api/mcp/external` (OAuth, streamable HTTP), `/api/mcp/external/{authorize,token,register,revoke,health}`                                                               |

## Durable Objects

| DO                | Scope         | Purpose                                                                                         |
| ----------------- | ------------- | ----------------------------------------------------------------------------------------------- |
| `UserDO`          | per user      | Profile, password, OAuth providers, org memberships, onboarding state                           |
| `OrgDO`           | per org       | Members, invitations, threads, worker scripts, integrations, API tokens                         |
| `OrgSlugDO`       | per slug      | Atomic slug ownership (`claim`/`getOwner`/`release`)                                            |
| `WorkspaceDO`     | per workspace | Metadata, members, integrations, audit logs, token refresh alarms                               |
| `WorkspaceCronDO` | per workspace | Scheduled prompt definitions, next-run calculation, alarm-based prompt dispatch to chat threads |
| `ChatThreadDO`    | per thread    | WebSocket state, preview target, todo/prompt persistence                                        |
| `WorkerLogsDO`    | per script    | Persisted deployed worker logs (up to 10k entries), real-time WebSocket streaming               |
| `ExternalMcpDO`   | per connection| External MCP server for OAuth-authenticated clients (bash, files, apps)                         |

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
import { waitUntil } from "cloudflare:workers";

waitUntil(
  someAsyncOperation().catch((err) =>
    console.error("Background task failed:", err),
  ),
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

Admin endpoints are served by the main worker at `/api/admin/*` and require `ADMIN_API_KEY` Bearer auth (set via `wrangler secret put ADMIN_API_KEY`). `GET /api/admin/threads/:id/messages` now supports both Bearer auth and superuser session auth. Requests without a Bearer token still fall through to React Router for remaining session-auth admin routes such as `/api/admin/threads/:id/jsonl`.

Metrics-specific admin behavior:

- `GET /api/admin/spam/org-ids` returns the current spam-org set derived from effective spend limits.
- `GET /api/admin/orgs` now supports additive query params `exclude_spam`, `exclude_internal_domains`, `include_usage`, and `include_spend_30d`; slug search is supported alongside name search.
- `GET /api/admin/dashboard/top-orgs` returns server-ranked org rows with usage rollups and effective spend windows.
- `GET /api/admin/dashboard/daily-spend` aggregates one UTC calendar day of cross-org usage into totals, spam/non-spam splits, previous-day comparison, hourly buckets, model spend, and top-org spend rows. It includes internal `@camelai.com` orgs so the daily totals account for all spend, accepts `date` plus `top_orgs_limit` (max 50), and derives `billing_plan` from the current org `billing_status` (`paying` -> `pro`, otherwise `free`) because admin index rows do not track a richer plan enum yet.
- `GET /api/admin/dashboard/summary` now computes the home-tab payload inside `AdminIndexDO`, including filtered KPIs, 30-day daily/weekly series, growth thresholds, selected-day drill-downs, billing/app visibility breakdowns, and a 7-day retention snapshot.
- `GET /api/admin/dashboard/retention` now computes the retention-tab payload inside `AdminIndexDO`, including Monday-start signup cohorts, retention milestones, WAU series, stickiness, and retention KPIs.
- `GET /api/admin/dashboard/spam-summary` returns the spam-tab entity snapshot plus usage analytics for the resolved spam-org set.

```bash
curl -H "Authorization: Bearer <key>" https://<host>/api/admin/stats
curl -H "Authorization: Bearer <key>" https://<host>/api/admin/users
curl -H "Authorization: Bearer <key>" https://<host>/api/admin/orgs
curl -H "Authorization: Bearer <key>" https://<host>/api/admin/spam/org-ids
curl -H "Authorization: Bearer <key>" https://<host>/api/admin/dashboard/top-orgs
curl -H "Authorization: Bearer <key>" "https://<host>/api/admin/dashboard/daily-spend?date=2026-04-04&top_orgs_limit=20"
curl -H "Authorization: Bearer <key>" https://<host>/api/admin/threads
curl -H "Authorization: Bearer <key>" https://<host>/api/admin/threads/:id/messages
curl -H "Authorization: Bearer <key>" https://<host>/api/admin/kv?prefix=email:
curl -H "Authorization: Bearer <key>" https://<host>/api/admin/r2?prefix=abc
curl -X POST -d '{"user_id":"..."}' -H "Authorization: Bearer <key>" https://<host>/api/admin/orgs/:id/members
curl -X PATCH -d '{"title":"..."}' -H "Authorization: Bearer <key>" https://<host>/api/admin/threads/:id
```

| Method | Endpoint            | Purpose                                                    |
| ------ | ------------------- | ---------------------------------------------------------- |
| GET    | `/stats`            | Aggregate counts (user_count, org_count, membership_count) |
| GET    | `/users`            | All users                                                  |
| GET    | `/users/:id/orgs`   | User's org memberships                                     |
| GET    | `/spam/org-ids`     | Spam org IDs derived from effective spend limits           |
| GET    | `/orgs`             | All orgs (filters + optional usage enrichment)             |
| GET    | `/dashboard/top-orgs` | Top orgs by spend or member count                        |
| GET    | `/dashboard/daily-spend` | One-day spend totals, hourly/model breakdowns, and top orgs |
| GET    | `/dashboard/summary` | Summary KPIs, series, drill-downs, and retention snapshot |
| GET    | `/dashboard/retention` | Cohorts, retention curve, WAU, stickiness, and KPIs    |
| GET    | `/dashboard/spam-summary` | Spam-tab entity snapshot plus usage analytics      |
| GET    | `/threads`          | All threads across orgs                                    |
| POST   | `/orgs/:id/members` | Add member to org (`{ user_id, role? }`)                   |
| PATCH  | `/threads/:id`      | Update thread (`{ title?, created_by?, model? }`)          |
| GET    | `/kv`               | List KV keys (`?prefix=` supported)                        |
| GET    | `/kv/:key`          | Get KV value                                               |
| GET    | `/email-domain-blocklist` | Get KV-backed email domain blocklist                  |
| PUT    | `/email-domain-blocklist` | Replace full email domain blocklist (`{ domains[] }`) |
| POST   | `/email-domain-blocklist` | Add domain to blocklist (`{ domain }`)                |
| DELETE | `/email-domain-blocklist/:domain` | Remove domain from blocklist                  |
| GET    | `/bans`             | List active bans (`?scope=&limit=&cursor=`)                |
| GET    | `/bans/:scope/:id`  | Get ban by scope + target id                               |
| POST   | `/users/:id/ban`    | Ban user and purge data (`{ reason }`)                     |
| POST   | `/orgs/:id/ban`     | Ban org and purge data (`{ reason }`)                      |
| GET    | `/r2`               | List R2 objects (`?prefix=` supported)                     |
| GET    | `/r2/:key+`         | R2 object head metadata                                    |
| GET    | `/orgs/:id/usage/spend` | Org spend totals and rolling window status              |
| GET    | `/orgs/:id/usage/limits` | Org effective spend limits                             |
| PUT    | `/orgs/:id/usage/limits` | Set org spend limit overrides                          |
| GET    | `/orgs/:id/usage/log` | Paginated usage log (`?limit=&cursor=&from=&to=`)        |
| GET    | `/orgs/:id/usage/log/sum` | Sum spend between dates (`?from=&to=`, ms timestamps) |

### Sandbox Host Deployment

The sandbox host runs on an Azure VM (`ssh chiridion-vm`, user `chiridion`, IP `20.46.233.68`). Deploy via rsync + SSH build + systemctl restart. Rebuild Docker image on VM and push to ACR (`crchiridionprod`).

Sandbox names: `chiridion-{workspaceId}`. Host dir: `/srv/sandboxes/{sandboxName}` → container `/home/claude`. Image: Ubuntu 24.04 with bun, node 22, git, rclone, uv. Containers use gVisor (`--runtime=runsc`) and start under `tini` as PID 1 so subprocess-heavy tools like Chromium/Playwright are reaped correctly.

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
