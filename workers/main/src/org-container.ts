/**
 * OrgContainer - Container class for per-org sandbox containers.
 * Uses @cloudflare/containers to manage container lifecycle with env vars at startup.
 */
import { Container } from '@cloudflare/containers';
import { getTempR2Credentials } from './r2-credentials';
import type { DoRpcService } from './rpc-service';

export interface OrgContainerEnv {
  SANDBOX: DurableObjectNamespace<OrgContainer>;
  DO_RPC: Service<DoRpcService>;
  R2_BUCKET: R2Bucket;
  EMAIL_TO_USER: KVNamespace;
  ANTHROPIC_API_KEY: string;
  CF_ACCOUNT_ID?: string;
  CF_DISPATCH_NAMESPACE?: string;
  R2_BUCKET_NAME?: string;
  R2_ACCOUNT_ID?: string;
  R2_MOUNT_DIR?: string;
  R2_MOUNT_READONLY?: string;
  R2_API_TOKEN?: string;
  R2_PARENT_ACCESS_KEY_ID?: string;
  WORKER_BASE_URL?: string;
}

// Control plane response types
interface ControlPlaneHealthResponse {
  status: string;
  version: string;
  pid: number;
}

interface ControlPlaneExecResponse {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  killed?: boolean;
  signal?: string | null;
}

interface ControlPlaneExistsResponse {
  exists: boolean;
  isFile?: boolean;
  isDirectory?: boolean;
  size?: number;
  modifiedAt?: string;
}

interface ControlPlaneReadResponse {
  success: boolean;
  content?: string;
  size?: number;
  isBinary?: boolean;
  encoding?: string;
  mimeType?: string;
  error?: string;
  code?: string;
}

interface ControlPlaneWriteResponse {
  success: boolean;
  error?: string;
  code?: string;
}

interface ControlPlaneListResponse {
  success?: boolean;
  files: Array<{
    name: string;
    type: 'file' | 'directory';
    size: number;
    modifiedAt: string;
    relativePath: string;
    absolutePath: string;
  }>;
  count: number;
  path: string;
  timestamp?: string;
  error?: string;
}

interface ControlPlaneMkdirResponse {
  success: boolean;
  timestamp?: string;
  error?: string;
  code?: string;
}

interface ControlPlaneMoveResponse {
  success: boolean;
  timestamp?: string;
  error?: string;
  code?: string;
}

interface ControlPlaneDeleteResponse {
  success: boolean;
  timestamp?: string;
  error?: string;
  code?: string;
}

// Port configuration
const WS_SERVER_PORT = 8080;
const CONTROL_PLANE_PORT = 9000;

/**
 * Generate a secure token for container API access.
 */
function generateContainerToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const base64 = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
  return `ctok_${base64}`;
}

/**
 * Get or create a deploy token for an org's container.
 */
async function getOrCreateContainerToken(
  kv: KVNamespace,
  org: string
): Promise<string> {
  const orgPrefix = org.slice(0, 32).replace(/[^a-zA-Z0-9_-]/g, '_');
  const prefixKey = `platform_script_prefix:${orgPrefix}`;
  const existingTokenKey = `container_token:${org}`;
  const existingToken = await kv.get(existingTokenKey);
  if (existingToken) {
    await kv.put(prefixKey, org);
    return existingToken;
  }

  const token = generateContainerToken();

  await kv.put(`platform_script_token:${token}`, orgPrefix);
  await kv.put(prefixKey, org);
  await kv.put(existingTokenKey, token);

  return token;
}

/**
 * OrgContainer - One container per organization.
 * Extends Container to handle WebSocket proxying and control plane operations.
 */
export class OrgContainer extends Container<OrgContainerEnv> {
  // Default port for WebSocket proxying (ws-server)
  defaultPort = WS_SERVER_PORT;

  // Idle timeout before container sleeps
  sleepAfter = '10m';

  // Enable outbound internet for API calls
  enableInternet = true;

  // Track the org ID for this container
  private orgId: string | null = null;

  // Lifecycle hooks
  override onStart(): void {
    console.log(`[OrgContainer] Container started for org: ${this.orgId || 'unknown'}`);
  }

  override onStop(): void {
    console.log(`[OrgContainer] Container stopped for org: ${this.orgId || 'unknown'}`);
  }

  override onError(error: unknown): void {
    console.error(`[OrgContainer] Container error for org: ${this.orgId || 'unknown'}`, error);
    throw error;
  }

  /**
   * Build environment variables for container startup.
   */
  async buildEnvVars(orgId: string): Promise<Record<string, string>> {
    this.orgId = orgId;

    const envVars: Record<string, string> = {
      ANTHROPIC_API_KEY: this.env.ANTHROPIC_API_KEY,
      ORG_ID: orgId,
    };

    // R2 config
    if (this.env.R2_BUCKET_NAME) envVars.R2_BUCKET_NAME = this.env.R2_BUCKET_NAME;
    if (this.env.R2_ACCOUNT_ID) envVars.R2_ACCOUNT_ID = this.env.R2_ACCOUNT_ID;
    if (this.env.R2_MOUNT_DIR) envVars.R2_MOUNT_DIR = this.env.R2_MOUNT_DIR;
    if (this.env.R2_MOUNT_READONLY) envVars.R2_MOUNT_READONLY = this.env.R2_MOUNT_READONLY;

    // R2 prefix for org-scoped access
    const prefix = `${orgId}/`;
    envVars.R2_PREFIX = prefix;

    // Generate temp R2 credentials
    if (this.env.R2_API_TOKEN && this.env.R2_PARENT_ACCESS_KEY_ID && this.env.R2_ACCOUNT_ID && this.env.R2_BUCKET_NAME) {
      try {
        const tempCreds = await getTempR2Credentials(
          this.env.R2_ACCOUNT_ID,
          this.env.R2_BUCKET_NAME,
          this.env.R2_PARENT_ACCESS_KEY_ID,
          this.env.R2_API_TOKEN,
          prefix,
          86400
        );
        envVars.AWS_ACCESS_KEY_ID = tempCreds.accessKeyId;
        envVars.AWS_SECRET_ACCESS_KEY = tempCreds.secretAccessKey;
        envVars.AWS_SESSION_TOKEN = tempCreds.sessionToken;

        // Ensure prefix exists in R2
        const placeholderKey = `${prefix}.keep`;
        const existing = await this.env.R2_BUCKET.head(placeholderKey);
        if (!existing) {
          await this.env.R2_BUCKET.put(placeholderKey, '');
        }
      } catch (e) {
        console.error('[OrgContainer] Failed to get R2 credentials:', e);
      }
    }

    // Wrangler config (for deploys from container)
    if (this.env.CF_ACCOUNT_ID) envVars.CLOUDFLARE_ACCOUNT_ID = this.env.CF_ACCOUNT_ID;
    if (this.env.CF_DISPATCH_NAMESPACE) envVars.CF_DISPATCH_NAMESPACE = this.env.CF_DISPATCH_NAMESPACE;
    envVars.WRANGLER_SEND_METRICS = 'false';
    envVars.CI = '1';

    // Cloudflare API proxy config
    if (this.env.WORKER_BASE_URL) {
      envVars.WORKER_BASE_URL = this.env.WORKER_BASE_URL;
      envVars.CLOUDFLARE_API_BASE_URL = `${this.env.WORKER_BASE_URL}/client/v4`;

      const containerToken = await getOrCreateContainerToken(this.env.EMAIL_TO_USER, orgId);
      envVars.CLOUDFLARE_API_TOKEN = containerToken;
    }

    // Fetch integration credentials and pass as ENV vars
    try {
      const integrationEnvVars = await this.env.DO_RPC.getOrgIntegrationEnvVars(orgId);
      console.log('[OrgContainer] Integration env vars:', Object.entries(integrationEnvVars).map(
        ([k, v]) => `${k}=${v.length} chars`
      ));
      Object.assign(envVars, integrationEnvVars);
    } catch (e) {
      console.error('[OrgContainer] Failed to load integration env vars:', e);
    }

    return envVars;
  }

  /**
   * Start container with org-specific environment variables.
   * If container is already running, returns immediately without rebuilding env vars.
   */
  async startForOrg(orgId: string): Promise<void> {
    this.orgId = orgId;

    // Only build env vars once per container instance - they're set as class property
    // so Container class uses them for any start path (including auto-restarts)
    if (!(this as any).envVars || Object.keys((this as any).envVars).length === 0) {
      console.log('[OrgContainer] Building env vars for org:', orgId);
      const envVars = await this.buildEnvVars(orgId);
      (this as any).envVars = envVars;
    }

    const state = await this.getState();
    console.log('[OrgContainer] Container state:', state.status, 'for org:', orgId);
    if (state.status === 'running' || state.status === 'healthy') {
      console.log('[OrgContainer] startForOrg skipping start; container already running', {
        orgId,
        status: state.status,
      });
      return;
    }

    console.log('[OrgContainer] Starting container for org:', orgId);

    await this.startAndWaitForPorts({
      ports: [WS_SERVER_PORT, CONTROL_PLANE_PORT],
      cancellationOptions: {
        instanceGetTimeoutMS: 30000,
        portReadyTimeoutMS: 60000,
      },
    });

    console.log('[OrgContainer] Container started and ports ready for org:', orgId);
  }

  /**
   * Call control plane API endpoint.
   * No auth required - control plane is only accessible from within the container
   * or via containerFetch from this DO. Container isolation is the security boundary.
   */
  private async controlPlane<T>(path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};

    if (body) {
      headers['Content-Type'] = 'application/json';
    }

    const response = await this.containerFetch(`http://container${path}`, {
      method: body ? 'POST' : 'GET',
      headers,
      body: body ? JSON.stringify(body) : undefined,
    }, CONTROL_PLANE_PORT);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Control plane error: ${response.status} ${text}`);
    }

    return response.json() as Promise<T>;
  }

  /**
   * Health check on control plane.
   */
  async healthCheck(): Promise<ControlPlaneHealthResponse> {
    return this.controlPlane<ControlPlaneHealthResponse>('/health');
  }

  /**
   * Execute a command in the container.
   */
  async exec(command: string, options?: { timeout?: number; cwd?: string }): Promise<ControlPlaneExecResponse> {
    return this.controlPlane<ControlPlaneExecResponse>('/exec', {
      command,
      timeout: options?.timeout,
      cwd: options?.cwd,
    });
  }

  /**
   * Check if a path exists in the container.
   */
  async exists(path: string): Promise<ControlPlaneExistsResponse> {
    return this.controlPlane<ControlPlaneExistsResponse>('/fs/exists', { path });
  }

  /**
   * Read a file from the container.
   */
  async readFile(path: string): Promise<ControlPlaneReadResponse> {
    return this.controlPlane<ControlPlaneReadResponse>('/fs/read', { path });
  }

  /**
   * Write a file to the container.
   */
  async writeFile(path: string, content: string): Promise<ControlPlaneWriteResponse> {
    return this.controlPlane<ControlPlaneWriteResponse>('/fs/write', { path, content });
  }

  /**
   * List files in a directory.
   */
  async listFiles(path: string, options?: { recursive?: boolean; includeHidden?: boolean }): Promise<ControlPlaneListResponse> {
    return this.controlPlane<ControlPlaneListResponse>('/fs/list', {
      path,
      recursive: options?.recursive,
      includeHidden: options?.includeHidden,
    });
  }

  /**
   * Create a directory.
   */
  async mkdir(path: string, options?: { recursive?: boolean }): Promise<ControlPlaneMkdirResponse> {
    return this.controlPlane<ControlPlaneMkdirResponse>('/fs/mkdir', {
      path,
      recursive: options?.recursive ?? true,
    });
  }

  /**
   * Move/rename a file or directory.
   */
  async moveFile(source: string, destination: string): Promise<ControlPlaneMoveResponse> {
    return this.controlPlane<ControlPlaneMoveResponse>('/fs/move', { source, destination });
  }

  /**
   * Delete a file or directory.
   */
  async deleteFile(path: string): Promise<ControlPlaneDeleteResponse> {
    return this.controlPlane<ControlPlaneDeleteResponse>('/fs/delete', { path });
  }
}

/**
 * Get sandbox ID for an org (one container per org).
 */
export function getContainerIdForOrg(org: string): string {
  const safeOrg = org.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `org-${safeOrg}`.slice(0, 63);
}

/**
 * Get container stub for an org.
 */
export function getOrgContainer(env: OrgContainerEnv, org: string): DurableObjectStub<OrgContainer> {
  const containerId = getContainerIdForOrg(org);
  return env.SANDBOX.get(env.SANDBOX.idFromName(containerId));
}

/**
 * Handle WebSocket upgrade with container management.
 * Includes retry logic for transient failures.
 */
export async function handleWebSocketUpgrade(
  request: Request,
  env: OrgContainerEnv,
  org: string
): Promise<Response> {
  const url = new URL(request.url);
  console.log('[handleWebSocketUpgrade] Starting', {
    org,
    url: url.toString(),
    method: request.method,
    upgrade: request.headers.get('Upgrade'),
    connection: request.headers.get('Connection'),
  });

  const container = getOrgContainer(env, org);
  const maxRetries = 2;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      console.log('[handleWebSocketUpgrade] Starting container', { org, attempt });

      // Start container if not running (startForOrg is smart about checking state)
      await container.startForOrg(org);

      console.log('[handleWebSocketUpgrade] Container started, proxying WebSocket via fetch()', { org, attempt });

      // IMPORTANT: Use container.fetch() directly, NOT a custom method.
      // The Container class's fetch() handles WebSocket forwarding specially.
      // Calling a custom method like proxyWebSocket() creates an RPC boundary
      // that can't serialize WebSocket objects.
      const response = await container.fetch(request);

      console.log('[handleWebSocketUpgrade] fetch() response', {
        org,
        attempt,
        status: response.status,
        webSocket: !!response.webSocket,
      });

      return response;
    } catch (e) {
      console.error('[handleWebSocketUpgrade] Error:', {
        org,
        attempt,
        error: String(e),
        stack: e instanceof Error ? e.stack : undefined,
      });
      if (attempt < maxRetries) {
        console.log('[handleWebSocketUpgrade] Retrying after error...', { org, attempt });
        await new Promise(resolve => setTimeout(resolve, 1000));
        continue;
      }
      return new Response(`Container error: ${String(e)}`, { status: 500 });
    }
  }

  return new Response('Failed to connect to container after retries', { status: 500 });
}
