# Chiridion App - Agent Documentation

## Overview

Chiridion is an AI chat application built on Cloudflare's edge infrastructure. It uses the Claude SDK running inside Cloudflare Containers to provide streaming AI responses through WebSockets.

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
   - Tailwind CSS for styling

2. **Worker** (`worker/`)
   - Cloudflare Workers with Durable Objects
   - `ChatThreadDO` - Manages individual chat sessions
   - `ChatIndexDO` - Indexes all chat threads
   - `ThreadSandbox` - Executes Claude SDK in containers

3. **Sandbox** (`sandbox/`)
   - `driver.mjs` - Runs inside Cloudflare Container
   - Calls Claude SDK `query()` with streaming enabled
   - Outputs NDJSON events to stdout

## Key Files

| File | Purpose |
|------|---------|
| `src/components/Chat.tsx` | Main chat UI with streaming state management |
| `src/app/chat/[id]/page.tsx` | Chat page route |
| `worker/durable-objects.ts` | WebSocket handler, container orchestration |
| `worker/index.ts` | Worker entry point |
| `sandbox/driver.mjs` | Claude SDK runner inside container |
| `wrangler.jsonc` | Cloudflare Worker configuration |

## Data Flow

### Message Sending
1. User types message in `Chat.tsx`
2. Message sent via WebSocket to `ChatThreadDO`
3. DO spawns container with `sandbox/driver.mjs`
4. Driver calls `query({ prompt, options: { sessionId, includePartialMessages: true } })`
5. SDK streams events as NDJSON to stdout
6. Container output parsed by DO and forwarded via WebSocket
7. Frontend updates React state with streaming content

### SDK Event Types
- `system` (subtype: `init`) - Session initialization
- `stream_event` - Real-time streaming:
  - `content_block_start` - New text block
  - `content_block_delta` - Incremental text chunk
  - `message_delta` - Stop reason
- `assistant` - Full/partial assistant message
- `user` - Tool results
- `result` - Query complete

## Development

### Prerequisites
- Node.js 22+
- Docker (for Cloudflare Containers)
- Cloudflare account (for deployment)

### Local Development
```bash
# Install dependencies
npm install

# Set up environment variables
cp .dev.vars.example .dev.vars
# Add ANTHROPIC_API_KEY to .dev.vars

# Start the development server
npm run dev:cf
```

### Testing
```bash
# Run unit tests
npm run test

# Run E2E tests (requires server running)
BASE_URL=http://localhost:8787 npx playwright test
```

### Build & Deploy
```bash
# Build for Cloudflare
npm run build:cf

# Deploy to Cloudflare
npm run deploy
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Claude API key for SDK |
| `NEXTJS_ENV` | Environment (development/production) |

## Known Issues & Solutions

See `STREAMING_BUG_SUMMARY.md` for detailed documentation of streaming-related bugs and fixes.

### Common Issues

1. **Streaming not working**: Ensure `includePartialMessages: true` is set in driver.mjs
2. **API key not found**: Check `.dev.vars` has `ANTHROPIC_API_KEY` set
3. **Docker cache stale**: Add version comment to `driver.mjs` to invalidate cache
4. **Flash bug**: Don't clear streaming content on `result` event

## Testing Strategy

### Unit Tests (`tests/`)
- React component tests with Vitest + Testing Library
- Test streaming state management logic

### E2E Tests (`e2e/`)
- Playwright tests against running server
- `chat.spec.ts` - Basic chat flow, streaming verification
- `streaming.spec.ts` - Detailed streaming behavior
- `debug-deltas.spec.ts` - Event timeline debugging

## Project Structure

```
chiridion-app/
├── src/
│   ├── app/           # Next.js app router pages
│   ├── components/    # React components
│   └── lib/           # Utilities
├── worker/            # Cloudflare Worker code
├── sandbox/           # Container driver code
├── e2e/               # Playwright E2E tests
├── tests/             # Vitest unit tests
├── public/            # Static assets
├── wrangler.jsonc     # Worker config
└── package.json
```
