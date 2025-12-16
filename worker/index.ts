// Custom worker that wraps OpenNext and handles WebSocket + Durable Objects
// @ts-ignore - .open-next/worker.js is generated at build time
import openNextHandler from "../.open-next/worker.js";
import { ChatIndexDO, ChatThreadDO, type ChatEnv } from "./durable-objects.js";
import { getSandbox, Sandbox } from '@cloudflare/sandbox';

// Export Sandbox as ThreadSandbox to match wrangler.jsonc class_name
export { Sandbox as ThreadSandbox };

interface Env extends ChatEnv {
  ASSETS: Fetcher;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Test endpoint for sandbox debugging
    if (url.pathname === '/_test/sandbox') {
      const cmd = url.searchParams.get('cmd') || 'echo hello';
      const sandboxId = url.searchParams.get('id') || 'test-sandbox';
      const sandbox = getSandbox(env.SANDBOX, sandboxId);

      try {
        const result = await sandbox.exec(cmd, {
          env: { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY },
          timeout: 60000
        });
        return new Response(JSON.stringify({
          success: result.success,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
        }, null, 2), { headers: { 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }, null, 2), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // Handle WebSocket upgrade requests at /ws/{threadId}
    const wsMatch = url.pathname.match(/^\/ws\/([^\/]+)$/);
    if (wsMatch && request.headers.get('Upgrade') === 'websocket') {
      const threadId = wsMatch[1];
      const threadStub = env.CHAT_THREAD.get(env.CHAT_THREAD.idFromName(threadId));
      // Forward to the thread DO's WebSocket handler
      return threadStub.fetch(new Request(new URL('/websocket', url.origin), request));
    }

    // Pass all other requests to OpenNext/Next.js
    return openNextHandler.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

// Export Durable Object classes
export { ChatIndexDO, ChatThreadDO };

// Re-export OpenNext's DO handlers if needed for caching
// @ts-ignore - .open-next/worker.js is generated at build time
export { DOQueueHandler, DOShardedTagCache } from "../.open-next/worker.js";
