/**
 * Shared types and constants for the main worker
 */

import type { ChatEnv } from "./chat-thread-do.js";
import type { DOEnv } from "./auth.js";
import type { DataProxyEnv } from "./data-proxy.js";
import type { CfApiProxyEnv } from "./cf-api-proxy.js";
import type { McpEnv } from "./mcp-handler.js";
import type { WorkspaceDO } from "./workspace.js";
import type { WorkerLogsDO } from "./worker-logs-do.js";
import type { EmailHandleDO } from "./email-handle-registry.js";
import type {
  SlackTeamRegistryDO,
  TelegramRegistryDO,
} from "./channel-registries.js";
import type { AppScreenshotJob } from "./screenshot-queue.js";
import type { SlackEventQueueMessage } from "./slack-types.js";
import type { ArtifactsRepo } from "./workspace-filesystem-do.js";

interface ArtifactsBinding {
  create(
    name: string,
    options?: {
      readOnly?: boolean;
      description?: string;
      setDefaultBranch?: string;
    },
  ): Promise<{
    id?: string;
    name: string;
    remote: string;
    defaultBranch?: string;
    status?: "ready" | "creating" | "importing" | "forking";
    token?: string;
  }>;
  get(name: string): Promise<ArtifactsRepo>;
}

export interface Env
  extends
    ChatEnv,
    DOEnv,
    DataProxyEnv,
    Omit<CfApiProxyEnv, "CHAT_THREAD">,
    Omit<McpEnv, "CHAT_THREAD" | "MCP_OBJECT"> {
  ASSETS: Fetcher;
  WORKSPACE: DurableObjectNamespace<WorkspaceDO>;
  WORKER_LOGS: DurableObjectNamespace<WorkerLogsDO>;
  SESSIONS: KVNamespace;
  OBSERVABILITY_EVENTS?: AnalyticsEngineDataset;
  ERROR_ANALYTICS?: AnalyticsEngineDataset;
  APP_SCREENSHOT_QUEUE?: Queue<AppScreenshotJob>;
  SLACK_EVENTS_QUEUE?: Queue<SlackEventQueueMessage>;
  BROWSER?: Fetcher;
  ARTIFACTS?: ArtifactsBinding;
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
  EMAIL?: ChatEnv["EMAIL"];
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_BOT_USERNAME?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  STRIPE_MODE?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_SUBSCRIPTION_PRICE_ID?: string;
  STRIPE_STARTER_PRICE_ID?: string;
  STRIPE_PRO_PRICE_ID?: string;
  STRIPE_TEAM_PRICE_ID?: string;
  STRIPE_CREDIT_PRICE_IDS?: string;
  STRIPE_CREDIT_PRICE_ID?: string;
  STRIPE_BILLING_PORTAL_CONFIGURATION_ID?: string;
  LEGACY_STRIPE_MIGRATION_CUSTOMERS?: string;
  BILLING_TRIAL_CREDIT_CENTS?: string;
  BILLING_SUBSCRIPTION_INCLUDED_CREDIT_CENTS?: string;
  LOCAL_AUTH_BYPASS?: string;
  LOCAL_AUTH_USER_EMAIL?: string;
  LOCAL_AUTH_USER_NAME?: string;
  RUN_AGENT_EVALS?: string;
  // Claude API Proxy (CF AI Gateway)
  CF_GATEWAY_NAME?: string;
  CF_GATEWAY_TOKEN?: string;
  AI_GATEWAY_AUTH_TOKEN?: string;
  BEDROCK_REGION?: string;
  // Sandbox proxy shared secret
  SANDBOX_PROXY_SECRET?: string;
  PROJECT_RUNTIME_SERVICE_URL?: string;
  PROJECT_RUNTIME_SERVICE_BEARER_TOKEN?: string;
  LEGACY_WORKSPACE_HOST?: Fetcher;
  LEGACY_WORKSPACE_SERVICE_URL?: string;
  PROJECT_RUNTIME_DOCKER_PROXY_BASE_URL?: string;
  PROJECT_RUNTIME_ARTIFACTS_PROXY_BASE?: string;
  PROJECT_RUNTIME_PROXY_SECRET?: string;
  PROJECT_RUNTIME_MTLS_CERT_SHA256?: string;
  LOCAL_ARTIFACTS_BASE_URL?: string;
  LOCAL_ARTIFACTS_SECRET?: string;
  LOCAL_APP_VANITY_DOMAIN?: string;
  LOCAL_APP_IFRAME_DOMAIN?: string;
  CLOUDFLARE_ACCESS_TEAM_DOMAIN?: string;
  CLOUDFLARE_ACCESS_AUD?: string;
  CLOUDFLARE_ACCESS_AUDS?: string;
  CLOUDFLARE_ACCESS_ORG_MAP?: string;
  CLOUDFLARE_ACCESS_ORG_CLAIMS?: string;
  CLOUDFLARE_ACCESS_ORG_GROUP_PREFIX?: string;
  CLOUDFLARE_ACCESS_ADMIN_GROUP_PREFIX?: string;
  CLOUDFLARE_ACCESS_DEFAULT_ORG_NAME?: string;
  CLOUDFLARE_ACCESS_REQUIRED_EMAIL_DOMAIN?: string;
  LEGACY_WORKSPACE_MIGRATIONS?: Workflow;
  LEGACY_PREVIEW_REPAIRS?: Workflow;
  ENABLE_LEGACY_WORKSPACE_MIGRATION?: string;
  // Email handle registry (atomic handle claims)
  EMAIL_HANDLE?: DurableObjectNamespace<EmailHandleDO>;
  // Channel routing registries (strongly consistent routing state)
  TELEGRAM_REGISTRY?: DurableObjectNamespace<TelegramRegistryDO>;
  SLACK_TEAM_REGISTRY?: DurableObjectNamespace<SlackTeamRegistryDO>;
  // Admin CLI API key (set via wrangler secret)
  ADMIN_API_KEY?: string;
  // Derived global admin/index read model. Tenant-owned state remains authoritative in DOs.
  APP_DB?: D1Database;
  // Optional static OAuth client id for the remote admin MCP server.
  ADMIN_MCP_CLIENT_ID?: string;
  // Comma/whitespace-separated redirect URI allowlist for ADMIN_MCP_CLIENT_ID.
  ADMIN_MCP_REDIRECT_URIS?: string;
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
export { SESSION_HEADER } from "./cookies.js";

// New prefix with org-slug namespacing: script:{script-name}--{org-slug}
export const SCRIPT_PREFIX = "script:";
// Legacy prefix for backwards compatibility during migration
export const SCRIPT_ORG_PREFIX_LEGACY = "script_org:";
