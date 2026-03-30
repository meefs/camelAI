import type { AppLoadContext } from 'react-router';
import type { UserDO, OrgDO } from '../../workers/main/src/auth';
import type { WorkspaceDO } from '../../workers/main/src/workspace';
import type { ChatThreadDO } from '../../workers/main/src/durable-objects';
import type { WorkerLogsDO } from '../../workers/main/src/worker-logs-do';
import type { AdminIndexDO } from '../../workers/main/src/admin-index-do';

/**
 * Cloudflare environment bindings available in React Router loaders/actions.
 * This interface should match the Env type in workers/main/src/index.ts
 */
export interface CloudflareEnv {
  // Durable Objects
  CHAT_THREAD: DurableObjectNamespace<ChatThreadDO>;
  USER: DurableObjectNamespace<UserDO>;
  ORG: DurableObjectNamespace<OrgDO>;
  WORKSPACE: DurableObjectNamespace<WorkspaceDO>;
  ADMIN_INDEX: DurableObjectNamespace<AdminIndexDO>;
  MCP_OBJECT: DurableObjectNamespace;
  WORKER_LOGS: DurableObjectNamespace<WorkerLogsDO>;

  // KV Namespaces
  EMAIL_TO_USER: KVNamespace;
  APP_KV: KVNamespace;
  SESSIONS: KVNamespace;

  // R2
  R2_BUCKET: R2Bucket;

  // Service bindings
  WORKER_SELF_REFERENCE: Fetcher;

  // Other bindings
  ASSETS: Fetcher;
  IMAGES: unknown; // ImagesBinding
  AI: unknown; // AI binding
  BROWSER?: Fetcher;
  ERROR_ANALYTICS?: AnalyticsEngineDataset;

  // Environment variables
  NEXTJS_ENV?: string;
  R2_BUCKET_NAME: string;
  R2_ACCOUNT_ID: string;
  R2_MOUNT_DIR: string;
  R2_PARENT_ACCESS_KEY_ID: string;
  CF_ACCOUNT_ID: string;
  CF_DISPATCH_NAMESPACE: string;
  CF_API_TOKEN?: string;
  CF_ZONE_ID?: string;
  CF_CUSTOM_HOSTNAME_FALLBACK?: string;
  CF_CUSTOM_HOSTNAME_CNAME_TARGET?: string;
  CF_DCV_DELEGATION_UUID?: string;
  WORKER_BASE_URL: string;
  TOKEN_SIGNING_SECRET: string;
  INTEGRATION_SECRET_KEY: string;
  WORKSPACE_EMAIL_DOMAIN?: string;
  EMAIL_FROM_ADDRESS?: string;
  RESEND_API_KEY?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  SANDBOX_HOST?: Fetcher;
  SANDBOX_HOST_URL?: string;
}

/**
 * Extended load context with Cloudflare bindings
 */
export interface CloudflareLoadContext extends AppLoadContext {
  cloudflare: {
    env: CloudflareEnv;
  };
}

/**
 * Get Cloudflare environment bindings from React Router load context
 */
export function getEnv(context: AppLoadContext): CloudflareEnv {
  const cfContext = context as CloudflareLoadContext;
  if (!cfContext.cloudflare?.env) {
    throw new Error('Cloudflare environment not available in load context');
  }
  return cfContext.cloudflare.env;
}
