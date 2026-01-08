/**
 * Custom worker entry point that wraps OpenNext and exports Durable Objects.
 *
 * This pattern allows you to:
 * 1. Add custom routes (WebSockets, API proxies, etc.)
 * 2. Export Durable Object classes for persistence
 * 3. Fall back to Next.js for all other routes
 */

// @ts-ignore - .open-next/worker.js is generated at build time
import openNextHandler from "../../.open-next/worker.js";

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
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Add custom route handlers here
    // Example: WebSocket upgrade
    // if (url.pathname.startsWith('/ws/') && request.headers.get('Upgrade') === 'websocket') {
    //   return handleWebSocket(request, env);
    // }

    // Example: Custom API route bypassing Next.js
    // if (url.pathname.startsWith('/api/custom/')) {
    //   return handleCustomApi(request, env);
    // }

    // Pass all other requests to Next.js
    return openNextHandler.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
