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
     - **Chat DOs:** `ChatIndexDO` (thread/project metadata per org)
     - **Auth DOs:** `SessionDO`, `UserDO`, `OrgDO`
     - `ThreadSandbox` - Executes Claude SDK in containers
     - WebSocket routing at worker level (one container per org)
     - `DoRpcService` - RPC entrypoint for cross-worker calls
   - `dispatcher/` - Routes `*.chiridion.ai` to user workers (WfP)
   - `admin-cli/` - Local-only admin CLI for querying live environments

3. **Sandbox** (`sandbox/`)
   - `ws-server.mjs` - WebSocket server running inside Cloudflare Container
   - Calls Claude SDK `query()` with streaming enabled
   - `control-plane.mjs` - Exec/filesystem API server for container management

## Key Files

| File | Purpose |
|------|---------|
| `src/components/Chat.tsx` | Main chat UI with streaming state management |
| `src/contexts/AuthContext.tsx` | React context for auth state |
| `src/app/login/page.tsx` | Login page |
| `src/app/signup/page.tsx` | Signup page |
| `src/lib/auth.ts` | Cookie handling, validation helpers |
| `src/lib/auth-do.ts` | Functions to interact with auth DOs |
| `workers/main/src/durable-objects.ts` | ChatIndexDO for thread/project metadata |
| `workers/main/src/container.ts` | Container lifecycle and WebSocket routing |
| `workers/main/src/auth.ts` | SessionDO, UserDO, OrgDO implementations |
| `workers/main/src/password.ts` | PBKDF2 password hashing |
| `workers/main/src/index.ts` | Worker entry point |
| `scripts/dev-proxy.mjs` | Local dev runner (wrangler + next + proxy) |
| `sandbox/ws-server.mjs` | WebSocket server with Claude SDK inside container |
| `src/lib/integration-registry.ts` | Integration type definitions and schemas |
| `src/lib/integration-crypto.ts` | Credential encryption utilities |
| `workers/main/src/rpc-service.ts` | DoRpcService - RPC methods for cross-worker calls |
| `workers/admin-cli/cli.mjs` | Admin CLI wrapper script |
| `workers/admin-cli/src/index.ts` | Admin CLI worker (local-only) |

## Configuration Files

| File | Purpose |
|------|---------|
| `wrangler.jsonc` | Main production/deployment config |
| `wrangler.build.jsonc` | OpenNext build config |
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
1. User signs up/logs in via `/api/auth/signup` or `/api/auth/login`
2. Password verified with PBKDF2 (100k iterations, SHA-256)
3. Session created in `SessionDO`, cookie set with `httpOnly`, `sameSite: lax`
4. Email → userId mapping stored in KV (`EMAIL_TO_USER`)
5. `AuthContext` fetches session state from `/api/auth/me`

### Message Sending
1. User types message in `Chat.tsx`
2. WebSocket connects to `/ws/{org}` - Worker routes directly to container
3. Container runs ws-server which proxies to Claude SDK
4. Claude SDK stores messages in JSONL files (`~/.claude/projects/.../session.jsonl`)
5. Streaming responses sent back through WebSocket
6. Thread ID = Claude session_id (received on first message)
7. Frontend updates React state with streaming content

### Projects
1. Each thread belongs to a project (`project_id` on threads)
2. `ChatIndexDO` stores projects and threads per org
3. A default project is created per org and assigned to existing/new threads when none is specified

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

### Auth
| Route | Method | Purpose |
|-------|--------|---------|
| `/api/auth/signup` | POST | Create account |
| `/api/auth/login` | POST | Login |
| `/api/auth/logout` | POST | Logout |
| `/api/auth/me` | GET | Get current session |
| `/api/auth/switch-org` | POST | Switch active org |

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
```

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Claude API key for SDK |
| `NEXTJS_ENV` | Environment (development/production) |
| `INTEGRATION_SECRET_KEY` | 256-bit key for encrypting integration credentials |

### KV Namespaces

| Binding | Purpose |
|---------|---------|
| `EMAIL_TO_USER` | Maps email addresses to user IDs |

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
│   │   │   ├── auth/        # Auth endpoints
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
- Auth/UI state: `AuthContext.test.tsx` (login/signup/logout/switch org flows, loading/error states).
- Auth helpers: `auth-validation.test.ts`, `admin-auth.test.ts`, `auth-serialization.test.ts` (plain-object safety for DO responses).
- Chat rendering logic: `Chat.test.tsx` (partial message replacement vs append), `content-parsing.test.ts` (JSON content blocks), `stream-playback.test.ts` (stream event reducer in `src/lib/streaming`).
- Crypto: `password.test.ts` (PBKDF2 hash/verify, edge cases).

### Integration Tests (Vitest + dev server) (`tests/integration/`)
- Run with `npm run test:integration` using `vitest.integration.config.ts`.
- `global-setup.ts` starts `npm run dev` (wrangler + next) on `INTEGRATION_TEST_PORT` (default `3100`), waits for readiness, writes `.server-url` for tests to read.
- Tests focus on real HTTP behavior and auth gating (server actions own auth):
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
- `persistence.spec.ts` + `persistence-api.spec.ts` verify message/tool block persistence across reload (UI + API-created threads).
- `admin.spec.ts` covers admin access control; superuser tests require `SUPERUSER_TEST_EMAIL` and `SUPERUSER_TEST_PASSWORD`.
