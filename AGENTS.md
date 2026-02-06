# Chiridion App - Agent Documentation

> **Note to agents:** Keep this file up to date. When you add new features, workers, API routes, or make significant architectural changes, update the relevant sections of this document.

## Overview

Chiridion is an AI coding assistant built on Cloudflare's edge infrastructure. Users can chat with a Claude-powered agent that has access to a persistent computer (workspace) where files persist across sessions. Users can create applications by having the agent write code, then publish those applications to live URLs hosted by Chiridion. The app supports integrations (connections) to external services that can be used in applications.

**Key Capabilities:**
- Real-time AI chat with streaming responses via WebSockets
- Persistent workspaces with JuiceFS-backed filesystem
- One-click app deployment to `*.chiridion.app` subdomains
- Multi-tenant authentication with users, organizations, and workspaces
- External service integrations for reading/writing data

## Architecture

```
┌─────────────────┐     ┌──────────────────────┐     ┌─────────────────────┐
│  React Router   │────▶│   Cloudflare Worker  │────▶│ Cloudflare Container│
│   (SSR + WS)    │◀────│   (Durable Objects)  │◀────│   (Claude SDK)      │
└─────────────────┘     └──────────────────────┘     └─────────────────────┘
         │                        │                           │
         │                        ▼                           │
         │              ┌──────────────────┐                  │
         │              │  Dispatcher WfP  │                  │
         │              │ (User App Hosts) │                  │
         │              └──────────────────┘                  │
         │                        │                           │
         ▼                        ▼                           ▼
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────────┐
│   R2 Storage    │     │    OpenRouter    │     │     JuiceFS         │
│  (Files/Assets) │     │   (LLM Access)   │     │   (Workspace FS)    │
└─────────────────┘     └──────────────────┘     └─────────────────────┘
```

### Components

1. **Frontend** (`src/`)
   - React Router 7 with React 19 SSR
   - React Router 7 **framework mode** conventions by default (successor to Remix)
   - Imperative route configuration in `src/routes.ts`
   - Loaders/actions for data fetching and mutations
   - Prefer server-driven data flow (`loader`, `action`, `<Form>`, `useFetcher`) over SPA-style client fetching in `useEffect`
   - WebSocket client for real-time streaming
   - Tailwind CSS v4 + shadcn/ui components
   - Cloudflare Workers SSR via `@cloudflare/vite-plugin`

2. **Workers** (`workers/`)
   - `main/` - Main Chiridion app worker
     - React Router SSR handler
     - Durable Objects for state: `UserDO`, `OrgDO`, `OrgSlugDO`, `WorkspaceDO`, `ChatThreadDO`
     - `ThreadSandbox` - Container lifecycle management
     - WebSocket routing (one container per workspace)
     - OAuth flow handling
     - MCP server endpoint (`/mcp`) with API key auth
   - `dispatcher/` - Routes `*.chiridion.app` to user workers (Workers for Platforms)
   - `admin-cli/` - Local-only admin CLI for querying live environments

3. **Sandbox** (`sandbox/`)
   - `entrypoint.sh` - Container startup: mounts JuiceFS, starts services
   - `ws-server.mjs` - WebSocket server running Claude SDK inside container
   - `control-plane.mjs` - Exec/filesystem API server for container management
   - `sync.mjs` - R2 tar snapshot download (migration tool)
   - `skills/` - Agent skills (developing-software, file-sharing, frontend-design)

## Key Files

### Frontend Core
| File | Purpose |
|------|---------|
| `src/routes.ts` | Imperative route configuration |
| `src/root.tsx` | Root layout, links, meta, error boundary |
| `src/entry.server.tsx` | SSR entry point with streaming |
| `src/entry.client.tsx` | Client-side hydration |
| `vite.config.ts` | Vite + React Router + Cloudflare plugin |

### Route Files
| File | Purpose |
|------|---------|
| `src/routes/_app.tsx` | Protected app layout with auth check |
| `src/routes/_onboarding.tsx` | Protected onboarding layout and branching logic |
| `src/routes/_auth.tsx` | Public auth layout (login/signup) |
| `src/routes/_admin.tsx` | Admin-only layout (superuser check) |
| `src/routes/_admin.orgs.$id.tsx` | Admin org detail view (members, workspaces, archive, permanent test-reset delete) |
| `src/routes/_app.chat.$id.tsx` | Chat page with streaming |
| `src/routes/_app.apps.tsx` | Apps listing with workspace filter |
| `src/routes/_app.computer.tsx` | File browser for workspace |
| `src/routes/_app.connections.tsx` | Integration management |
| `src/routes/_app.history.tsx` | Chat history across workspaces |

### Server Libraries
| File | Purpose |
|------|---------|
| `src/lib/auth.server.ts` | Auth helpers: `requireAuthContext()`, `requireSuperuser()` |
| `src/lib/cloudflare.server.ts` | `getEnv()` helper for Cloudflare bindings |
| `src/lib/cookies.server.ts` | Cookie management utilities |
| `src/lib/chat-do.server.ts` | Chat Durable Object interactions |
| `src/lib/auth-do.ts` | User/Org DO method wrappers |

### Worker Core
| File | Purpose |
|------|---------|
| `workers/main/src/index.ts` | Worker entry: WebSocket, OAuth, MCP, SSR |
| `workers/main/src/auth.ts` | `UserDO`, `OrgDO` implementations |
| `workers/main/src/org-slug-registry.ts` | `OrgSlugDO` slug ownership registry |
| `workers/main/src/workspace.ts` | `WorkspaceDO` implementation |
| `workers/main/src/workspace-container.ts` | `ThreadSandbox` container lifecycle |
| `workers/main/src/durable-objects.ts` | `ChatThreadDO` for thread state |
| `workers/main/src/cf-api-proxy.ts` | Cloudflare API proxy for deploys |
| `workers/main/src/mcp-handler.ts` | MCP server with `ChiridionMcp` |
| `workers/main/src/openrouter-keys.ts` | OpenRouter API key provisioning for per-org usage |

### Sandbox
| File | Purpose |
|------|---------|
| `sandbox/entrypoint.sh` | Container startup script |
| `sandbox/ws-server.mjs` | WebSocket server with Claude SDK |
| `sandbox/control-plane.mjs` | Container exec/filesystem API |
| `sandbox/requirements.txt` | Python data analysis packages |
| `sandbox/skills/developing-software/SKILL.md` | Software development skill documentation |

## Configuration Files

| File | Purpose |
|------|---------|
| `wrangler.jsonc` | Main worker config (prod/staging/dev envs) |
| `vite.config.ts` | Vite build configuration |
| `components.json` | shadcn/ui configuration |
| `.mcp.json` | MCP server config (shadcn registry) |

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

### React Router Data Loading

**Loaders** run on the server for GET requests:
```typescript
// src/routes/_app.tsx
import type { Route } from './+types/_app';

export async function loader({ request, context }: Route.LoaderArgs) {
  const authContext = await requireAuthContext(request, context);
  return { authState: authContext };
}

export default function AppLayout() {
  const { authState } = useLoaderData<typeof loader>();
  // Render with auth state...
}
```

**Actions** handle POST/PUT/DELETE requests:
```typescript
// src/routes/_app.apps.tsx
export async function action({ request, context }: Route.ActionArgs) {
  const authContext = await requireAuthContext(request, context);
  const formData = await request.formData();
  const intent = formData.get('intent');

  if (intent === 'setAppPublic') {
    // Perform mutation...
    return { success: true };
  }
  return { error: 'Unknown action' };
}
```

### Authentication
1. User signs up/logs in via API routes (`/api/auth/login`, `/api/auth/signup`)
2. Password verified with PBKDF2 (100k iterations, SHA-256)
3. Session created in KV (`SESSIONS`), cookie set with `httpOnly`, `sameSite: lax`
4. Email → userId mapping stored in KV (`EMAIL_TO_USER`)
5. Route loaders call `requireAuthContext()` which validates session and loads user/org/workspace data

### Onboarding Flow
1. Incomplete users are redirected to `/onboarding` before accessing app routes under `_app`.
2. The parent onboarding loader (`src/routes/_onboarding.tsx`) is intentionally minimal: session + `UserDO.getAuthBootstrap()` and onboarding completion checks.
3. Step-specific server data is loaded in child route loaders (for example welcome and org-slug) and can stream via promise-returning loader fields + React Suspense (`use()`/`<Await>` patterns).
4. `_onboarding.tsx` exports `shouldRevalidate` to avoid rerunning the parent loader on `/onboarding/*` → `/onboarding/*` navigations when `team` mode is unchanged.
5. Onboarding answers are stored in localStorage (`chiridion:onboarding:progress`) during the flow.
6. Final answers are persisted to `UserDO` via `POST /api/onboarding` with `completed_at`.
7. Org slug step is conditional (`owner + one member + zero deployed scripts`) and uses:
   - `POST /api/orgs/:id/check-slug` for debounced availability checks
   - `POST /api/orgs/:id/update-slug` for one-time slug updates
8. Slug uniqueness is enforced by `OrgSlugDO` (`claim/getOwner/release`), not KV.
9. On first post-onboarding thread creation, chat action injects invisible onboarding context and writes `~/.chiridion/profile.md`.

### Message Sending
1. User types message in `Chat.tsx`
2. WebSocket connects to `/ws/{workspace}` - Worker routes to container
3. Container runs `ws-server.mjs` which calls Claude SDK
4. Claude SDK stores messages in JSONL files (`~/.claude/projects/.../session.jsonl`)
5. Streaming responses sent back through WebSocket
6. Thread ID = Claude session_id (received on first message)

### Todo State Persistence
The floating todo list state persists across reconnections:
1. When `ws-server.mjs` sees a `TodoWrite` tool call, it broadcasts a `todo_state` event and saves to `/home/claude/.chiridion/todos/{threadId}.json`
2. On WebSocket init, the server reads the persisted file and sends `todo_state` to the client
3. On turn completion (`result` event), the persisted file is cleared

### Integration Token Refresh
- OAuth integrations with expiring tokens (for example Notion) store `token_expires_at` and are refreshed by `WorkspaceDO` alarms.
- BigQuery integrations now follow the same token lifecycle pattern: the encrypted `service_account_json` is used server-side to mint short-lived Google access tokens.
- Runtime environments receive `INT_BIGQUERY_*_ACCESS_TOKEN` instead of raw service account JSON whenever a token is available.
- After token refresh, updated credentials are pushed to both the running workspace container and all deployed workspace workers.

### Workspace Persistence (JuiceFS)
JuiceFS provides a FUSE-based distributed filesystem with SQLite metadata and R2 data storage:

1. Container entrypoint downloads JuiceFS SQLite metadata from R2
2. If no JuiceFS metadata exists but an old tar backup is found, migrates data
3. JuiceFS mounts at `R2_MOUNT_DIR` (defaults to `/home/claude`) with writeback caching
4. Data is stored in R2 at `{bucket}/chiridion-{org}-{workspace}/`
5. Background metadata upload loop runs every 60s

### Workspace Container Warmup
To reduce perceived latency from JuiceFS mount, container warmup happens server-side:
1. `_app.tsx` loader triggers `container.startForWorkspace()` via `waitUntil`
2. Container starts in background while page renders
3. By the time user opens chat, container is often already warm

### Threads
- Each thread belongs to a workspace
- Threads stored in `OrgDO` (one per organization)
- `ChatThreadDO` handles real-time preview state
- History queries threads across accessible workspaces

### App Previews
1. Deploy succeeds and enqueues screenshot job to `APP_SCREENSHOT_QUEUE`
2. Queue consumer renders app via Browser Rendering
3. JPEG previews stored in R2 under `app-previews/{orgId}/{workspaceId}/{scriptName}/current.jpg`
4. Apps page loads previews through `/api/apps/:scriptName/preview`

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

API routes are defined as React Router routes with loaders (GET) and actions (POST/PUT/DELETE) in `src/routes/api/`.

### Auth Routes
| Route | Method | Purpose |
|-------|--------|---------|
| `/api/auth/login` | POST | Login with email/password |
| `/api/auth/signup` | POST | Create new account |
| `/api/auth/logout` | POST | Clear session |
| `/api/auth/switch-org` | POST | Switch active organization |
| `/api/auth/switch-workspace` | POST | Switch active workspace |

### Organization Routes
| Route | Method | Purpose |
|-------|--------|---------|
| `/api/orgs/:id/invite` | POST | Create an invitation for an organization |
| `/api/orgs/:id/invite` | DELETE | Cancel or decline an invitation |
| `/api/orgs/:id/check-slug` | POST | Validate org slug format and availability |
| `/api/orgs/:id/update-slug` | POST | One-time org slug update during onboarding |

### Onboarding Routes
| Route | Method | Purpose |
|-------|--------|---------|
| `/api/onboarding` | POST | Save onboarding preferences to `UserDO` |

### Invitation Routes
| Route | Method | Purpose |
|-------|--------|---------|
| `/api/invitations/:orgId/:invitationId` | GET | Fetch invitation details |
| `/api/invitations/:orgId/:invitationId` | POST | Accept invitation |

### Workspace Routes
| Route | Method | Purpose |
|-------|--------|---------|
| `/api/workspaces/:id/fs/list` | GET | List directory contents |
| `/api/workspaces/:id/fs/read` | GET | Read file contents |
| `/api/workspaces/:id/fs/write` | POST | Write text file |
| `/api/workspaces/:id/fs/upload` | POST | Upload binary file (FormData) |
| `/api/workspaces/:id/fs/create` | POST | Create new file |
| `/api/workspaces/:id/fs/mkdir` | POST | Create directory |
| `/api/workspaces/:id/fs/move` | POST | Move/rename file |
| `/api/workspaces/:id/fs/delete` | POST | Delete file or directory |
| `/api/workspaces/:id/upload` | POST | Upload files to R2 (chat attachments) |
| `/api/workspaces/:id/download` | GET | Download files from R2 |
| `/api/workspaces/:id/uploads/*` | GET | Serve user-uploaded files from R2 (preview/download) |
| `/api/workspaces/:id/outputs/*` | GET | Stream agent-created output files for download/preview |

### Apps Routes
| Route | Method | Purpose |
|-------|--------|---------|
| `/api/apps/:scriptName/preview` | GET | Stream app preview screenshot |

### WebSocket Routes (Main Worker)
| Route | Purpose |
|-------|---------|
| `/ws/{workspace}` | Real-time chat streaming |
| `/ws/thread/{threadId}` | Thread preview state updates |

### OAuth Routes (Main Worker)
| Route | Method | Purpose |
|-------|--------|---------|
| `/api/auth/google` | GET | Initiate Google OAuth |
| `/api/auth/google/callback` | GET | Google OAuth callback |
| `/api/auth/github` | GET | Initiate GitHub OAuth |
| `/api/auth/github/callback` | GET | GitHub OAuth callback |

### MCP Routes (Main Worker)
| Route | Method | Purpose |
|-------|--------|---------|
| `/mcp/health` | GET | Health check |
| `/mcp` | POST | MCP protocol endpoint (streamable HTTP) |

MCP auth uses signed JWT tokens with `mcp` scope. Per-thread tokens are created when a WebSocket connects and passed to the container via `X-Chiridion-MCP-Token` header. The token includes the `thread_id` in the payload for secure thread context (can't be spoofed).

## Development

### Prerequisites
- Node.js 22+
- Bun (package manager - **always use `bun` instead of `npm`**)
- Docker (for Cloudflare Containers)
- Cloudflare account (for deployment)

### Local Development

**Full Cloudflare dev (recommended)**
```bash
bun run dev
```
Runs `react-router dev` with Cloudflare Vite plugin. Starts Docker proxy socket for FUSE mount access.
Default port: 3001 (override with `VITE_DEV_PORT`).

**Production build**
```bash
bun run build
```
Runs `react-router build`, outputs to `build/client/` and `build/server/`.

### Environment Variables

Create `.dev.vars`:
```
OPENROUTER_API_KEY=your_openrouter_key_here
OPENROUTER_PROVISIONING_KEY=your_provisioning_key_here
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
GITHUB_CLIENT_ID=your_github_client_id
GITHUB_CLIENT_SECRET=your_github_client_secret
```

| Variable | Description |
|----------|-------------|
| `OPENROUTER_API_KEY` | Fallback OpenRouter API key for LLM access |
| `OPENROUTER_PROVISIONING_KEY` | OpenRouter provisioning key for creating per-org API keys |
| `WORKER_BASE_URL` | Base URL for the main worker |
| `INTEGRATION_SECRET_KEY` | 256-bit key for encrypting integration credentials |
| `TOKEN_SIGNING_SECRET` | Secret for signing auth tokens |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `GITHUB_CLIENT_ID` | GitHub OAuth client ID |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth client secret |
| `DISPATCHER_MISSING_REGISTRY_MODE` | Dispatcher behavior when worker KV metadata is missing: `open` (fail-open), `legacy-open` (fail-open only for legacy hostnames), or `closed` (strict fail-closed) |

#### JuiceFS Container Variables (set automatically by worker)

| Variable | Description |
|----------|-------------|
| `JUICEFS_META_DIR` | Directory for JuiceFS SQLite metadata (default: `/var/lib/juicefs`) |
| `JUICEFS_CACHE_DIR` | Directory for JuiceFS FUSE cache (default: `/tmp/juicefs-cache`) |
| `JUICEFS_UPLOAD_DELAY` | Delay before uploading dirty data to R2 (default: `5s`) |
| `JUICEFS_BUFFER_SIZE` | Read/write buffer size in MB (default: `2048`) |
| `JUICEFS_CACHE_SIZE` | Max local cache size in MB (default: `4096` = 4GB, container has 8GB disk) |
| `DISABLE_JUICEFS` | Set to `1` to skip JuiceFS mount |

#### Sandbox Debug Variables (optional)

| Variable | Description |
|----------|-------------|
| `CHIRIDION_TRACE_EVENTS` | Set to `0` to disable ws-server trace writes |
| `CHIRIDION_DEBUG_STARTUP` | Log startup env snapshot (`1` to enable) |
| `CHIRIDION_DEBUG_SDK` | Log query options (`1` to enable) |
| `CHIRIDION_DEBUG_FS` | Run filesystem probes at startup (`1` to enable) |

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

### KV Namespaces

| Binding | Purpose |
|---------|---------|
| `EMAIL_TO_USER` | Maps email addresses to user IDs |
| `SESSIONS` | Session storage |
| `API_TOKENS` | API token storage |

### Observability

**Error Analytics** - SSR errors logged to Workers Analytics Engine.

| Binding | Dataset | Purpose |
|---------|---------|---------|
| `ERROR_ANALYTICS` | `chiridion_errors` | SSR error tracking |

**Querying errors:**
```sql
SELECT blob1 AS digest, blob2 AS message, blob3 AS path, SUM(double2) AS count
FROM chiridion_errors
WHERE timestamp > NOW() - INTERVAL '1' HOUR
GROUP BY digest, message, path
ORDER BY count DESC
```

**Live logs:** `npx wrangler tail --env <env>`

### Testing
```bash
# Unit tests (Vitest + jsdom)
bun run test

# Run tests once (CI mode)
bun run test:run

# All tests (unit + workers)
bun run test:all

# Workers runtime tests (Miniflare + Durable Objects)
bun run test:workers

# E2E tests (Playwright)
bun run test:e2e

# E2E with UI
bun run test:e2e:ui
```

### Build & Deploy
```bash
# Build for Cloudflare
bun run build:cf

# Deploy main worker
bun run deploy:main:prod
bun run deploy:main:staging
bun run deploy:main:dev-illiana
bun run deploy:main:dev-miguel

# Deploy dispatcher worker
bun run deploy:dispatcher:prod
bun run deploy:dispatcher:staging
```

### Admin CLI

Query live environments locally using remote DO namespace bindings.

```bash
# Quick CLI (starts wrangler, queries, exits)
bun run admin -- [env] [endpoint] [jq-filter]

# Examples
bun run admin -- staging overview
bun run admin -- prod users '.users[] | {name, email}'
bun run admin -- dev-illiana orgs
bun run admin -- staging threads
bun run admin -- workers  # List all user workers

# Interactive mode (keeps server running)
bun run admin:staging
bun run admin:prod
bun run admin:dev-illiana
```

| Endpoint | Description |
|----------|-------------|
| `/overview` | Users, orgs, membership counts |
| `/orgs` | All orgs with member details |
| `/users` | All users with org counts |
| `/threads` | All threads across orgs |
| `/kv-keys` | List KV keys (optional `?prefix=`) |
| `/r2/list` | List R2 objects (optional `?prefix=`) |
| `/workers` | List all user workers in dispatch namespace |

## Project Structure

```
chiridion-app/
├── src/
│   ├── routes.ts              # Route configuration
│   ├── root.tsx               # Root layout
│   ├── entry.server.tsx       # SSR entry
│   ├── entry.client.tsx       # Client hydration
│   ├── types.ts               # Shared types
│   ├── routes/
│   │   ├── _app.tsx           # Protected layout
│   │   ├── _onboarding.tsx    # Onboarding layout and flow guards
│   │   ├── _onboarding.*.tsx  # Onboarding screens (welcome, slug, q1-q6)
│   │   ├── _auth.tsx          # Auth layout
│   │   ├── _admin.tsx         # Admin layout
│   │   ├── _app.chat.$id.tsx  # Chat page
│   │   ├── _app.apps.tsx      # Apps listing
│   │   ├── _app.computer.$workspaceId.tsx  # File browser
│   │   ├── _app.connections.tsx # Integrations
│   │   ├── _app.history.tsx   # Chat history
│   │   ├── _app.settings.*.tsx # Settings pages
│   │   ├── invitations.$orgId.$invitationId.tsx # Public invitation
│   │   └── api/               # API route handlers
│   │       ├── auth.*.ts      # Auth endpoints
│   │       ├── workspaces.*.ts # Workspace endpoints
│   │       └── apps.*.ts      # Apps endpoints
│   ├── components/
│   │   ├── ui/                # shadcn/ui components
│   │   ├── Chat.tsx           # Chat with WebSocket
│   │   ├── onboarding/        # Onboarding UI components
│   │   ├── bug-report-preview/ # Bug report card + detail dialog
│   │   ├── sidebar/           # Navigation
│   │   ├── settings/          # Settings components
│   │   ├── admin/             # Admin components
│   │   └── floating-todo/     # Todo list UI
│   ├── lib/
│   │   ├── auth.server.ts     # Server auth helpers
│   │   ├── cloudflare.server.ts # CF env helpers
│   │   ├── cookies.server.ts  # Cookie utils
│   │   ├── utils.ts           # cn() helper
│   │   └── streaming/         # Stream event handling
│   └── styles/globals.css     # Tailwind + theme
├── workers/
│   ├── main/src/
│   │   ├── index.ts           # Worker entry
│   │   ├── auth.ts            # UserDO, OrgDO
│   │   ├── org-slug-registry.ts # OrgSlugDO uniqueness registry
│   │   ├── workspace.ts       # WorkspaceDO
│   │   ├── workspace-container.ts # ThreadSandbox
│   │   ├── durable-objects.ts # ChatThreadDO
│   │   ├── cf-api-proxy.ts    # Deploy proxy
│   │   ├── mcp-handler.ts     # MCP server
│   │   └── openrouter-keys.ts # Per-org API key provisioning
│   ├── dispatcher/src/        # WfP subdomain router
│   └── admin-cli/             # Admin CLI tool
├── sandbox/
│   ├── entrypoint.sh          # Container startup
│   ├── ws-server.mjs          # Claude SDK WebSocket
│   ├── control-plane.mjs      # Container management API
│   └── skills/                # Agent skills
├── tests/                     # Vitest unit tests
├── e2e/                       # Playwright E2E tests
├── scripts/                   # Dev/deploy scripts
├── wrangler.jsonc             # Main worker config
├── vite.config.ts             # Vite configuration
├── components.json            # shadcn/ui config
└── package.json
```

## Durable Objects

### UserDO (per user)
- User profile, password hash, OAuth providers
- Organization memberships and roles
- Workspace access permissions
- Onboarding preferences + first-chat personalization marker

### OrgDO (per organization)
- Organization info, members, invitations
- Thread storage
- Worker scripts with preview status
- Integration credentials (org-level)
- API tokens
- OpenRouter API key (encrypted, per-org)
- One-time onboarding slug update guard (`owner + one-member + zero-apps`)

### OrgSlugDO (per slug)
- Atomic slug ownership (`claim`, `getOwner`, `release`)
- Prevents concurrent slug collisions during org creation/onboarding

### WorkspaceDO (per workspace)
- Workspace metadata, members, access levels
- Workspace-specific integrations
- Audit logs

### ChatThreadDO (per thread)
- WebSocket connection state
- Preview worker list (out-of-band state)

### ThreadSandbox (per workspace)
- Container lifecycle using `@cloudflare/containers`
- WebSocket upgrade handling
- Control plane API endpoints

### ChiridionMcp (MCP Agent)
- MCP server implementation
- Deployment management tools
- Context-aware operations

### Storage APIs

Durable Objects use SQLite-backed storage with two APIs:

| API | Use Case |
|-----|----------|
| `ctx.storage.sql` | Relational data, queries, joins, complex transactions |
| `ctx.storage.kv` | Simple key-value data (sync, fast) |

```typescript
// SQLite for complex data
this.ctx.storage.sql.exec("SELECT * FROM users WHERE org_id = ?", orgId);

// Sync KV for simple key-value (no await needed)
this.ctx.storage.kv.put("config", { theme: "dark" });
const config = this.ctx.storage.kv.get("config");
```

**Important:** Always use the sync KV API (`ctx.storage.kv`). Never use the legacy async API (`await ctx.storage.get/put`).

### Background Tasks

Use `waitUntil` from `cloudflare:workers` to spawn fire-and-forget background tasks:

```typescript
import { waitUntil } from 'cloudflare:workers';

// Fire-and-forget background task
waitUntil(
  someAsyncOperation().catch(err => console.error('Background task failed:', err))
);
```

**Important:** Import `waitUntil` directly - don't pass `ctx` through function calls. This keeps APIs clean and avoids prop drilling.

## Known Issues & Solutions

See `STREAMING_BUG_SUMMARY.md` for streaming-related bugs and fixes.

### Common Issues

1. **Durable Objects not working locally**: Use `bun run dev` (wrangler-based dev)
2. **Streaming not working**: Ensure `includePartialMessages: true` in ws-server.mjs
3. **API key not found**: Check `.dev.vars` has `OPENROUTER_API_KEY`
4. **Docker cache stale**: Add version comment to `entrypoint.sh` to invalidate
5. **Session not persisting**: Check cookies and DO worker is running
6. **JuiceFS mount fails**: Check `/dev/fuse` exists, verify R2 credentials
7. **Type errors after route changes**: Run `bun run typecheck` to regenerate types

## Testing Strategy

### Unit Tests (`tests/`)
- Config: `vitest.config.ts` with jsdom
- Auth helpers, Chat rendering, content parsing, stream playback

### Integration Tests (`tests/integration/`)
- Config: `vitest.integration.config.ts`
- Page accessibility, auth gating, API route auth requirements

### Workers Tests (`workers/main/tests/`)
- Config: `vitest.workers.config.ts`
- Full auth flow through RPC → Durable Objects

### E2E Tests (`e2e/`)
- Config: `playwright.config.ts`
- Signup/login/logout, chat streaming, tool use, persistence
