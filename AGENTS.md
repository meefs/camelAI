# Chiridion App - Agent Documentation

> **Note to agents:** Keep this file up to date. When you add new features, workers, API routes, or make significant architectural changes, update the relevant sections of this document.

## Overview

Chiridion is an AI chat application built on Cloudflare's edge infrastructure. It uses the Claude SDK running inside Cloudflare Containers to provide streaming AI responses through WebSockets. The app includes multi-tenant authentication with users and organizations.

## Architecture

```
┌─────────────────┐     ┌──────────────────────┐     ┌─────────────────────┐
│   Next.js UI    │────▶│   Cloudflare Worker  │────▶│ Cloudflare Container│
│  (React + WS)   │◀────│   (Durable Objects)  │◀────│   (Claude SDK)      │
└─────────────────┘     └──────────────────────┘     └─────────────────────┘
```

### Components

1. **Frontend** (`src/`)
   - Next.js 15 with React 19
   - WebSocket client for real-time streaming
   - Tailwind CSS v4 + shadcn/ui components
   - AuthContext for session/org state management

2. **Workers** (`workers/`)
   - `main/` - Main Chiridion app worker
     - Cloudflare Workers with Durable Objects
    - **Auth DOs:** `UserDO`, `OrgDO` (OrgDO stores threads per workspace + proxy usage rollups)
     - `ThreadSandbox` - Executes Claude SDK in containers
     - WebSocket routing at worker level (one container per org)
     - `DoRpcService` - RPC entrypoint for cross-worker calls
   - `dispatcher/` - Routes `*.chiridion.app` to user workers (WfP)
   - `admin-cli/` - Local-only admin CLI for querying live environments
   - `screenshot/` - Queue consumer that renders app previews via Browser Rendering and stores in R2
   - `proxy/` - Multi-provider LLM proxy worker (Anthropic/OpenAI-compatible/Bedrock/Azure Foundry) with token accounting

3. **Sandbox** (`sandbox/`)
   - `ws-server.mjs` - WebSocket server running inside Cloudflare Container
   - Calls Claude SDK `query()` with streaming enabled
   - `control-plane.mjs` - Exec/filesystem API server for container management

## Key Files

| File | Purpose |
|------|---------|
| `src/components/Chat.tsx` | Main chat UI with streaming state management |
| `src/components/floating-todo/*` | Floating todo list UI for streaming task progress |
| `src/components/tool-call/*` | Tool call UI, summaries, and expanded details (including Skill sheet rendering) |
| `src/app/(admin)/qaml-backdoor/apps/*` | Admin Apps list/detail pages for worker scripts |
| `src/components/admin/app-edit-form.tsx` | Admin app visibility editor |
| `src/components/admin/app-danger-zone.tsx` | Admin app deletion actions |
| `src/app/(app)/apps/apps-client.tsx` | Apps list UI with workspace filter tabs and data refresh |
| `src/app/(app)/apps/AppCard.tsx` | App card layout, URL actions, and workspace badges |
| `src/contexts/AuthContext.tsx` | React context for auth state |
| `src/app/login/page.tsx` | Login page |
| `src/app/signup/page.tsx` | Signup page |
| `src/lib/auth.ts` | Cookie handling, validation helpers |
| `src/lib/auth-do.ts` | Functions to interact with auth DOs |
| `src/lib/oauth-config.ts` | OAuth provider configuration (Google, GitHub) |
| `src/components/auth/oauth-buttons.tsx` | OAuth sign-in buttons component |
| `workers/main/src/oauth-state.ts` | OAuth state management for CSRF protection |
| `workers/main/src/durable-objects.ts` | ChatThreadDO for thread preview state |
| `workers/main/src/container.ts` | Container lifecycle and WebSocket routing |
| `workers/main/src/auth.ts` | UserDO, OrgDO implementations (threads stored in OrgDO) |
| `workers/main/src/password.ts` | PBKDF2 password hashing |
| `workers/main/src/index.ts` | Worker entry point |
| `workers/screenshot/src/index.ts` | Queue consumer for app preview screenshots |
| `scripts/dev-proxy.mjs` | Local dev runner (wrangler + next + proxy) |
| `sandbox/ws-server.mjs` | WebSocket server with Claude SDK inside container |
| `src/lib/integration-registry.ts` | Integration type definitions and schemas |
| `src/lib/integration-crypto.ts` | Credential encryption utilities |
| `workers/main/src/rpc-service.ts` | DoRpcService - RPC methods for cross-worker calls |
| `workers/admin-cli/cli.mjs` | Admin CLI wrapper script |
| `workers/admin-cli/src/index.ts` | Admin CLI worker (local-only) |
| `workers/proxy/src/index.ts` | LLM proxy worker entry (multi-provider, streaming, token usage) |
| `workers/proxy/wrangler.jsonc` | Proxy worker deployment config |
| `src/instrumentation.ts` | Next.js SSR error logging to Analytics Engine |
| `src/app/api/apps/[scriptName]/preview/route.ts` | Authenticated preview image endpoint for app cards |

## Configuration Files

| File | Purpose |
|------|---------|
| `wrangler.jsonc` | Main production/deployment config |
| `wrangler.build.jsonc` | OpenNext build config |
| `workers/screenshot/wrangler.jsonc` | Screenshot worker deployment config |
| `components.json` | shadcn/ui configuration |
| `.mcp.json` | MCP server config (shadcn registry access) |

## UI Components (shadcn/ui)

This project uses [shadcn/ui](https://ui.shadcn.com) for UI components. **When doing ANY UI work, the `shadcn-components` skill will auto-activate** with detailed workflow instructions.

### Key Resources
| Resource | Purpose |
|----------|---------|
| `.claude/skills/shadcn-components/` | Skill with required workflow and composition patterns |
| `docs/shadcn-components.md` | Full component catalog organized by category |
| `components.json` | shadcn configuration |
| `src/components/ui/` | Installed components |

### Quick Reference
- **Style:** radix-mira, zinc, Inter font, 0.5rem radius, Lucide icons
- **Install:** `npx shadcn@latest add <component>`
- **Styling:** Use `cn()` from `@/lib/utils`, theme vars in `globals.css`

## Data Flow

### Authentication
1. User signs up/logs in via server actions (`login()`, `signup()` in `src/lib/server-actions/auth.ts`)
2. Password verified with PBKDF2 (100k iterations, SHA-256)
3. Session created in `SessionDO`, cookie set with `httpOnly`, `sameSite: lax`
4. Email → userId mapping stored in KV (`EMAIL_TO_USER`)
5. `AuthContext` calls `getAuthState()` server action to fetch session state

### Message Sending
1. User types message in `Chat.tsx`
2. WebSocket connects to `/ws/{org}` - Worker routes directly to container
3. Container runs ws-server which proxies to Claude SDK
4. Claude SDK stores messages in JSONL files (`~/.claude/projects/.../session.jsonl`)
5. Streaming responses sent back through WebSocket
6. Thread ID = Claude session_id (received on first message)
7. Frontend updates React state with streaming content

### Threads
1. Each thread belongs to a workspace
2. Threads are stored in `OrgDO` (one per organization)
3. `ChatThreadDO` handles real-time preview state for each thread
4. History can query threads across accessible workspaces via `getThreadsAllWorkspacesPaginated` on `OrgDO`

### App Previews
1. Deploy succeeds in `workers/main/src/index.ts` and enqueues an `APP_SCREENSHOT_QUEUE` job (local dev captures inline with Browser Rendering against `LOCAL_APP_PREVIEW_URL`, defaulting to `https://hello-world-test.chiridion.app/`).
2. Screenshot worker renders `https://{script}.apps.{env}.chiridion.ai` via Browser Rendering.
3. For private apps, the dispatcher exchanges the single-use screenshot token for a short-lived screenshot session cookie to allow asset requests.
4. JPEG previews are stored in R2 under `app-previews/{orgId}/{workspaceId}/{scriptName}/current.jpg`.
5. OrgDO updates `worker_scripts.preview_*` fields for status + key.
6. Apps page loads previews through `/api/apps/[scriptName]/preview` (org membership required).

### SDK Event Types
- `system` (subtype: `init`) - Session initialization
- `stream_event` - Real-time streaming:
  - `content_block_start` - New text block
  - `content_block_delta` - Incremental text chunk
  - `message_delta` - Stop reason
- `assistant` - Full/partial assistant message
- `user` - Tool results
- `result` - Query complete

## API Routes

### Organizations
| Route | Method | Purpose |
|-------|--------|---------|
| `/api/orgs` | GET, POST | List/create orgs |
| `/api/orgs/[id]` | GET, PUT, DELETE | Get/update/delete org |
| `/api/orgs/[id]/members` | GET, PUT, DELETE | Manage members |
| `/api/orgs/[id]/invite` | GET, POST, DELETE | Manage invitations |
| `/api/orgs/[id]/integrations` | GET, POST | List/create integrations |
| `/api/orgs/[id]/integrations/[integrationId]` | GET, PUT, DELETE | Get/update/delete integration |
| `/api/invitations/[orgId]/[invitationId]` | GET, POST | View/accept invitation |

### Integrations (public)
| Route | Method | Purpose |
|-------|--------|---------|
| `/api/integrations/types` | GET | List available integration types |

### OAuth (public)
| Route | Method | Purpose |
|-------|--------|---------|
| `/api/auth/google` | GET | Initiate Google OAuth flow |
| `/api/auth/google/callback` | GET | Google OAuth callback |
| `/api/auth/github` | GET | Initiate GitHub OAuth flow |
| `/api/auth/github/callback` | GET | GitHub OAuth callback |

### Chat (auth required)
| Route | Method | Purpose |
|-------|--------|---------|
| `/api/threads` | GET, POST | List/create threads |
| `/api/threads/[id]` | GET, DELETE | Get/delete thread |
| `/api/threads/[id]/messages` | GET, POST | Get/add thread messages |
| `/api/projects` | GET, POST | List/create projects |
| `/api/projects/[id]` | GET, PUT, DELETE | Get/update/delete project |
| `/api/chat` | POST | Send message (REST fallback) |
| `/ws/{org}` | WebSocket | Real-time chat (one connection per org) |

### Apps (auth required)
| Route | Method | Purpose |
|-------|--------|---------|
| `/api/apps/[scriptName]/preview` | GET | Stream app preview screenshot from R2 |

### Proxy Worker (separate service)
| Route | Method | Purpose |
|-------|--------|---------|
| `/v1/messages` | POST | LLM proxy (Anthropic-style request/response, streaming supported) |

## Development

### Prerequisites
- Node.js 22+
- Docker (for Cloudflare Containers)
- Cloudflare account (for deployment)

### Local Development

**Full Cloudflare dev (recommended)**
```bash
npm run dev
```
Runs `wrangler dev` + `next dev` with a local proxy. The proxy routes `/ws/*` and `/client/v4/*` to Wrangler and everything else to Next.
Default ports: proxy `3100`, Wrangler `8787`, Next `3001` (override with `PROXY_DEV_PORT`, `WRANGLER_DEV_PORT`, `NEXT_DEV_PORT`).

### Environment Variables

Create `.dev.vars`:
```
ANTHROPIC_API_KEY=your_key_here
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
GITHUB_CLIENT_ID=your_github_client_id
GITHUB_CLIENT_SECRET=your_github_client_secret
```

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Claude API key for SDK |
| `NEXTJS_ENV` | Environment (development/production) |
| `INTEGRATION_SECRET_KEY` | 256-bit key for encrypting integration credentials |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID (from Google Cloud Console) |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `GITHUB_CLIENT_ID` | GitHub OAuth App client ID (from GitHub Developer Settings) |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth App client secret |
| `LOCAL_APP_PREVIEW_URL` | Optional override for local app preview screenshots (defaults to `https://hello-world-test.chiridion.app/`) |
| `PROXY_BASE_URL` | Base URL for the LLM proxy used by sandbox containers (sets `ANTHROPIC_BASE_URL` in containers) |

#### OAuth Setup

**Google OAuth:**
1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select existing
3. Navigate to APIs & Services > Credentials
4. Create OAuth 2.0 Client ID (Web application)
5. Add authorized redirect URI: `https://your-domain.com/api/auth/google/callback`

**GitHub OAuth:**
1. Go to [GitHub Developer Settings](https://github.com/settings/developers)
2. Create a new OAuth App
3. Set Authorization callback URL: `https://your-domain.com/api/auth/github/callback`

### Proxy Worker Environment Variables (`workers/proxy`)

| Variable | Description |
|----------|-------------|
| `PROXY_PROVIDERS` | JSON array of provider configs (name/type/baseUrl/etc.) |
| `PROXY_DEFAULT_PROVIDER` | Default provider name |
| `PROXY_FALLBACK_ORDER` | Comma-separated provider fallback list |
| `PROXY_LOG_LEVEL` | Logging verbosity (`debug`, `info`, `warn`, `error`, `none`) |
| `PROXY_MODEL_ALIASES` | JSON map of Anthropic model IDs → canonical aliases |
| `PROXY_BEDROCK_MODEL_MAP` | JSON map of Anthropic model IDs/aliases → Bedrock model IDs (e.g., `global.anthropic.claude-...-v1:0`) |
| `ANTHROPIC_API_KEY` | Upstream Anthropic key |
| `ANTHROPIC_API_URL` | Anthropic base URL override |
| `ANTHROPIC_VERSION` | Anthropic API version header override |
| `ANTHROPIC_FOUNDRY_API_KEY` | Upstream Foundry API key |
| `ANTHROPIC_FOUNDRY_BASE_URL` | Foundry base URL (optional if resource is set) |
| `ANTHROPIC_FOUNDRY_RESOURCE` | Foundry resource name (optional if base URL is set) |
| `AZURE_FOUNDRY_API_KEY` | Back-compat alias for Foundry API key |
| `AZURE_FOUNDRY_BASE_URL` | Back-compat alias for Foundry base URL |
| `AZURE_FOUNDRY_RESOURCE` | Back-compat alias for Foundry resource name |
| `AWS_REGION` | AWS region for Bedrock runtime |
| `BEDROCK_MODEL_ID` | Bedrock model identifier |
| `ANTHROPIC_BEDROCK_BASE_URL` | Optional Bedrock runtime base URL override |
| `BEDROCK_API_KEY` | Bedrock Runtime API key (uses bearer token auth) |
| `AWS_BEARER_TOKEN_BEDROCK` | Alternate Bedrock API key env var (bearer token auth) |

Proxy auth uses API tokens minted via `DoRpcService.createOrgApiToken` (stored in `API_TOKENS` KV on the main worker). Requests must include `Authorization: Bearer <token>` or `x-api-key`. The proxy relies on the `MAIN_RPC` service binding to validate tokens and record usage.

Sandbox containers require `PROXY_BASE_URL` on the main worker; the container mints a per-org proxy token and exports `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY` (no upstream key fallback).

### KV Namespaces

| Binding | Purpose |
|---------|---------|
| `EMAIL_TO_USER` | Maps email addresses to user IDs |

### Observability

**Error Analytics** - SSR errors are logged to Workers Analytics Engine via `src/instrumentation.ts`.

| Binding | Dataset | Purpose |
|---------|---------|---------|
| `ERROR_ANALYTICS` | `chiridion_errors` | SSR error tracking |

**Data points logged:**
- `indexes[0]`: Route type (`render`, `route`, `action`, `middleware`)
- `blobs[0-6]`: Error digest, message, path, method, route pattern, router kind, stack trace
- `doubles[0-1]`: Timestamp, count

**Querying errors** (via Cloudflare Dashboard → Analytics Engine or GraphQL API):
```sql
SELECT
  blob1 AS digest,
  blob2 AS message,
  blob3 AS path,
  SUM(double2) AS count
FROM chiridion_errors
WHERE timestamp > NOW() - INTERVAL '1' HOUR
GROUP BY digest, message, path
ORDER BY count DESC
```

**Live logs:** Use `npx wrangler tail --env <env>` to see `console.error` output in real-time.

### Testing
```bash
# Unit tests (Vitest + jsdom)
npm run test

# Integration tests (Vitest + real dev server)
npm run test:integration

# Workers runtime tests (Miniflare + Durable Objects)
npm run test:workers

# E2E tests (Playwright; configure BASE_URL or run npm run dev)
npm run test:e2e
```

### Build & Deploy
```bash
# Build for Cloudflare
npm run build:cf

# Deploy to production
npm run deploy:prod

# Deploy to staging
npm run deploy:staging
```

### Admin CLI

Query live environments locally using RPC service bindings to call `DoRpcService` methods directly on deployed workers.

```bash
# Quick CLI (starts wrangler, queries, exits)
npm run admin -- [env] [endpoint] [jq-filter]

# Examples
npm run admin -- dev-illiana overview
npm run admin -- staging orgs
npm run admin -- prod users '.users[] | {name, email}'
npm run admin -- dev-illiana orgs '.orgs[] | {org_id: .id, name: .name}'
npm run admin -- dev-illiana threads
npm run admin -- workers                    # Fast - no wrangler startup
npm run admin -- workers                    # List all workers in dispatch namespace

# Interactive mode (keeps server running for multiple queries)
npm run admin:dev-illiana  # Then curl http://localhost:8788/overview
npm run admin:staging
npm run admin:prod
```

| Environment | Target |
|-------------|--------|
| `staging` (default) | staging.chiridion.ai |
| `prod` | chiridion.ai |
| `dev-illiana` | dev-illiana.chiridion.ai |
| `dev-miguel` | dev-miguel.chiridion.ai |

| Endpoint | RPC Method | Description |
|----------|------------|-------------|
| `/overview` | `getAdminOverview()` | Users, orgs, membership counts |
| `/orgs` | `adminGetOrgsPaginated()` + `getOrgMembers()` | All orgs with member details |
| `/users` | `adminGetUsersPaginated()` | All users with org counts |
| `/threads` | `adminGetThreadsPaginated()` | All threads across all orgs |
| `/kv-keys` | Direct KV access | List KV keys (optional `?prefix=`) |
| `/r2/list` | Direct R2 access | List R2 objects (optional `?prefix=`) |
| `/r2/info/{key}` | Direct R2 access | Get R2 object metadata |
| `/r2/backup/{orgId}` | Direct R2 access | Get backup info for an org |
| `/workers` | Direct API (no wrangler) | List all user workers in dispatch namespace |
| `/workers/{orgId}` | Direct API (no wrangler) | Deprecated: script names are no longer org-prefixed; use `/workers` |
| `/container/{orgId}/ls` | RPC → Container | List workspace files (optional `?path=`, `?recursive=true`) |
| `/container/{orgId}/read/{path}` | RPC → Container | Read a file from container workspace |
| `/container/{orgId}/write` | RPC → Container | Write a file (POST: `{path, content}`) |
| `/container/{orgId}/mkdir` | RPC → Container | Create directory (POST: `{path}`) |
| `/container/{orgId}/delete` | RPC → Container | Delete file/dir (POST: `{path}`) |
| `/container/{orgId}/reset` | RPC → Container | Reset container (POST, destroys and recreates) |

**How it works:** Most endpoints use Cloudflare service bindings with `entrypoint: "DoRpcService"` and `remote: true` to call RPC methods on deployed workers. No HTTP routes needed - direct RPC over the Cloudflare network.

**Workers endpoint:** The `/workers` endpoint uses direct Cloudflare API calls (no wrangler needed), reading the OAuth token automatically from `~/Library/Preferences/.wrangler/config/default.toml`. Run `npx wrangler login` if not already authenticated.

## Project Structure

```
chiridion-app/
├── src/
│   ├── app/
│   │   ├── api/
│   │   │   ├── chat/        # Chat endpoint
│   │   │   ├── integrations/# Integration type registry
│   │   │   ├── invitations/ # Invitation acceptance
│   │   │   ├── orgs/        # Org management + integrations
│   │   │   ├── projects/    # Project CRUD
│   │   │   └── threads/     # Thread CRUD
│   │   ├── chat/[id]/       # Chat page
│   │   ├── login/           # Login page
│   │   ├── signup/          # Signup page
│   │   └── globals.css      # Tailwind + shadcn theme variables
│   ├── components/
│   │   └── ui/              # shadcn/ui components
│   ├── contexts/            # React contexts (AuthContext)
│   ├── lib/
│   │   └── utils.ts         # cn() helper for Tailwind classes
│   └── types.ts             # TypeScript types
├── workers/
│   ├── main/
│   │   └── src/
│   │       ├── index.ts         # Worker entry point
│   │       ├── durable-objects.ts # Chat DOs
│   │       ├── auth.ts          # Auth DOs
│   │       ├── rpc-service.ts   # DoRpcService RPC entrypoint
│   │       └── password.ts      # Password hashing
│   ├── dispatcher/          # WfP subdomain router
│   │   └── src/
│   ├── proxy/               # LLM proxy worker
│   │   ├── src/index.ts     # Proxy worker entry
│   │   └── wrangler.jsonc   # Proxy worker config
│   └── admin-cli/           # Local-only admin CLI
│       ├── cli.mjs          # CLI wrapper script
│       ├── src/index.ts     # Worker code
│       └── wrangler.jsonc   # Config with remote bindings
├── sandbox/                 # Container sandbox code
├── scripts/                 # Dev scripts
│   └── dev-proxy.mjs        # Wrangler + Next dev + proxy
├── e2e/                     # Playwright E2E tests
├── tests/                   # Vitest unit tests
├── wrangler.jsonc           # Production config
├── wrangler.build.jsonc     # OpenNext build config
├── components.json          # shadcn/ui config
├── .mcp.json                # MCP server config
└── package.json
```

## Known Issues & Solutions

See `STREAMING_BUG_SUMMARY.md` for streaming-related bugs and fixes.

### Common Issues

1. **Durable Objects not working locally**: Use `npm run dev` (wrangler-based dev) rather than `next dev`
2. **Streaming not working**: Ensure `includePartialMessages: true` is set in ws-server.mjs
3. **API key not found**: Check `.dev.vars` has `ANTHROPIC_API_KEY` set
4. **Docker cache stale**: Add version comment to `ws-server.mjs` to invalidate cache
5. **Session not persisting**: Ensure cookies are set with correct domain and the DO worker is running

## Testing Strategy

### Unit Tests (Vitest + jsdom) (`tests/`)
- Config: `vitest.config.ts` with `jsdom`, `tests/setup.ts` (matchMedia), excludes `tests/integration/**`.
- Auth/UI state: `AuthContext.test.tsx` tests auth flows with mocked server actions.
- Auth helpers: `auth-validation.test.ts`, `admin-auth.test.ts`, `auth-serialization.test.ts` (plain-object safety for DO responses).
- Chat rendering logic: `Chat.test.tsx` (partial message replacement vs append), `content-parsing.test.ts` (JSON content blocks), `stream-playback.test.ts` (stream event reducer in `src/lib/streaming`).
- Crypto: `password.test.ts` (PBKDF2 hash/verify, edge cases).

### Integration Tests (Vitest + dev server) (`tests/integration/`)
- Run with `npm run test:integration` using `vitest.integration.config.ts`.
- `global-setup.ts` starts `npm run dev` (wrangler + next) on `INTEGRATION_TEST_PORT` (default `3100`), waits for readiness, writes `.server-url` for tests to read.
- Tests focus on page accessibility and auth gating (auth uses server actions, not API routes):
  - `pages.test.ts` checks login/signup SSR, public invitation pages, and protected route redirects.
  - `api-routes.test.ts` asserts auth required for chat, threads preview, workspace FS, and computer APIs; static asset behavior.
- Runs sequentially (single fork) to avoid port conflicts.

### Workers Runtime Tests (Cloudflare pool) (`workers/main/tests/`)
- Run with `npm run test:workers` using `vitest.workers.config.ts` + `wrangler.test.jsonc`.
- `auth-do.test.ts` exercises full auth flow through RPC -> Durable Objects (users, orgs, sessions, org switching).
- `password.test.ts` validates hashing/verification in the Workers runtime.

### E2E Tests (Playwright) (`e2e/`)
- Config in `playwright.config.ts`; default `baseURL` is remote, override `BASE_URL` for local (`npm run dev`).
- `auth.spec.ts` covers signup/login/logout and protected-route redirects.
- `chat.spec.ts` validates chat creation, streaming deltas, and tool use UI.
- `streaming.spec.ts` inspects WebSocket `sdk_event` flow and partial assistant events.
- `persistence.spec.ts` + `persistence-api.spec.ts` verify message/tool block persistence across reload.
- `invitation.spec.ts` tests invitation page error handling.
- `admin.spec.ts` covers admin access control; superuser tests require `SUPERUSER_TEST_EMAIL` and `SUPERUSER_TEST_PASSWORD`.
