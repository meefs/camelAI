/**
 * Shared types and constants for the main worker
 */

import type { ChatEnv } from './durable-objects.js';
import type { DOEnv } from './auth.js';
import type { WorkspaceContainerEnv } from './workspace-container.js';
import type { CfApiProxyEnv } from './cf-api-proxy.js';
import type { McpEnv } from './mcp-handler.js';
import type { WorkspaceDO } from './workspace.js';
import type { AppScreenshotJob } from './screenshot-queue.js';

export interface Env extends ChatEnv, DOEnv, WorkspaceContainerEnv, CfApiProxyEnv, McpEnv {
  ASSETS: Fetcher;
  WORKSPACE: DurableObjectNamespace<WorkspaceDO>;
  SESSIONS: KVNamespace;
  ERROR_ANALYTICS?: AnalyticsEngineDataset;
  APP_SCREENSHOT_QUEUE?: Queue<AppScreenshotJob>;
  BROWSER?: Fetcher;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  SLACK_CLIENT_ID?: string;
  SLACK_CLIENT_SECRET?: string;
  NOTION_CLIENT_ID?: string;
  NOTION_CLIENT_SECRET?: string;
  // Additional OAuth providers
  LINEAR_CLIENT_ID?: string;
  LINEAR_CLIENT_SECRET?: string;
  AIRTABLE_CLIENT_ID?: string;
  AIRTABLE_CLIENT_SECRET?: string;
  HUBSPOT_CLIENT_ID?: string;
  HUBSPOT_CLIENT_SECRET?: string;
  TYPEFORM_CLIENT_ID?: string;
  TYPEFORM_CLIENT_SECRET?: string;
  MAILCHIMP_CLIENT_ID?: string;
  MAILCHIMP_CLIENT_SECRET?: string;
  JIRA_CLIENT_ID?: string;
  JIRA_CLIENT_SECRET?: string;
  ASANA_CLIENT_ID?: string;
  ASANA_CLIENT_SECRET?: string;
  FIGMA_CLIENT_ID?: string;
  FIGMA_CLIENT_SECRET?: string;
  INTERCOM_CLIENT_ID?: string;
  INTERCOM_CLIENT_SECRET?: string;
  ZENDESK_CLIENT_ID?: string;
  ZENDESK_CLIENT_SECRET?: string;
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
  SHOPIFY_CLIENT_ID?: string;
  SHOPIFY_CLIENT_SECRET?: string;
  SQUARE_CLIENT_ID?: string;
  SQUARE_CLIENT_SECRET?: string;
  INTEGRATION_SECRET_KEY: string;
  // Claude API Proxy (CF AI Gateway)
  CF_GATEWAY_NAME?: string;
  CF_GATEWAY_TOKEN?: string;
  BEDROCK_REGION?: string;
}

export interface RouteContext {
  req: Request;
  env: Env;
  ctx: ExecutionContext;
  url: URL;
  match: RegExpMatchArray;
}

export type RouteHandler = (ctx: RouteContext) => Promise<Response>;

export interface Route {
  method: string;
  path: RegExp;
  handler: RouteHandler;
  websocket?: boolean;
}

// Re-export cookie constants from cookies.ts (single source of truth)
export { SESSION_COOKIE, LEGACY_SESSION_COOKIE, SESSION_HEADER } from './cookies.js';

export const THREAD_TOKEN_HEADER = 'X-Chiridion-Thread-Deploy-Token';
// New prefix with org-slug namespacing: script:{org-slug}--{script-name}
export const SCRIPT_PREFIX = 'script:';
// Legacy prefix for backwards compatibility during migration
export const SCRIPT_ORG_PREFIX_LEGACY = 'script_org:';
