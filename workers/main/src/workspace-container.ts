/**
 * WorkspaceContainer - Container class for per-workspace sandbox containers.
 * Uses @cloudflare/containers to manage container lifecycle with env vars at startup.
 */
import { Container } from '@cloudflare/containers';
import { getTempR2Credentials } from './r2-credentials';
import { createSignedToken } from './signed-tokens';
import { mapCredentialsToEnvVars } from './integration-env';
import { decryptCredentials } from '../../../src/lib/integration-crypto';
import {
  createOpenRouterKey,
  encryptOpenRouterKey,
  decryptOpenRouterKey,
  getKeyHash,
} from './openrouter-keys';
import type { OrgDO } from './auth';
import type { WorkspaceDO } from './workspace';

export interface WorkspaceContainerEnv {
  SANDBOX: DurableObjectNamespace<WorkspaceContainer>;
  ORG: DurableObjectNamespace<OrgDO>;
  WORKSPACE: DurableObjectNamespace<WorkspaceDO>;
  R2_BUCKET: R2Bucket;
  EMAIL_TO_USER: KVNamespace;
  ANTHROPIC_API_KEY: string;
  TOKEN_SIGNING_SECRET: string;
  INTEGRATION_SECRET_KEY: string;
  CF_ACCOUNT_ID?: string;
  CF_DISPATCH_NAMESPACE?: string;
  R2_BUCKET_NAME?: string;
  R2_ACCOUNT_ID?: string;
  R2_MOUNT_DIR?: string;
  R2_MOUNT_READONLY?: string;
  R2_API_TOKEN?: string;
  R2_PARENT_ACCESS_KEY_ID?: string;
  WORKER_BASE_URL?: string;
  OPENROUTER_PROVISIONING_KEY?: string; // Parent key for creating per-org keys
  DISABLE_JUICEFS?: string;
  CHIRIDION_TRACE_EVENTS?: string;
  CHIRIDION_DEBUG_STARTUP?: string;
  CHIRIDION_DEBUG_SDK?: string;
  CHIRIDION_DEBUG_FS?: string;
  CHIRIDION_DEBUG_PROXY?: string;
  CHIRIDION_PREQUEUE_FIRST_MESSAGE?: string;
  CHIRIDION_FIRST_MESSAGE_DELAY_MS?: string;
  CLAUDE_CODE_ENABLE_TELEMETRY?: string;
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC?: string;
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS?: string;
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

// ws-server response types
interface WsServerUpdateEnvResponse {
  success: boolean;
  keys?: string[];
  error?: string;
}

// Port configuration
const WS_SERVER_PORT = 8080;
const CONTROL_PLANE_PORT = 9000;

// TTL for signed tokens (24 hours)
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Create a signed deploy token for a workspace container.
 * Token is self-validating (no KV storage needed).
 */
async function createDeployToken(
  secret: string,
  workspaceId: string,
  orgId: string,
  orgSlug: string,
  userId: string
): Promise<string> {
  return createSignedToken(secret, {
    org_id: orgId,
    org_slug: orgSlug,
    user_id: userId,
    scopes: ['deploy'],
    exp: Date.now() + TOKEN_TTL_MS,
    workspace_id: workspaceId,
    name: `deploy-${workspaceId}`,
  });
}

/**
 * WorkspaceContainer - One container per workspace.
 * Extends Container to handle WebSocket proxying and control plane operations.
 */
export class WorkspaceContainer extends Container<WorkspaceContainerEnv> {
  // Default port for WebSocket proxying (ws-server)
  defaultPort = WS_SERVER_PORT;

  // Idle timeout before container sleeps
  sleepAfter = '1h';

  // Enable outbound internet for API calls
  enableInternet = true;

  // Track the workspace + org IDs for this container
  private workspaceId: string | null = null;
  private orgId: string | null = null;
  // Track data proxy token expiry for registration with WorkspaceDO
  private dataProxyTokenExpiry: number | null = null;

  /**
   * Override fetch to ensure env vars are always set before container starts.
   * This prevents the container from auto-starting without proper configuration.
   */
  override async fetch(request: Request): Promise<Response> {
    if (!this.envVars || Object.keys(this.envVars).length === 0) {
      console.error('[WorkspaceContainer] fetch() called without env vars - container not initialized');
      return new Response(JSON.stringify({
        error: 'Container not initialized',
        message: 'Call startForWorkspace() before accessing container'
      }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return super.fetch(request);
  }

  // Lifecycle hooks
  override onStart(): void {
    console.log(
      `[WorkspaceContainer] Container started`,
      { workspaceId: this.workspaceId || 'unknown', orgId: this.orgId || 'unknown' }
    );
  }

  override onStop(): void {
    console.log(
      `[WorkspaceContainer] Container stopped`,
      { workspaceId: this.workspaceId || 'unknown', orgId: this.orgId || 'unknown' }
    );
  }

  override onError(error: unknown): void {
    console.error(
      `[WorkspaceContainer] Container error`,
      { workspaceId: this.workspaceId || 'unknown', orgId: this.orgId || 'unknown', error }
    );
    throw error;
  }

  /**
   * Build environment variables for container startup.
   */
  async buildEnvVars(workspaceId: string, orgId: string): Promise<Record<string, string>> {
    this.workspaceId = workspaceId;
    this.orgId = orgId;

    const envVars: Record<string, string> = {
      ORG_ID: orgId,
      WORKSPACE_ID: workspaceId,
    };

    // R2 config
    if (this.env.R2_BUCKET_NAME) envVars.R2_BUCKET_NAME = this.env.R2_BUCKET_NAME;
    if (this.env.R2_ACCOUNT_ID) envVars.R2_ACCOUNT_ID = this.env.R2_ACCOUNT_ID;
    if (this.env.R2_MOUNT_DIR) envVars.R2_MOUNT_DIR = this.env.R2_MOUNT_DIR;
    if (this.env.R2_MOUNT_READONLY) envVars.R2_MOUNT_READONLY = this.env.R2_MOUNT_READONLY;
    if (this.env.DISABLE_JUICEFS) envVars.DISABLE_JUICEFS = this.env.DISABLE_JUICEFS;
    if (this.env.CHIRIDION_TRACE_EVENTS) envVars.CHIRIDION_TRACE_EVENTS = this.env.CHIRIDION_TRACE_EVENTS;
    if (this.env.CHIRIDION_DEBUG_STARTUP) envVars.CHIRIDION_DEBUG_STARTUP = this.env.CHIRIDION_DEBUG_STARTUP;
    if (this.env.CHIRIDION_DEBUG_SDK) envVars.CHIRIDION_DEBUG_SDK = this.env.CHIRIDION_DEBUG_SDK;
    if (this.env.CHIRIDION_DEBUG_FS) envVars.CHIRIDION_DEBUG_FS = this.env.CHIRIDION_DEBUG_FS;
    if (this.env.CHIRIDION_DEBUG_PROXY) envVars.CHIRIDION_DEBUG_PROXY = this.env.CHIRIDION_DEBUG_PROXY;
    if (this.env.CHIRIDION_PREQUEUE_FIRST_MESSAGE) envVars.CHIRIDION_PREQUEUE_FIRST_MESSAGE = this.env.CHIRIDION_PREQUEUE_FIRST_MESSAGE;
    if (this.env.CHIRIDION_FIRST_MESSAGE_DELAY_MS) {
      envVars.CHIRIDION_FIRST_MESSAGE_DELAY_MS = this.env.CHIRIDION_FIRST_MESSAGE_DELAY_MS;
    }
    if (this.env.CLAUDE_CODE_ENABLE_TELEMETRY) {
      envVars.CLAUDE_CODE_ENABLE_TELEMETRY = this.env.CLAUDE_CODE_ENABLE_TELEMETRY;
    }
    if (this.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC) {
      envVars.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = this.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
    }
    if (this.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS) {
      envVars.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = this.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS;
    }

    // R2 prefix for workspace-scoped access (legacy org-id workspaces keep old prefix)
    const prefix = workspaceId === orgId ? `${orgId}/` : `${orgId}/${workspaceId}/`;
    envVars.R2_PREFIX = prefix;

    // Generate temp R2 credentials scoped to workspace prefix + JuiceFS volume prefix
    if (this.env.R2_API_TOKEN && this.env.R2_PARENT_ACCESS_KEY_ID && this.env.R2_ACCOUNT_ID && this.env.R2_BUCKET_NAME) {
      try {
        // JuiceFS volume name uses sanitized org/workspace IDs (matches entrypoint.sh logic)
        const sanitizeName = (s: string) => s.replace(/[^a-zA-Z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 20) || 'x';
        const orgSafe = sanitizeName(orgId);
        const wsSafe = sanitizeName(workspaceId);
        const juicefsVolumeName = `chiridion-${orgSafe}-${wsSafe}`;

        const tempCreds = await getTempR2Credentials(
          this.env.R2_ACCOUNT_ID,
          this.env.R2_BUCKET_NAME,
          this.env.R2_PARENT_ACCESS_KEY_ID,
          this.env.R2_API_TOKEN,
          [prefix, `${juicefsVolumeName}/`],  // Include both workspace prefix and JuiceFS volume prefix
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
        console.error('[WorkspaceContainer] Failed to get R2 credentials:', e);
      }
    }

    // Wrangler config (for deploys from container)
    // Use placeholder account ID - the proxy rewrites it to the real account ID
    // This avoids exposing our actual Cloudflare account ID to containers
    envVars.CLOUDFLARE_ACCOUNT_ID = 'chiridion';
    if (this.env.CF_DISPATCH_NAMESPACE) envVars.CF_DISPATCH_NAMESPACE = this.env.CF_DISPATCH_NAMESPACE;
    envVars.WRANGLER_SEND_METRICS = 'false';
    envVars.CI = '1';

    // Validate required config
    if (!this.env.TOKEN_SIGNING_SECRET) {
      throw new Error('TOKEN_SIGNING_SECRET is required for sandbox token signing');
    }

    // Get org info for user_id and org_slug (needed for all signed tokens)
    const orgStub = this.env.ORG.get(this.env.ORG.idFromName(orgId));
    const orgInfo = await orgStub.getInfo();
    const userId = orgInfo?.created_by || 'system';
    const orgName = orgInfo?.name || orgId;
    const orgSlug = orgInfo?.slug || `org-${orgId.slice(0, 3)}`;

    // Claude API Proxy config - create signed token for LLM access
    if (!this.env.WORKER_BASE_URL) {
      throw new Error('WORKER_BASE_URL is required for Claude API proxy');
    }

    const claudeApiToken = await createSignedToken(this.env.TOKEN_SIGNING_SECRET, {
      org_id: orgId,
      org_slug: orgSlug,
      user_id: userId,
      scopes: ['claude_api'],
      exp: Date.now() + TOKEN_TTL_MS,
      workspace_id: workspaceId,
      name: `claude-api-${workspaceId}`,
    });
    envVars.ANTHROPIC_BASE_URL = `${this.env.WORKER_BASE_URL}/api/claude`;
    envVars.ANTHROPIC_API_KEY = claudeApiToken;
    console.log('[WorkspaceContainer] Configured Claude API proxy for workspace', { workspaceId, orgId });

    // OpenRouter key available for agent's other uses (optional)
    let openRouterKey: string | null = null;
    const keyRecord = await orgStub.getOpenRouterKeyRecord();
    if (keyRecord) {
      try {
        openRouterKey = await decryptOpenRouterKey(keyRecord.key_encrypted, this.env.INTEGRATION_SECRET_KEY);
        envVars.OPENROUTER_API_KEY = openRouterKey;
        console.log('[WorkspaceContainer] OpenRouter key available for agent', { orgId, keyHash: keyRecord.key_hash });
      } catch (e) {
        console.error('[WorkspaceContainer] Failed to decrypt org OpenRouter key:', e);
      }
    } else if (this.env.OPENROUTER_PROVISIONING_KEY) {
      // Create OpenRouter key for org if provisioning is available
      try {
        console.log('[WorkspaceContainer] Creating new OpenRouter key for org', { orgId, orgName });
        const keyResponse = await createOpenRouterKey(this.env.OPENROUTER_PROVISIONING_KEY, {
          name: `Chiridion - ${orgName}`,
        });
        openRouterKey = keyResponse.key;

        // Store encrypted key in org
        const keyHash = getKeyHash(openRouterKey);
        const keyEncrypted = await encryptOpenRouterKey(openRouterKey, this.env.INTEGRATION_SECRET_KEY);
        await orgStub.setOpenRouterKey(
          keyHash,
          keyEncrypted,
          `Chiridion - ${orgName}`,
          keyResponse.data.hash,
          null
        );
        envVars.OPENROUTER_API_KEY = openRouterKey;
        console.log('[WorkspaceContainer] Created and stored new org OpenRouter key', { orgId, keyHash });
      } catch (e) {
        console.error('[WorkspaceContainer] Failed to create org OpenRouter key:', e);
      }
    }

    // Cloudflare API proxy config
    // Create a workspace-scoped deploy token for container to use with Cloudflare API
    if (this.env.WORKER_BASE_URL) {
      envVars.WORKER_BASE_URL = this.env.WORKER_BASE_URL;
      envVars.CLOUDFLARE_API_BASE_URL = `${this.env.WORKER_BASE_URL}/client/v4`;

      const deployToken = await createDeployToken(this.env.TOKEN_SIGNING_SECRET, workspaceId, orgId, orgSlug, userId);
      envVars.CLOUDFLARE_API_TOKEN = deployToken;
      console.log('[WorkspaceContainer] Created signed deploy token for workspace', { workspaceId, orgId, orgSlug });

      // Data Proxy token - allows container to access data sources via HTTP API
      const dataProxyTokenExpiry = Date.now() + TOKEN_TTL_MS;
      const dataProxyToken = await createSignedToken(this.env.TOKEN_SIGNING_SECRET, {
        org_id: orgId,
        org_slug: orgSlug,
        user_id: userId,
        scopes: ['data-proxy'],
        exp: dataProxyTokenExpiry,
        workspace_id: workspaceId,
        name: `data-proxy-${workspaceId}`,
      });
      envVars.DATA_PROXY_TOKEN = dataProxyToken;
      envVars.DATA_PROXY_URL = `${this.env.WORKER_BASE_URL}/api`;

      // Store expiry for later registration with WorkspaceDO
      this.dataProxyTokenExpiry = dataProxyTokenExpiry;
    }

    // Token expires in 24 hours
    const tokenExpiry = Date.now() + TOKEN_TTL_MS;

    // MCP server config (create signed token for MCP access)
    // MCP endpoint is on the main worker at /mcp
    if (this.env.WORKER_BASE_URL) {
      // MCP tokens are now per-thread and passed via WebSocket headers (X-Chiridion-MCP-Token)
      envVars.MCP_SERVER_URL = `${this.env.WORKER_BASE_URL}/mcp`;
    }

    return envVars;
  }

  /**
   * Start container with workspace-specific environment variables.
   * If container is already running, returns immediately without rebuilding env vars.
   */
  async startForWorkspace(workspaceId: string, orgId: string): Promise<void> {
    this.workspaceId = workspaceId;
    this.orgId = orgId;
    const startTs = Date.now();

    // Only build env vars once per container instance - they're set as class property
    // so Container class uses them for any start path (including auto-restarts)
    if (!this.envVars || Object.keys(this.envVars).length === 0) {
      console.log('[WorkspaceContainer] Building env vars for workspace:', { workspaceId, orgId });
      const envStart = Date.now();
      const envVars = await this.buildEnvVars(workspaceId, orgId);
      console.log('[WorkspaceContainer] Built env vars', { workspaceId, orgId, ms: Date.now() - envStart });
      this.envVars = envVars;
    }

    const state = await this.getState();
    console.log('[WorkspaceContainer] Container state:', state.status, 'for workspace:', workspaceId);

    // Only skip if container is fully healthy (ready to serve requests)
    // 'running' means container is still booting - NOT ready yet
    if (state.status === 'healthy') {
      console.log('[WorkspaceContainer] startForWorkspace skipping start; container healthy', { workspaceId });
      return;
    }

    // Container is stopped, stopping, or still 'running' (booting) - need to wait for ports
    console.log('[WorkspaceContainer] Starting/waiting for container', { workspaceId, orgId, status: state.status });

    const waitStart = Date.now();
    await this.startAndWaitForPorts({
      ports: [WS_SERVER_PORT, CONTROL_PLANE_PORT],
      cancellationOptions: {
        instanceGetTimeoutMS: 30000,
        portReadyTimeoutMS: 60000,
      },
    });
    const waitMs = Date.now() - waitStart;

    console.log('[WorkspaceContainer] Container started and ports ready for workspace:', {
      workspaceId,
      orgId,
      waitMs,
      totalMs: Date.now() - startTs,
    });

    // Push integration env vars after container is ready
    // This writes to /etc/profile.d/chiridion-integrations.sh so bash commands can access them
    const pushSuccess = await this.refreshIntegrationEnvVars(workspaceId);
    console.log('[WorkspaceContainer] Refreshed integration env vars', {
      workspaceId,
      orgId,
      success: pushSuccess,
    });

    // Register data proxy token expiry with WorkspaceDO for auto-refresh scheduling
    if (this.dataProxyTokenExpiry) {
      try {
        const workspaceStub = this.env.WORKSPACE.get(this.env.WORKSPACE.idFromName(workspaceId));
        await workspaceStub.registerDataProxyTokenExpiry(this.dataProxyTokenExpiry);
      } catch (err) {
        console.error('[WorkspaceContainer] Failed to register data proxy token expiry:', err);
      }
    }
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
   * Write a binary file to the container (content is base64-encoded).
   */
  async writeBinaryFile(path: string, base64Content: string): Promise<ControlPlaneWriteResponse> {
    return this.controlPlane<ControlPlaneWriteResponse>('/fs/write', {
      path,
      content: base64Content,
      encoding: 'base64',
    });
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

  /**
   * Fetch integration env vars for this workspace.
   * Returns a map of INT_* env vars from integrations, plus DATA_PROXY_TOKEN.
   */
  async fetchIntegrationEnvVars(workspaceId: string): Promise<Record<string, string>> {
    const integrationEnvVars: Record<string, string> = {};
    try {
      const workspaceStub = this.env.WORKSPACE.get(this.env.WORKSPACE.idFromName(workspaceId));
      const records = await workspaceStub.getIntegrations();

      for (const record of records) {
        const credentials = await decryptCredentials(record.credentials_encrypted, this.env.INTEGRATION_SECRET_KEY);
        const config = JSON.parse(record.config) as Record<string, unknown>;
        Object.assign(integrationEnvVars, mapCredentialsToEnvVars(record.name, record.integration_type, credentials, config));
      }

      // Also generate fresh data proxy token for refresh
      const dataProxyResult = await workspaceStub.generateDataProxyToken();
      if (dataProxyResult) {
        integrationEnvVars.DATA_PROXY_TOKEN = dataProxyResult.token;
        // Update our tracked expiry
        this.dataProxyTokenExpiry = dataProxyResult.expiresAt;
      }

      console.log('[WorkspaceContainer] Fetched integration env vars:', Object.entries(integrationEnvVars).map(
        ([k, v]) => `${k}=${v.length} chars`
      ));
    } catch (e) {
      console.error('[WorkspaceContainer] Failed to fetch integration env vars:', e);
    }
    return integrationEnvVars;
  }

  /**
   * Push integration env vars to ws-server.
   * Called when integrations are created/updated/deleted to update the running container.
   * Also called after container startup to set initial integration env vars.
   * Returns true if successful, false if container is not running or push failed.
   */
  async pushIntegrationEnvVars(envVars: Record<string, string>): Promise<boolean> {
    try {
      // Check if container is running/healthy before pushing
      const state = await this.getState();
      if (state.status !== 'healthy' && state.status !== 'running') {
        console.log('[WorkspaceContainer] Container not running, skipping env push', { status: state.status });
        return false;
      }

      const response = await this.containerFetch('http://container/update-env', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ env: envVars }),
      }, WS_SERVER_PORT);

      if (!response.ok) {
        const text = await response.text();
        console.error('[WorkspaceContainer] Failed to push env vars:', response.status, text);
        return false;
      }

      const result = await response.json() as WsServerUpdateEnvResponse;
      console.log('[WorkspaceContainer] Pushed integration env vars:', result.keys?.length ?? 0, 'keys');
      return result.success;
    } catch (e) {
      // Container may not be running or ws-server may not be ready
      console.error('[WorkspaceContainer] Error pushing env vars:', e);
      return false;
    }
  }

  /**
   * Refresh integration env vars by fetching from WorkspaceDO and pushing to container.
   * Combines fetchIntegrationEnvVars + pushIntegrationEnvVars in a single RPC call.
   * Returns true if successful, false if container is not running or push failed.
   */
  async refreshIntegrationEnvVars(workspaceId: string): Promise<boolean> {
    const envVars = await this.fetchIntegrationEnvVars(workspaceId);
    return this.pushIntegrationEnvVars(envVars);
  }
}

/**
 * Get sandbox ID for a workspace (one container per workspace).
 */
export function getContainerIdForWorkspace(workspaceId: string): string {
  const safeId = workspaceId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `ws-${safeId}`.slice(0, 63);
}

/**
 * Get container stub for a workspace.
 */
export function getWorkspaceContainer(
  env: WorkspaceContainerEnv,
  workspaceId: string
): DurableObjectStub<WorkspaceContainer> {
  const containerId = getContainerIdForWorkspace(workspaceId);
  return env.SANDBOX.get(env.SANDBOX.idFromName(containerId));
}

/**
 * Handle WebSocket upgrade with container management.
 * Includes retry logic for transient failures.
 */
export async function handleWebSocketUpgrade(
  request: Request,
  env: WorkspaceContainerEnv,
  workspaceId: string,
  orgId: string
): Promise<Response> {
  const url = new URL(request.url);
  console.log('[handleWebSocketUpgrade] Starting', {
    workspaceId,
    orgId,
    url: url.toString(),
    method: request.method,
    upgrade: request.headers.get('Upgrade'),
    connection: request.headers.get('Connection'),
  });

  const container = getWorkspaceContainer(env, workspaceId);
  const maxRetries = 2;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      console.log('[handleWebSocketUpgrade] Starting container', { workspaceId, orgId, attempt });

      // Start container if not running (startForWorkspace handles integration env vars push)
      await container.startForWorkspace(workspaceId, orgId);

      console.log('[handleWebSocketUpgrade] Container ready, proxying WebSocket via fetch()', {
        workspaceId,
        orgId,
        attempt,
      });

      // IMPORTANT: Use container.fetch() directly, NOT a custom method.
      // The Container class's fetch() handles WebSocket forwarding specially.
      // Calling a custom method like proxyWebSocket() creates an RPC boundary
      // that can't serialize WebSocket objects.
      const response = await container.fetch(request);

      console.log('[handleWebSocketUpgrade] fetch() response', {
        workspaceId,
        orgId,
        attempt,
        status: response.status,
        webSocket: !!response.webSocket,
      });

      return response;
    } catch (e) {
      console.error('[handleWebSocketUpgrade] Error:', {
        workspaceId,
        orgId,
        attempt,
        error: String(e),
        stack: e instanceof Error ? e.stack : undefined,
      });
      if (attempt < maxRetries) {
        console.log('[handleWebSocketUpgrade] Retrying after error...', { workspaceId, attempt });
        await new Promise(resolve => setTimeout(resolve, 1000));
        continue;
      }
      return new Response(`Container error: ${String(e)}`, { status: 500 });
    }
  }

  return new Response('Failed to connect to container after retries', { status: 500 });
}
