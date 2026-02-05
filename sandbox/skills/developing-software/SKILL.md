---
name: developing-software
description: Deploy software to the internet using Cloudflare Workers. Use this skill when the user asks to deploy APIs, web apps, fullstack applications, or AI-powered apps. Handles Workers, Durable Objects with SQLite storage, real-time WebSocket connections, and AI chat agents with the Vercel AI SDK.
license: Complete terms in LICENSE.txt
---

# Deploying Software to Cloudflare

This skill guides deployment of production software to Cloudflare's edge network using Workers, Durable Objects, and the globally installed wrangler CLI.

## Core Principles

1. **Always use the globally installed `wrangler` binary** - Do not install wrangler locally
2. **Use `create-worker` to scaffold projects** - Do not use `wrangler init` or `npm create cloudflare`
3. **Deploy Cloudflare Workers** - The infrastructure is already configured for Worker deployments
4. **Use Durable Objects with SQLite backends** - This is the primary persistence mechanism
5. **Use React Router 7 framework mode for fullstack web apps** - It is the successor to Remix; default to route `loader()`/`action()` patterns, not SPA-style client data fetching
6. **Use shadcn/ui for frontend components** - The CLI is globally installed, use `shadcn add <component>` (NOT `npx shadcn`)
7. **Avoid large package installations** - Do not install large frameworks like OpenNext, Next.js, or other heavy dependencies that take a long time to install. The `create-worker` template has everything pre-configured.

## Creating New Projects

Use the `create-worker` command to scaffold new projects. Do NOT use `wrangler init` or `npm create cloudflare`.

```bash
# Create a fullstack React app with defaults
create-worker my-app

# Customize the UI style and theme
create-worker my-app --style nova --theme blue

# Create with authentication boilerplate
create-worker my-app --auth

# Full customization example
create-worker my-app --style lyra --theme emerald --font figtree --radius large

# See all options
create-worker --help
```

### Style Options

| Option | Values | Default | Description |
|--------|--------|---------|-------------|
| `--style` | vega, nova, maia, lyra, mira | mira | UI style preset |
| `--theme` | neutral, amber, blue, cyan, emerald, fuchsia, green, indigo, lime, orange, pink, purple, red, rose, sky, teal, violet, yellow, zinc, gray, stone | neutral | Theme color |
| `--base-color` | neutral, zinc, gray, stone | neutral | Base gray color (must match theme if theme is zinc/gray/stone) |
| `--font` | inter, noto-sans, nunito-sans, figtree | inter | Font family |
| `--radius` | default, none, small, medium, large | default | Border radius |
| `--menu-color` | default, inverted | default | Menu color style |
| `--menu-accent` | subtle, bold | subtle | Menu accent style |
| `--auth` | - | - | Add session-based authentication with login page and auth API routes |

## Deployment Commands

```bash
# Deploy to production
yarn deploy

# View logs
wrangler tail
```

> **Note:** `wrangler dev` is not available. Deployments are fast - just deploy and iterate in the cloud.

## Post-Deployment Verification

After deploying a worker, use MCP tools to verify the deployment and get the live URL:

1. **Get the deployed app URL** - Use the `list_apps` MCP tool to retrieve the URL of deployed workers
2. **Take a screenshot** - Use the `take_app_screenshot` MCP tool to capture the deployed app and verify it looks correct

```bash
# Example workflow after yarn deploy
# 1. List apps to get the URL
#    → Use MCP tool: list_apps

# 2. Take a screenshot to verify the UI
#    → Use MCP tool: take_app_screenshot with the script name
```

This ensures the deployment succeeded and the app renders correctly before sharing the URL with the user.

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

## KV Storage APIs

In addition to SQLite, Durable Objects provide key-value storage APIs. There are two variants:

### Synchronous KV Storage (Recommended)

SQLite-backed Durable Objects have access to a fast, synchronous KV API via `ctx.storage.kv`. This is the preferred KV storage method when using SQLite-backed DOs.

```typescript
export class MyDurableObject extends DurableObject<Env> {
  async handleRequest() {
    // Synchronous operations - no await needed
    this.ctx.storage.kv.put("key", { foo: "bar" });
    const value = this.ctx.storage.kv.get("key");

    // Delete a key
    this.ctx.storage.kv.delete("key");

    // Check if key exists
    const exists = this.ctx.storage.kv.has("key");

    // List keys with optional prefix
    const keys = this.ctx.storage.kv.list(); // returns Map
    const prefixed = this.ctx.storage.kv.list({ prefix: "user:" });

    // Batch operations
    this.ctx.storage.kv.put(new Map([
      ["key1", "value1"],
      ["key2", "value2"]
    ]));

    // Get multiple keys
    const values = this.ctx.storage.kv.get(["key1", "key2"]); // returns Map
  }
}
```

| Method | Description |
|--------|-------------|
| `kv.get(key)` | Get a single value |
| `kv.get(keys[])` | Get multiple values (returns Map) |
| `kv.put(key, value)` | Store a single value |
| `kv.put(entries)` | Store multiple values (accepts Map or entries) |
| `kv.delete(key)` | Delete a single key |
| `kv.delete(keys[])` | Delete multiple keys |
| `kv.has(key)` | Check if key exists |
| `kv.list(options?)` | List keys with optional prefix/limit |

### Legacy Async KV Storage

The original async KV storage API is still available and works with both SQLite-backed and legacy KV-backed Durable Objects:

```typescript
export class MyDurableObject extends DurableObject<Env> {
  async handleRequest() {
    // Async operations - requires await
    await this.ctx.storage.put("key", { foo: "bar" });
    const value = await this.ctx.storage.get("key");

    // Delete
    await this.ctx.storage.delete("key");

    // List keys
    const entries = await this.ctx.storage.list({ prefix: "user:" });

    // Batch operations
    await this.ctx.storage.put({
      key1: "value1",
      key2: "value2"
    });

    // Get multiple
    const values = await this.ctx.storage.get(["key1", "key2"]);
  }
}
```

### When to Use KV vs SQLite

| Use Case | Recommendation |
|----------|----------------|
| Simple key-value data | Sync KV (`ctx.storage.kv`) |
| Relational data with queries | SQLite (`ctx.storage.sql`) |
| Full-text search, joins, aggregations | SQLite |
| Session/config data | Sync KV |
| High-frequency reads of single keys | Sync KV |
| Complex transactions | SQLite |

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
# Create React app with Vite
create-worker my-app

# Or with custom styling
create-worker my-app --style nova --theme blue

# Or with authentication
create-worker my-app --auth

cd my-app

# Dependencies are pre-cached - do not run yarn install

# Add shadcn/ui components (globally installed - do NOT use npx)
shadcn add button card form input

# Local development
yarn dev

# Deploy
yarn deploy
```

The template includes:
- React 19 with React Router 7
- Vite for fast builds and HMR
- Tailwind CSS v4
- shadcn/ui pre-configured
- TypeScript
- Cloudflare Worker entry in `workers/app.ts`
- Server data/mutation patterns via route `loader()` and `action()`

### Wrangler Configuration for React + Vite

The template creates this `wrangler.jsonc`:

```jsonc
{
  "name": "my-app",
  "main": "./workers/app.ts",
  "compatibility_date": "2024-12-01",
  "compatibility_flags": ["nodejs_compat"],
  "assets": {
    "directory": "./public/",
    "binding": "ASSETS"
  }
}
```

### Adding API Routes

For JSON API endpoints, add a React Router route under `app/routes/` and wire it in `app/routes.ts`.
Use route `loader()` for GET handlers and `action()` for POST/PUT/DELETE handlers.

```typescript
// app/routes/api.items.ts
import type { Route } from "./+types/api.items";
import { data } from "react-router";

export async function loader({ context }: Route.LoaderArgs) {
  const id = context.cloudflare.env.EXAMPLE_DO.idFromName("global");
  const stub = context.cloudflare.env.EXAMPLE_DO.get(id);
  const items = await stub.listItems();

  return data({ items });
}

export async function action({ request, context }: Route.ActionArgs) {
  const payload = await request.json();

  const id = context.cloudflare.env.EXAMPLE_DO.idFromName("global");
  const stub = context.cloudflare.env.EXAMPLE_DO.get(id);

  await stub.createItem(payload);
  return data({ ok: true }, { status: 201 });
}

// app/routes.ts
import { route, type RouteConfig } from "@react-router/dev/routes";

export default [
  route("api/items", "routes/api.items.ts"),
] satisfies RouteConfig;
```

### Organizing API Routes

For larger APIs, split endpoints by resource:

```typescript
// app/routes.ts
export default [
  route("api/items", "routes/api.items.ts"),
  route("api/items/:id", "routes/api.items.$id.ts"),
] satisfies RouteConfig;
```

## AI-Powered Apps

The template includes pre-configured AI chat capabilities using the Vercel AI SDK with OpenRouter. **The code is commented out by default**—just uncomment to enable:

1. In `wrangler.jsonc`: Uncomment the `Chat` DO binding and migration
2. In `workers/app.ts`: Uncomment the `Chat` export and `routeAgentRequest` call
3. In `app/routes.ts`: Add the chat route

Features include:
- Automatic conversation history persistence
- Resumable streaming via WebSockets
- Tool use and function calling
- Web search plugin for real-time information

**See [AI-APPS.md](AI-APPS.md) for setup, customization, and common pitfalls.**

## Project Snapshots with JuiceFS

JuiceFS clone creates instant project snapshots. This is faster than git and captures the complete project state including node_modules and build artifacts.

### Automatic Build Snapshots

**Every successful `yarn build` automatically creates a snapshot.** These are stored outside the project at:

```
~/.chiridion/snapshots/{projectName}/
  2026-02-04T15-30-00-000Z/
  2026-02-04T15-31-00-000Z/
  ...
```

The last 50 snapshots are kept automatically. Use `--no-snapshot` to skip: `yarn build --no-snapshot`

### Manual Snapshots

For named checkpoints (more memorable than timestamps):

```bash
# Snapshot before risky changes
juicefs clone ~/my-app ~/.chiridion/snapshots/my-app/before-refactor

# Snapshot after a feature works
juicefs clone ~/my-app ~/.chiridion/snapshots/my-app/auth-working
```

### Rollback

When something breaks, restore instantly:

```bash
# List available snapshots
ls ~/.chiridion/snapshots/my-app/

# Restore from a timestamped build snapshot
rm -rf ~/my-app
juicefs clone ~/.chiridion/snapshots/my-app/2026-02-04T15-30-00-000Z ~/my-app

# Or from a named snapshot
rm -rf ~/my-app
juicefs clone ~/.chiridion/snapshots/my-app/auth-working ~/my-app
```

### When to Create Manual Snapshots

Since builds auto-snapshot, manual snapshots are mainly useful for:

1. **Before risky non-build changes** - Config changes, dependency updates
2. **Named milestones** - "auth-working", "before-refactor" are easier to find than timestamps
3. **Before experimenting** - Try ideas without fear

### Why JuiceFS Instead of Git

| Aspect | JuiceFS Clone | Git |
|--------|---------------|-----|
| Speed | Instant (copy-on-write) | Slow (hashing, indexing) |
| Scope | Complete project state | Only tracked files |
| node_modules | Included | Excluded (.gitignore) |
| Build artifacts | Included | Excluded |
| Complexity | Single command | Stage, commit, manage index |
| Rollback | Instant clone | Reset, checkout, potential conflicts |

## Best Practices

1. **One DO class per domain concept** - e.g., `UserDO`, `RoomDO`, `SessionDO`
2. **Use SQLite for relational data** - Queries, joins, and complex transactions
3. **Use sync KV for simple key-value data** - `ctx.storage.kv` is fast and synchronous
4. **Initialize schema in constructor** - Use `CREATE TABLE IF NOT EXISTS`
4. **Use hibernatable WebSockets for real-time** - Saves significant costs
5. **Tag WebSockets for routing** - Makes broadcasting to subsets efficient
6. **Use transactions for multi-step operations** - Ensures consistency
7. **Set auto-response for heartbeats** - Prevents unnecessary wake-ups
