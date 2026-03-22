/**
 * Main camelAI Worker - Composition Root
 *
 * Routes:
 * - /client/v4/* → CF API proxy for wrangler deploys
 * - /mcp/* → MCP protocol
 * - /api/auth/:provider → User OAuth (Google, GitHub)
 * - /api/integrations/slack/* → Slack OAuth
 * - /api/integrations/slack/events → Slack Events API webhook
 * - email() → Workspace email ingress (Cloudflare Email Routing)
 * - /api/threads/:id/preview → Thread preview API
 * - /ws/:workspace → Chat WebSocket (forwarded to ChatThreadDO)
 * - * → React Router SSR
 */

import { createRequestHandler } from 'react-router';
import type { Env, Route } from './types.js';
import { handleScreenshotQueue, type AppScreenshotJob } from './screenshot-queue.js';
import { handleSlackEventsQueue } from './slack-events-queue.js';
import type { SlackEventQueueMessage } from './slack-types.js';
import { handleWorkspaceEmailIngress } from './email-ingress.js';

// Route handlers
import { handleCfProxy } from './routes/cf-proxy.js';
import { handleMcp } from './routes/mcp.js';
import { handleThreadPreview } from './routes/threads.js';
import { handleOAuthStart, handleOAuthCallback } from './routes/oauth.js';
import {
  handleSlackOAuthStart,
  handleSlackOAuthCallback,
  handleSlackEvents,
  handleNotionOAuthStart,
  handleNotionOAuthCallback,
  handleSalesforceOAuthStart,
  handleSalesforceOAuthCallback,
} from './routes/integrations.js';
import { handleChatWebSocket } from './routes/websocket.js';
import { handleLogsWebSocket } from './routes/logs-websocket.js';
import { handleExternalMcp, handleOAuthMetadata, handleResourceMetadata } from './routes/external-mcp.js';
import {
  handleMssqlQuery,
  handleMysqlQuery,
  handlePostgresQuery,
} from './routes/data-proxy.js';
import { handleResendProxy } from './routes/resend-proxy.js';
import { handleWorkerAuth } from './routes/worker-auth.js';
import { handleAdminApi } from './routes/admin/index.js';

// Re-exports for wrangler
export { ChiridionMcp } from './mcp-handler.js';
export { ExternalMcpDO } from './external-mcp-handler.js';
export { ChatThreadDO } from './durable-objects.js';
export { UserDO, OrgDO } from './auth.js';
export { OrgSlugDO } from './org-slug-registry.js';
export { EmailHandleDO } from './email-handle-registry.js';
export { WorkspaceDO } from './workspace.js';
export { WorkspaceCronDO } from './workspace-cron.js';
export { WorkerLogsDO } from './worker-logs-do.js';
export { R2VirtualBucket } from './r2-virtual-bucket.js';
export { DataProxyService } from './data-proxy-service.js';
export { AIVirtualBinding } from './ai-virtual-binding.js';
export { AdminIndexDO } from './admin-index-do.js';

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
  // Admin REST API (ADMIN_API_KEY auth; returns null to fall through to React Router for session-auth routes)
  { method: 'ALL', path: /^\/api\/admin\//, handler: handleAdminApi },

  // CF API Proxy
  { method: 'ALL', path: /^\/client\/v4\//, handler: handleCfProxy },

  // Data proxy (for sandbox containers)
  { method: 'POST', path: /^\/api\/mssql\/query$/, handler: handleMssqlQuery },
  { method: 'POST', path: /^\/api\/postgres\/query$/, handler: handlePostgresQuery },
  { method: 'POST', path: /^\/api\/mysql\/query$/, handler: handleMysqlQuery },

  // Resend email proxy (for sandbox containers)
  { method: 'POST', path: /^\/api\/resend\/emails$/, handler: handleResendProxy },

  // MCP (internal - sandbox agent)
  { method: 'ALL', path: /^\/mcp(\/|$)/, handler: handleMcp },

  // External MCP (OAuth-authenticated, for external clients)
  { method: 'GET', path: /^\/\.well-known\/oauth-authorization-server\/api\/mcp\/external$/, handler: handleOAuthMetadata },
  { method: 'GET', path: /^\/\.well-known\/oauth-protected-resource\/api\/mcp\/external$/, handler: handleResourceMetadata },
  { method: 'ALL', path: /^\/api\/mcp\/external(\/|$)/, handler: handleExternalMcp },

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
  { method: 'POST', path: /^\/api\/integrations\/slack\/events$/, handler: handleSlackEvents },
  { method: 'GET', path: /^\/api\/integrations\/notion\/oauth$/, handler: handleNotionOAuthStart },
  { method: 'GET', path: /^\/api\/integrations\/notion\/callback$/, handler: handleNotionOAuthCallback },
  { method: 'GET', path: /^\/api\/integrations\/salesforce\/oauth$/, handler: handleSalesforceOAuthStart },
  { method: 'GET', path: /^\/api\/integrations\/salesforce\/callback$/, handler: handleSalesforceOAuthCallback },

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

      const result = await route.handler({ req, env, ctx, url, match });
      if (result !== null) return result;
      // null → handler declined, continue matching
    }

    if (isWebSocket) {
      return new Response('Not Found', { status: 404 });
    }

    return reactRouterHandler(req, { cloudflare: { env, ctx } });
  },

  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    await handleWorkspaceEmailIngress(message, env);
  },

  async queue(batch: MessageBatch<AppScreenshotJob | SlackEventQueueMessage>, env: Env): Promise<void> {
    if (batch.queue.startsWith('chiridion-app-screenshots')) {
      return handleScreenshotQueue(batch as MessageBatch<AppScreenshotJob>, env);
    }
    if (batch.queue.startsWith('chiridion-app-slack-events')) {
      return handleSlackEventsQueue(batch as MessageBatch<SlackEventQueueMessage>, env);
    }

    console.warn('[queue] unhandled queue batch', { queue: batch.queue, size: batch.messages.length });
    batch.ackAll();
  },
} satisfies ExportedHandler<Env>;
