/**
 * Container management utilities for WebSocket routing.
 * Handles sandbox lifecycle without a Durable Object.
 */
import { getSandbox, type Sandbox, type Process } from '@cloudflare/sandbox';
import { getTempR2Credentials } from './r2-credentials';
import type { DoRpcService } from './rpc-service';

export interface ContainerEnv {
  SANDBOX: DurableObjectNamespace<Sandbox>;
  DO_RPC: Service<DoRpcService>;
  R2_BUCKET: R2Bucket;
  ANTHROPIC_API_KEY: string;
  CF_ACCOUNT_ID?: string;
  R2_BUCKET_NAME?: string;
  R2_ACCOUNT_ID?: string;
  R2_MOUNT_DIR?: string;
  R2_MOUNT_READONLY?: string;
  R2_API_TOKEN?: string;
  R2_PARENT_ACCESS_KEY_ID?: string;
}

/**
 * Get sandbox ID for an org (one container per org).
 */
export function getSandboxIdForOrg(org: string): string {
  const safeOrg = org.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `org-${safeOrg}`.slice(0, 63);
}

/**
 * Get or create sandbox reference for an org.
 */
export function getOrgSandbox(env: ContainerEnv, org: string): ReturnType<typeof getSandbox> {
  const sandboxId = getSandboxIdForOrg(org);
  return getSandbox(env.SANDBOX, sandboxId, { normalizeId: true });
}

/**
 * Check if ws-server is already running in the container.
 */
export async function checkWsServerReady(sandbox: ReturnType<typeof getSandbox>): Promise<boolean> {
  try {
    const result = await sandbox.exec(
      'curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/health',
      { timeout: 2000 }
    );
    return result.stdout?.trim() === '200';
  } catch {
    return false;
  }
}

/**
 * Start the ws-server process in the container.
 */
export async function startWsServerProcess(
  sandbox: ReturnType<typeof getSandbox>,
  env: ContainerEnv,
  org: string
): Promise<Process | null> {
  try {
    console.log('[container] Starting WS server process', { org });

    const processEnv: Record<string, string> = {
      ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
    };

    // R2 mount config
    if (env.R2_BUCKET_NAME) processEnv.R2_BUCKET_NAME = env.R2_BUCKET_NAME;
    if (env.R2_ACCOUNT_ID) processEnv.R2_ACCOUNT_ID = env.R2_ACCOUNT_ID;
    if (env.R2_MOUNT_DIR) processEnv.R2_MOUNT_DIR = env.R2_MOUNT_DIR;
    if (env.R2_MOUNT_READONLY) processEnv.R2_MOUNT_READONLY = env.R2_MOUNT_READONLY;

    processEnv.ORG_ID = org;

    // Wrangler config (for deploys from container)
    if (env.CF_ACCOUNT_ID) processEnv.CLOUDFLARE_ACCOUNT_ID = env.CF_ACCOUNT_ID;
    processEnv.WRANGLER_SEND_METRICS = 'false';
    processEnv.CI = '1';

    // Generate org-scoped temp R2 credentials
    const prefix = `${org}/`;
    processEnv.R2_PREFIX = prefix;

    if (env.R2_API_TOKEN && env.R2_PARENT_ACCESS_KEY_ID && env.R2_ACCOUNT_ID && env.R2_BUCKET_NAME) {
      const tempCreds = await getTempR2Credentials(
        env.R2_ACCOUNT_ID,
        env.R2_BUCKET_NAME,
        env.R2_PARENT_ACCESS_KEY_ID,
        env.R2_API_TOKEN,
        prefix,
        86400
      );
      processEnv.AWS_ACCESS_KEY_ID = tempCreds.accessKeyId;
      processEnv.AWS_SECRET_ACCESS_KEY = tempCreds.secretAccessKey;
      processEnv.AWS_SESSION_TOKEN = tempCreds.sessionToken;

      // Ensure prefix exists in R2
      const placeholderKey = `${prefix}.keep`;
      const existing = await env.R2_BUCKET.head(placeholderKey);
      if (!existing) {
        await env.R2_BUCKET.put(placeholderKey, '');
      }
    }

    // Fetch integration credentials and pass as ENV vars
    try {
      const integrationEnvVars = await env.DO_RPC.getOrgIntegrationEnvVars(org);
      console.log('[container] Integration env vars:', Object.entries(integrationEnvVars).map(
        ([k, v]) => `${k}=${v.length} chars`
      ));
      Object.assign(processEnv, integrationEnvVars);
    } catch (e) {
      console.error('[container] Failed to load integration env vars:', e);
    }

    // Start the WS server process
    const process = await sandbox.startProcess('sh /app/run-ws-server.sh', { env: processEnv });
    console.log('[container] WS server process started', { org, processId: process.id });
    return process;
  } catch (e) {
    console.error('[container] Failed to start WS server process:', { org, error: String(e) });
    return null;
  }
}

/**
 * Wait for ws-server to become ready (poll health endpoint).
 */
export async function waitForWsServerReady(
  sandbox: ReturnType<typeof getSandbox>,
  timeoutMs: number = 30000
): Promise<boolean> {
  const startTime = Date.now();
  const pollInterval = 500;

  while (Date.now() - startTime < timeoutMs) {
    if (await checkWsServerReady(sandbox)) {
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }
  return false;
}

/**
 * Ensure container is ready and proxy WebSocket connection.
 */
export async function handleWebSocketUpgrade(
  request: Request,
  env: ContainerEnv,
  org: string
): Promise<Response> {
  const sandbox = getOrgSandbox(env, org);

  // Check if ws-server is already running
  const isReady = await checkWsServerReady(sandbox);

  if (!isReady) {
    console.log('[container] WS server not ready, starting...', { org });

    const process = await startWsServerProcess(sandbox, env, org);
    if (!process) {
      return new Response('Failed to start container', { status: 500 });
    }

    // Wait for server to become ready
    const ready = await waitForWsServerReady(sandbox, 30000);
    if (!ready) {
      console.error('[container] WS server failed to start in time', { org });
      return new Response('Container WS server failed to start', { status: 500 });
    }
  }

  // Proxy WebSocket directly to container port 8080
  return sandbox.wsConnect(request, 8080);
}
