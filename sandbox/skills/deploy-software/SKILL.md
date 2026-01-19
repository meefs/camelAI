---
name: deploy-software
description: Deploy software to the internet using Cloudflare Workers. Use this skill when the user asks to deploy APIs, web apps, or fullstack applications. Handles Workers, Durable Objects with SQLite storage, and real-time WebSocket connections.
license: Complete terms in LICENSE.txt
---

# Deploying Software to Cloudflare

This skill guides deployment of production software to Cloudflare's edge network using Workers, Durable Objects, and the globally installed wrangler CLI.

## Core Principles

1. **Always use the globally installed `wrangler` binary** - Do not install wrangler locally
2. **Use `create-worker` to scaffold projects** - Do not use `wrangler init` or `npm create cloudflare`
3. **Deploy Cloudflare Workers** - The infrastructure is already configured for Worker deployments
4. **Use Durable Objects with SQLite backends** - This is the primary persistence mechanism
5. **Use React + Vite for fullstack web apps** - With React Router and Tailwind CSS pre-configured
6. **Use shadcn/ui for frontend components** - The CLI is available via `npx shadcn@latest add <component>`

## Creating New Projects

Use the `create-worker` command to scaffold new projects. Do NOT use `wrangler init` or `npm create cloudflare`.

```bash
# Create a fullstack React app (recommended)
create-worker react-vite my-app

# Create with authentication boilerplate
create-worker react-vite my-app --auth

# See available templates
create-worker --help
```

### Available Templates

| Template | Description |
|----------|-------------|
| `react-vite` | React app with Vite, React Router, Tailwind CSS v4, and shadcn/ui pre-configured |

### Template Options

| Option | Description |
|--------|-------------|
| `--auth` | Add session-based authentication with login page and auth API routes |

## Deployment Commands

```bash
# Deploy to production
wrangler deploy

# Deploy to staging/preview
wrangler deploy --env staging

# View logs
wrangler tail
```

> **Note:** `wrangler dev` is not available. Deployments are fast - just deploy and iterate in the cloud.

## Durable Objects with SQLite Storage

SQLite-backed Durable Objects are the recommended persistence layer. Each Durable Object instance has its own private SQLite database with up to 10GB of storage.

### Configuration

In `wrangler.jsonc`, use `new_sqlite_classes` for SQLite-backed DOs:

```jsonc
{
  "durable_objects": {
    "bindings": [
      {
        "name": "MY_DO",
        "class_name": "MyDurableObject"
      }
    ]
  },
  "migrations": [
    {
      "tag": "v1",
      "new_sqlite_classes": ["MyDurableObject"]
    }
  ]
}
```

### SQLite Storage API

Access SQLite via `this.ctx.storage.sql`:

```typescript
import { DurableObject } from "cloudflare:workers";

export class MyDurableObject extends DurableObject<Env> {
  sql = this.ctx.storage.sql;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Initialize schema
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        created_at INTEGER DEFAULT (unixepoch())
      )
    `);
  }

  async getItem(id: string) {
    const result = this.sql.exec(
      "SELECT * FROM items WHERE id = ?",
      id
    ).one();
    return result;
  }

  async setItem(id: string, data: string) {
    this.sql.exec(
      "INSERT OR REPLACE INTO items (id, data) VALUES (?, ?)",
      id,
      data
    );
  }

  async listItems() {
    return this.sql.exec("SELECT * FROM items ORDER BY created_at DESC").toArray();
  }
}
```

### Key SQLite Methods

| Method | Description |
|--------|-------------|
| `sql.exec(query, ...params)` | Execute a SQL statement with optional parameters |
| `.one()` | Return a single row (or null) |
| `.toArray()` | Return all rows as an array |
| `.raw()` | Return raw column arrays instead of objects |

### Transactions

Use `this.ctx.storage.transactionSync()` for atomic operations:

```typescript
this.ctx.storage.transactionSync(() => {
  this.sql.exec("UPDATE accounts SET balance = balance - ? WHERE id = ?", amount, fromId);
  this.sql.exec("UPDATE accounts SET balance = balance + ? WHERE id = ?", amount, toId);
});
```

### Point-in-Time Recovery (PITR)

SQLite-backed DOs support restoring to any point in the past 30 days:

```typescript
// Get a bookmark for current state
const bookmark = await this.ctx.storage.getCurrentBookmark();

// Restore to a previous point
await this.ctx.storage.restoreFromBookmark(previousBookmark);
```

## Hibernatable WebSockets

Durable Objects support WebSocket connections that can hibernate to save costs. During hibernation, the DO is evicted from memory but connections remain open.

### Why Use Hibernatable WebSockets

- **Cost savings** - No duration charges during idle periods
- **Persistent connections** - Clients stay connected even when DO hibernates
- **Automatic wake** - DO recreates when a message arrives

### Implementation

```typescript
import { DurableObject } from "cloudflare:workers";

export class WebSocketDO extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);

    // Accept with hibernation support
    this.ctx.acceptWebSocket(server);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  // Called when a message arrives (even after hibernation)
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const data = typeof message === "string" ? message : new TextDecoder().decode(message);

    // Broadcast to all connected clients
    for (const socket of this.ctx.getWebSockets()) {
      socket.send(data);
    }
  }

  // Called when connection closes
  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
    ws.close(code, reason);
  }

  // Called on connection error
  async webSocketError(ws: WebSocket, error: unknown) {
    console.error("WebSocket error:", error);
    ws.close(1011, "Unexpected error");
  }
}
```

### Key Hibernation APIs

| Method | Description |
|--------|-------------|
| `ctx.acceptWebSocket(ws, tags?)` | Accept WebSocket with hibernation support |
| `ctx.getWebSockets(tag?)` | Get all connected WebSockets (optionally filtered by tag) |
| `ws.serializeAttachment(value)` | Store up to 2KB of state per connection |
| `ws.deserializeAttachment()` | Retrieve stored connection state |
| `ctx.setWebSocketAutoResponse(request, response)` | Auto-respond to pings without waking DO |

### Auto-Response for Ping/Pong

Avoid waking the DO for heartbeat messages:

```typescript
constructor(ctx: DurableObjectState, env: Env) {
  super(ctx, env);
  // Automatically respond to "ping" with "pong" without waking
  ctx.setWebSocketAutoResponse(
    new WebSocketRequestResponsePair("ping", "pong")
  );
}
```

### Persisting State Across Hibernation

Store per-connection metadata that survives hibernation:

```typescript
async fetch(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const userId = url.searchParams.get("userId");

  const webSocketPair = new WebSocketPair();
  const [client, server] = Object.values(webSocketPair);

  this.ctx.acceptWebSocket(server);

  // Store user info (survives hibernation, max 2KB)
  server.serializeAttachment({ userId, connectedAt: Date.now() });

  return new Response(null, { status: 101, webSocket: client });
}

async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
  // Retrieve stored state after hibernation wake
  const attachment = ws.deserializeAttachment();
  console.log(`Message from user ${attachment.userId}`);
}
```

### Tagging WebSockets

Organize connections by tags for targeted messaging:

```typescript
// Accept with tags
this.ctx.acceptWebSocket(server, ["room:123", "user:456"]);

// Get all sockets in a room
const roomSockets = this.ctx.getWebSockets("room:123");
for (const socket of roomSockets) {
  socket.send(JSON.stringify({ type: "room-message", data }));
}
```

## Fullstack Apps with React + Vite

For fullstack applications, use the `create-worker` command:

```bash
# Create React app with Vite (recommended)
create-worker react-vite my-app

# Or with authentication
create-worker react-vite my-app --auth

cd my-app
npm install

# Add shadcn/ui components (already configured)
npx shadcn@latest add button card form input

# Local development
npm run dev

# Deploy
npm run deploy
```

The template includes:
- React 19 with React Router 7
- Vite for fast builds and HMR
- Tailwind CSS v4
- shadcn/ui pre-configured
- TypeScript
- Hono for type-safe API routing
- Worker with example API route at `/api/hello`

### Wrangler Configuration for React + Vite

The template creates this `wrangler.jsonc`:

```jsonc
{
  "name": "my-app",
  "main": "workers/src/index.ts",
  "compatibility_date": "2024-12-01",
  "compatibility_flags": ["nodejs_compat"],
  "assets": {
    "directory": "dist",
    "binding": "ASSETS"
  }
}
```

### Adding API Routes

API routes are defined in `workers/src/index.ts` using [Hono](https://hono.dev):

```typescript
import { Hono } from "hono";

interface Env {
  ASSETS: Fetcher;
}

const app = new Hono<{ Bindings: Env }>();

app.get("/api/items", (c) => {
  return c.json({ items: [] });
});

app.post("/api/items", async (c) => {
  const body = await c.req.json();
  // Handle create item...
  return c.json({ success: true });
});

// 404 for unmatched API routes
app.all("/api/*", (c) => {
  return c.json({ error: "Not found" }, 404);
});

// Serve static assets for all other routes
app.all("*", async (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

export default app;
```

### Organizing Routes with Hono

For larger apps, organize routes into separate files:

```typescript
// workers/src/items-routes.ts
import { Hono } from "hono";

export const itemsRoutes = new Hono();

itemsRoutes.get("/", (c) => c.json({ items: [] }));
itemsRoutes.post("/", async (c) => {
  const body = await c.req.json();
  return c.json({ success: true });
});

// workers/src/index.ts
import { itemsRoutes } from "./items-routes.js";

app.route("/api/items", itemsRoutes);
```

## Best Practices

1. **One DO class per domain concept** - e.g., `UserDO`, `RoomDO`, `SessionDO`
2. **Use SQLite for all persistence** - Avoid the legacy KV storage API
3. **Initialize schema in constructor** - Use `CREATE TABLE IF NOT EXISTS`
4. **Use hibernatable WebSockets for real-time** - Saves significant costs
5. **Tag WebSockets for routing** - Makes broadcasting to subsets efficient
6. **Use transactions for multi-step operations** - Ensures consistency
7. **Set auto-response for heartbeats** - Prevents unnecessary wake-ups
