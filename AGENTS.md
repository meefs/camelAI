# Chiridion App - Agent Documentation

> **Note to agents:** Keep this file up to date. When you add new features, workers, API routes, or make significant architectural changes, update the relevant sections of this document.

## Overview

Chiridion is an AI coding assistant built on Cloudflare's edge infrastructure. Users can chat with a Claude-powered agent that has access to a persistent computer (workspace) where files persist across sessions. Users can create applications by having the agent write code, then publish those applications to live URLs hosted by Chiridion. The app supports integrations (connections) to external services that can be used in applications.

**Key Capabilities:**
- Real-time AI chat with streaming responses via WebSockets
- Persistent workspaces with R2-backed filesystem
- One-click app deployment to `*.chiridion.app` subdomains
- Multi-tenant authentication with users, organizations, and workspaces
- External service integrations for reading/writing data
- Organization invitation emails sent through Cloudflare Email bindings

## Architecture

```
┌─────────────────┐     ┌──────────────────────┐     ┌─────────────────────┐
│  React Router   │────▶│   Cloudflare Worker  │────▶│       Sprites       │
│   (SSR + WS)    │◀────│   (Durable Objects)  │◀────│  (exec + fs + SDK)  │
└─────────────────┘     └──────────────────────┘     └─────────────────────┘
         │                        │                           │
         │                        ▼                           │
         │              ┌──────────────────┐                  │
         │              │  Dispatcher WfP  │                  │
         │              │ (User App Hosts) │                  │
         │              └──────────────────┘                  │
         │                        │                           │
         ▼                        ▼                           ▼
┌─────────────────┐     ┌──────────────────┐
│   R2 Storage    │     │    OpenRouter    │
│  (Files/Assets) │     │   (LLM Access)   │
└─────────────────┘     └──────────────────┘
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
     - Sprites-backed workspace runtime (`workers/main/src/workspace-container.ts`)
     - WebSocket routing (one sprite runtime per workspace)
     - OAuth flow handling
     - MCP server endpoint (`/mcp`) with API key auth
   - `dispatcher/` - Routes `*.chiridion.app` to user workers (Workers for Platforms)
   - `admin-cli/` - Local-only admin CLI for querying live environments

3. **Sandbox** (`sandbox/`)
   - `claude-runner.mjs` - Claude SDK runner process executed via sprite exec
   - `memory-logger.mjs` - Runner helper for loading user profile context
   - `session-search/` - Session search CLI/daemon used inside workspaces
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
| `src/lib/email.server.ts` | Cloudflare invite-email sending helpers (`send_email` binding + invite URLs) |
| `src/lib/email/templates/org-invitation-email.tsx` | React Email invitation template component |

### Worker Core
| File | Purpose |
|------|---------|
| `workers/main/src/index.ts` | Worker entry: WebSocket, OAuth, MCP, SSR |
| `workers/main/src/auth.ts` | `UserDO`, `OrgDO` implementations |
| `workers/main/src/org-slug-registry.ts` | `OrgSlugDO` slug ownership registry |
| `workers/main/src/workspace.ts` | `WorkspaceDO` implementation |
| `workers/main/src/workspace-container.ts` | Sprites workspace runtime + websocket/filesystem proxy |
| `workers/main/src/durable-objects.ts` | `ChatThreadDO` for thread state |
| `workers/main/src/cf-api-proxy.ts` | Cloudflare API proxy for deploys |
| `workers/main/src/mcp-handler.ts` | MCP server with `ChiridionMcp` |
| `workers/main/src/openrouter-keys.ts` | OpenRouter API key provisioning for per-org usage |

### Sandbox
| File | Purpose |
|------|---------|
| `sandbox/claude-runner.mjs` | Claude SDK runner executable (stdin/stdout NDJSON) |
| `sandbox/memory-logger.mjs` | Runner helper utilities |
| `sandbox/session-search/src/cli.mjs` | Session search CLI entrypoint |
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
6. Intermediate answers are persisted to `UserDO` via `POST /api/onboarding`.
7. Org slug step is conditional (`owner + one member + zero deployed scripts`) and uses:
   - `POST /api/orgs/:id/check-slug` for debounced availability checks
   - `POST /api/orgs/:id/update-slug` for one-time slug updates
8. Slug uniqueness is enforced by `OrgSlugDO` (`claim/getOwner/release`), not KV.
9. Final submit calls `POST /api/onboarding/complete`, which server-side: persists completion (`completed_at`), applies optional slug update, creates the first thread, writes `~/.chiridion/profile.md`, and returns `threadId` + onboarding system context + redirect target.
10. The client reuses the existing pending-prefill handoff (`pendingMessage:newThread`) to inject a one-time `<chiridion system message>...</chiridion system message>` into that onboarding-created thread.

### Custom Connection "Other" Handoff
1. In the Connections page add-connection picker, selecting `other` shows a confirmation modal explaining the user will be moved to chat.
2. On continue, the client creates a new thread via the `/chat` route action (`intent=createThread`).
3. The client seeds `sessionStorage` key `pendingMessage:newThread` with a `<chiridion system message>...</chiridion system message>` payload targeting the new `threadId`.
4. The app navigates to `/chat/{threadId}?newThread=1`, where `Chat.tsx` consumes and sends the hidden seeded message to the agent.

### Message Sending
1. User types message in `Chat.tsx`
2. WebSocket connects to `/ws/{workspace}` - Worker validates access and forwards to `ChatThreadDO`
3. On accepted user messages, `ChatThreadDO` updates thread metadata (`updated_at` and `user_message_count`) via `OrgDO.touchThread`
4. `ChatThreadDO` opens/attaches a sprite exec session running `claude-runner.mjs`
5. `claude-runner.mjs` calls Claude SDK `query()` and streams events over stdout
6. `ChatThreadDO` multiplexes/replays events to connected chat clients
7. Claude SDK stores messages in JSONL files on the sprite at `/home/sprite/.claude/projects/-home-sprite/{threadId}.jsonl`

### Slash Commands
Users can send Claude SDK slash commands by typing the command as their entire message (nothing else). `ChatThreadDO.formatAttributedUserMessage()` detects these and strips the author prefix so the SDK receives the bare command. Supported commands:
- `/compact` - Manually compact the conversation context
- `/context` - Show current context window usage
- `/debug` - Toggle debug mode
- `/insights` - Show conversation insights
- `/security-review` - Run a security review

The allowlist is maintained in `ChatThreadDO.SLASH_COMMANDS` (`workers/main/src/durable-objects.ts`).

### Chat Attachment Uploads (R2 Multipart)
1. Client starts multipart upload via `POST /api/workspaces/:id/upload?action=mpu-create` with `originalName` and `contentType`.
2. Client slices files into parts (>= 5MB except last) and uploads in parallel via `PUT /api/workspaces/:id/upload?action=mpu-uploadpart&uploadId=...&filename=...&partNumber=...`.
3. Client finalizes via `POST /api/workspaces/:id/upload?action=mpu-complete&uploadId=...&filename=...` with collected `{ partNumber, etag }[]`.
4. On failure, client performs best-effort cleanup via `DELETE /api/workspaces/:id/upload?action=mpu-abort&uploadId=...&filename=...`.
5. The upload API is multipart-only (legacy single-upload POST without an `action` is not supported).

### Todo State Persistence
The floating todo list state persists across reconnections:
1. When `claude-runner.mjs` sees a `TodoWrite` tool call, it emits a `todo_state` event
2. `ChatThreadDO` stores the latest todo state in DO storage (`chatTodos`) and replays it on chat WebSocket init
3. On turn completion (`result` event), `ChatThreadDO` clears persisted todo state

### MCP Prompt Replay
MCP-driven thread prompts (for example connection setup and bug report capture) are persisted in `ChatThreadDO` and replayed to newly connected chat websocket clients (`/ws/{workspace}`):
1. `ChatThreadDO` stores pending prompt payloads in DO storage when MCP triggers a prompt
2. On chat WebSocket init, `ChatThreadDO` sends current preview target state and then replays any unexpired pending prompts
3. Prompts are removed when the client responds or when they expire (`30m` for connection setup, `5m` for bug report capture)

### Integration Token Refresh
- OAuth integrations with expiring tokens (for example Notion) store `token_expires_at` and are refreshed by `WorkspaceDO` alarms.
- BigQuery integrations now follow the same token lifecycle pattern: the encrypted `service_account_json` is used server-side to mint short-lived Google access tokens.
- Runtime environments receive `INT_BIGQUERY_*_ACCESS_TOKEN` instead of raw service account JSON whenever a token is available.
- After token refresh, updated credentials are pushed to both the running workspace sprite runtime and all deployed workspace workers.

### Workspace Runtime Provisioning
Sprites are provisioned eagerly when a workspace is created (`WorkspaceDO.createWorkspace` calls `WorkspaceContainer.provisionSpriteForWorkspace`).
Runtime startup is now on-demand from chat/API paths; dashboard route loaders no longer trigger warmup.

### Threads
- Each thread belongs to a workspace
- Threads stored in `OrgDO` (one per organization)
- `ChatThreadDO` handles real-time preview target state (single active target: deployed app or file)
- History queries threads across accessible workspaces

### App Previews
1. Deploy succeeds and enqueues screenshot job to `APP_SCREENSHOT_QUEUE`
2. Queue consumer renders app via Browser Rendering
3. JPEG previews stored in R2 under `app-previews/{orgId}/{workspaceId}/{scriptName}/current.jpg`
4. Apps page loads previews through `/api/apps/:scriptName/preview`

### Notebook File Previews
- Notebook previews are read-only and render cells in the chat preview panel.
- The panel header shows a notebook-only view toggle: `Report` (default) and `Notebook`.
- Report mode applies editorial rendering: extracted notebook header metadata, table-of-contents sidebar from markdown `##`/`###`, setup-cell filtering heuristics, hidden code (outputs only), and styled inset text-output wells.
- Notebook mode keeps full cell-by-cell rendering with execution gutters, line-numbered code, and per-cell outputs.
- Vega/Vega-Lite chart outputs render client-side via Vega/Vega-Lite/Vega-Embed CDN loading and are embedded with SVG renderer.
- Supported Vega chart payloads include both direct mime types (`application/vnd.vegalite.v*+json`, `application/vnd.vega.v*+json`) and Altair `text/html` `vegaEmbed(...)` wrappers (spec extraction path, including `NaN` literal normalization).
- Plotly outputs (`application/vnd.plotly.v1+json`) render client-side via Plotly CDN loading directly in the notebook DOM (no iframe wrapper), with responsive sizing and light/dark-aware theming.
- DataFrame-style HTML tables (`text/html` with `<table>`) are parsed and rendered natively in React with theme-aware styling, index-column support, and horizontal overflow handling.
- Pandas Styler and complex span-based tables (`rowspan`/`colspan`, e.g. MultiIndex columns) intentionally fall back to sandboxed iframe rendering.
- Non-chart `text/html` outputs still render in sandboxed iframes (`allow-scripts allow-downloads`) for generic HTML preview.

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
| `/api/orgs/:id/invite` | POST | Create an invitation for an organization and send invite email via Cloudflare when configured |
| `/api/orgs/:id/invite` | DELETE | Cancel or decline an invitation |
| `/api/orgs/:id/check-slug` | POST | Validate org slug format and availability |
| `/api/orgs/:id/update-slug` | POST | One-time org slug update during onboarding |

### Onboarding Routes
| Route | Method | Purpose |
|-------|--------|---------|
| `/api/onboarding` | POST | Save onboarding preferences to `UserDO` |
| `/api/onboarding/complete` | POST | Finalize onboarding and return first-thread redirect + one-time onboarding prefill context |

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
| `/api/workspaces/:id/fs/content/*` | GET | Stream raw workspace file contents for inline preview/download |
| `/api/workspaces/:id/fs/write` | POST | Write text file |
| `/api/workspaces/:id/fs/upload` | POST | Upload binary file (FormData) |
| `/api/workspaces/:id/fs/create` | POST | Create new file |
| `/api/workspaces/:id/fs/mkdir` | POST | Create directory |
| `/api/workspaces/:id/fs/move` | POST | Move/rename file |
| `/api/workspaces/:id/fs/delete` | POST | Delete file or directory |
| `/api/workspaces/:id/upload` | POST / PUT / DELETE | Upload files to R2 (chat attachments), including multipart lifecycle actions (`mpu-create`, `mpu-uploadpart`, `mpu-complete`, `mpu-abort`) |
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
| `/ws/logs?scriptName={name}` | Real-time log streaming for deployed workers |

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

MCP auth uses signed JWT tokens with `mcp` scope. Per-thread tokens are created when a WebSocket connects and passed to the workspace runtime via `X-Chiridion-MCP-Token` header. The token includes the `thread_id` in the payload for secure thread context (can't be spoofed).

## Development

### Prerequisites
- Node.js 22+
- Bun (package manager - **always use `bun` instead of `npm`**)
- Docker (optional for legacy local container tooling)
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
SPRITES_TOKEN=your_sprites_api_token_here
WORKER_BASE_URL=https://your-ngrok-subdomain.ngrok-free.app
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
GITHUB_CLIENT_ID=your_github_client_id
GITHUB_CLIENT_SECRET=your_github_client_secret
```

| Variable | Description |
|----------|-------------|
| `OPENROUTER_API_KEY` | Fallback OpenRouter API key for LLM access |
| `OPENROUTER_PROVISIONING_KEY` | OpenRouter provisioning key for creating per-org API keys |
| `SPRITES_TOKEN` | Sprites API bearer token for workspace runtime creation/exec |
| `SPRITES_API_BASE_URL` | Optional Sprites API base URL (default: `https://api.sprites.dev`) |
| `SPRITES_NAME_PREFIX` | Optional sprite name prefix (default: `chiridion`) |
| `SPRITES_EAGER_PROVISION_ON_CREATE` | Set to `0` to disable eager sprite creation during workspace creation (default: enabled) |
| `WORKER_BASE_URL` | Base URL for the main worker (must be publicly reachable from sprites; use ngrok in local dev) |
| `INTEGRATION_SECRET_KEY` | 256-bit key for encrypting integration credentials |
| `TOKEN_SIGNING_SECRET` | Secret for signing auth tokens |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `GITHUB_CLIENT_ID` | GitHub OAuth client ID |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth client secret |
| `EMAIL_FROM_ADDRESS` | Sender address for Cloudflare email binding fallback |
| `GMAIL_SERVICE_ACCOUNT_EMAIL` | Google service account email for Gmail API |
| `GMAIL_SERVICE_ACCOUNT_PRIVATE_KEY` | Private key (PEM) for Gmail API authentication |
| `GMAIL_SENDER_EMAIL` | Email address to send from (e.g., `no-reply@chiridion.ai`) |
| `DISPATCHER_MISSING_REGISTRY_MODE` | Dispatcher behavior when worker KV metadata is missing: `open` (fail-open), `legacy-open` (fail-open only for legacy hostnames), or `closed` (strict fail-closed) |

#### Gmail API (Recommended for Production)

Invitation emails are sent via Gmail API using a Google Workspace service account:

1. **Google Cloud Console:**
   - Create a service account in your project
   - Enable the Gmail API
   - Download the JSON key file

2. **Google Workspace Admin (admin.google.com):**
   - Go to Security → API Controls → Domain-wide Delegation
   - Add the service account's client ID
   - Grant scope: `https://www.googleapis.com/auth/gmail.send`

3. **Environment Variables:**
   - `GMAIL_SERVICE_ACCOUNT_EMAIL`: The service account email (e.g., `chiridion-email@project.iam.gserviceaccount.com`)
   - `GMAIL_SERVICE_ACCOUNT_PRIVATE_KEY`: The private key from the JSON file (include `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----`)
   - `GMAIL_SENDER_EMAIL`: The Workspace user to send as (e.g., `no-reply@chiridion.ai`)

#### Cloudflare Email Binding (Fallback)

Falls back to Cloudflare's `send_email` binding if Gmail is not configured. Note: This only works for verified email addresses.

- Configure the binding in Wrangler for each environment and set `EMAIL_FROM_ADDRESS` in vars/secrets.

#### Sandbox Debug Variables (optional)

| Variable | Description |
|----------|-------------|
| `CHIRIDION_TRACE_EVENTS` | Set to `0` to disable claude-runner trace writes |
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

# Deploy tail worker (for user worker logs)
bun run deploy:tail:prod
bun run deploy:tail:staging
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

### Sprite CLI

The `sprite` CLI is a globally installed binary for interacting with workspace sprite computers. No installation needed.

```bash
# List all sprites
sprite ls

# Execute a command on a sprite
sprite exec -s <sprite-name> -- <command>

# Open interactive shell
sprite console -s <sprite-name>
```

Sprite names follow the pattern `chiridion-ws-{workspaceId}`. Each workspace has one sprite.

**Pulling chat JSONL from a sprite:**
```bash
# JSONL files live at /home/sprite/.claude/projects/-home-sprite/{threadId}.jsonl
sprite exec -s chiridion-ws-{workspaceId} -- cat /home/sprite/.claude/projects/-home-sprite/{threadId}.jsonl > {threadId}.jsonl
```

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
│   │   ├── chat-file-preview/  # File/notebook preview renderers (report + notebook modes)
│   │   ├── sidebar/           # Navigation
│   │   ├── settings/          # Settings components
│   │   ├── admin/             # Admin components
│   │   └── floating-todo/     # Todo list UI
│   ├── lib/
│   │   ├── auth.server.ts     # Server auth helpers
│   │   ├── cloudflare.server.ts # CF env helpers
│   │   ├── cookies.server.ts  # Cookie utils
│   │   ├── email.server.ts    # Invite email sending helpers
│   │   ├── email/templates/   # React Email templates
│   │   ├── utils.ts           # cn() helper
│   │   └── streaming/         # Stream event handling
│   └── styles/globals.css     # Tailwind + theme
├── workers/
│   ├── main/src/
│   │   ├── index.ts           # Worker entry
│   │   ├── auth.ts            # UserDO, OrgDO
│   │   ├── org-slug-registry.ts # OrgSlugDO uniqueness registry
│   │   ├── workspace.ts       # WorkspaceDO
│   │   ├── workspace-container.ts # Sprites workspace runtime
│   │   ├── durable-objects.ts # ChatThreadDO
│   │   ├── cf-api-proxy.ts    # Deploy proxy
│   │   ├── mcp-handler.ts     # MCP server
│   │   └── openrouter-keys.ts # Per-org API key provisioning
│   ├── dispatcher/src/        # WfP subdomain router
│   └── admin-cli/             # Admin CLI tool
├── sandbox/
│   ├── claude-runner.mjs      # Claude SDK runner executable
│   ├── memory-logger.mjs      # User profile loader helper
│   ├── session-search/        # Session search CLI/daemon
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
- Active preview target state (out-of-band, one target at a time: app or file)

### Workspace Runtime (per workspace)
- Sprites lifecycle + provisioning
- Chat WebSocket forwarding to `ChatThreadDO`, which bridges to sprite exec
- Filesystem and command execution via Sprites exec API

### ChiridionMcp (MCP Agent)
- MCP server implementation
- Deployment management tools
- Thread-scoped preview controls (for example `set_file_preview` and `set_app_preview` to set the active preview target)
- Context-aware operations

### WorkerLogsDO (per deployed script)
- Stores logs from user-deployed workers (up to 10,000 entries per script)
- Receives logs from tail worker via RPC
- Provides log retrieval API with pagination (`getLogs`, `getStats`)
- WebSocket support for real-time streaming (replays recent logs on connect)
- Compatible with `wrangler tail` via CF API proxy interception

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

See repository history/PR context for legacy streaming bug investigations and fixes.

### Common Issues

1. **Durable Objects not working locally**: Use `bun run dev` (wrangler-based dev)
2. **Streaming not working**: Ensure `includePartialMessages: true` in `sandbox/claude-runner.mjs`
3. **API key not found**: Check `.dev.vars` has `OPENROUTER_API_KEY`
4. **Session not persisting**: Check cookies and DO worker is running
5. **Type errors after route changes**: Run `bun run typecheck` to regenerate types

## Testing Strategy

### Unit Tests (`tests/`)
- Config: `vitest.config.ts` with jsdom
- Auth helpers, Chat rendering, content parsing, stream playback

### Workers Tests (`workers/main/tests/`)
- Config: `vitest.workers.config.ts`
- Full auth flow through RPC → Durable Objects

### E2E Tests (`e2e/`)
- Config: `playwright.config.ts`
- Signup/login/logout, chat streaming, tool use, persistence
