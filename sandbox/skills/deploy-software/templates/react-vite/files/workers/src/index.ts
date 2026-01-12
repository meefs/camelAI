/**
 * Worker entry point that serves the React SPA and handles API routes.
 *
 * This pattern allows you to:
 * 1. Handle API routes in the worker (e.g., /api/*)
 * 2. Export Durable Object classes for persistence
 * 3. Serve static assets for all other routes (React SPA)
 */

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

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // API routes
    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, url, env);
    }

    // Serve static assets for all other routes
    // The React app will handle client-side routing
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

async function handleApi(request: Request, url: URL, _env: Env): Promise<Response> {
  // Example: GET /api/hello
  if (url.pathname === "/api/hello" && request.method === "GET") {
    return Response.json({
      message: "Hello from Cloudflare Workers!",
      timestamp: new Date().toISOString(),
    });
  }

  // Add more API routes here
  // Example: POST /api/items
  // if (url.pathname === "/api/items" && request.method === "POST") {
  //   const body = await request.json();
  //   // Handle create item...
  // }

  return Response.json({ error: "Not found" }, { status: 404 });
}
