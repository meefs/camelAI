/**
 * Workspace runtime backed by Docker + gVisor sandboxes.
 *
 * Architecture:
 * - Sandbox host (services/sandbox-host/): Manages Docker container lifecycle,
 *   host filesystem operations, exec, and proxies control plane traffic
 *   (health, env, chat WebSocket) to containers.
 * - Control plane (sandbox/control-plane.mjs): Runs inside the container as
 *   the main entrypoint on port 8080. Handles env push and Claude Agent SDK
 *   chat sessions.
 * - This module: Orchestrates sandbox lifecycle via the proxy, pushes env
 *   vars to the control plane, provides FS/exec APIs for dashboard routes,
 *   and exposes connectChatWebSocket() for ChatThreadDO.
 *
 * All traffic (lifecycle, FS, exec, control plane) routes through the
 * sandbox host proxy — CF Workers can't reach Docker bridge IPs directly.
 */
import { createSignedToken } from './signed-tokens';
import { mapCredentialsToEnvVars } from './integration-env';
import { decryptCredentials } from '../../../src/lib/integration-crypto';
import {
  createOpenRouterKey,
  encryptOpenRouterKey,
  decryptOpenRouterKey,
  getKeyHash,
} from './openrouter-keys';
import { waitUntil } from 'cloudflare:workers';
import type { OrgDO } from './auth';
import type { WorkspaceDO } from './workspace';

export interface WorkspaceContainerEnv {
  ORG: DurableObjectNamespace<OrgDO>;
  WORKSPACE: DurableObjectNamespace<WorkspaceDO>;
  R2_BUCKET: R2Bucket;
  EMAIL_TO_USER: KVNamespace;
  ANTHROPIC_API_KEY: string;
  TOKEN_SIGNING_SECRET: string;
  INTEGRATION_SECRET_KEY: string;
  CF_ACCOUNT_ID?: string;
  CF_DISPATCH_NAMESPACE?: string;
  WORKER_BASE_URL?: string;
  OPENROUTER_PROVISIONING_KEY?: string;
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

  // Sandbox host — VPC binding (deployed) or URL fallback (local dev)
  SANDBOX_HOST?: Fetcher;
  SANDBOX_HOST_URL?: string;
}

interface ControlPlaneExecResponse {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  killed?: boolean;
  signal?: string | null;
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

interface ControlPlaneWriteResponse {
  success: boolean;
  error?: string;
  code?: string;
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

interface ControlPlaneExistsResponse {
  exists: boolean;
  isFile?: boolean;
  isDirectory?: boolean;
  size?: number;
  modifiedAt?: string;
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

interface SandboxRecord {
  id: string;
  name: string;
  status: string;
}

export interface ClaudeRunnerEnvOptions {
  threadId: string;
  threadDeployToken?: string | null;
  mcpToken?: string | null;
}

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const runtimeCache = new Map<string, WorkspaceContainer>();
const INTEGRATION_ENV_FILE_PATH = '/home/claude/.chiridion/integration.env';

const PROXY_RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504, 524]);
const PROXY_MAX_RETRY_ATTEMPTS = 6;
const PROXY_BASE_RETRY_DELAY_MS = 250;
const PROXY_MAX_RETRY_DELAY_MS = 3000;

function toIsoTime(ms: number): string {
  return new Date(ms).toISOString();
}

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

export class WorkspaceContainer {
  private workspaceId: string;
  private orgId: string;
  private envVars: Record<string, string> | null = null;
  private sandbox: SandboxRecord | null = null;
  private sandboxKnownToExist = false;
  private dataProxyTokenExpiry: number | null = null;

  constructor(private env: WorkspaceContainerEnv, workspaceId: string, orgId: string) {
    this.workspaceId = workspaceId;
    this.orgId = orgId;
  }

  matchesEnv(env: WorkspaceContainerEnv): boolean {
    return this.env === env;
  }

  // ─── Proxy (lifecycle + FS + exec) ──────────────────────

  /**
   * Fetch via the sandbox host — uses Workers VPC binding when available
   * (deployed envs), falls back to direct HTTP for local dev.
   */
  private async fetchProxy(
    path: string,
    init: RequestInit = {},
    query: Record<string, string | number | boolean | undefined> = {}
  ): Promise<Response> {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const url = new URL(`http://localhost${normalizedPath}`);
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }

    const headers = new Headers(init.headers);

    // Use VPC binding when available (deployed envs), otherwise fall back to direct HTTP (local dev)
    if (this.env.SANDBOX_HOST) {
      return this.env.SANDBOX_HOST.fetch(url.toString(), { ...init, headers });
    }

    // Local dev fallback — use SANDBOX_HOST_URL or default
    const baseUrl = (this.env.SANDBOX_HOST_URL || 'http://localhost:4400').replace(/\/$/, '');
    const fallbackUrl = new URL(`${baseUrl}${normalizedPath}`);
    for (const [key, value] of url.searchParams.entries()) {
      fallbackUrl.searchParams.set(key, value);
    }
    return fetch(fallbackUrl.toString(), { ...init, headers });
  }

  // ─── Path Helpers ────────────────────────────────────────

  private normalizeFsPath(path: string): string {
    if (!path) return '/';
    return path.startsWith('/') ? path : `/${path}`;
  }

  private joinFsPath(base: string, name: string): string {
    const normalizedBase = this.normalizeFsPath(base);
    if (!name) return normalizedBase;
    if (normalizedBase === '/') return `/${name}`;
    return `${normalizedBase}/${name}`;
  }

  private dirnameFsPath(path: string): string {
    const normalized = this.normalizeFsPath(path);
    if (normalized === '/') return '/';
    const idx = normalized.lastIndexOf('/');
    if (idx <= 0) return '/';
    return normalized.slice(0, idx);
  }

  private basenameFsPath(path: string): string {
    const normalized = this.normalizeFsPath(path);
    if (normalized === '/') return '/';
    const idx = normalized.lastIndexOf('/');
    return idx < 0 ? normalized : normalized.slice(idx + 1);
  }

  // ─── Retry Helpers ───────────────────────────────────────

  private computeRetryDelayMs(attempt: number): number {
    const exponential = Math.min(
      PROXY_MAX_RETRY_DELAY_MS,
      PROXY_BASE_RETRY_DELAY_MS * Math.pow(2, Math.max(0, attempt - 1))
    );
    const jitter = Math.floor(Math.random() * 120);
    return exponential + jitter;
  }

  private isRetryableStatus(status: number): boolean {
    return PROXY_RETRYABLE_STATUS_CODES.has(status);
  }

  private isRetryableError(err: unknown): boolean {
    const message = String((err as { message?: unknown })?.message || err || '').toLowerCase();
    return message.includes('timed out')
      || message.includes('timeout')
      || message.includes('network')
      || message.includes('econnrefused');
  }

  private isLocalOnlyWorkerBaseUrl(baseUrl: string): boolean {
    try {
      const url = new URL(baseUrl);
      const host = url.hostname.toLowerCase();
      return host === 'localhost'
        || host === '127.0.0.1'
        || host === '::1'
        || host === 'host.docker.internal';
    } catch {
      return false;
    }
  }

  // ─── Exec + FS via Proxy ─────────────────────────────────

  private sandboxProxyPath(subpath: string): string {
    const name = this.getSandboxName();
    return `/v1/sandboxes/${encodeURIComponent(name)}${subpath}`;
  }

  /**
   * Execute a command on the sandbox via the proxy POST /exec endpoint.
   */
  private async execOnSandbox(
    args: string[],
    options: { cwd?: string; env?: Record<string, string> } = {}
  ): Promise<ControlPlaneExecResponse> {
    if (args.length === 0) {
      return { success: false, stdout: '', stderr: 'No command provided', exitCode: 1 };
    }

    const response = await this.fetchProxy(this.sandboxProxyPath('/exec'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd: args, cwd: options.cwd, env: options.env }),
    });

    if (!response.ok) {
      const body = await response.text();
      return { success: false, stdout: '', stderr: body, exitCode: response.status };
    }

    return await response.json() as ControlPlaneExecResponse;
  }

  async exec(command: string, options?: { timeout?: number; cwd?: string }): Promise<ControlPlaneExecResponse> {
    return this.execOnSandbox(['bash', '-lc', command], { cwd: options?.cwd });
  }

  // ─── FS Helpers ──────────────────────────────────────────

  private parseFsListEntries(payload: unknown): Array<{
    name: string;
    type: 'file' | 'directory';
    size: number;
    modifiedAt: string;
  }> {
    const rawEntries = Array.isArray(payload)
      ? payload
      : Array.isArray((payload as { files?: unknown[] })?.files)
        ? (payload as { files: unknown[] }).files
        : Array.isArray((payload as { entries?: unknown[] })?.entries)
          ? (payload as { entries: unknown[] }).entries
          : Array.isArray((payload as { items?: unknown[] })?.items)
            ? (payload as { items: unknown[] }).items
            : [];

    const nowIso = toIsoTime(Date.now());

    return rawEntries.flatMap((entry) => {
      const raw = (entry ?? {}) as Record<string, unknown>;
      const name = typeof raw.name === 'string'
        ? raw.name
        : typeof raw.path === 'string'
          ? this.basenameFsPath(raw.path)
          : '';
      if (!name || name === '/') return [];

      const rawType = typeof raw.type === 'string' ? raw.type.toLowerCase() : '';
      const isDir = rawType === 'directory' || rawType === 'dir' || raw.isDir === true || raw.isDirectory === true;
      const type: 'file' | 'directory' = isDir ? 'directory' : 'file';
      const size = typeof raw.size === 'number' ? raw.size : 0;
      const modifiedAt = typeof raw.modifiedAt === 'string'
        ? raw.modifiedAt
        : typeof raw.mtime === 'string'
          ? raw.mtime
          : typeof raw.updatedAt === 'string'
            ? raw.updatedAt
            : nowIso;

      return [{ name, type, size, modifiedAt }];
    });
  }


  // ─── Sandbox Lifecycle ───────────────────────────────────

  private getSandboxName(): string {
    const raw = `chiridion-${getContainerIdForWorkspace(this.workspaceId)}`;
    const normalized = raw
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    return (normalized || `chiridion-${Date.now()}`).slice(0, 63);
  }

  private async ensureSandboxExists(name: string): Promise<SandboxRecord> {
    if (this.sandboxKnownToExist && this.sandbox) {
      return this.sandbox;
    }

    // Create or reconnect via the proxy (idempotent POST)
    // Pass orgId + workspaceId so sandbox-host can set up R2 bind mounts at creation time.
    const response = await this.fetchProxy(`/v1/sandboxes/${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgId: this.orgId, workspaceId: this.workspaceId }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Failed to ensure sandbox ${name}: ${response.status} ${body}`);
    }

    const data = await response.json() as {
      id: string;
      name: string;
      status: string;
    };
    this.sandbox = {
      id: data.id,
      name: data.name,
      status: data.status || 'warm',
    };
    this.sandboxKnownToExist = true;
    return this.sandbox;
  }

  private async ensureSandbox(): Promise<SandboxRecord> {
    if (this.sandbox) return this.sandbox;
    return this.ensureSandboxExists(this.getSandboxName());
  }

  private async clearSandboxUserClaudeDir(): Promise<void> {
    const response = await this.fetchProxy(this.sandboxProxyPath('/fs/delete'), {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/home/claude/.claude', recursive: true }),
    });

    if (!response.ok && response.status !== 404) {
      const body = await response.text();
      throw new Error(`Failed clearing /home/claude/.claude: ${response.status} ${body}`);
    }
  }

  async provisionSandbox(): Promise<SandboxRecord> {
    const name = this.getSandboxName();
    console.log(`[Sandbox] provisioning sandbox=${name} workspace=${this.workspaceId}`);
    const sandbox = await this.ensureSandboxExists(name);
    await this.clearSandboxUserClaudeDir();
    console.log(`[Sandbox] sandbox=${name} ready (status=${sandbox.status})`);
    return sandbox;
  }

  /**
   * Ensure the sandbox exists and is ready.
   * Everything (SDK, skills, create-worker) is baked into the sandbox image,
   * so this just needs to create/reconnect the sandbox via the proxy.
   */
  async ensureSandboxReady(): Promise<void> {
    await this.ensureSandbox();
  }

  // ─── Env Vars ────────────────────────────────────────────

  /**
   * Push workspace-level env vars to the control plane via the proxy.
   */
  private async pushEnvToControlPlane(envVars: Record<string, string>): Promise<void> {
    const response = await this.fetchProxy(this.sandboxProxyPath('/env'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(envVars),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Failed to push env to control plane: ${response.status} ${body}`);
    }
  }

  async buildEnvVars(): Promise<Record<string, string>> {
    const { workspaceId, orgId } = this;
    const buildStartedAt = Date.now();
    console.log(`[WorkspaceContainer] buildEnvVars:start workspace=${workspaceId} org=${orgId}`);

    const envVars: Record<string, string> = {
      ORG_ID: orgId,
      WORKSPACE_ID: workspaceId,
    };

    if (this.env.CHIRIDION_TRACE_EVENTS) envVars.CHIRIDION_TRACE_EVENTS = this.env.CHIRIDION_TRACE_EVENTS;
    if (this.env.CHIRIDION_DEBUG_STARTUP) envVars.CHIRIDION_DEBUG_STARTUP = this.env.CHIRIDION_DEBUG_STARTUP;
    if (this.env.CHIRIDION_DEBUG_SDK) envVars.CHIRIDION_DEBUG_SDK = this.env.CHIRIDION_DEBUG_SDK;
    if (this.env.CHIRIDION_DEBUG_FS) envVars.CHIRIDION_DEBUG_FS = this.env.CHIRIDION_DEBUG_FS;
    if (this.env.CHIRIDION_DEBUG_PROXY) envVars.CHIRIDION_DEBUG_PROXY = this.env.CHIRIDION_DEBUG_PROXY;
    if (this.env.CHIRIDION_PREQUEUE_FIRST_MESSAGE) envVars.CHIRIDION_PREQUEUE_FIRST_MESSAGE = this.env.CHIRIDION_PREQUEUE_FIRST_MESSAGE;
    if (this.env.CHIRIDION_FIRST_MESSAGE_DELAY_MS) envVars.CHIRIDION_FIRST_MESSAGE_DELAY_MS = this.env.CHIRIDION_FIRST_MESSAGE_DELAY_MS;
    if (this.env.CLAUDE_CODE_ENABLE_TELEMETRY) envVars.CLAUDE_CODE_ENABLE_TELEMETRY = this.env.CLAUDE_CODE_ENABLE_TELEMETRY;
    if (this.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC) envVars.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = this.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
    if (this.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS) envVars.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = this.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS;

    const prefix = workspaceId === orgId ? `${orgId}/` : `${orgId}/${workspaceId}/`;

    if (!this.env.TOKEN_SIGNING_SECRET) {
      throw new Error('TOKEN_SIGNING_SECRET is required for token signing');
    }
    if (!this.env.WORKER_BASE_URL) {
      throw new Error('WORKER_BASE_URL is required for Claude API proxy');
    }

    const workerBaseUrl = this.env.WORKER_BASE_URL;
    if (this.isLocalOnlyWorkerBaseUrl(workerBaseUrl)) {
      throw new Error(
        `WORKER_BASE_URL must be publicly reachable from sandboxes (got ${workerBaseUrl}). ` +
        'Use an ngrok URL for local development.'
      );
    }

    // ─── Phase 1: Parallel fetches (no dependencies) ─────────────
    const phase1StartedAt = Date.now();
    const orgStub = this.env.ORG.get(this.env.ORG.idFromName(orgId));

    const [orgInfo, keyRecord] = await Promise.all([
      orgStub.getInfo(),
      orgStub.getOpenRouterKeyRecord(),
    ]);
    console.log(`[WorkspaceContainer] buildEnvVars:phase1 workspace=${workspaceId} ms=${Date.now() - phase1StartedAt}`);

    const userId = orgInfo?.created_by || 'system';
    const orgName = orgInfo?.name || orgId;
    const orgSlug = orgInfo?.slug || `org-${orgId.slice(0, 3)}`;

    // ─── Phase 2: Parallel operations (depend on phase 1) ────────
    const phase2StartedAt = Date.now();
    const dataProxyTokenExpiry = Date.now() + TOKEN_TTL_MS;

    // R2 placeholder check (fire and forget in background)
    if (this.env.R2_BUCKET) {
      const placeholderKey = `${prefix}.keep`;
      waitUntil(
        this.env.R2_BUCKET.head(placeholderKey).then((existing) => {
          if (!existing) return this.env.R2_BUCKET.put(placeholderKey, '');
        }).catch((e) => console.error('[WorkspaceContainer] R2 placeholder check failed:', e))
      );
    }

    // All token signing in parallel
    const tokenPromises = Promise.all([
      createSignedToken(this.env.TOKEN_SIGNING_SECRET, {
        org_id: orgId,
        org_slug: orgSlug,
        user_id: userId,
        scopes: ['claude_api'],
        exp: Date.now() + TOKEN_TTL_MS,
        workspace_id: workspaceId,
        name: `claude-api-${workspaceId}`,
      }),
      createDeployToken(this.env.TOKEN_SIGNING_SECRET, workspaceId, orgId, orgSlug, userId),
      createSignedToken(this.env.TOKEN_SIGNING_SECRET, {
        org_id: orgId,
        org_slug: orgSlug,
        user_id: userId,
        scopes: ['data-proxy'],
        exp: dataProxyTokenExpiry,
        workspace_id: workspaceId,
        name: `data-proxy-${workspaceId}`,
      }),
    ]);

    // OpenRouter key handling
    const openRouterPromise = (async (): Promise<string | null> => {
      if (keyRecord) {
        try {
          return await decryptOpenRouterKey(keyRecord.key_encrypted, this.env.INTEGRATION_SECRET_KEY);
        } catch (e) {
          console.error('[WorkspaceContainer] Failed to decrypt org OpenRouter key:', e);
          return null;
        }
      } else if (this.env.OPENROUTER_PROVISIONING_KEY) {
        try {
          const keyResponse = await createOpenRouterKey(this.env.OPENROUTER_PROVISIONING_KEY, {
            name: `Chiridion - ${orgName}`,
          });
          const keyHash = getKeyHash(keyResponse.key);
          const keyEncrypted = await encryptOpenRouterKey(keyResponse.key, this.env.INTEGRATION_SECRET_KEY);
          // Fire and forget the storage write
          waitUntil(
            orgStub.setOpenRouterKey(
              keyHash,
              keyEncrypted,
              `Chiridion - ${orgName}`,
              keyResponse.data.hash,
              null
            ).catch((e) => console.error('[WorkspaceContainer] Failed to store OpenRouter key:', e))
          );
          return keyResponse.key;
        } catch (e) {
          console.error('[WorkspaceContainer] Failed to create org OpenRouter key:', e);
          return null;
        }
      }
      return null;
    })();

    const [[claudeApiToken, deployToken, dataProxyToken], openRouterKey] = await Promise.all([
      tokenPromises,
      openRouterPromise,
    ]);
    console.log(`[WorkspaceContainer] buildEnvVars:phase2 workspace=${workspaceId} ms=${Date.now() - phase2StartedAt}`);

    // Apply tokens
    envVars.ANTHROPIC_BASE_URL = `${workerBaseUrl}/api/claude`;
    envVars.ANTHROPIC_API_KEY = claudeApiToken;
    envVars.CLOUDFLARE_API_TOKEN = deployToken;
    envVars.DATA_PROXY_TOKEN = dataProxyToken;
    envVars.DATA_PROXY_URL = `${workerBaseUrl}/api`;
    this.dataProxyTokenExpiry = dataProxyTokenExpiry;

    if (openRouterKey) {
      envVars.OPENROUTER_API_KEY = openRouterKey;
    }

    envVars.CLOUDFLARE_ACCOUNT_ID = 'chiridion';
    if (this.env.CF_DISPATCH_NAMESPACE) envVars.CF_DISPATCH_NAMESPACE = this.env.CF_DISPATCH_NAMESPACE;
    envVars.WRANGLER_SEND_METRICS = 'false';
    envVars.CI = '1';
    envVars.WORKER_BASE_URL = workerBaseUrl;
    envVars.CLOUDFLARE_API_BASE_URL = `${workerBaseUrl}/client/v4`;
    envVars.MCP_SERVER_URL = `${workerBaseUrl}/mcp`;

    console.log(`[WorkspaceContainer] buildEnvVars:done workspace=${workspaceId} org=${orgId} totalMs=${Date.now() - buildStartedAt}`);
    return envVars;
  }

  /**
   * Start the workspace runtime with the given env vars.
   * Env vars should be pre-built (and cached) by WorkspaceDO.ensureSandboxReady().
   */
  async startForWorkspace(prebuiltEnvVars?: Record<string, string>): Promise<void> {
    // If we already have env vars pushed, skip
    if (this.envVars && Object.keys(this.envVars).length > 0) {
      console.log(`[Sandbox] startForWorkspace: already initialized workspace=${this.workspaceId}`);
      return;
    }

    // Use prebuilt env vars if provided, otherwise build (fallback for legacy callers)
    if (prebuiltEnvVars && Object.keys(prebuiltEnvVars).length > 0) {
      console.log(`[Sandbox] startForWorkspace: using prebuilt env vars workspace=${this.workspaceId}`);
      this.envVars = prebuiltEnvVars;
    } else {
      console.log(`[Sandbox] startForWorkspace: building env vars (no cache) workspace=${this.workspaceId} org=${this.orgId}`);
      this.envVars = await this.buildEnvVars();
    }

    // Push workspace env to control plane
    await this.pushEnvToControlPlane(this.envVars);

    if (this.dataProxyTokenExpiry) {
      try {
        const workspaceStub = this.env.WORKSPACE.get(this.env.WORKSPACE.idFromName(this.workspaceId));
        await workspaceStub.registerDataProxyTokenExpiry(this.dataProxyTokenExpiry);
      } catch (err) {
        console.error('[WorkspaceContainer] Failed to register data proxy token expiry:', err);
      }
    }
  }

  /**
   * Build thread-specific env vars (delta from workspace env).
   * Passed to the control plane chat WebSocket init message.
   */
  async buildClaudeRunnerEnv(options: ClaudeRunnerEnvOptions): Promise<Record<string, string>> {
    if (!this.workspaceId) {
      throw new Error('WorkspaceContainer not initialized');
    }

    console.log(`[Sandbox] buildClaudeRunnerEnv: thread=${options.threadId}`);
    const integrationEnv = await this.fetchIntegrationEnvVars();

    await this.writeIntegrationEnvFileToSandbox(integrationEnv);

    const env: Record<string, string> = {
      ...integrationEnv,
      CHIRIDION_THREAD_ID: options.threadId,
      DEBUG_CLAUDE_AGENT_SDK: '1',
      CLAUDE_ENV_FILE: INTEGRATION_ENV_FILE_PATH,
    };

    if (options.threadDeployToken) env.CHIRIDION_THREAD_DEPLOY_TOKEN = options.threadDeployToken;
    if (options.mcpToken) env.CHIRIDION_MCP_TOKEN = options.mcpToken;

    return env;
  }

  // ─── Chat WebSocket ──────────────────────────────────────

  /**
   * Open a WebSocket to the control plane's /chat endpoint via the proxy.
   * ChatThreadDO uses this to bridge chat clients to the Claude Agent SDK
   * running in-process inside the sandbox.
   */
  async connectChatWebSocket(): Promise<WebSocket> {
    await this.ensureSandbox();

    const wsPath = this.sandboxProxyPath('/chat');
    console.log(`[Sandbox] connectChatWebSocket: connecting via proxy`);

    const headers: Record<string, string> = { Upgrade: 'websocket' };
    let response: Response;

    if (this.env.SANDBOX_HOST) {
      // VPC binding — use absolute URL with http:// (tunnel handles transport)
      response = await this.env.SANDBOX_HOST.fetch(`http://localhost${wsPath}`, { headers });
    } else {
      // Local dev fallback
      const baseUrl = (this.env.SANDBOX_HOST_URL || 'http://localhost:4400').replace(/\/$/, '');
      response = await fetch(`${baseUrl}${wsPath}`, { headers });
    }

    if (response.status !== 101 || !response.webSocket) {
      const body = await response.text();
      console.error(`[Sandbox] connectChatWebSocket: upgrade failed status=${response.status} body=${body.slice(0, 500)}`);
      throw new Error(`Failed to open chat websocket: ${response.status} ${body}`);
    }

    console.log(`[Sandbox] connectChatWebSocket: websocket opened`);
    return response.webSocket;
  }

  // ─── Integration Env Vars ────────────────────────────────

  /**
   * Write integration env vars to a dotenv file on the sandbox.
   */
  private async writeIntegrationEnvFileToSandbox(envVars: Record<string, string>): Promise<boolean> {
    try {
      const lines: string[] = [];
      for (const [key, value] of Object.entries(envVars)) {
        const escaped = value
          .replace(/\\/g, '\\\\')
          .replace(/"/g, '\\"')
          .replace(/\n/g, '\\n');
        lines.push(`${key}="${escaped}"`);
      }
      const content = lines.join('\n') + '\n';
      const result = await this.writeFile(INTEGRATION_ENV_FILE_PATH, content);
      if (!result.success) {
        console.error(`[Sandbox] writeIntegrationEnvFileToSandbox: write failed: ${result.error}`);
        return false;
      }
      console.log(`[Sandbox] writeIntegrationEnvFileToSandbox: wrote ${lines.length} vars to ${INTEGRATION_ENV_FILE_PATH}`);
      return true;
    } catch (err) {
      console.error('[Sandbox] writeIntegrationEnvFileToSandbox: error:', err);
      return false;
    }
  }

  async fetchIntegrationEnvVars(): Promise<Record<string, string>> {
    const workspaceId = this.workspaceId;
    const integrationEnvVars: Record<string, string> = {};
    const startedAt = Date.now();
    let integrationCount = 0;
    let getIntegrationsMs = 0;
    let decryptAndMapMs = 0;
    let dataProxyMs = 0;
    try {
      const workspaceStub = this.env.WORKSPACE.get(this.env.WORKSPACE.idFromName(workspaceId));
      const getIntegrationsStartedAt = Date.now();
      const records = await workspaceStub.getIntegrations();
      getIntegrationsMs = Date.now() - getIntegrationsStartedAt;
      integrationCount = records.length;

      const decryptStartedAt = Date.now();
      for (const record of records) {
        const credentials = await decryptCredentials(record.credentials_encrypted, this.env.INTEGRATION_SECRET_KEY);
        const config = JSON.parse(record.config) as Record<string, unknown>;
        Object.assign(integrationEnvVars, mapCredentialsToEnvVars(record.name, record.integration_type, credentials, config));
      }
      decryptAndMapMs = Date.now() - decryptStartedAt;

      const dataProxyStartedAt = Date.now();
      const dataProxyResult = await workspaceStub.generateDataProxyToken();
      dataProxyMs = Date.now() - dataProxyStartedAt;
      if (dataProxyResult) {
        integrationEnvVars.DATA_PROXY_TOKEN = dataProxyResult.token;
        this.dataProxyTokenExpiry = dataProxyResult.expiresAt;
      }
      console.log(
        `[WorkspaceContainer] fetchIntegrationEnvVars workspace=${workspaceId} integrations=${integrationCount} getIntegrationsMs=${getIntegrationsMs} decryptMapMs=${decryptAndMapMs} dataProxyMs=${dataProxyMs} totalMs=${Date.now() - startedAt}`
      );
    } catch (e) {
      console.error('[WorkspaceContainer] Failed to fetch integration env vars:', e);
      console.log(
        `[WorkspaceContainer] fetchIntegrationEnvVars workspace=${workspaceId} failed=true integrations=${integrationCount} getIntegrationsMs=${getIntegrationsMs} decryptMapMs=${decryptAndMapMs} dataProxyMs=${dataProxyMs} totalMs=${Date.now() - startedAt}`
      );
    }

    return integrationEnvVars;
  }

  async pushIntegrationEnvVars(envVars: Record<string, string>): Promise<boolean> {
    return this.writeIntegrationEnvFileToSandbox(envVars);
  }

  async refreshIntegrationEnvVars(): Promise<boolean> {
    const envVars = await this.fetchIntegrationEnvVars();
    return this.pushIntegrationEnvVars(envVars);
  }

  // ─── Public FS API ───────────────────────────────────────

  async healthCheck(): Promise<{ status: string }> {
    const response = await this.fetchProxy(this.sandboxProxyPath('/health'), { method: 'GET' });
    if (!response.ok) {
      return { status: 'error' };
    }
    return await response.json() as { status: string };
  }

  async exists(path: string): Promise<ControlPlaneExistsResponse> {
    const normalizedPath = this.normalizeFsPath(path);
    const response = await this.fetchProxy(
      this.sandboxProxyPath('/fs/exists'),
      { method: 'GET' },
      { path: normalizedPath }
    );

    if (!response.ok) {
      return { exists: false };
    }

    return await response.json() as ControlPlaneExistsResponse;
  }

  /**
   * Stream a file's raw bytes directly from the sandbox host proxy.
   * Returns the Response object for pass-through streaming (no buffering/encoding).
   * Returns null if the file doesn't exist, throws on other errors.
   */
  async readFileStream(path: string): Promise<Response | null> {
    const normalizedPath = this.normalizeFsPath(path);
    const response = await this.fetchProxy(
      this.sandboxProxyPath('/fs/read'),
      { method: 'GET' },
      { path: normalizedPath }
    );

    if (response.status === 404) return null;

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Failed reading file ${path}: ${response.status} ${body}`);
    }

    return response;
  }

  async readFile(path: string): Promise<ControlPlaneReadResponse> {
    const normalizedPath = this.normalizeFsPath(path);
    const response = await this.fetchProxy(
      this.sandboxProxyPath('/fs/read'),
      { method: 'GET' },
      { path: normalizedPath }
    );

    if (response.status === 404) {
      return { success: false, error: 'File not found', code: 'ENOENT' };
    }

    if (!response.ok) {
      const body = await response.text();
      return { success: false, error: body || 'Read failed', code: `HTTP_${response.status}` };
    }

    const buffer = new Uint8Array(await response.arrayBuffer());
    const hasNul = buffer.includes(0);
    const content = hasNul
      ? Buffer.from(buffer).toString('base64')
      : new TextDecoder().decode(buffer);

    return {
      success: true,
      content,
      size: buffer.byteLength,
      isBinary: hasNul,
      encoding: hasNul ? 'base64' : 'utf8',
    };
  }

  async writeFile(path: string, content: string): Promise<ControlPlaneWriteResponse> {
    const normalizedPath = this.normalizeFsPath(path);
    const response = await this.fetchProxy(
      this.sandboxProxyPath('/fs/write'),
      {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        body: content,
      },
      { path: normalizedPath }
    );

    if (!response.ok) {
      const body = await response.text();
      return { success: false, error: body || 'Write failed', code: `HTTP_${response.status}` };
    }

    return { success: true };
  }

  async writeBinaryFile(path: string, base64Content: string): Promise<ControlPlaneWriteResponse> {
    const normalizedPath = this.normalizeFsPath(path);
    const binaryBuffer = Buffer.from(base64Content, 'base64');
    const response = await this.fetchProxy(
      this.sandboxProxyPath('/fs/write'),
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: binaryBuffer,
      },
      { path: normalizedPath }
    );

    if (!response.ok) {
      const body = await response.text();
      return { success: false, error: body || 'Write failed', code: `HTTP_${response.status}` };
    }

    return { success: true };
  }

  async listFiles(path: string, options?: { recursive?: boolean; includeHidden?: boolean }): Promise<ControlPlaneListResponse> {
    const root = this.normalizeFsPath(path);
    const recursive = options?.recursive === true;
    const includeHidden = options?.includeHidden === true;
    const files: ControlPlaneListResponse['files'] = [];

    const walk = async (current: string): Promise<void> => {
      const response = await this.fetchProxy(
        this.sandboxProxyPath('/fs/list'),
        { method: 'GET' },
        { path: current }
      );

      if (response.status === 404) {
        throw new Error(`Path not found: ${current}`);
      }

      if (!response.ok) {
        const body = await response.text();
        throw new Error(body || `Failed to list directory: ${response.status}`);
      }

      const payload = await response.json();
      const entries = this.parseFsListEntries(payload);
      for (const entry of entries) {
        if (!includeHidden && entry.name.startsWith('.')) continue;
        const absolutePath = this.joinFsPath(current, entry.name);
        const relativePath = absolutePath.startsWith(`${root}/`)
          ? absolutePath.slice(root.length + 1)
          : absolutePath === root
            ? entry.name
            : absolutePath;

        files.push({
          name: entry.name,
          type: entry.type,
          size: entry.size,
          modifiedAt: entry.modifiedAt,
          relativePath,
          absolutePath,
        });

        if (recursive && entry.type === 'directory') {
          await walk(absolutePath);
        }
      }
    };

    try {
      await walk(root);
      return {
        success: true,
        files,
        count: files.length,
        path: root,
        timestamp: toIsoTime(Date.now()),
      };
    } catch (err) {
      return {
        success: false,
        files: [],
        count: 0,
        path: root,
        error: String((err as { message?: unknown })?.message || err),
      };
    }
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<ControlPlaneMkdirResponse> {
    const normalizedPath = this.normalizeFsPath(path);
    const response = await this.fetchProxy(
      this.sandboxProxyPath('/fs/mkdir'),
      { method: 'POST' },
      { path: normalizedPath }
    );

    if (!response.ok) {
      const body = await response.text();
      return { success: false, error: body || 'mkdir failed', code: `HTTP_${response.status}` };
    }

    return { success: true, timestamp: toIsoTime(Date.now()) };
  }

  async moveFile(source: string, destination: string): Promise<ControlPlaneMoveResponse> {
    const response = await this.fetchProxy(this.sandboxProxyPath('/fs/move'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: this.normalizeFsPath(source),
        dest: this.normalizeFsPath(destination),
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      return { success: false, error: body || 'Move failed', code: `HTTP_${response.status}` };
    }

    return { success: true, timestamp: toIsoTime(Date.now()) };
  }

  async deleteFile(path: string): Promise<ControlPlaneDeleteResponse> {
    const response = await this.fetchProxy(this.sandboxProxyPath('/fs/delete'), {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: this.normalizeFsPath(path),
        recursive: true,
      }),
    });

    if (!response.ok && response.status !== 404) {
      const body = await response.text();
      return { success: false, error: body || 'Delete failed', code: `HTTP_${response.status}` };
    }

    return { success: true, timestamp: toIsoTime(Date.now()) };
  }
}

export function getContainerIdForWorkspace(workspaceId: string): string {
  const safeId = workspaceId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `ws-${safeId}`.slice(0, 63);
}

export function getWorkspaceContainer(
  env: WorkspaceContainerEnv,
  workspaceId: string,
  orgId: string
): WorkspaceContainer {
  const cacheKey = `${workspaceId}:${orgId}`;
  const cached = runtimeCache.get(cacheKey);
  if (cached && cached.matchesEnv(env)) {
    return cached;
  }

  const runtime = new WorkspaceContainer(env, workspaceId, orgId);
  runtimeCache.set(cacheKey, runtime);
  return runtime;
}
