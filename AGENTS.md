# Chiridion App - Agent Documentation

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

2. **Worker** (`worker/`)
   - Cloudflare Workers with Durable Objects
  - **Chat DOs:**
    - `ChatThreadDO` - Manages individual chat sessions
    - `ChatIndexDO` - Indexes all chat threads and projects per org
   - **Auth DOs:**
     - `SessionDO` - Session state with 30-day expiry
     - `UserDO` - User profiles and password hashes
     - `OrgDO` - Organizations, members, and invitations
   - `ThreadSandbox` - Executes Claude SDK in containers

3. **Sandbox** (`sandbox/`)
   - `driver.mjs` - Runs inside Cloudflare Container
   - Calls Claude SDK `query()` with streaming enabled
   - Outputs NDJSON events to stdout

## Key Files

| File | Purpose |
|------|---------|
| `src/components/Chat.tsx` | Main chat UI with streaming state management |
| `src/contexts/AuthContext.tsx` | React context for auth state |
| `src/app/login/page.tsx` | Login page |
| `src/app/signup/page.tsx` | Signup page |
| `src/lib/auth.ts` | Cookie handling, validation helpers |
| `src/lib/auth-do.ts` | Functions to interact with auth DOs |
| `worker/durable-objects.ts` | WebSocket handler, container orchestration |
| `worker/auth.ts` | SessionDO, UserDO, OrgDO implementations |
| `worker/password.ts` | PBKDF2 password hashing |
| `worker/index.ts` | Worker entry point |
| `scripts/dev.mjs` | Dev runner (watch + rebuild + wrangler) |
| `sandbox/driver.mjs` | Claude SDK runner inside container |

## Configuration Files

| File | Purpose |
|------|---------|
| `wrangler.jsonc` | Main production/deployment config |
| `wrangler.build.jsonc` | OpenNext build config |
| `components.json` | shadcn/ui configuration |
| `.mcp.json` | MCP server config (shadcn registry access) |

## UI Components (shadcn/ui)

This project uses [shadcn/ui](https://ui.shadcn.com) for UI components built on Radix UI primitives.

### Configuration
- **Style:** radix-mira (compact/dense interface)
- **Base color:** zinc
- **Font:** Inter
- **Radius:** 0.5rem (medium)
- **Icons:** Lucide

### Key Files
| File | Purpose |
|------|---------|
| `components.json` | shadcn configuration and registry settings |
| `src/lib/utils.ts` | `cn()` helper for merging Tailwind classes |
| `src/components/ui/` | Installed shadcn components |
| `src/app/globals.css` | Theme CSS variables (light/dark) |

### Adding Components

Use the shadcn MCP server tools to browse and install components:
- `shadcn_list_items` - List available components
- `shadcn_get_item` - Get component details
- `shadcn_add_item` - Install a component

Or via CLI:
```bash
npx shadcn@latest add <component>
```

### Styling Guidelines
- Use the `cn()` utility from `@/lib/utils` for conditional classes
- Theme colors use CSS variables defined in `globals.css`
- Components support light/dark mode via `.dark` class on root
- Prefer shadcn components over custom implementations when available

## Data Flow

### Authentication
1. User signs up/logs in via `/api/auth/signup` or `/api/auth/login`
2. Password verified with PBKDF2 (100k iterations, SHA-256)
3. Session created in `SessionDO`, cookie set with `httpOnly`, `sameSite: lax`
4. Email → userId mapping stored in KV (`EMAIL_TO_USER`)
5. `AuthContext` fetches session state from `/api/auth/me`

### Message Sending
1. User types message in `Chat.tsx`
2. Message sent via WebSocket to `ChatThreadDO`
3. DO spawns container with `sandbox/driver.mjs`
4. Driver calls `query({ prompt, options: { sessionId, includePartialMessages: true } })`
5. SDK streams events as NDJSON to stdout
6. Container output parsed by DO and forwarded via WebSocket
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
| `/api/invitations/[orgId]/[invitationId]` | GET, POST | View/accept invitation |

### Chat (auth required)
| Route | Method | Purpose |
|-------|--------|---------|
| `/api/threads` | GET, POST | List/create threads |
| `/api/threads/[id]` | GET, DELETE | Get/delete thread |
| `/api/threads/[id]/messages` | GET, POST | Get/add thread messages |
| `/api/projects` | GET, POST | List/create projects |
| `/api/projects/[id]` | GET, PUT, DELETE | Get/update/delete project |
| `/api/chat` | POST | Send message (REST fallback) |
| `/ws/[threadId]` | WebSocket | Real-time chat |

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
Watches files, rebuilds the OpenNext bundle, and restarts the local worker as needed (reload-style, not HMR).

### Environment Variables

Create `.dev.vars`:
```
ANTHROPIC_API_KEY=your_key_here
```

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Claude API key for SDK |
| `NEXTJS_ENV` | Environment (development/production) |

### KV Namespaces

| Binding | Purpose |
|---------|---------|
| `EMAIL_TO_USER` | Maps email addresses to user IDs |

### Testing
```bash
# Run unit tests
npm run test

# Run E2E tests (requires server running)
npm run test:e2e
```

### Build & Deploy
```bash
# Build for Cloudflare
npm run build:cf

# Deploy to production
npm run deploy

# Deploy to staging
npm run deploy:staging
```

## Project Structure

```
chiridion-app/
├── src/
│   ├── app/
│   │   ├── api/
│   │   │   ├── auth/        # Auth endpoints
│   │   │   ├── chat/        # Chat endpoint
│   │   │   ├── invitations/ # Invitation acceptance
│   │   │   ├── orgs/        # Org management
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
├── worker/
│   ├── index.ts             # Worker entry (production)
│   ├── durable-objects.ts   # Chat DOs
│   ├── auth.ts              # Auth DOs
│   └── password.ts          # Password hashing
├── sandbox/                 # Container driver code
├── scripts/                 # Dev scripts
│   └── dev.mjs              # Watch + rebuild + wrangler
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
2. **Streaming not working**: Ensure `includePartialMessages: true` is set in driver.mjs
3. **API key not found**: Check `.dev.vars` has `ANTHROPIC_API_KEY` set
4. **Docker cache stale**: Add version comment to `driver.mjs` to invalidate cache
5. **Session not persisting**: Ensure cookies are set with correct domain and the DO worker is running

## Testing Strategy

### Unit Tests (`tests/`)
- `auth-validation.test.ts` - Email/password validation
- `password.test.ts` - Password hashing/verification
- `AuthContext.test.tsx` - Auth state management
- React component tests with Vitest + Testing Library

### E2E Tests (`e2e/`)
- `auth.spec.ts` - Login/signup flows
- `chat.spec.ts` - Basic chat flow, streaming verification
- `streaming.spec.ts` - Detailed streaming behavior
