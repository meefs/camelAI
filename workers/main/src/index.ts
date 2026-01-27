/**
 * Main Chiridion Worker - Composition Root
 *
 * Routes:
 * - /client/v4/* → CF API proxy for wrangler deploys
 * - /mcp/* → MCP protocol
 * - /api/auth/:provider → User OAuth (Google, GitHub)
 * - /api/integrations/slack/* → Slack OAuth
 * - /api/threads/:id/preview → Thread preview API
 * - /ws/thread/:id → Thread preview WebSocket
 * - /ws/:workspace → Chat WebSocket
 * - * → React Router SSR
 */

import { createRequestHandler } from 'react-router';
import type { Env, Route } from './types.js';
import { handleScreenshotQueue, type AppScreenshotJob } from './screenshot-queue.js';

// Route handlers
import { handleCfProxy } from './routes/cf-proxy.js';
import { handleMcp } from './routes/mcp.js';
import { handleThreadPreview } from './routes/threads.js';
import { handleOAuthStart, handleOAuthCallback } from './routes/oauth.js';
import { handleSlackOAuthStart, handleSlackOAuthCallback } from './routes/integrations.js';
import { handleThreadWebSocket, handleChatWebSocket } from './routes/websocket.js';

// Re-exports for wrangler
export { ChiridionMcp } from './mcp-handler.js';
export { WorkspaceContainer as ThreadSandbox } from './workspace-container.js';
export { ChatThreadDO } from './durable-objects.js';
export { UserDO, OrgDO } from './auth.js';
export { WorkspaceDO } from './workspace.js';

// Extend React Router's AppLoadContext
declare module 'react-router' {
  export interface AppLoadContext {
    cloudflare: { env: Env; ctx: ExecutionContext };
  }
}

// =============================================================================
// Route Table
// =============================================================================

const routes: Route[] = [
  // CF API Proxy
  { method: 'ALL', path: /^\/client\/v4\//, handler: handleCfProxy },

  // MCP
  { method: 'ALL', path: /^\/mcp(\/|$)/, handler: handleMcp },

  // Thread Preview API
  { method: 'POST', path: /^\/api\/threads\/([^/]+)\/preview$/, handler: handleThreadPreview },

  // User OAuth
  { method: 'GET', path: /^\/api\/auth\/(google|github)$/, handler: handleOAuthStart },
  { method: 'GET', path: /^\/api\/auth\/(google|github)\/callback$/, handler: handleOAuthCallback },

  // Integration OAuth
  { method: 'GET', path: /^\/api\/integrations\/slack\/oauth$/, handler: handleSlackOAuthStart },
  { method: 'GET', path: /^\/api\/integrations\/slack\/callback$/, handler: handleSlackOAuthCallback },

  // WebSocket routes
  { method: 'GET', path: /^\/ws\/thread\/([^/]+)$/, handler: handleThreadWebSocket, websocket: true },
  { method: 'GET', path: /^\/ws\/[^/]+$/, handler: handleChatWebSocket, websocket: true },
];

// =============================================================================
// React Router Handler (hoisted to module scope)
// =============================================================================

// @ts-expect-error - virtual module provided by @react-router/dev
const reactRouterHandler = createRequestHandler(
  () => import('virtual:react-router/server-build'),
  import.meta.env.MODE
);

// =============================================================================
// Main Router
// =============================================================================

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const method = req.method;
    const isWebSocket = req.headers.get('Upgrade') === 'websocket';

    for (const route of routes) {
      if (isWebSocket && !route.websocket) continue;
      if (route.websocket && !isWebSocket) continue;
      if (route.method !== 'ALL' && route.method !== method) continue;

      const match = url.pathname.match(route.path);
      if (!match) continue;

      return route.handler({ req, env, ctx, url, match });
    }

    if (isWebSocket) {
      return new Response('Not Found', { status: 404 });
    }

    return reactRouterHandler(req, { cloudflare: { env, ctx } });
  },

  async queue(batch: MessageBatch<AppScreenshotJob>, env: Env): Promise<void> {
    return handleScreenshotQueue(batch, env);
  },
} satisfies ExportedHandler<Env>;
