/**
 * Example Durable Object with SQLite storage.
 *
 * To use this:
 * 1. Copy this file to a new file (e.g., my-do.ts)
 * 2. Customize the class name and methods
 * 3. Export from workers/src/index.ts: export { MyDO } from "./my-do.js"
 * 4. Add to wrangler.jsonc:
 *    "durable_objects": {
 *      "bindings": [{ "name": "MY_DO", "class_name": "MyDO" }]
 *    },
 *    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["MyDO"] }]
 */

import { DurableObject } from "cloudflare:workers";

interface Env {
  MY_DO: DurableObjectNamespace<MyDO>;
}

export class MyDO extends DurableObject<Env> {
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

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/items") {
      const items = this.sql.exec("SELECT * FROM items ORDER BY created_at DESC").toArray();
      return Response.json({ items });
    }

    if (request.method === "POST" && url.pathname === "/items") {
      const { id, data } = await request.json() as { id: string; data: string };
      this.sql.exec("INSERT OR REPLACE INTO items (id, data) VALUES (?, ?)", id, data);
      return Response.json({ success: true, id });
    }

    if (request.method === "DELETE" && url.pathname.startsWith("/items/")) {
      const id = url.pathname.split("/").pop();
      this.sql.exec("DELETE FROM items WHERE id = ?", id);
      return Response.json({ success: true });
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  }
}
