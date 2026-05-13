/**
 * Workspace runtime backed by Docker + gVisor sandboxes.
 *
 * Architecture:
 * - Sandbox host (services/sandbox-host/): Manages Docker container lifecycle,
 *   host filesystem operations, container exec, and API traffic.
 * - This module: Provides FS/exec APIs for dashboard routes, builds
 *   thread-specific env vars for integration-backed tools.
 *
 * All sandbox traffic (lifecycle, FS, exec, data proxy) routes through the
 * sandbox host — CF Workers can't reach Docker bridge IPs directly.
 */
import { mapCredentialsToEnvVars } from "./integration-env";
import { decryptCredentials } from "../../../src/lib/integration-crypto";
import {
  DEFAULT_LLM_MODEL,
  DEFAULT_CODEX_MODEL,
  normalizeLlmModel,
} from "../../../src/lib/llm-provider-config";
import { createDispatcherSession } from "./worker-auth";
import type { WorkspaceDO } from "./workspace";
import type { OrgDO } from "./auth";
import { isOrgBanned } from "./ban-list";

export interface WorkspaceContainerEnv {
  WORKSPACE: DurableObjectNamespace<WorkspaceDO>;
  ORG: DurableObjectNamespace<OrgDO>;
  R2_BUCKET: R2Bucket;
  INTEGRATION_SECRET_KEY: string;
  SESSIONS?: KVNamespace;
  APP_KV: KVNamespace;

  SANDBOX_HOST?: Fetcher;
  SANDBOX_HOST_URL?: string;
  WORKER_BASE_URL?: string;
  CF_DISPATCH_NAMESPACE?: string;
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
    type: "file" | "directory";
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

interface ControlPlaneThreadMessagesStreamResponse {
  success: boolean;
  response?: Response;
  error?: string;
  code?: string;
}

interface ReadThreadMessagesStreamOptions {
  claudeSessionId?: string | null;
  codexSessionId?: string | null;
  skipBanCheck?: boolean;
}

interface SandboxFetchRetryOptions {
  operation: string;
  attempts?: number;
  initialDelayMs?: number;
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

export interface ChatRunnerEnvOptions {
  threadId: string;
  provider: "claude" | "codex";
}

const INTEGRATION_ENV_FILE_PATH = "/home/claude/.chiridion/integration.env";

function toIsoTime(ms: number): string {
  return new Date(ms).toISOString();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorName(error: unknown): string {
  if (error instanceof Error) return error.name;
  if (typeof error === "object" && error && "name" in error) {
    return String((error as { name?: unknown }).name ?? "");
  }
  return "";
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

function isTransientSandboxFetchError(error: unknown): boolean {
  const text = `${getErrorName(error)} ${getErrorMessage(error)}`.toLowerCase();
  return (
    text.includes("handshaketimeouterror") ||
    text.includes("handshake timeout") ||
    text.includes("network connection lost") ||
    text.includes("connection reset") ||
    text.includes("connection closed") ||
    text.includes("fetch failed")
  );
}

export class WorkspaceContainer {
  private workspaceId: string;
  private orgId: string;

  constructor(
    private env: WorkspaceContainerEnv,
    workspaceId: string,
    orgId: string,
  ) {
    this.workspaceId = workspaceId;
    this.orgId = orgId;
  }

  // ─── Helpers ─────────────────────────────────────────────

  private getSandboxHostUrlOverride(): URL | null {
    const raw = (this.env.SANDBOX_HOST_URL || "").trim();
    if (!raw) return null;
    try {
      const parsed = new URL(raw);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        console.warn(
          `[Sandbox] ignoring SANDBOX_HOST_URL with unsupported protocol: ${parsed.protocol}`,
        );
        return null;
      }
      return parsed;
    } catch {
      console.warn(`[Sandbox] ignoring invalid SANDBOX_HOST_URL: ${raw}`);
      return null;
    }
  }

  private normalizeBaseUrl(url: URL): URL {
    const copy = new URL(url.toString());
    copy.search = "";
    copy.hash = "";
    copy.pathname = copy.pathname.replace(/\/+$/, "");
    return copy;
  }

  private sandboxUrl(subpath: string, query?: Record<string, string>): string {
    const workspacePath = `/v1/workspaces/${encodeURIComponent(this.orgId)}/${encodeURIComponent(this.workspaceId)}${subpath}`;
    const sandboxBase = this.getSandboxHostUrlOverride();
    const url = sandboxBase
      ? this.normalizeBaseUrl(sandboxBase)
      : new URL("http://sandbox");

    const basePath =
      url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
    url.pathname = `${basePath}${workspacePath}`;

    if (query) {
      for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    }
    return url.toString();
  }

  private normalizeFsPath(path: string): string {
    if (!path) return "/";
    return path.startsWith("/") ? path : `/${path}`;
  }

  private joinFsPath(base: string, name: string): string {
    const normalizedBase = this.normalizeFsPath(base);
    if (!name) return normalizedBase;
    if (normalizedBase === "/") return `/${name}`;
    return `${normalizedBase}/${name}`;
  }

  private basenameFsPath(path: string): string {
    const normalized = this.normalizeFsPath(path);
    if (normalized === "/") return "/";
    const idx = normalized.lastIndexOf("/");
    return idx < 0 ? normalized : normalized.slice(idx + 1);
  }

  private async fetchSandbox(
    url: string,
    init: RequestInit = {},
    options: { skipBanCheck?: boolean } = {},
  ): Promise<Response> {
    if (!options.skipBanCheck && this.env.APP_KV) {
      const orgBan = await isOrgBanned(this.env.APP_KV, { orgId: this.orgId });
      if (orgBan) {
        throw new Error("Organization is banned");
      }
    }

    const sandboxBase = this.getSandboxHostUrlOverride();
    if (sandboxBase) {
      return fetch(url, init);
    }
    if (!this.env.SANDBOX_HOST) {
      throw new Error(
        "SANDBOX_HOST binding is not configured (or set SANDBOX_HOST_URL for local sandbox mode)",
      );
    }
    return this.env.SANDBOX_HOST.fetch(url, init);
  }

  private async fetchSandboxWithRetry(
    url: string,
    init: RequestInit = {},
    options: { skipBanCheck?: boolean } = {},
    retry: SandboxFetchRetryOptions,
  ): Promise<Response> {
    const attempts = Math.max(1, retry.attempts ?? 3);
    const initialDelayMs = Math.max(0, retry.initialDelayMs ?? 150);
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.fetchSandbox(url, init, options);
      } catch (error) {
        lastError = error;
        const canRetry =
          attempt < attempts && isTransientSandboxFetchError(error);
        if (!canRetry) throw error;

        console.warn("[Sandbox] transient sandbox fetch failed; retrying", {
          operation: retry.operation,
          workspaceId: this.workspaceId,
          orgId: this.orgId,
          attempt,
          attempts,
          error: getErrorMessage(error),
        });
        await delay(initialDelayMs * 2 ** (attempt - 1));
      }
    }

    throw lastError;
  }

  /**
   * Execute a command on the sandbox via the proxy POST /exec endpoint.
   */
  async execOnSandbox(
    args: string[],
    options: { cwd?: string; env?: Record<string, string> } = {},
  ): Promise<ControlPlaneExecResponse> {
    if (args.length === 0) {
      return {
        success: false,
        stdout: "",
        stderr: "No command provided",
        exitCode: 1,
      };
    }

    const response = await this.fetchSandbox(this.sandboxUrl("/exec"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cmd: args, cwd: options.cwd, env: options.env }),
    });

    if (!response.ok) {
      const body = await response.text();
      return {
        success: false,
        stdout: "",
        stderr: body,
        exitCode: response.status,
      };
    }

    return (await response.json()) as ControlPlaneExecResponse;
  }

  async exec(
    command: string,
    options?: { timeout?: number; cwd?: string },
  ): Promise<ControlPlaneExecResponse> {
    return this.execOnSandbox(["bash", "-lc", command], { cwd: options?.cwd });
  }

  // ─── FS Helpers ──────────────────────────────────────────

  private parseFsListEntries(payload: unknown): Array<{
    name: string;
    type: "file" | "directory";
    size: number;
    modifiedAt: string;
    relativePath?: string;
    absolutePath?: string;
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
      const rawPath = typeof raw.path === "string" ? raw.path : "";
      const rawRelativePath =
        typeof raw.relativePath === "string"
          ? raw.relativePath
          : typeof raw.relative === "string"
            ? raw.relative
            : "";
      const rawAbsolutePath =
        typeof raw.absolutePath === "string"
          ? raw.absolutePath
          : rawPath.startsWith("/")
            ? rawPath
            : "";

      const name =
        typeof raw.name === "string"
          ? raw.name
          : rawRelativePath
            ? this.basenameFsPath(rawRelativePath)
            : rawAbsolutePath
              ? this.basenameFsPath(rawAbsolutePath)
              : rawPath
                ? this.basenameFsPath(rawPath)
                : "";
      const relativePath = rawRelativePath
        ? rawRelativePath
        : rawPath && !rawPath.startsWith("/")
          ? rawPath
          : "";
      if (!name || name === "/") return [];

      const rawType =
        typeof raw.type === "string" ? raw.type.toLowerCase() : "";
      const isDir =
        rawType === "directory" ||
        rawType === "dir" ||
        raw.isDir === true ||
        raw.isDirectory === true;
      const type: "file" | "directory" = isDir ? "directory" : "file";
      const size = typeof raw.size === "number" ? raw.size : 0;
      const modifiedAt =
        typeof raw.modifiedAt === "string"
          ? raw.modifiedAt
          : typeof raw.mtime === "string"
            ? raw.mtime
            : typeof raw.updatedAt === "string"
              ? raw.updatedAt
              : nowIso;

      return [
        {
          name,
          type,
          size,
          modifiedAt,
          ...(relativePath ? { relativePath } : {}),
          ...(rawAbsolutePath ? { absolutePath: rawAbsolutePath } : {}),
        },
      ];
    });
  }

  private isHiddenRelativePath(relativePath: string): boolean {
    return relativePath.split("/").some((segment) => segment.startsWith("."));
  }

  private async listFilesWithLegacyWalk(
    root: string,
    includeHidden: boolean,
  ): Promise<ControlPlaneListResponse> {
    const files: ControlPlaneListResponse["files"] = [];
    const queue: string[] = [root];
    const enqueued = new Set<string>([root]);
    let cursor = 0;
    let activeWorkers = 0;
    const workerCount = 8;

    const processDirectory = async (current: string): Promise<string[]> => {
      const response = await this.fetchSandbox(
        this.sandboxUrl("/fs/list", { path: current }),
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
      const childDirectories: string[] = [];
      for (const entry of entries) {
        if (!includeHidden && entry.name.startsWith(".")) continue;
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

        if (entry.type === "directory") {
          childDirectories.push(absolutePath);
        }
      }
      return childDirectories;
    };

    const waitForTick = async () =>
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const workers = Array.from({ length: workerCount }, async () => {
      while (true) {
        if (cursor >= queue.length) {
          if (activeWorkers === 0) break;
          await waitForTick();
          continue;
        }

        const current = queue[cursor];
        cursor += 1;
        if (!current) continue;

        activeWorkers += 1;
        try {
          const childDirectories = await processDirectory(current);
          for (const childPath of childDirectories) {
            if (enqueued.has(childPath)) continue;
            enqueued.add(childPath);
            queue.push(childPath);
          }
        } finally {
          activeWorkers -= 1;
        }
      }
    });

    await Promise.all(workers);
    return {
      success: true,
      files,
      count: files.length,
      path: root,
      timestamp: toIsoTime(Date.now()),
    };
  }

  /**
   * Build thread-specific env vars (integration creds + thread ID).
   * Passed to the sandbox-host chat runner.
   *
   * Model-provider credentials are intentionally not returned here. ChatThreadDO
   * resolves org BYOK state directly before each Pi model request so key changes
   * are not cached by a long-lived session.
   */
  async buildChatRunnerEnv(options: ChatRunnerEnvOptions): Promise<{
    envVars: Record<string, string>;
  }> {
    if (!this.workspaceId) {
      throw new Error("WorkspaceContainer not initialized");
    }

    console.log(
      `[Sandbox] buildChatRunnerEnv: thread=${options.threadId} provider=${options.provider}`,
    );
    const integrationEnv = await this.fetchIntegrationEnvVars();

    // Create a dispatcher session so Playwright scripts can access private deployed apps
    const appSessionEnv = await this.createAppAccessSession();

    await this.writeIntegrationEnvFileToSandbox({
      ...integrationEnv,
      ...appSessionEnv,
    });

    const orgStub = this.env.ORG.get(this.env.ORG.idFromName(this.orgId));
    const thread = await orgStub.getThread(options.threadId);
    const llmProviderRecord = await orgStub.getLlmProviderConfig();

    const threadProvider = options.provider;
    const threadModel =
      thread && thread.workspace_id === this.workspaceId
        ? normalizeLlmModel(
            thread.model,
            threadProvider,
            llmProviderRecord?.provider,
          )
        : threadProvider === "codex"
          ? normalizeLlmModel(undefined, "codex", llmProviderRecord?.provider)
          : DEFAULT_LLM_MODEL;

    integrationEnv.CHIRIDION_CLAUDE_MODEL =
      threadProvider === "claude" ? threadModel : DEFAULT_LLM_MODEL;
    integrationEnv.CHIRIDION_CODEX_MODEL =
      threadProvider === "codex" ? threadModel : DEFAULT_CODEX_MODEL;

    return {
      envVars: {
        ...integrationEnv,
        ...appSessionEnv,
        CHIRIDION_CHAT_PROVIDER: options.provider,
      },
    };
  }

  /**
   * Create a dispatcher session for sandbox Playwright scripts to access
   * private deployed apps owned by the org.
   */
  private async createAppAccessSession(): Promise<Record<string, string>> {
    if (!this.env.SESSIONS || !this.orgId || !this.workspaceId) return {};

    try {
      const { sessionId } = await createDispatcherSession(
        this.env.SESSIONS,
        `sandbox:${this.workspaceId}`,
        this.orgId,
      );
      return { CHIRIDION_APP_SESSION: sessionId };
    } catch (err) {
      console.error("[Sandbox] createAppAccessSession failed:", err);
      return {};
    }
  }

  // ─── Integration Env Vars ────────────────────────────────

  async buildContainerCommandEnv(): Promise<Record<string, string>> {
    const env: Record<string, string> = {
      WORKSPACE_ID: this.workspaceId,
      ORG_ID: this.orgId,
      WRANGLER_SEND_METRICS: "false",
      CI: "1",
    };
    const dispatchNamespace = this.env.CF_DISPATCH_NAMESPACE?.trim();
    if (dispatchNamespace) {
      env.CF_DISPATCH_NAMESPACE = dispatchNamespace;
    }

    // Compatibility: keep INT_* credentials available to shell commands for now.
    // Follow-up PR should remove this once connection method bindings are the only
    // supported integration interface.
    Object.assign(env, await this.fetchIntegrationEnvVars());
    Object.assign(env, await this.createAppAccessSession());
    return env;
  }

  /**
   * Write integration env vars to a dotenv file on the sandbox.
   */
  private async writeIntegrationEnvFileToSandbox(
    envVars: Record<string, string>,
  ): Promise<boolean> {
    try {
      const lines: string[] = [];
      for (const [key, value] of Object.entries(envVars)) {
        const escaped = value
          .replace(/\\/g, "\\\\")
          .replace(/"/g, '\\"')
          .replace(/\n/g, "\\n");
        lines.push(`export ${key}="${escaped}"`);
      }
      const content = lines.join("\n") + "\n";
      const result = await this.writeFile(INTEGRATION_ENV_FILE_PATH, content);
      if (!result.success) {
        console.error(
          `[Sandbox] writeIntegrationEnvFileToSandbox: write failed: ${result.error}`,
        );
        return false;
      }
      console.log(
        `[Sandbox] writeIntegrationEnvFileToSandbox: wrote ${lines.length} vars to ${INTEGRATION_ENV_FILE_PATH}`,
      );
      return true;
    } catch (err) {
      console.error("[Sandbox] writeIntegrationEnvFileToSandbox: error:", err);
      return false;
    }
  }

  private async fetchIntegrationEnvVarsWithStatus(): Promise<{
    envVars: Record<string, string>;
    success: boolean;
  }> {
    const workspaceId = this.workspaceId;
    const integrationEnvVars: Record<string, string> = {};
    const startedAt = Date.now();
    let integrationCount = 0;
    let getIntegrationsMs = 0;
    let decryptAndMapMs = 0;
    try {
      const workspaceStub = this.env.WORKSPACE.get(
        this.env.WORKSPACE.idFromName(workspaceId),
      );
      const getIntegrationsStartedAt = Date.now();
      const records = await workspaceStub.getIntegrations();
      getIntegrationsMs = Date.now() - getIntegrationsStartedAt;
      integrationCount = records.length;

      const decryptStartedAt = Date.now();
      for (const record of records) {
        const credentials = record.credentials_encrypted
          ? await decryptCredentials(
              record.credentials_encrypted,
              this.env.INTEGRATION_SECRET_KEY,
            )
          : {};
        const config = JSON.parse(record.config) as Record<string, unknown>;
        Object.assign(
          integrationEnvVars,
          mapCredentialsToEnvVars(
            record.name,
            record.integration_type,
            credentials,
            config,
          ),
        );
      }
      decryptAndMapMs = Date.now() - decryptStartedAt;

      console.log(
        `[WorkspaceContainer] fetchIntegrationEnvVars workspace=${workspaceId} integrations=${integrationCount} getIntegrationsMs=${getIntegrationsMs} decryptMapMs=${decryptAndMapMs} totalMs=${Date.now() - startedAt}`,
      );
      return { envVars: integrationEnvVars, success: true };
    } catch (e) {
      console.error(
        "[WorkspaceContainer] Failed to fetch integration env vars:",
        e,
      );
      console.log(
        `[WorkspaceContainer] fetchIntegrationEnvVars workspace=${workspaceId} failed=true integrations=${integrationCount} getIntegrationsMs=${getIntegrationsMs} decryptMapMs=${decryptAndMapMs} totalMs=${Date.now() - startedAt}`,
      );
      return { envVars: integrationEnvVars, success: false };
    }
  }

  async fetchIntegrationEnvVars(): Promise<Record<string, string>> {
    const { envVars } = await this.fetchIntegrationEnvVarsWithStatus();
    return envVars;
  }

  async pushIntegrationEnvVars(
    envVars: Record<string, string>,
  ): Promise<boolean> {
    return this.writeIntegrationEnvFileToSandbox(envVars);
  }

  async refreshIntegrationEnvVars(): Promise<boolean> {
    const { envVars, success } = await this.fetchIntegrationEnvVarsWithStatus();
    if (!success) {
      console.warn(
        `[WorkspaceContainer] refreshIntegrationEnvVars: skipping env file write due to fetch failure workspace=${this.workspaceId}`,
      );
      return false;
    }
    return this.pushIntegrationEnvVars(envVars);
  }

  // ─── Public FS API ───────────────────────────────────────

  async exists(path: string): Promise<ControlPlaneExistsResponse> {
    const normalizedPath = this.normalizeFsPath(path);
    const response = await this.fetchSandbox(
      this.sandboxUrl("/fs/exists", { path: normalizedPath }),
    );

    if (!response.ok) {
      return { exists: false };
    }

    return (await response.json()) as ControlPlaneExistsResponse;
  }

  /**
   * Stream a file's raw bytes directly from the sandbox host proxy.
   * Returns the Response object for pass-through streaming (no buffering/encoding).
   * Returns null if the file doesn't exist, throws on other errors.
   */
  async readFileStream(
    path: string,
    options: { skipBanCheck?: boolean } = {},
  ): Promise<Response | null> {
    const normalizedPath = this.normalizeFsPath(path);
    const response = await this.fetchSandbox(
      this.sandboxUrl("/fs/read", { path: normalizedPath }),
      {},
      options,
    );

    if (response.status === 404) return null;

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Failed reading file ${path}: ${response.status} ${body}`,
      );
    }

    return response;
  }

  async readFile(path: string): Promise<ControlPlaneReadResponse> {
    const normalizedPath = this.normalizeFsPath(path);
    const response = await this.fetchSandbox(
      this.sandboxUrl("/fs/read", { path: normalizedPath }),
    );

    if (response.status === 404) {
      return { success: false, error: "File not found", code: "ENOENT" };
    }

    if (!response.ok) {
      const body = await response.text();
      return {
        success: false,
        error: body || "Read failed",
        code: `HTTP_${response.status}`,
      };
    }

    const buffer = new Uint8Array(await response.arrayBuffer());
    const hasNul = buffer.includes(0);
    const content = hasNul
      ? Buffer.from(buffer).toString("base64")
      : new TextDecoder().decode(buffer);

    return {
      success: true,
      content,
      size: buffer.byteLength,
      isBinary: hasNul,
      encoding: hasNul ? "base64" : "utf8",
    };
  }

  async readThreadMessagesStream(
    threadId: string,
    options: ReadThreadMessagesStreamOptions = {},
  ): Promise<ControlPlaneThreadMessagesStreamResponse> {
    const trimmedThreadId = threadId.trim();
    if (!trimmedThreadId) {
      return { success: false, error: "Thread ID is required", code: "EINVAL" };
    }

    const query: Record<string, string> = { threadId: trimmedThreadId };
    const claudeSessionId = options.claudeSessionId?.trim();
    if (claudeSessionId) {
      query.claudeSessionId = claudeSessionId;
    }
    const codexSessionId = options.codexSessionId?.trim();
    if (codexSessionId) {
      query.codexSessionId = codexSessionId;
    }

    const response = await this.fetchSandboxWithRetry(
      this.sandboxUrl("/chat/messages", query),
      {
        headers: { Accept: "application/json" },
      },
      { skipBanCheck: options.skipBanCheck },
      { operation: "chat_messages", attempts: 3, initialDelayMs: 150 },
    );

    if (!response.ok) {
      const body = await response.text();
      return {
        success: false,
        error: body || "Read thread message stream failed",
        code: `HTTP_${response.status}`,
      };
    }

    return { success: true, response };
  }

  async readPiCoreMessagesStream(
    threadId: string,
    options: { skipBanCheck?: boolean } = {},
  ): Promise<ControlPlaneThreadMessagesStreamResponse> {
    const trimmedThreadId = threadId.trim();
    if (!trimmedThreadId) {
      return { success: false, error: "Thread ID is required", code: "EINVAL" };
    }

    const response = await this.fetchSandboxWithRetry(
      this.sandboxUrl("/chat/pi-core-messages", { threadId: trimmedThreadId }),
      {
        headers: { Accept: "application/json" },
      },
      { skipBanCheck: options.skipBanCheck },
      { operation: "chat_pi_core_messages", attempts: 3, initialDelayMs: 150 },
    );

    if (!response.ok) {
      const body = await response.text();
      return {
        success: false,
        error: body || "Read Pi core message stream failed",
        code: `HTTP_${response.status}`,
      };
    }

    return { success: true, response };
  }

  async terminateWorkspace(
    reason = "explicit_terminate_route",
  ): Promise<{ success: boolean; error?: string }> {
    const response = await this.fetchSandbox(
      this.sandboxUrl("/terminate", { reason }),
      { method: "POST" },
      { skipBanCheck: true },
    );

    if (!response.ok) {
      return {
        success: false,
        error: (await response.text()) || "Terminate failed",
      };
    }

    const body = (await response.json()) as { success?: boolean };
    return { success: Boolean(body.success) };
  }

  async purgeWorkspace(
    reason = "ban_purge",
  ): Promise<{ success: boolean; error?: string }> {
    const response = await this.fetchSandbox(
      this.sandboxUrl("", { reason }),
      { method: "DELETE" },
      { skipBanCheck: true },
    );

    if (!response.ok) {
      return {
        success: false,
        error: (await response.text()) || "Workspace purge failed",
      };
    }

    const body = (await response.json()) as { success?: boolean };
    return { success: Boolean(body.success) };
  }

  async writeFile(
    path: string,
    content: string,
  ): Promise<ControlPlaneWriteResponse> {
    const normalizedPath = this.normalizeFsPath(path);
    const response = await this.fetchSandbox(
      this.sandboxUrl("/fs/write", { path: normalizedPath }),
      {
        method: "PUT",
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body: content,
      },
    );

    if (!response.ok) {
      const body = await response.text();
      return {
        success: false,
        error: body || "Write failed",
        code: `HTTP_${response.status}`,
      };
    }

    return { success: true };
  }

  async writeBinaryFile(
    path: string,
    base64Content: string,
  ): Promise<ControlPlaneWriteResponse> {
    const normalizedPath = this.normalizeFsPath(path);
    const binaryBuffer = Buffer.from(base64Content, "base64");
    const response = await this.fetchSandbox(
      this.sandboxUrl("/fs/write", { path: normalizedPath }),
      {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: binaryBuffer,
      },
    );

    if (!response.ok) {
      const body = await response.text();
      return {
        success: false,
        error: body || "Write failed",
        code: `HTTP_${response.status}`,
      };
    }

    return { success: true };
  }

  async listFiles(
    path: string,
    options?: { recursive?: boolean; includeHidden?: boolean },
  ): Promise<ControlPlaneListResponse> {
    const root = this.normalizeFsPath(path);
    const recursive = options?.recursive === true;
    const includeHidden = options?.includeHidden === true;

    try {
      const response = await this.fetchSandbox(
        this.sandboxUrl("/fs/list", {
          path: root,
          recursive: recursive ? "1" : "0",
          includeHidden: includeHidden ? "1" : "0",
        }),
      );

      if (response.status === 404) {
        throw new Error(`Path not found: ${root}`);
      }

      if (!response.ok) {
        const body = await response.text();
        throw new Error(body || `Failed to list directory: ${response.status}`);
      }

      const payload = (await response.json()) as { recursive?: unknown };
      const backendRecursive = payload.recursive === true;
      if (recursive && !backendRecursive) {
        // Compatibility fallback for older sandbox-host versions.
        return await this.listFilesWithLegacyWalk(root, includeHidden);
      }

      const entries = this.parseFsListEntries(payload);
      const files: ControlPlaneListResponse["files"] = [];
      for (const entry of entries) {
        const relativePath = (entry.relativePath || "")
          .replace(/^\/+/, "")
          .split("/")
          .filter(Boolean)
          .join("/");
        const absolutePath = entry.absolutePath
          ? this.normalizeFsPath(entry.absolutePath)
          : relativePath
            ? this.joinFsPath(root, relativePath)
            : this.joinFsPath(root, entry.name);
        const normalizedRelativePath =
          relativePath ||
          (absolutePath.startsWith(`${root}/`)
            ? absolutePath.slice(root.length + 1)
            : absolutePath === root
              ? entry.name
              : this.basenameFsPath(absolutePath));

        if (!normalizedRelativePath) continue;
        if (
          !includeHidden &&
          this.isHiddenRelativePath(normalizedRelativePath)
        ) {
          continue;
        }

        files.push({
          name: entry.name,
          type: entry.type,
          size: entry.size,
          modifiedAt: entry.modifiedAt,
          relativePath: normalizedRelativePath,
          absolutePath,
        });
      }

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

  async mkdir(
    path: string,
    options?: { recursive?: boolean },
  ): Promise<ControlPlaneMkdirResponse> {
    const normalizedPath = this.normalizeFsPath(path);
    const response = await this.fetchSandbox(
      this.sandboxUrl("/fs/mkdir", { path: normalizedPath }),
      { method: "POST" },
    );

    if (!response.ok) {
      const body = await response.text();
      return {
        success: false,
        error: body || "mkdir failed",
        code: `HTTP_${response.status}`,
      };
    }

    return { success: true, timestamp: toIsoTime(Date.now()) };
  }

  async moveFile(
    source: string,
    destination: string,
  ): Promise<ControlPlaneMoveResponse> {
    const response = await this.fetchSandbox(this.sandboxUrl("/fs/move"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: this.normalizeFsPath(source),
        dest: this.normalizeFsPath(destination),
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      return {
        success: false,
        error: body || "Move failed",
        code: `HTTP_${response.status}`,
      };
    }

    return { success: true, timestamp: toIsoTime(Date.now()) };
  }

  async deleteFile(path: string): Promise<ControlPlaneDeleteResponse> {
    const response = await this.fetchSandbox(this.sandboxUrl("/fs/delete"), {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: this.normalizeFsPath(path),
        recursive: true,
      }),
    });

    if (!response.ok && response.status !== 404) {
      const body = await response.text();
      return {
        success: false,
        error: body || "Delete failed",
        code: `HTTP_${response.status}`,
      };
    }

    return { success: true, timestamp: toIsoTime(Date.now()) };
  }
}
