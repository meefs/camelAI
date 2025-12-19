// Custom worker that wraps OpenNext and handles WebSocket + Durable Objects
// @ts-ignore - .open-next/worker.js is generated at build time
import openNextHandler from "../.open-next/worker.js";
import { ChatIndexDO, ChatThreadDO, type ChatEnv } from "./durable-objects.js";
import { SessionDO, UserDO, OrgDO, type AuthEnv } from "./auth.js";
import { Sandbox } from '@cloudflare/sandbox';

// Export Sandbox as ThreadSandbox to match wrangler.jsonc class_name
export { Sandbox as ThreadSandbox };

interface Env extends ChatEnv, AuthEnv {
  ASSETS: Fetcher;
  NEXTJS_ENV?: string;
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  CF_DISPATCH_NAMESPACE?: string;
}


export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Handle WebSocket upgrade requests at /ws/{threadId}
    const wsMatch = url.pathname.match(/^\/ws\/([^\/]+)$/);
    if (wsMatch && request.headers.get('Upgrade') === 'websocket') {
      const threadId = wsMatch[1];
      const threadStub = env.CHAT_THREAD.get(env.CHAT_THREAD.idFromName(threadId));
      // Forward the upgrade request directly. The DO reads the external origin from forwarded headers.
      return threadStub.fetch(request);
    }

    // Pass all other requests to OpenNext/Next.js
    return openNextHandler.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

// Export Durable Object classes
export { ChatIndexDO, ChatThreadDO };
export { SessionDO, UserDO, OrgDO };

// Re-export OpenNext's DO handlers if needed for caching
// @ts-ignore - .open-next/worker.js is generated at build time
export { DOQueueHandler, DOShardedTagCache } from "../.open-next/worker.js";
