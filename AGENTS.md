# Chiridion App - Agent Documentation

> **Note to agents:** Keep this file up to date. When you add new features, workers, API routes, or make significant architectural changes, update the relevant sections of this document.

## Overview

Chiridion is an AI coding assistant built on Cloudflare's edge infrastructure. Users chat with a Claude-powered agent that has a persistent workspace where files survive across sessions. Users create applications by having the agent write code, then publish them to live `*.chiridion.app` URLs. The app supports integrations (connections) to external services.

## Architecture

```
┌─────────────────┐     ┌──────────────────────┐  VPC Tunnel  ┌──────────────────────┐
│  React Router   │────▶│   Cloudflare Worker  │─────────────▶│   Sandbox Host       │
│   (SSR + WS)    │◀────│   (Durable Objects)  │◀─────────────│  (Docker + gVisor)   │
└─────────────────┘     └──────────────────────┘              └──────────────────────┘
         │                        │                                      │
         │                        ▼                                      ▼
         │              ┌──────────────────┐                   ┌─────────────────┐
         │              │  Dispatcher WfP  │                   │  NVMe RAID0     │
         │              │ (User App Hosts) │                   │  + Azure NFS    │
         │              └──────────────────┘                   │  (Persistent FS) │
         │                        │                            └─────────────────┘
         ▼                        ▼
┌─────────────────┐     ┌──────────────────┐
│   R2 Storage    │     │    OpenRouter    │
│  (Files/Assets) │     │   (LLM Access)   │
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
   - `main/` - Main Chiridion app worker (SSR, Durable Objects, WebSocket routing, OAuth, MCP)
   - `dispatcher/` - Routes `*.chiridion.app` to user workers (Workers for Platforms)
   - `admin-cli/` - Local-only admin CLI for querying live environments

3. **Sandbox Host** (`services/sandbox-host/`)
   - Go HTTP server managing Docker + gVisor container lifecycle on Azure VM
   - Accessed via Workers VPC binding (Cloudflare Tunnel) — not exposed to public internet
   - Host FS operations on NVMe RAID0 + Azure Blob NFS v3 overlayfs
   - Proxies control plane traffic (health, env, chat WebSocket) to containers

4. **Sandbox** (`sandbox/`)
   - `control-plane.mjs` - In-sandbox control plane server + Claude Agent SDK session runner
   - `memory-logger.mjs` - Runner helper for loading user profile context
   - `session-search/` - Session search CLI/daemon used inside workspaces
   - `skills/` - Agent skills (data-analysis, developing-software, file-sharing, testing-debugging)

## UI Components (shadcn/ui)

This project uses [shadcn/ui](https://ui.shadcn.com). **When doing ANY UI work, the `shadcn-components` skill will auto-activate.**

- **Style:** radix-mira, zinc, Inter font, 0.5rem radius, Lucide icons
- **Install:** `npx shadcn@latest add <component>`
- **Styling:** Use `cn()` from `@/lib/utils`, theme vars in `globals.css`
- **Catalog:** `docs/shadcn-components.md` has the full component list by category
- **Installed components:** `src/components/ui/`

## Data Flow

### Authentication
1. User signs up/logs in via `/api/auth/login` or `/api/auth/signup`
2. Password verified with PBKDF2 (100k iterations, SHA-256)
3. Session stored in KV (`SESSIONS`), cookie set with `httpOnly`, `sameSite: lax`
4. Route loaders call `requireAuthContext()` to validate session and load user/org/workspace data

### Onboarding
Incomplete users are redirected to `/onboarding` before accessing `_app` routes. Steps stored in localStorage during the flow, persisted to `UserDO` via `POST /api/onboarding`, finalized via `POST /api/onboarding/complete` (creates first thread, writes `~/.chiridion/profile.md`, returns redirect). Org slug step is conditional and enforced by `OrgSlugDO`.

### Message Sending
1. WebSocket connects to `/ws/{workspace}` → Worker validates access → forwards to `ChatThreadDO`
2. `ChatThreadDO` opens WebSocket to sandbox `control-plane.mjs`
3. `control-plane.mjs` calls Claude SDK `query()` and streams events back with monotonic `seq` numbers
4. On reconnects, `ChatThreadDO` sends `lastSeq`, replays missed events, dedupes, resumes streaming
5. Claude SDK stores messages in JSONL at `/home/claude/.claude/projects/-home-claude/{threadId}.jsonl`

### Slash Commands
Users send Claude SDK slash commands as their entire message. `ChatThreadDO.formatAttributedUserMessage()` strips the author prefix. Supported: `/compact`, `/context`, `/debug`, `/insights`, `/security-review`. Allowlist in `ChatThreadDO.SLASH_COMMANDS` (`workers/main/src/durable-objects.ts`).

### Pending-Message Handoff Pattern
Several features (onboarding first-thread, custom connection "Other") use the same pattern: seed `sessionStorage` key `pendingMessage:newThread` with a `<chiridion system message>...</chiridion system message>` payload, navigate to `/chat/{threadId}?newThread=1`, and `Chat.tsx` consumes and sends the hidden message.

### Chat Attachment Uploads
Multipart-only R2 uploads via `/api/workspaces/:id/upload` with actions: `mpu-create`, `mpu-uploadpart`, `mpu-complete`, `mpu-abort`.

### Todo State Persistence
`control-plane.mjs` emits `todo_state` on `TodoWrite` tool calls. `ChatThreadDO` persists it and replays on WebSocket init. Cleared on turn completion (`result` event).

### Task Notifications
SDK `<task-notification>` user-role payloads are parsed client-side, merged into the nearest assistant message as `task_notification` content blocks, and rendered inline as tool-call rows. If no assistant message exists yet, Chat synthesizes an assistant message so raw XML is never shown.

### MCP Prompt Replay
MCP-driven prompts (connection setup, bug reports) are persisted in `ChatThreadDO` and replayed to newly connected clients. Prompts expire (30m for connections, 5m for bug reports).

### Integration Token Refresh
OAuth integrations with expiring tokens are refreshed by `WorkspaceDO` alarms. Updated credentials are pushed to both sandbox runtimes and deployed workers.

### App Previews
Deploy enqueues screenshot job → Browser Rendering → JPEG stored in R2 at `app-previews/{orgId}/{workspaceId}/{scriptName}/current.jpg` → served via `/api/apps/:scriptName/preview`.

### Notebook File Previews
Notebook previews render in the chat preview panel with two modes: **Report** (editorial rendering with TOC, hidden code, styled outputs) and **Notebook** (full cell-by-cell with execution gutters). Supports Vega/Vega-Lite, Plotly, DataFrame tables (native React rendering capped at 100 rows with CSV download), and generic HTML in sandboxed iframes.

### SDK Event Types
- `system` (subtype: `init`) - Session initialization
- `stream_event` - Real-time: `content_block_start`, `content_block_delta`, `message_delta`
- `assistant` - Full/partial assistant message
- `user` - Tool results
- `result` - Query complete

## API Routes

Routes are defined as React Router routes in `src/routes/api/`. See `src/routes.ts` for the full route configuration.

| Area | Key Routes |
|------|------------|
| Auth | `/api/auth/login`, `/api/auth/signup`, `/api/auth/logout`, `/api/auth/switch-org`, `/api/auth/switch-workspace` |
| OAuth | `/api/auth/google[/callback]`, `/api/auth/github[/callback]` |
| Orgs | `/api/orgs/:id/invite`, `/api/orgs/:id/check-slug`, `/api/orgs/:id/update-slug` |
| Onboarding | `/api/onboarding`, `/api/onboarding/complete` |
| Invitations | `/api/invitations/:orgId/:invitationId` (GET/POST) |
| Workspace FS | `/api/workspaces/:id/fs/{list,read,content/*,write,upload,create,mkdir,move,delete}` |
| Workspace files | `/api/workspaces/:id/{upload,download,uploads/*,outputs/*}` |
| Apps | `/api/apps/:scriptName/preview` |
| WebSocket | `/ws/{workspace}` (chat), `/ws/logs?scriptName={name}` (worker logs) |
| MCP | `/mcp` (streamable HTTP), `/mcp/health` |

## Durable Objects

| DO | Scope | Purpose |
|----|-------|---------|
| `UserDO` | per user | Profile, password, OAuth providers, org memberships, onboarding state |
| `OrgDO` | per org | Members, invitations, threads, worker scripts, integrations, API tokens, OpenRouter key |
| `OrgSlugDO` | per slug | Atomic slug ownership (`claim`/`getOwner`/`release`) |
| `WorkspaceDO` | per workspace | Metadata, members, integrations, audit logs, token refresh alarms |
| `ChatThreadDO` | per thread | WebSocket state, preview target, todo/prompt persistence |
| `WorkerLogsDO` | per script | Deployed worker logs (up to 10k entries), real-time WebSocket streaming |

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
OPENROUTER_API_KEY=your_openrouter_key_here
OPENROUTER_PROVISIONING_KEY=your_provisioning_key_here
WORKER_BASE_URL=https://your-ngrok-subdomain.ngrok-free.app
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
GITHUB_CLIENT_ID=your_github_client_id
GITHUB_CLIENT_SECRET=your_github_client_secret
```

Other env vars: `INTEGRATION_SECRET_KEY`, `TOKEN_SIGNING_SECRET`, `EMAIL_FROM_ADDRESS`, `GMAIL_SERVICE_ACCOUNT_EMAIL`, `GMAIL_SERVICE_ACCOUNT_PRIVATE_KEY`, `GMAIL_SENDER_EMAIL`, `DISPATCHER_MISSING_REGISTRY_MODE`.

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

### Admin CLI
```bash
bun run admin -- [env] [endpoint] [jq-filter]   # Quick query
bun run admin -- staging overview                # Example
bun run admin -- prod users '.users[] | {name, email}'
bun run admin:staging                            # Interactive mode
```

Endpoints: `/overview`, `/orgs`, `/users`, `/threads`, `/kv-keys`, `/r2/list`, `/workers`.

### Sandbox Host Deployment

The sandbox host runs on an Azure VM (`ssh chiridion-vm`, user `chiridion`, IP `172.173.64.214`). Deploy via rsync + SSH build + systemctl restart. Rebuild Docker image on VM and push to ACR (`crchiridionprod`).

Sandbox names: `chiridion-{workspaceId}`. Host dir: `/mnt/workspaces/{sandboxName}` → container `/home/claude`. Image: Ubuntu 24.04 with bun, node 22, git, rclone, uv. Containers use gVisor (`--runtime=runsc`).

**Network:** Two listeners — `PORT` (80, worker control traffic) and `SANDBOX_PROXY_PORT` (8081, container egress only). VM firewall blocks containers from reaching control port.

**Storage:** NVMe RAID0 (hot) + JuiceFS (durable canonical) via overlayfs. Background sync flushes NVMe → JuiceFS.

**R2 FUSE mounts:** Set up automatically when env vars are pushed. Uses permanent R2 credentials from sandbox-host env.

### Observability

SSR errors logged to Workers Analytics Engine (`ERROR_ANALYTICS` binding, `chiridion_errors` dataset). Live logs: `npx wrangler tail --env <env>`.

## Known Issues

1. **Durable Objects not working locally**: Use `bun run dev` (wrangler-based dev)
2. **Streaming not working**: Ensure `includePartialMessages: true` in `sandbox/control-plane.mjs`
3. **API key not found**: Check `.dev.vars` has `OPENROUTER_API_KEY`
4. **Session not persisting**: Check cookies and DO worker is running
5. **Type errors after route changes**: Run `bun run typecheck` to regenerate types
