/**
 * Workspace runtime backed by Docker + gVisor sandboxes.
 *
 * Architecture:
 * - Sandbox host (services/sandbox-host/): Manages Docker container lifecycle,
 *   host filesystem operations, exec, and proxies control plane + API traffic.
 * - Control plane (sandbox/control-plane.mjs): Runs inside the container as
 *   the main entrypoint on port 8080. Handles Claude Agent SDK chat sessions.
 * - This module: Provides FS/exec APIs for dashboard routes, builds
 *   thread-specific env vars (integrations), and exposes
 *   connectChatWebSocket() for ChatThreadDO.
 *
 * Base env vars (API keys, proxy URLs) are set as Docker -e flags at container
 * creation. API traffic from containers routes through the sandbox host proxy
 * which adds identity headers + a shared secret.
 *
 * All traffic (lifecycle, FS, exec, control plane) routes through the
 * sandbox host — CF Workers can't reach Docker bridge IPs directly.
 */
import { mapCredentialsToEnvVars } from './integration-env';
import { decryptCredentials } from '../../../src/lib/integration-crypto';
import type { WorkspaceDO } from './workspace';

export interface WorkspaceContainerEnv {
  WORKSPACE: DurableObjectNamespace<WorkspaceDO>;
  R2_BUCKET: R2Bucket;
  INTEGRATION_SECRET_KEY: string;

  SANDBOX_HOST: Fetcher;
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

export interface ClaudeRunnerEnvOptions {
  threadId: string;
}

const INTEGRATION_ENV_FILE_PATH = '/home/claude/.chiridion/integration.env';

function toIsoTime(ms: number): string {
  return new Date(ms).toISOString();
}

export class WorkspaceContainer {
  private workspaceId: string;
  private orgId: string;

  constructor(private env: WorkspaceContainerEnv, workspaceId: string, orgId: string) {
    this.workspaceId = workspaceId;
    this.orgId = orgId;
  }

  // ─── Helpers ─────────────────────────────────────────────

  private sandboxUrl(subpath: string, query?: Record<string, string>): string {
    const base = `http://sandbox/v1/workspaces/${encodeURIComponent(this.orgId)}/${encodeURIComponent(this.workspaceId)}${subpath}`;
    if (!query) return base;
    const url = new URL(base);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    return url.toString();
  }

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

  private basenameFsPath(path: string): string {
    const normalized = this.normalizeFsPath(path);
    if (normalized === '/') return '/';
    const idx = normalized.lastIndexOf('/');
    return idx < 0 ? normalized : normalized.slice(idx + 1);
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

    const response = await this.env.SANDBOX_HOST.fetch(this.sandboxUrl('/exec'), {
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


  /**
   * Build thread-specific env vars (integration creds + thread ID).
   * Passed to the control plane chat WebSocket init message.
   */
  async buildClaudeRunnerEnv(options: ClaudeRunnerEnvOptions): Promise<Record<string, string>> {
    if (!this.workspaceId) {
      throw new Error('WorkspaceContainer not initialized');
    }

    console.log(`[Sandbox] buildClaudeRunnerEnv: thread=${options.threadId}`);
    const integrationEnv = await this.fetchIntegrationEnvVars();

    await this.writeIntegrationEnvFileToSandbox(integrationEnv);

    return {
      ...integrationEnv,
      CHIRIDION_THREAD_ID: options.threadId,
    };
  }

  // ─── Chat WebSocket ──────────────────────────────────────

  /**
   * Open a WebSocket to the control plane's /chat endpoint via the proxy.
   * ChatThreadDO uses this to bridge chat clients to the Claude Agent SDK
   * running in-process inside the sandbox.
   */
  async connectChatWebSocket(): Promise<WebSocket> {
    console.log(`[Sandbox] connectChatWebSocket: connecting via proxy`);

    const response = await this.env.SANDBOX_HOST.fetch(this.sandboxUrl('/chat'), {
      headers: { Upgrade: 'websocket' },
    });

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

      console.log(
        `[WorkspaceContainer] fetchIntegrationEnvVars workspace=${workspaceId} integrations=${integrationCount} getIntegrationsMs=${getIntegrationsMs} decryptMapMs=${decryptAndMapMs} totalMs=${Date.now() - startedAt}`
      );
    } catch (e) {
      console.error('[WorkspaceContainer] Failed to fetch integration env vars:', e);
      console.log(
        `[WorkspaceContainer] fetchIntegrationEnvVars workspace=${workspaceId} failed=true integrations=${integrationCount} getIntegrationsMs=${getIntegrationsMs} decryptMapMs=${decryptAndMapMs} totalMs=${Date.now() - startedAt}`
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

  async exists(path: string): Promise<ControlPlaneExistsResponse> {
    const normalizedPath = this.normalizeFsPath(path);
    const response = await this.env.SANDBOX_HOST.fetch(
      this.sandboxUrl('/fs/exists', { path: normalizedPath }),
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
    const response = await this.env.SANDBOX_HOST.fetch(
      this.sandboxUrl('/fs/read', { path: normalizedPath }),
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
    const response = await this.env.SANDBOX_HOST.fetch(
      this.sandboxUrl('/fs/read', { path: normalizedPath }),
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
    const response = await this.env.SANDBOX_HOST.fetch(
      this.sandboxUrl('/fs/write', { path: normalizedPath }),
      {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        body: content,
      },
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
    const response = await this.env.SANDBOX_HOST.fetch(
      this.sandboxUrl('/fs/write', { path: normalizedPath }),
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: binaryBuffer,
      },
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
      const response = await this.env.SANDBOX_HOST.fetch(
        this.sandboxUrl('/fs/list', { path: current }),
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
    const response = await this.env.SANDBOX_HOST.fetch(
      this.sandboxUrl('/fs/mkdir', { path: normalizedPath }),
      { method: 'POST' },
    );

    if (!response.ok) {
      const body = await response.text();
      return { success: false, error: body || 'mkdir failed', code: `HTTP_${response.status}` };
    }

    return { success: true, timestamp: toIsoTime(Date.now()) };
  }

  async moveFile(source: string, destination: string): Promise<ControlPlaneMoveResponse> {
    const response = await this.env.SANDBOX_HOST.fetch(this.sandboxUrl('/fs/move'), {
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
    const response = await this.env.SANDBOX_HOST.fetch(this.sandboxUrl('/fs/delete'), {
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

