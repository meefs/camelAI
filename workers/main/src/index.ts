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
import {
  handleSlackOAuthStart,
  handleSlackOAuthCallback,
  handleNotionOAuthStart,
  handleNotionOAuthCallback,
  handleGitHubOAuthStart,
  handleGitHubOAuthCallback,
  handleLinearOAuthStart,
  handleLinearOAuthCallback,
  handleAirtableOAuthStart,
  handleAirtableOAuthCallback,
  handleHubSpotOAuthStart,
  handleHubSpotOAuthCallback,
  handleTypeformOAuthStart,
  handleTypeformOAuthCallback,
  handleMailchimpOAuthStart,
  handleMailchimpOAuthCallback,
  handleJiraOAuthStart,
  handleJiraOAuthCallback,
  handleAsanaOAuthStart,
  handleAsanaOAuthCallback,
  handleFigmaOAuthStart,
  handleFigmaOAuthCallback,
  handleIntercomOAuthStart,
  handleIntercomOAuthCallback,
  handleZendeskOAuthStart,
  handleZendeskOAuthCallback,
  handleDiscordOAuthStart,
  handleDiscordOAuthCallback,
  handleShopifyOAuthStart,
  handleShopifyOAuthCallback,
  handleSquareOAuthStart,
  handleSquareOAuthCallback,
} from './routes/integrations.js';
import { handleThreadWebSocket, handleChatWebSocket } from './routes/websocket.js';
import { handleClaudeProxy, handleCountTokens } from './routes/claude-proxy.js';
import { handleWorkerAuth } from './routes/worker-auth.js';

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
  { method: 'GET', path: /^\/api\/integrations\/github\/oauth$/, handler: handleGitHubOAuthStart },
  { method: 'GET', path: /^\/api\/integrations\/github\/callback$/, handler: handleGitHubOAuthCallback },
  { method: 'GET', path: /^\/api\/integrations\/linear\/oauth$/, handler: handleLinearOAuthStart },
  { method: 'GET', path: /^\/api\/integrations\/linear\/callback$/, handler: handleLinearOAuthCallback },
  { method: 'GET', path: /^\/api\/integrations\/airtable\/oauth$/, handler: handleAirtableOAuthStart },
  { method: 'GET', path: /^\/api\/integrations\/airtable\/callback$/, handler: handleAirtableOAuthCallback },
  { method: 'GET', path: /^\/api\/integrations\/hubspot\/oauth$/, handler: handleHubSpotOAuthStart },
  { method: 'GET', path: /^\/api\/integrations\/hubspot\/callback$/, handler: handleHubSpotOAuthCallback },
  { method: 'GET', path: /^\/api\/integrations\/typeform\/oauth$/, handler: handleTypeformOAuthStart },
  { method: 'GET', path: /^\/api\/integrations\/typeform\/callback$/, handler: handleTypeformOAuthCallback },
  { method: 'GET', path: /^\/api\/integrations\/mailchimp\/oauth$/, handler: handleMailchimpOAuthStart },
  { method: 'GET', path: /^\/api\/integrations\/mailchimp\/callback$/, handler: handleMailchimpOAuthCallback },
  { method: 'GET', path: /^\/api\/integrations\/jira\/oauth$/, handler: handleJiraOAuthStart },
  { method: 'GET', path: /^\/api\/integrations\/jira\/callback$/, handler: handleJiraOAuthCallback },
  { method: 'GET', path: /^\/api\/integrations\/asana\/oauth$/, handler: handleAsanaOAuthStart },
  { method: 'GET', path: /^\/api\/integrations\/asana\/callback$/, handler: handleAsanaOAuthCallback },
  { method: 'GET', path: /^\/api\/integrations\/figma\/oauth$/, handler: handleFigmaOAuthStart },
  { method: 'GET', path: /^\/api\/integrations\/figma\/callback$/, handler: handleFigmaOAuthCallback },
  { method: 'GET', path: /^\/api\/integrations\/intercom\/oauth$/, handler: handleIntercomOAuthStart },
  { method: 'GET', path: /^\/api\/integrations\/intercom\/callback$/, handler: handleIntercomOAuthCallback },
  { method: 'GET', path: /^\/api\/integrations\/zendesk\/oauth$/, handler: handleZendeskOAuthStart },
  { method: 'GET', path: /^\/api\/integrations\/zendesk\/callback$/, handler: handleZendeskOAuthCallback },
  { method: 'GET', path: /^\/api\/integrations\/discord\/oauth$/, handler: handleDiscordOAuthStart },
  { method: 'GET', path: /^\/api\/integrations\/discord\/callback$/, handler: handleDiscordOAuthCallback },
  { method: 'GET', path: /^\/api\/integrations\/shopify\/oauth$/, handler: handleShopifyOAuthStart },
  { method: 'GET', path: /^\/api\/integrations\/shopify\/callback$/, handler: handleShopifyOAuthCallback },
  { method: 'GET', path: /^\/api\/integrations\/square\/oauth$/, handler: handleSquareOAuthStart },
  { method: 'GET', path: /^\/api\/integrations\/square\/callback$/, handler: handleSquareOAuthCallback },

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
