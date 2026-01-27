import type { AppLoadContext } from 'react-router';
import type { UserDO, OrgDO } from '../../workers/main/src/auth';
import type { WorkspaceDO } from '../../workers/main/src/workspace';
import type { ChatThreadDO } from '../../workers/main/src/durable-objects';

/**
 * Cloudflare environment bindings available in React Router loaders/actions.
 * This interface should match the Env type in workers/main/src/index.ts
 */
export interface CloudflareEnv {
  // Durable Objects
  CHAT_THREAD: DurableObjectNamespace<ChatThreadDO>;
  SANDBOX: DurableObjectNamespace;
  USER: DurableObjectNamespace<UserDO>;
  ORG: DurableObjectNamespace<OrgDO>;
  WORKSPACE: DurableObjectNamespace<WorkspaceDO>;
  MCP_OBJECT: DurableObjectNamespace;

  // KV Namespaces
  EMAIL_TO_USER: KVNamespace;
  API_TOKENS: KVNamespace;
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
  WORKER_BASE_URL: string;
  OPENROUTER_API_KEY: string; // Fallback global key
  OPENROUTER_PROVISIONING_KEY?: string; // Parent key for creating per-org keys
  TOKEN_SIGNING_SECRET: string;
  INTEGRATION_SECRET_KEY: string;
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
