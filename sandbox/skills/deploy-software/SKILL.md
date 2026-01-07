---
name: deploy-software
description: Deploy software to the internet using Cloudflare Workers. Use this skill when the user asks to deploy APIs, web apps, or fullstack applications. Handles Workers, Durable Objects with SQLite storage, and real-time WebSocket connections.
license: Complete terms in LICENSE.txt
---

# Deploying Software to Cloudflare

This skill guides deployment of production software to Cloudflare's edge network using Workers, Durable Objects, and the globally installed wrangler CLI.

## Core Principles

1. **Always use the globally installed `wrangler` binary** - Do not install wrangler locally
2. **Deploy Cloudflare Workers** - The infrastructure is already configured for Worker deployments
3. **Use Durable Objects with SQLite backends** - This is the primary persistence mechanism
4. **Use Next.js for fullstack web apps** - Combine with OpenNext for Cloudflare deployment
5. **Use shadcn/ui for frontend components** - The CLI is available via `npx shadcn@latest add <component>`

## What You Can Build

- **APIs** - RESTful or GraphQL endpoints running on Workers
- **Simple web apps** - Static sites with dynamic Worker functions
- **Fullstack web apps** - Next.js applications with server-side rendering and API routes

## Deployment Commands

```bash
# Deploy to production
wrangler deploy

# Deploy to staging/preview
wrangler deploy --env staging

# View logs
wrangler tail

# Local development
wrangler dev
```

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

## Fullstack Apps with Next.js

For fullstack applications, use Next.js with OpenNext for Cloudflare:

```bash
# Create Next.js app
npx create-next-app@latest my-app

# Add OpenNext for Cloudflare
npm install @opennextjs/cloudflare

# Add shadcn/ui components
npx shadcn@latest init
npx shadcn@latest add button card form input
```

### Wrangler Configuration for Next.js

```jsonc
{
  "name": "my-nextjs-app",
  "main": ".open-next/worker.js",
  "compatibility_date": "2024-09-23",
  "compatibility_flags": ["nodejs_compat"],
  "assets": {
    "directory": ".open-next/assets",
    "binding": "ASSETS"
  }
}
```

## Best Practices

1. **One DO class per domain concept** - e.g., `UserDO`, `RoomDO`, `SessionDO`
2. **Use SQLite for all persistence** - Avoid the legacy KV storage API
3. **Initialize schema in constructor** - Use `CREATE TABLE IF NOT EXISTS`
4. **Use hibernatable WebSockets for real-time** - Saves significant costs
5. **Tag WebSockets for routing** - Makes broadcasting to subsets efficient
6. **Use transactions for multi-step operations** - Ensures consistency
7. **Set auto-response for heartbeats** - Prevents unnecessary wake-ups
