/**
 * Shared types and constants for the main worker
 */

import type { ChatEnv } from './durable-objects.js';
import type { DOEnv } from './auth.js';
import type { WorkspaceContainerEnv } from './workspace-container.js';
import type { DataProxyEnv } from './data-proxy.js';
import type { CfApiProxyEnv } from './cf-api-proxy.js';
import type { McpEnv } from './mcp-handler.js';
import type { WorkspaceDO } from './workspace.js';
import type { EphemeralWorkerLogsDO } from './worker-logs-do.js';
import type { EmailHandleDO } from './email-handle-registry.js';
import type { AppScreenshotJob } from './screenshot-queue.js';
import type { SlackEventQueueMessage } from './slack-types.js';

export interface Env extends ChatEnv, DOEnv, WorkspaceContainerEnv, DataProxyEnv, CfApiProxyEnv, McpEnv {
  ASSETS: Fetcher;
  WORKSPACE: DurableObjectNamespace<WorkspaceDO>;
  WORKER_LOGS: DurableObjectNamespace<EphemeralWorkerLogsDO>;
  SESSIONS: KVNamespace;
  ERROR_ANALYTICS?: AnalyticsEngineDataset;
  APP_SCREENSHOT_QUEUE?: Queue<AppScreenshotJob>;
  SLACK_EVENTS_QUEUE?: Queue<SlackEventQueueMessage>;
  BROWSER?: Fetcher;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  SLACK_CLIENT_ID?: string;
  SLACK_CLIENT_SECRET?: string;
  SLACK_SIGNING_SECRET?: string;
  NOTION_CLIENT_ID?: string;
  NOTION_CLIENT_SECRET?: string;
  SALESFORCE_CLIENT_ID?: string;
  SALESFORCE_CLIENT_SECRET?: string;
  INTEGRATION_SECRET_KEY: string;
  WORKSPACE_EMAIL_DOMAIN?: string;
  EMAIL_FROM_ADDRESS?: string;
  RESEND_API_KEY?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  // Claude API Proxy (CF AI Gateway)
  CF_GATEWAY_NAME?: string;
  CF_GATEWAY_TOKEN?: string;
  BEDROCK_REGION?: string;
  // Sandbox proxy shared secret
  SANDBOX_PROXY_SECRET?: string;
  // Email handle registry (atomic handle claims)
  EMAIL_HANDLE?: DurableObjectNamespace<EmailHandleDO>;
  // Admin CLI API key (set via wrangler secret)
  ADMIN_API_KEY?: string;
}

export interface RouteContext {
  req: Request;
  env: Env;
  ctx: ExecutionContext;
  url: URL;
  match: RegExpMatchArray;
}

export type RouteHandler = (ctx: RouteContext) => Promise<Response | null>;

export interface Route {
  method: string;
  path: RegExp;
  handler: RouteHandler;
  websocket?: boolean;
}

// Re-export cookie constants from cookies.ts (single source of truth)
export { SESSION_HEADER } from './cookies.js';

// New prefix with org-slug namespacing: script:{script-name}--{org-slug}
export const SCRIPT_PREFIX = 'script:';
// Legacy prefix for backwards compatibility during migration
export const SCRIPT_ORG_PREFIX_LEGACY = 'script_org:';
