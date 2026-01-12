/**
 * Worker entry point that serves the React SPA, handles API routes and auth using Hono.
 *
 * This pattern allows you to:
 * 1. Handle API routes in the worker using Hono's routing (e.g., /api/*)
 * 2. Handle authentication routes (/api/auth/*)
 * 3. Export Durable Object classes for persistence
 * 4. Serve static assets for all other routes (React SPA)
 */

import { Hono } from "hono";
import { authRoutes } from "./auth-routes.js";

// To add Durable Objects:
// 1. Copy workers/src/durable-objects.example.ts and customize it
// 2. Import and export your DO class here
// 3. Add the binding to wrangler.jsonc
//
// Example:
// import { MyDO } from "./my-do.js";
// export { MyDO };

interface Env {
  ASSETS: Fetcher;
  // Add your DO bindings here:
  // MY_DO: DurableObjectNamespace<MyDO>;
}

const app = new Hono<{ Bindings: Env }>();

// Mount auth routes
app.route("/api/auth", authRoutes);

// API routes
app.get("/api/hello", (c) => {
  return c.json({
    message: "Hello from Cloudflare Workers!",
    timestamp: new Date().toISOString(),
  });
});

// Add more API routes here
// Example: POST /api/items
// app.post("/api/items", async (c) => {
//   const body = await c.req.json();
//   // Handle create item...
//   return c.json({ success: true });
// });

// 404 for unmatched API routes
app.all("/api/*", (c) => {
  return c.json({ error: "Not found" }, 404);
});

// Serve static assets for all other routes
// The React app will handle client-side routing
app.all("*", async (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

export default app;
