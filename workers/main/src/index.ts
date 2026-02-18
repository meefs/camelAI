/**
 * Main camelAI Worker - Composition Root
 *
 * Routes:
 * - /client/v4/* → CF API proxy for wrangler deploys
 * - /mcp/* → MCP protocol
 * - /api/auth/:provider → User OAuth (Google, GitHub)
 * - /api/integrations/slack/* → Slack OAuth
 * - /api/threads/:id/preview → Thread preview API
 * - /ws/:workspace → Chat WebSocket (forwarded to ChatThreadDO)
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
import {
  handleSlackOAuthStart,
  handleSlackOAuthCallback,
  handleNotionOAuthStart,
  handleNotionOAuthCallback,
  handleSalesforceOAuthStart,
  handleSalesforceOAuthCallback,
} from './routes/integrations.js';
import { handleChatWebSocket } from './routes/websocket.js';
import { handleLogsWebSocket } from './routes/logs-websocket.js';
import { handleClaudeProxy, handleCountTokens } from './routes/claude-proxy.js';
import { handleWorkerAuth } from './routes/worker-auth.js';
import { handleMssqlQuery, handleDataProxyHealth } from './routes/data-proxy.js';

// Re-exports for wrangler
export { ChiridionMcp } from './mcp-handler.js';
export { DataProxy } from './data-proxy.js';
export { ChatThreadDO } from './durable-objects.js';
export { UserDO, OrgDO } from './auth.js';
export { OrgSlugDO } from './org-slug-registry.js';
export { WorkspaceDO } from './workspace.js';
export { WorkerLogsDO } from './worker-logs-do.js';
export { R2VirtualBucket } from './r2-virtual-bucket.js';

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

  // Claude API Proxy (for sandbox containers)
  { method: 'POST', path: /^\/api\/claude\/v1\/messages\/count_tokens$/, handler: handleCountTokens },
  { method: 'POST', path: /^\/api\/claude\/v1\/messages$/, handler: handleClaudeProxy },

  // MCP
  { method: 'ALL', path: /^\/mcp(\/|$)/, handler: handleMcp },

  // Thread Preview API
  { method: 'POST', path: /^\/api\/threads\/([^/]+)\/preview$/, handler: handleThreadPreview },

  // User OAuth
  { method: 'GET', path: /^\/api\/auth\/(google|github)$/, handler: handleOAuthStart },
  { method: 'GET', path: /^\/api\/auth\/(google|github)\/callback$/, handler: handleOAuthCallback },

  // Worker auth (cross-domain auth for private workers)
  { method: 'GET', path: /^\/auth\/worker$/, handler: handleWorkerAuth },

  // Integration OAuth
  { method: 'GET', path: /^\/api\/integrations\/slack\/oauth$/, handler: handleSlackOAuthStart },
  { method: 'GET', path: /^\/api\/integrations\/slack\/callback$/, handler: handleSlackOAuthCallback },
  { method: 'GET', path: /^\/api\/integrations\/notion\/oauth$/, handler: handleNotionOAuthStart },
  { method: 'GET', path: /^\/api\/integrations\/notion\/callback$/, handler: handleNotionOAuthCallback },
  { method: 'GET', path: /^\/api\/integrations\/salesforce\/oauth$/, handler: handleSalesforceOAuthStart },
  { method: 'GET', path: /^\/api\/integrations\/salesforce\/callback$/, handler: handleSalesforceOAuthCallback },

  // Data Proxy API (requires 'data-proxy' scope token)
  { method: 'POST', path: /^\/api\/mssql\/query$/, handler: handleMssqlQuery },
  { method: 'GET', path: /^\/api\/data-proxy\/health$/, handler: handleDataProxyHealth },

  // WebSocket routes
  { method: 'GET', path: /^\/ws\/logs$/, handler: handleLogsWebSocket, websocket: true },
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
