/**
 * MCP Server Handler
 *
 * Handles MCP protocol requests authenticated via sandbox host proxy.
 * Uses the agents package with streamable HTTP transport.
 */

import { McpAgent } from 'agents/mcp';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { OrgDO, WorkerScript } from './auth';
import type { WorkspaceDO } from './workspace';
import type { ChatThreadDO, ConnectionSetupRequest, ConnectionSetupResponse, DynamicIntegrationSchema, DynamicField, BugReportCaptureRequest, BugReportCaptureResponse, PreviewTarget } from './durable-objects';
import type { WorkspaceCronDO } from './workspace-cron';
import { WorkspaceContainer, type WorkspaceContainerEnv } from './workspace-container';
import { getAllIntegrations, getIntegrationsByCategory, getIntegrationDefinition, validateConfig, validateCredentials } from '../../../src/lib/integration-registry';
import { encryptCredentials } from '../../../src/lib/integration-crypto';
import { normalizeEnvVarName, getEnvVarSuffixesForType } from './integration-env';
import { validateSandboxProxy } from './sandbox-auth';
import {
  getEnvPrefix,
  syncAllWorkspaceWorkerSecrets,
  createOrRefreshCustomHostname,
  deleteCustomHostname,
  findCustomHostnameByHostname,
  getCustomHostnameStatus,
  type CfApiProxyEnv,
} from './cf-api-proxy';
import type { WorkerLogsDO } from './worker-logs-do';
import { getPreferredAppUrl, isAppCustomDomainReady } from '../../../src/lib/app-url';
import {
  buildCustomDomainDnsCheck,
  getCustomHostnameDnsTarget,
  type CnameLookupResult,
  type CustomDomainDnsCheck,
} from '../../../src/lib/custom-domain-dns';
import {
  getAppCustomDomainDiagnosticState,
  shouldRefreshAppCustomDomainState,
  shouldRetryAppCustomDomainProvisioning,
} from '../../../src/lib/custom-domain-state';

export interface McpEnv extends WorkspaceContainerEnv {
  CHAT_THREAD: DurableObjectNamespace<ChatThreadDO>;
  MCP_OBJECT: DurableObjectNamespace<ChiridionMcp>;
  WORKER_LOGS: DurableObjectNamespace<WorkerLogsDO>;
  WORKSPACE_CRON?: DurableObjectNamespace<WorkspaceCronDO>;
  APP_KV: KVNamespace;
  SANDBOX_PROXY_SECRET?: string;
  CF_ZONE_ID?: string;
  CF_API_TOKEN?: string;
  CF_CUSTOM_HOSTNAME_FALLBACK?: string;
  CF_CUSTOM_HOSTNAME_CNAME_TARGET?: string;
}

// Headers used to pass auth context to the MCP DO
const AUTH_HEADER_ORG_ID = 'x-chiridion-org-id';
const AUTH_HEADER_USER_ID = 'x-chiridion-user-id';
const AUTH_HEADER_WORKSPACE_ID = 'x-chiridion-workspace-id';
const AUTH_HEADER_THREAD_ID = 'x-chiridion-thread-id';

const WORKSPACE_ROOT_PREFIXES = ['/home/claude', '/workspace', '/root'];
const TEMP_PREVIEW_PREFIXES = [
  { prefix: '/mnt/user-uploads/', source: 'upload' as const },
  { prefix: '/mnt/user-outputs/', source: 'output' as const },
];

// Pending connection setup request with resolver
interface PendingConnectionSetup {
  resolve: (response: ConnectionSetupResponse) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

// Pending bug report capture request with resolver
interface PendingBugReportCapture {
  resolve: (response: BugReportCaptureResponse) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

interface ParsedFilePreviewPath {
  source: 'workspace' | 'upload' | 'output';
  path: string;
  filename: string;
}

/**
 * MCP Agent implementation with deployment management tools
 */
export class ChiridionMcp extends McpAgent<McpEnv, Record<string, unknown>, Record<string, unknown>> {
  server = new McpServer({
    name: 'chiridion-mcp',
    version: '1.0.0',
  });

  // Auth context extracted from request headers (resolved per request)
  private orgId: string | null = null;
  private orgSlug: string | null = null;
  private userId: string | null = null;
  private workspaceId: string | null = null;
  private threadId: string | null = null;

  // Pending connection setup promises (requestId -> resolver)
  private pendingConnectionSetups: Map<string, PendingConnectionSetup> = new Map();
  // Pending bug report capture promises (requestId -> resolver)
  private pendingBugReports: Map<string, PendingBugReportCapture> = new Map();

  /**
   * Override fetch to extract auth context from headers before processing
   */
  async fetch(request: Request): Promise<Response> {
    const t0 = performance.now();
    // Extract auth context from headers (set by handleMcpRequest)
    this.orgId = request.headers.get(AUTH_HEADER_ORG_ID);
    this.userId = request.headers.get(AUTH_HEADER_USER_ID);
    this.workspaceId = request.headers.get(AUTH_HEADER_WORKSPACE_ID);
    this.threadId = request.headers.get(AUTH_HEADER_THREAD_ID);

    // Call parent fetch to handle MCP protocol
    const response = await super.fetch(request);
    console.log(`[MCP DO] ${request.method} fetch completed in ${(performance.now() - t0).toFixed(0)}ms`);
    return response;
  }

  /**
   * Get OrgDO stub for the current org
   */
  private getOrgStub(): DurableObjectStub<OrgDO> {
    if (!this.orgId) throw new Error('No org context');
    return this.env.ORG.get(this.env.ORG.idFromName(this.orgId)) as DurableObjectStub<OrgDO>;
  }

  /**
   * Get WorkspaceDO stub for a workspace
   */
  private getWorkspaceStub(workspaceId: string): DurableObjectStub<WorkspaceDO> {
    return this.env.WORKSPACE.get(this.env.WORKSPACE.idFromName(workspaceId)) as DurableObjectStub<WorkspaceDO>;
  }

  /**
   * Get ChatThreadDO stub for a thread
   */
  private getChatThreadStub(threadId: string): DurableObjectStub<ChatThreadDO> {
    return this.env.CHAT_THREAD.get(this.env.CHAT_THREAD.idFromName(threadId)) as DurableObjectStub<ChatThreadDO>;
  }

  /**
   * Get WorkspaceCronDO stub for a workspace.
   */
  private getWorkspaceCronStub(workspaceId: string): DurableObjectStub<WorkspaceCronDO> {
    if (!this.env.WORKSPACE_CRON) {
      throw new Error('Workspace scheduler binding is not configured');
    }
    return this.env.WORKSPACE_CRON.get(
      this.env.WORKSPACE_CRON.idFromName(workspaceId)
    ) as DurableObjectStub<WorkspaceCronDO>;
  }

  /**
   * Require auth context, throwing if not available
   */
  private requireAuth(): { orgId: string; userId: string; workspaceId: string | null } {
    if (!this.orgId || !this.userId) {
      throw new Error('Authentication context not available');
    }
    return { orgId: this.orgId, userId: this.userId, workspaceId: this.workspaceId };
  }

  /**
   * Create a text response for MCP tools
   */
  private textResponse(data: unknown) {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    };
  }

  /**
   * Refresh the integration env file consumed by live Claude sessions
   * (pointed to by CLAUDE_ENV_FILE).
   */
  private async refreshWorkspaceIntegrationEnvFile(workspaceId: string, orgId: string): Promise<boolean> {
    try {
      return await new WorkspaceContainer(this.env, workspaceId, orgId).refreshIntegrationEnvVars();
    } catch (err) {
      console.error('[MCP] Failed to refresh workspace integration env file:', err);
      return false;
    }
  }

  /**
   * RPC method called by ChatThreadDO when user completes connection setup.
   * Resolves the pending promise for the corresponding request.
   * Also cleans up persisted storage for hibernation recovery.
   */
  receiveConnectionSetupResponse(response: ConnectionSetupResponse): void {
    // Clean up persisted storage (for hibernation recovery) - sync KV is faster
    this.ctx.storage.kv.delete(`pending_connection:${response.requestId}`);

    // Resolve in-memory promise if it exists (DO didn't hibernate)
    const pending = this.pendingConnectionSetups.get(response.requestId);
    if (pending) {
      clearTimeout(pending.timeoutId);
      this.pendingConnectionSetups.delete(response.requestId);
      pending.resolve(response);
    }
    // If not in Map, the tool call already timed out - nothing more to do
  }

  /**
   * Persist a pending connection setup to storage (for hibernation recovery).
   * Uses sync KV for better performance.
   */
  private persistPendingConnectionSetup(requestId: string): void {
    this.ctx.storage.kv.put(`pending_connection:${requestId}`, Date.now().toString());
  }

  /**
   * RPC method called by ChatThreadDO when a bug report capture response is received.
   * Also cleans up persisted storage for hibernation recovery.
   */
  receiveBugReportCaptureResponse(response: BugReportCaptureResponse): void {
    // Clean up persisted storage (for hibernation recovery) - sync KV is faster
    this.ctx.storage.kv.delete(`pending_bug_report:${response.requestId}`);

    // Resolve in-memory promise if it exists (DO didn't hibernate)
    const pending = this.pendingBugReports.get(response.requestId);
    if (pending) {
      clearTimeout(pending.timeoutId);
      this.pendingBugReports.delete(response.requestId);
      pending.resolve(response);
    }
    // If not in Map, the tool call already timed out - nothing more to do
  }

  /**
   * Persist a pending bug report capture to storage (for hibernation recovery).
   * Uses sync KV for better performance.
   */
  private persistPendingBugReport(requestId: string): void {
    this.ctx.storage.kv.put(`pending_bug_report:${requestId}`, Date.now().toString());
  }

  /**
   * Register a pending connection setup and return a promise that resolves when user responds.
   * Call persistPendingConnectionSetup() first to ensure storage is written.
   */
  private waitForConnectionSetup(requestId: string, timeoutMs: number): Promise<ConnectionSetupResponse> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingConnectionSetups.delete(requestId);
        // Clean up storage on timeout - sync KV
        this.ctx.storage.kv.delete(`pending_connection:${requestId}`);
        reject(new Error('Connection setup timed out'));
      }, timeoutMs);

      this.pendingConnectionSetups.set(requestId, { resolve, reject, timeoutId });
    });
  }

  /**
   * Wait for a bug report capture response from the user (via ChatThreadDO callback).
   * Call persistPendingBugReport() first to ensure storage is written.
   */
  private waitForBugReportCapture(requestId: string, timeoutMs: number): Promise<BugReportCaptureResponse> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingBugReports.delete(requestId);
        // Clean up storage on timeout - sync KV
        this.ctx.storage.kv.delete(`pending_bug_report:${requestId}`);
        reject(new Error('Bug report capture timed out'));
      }, timeoutMs);

      this.pendingBugReports.set(requestId, { resolve, reject, timeoutId });
    });
  }

  /**
   * Get the vanity domain for deployed apps based on current environment.
   * E.g., "camelai.app" for production, "staging.camelai.app" for staging
   */
  private getVanityDomain(): string {
    const baseUrl = this.env.WORKER_BASE_URL;
    if (baseUrl) {
      try {
        const hostname = new URL(baseUrl).hostname;
        const envPrefix = getEnvPrefix(hostname);
        if (envPrefix) return `${envPrefix}.camelai.app`;
        // WORKER_BASE_URL is set but not a camelai.dev hostname (e.g. ngrok) → local dev
        if (hostname !== 'camelai.dev' && !hostname.endsWith('.camelai.dev')) {
          return 'local.camelai.app';
        }
        return 'camelai.app';
      } catch {
        return 'camelai.app';
      }
    }
    return 'camelai.app';
  }

  /**
   * Get the org slug, fetching from OrgDO if not cached.
   */
  private async getOrgSlug(): Promise<string | null> {
    if (this.orgSlug) return this.orgSlug;
    if (!this.orgId) return null;
    try {
      const orgStub = this.getOrgStub();
      this.orgSlug = await orgStub.getSlug();
      return this.orgSlug;
    } catch {
      return null;
    }
  }

  private async refreshScriptCustomDomainState(
    script: WorkerScript
  ): Promise<WorkerScript> {
    const zoneId = this.env.CF_ZONE_ID?.trim();
    const apiToken = this.env.CF_API_TOKEN?.trim();
    if (!script.custom_domain_hostname || !zoneId || !apiToken || isAppCustomDomainReady(script)) {
      return script;
    }

    const expectedHostname = script.custom_domain_hostname;
    let record = null;

    if (script.custom_domain_cf_hostname_id && script.custom_domain_hostname === expectedHostname) {
      record = await getCustomHostnameStatus(zoneId, apiToken, script.custom_domain_cf_hostname_id);
    }

    if (!record) {
      record = await findCustomHostnameByHostname(zoneId, apiToken, expectedHostname);
    }

    if (!record) {
      return script;
    }

    const orgStub = this.getOrgStub();
    return (
      await orgStub.updateWorkerScriptCustomDomain(script.script_name, {
        hostname: expectedHostname,
        cf_hostname_id: record.id,
        status: record.status,
        ssl_status: record.ssl.status,
        error: null,
      })
    ) ?? script;
  }

  /**
   * Get the full URL for a deployed app.
   * New-style slugs (6+ alphanumeric) use single hyphen, old-style use double.
   */
  private async getAppUrl(script: WorkerScript): Promise<string> {
    let refreshedScript = script;
    let appHostname = 'camelai.dev';
    try {
      refreshedScript = await this.refreshScriptCustomDomainState(script);
    } catch {}

    if (this.env.WORKER_BASE_URL) {
      try {
        appHostname = new URL(this.env.WORKER_BASE_URL).hostname;
      } catch {}
    }

    const orgSlug = await this.getOrgSlug();
    return getPreferredAppUrl(refreshedScript, {
      hostname: appHostname,
      orgSlug: orgSlug ?? undefined,
      orgCustomDomain: null,
    });
  }

  private sanitizePathInput(path: string): string {
    return path.trim().replace(/\\/g, '/');
  }

  private normalizePathSegments(path: string, leadingSlash: boolean): string | null {
    const segments = path
      .split('/')
      .filter((segment) => segment.length > 0 && segment !== '.');

    if (segments.some((segment) => segment === '..')) {
      return null;
    }

    const normalized = segments.join('/');
    if (leadingSlash) {
      return normalized ? `/${normalized}` : '/';
    }
    return normalized;
  }

  private basename(path: string): string {
    return path.split('/').filter(Boolean).pop() || path;
  }

  private encodePathSegments(path: string): string {
    return path
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
  }

  private parseFilePreviewPath(rawPath: string): ParsedFilePreviewPath | null {
    const trimmed = this.sanitizePathInput(rawPath);
    if (!trimmed) return null;

    const absoluteInput = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;

    for (const { prefix, source } of TEMP_PREVIEW_PREFIXES) {
      if (!absoluteInput.startsWith(prefix)) continue;
      const relative = absoluteInput.slice(prefix.length);
      const normalized = this.normalizePathSegments(relative, false);
      if (!normalized) return null;
      return {
        source,
        path: normalized,
        filename: this.basename(normalized),
      };
    }

    let workspacePath = absoluteInput;
    for (const prefix of WORKSPACE_ROOT_PREFIXES) {
      if (workspacePath === prefix) {
        workspacePath = '/';
        break;
      }
      if (workspacePath.startsWith(`${prefix}/`)) {
        workspacePath = workspacePath.slice(prefix.length);
        if (!workspacePath.startsWith('/')) {
          workspacePath = `/${workspacePath}`;
        }
        break;
      }
    }

    const normalizedWorkspacePath = this.normalizePathSegments(workspacePath, true);
    if (!normalizedWorkspacePath || normalizedWorkspacePath === '/') return null;
    return {
      source: 'workspace',
      path: normalizedWorkspacePath,
      filename: this.basename(normalizedWorkspacePath),
    };
  }

  async init() {
    // ==========================================
    // Deployment Management Tools
    // ==========================================

    // List deployed apps/workers
    this.server.tool(
      'list_apps',
      'List deployed apps/workers for the current workspace. Returns script names, URLs, visibility status, and creation info.',
      {},
      async () => {
        const { workspaceId } = this.requireAuth();
        if (!workspaceId) {
          return this.textResponse({ error: 'No workspace context available' });
        }

        const orgStub = this.getOrgStub();
        const scripts: WorkerScript[] = await orgStub.listWorkerScriptsByWorkspace(workspaceId);

        const apps = await Promise.all(scripts.map(async (s: WorkerScript) => ({
          name: s.script_name,
          url: await this.getAppUrl(s),
          is_public: s.is_public,
          created_by: s.created_by,
          created_at: new Date(s.created_at).toISOString(),
          updated_at: new Date(s.updated_at).toISOString(),
          preview_status: s.preview_status,
        })));

        return this.textResponse({ count: apps.length, apps });
      }
    );

    // Set app visibility (public/private)
    this.server.tool(
      'set_app_visibility',
      'Change the visibility of a deployed app in the current workspace. Public apps are accessible to anyone, private apps require authentication.',
      {
        script_name: z.string().describe('The name of the app/worker script'),
        is_public: z.boolean().describe('Set to true for public access, false for private (org members only)'),
      },
      async ({ script_name, is_public }) => {
        const { orgId, userId, workspaceId } = this.requireAuth();
        if (!workspaceId) {
          return this.textResponse({ error: 'No workspace context available' });
        }

        const orgStub = this.getOrgStub();

        // Verify script belongs to current workspace
        const script: WorkerScript | null = await orgStub.getWorkerScript(script_name);
        if (!script) {
          return this.textResponse({ success: false, error: `App '${script_name}' not found` });
        }
        if (script.workspace_id !== workspaceId) {
          return this.textResponse({ success: false, error: `App '${script_name}' belongs to a different workspace` });
        }

        const result = await orgStub.setWorkerScriptPublic(script_name, is_public, userId);
        if (!result) {
          return this.textResponse({ success: false, error: `Failed to update app '${script_name}'` });
        }

        return this.textResponse({
          success: true,
          app: {
            name: result.script_name,
            url: await this.getAppUrl(result),
            is_public: result.is_public,
            updated_at: new Date(result.updated_at).toISOString(),
          },
          message: `App '${script_name}' is now ${is_public ? 'public' : 'private'}`,
        });
      }
    );

    // Set preview panel to a file
    this.server.tool(
      'set_file_preview',
      'Set the chat preview panel to a file path. Supports workspace paths and temp output paths like /mnt/user-uploads/... or /mnt/user-outputs/....',
      {
        path: z
          .string()
          .describe('Path to preview. Examples: "/home/claude/README.md", "src/app.tsx", "/mnt/user-outputs/plot.png", "/mnt/user-uploads/notebook.ipynb"'),
        content_type: z
          .string()
          .optional()
          .describe('Optional MIME type hint (for example "application/x-ipynb+json" or "image/png").'),
      },
      async ({ path, content_type }) => {
        const { workspaceId } = this.requireAuth();
        if (!workspaceId) {
          return this.textResponse({ success: false, error: 'No workspace context available' });
        }

        // Thread ID comes from the proxy auth headers
        const threadId = this.threadId;
        if (!threadId) {
          return this.textResponse({
            success: false,
            error: 'No thread context available.',
          });
        }

        const parsedPath = this.parseFilePreviewPath(path);
        if (!parsedPath) {
          return this.textResponse({
            success: false,
            error: 'Invalid file path. Use a workspace path, /mnt/user-uploads/..., or /mnt/user-outputs/... without ".." segments.',
          });
        }

        const target: PreviewTarget = {
          kind: 'file',
          source: parsedPath.source,
          workspaceId,
          path: parsedPath.path,
          filename: parsedPath.filename,
          contentType: typeof content_type === 'string' && content_type.trim() ? content_type.trim() : undefined,
        };

        const chatThreadStub = this.getChatThreadStub(threadId);
        await chatThreadStub.setPreviewTarget(target);

        const normalizedPath = target.path.replace(/^\/+/, '');
        const encodedPath = this.encodePathSegments(normalizedPath);
        const route = target.source === 'workspace'
          ? `fs/content/${encodedPath}`
          : `${target.source === 'upload' ? 'uploads' : 'outputs'}/${encodedPath}`;
        const previewUrl = `/api/workspaces/${workspaceId}/${route}`;

        return this.textResponse({
          success: true,
          target,
          preview_url: previewUrl,
          message: `Preview set to ${target.path}`,
        });
      }
    );

    // Set preview panel to a deployed app
    this.server.tool(
      'set_app_preview',
      'Set the chat preview panel to a deployed app in the current workspace.',
      {
        script_name: z.string().describe('The name of the deployed app/worker script to preview.'),
      },
      async ({ script_name }) => {
        const { workspaceId } = this.requireAuth();
        if (!workspaceId) {
          return this.textResponse({ success: false, error: 'No workspace context available' });
        }

        // Thread ID comes from the proxy auth headers
        const threadId = this.threadId;
        if (!threadId) {
          return this.textResponse({
            success: false,
            error: 'No thread context available.',
          });
        }

        const orgStub = this.getOrgStub();
        const script: WorkerScript | null = await orgStub.getWorkerScript(script_name);
        if (!script) {
          return this.textResponse({ success: false, error: `App '${script_name}' not found` });
        }
        if (script.workspace_id !== workspaceId) {
          return this.textResponse({ success: false, error: `App '${script_name}' belongs to a different workspace` });
        }

        const target: PreviewTarget = {
          kind: 'app',
          scriptName: script.script_name,
          isPublic: script.is_public,
        };

        const chatThreadStub = this.getChatThreadStub(threadId);
        await chatThreadStub.setPreviewTarget(target);

        return this.textResponse({
          success: true,
          target,
          app: {
            name: script.script_name,
            url: await this.getAppUrl(script),
            is_public: script.is_public,
          },
          message: `Preview set to app '${script.script_name}'`,
        });
      }
    );

    // Get recent logs for a deployed app
    this.server.tool(
      'get_latest_logs',
      'Get recent runtime logs for a deployed app in the current workspace. Returns console and exception events captured by the tail worker.',
      {
        script_name: z.string().min(1).describe('The app/worker script name to fetch logs for.'),
        limit: z.number().int().min(1).max(500).optional().describe('Maximum number of log entries to return (default 100, max 500).'),
        since_ms: z.number().int().min(0).optional().describe('Optional lower-bound timestamp in milliseconds; only logs newer than this are returned.'),
      },
      async ({ script_name, limit = 100, since_ms }) => {
        const { workspaceId } = this.requireAuth();
        if (!workspaceId) {
          return this.textResponse({ success: false, error: 'No workspace context available' });
        }

        const orgStub = this.getOrgStub();
        const script: WorkerScript | null = await orgStub.getWorkerScript(script_name);
        if (!script) {
          return this.textResponse({ success: false, error: `App '${script_name}' not found` });
        }
        if (script.workspace_id !== workspaceId) {
          return this.textResponse({ success: false, error: `App '${script_name}' belongs to a different workspace` });
        }

        const orgSlug = await this.getOrgSlug();
        // Security: do not fall back to unscoped legacy keys when an org slug exists.
        const storageKey = orgSlug ? `${script_name}--${orgSlug}` : script_name;
        const logsStub = this.env.WORKER_LOGS.get(this.env.WORKER_LOGS.idFromName(storageKey));
        const [logs, stats] = await Promise.all([
          logsStub.getLogs({ limit, since: since_ms }),
          logsStub.getStats(),
        ]);

        return this.textResponse({
          success: true,
          script: {
            name: script_name,
            storage_key: storageKey,
            dispatch_name: storageKey,
          },
          count: logs.length,
          limit,
          since_ms: since_ms ?? null,
          stats: {
            total_log_count: stats.logCount,
            last_log_at_ms: stats.lastLogAt,
            last_log_at: stats.lastLogAt ? new Date(stats.lastLogAt).toISOString() : null,
          },
          logs: logs.map((entry) => ({
            id: entry.id,
            timestamp_ms: entry.timestamp,
            timestamp: new Date(entry.timestamp).toISOString(),
            level: entry.level,
            message: entry.message,
            exception: entry.exception,
            script_version: entry.scriptVersion,
          })),
        });
      }
    );

    // ==========================================
    // Scheduled Prompt Tools
    // ==========================================

    const formatScheduledPrompt = (prompt: {
      id: string;
      name: string;
      prompt: string;
      cron_expression: string;
      thread_id: string;
      scheduled_by_thread_id: string | null;
      enabled: boolean;
      created_by: string;
      created_at: number;
      updated_at: number;
      next_run_at: number | null;
      last_run_at: number | null;
      last_run_status: string | null;
      last_run_error: string | null;
      run_count: number;
    }) => ({
      id: prompt.id,
      name: prompt.name,
      prompt: prompt.prompt,
      cron_expression: prompt.cron_expression,
      thread_id: prompt.thread_id,
      scheduled_by_thread_id: prompt.scheduled_by_thread_id,
      enabled: prompt.enabled,
      created_by: prompt.created_by,
      created_at: new Date(prompt.created_at).toISOString(),
      updated_at: new Date(prompt.updated_at).toISOString(),
      next_run_at: prompt.next_run_at ? new Date(prompt.next_run_at).toISOString() : null,
      last_run_at: prompt.last_run_at ? new Date(prompt.last_run_at).toISOString() : null,
      last_run_status: prompt.last_run_status,
      last_run_error: prompt.last_run_error,
      run_count: prompt.run_count,
    });

    this.server.tool(
      'list_scheduled_prompts',
      'List scheduled prompts for the current workspace. Cron expressions use 5 fields in UTC: minute hour day-of-month month day-of-week.',
      {},
      async () => {
        const { workspaceId } = this.requireAuth();
        if (!workspaceId) {
          return this.textResponse({ success: false, error: 'No workspace context available' });
        }
        try {
          const schedulerStub = this.getWorkspaceCronStub(workspaceId);
          const prompts = await schedulerStub.listScheduledPrompts(workspaceId);

          return this.textResponse({
            success: true,
            count: prompts.length,
            timezone: 'UTC',
            prompts: prompts.map((prompt) => formatScheduledPrompt(prompt)),
          });
        } catch (error) {
          return this.textResponse({
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    );

    this.server.tool(
      'create_scheduled_prompt',
      'Create a scheduled prompt in the current workspace. The cron expression is evaluated in UTC, and a dedicated thread is created for this schedule automatically.',
      {
        name: z.string().describe('Friendly name for the scheduled prompt'),
        prompt: z.string().describe('Prompt text to send when the schedule fires'),
        cron_expression: z
          .string()
          .describe('5-field cron expression in UTC: minute hour day-of-month month day-of-week'),
        enabled: z
          .boolean()
          .optional()
          .describe('Optional. Defaults to true. Set false to create a paused schedule.'),
      },
      async ({ name, prompt, cron_expression, enabled }) => {
        const { userId, workspaceId } = this.requireAuth();
        if (!workspaceId) {
          return this.textResponse({ success: false, error: 'No workspace context available' });
        }

        try {
          const schedulerStub = this.getWorkspaceCronStub(workspaceId);
          const created = await schedulerStub.createScheduledPrompt({
            workspaceId,
            name,
            prompt,
            cronExpression: cron_expression,
            createdBy: userId,
            scheduledByThreadId: this.threadId,
            enabled,
          });

          return this.textResponse({
            success: true,
            timezone: 'UTC',
            scheduled_prompt: formatScheduledPrompt(created),
            message: `Created scheduled prompt "${created.name}"`,
          });
        } catch (error) {
          return this.textResponse({
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    );

    this.server.tool(
      'update_scheduled_prompt',
      'Update an existing scheduled prompt in the current workspace.',
      {
        prompt_id: z.string().describe('ID of the scheduled prompt to update'),
        name: z.string().optional().describe('Optional new display name'),
        prompt: z.string().optional().describe('Optional new prompt text'),
        cron_expression: z
          .string()
          .optional()
          .describe('Optional new 5-field UTC cron expression'),
        enabled: z
          .boolean()
          .optional()
          .describe('Optional enabled state'),
      },
      async ({ prompt_id, name, prompt, cron_expression, enabled }) => {
        const { workspaceId } = this.requireAuth();
        if (!workspaceId) {
          return this.textResponse({ success: false, error: 'No workspace context available' });
        }

        try {
          const schedulerStub = this.getWorkspaceCronStub(workspaceId);
          const updated = await schedulerStub.updateScheduledPrompt({
            workspaceId,
            id: prompt_id,
            name,
            prompt,
            cronExpression: cron_expression,
            enabled,
          });

          if (!updated) {
            return this.textResponse({
              success: false,
              error: `Scheduled prompt "${prompt_id}" not found`,
            });
          }

          return this.textResponse({
            success: true,
            timezone: 'UTC',
            scheduled_prompt: formatScheduledPrompt(updated),
            message: `Updated scheduled prompt "${updated.name}"`,
          });
        } catch (error) {
          return this.textResponse({
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    );

    this.server.tool(
      'delete_scheduled_prompt',
      'Delete a scheduled prompt from the current workspace.',
      {
        prompt_id: z.string().describe('ID of the scheduled prompt to delete'),
      },
      async ({ prompt_id }) => {
        const { workspaceId } = this.requireAuth();
        if (!workspaceId) {
          return this.textResponse({ success: false, error: 'No workspace context available' });
        }

        try {
          const schedulerStub = this.getWorkspaceCronStub(workspaceId);
          const deleted = await schedulerStub.deleteScheduledPrompt(workspaceId, prompt_id);
          if (!deleted) {
            return this.textResponse({
              success: false,
              error: `Scheduled prompt "${prompt_id}" not found`,
            });
          }

          return this.textResponse({
            success: true,
            message: `Deleted scheduled prompt "${prompt_id}"`,
          });
        } catch (error) {
          return this.textResponse({
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    );

    this.server.tool(
      'run_scheduled_prompt_now',
      'Trigger a scheduled prompt immediately without waiting for its next cron time.',
      {
        prompt_id: z.string().describe('ID of the scheduled prompt to run now'),
      },
      async ({ prompt_id }) => {
        const { workspaceId } = this.requireAuth();
        if (!workspaceId) {
          return this.textResponse({ success: false, error: 'No workspace context available' });
        }

        try {
          const schedulerStub = this.getWorkspaceCronStub(workspaceId);
          const result = await schedulerStub.runScheduledPromptNow(workspaceId, prompt_id);
          if (!result) {
            return this.textResponse({
              success: false,
              error: `Scheduled prompt "${prompt_id}" not found`,
            });
          }

          return this.textResponse({
            success: true,
            timezone: 'UTC',
            scheduled_prompt: formatScheduledPrompt(result.prompt),
            run: {
              status: result.dispatch.status,
              thread_id: result.dispatch.thread_id,
              error: result.dispatch.error,
              reply: result.dispatch.reply,
            },
          });
        } catch (error) {
          return this.textResponse({
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    );

    // ==========================================
    // Integration Tools
    // ==========================================

    // List configured integrations
    this.server.tool(
      'list_integrations',
      'List configured integrations (Stripe, Notion, GitHub, etc.) for the current workspace.',
      {
        category: z
          .enum(['databases', 'saas', 'ai_services', 'cloud_providers', 'communication'])
          .optional()
          .describe('Optional category to filter integrations'),
      },
      async ({ category }) => {
        const { workspaceId } = this.requireAuth();
        if (!workspaceId) {
          return this.textResponse({ error: 'No workspace context available' });
        }

        const workspaceStub = this.getWorkspaceStub(workspaceId);
        const rawIntegrations = await workspaceStub.getIntegrations();

        // Map from DO format to Integration type (including config for dynamic field detection)
        const integrations = rawIntegrations.map(r => {
          let parsedConfig: Record<string, unknown> = {};
          try {
            parsedConfig = r.config ? JSON.parse(r.config) : {};
          } catch {
            // Ignore parse errors
          }
          return {
            id: r.id,
            integration_type: r.integration_type,
            name: r.name,
            category: r.category,
            auth_method: r.auth_method,
            has_credentials: Boolean(r.credentials_encrypted),
            created_at: r.created_at,
            updated_at: r.updated_at,
            config: parsedConfig,
          };
        });

        let filtered = integrations;
        if (category) {
          filtered = filtered.filter((i) => i.category === category);
        }

        const result = filtered.map((i) => {
          // For "other" type with dynamic_fields, use those for env var suffixes
          const dynamicFields = i.integration_type === 'other' && i.config.dynamic_fields
            ? (i.config.dynamic_fields as DynamicField[])
            : undefined;
          const envVarPrefix = `INT_${normalizeEnvVarName(i.integration_type)}_${normalizeEnvVarName(i.name)}`;
          const envVarSuffixes = getEnvVarSuffixesForType(i.integration_type, dynamicFields);
          return {
            id: i.id,
            type: i.integration_type,
            name: i.name,
            category: i.category,
            auth_method: i.auth_method,
            has_credentials: i.has_credentials,
            created_at: new Date(i.created_at).toISOString(),
            updated_at: new Date(i.updated_at).toISOString(),
            // Env var info for accessing credentials
            env_var_prefix: envVarPrefix,
            env_vars: envVarSuffixes.map(suffix => `${envVarPrefix}_${suffix}`),
            // For dynamic "other" integrations, include the display name
            display_name: i.integration_type === 'other' && i.config.display_name
              ? (i.config.display_name as string)
              : undefined,
          };
        });

        return this.textResponse({ count: result.length, integrations: result });
      }
    );

    // List available integration types
    this.server.tool(
      'list_integration_types',
      'List all available integration types that can be configured (Stripe, Notion, PostgreSQL, etc.). Returns the registry of supported integrations with their configuration schemas.',
      {
        category: z
          .enum(['databases', 'saas', 'ai_services', 'cloud_providers', 'communication'])
          .optional()
          .describe('Optional category to filter integration types'),
      },
      async ({ category }) => {
        const integrations = category ? getIntegrationsByCategory(category) : getAllIntegrations();

        const types = integrations.map((def) => ({
          type: def.type,
          display_name: def.displayName,
          description: def.description,
          category: def.category,
          auth_method: def.authMethod,
          config_fields: def.configSchema.map((f) => ({
            name: f.name,
            label: f.label,
            type: f.type,
            required: f.required,
            description: f.description,
          })),
          credential_fields: def.credentialSchema.map((f) => ({
            name: f.name,
            label: f.label,
            required: f.required,
            description: f.description,
          })),
          supports_proxy: false,
        }));

        // Group by category for easier reading
        const byCategory: Record<string, typeof types> = {};
        for (const t of types) {
          if (!byCategory[t.category]) {
            byCategory[t.category] = [];
          }
          byCategory[t.category].push(t);
        }

        return this.textResponse({
          total_count: types.length,
          by_category: byCategory,
        });
      }
    );

    // Create a new integration
    this.server.tool(
      'create_integration',
      'Create a new integration/connection for the current workspace. Use list_integration_types to see available types and their required config/credential fields.',
      {
        integration_type: z.string().describe('The type of integration (e.g., "stripe", "notion", "postgres", "other")'),
        name: z.string().describe('A friendly name for this connection (e.g., "Production Stripe", "My Notion Workspace")'),
        config: z
          .any()
          .optional()
          .describe('Configuration fields as an object (varies by type). For "other" type, include display_name, description, base_url, auth_type, auth_header.'),
        credentials: z
          .any()
          .optional()
          .describe('Credential fields as an object (e.g., api_key, api_secret, client_id, client_secret). These are encrypted at rest.'),
      },
      async ({ integration_type, name, config = {}, credentials = {} }) => {
        const { orgId, userId, workspaceId } = this.requireAuth();
        if (!workspaceId) {
          return this.textResponse({ error: 'No workspace context available' });
        }

        // Validate integration type
        const definition = getIntegrationDefinition(integration_type);
        if (!definition) {
          return this.textResponse({
            success: false,
            error: `Unknown integration type: ${integration_type}. Use list_integration_types to see available types.`,
          });
        }

        // Validate config fields
        const configErrors = validateConfig(integration_type, config as Record<string, unknown>);
        if (configErrors.length > 0) {
          return this.textResponse({
            success: false,
            error: 'Invalid configuration',
            validation_errors: configErrors,
          });
        }

        // Validate credential fields
        const credentialErrors = validateCredentials(integration_type, credentials as Record<string, unknown>);
        if (credentialErrors.length > 0) {
          return this.textResponse({
            success: false,
            error: 'Invalid credentials',
            validation_errors: credentialErrors,
          });
        }

        try {
          // Encrypt credentials
          const credentialsEncrypted = await encryptCredentials(credentials as Record<string, unknown>, this.env.INTEGRATION_SECRET_KEY);

          // Generate ID and create integration
          const integrationId = crypto.randomUUID();
          const workspaceStub = this.getWorkspaceStub(workspaceId);

          await workspaceStub.createIntegration(
            integrationId,
            integration_type,
            name,
            definition.category,
            definition.authMethod,
            JSON.stringify(config),
            credentialsEncrypted,
            userId
          );

          // Kick off worker secret sync immediately so deployed workers are not
          // blocked by sandbox env-file refresh latency.
          this.ctx.waitUntil(
            syncAllWorkspaceWorkerSecrets(this.env as unknown as CfApiProxyEnv, workspaceId, orgId)
              .catch((err) => console.error('[MCP] Failed to sync secrets to workers:', err))
          );

          // Refresh live integration env file in the sandbox.
          const envFileRefreshed = await this.refreshWorkspaceIntegrationEnvFile(workspaceId, orgId);

          const envVarPrefix = `INT_${normalizeEnvVarName(integration_type)}_${normalizeEnvVarName(name)}`;
          const envVarSuffixes = getEnvVarSuffixesForType(integration_type);
          return this.textResponse({
            success: true,
            integration: {
              id: integrationId,
              type: integration_type,
              name,
              category: definition.category,
              env_var_prefix: envVarPrefix,
              env_vars: envVarSuffixes.map(suffix => `${envVarPrefix}_${suffix}`),
              env_file_refreshed: envFileRefreshed,
            },
            message: `Integration '${name}' created successfully. Environment variables: ${envVarSuffixes.map(suffix => `${envVarPrefix}_${suffix}`).join(', ')}`,
          });
        } catch (err) {
          return this.textResponse({
            success: false,
            error: err instanceof Error ? err.message : 'Failed to create integration',
          });
        }
      }
    );

    // Prompt user to set up a connection via UI modal
    this.server.tool(
      'prompt_connection_setup',
      'Prompt the user to set up a new integration/connection through a UI modal in the chat interface. This allows the user to securely enter credentials without exposing them in the chat. The tool will wait for the user to complete the setup and return the result. For direct database integrations, include a note in instructions reminding the user to allowlist 20.46.233.68 on their database firewall. For custom integrations, use integration_type="other" with the fields parameter to define custom credential fields.',
      {
        integration_type: z
          .string()
          .describe('The type of integration to set up (e.g., "stripe", "notion", "slack", "github", "other"). Use "other" for custom APIs not in the registry.'),
        suggested_name: z
          .string()
          .optional()
          .describe('Optional: Suggested name for the connection that will be pre-filled in the form.'),
        message: z
          .string()
          .optional()
          .describe('Optional: A message to show the user explaining why this connection is needed.'),
        display_name: z
          .string()
          .optional()
          .describe('Optional: Display name for custom integrations (when integration_type="other"). E.g., "Acme API"'),
        description: z
          .string()
          .optional()
          .describe('Optional: Description for custom integrations. E.g., "Connect to Acme\'s product catalog API"'),
        instructions: z
          .string()
          .optional()
          .describe('Optional: Setup instructions shown above the form. Supports markdown. E.g., "Find your API key in Acme dashboard under Settings > API Keys"'),
        fields: z
          .array(z.object({
            name: z.string().describe('Field name for env var suffix (e.g., "api_key" becomes _API_KEY)'),
            label: z.string().describe('Display label shown in UI'),
            type: z.enum(['password', 'text', 'url', 'number']).describe('Input type'),
            required: z.boolean().describe('Whether the field is required'),
            placeholder: z.string().optional().describe('Placeholder text'),
            description: z.string().optional().describe('Help text below input'),
          }))
          .max(10)
          .optional()
          .describe('Optional: Custom credential fields for "other" integrations. Max 10 fields.'),
      },
      async ({ integration_type, suggested_name, message, display_name, description, instructions, fields }) => {
        const { orgId, userId, workspaceId } = this.requireAuth();
        if (!workspaceId) {
          return this.textResponse({ error: 'No workspace context available' });
        }

        // Thread ID comes from the proxy auth headers
        const threadId = this.threadId;
        if (!threadId) {
          return this.textResponse({
            success: false,
            error: 'No thread context available.',
          });
        }

        // Validate integration type and get definition for default name
        const definition = getIntegrationDefinition(integration_type);
        if (!definition) {
          return this.textResponse({
            success: false,
            error: `Unknown integration type: ${integration_type}. Use list_integration_types to see available types.`,
          });
        }

        // Build dynamic schema for "other" type with custom fields
        let dynamicSchema: DynamicIntegrationSchema | undefined;
        if (integration_type === 'other' && fields && fields.length > 0) {
          dynamicSchema = {
            displayName: display_name || suggested_name || 'Custom Integration',
            description: description,
            instructions: instructions,
            fields: fields,
          };
        }

        // Generate default name if not provided (e.g., "Stripe", "Notion")
        // For dynamic "other" integrations, prefer the display_name
        const defaultName = suggested_name || (integration_type === 'other' && display_name) || definition.displayName;

        const requestId = crypto.randomUUID();
        const timeoutMs = 30 * 60 * 1000; // 30 minutes

        try {
          // Get the MCP DO's own ID so ChatThreadDO can call back
          const mcpDoId = this.ctx.id.toString();

          // Persist to storage first (for hibernation recovery) - sync KV
          this.persistPendingConnectionSetup(requestId);

          // Register the pending request BEFORE sending to ChatThreadDO
          const responsePromise = this.waitForConnectionSetup(requestId, timeoutMs);

          // Send prompt to ChatThreadDO with callback info
          const chatThreadStub = this.getChatThreadStub(threadId);
          const promptResponse = await chatThreadStub.fetch(
            new Request('http://internal/connection-setup/prompt', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                requestId,
                integrationType: integration_type,
                suggestedName: defaultName,
                message,
                instructions,
                createdAt: Date.now(),
                // Callback info for RPC
                mcpDoId,
                // Dynamic schema for custom "other" integrations
                dynamicSchema,
              } as ConnectionSetupRequest & { mcpDoId: string; dynamicSchema?: DynamicIntegrationSchema }),
            })
          );

          if (!promptResponse.ok) {
            // Clean up pending request (both in-memory and storage)
            const pending = this.pendingConnectionSetups.get(requestId);
            if (pending) {
              clearTimeout(pending.timeoutId);
              this.pendingConnectionSetups.delete(requestId);
            }
            this.ctx.storage.kv.delete(`pending_connection:${requestId}`);
            return this.textResponse({
              success: false,
              error: 'Failed to send prompt to user',
            });
          }

          // Wait for user response (via RPC callback from ChatThreadDO)
          const userResponse = await responsePromise;

          if (userResponse.cancelled) {
            return this.textResponse({
              success: false,
              cancelled: true,
              message: 'User cancelled the connection setup',
            });
          }

          if (!userResponse.integration) {
            return this.textResponse({
              success: false,
              error: 'Invalid response from user - missing integration data',
            });
          }

          // Create the integration
          const { type, name, config, credentials } = userResponse.integration;
          const intDefinition = getIntegrationDefinition(type);

          if (!intDefinition) {
            return this.textResponse({
              success: false,
              error: `Unknown integration type from user response: ${type}`,
            });
          }

          // Check if OAuth flow already created the integration
          // This happens when user completes OAuth flow in browser
          if (credentials._oauth_completed && credentials.integration_id) {
            const integrationId = credentials.integration_id as string;
            const envFileRefreshed = await this.refreshWorkspaceIntegrationEnvFile(workspaceId, orgId);
            const envVarPrefix = `INT_${normalizeEnvVarName(type)}_${normalizeEnvVarName(name)}`;
            const envVarSuffixes = getEnvVarSuffixesForType(type);
            return this.textResponse({
              success: true,
              integration: {
                id: integrationId,
                type,
                name,
                category: intDefinition.category,
                env_var_prefix: envVarPrefix,
                env_vars: envVarSuffixes.map(suffix => `${envVarPrefix}_${suffix}`),
                env_file_refreshed: envFileRefreshed,
              },
              message: `Integration '${name}' connected successfully via OAuth. Environment variables: ${envVarSuffixes.map(suffix => `${envVarPrefix}_${suffix}`).join(', ')}`,
            });
          }

          // For dynamic "other" integrations, store the field definitions in config
          // so env var mapping can use them later
          let finalConfig = config;
          if (type === 'other' && dynamicSchema && dynamicSchema.fields.length > 0) {
            finalConfig = {
              ...config,
              display_name: dynamicSchema.displayName,
              dynamic_fields: dynamicSchema.fields,
            };
          }

          // Encrypt credentials and create integration
          const credentialsEncrypted = await encryptCredentials(credentials, this.env.INTEGRATION_SECRET_KEY);
          const integrationId = crypto.randomUUID();

          // Get workspace stub for creating integration
          const workspaceStub = this.getWorkspaceStub(workspaceId);
          await workspaceStub.createIntegration(
            integrationId,
            type,
            name,
            intDefinition.category,
            intDefinition.authMethod,
            JSON.stringify(finalConfig),
            credentialsEncrypted,
            userId
          );

          // Kick off worker secret sync immediately so deployed workers are not
          // blocked by sandbox env-file refresh latency.
          this.ctx.waitUntil(
            syncAllWorkspaceWorkerSecrets(this.env as unknown as CfApiProxyEnv, workspaceId, orgId)
              .catch((err) => console.error('[MCP] Failed to sync secrets to workers:', err))
          );

          // Refresh live integration env file in the sandbox.
          const envFileRefreshed = await this.refreshWorkspaceIntegrationEnvFile(workspaceId, orgId);

          // For dynamic "other" integrations, generate env var suffixes from field names
          const dynamicFields = type === 'other' && dynamicSchema?.fields ? dynamicSchema.fields : undefined;
          const envVarPrefix = `INT_${normalizeEnvVarName(type)}_${normalizeEnvVarName(name)}`;
          const envVarSuffixes = getEnvVarSuffixesForType(type, dynamicFields);
          return this.textResponse({
            success: true,
            integration: {
              id: integrationId,
              type,
              name,
              category: definition.category,
              env_var_prefix: envVarPrefix,
              env_vars: envVarSuffixes.map(suffix => `${envVarPrefix}_${suffix}`),
              env_file_refreshed: envFileRefreshed,
            },
            message: `Integration '${name}' created successfully via user prompt. Environment variables: ${envVarSuffixes.map(suffix => `${envVarPrefix}_${suffix}`).join(', ')}`,
          });
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : 'Failed to prompt for connection setup';
          const isTimeout = errorMessage.includes('timed out');

          return this.textResponse({
            success: false,
            timeout: isTimeout,
            error: errorMessage,
            message: isTimeout
              ? 'Connection setup timed out. The user did not complete the setup in time.'
              : undefined,
          });
        }
      }
    );

    // Capture a bug report from the currently deployed app
    this.server.tool(
      'capture_bug_report',
      'Capture a bug report from the currently deployed app preview. This tool triggers the bug capture UI in the user\'s browser, which captures a screenshot, DOM snapshot, console logs, network requests, and session recording. Use this when you need to debug an issue with a deployed app or want to see the current state of the preview. The user will see a dialog allowing them to add a description before the capture is completed.',
      {
        message: z
          .string()
          .optional()
          .describe('Optional message to show the user explaining why you need to capture a bug report (e.g., "I\'d like to capture the current state to debug the login issue")'),
      },
      async ({ message }) => {
        const { workspaceId } = this.requireAuth();
        if (!workspaceId) {
          return this.textResponse({ error: 'No workspace context available' });
        }

        // Thread ID comes from the proxy auth headers
        const threadId = this.threadId;
        if (!threadId) {
          return this.textResponse({
            success: false,
            error: 'No thread context available.',
          });
        }

        const requestId = crypto.randomUUID();
        const timeoutMs = 2 * 60 * 1000; // 2 minutes (screenshot capture can take time)

        try {
          // Get the MCP DO's own ID so ChatThreadDO can call back
          const mcpDoId = this.ctx.id.toString();

          // Persist to storage first (for hibernation recovery) - sync KV
          this.persistPendingBugReport(requestId);

          // Register the pending request BEFORE sending to ChatThreadDO
          const responsePromise = this.waitForBugReportCapture(requestId, timeoutMs);

          // Send prompt to ChatThreadDO with callback info
          const chatThreadStub = this.getChatThreadStub(threadId);
          const promptResponse = await chatThreadStub.fetch(
            new Request('http://internal/bug-report/prompt', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                requestId,
                message,
                createdAt: Date.now(),
                mcpDoId,
              } as BugReportCaptureRequest & { mcpDoId: string }),
            })
          );

          if (!promptResponse.ok) {
            // Clean up pending request (both in-memory and storage)
            const pending = this.pendingBugReports.get(requestId);
            if (pending) {
              clearTimeout(pending.timeoutId);
              this.pendingBugReports.delete(requestId);
            }
            this.ctx.storage.kv.delete(`pending_bug_report:${requestId}`);
            return this.textResponse({
              success: false,
              error: 'Failed to send bug report prompt to user',
            });
          }

          // Wait for user response (via RPC callback from ChatThreadDO)
          const userResponse = await responsePromise;

          if (userResponse.cancelled) {
            return this.textResponse({
              success: false,
              cancelled: true,
              message: 'User cancelled the bug report capture',
            });
          }

          if (!userResponse.bugReport) {
            return this.textResponse({
              success: false,
              error: 'Invalid response from user - missing bug report data',
            });
          }

          const { reportPath, screenshotPath, sessionRecordingPath, appName, appUrl, userDescription } = userResponse.bugReport;

          return this.textResponse({
            success: true,
            bug_report: {
              report_path: reportPath,
              screenshot_path: screenshotPath,
              session_recording_path: sessionRecordingPath,
              app_name: appName,
              app_url: appUrl,
              user_description: userDescription,
            },
            message: `Bug report captured successfully for app "${appName}". The report is available at: ${reportPath}`,
          });
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : 'Failed to capture bug report';
          const isTimeout = errorMessage.includes('timed out');

          return this.textResponse({
            success: false,
            timeout: isTimeout,
            error: errorMessage,
            message: isTimeout
              ? 'Bug report capture timed out. The user did not complete the capture in time.'
              : undefined,
          });
        }
      }
    );

    // ── Custom Domain Tools ──────────────────────────────────────────

    // Get exact custom domains with diagnostic info
    this.server.tool(
      'get_custom_domain',
      'Get exact custom domains configured for this organization with required DNS records, per-app hostname/SSL status, and live DNS resolution checks. Use this to troubleshoot custom domain issues.',
      {},
      async () => {
        this.requireAuth();
        const orgStub = this.getOrgStub();
        const zoneId = this.env.CF_ZONE_ID?.trim();
        const apiToken = this.env.CF_API_TOKEN?.trim();
        const dnsTarget = getCustomHostnameDnsTarget({
          cnameTarget: this.env.CF_CUSTOM_HOSTNAME_CNAME_TARGET,
          fallbackOrigin: this.env.CF_CUSTOM_HOSTNAME_FALLBACK,
        });
        const scripts = await orgStub.listWorkerScripts();
        const now = Date.now();
        const apps: Array<{
          name: string;
          hostname: string | null;
          cf_hostname_id: string | null;
          status: string | null;
          ssl_status: string | null;
          error: string | null;
          updated_at: number | null;
          dns_checks: {
            routing_cname: CustomDomainDnsCheck | null;
          };
        }> = [];

        for (const script of scripts) {
          let currentScript = script;

          if (
            zoneId &&
            apiToken &&
            shouldRefreshAppCustomDomainState(script, null, now) &&
            script.custom_domain_hostname
          ) {
            try {
              let record = null;
              if (script.custom_domain_cf_hostname_id) {
                record = await getCustomHostnameStatus(zoneId, apiToken, script.custom_domain_cf_hostname_id);
              }
              if (!record) {
                record = await findCustomHostnameByHostname(zoneId, apiToken, script.custom_domain_hostname);
              }
              if (record) {
                currentScript =
                  (await orgStub.updateWorkerScriptCustomDomain(script.script_name, {
                    hostname: script.custom_domain_hostname,
                    cf_hostname_id: record.id,
                    status: record.status,
                    ssl_status: record.ssl.status,
                    error: null,
                  })) ?? currentScript;
              }
            } catch (err) {
              // Fall through to diagnostic state derived from cached data
            }
          }

          const appState = getAppCustomDomainDiagnosticState(currentScript, null);
          const dnsChecks = {
            routing_cname: null as CustomDomainDnsCheck | null,
          };
          if (appState.hostname) {
            dnsChecks.routing_cname = buildCustomDomainDnsCheck({
              queried: appState.hostname,
              expectedTarget: dnsTarget,
              lookup: await resolveCnameViaDoH(appState.hostname),
            });
          }

          apps.push({
            name: script.script_name,
            hostname: appState.hostname,
            cf_hostname_id: appState.cf_hostname_id,
            status: appState.status,
            ssl_status: appState.ssl_status,
            error: appState.error,
            updated_at: appState.updated_at,
            dns_checks: dnsChecks,
          });
        }

        const configuredApps = apps.filter((app) => app.hostname);
        const activeCount = configuredApps.filter(a => a.status === 'active' && a.ssl_status === 'active').length;
        const parts: string[] = [];
        if (configuredApps.length === 0) {
          parts.push('No exact custom domains configured.');
        } else {
          parts.push(`${activeCount}/${configuredApps.length} configured custom domains have active SSL.`);
        }
        if (apps.length === 0) {
          parts.push('No apps deployed yet.');
        }

        return this.textResponse({
          configured: configuredApps.length > 0,
          dns_target: dnsTarget,
          apps,
          message: parts.join(' '),
        });
      }
    );

    // Set exact app custom domain
    this.server.tool(
      'set_custom_domain',
      'Set one exact custom hostname for one deployed app (admin only). The user chooses the hostname; camelAI provides the DNS target. Wildcards are not supported.',
      {
        app_name: z.string().min(1).describe('The deployed app name.'),
        hostname: z.string().min(3).describe('The exact hostname the user wants to use, e.g. "example.com" or "app.example.com".'),
      },
      async ({ app_name: appName, hostname: rawHostname }) => {
        const { userId } = this.requireAuth();
        const orgStub = this.getOrgStub();

        const member = await orgStub.getMember(userId);
        if (!member || (member.role !== 'owner' && member.role !== 'admin')) {
          return this.textResponse({ success: false, error: 'Only org admins can manage custom domains' });
        }

        const hostname = rawHostname.trim().toLowerCase().replace(/\.$/, '');
        const script = await orgStub.getWorkerScript(appName);
        if (!script) {
          return this.textResponse({ success: false, error: 'App not found' });
        }
        const scripts = await orgStub.listWorkerScripts();
        const conflictingScript = scripts.find(
          (candidate) =>
            candidate.script_name !== appName &&
            candidate.custom_domain_hostname === hostname
        );
        if (conflictingScript) {
          return this.textResponse({
            success: false,
            error: `That hostname is already assigned to ${conflictingScript.script_name}`,
          });
        }

        if (
          hostname.includes('*') ||
          !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(hostname)
        ) {
          return this.textResponse({ success: false, error: 'Invalid exact hostname. Wildcards are not supported.' });
        }
        if (hostname.endsWith('.camelai.app') || hostname.endsWith('.camelai.dev')) {
          return this.textResponse({ success: false, error: 'Cannot use camelAI domains as custom domains' });
        }

        const zoneId = this.env.CF_ZONE_ID?.trim();
        const apiToken = this.env.CF_API_TOKEN?.trim();
        if (!zoneId || !apiToken) {
          return this.textResponse({ success: false, error: 'Cloudflare API not configured' });
        }
        const dnsTarget = getCustomHostnameDnsTarget({
          cnameTarget: this.env.CF_CUSTOM_HOSTNAME_CNAME_TARGET,
          fallbackOrigin: this.env.CF_CUSTOM_HOSTNAME_FALLBACK,
        });

        try {
          const record = await createOrRefreshCustomHostname(zoneId, apiToken, hostname);
          if (!record) {
            await orgStub.updateWorkerScriptCustomDomain(appName, {
              hostname,
              error: 'Failed to create or locate Cloudflare custom hostname',
            });
            return this.textResponse({ success: false, error: 'Failed to create or locate Cloudflare custom hostname' });
          }

          if (script.custom_domain_cf_hostname_id && script.custom_domain_cf_hostname_id !== record.id) {
            await deleteCustomHostname(zoneId, apiToken, script.custom_domain_cf_hostname_id).catch(() => {});
          }

          await orgStub.updateWorkerScriptCustomDomain(appName, {
            hostname,
            cf_hostname_id: record.id,
            status: record.status,
            ssl_status: record.ssl.status,
            error: null,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await orgStub.updateWorkerScriptCustomDomain(appName, {
            hostname,
            error: message,
          });
          return this.textResponse({ success: false, error: message });
        }

        return this.textResponse({
          success: true,
          app: appName,
          hostname,
          dns_target: dnsTarget,
          routing_record: `${hostname} CNAME ${dnsTarget}`,
          message: `Custom hostname set for ${appName}. Add ${hostname} CNAME ${dnsTarget}.`,
        });
      }
    );

    // Remove exact app custom domain
    this.server.tool(
      'remove_custom_domain',
      'Remove the exact custom domain from one app (admin only).',
      {
        app_name: z.string().min(1).describe('The deployed app name.'),
      },
      async ({ app_name: appName }) => {
        const { userId } = this.requireAuth();
        const orgStub = this.getOrgStub();

        const member = await orgStub.getMember(userId);
        if (!member || (member.role !== 'owner' && member.role !== 'admin')) {
          return this.textResponse({ success: false, error: 'Only org admins can manage custom domains' });
        }

        const script = await orgStub.getWorkerScript(appName);
        if (!script?.custom_domain_hostname) {
          return this.textResponse({ success: false, error: 'No custom domain configured for this app' });
        }

        const removedDomain = script.custom_domain_hostname;
        const zoneId = this.env.CF_ZONE_ID?.trim();
        const apiToken = this.env.CF_API_TOKEN?.trim();
        if (zoneId && apiToken && script.custom_domain_cf_hostname_id) {
          await deleteCustomHostname(zoneId, apiToken, script.custom_domain_cf_hostname_id).catch(() => {});
        }
        await orgStub.clearWorkerScriptCustomDomain(appName);

        return this.textResponse({
          success: true,
          app: appName,
          removed_domain: removedDomain,
          message: `Custom domain ${removedDomain} removed from ${appName}.`,
        });
      }
    );

    // Retry custom domain hostname provisioning for configured exact app domains
    this.server.tool(
      'retry_custom_domain_hostnames',
      'Retry Cloudflare hostname provisioning for apps with configured exact custom domains whose SSL or hostname setup is not active.',
      {},
      async () => {
        const { userId } = this.requireAuth();
        const orgStub = this.getOrgStub();

        const member = await orgStub.getMember(userId);
        if (!member || (member.role !== 'owner' && member.role !== 'admin')) {
          return this.textResponse({ success: false, error: 'Only org admins can retry hostname provisioning' });
        }

        const zoneId = this.env.CF_ZONE_ID?.trim();
        const apiToken = this.env.CF_API_TOKEN?.trim();
        if (!zoneId || !apiToken) {
          return this.textResponse({ success: false, error: 'Cloudflare API not configured' });
        }

        const scripts = await orgStub.listWorkerScripts();
        const scriptsToSync = scripts.filter((script) =>
          shouldRetryAppCustomDomainProvisioning(script, null)
        );
        let retried = scriptsToSync.length;
        let succeeded = 0;
        const errors: Array<{ app: string; error: string }> = [];

        for (const script of scriptsToSync) {
          if (!script.custom_domain_hostname) continue;
            try {
              const result = await createOrRefreshCustomHostname(zoneId, apiToken, script.custom_domain_hostname);
              if (result) {
                await orgStub.updateWorkerScriptCustomDomain(script.script_name, {
                  hostname: script.custom_domain_hostname,
                  cf_hostname_id: result.id,
                  status: result.status,
                  ssl_status: result.ssl.status,
                  error: null,
                });
                succeeded++;
              } else {
                const msg = 'Failed to create or locate Cloudflare hostname';
                await orgStub.updateWorkerScriptCustomDomain(script.script_name, {
                  hostname: script.custom_domain_hostname,
                  cf_hostname_id: null,
                  status: null,
                  ssl_status: null,
                  error: msg,
                });
                if (errors.length === 0) {
                  errors.push({ app: script.script_name, error: msg });
                }
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              await orgStub.updateWorkerScriptCustomDomain(script.script_name, {
                hostname: script.custom_domain_hostname,
                error: msg,
              });
              errors.push({ app: script.script_name, error: msg });
            }
        }

        return this.textResponse({
          success: true,
          retried,
          succeeded,
          errors: errors.length > 0 ? errors : undefined,
          message: retried === 0
            ? 'No apps need hostname retry — all are either active or still provisioning normally.'
            : `Retried ${retried} app(s): ${succeeded} succeeded${errors.length > 0 ? `, ${errors.length} failed` : ''}. Run get_custom_domain to check updated status.`,
        });
      }
    );

  }
}

/**
 * Resolve a CNAME record via Cloudflare DNS-over-HTTPS.
 * Returns a structured result so callers can distinguish missing records
 * from diagnostic failures like DoH outages or rate limits.
 */
async function resolveCnameViaDoH(hostname: string): Promise<CnameLookupResult> {
  const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=CNAME`;
  try {
    const resp = await fetch(url, {
      headers: { Accept: 'application/dns-json' },
    });
    if (!resp.ok) {
      return {
        status: 'unavailable',
        error: `DoH query failed with HTTP ${resp.status}`,
        http_status: resp.status,
      };
    }
    const data = await resp.json() as {
      Status?: number;
      Answer?: Array<{ type: number; data: string }>;
    };
    // DNS Status: 0 = NOERROR, 3 = NXDOMAIN (both mean "record doesn't exist" when no CNAME answer).
    // Anything else (2 = SERVFAIL, 5 = REFUSED, etc.) is a resolver failure.
    const dnsStatus = data.Status ?? 0;
    // CNAME is DNS type 5
    const cname = data.Answer?.find(a => a.type === 5);
    if (!cname) {
      if (dnsStatus !== 0 && dnsStatus !== 3) {
        return {
          status: 'unavailable',
          error: `DNS resolver returned status ${dnsStatus}`,
          http_status: null,
        };
      }
      return { status: 'missing' };
    }
    // Remove trailing dot from DNS response
    return { status: 'resolved', target: cname.data.replace(/\.$/, '') };
  } catch (error) {
    return {
      status: 'unavailable',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Handle MCP requests
 */
export async function handleMcpRequest(
  request: Request,
  env: McpEnv,
  ctx: ExecutionContext
): Promise<Response> {
  const url = new URL(request.url);

  // Health check endpoint
  if (url.pathname === '/mcp/health') {
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'content-type': 'application/json' },
    });
  }

  const t0 = performance.now();

  // Authenticate via sandbox host proxy
  const proxyAuth = validateSandboxProxy(request, env);
  if (!proxyAuth.valid) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }

  // Resolve auth from the currently active turn author rather than the
  // sandbox-host proxy session, which is connection-scoped in multi-user chats.
  let activeTurnUserId: string | null = null;
  if (proxyAuth.threadId) {
    try {
      const chatThreadStub = env.CHAT_THREAD.get(
        env.CHAT_THREAD.idFromName(proxyAuth.threadId)
      ) as DurableObjectStub<ChatThreadDO>;
      const resolvedUserId = await chatThreadStub.getActiveTurnUserId();
      if (typeof resolvedUserId === 'string' && resolvedUserId.trim()) {
        activeTurnUserId = resolvedUserId.trim();
      }
    } catch (error) {
      console.warn('[MCP] Failed to resolve active turn user', {
        threadId: proxyAuth.threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const headers = new Headers(request.headers);
  headers.set(AUTH_HEADER_ORG_ID, proxyAuth.orgId);
  headers.set(AUTH_HEADER_USER_ID, activeTurnUserId ?? 'system');
  headers.set(AUTH_HEADER_WORKSPACE_ID, proxyAuth.workspaceId);
  const threadId = proxyAuth.threadId ?? request.headers.get('x-chiridion-thread-id');
  if (threadId) headers.set(AUTH_HEADER_THREAD_ID, threadId);

  const authenticatedRequest = new Request(request.url, {
    method: request.method,
    headers,
    body: request.body,
    // @ts-expect-error - duplex is required for streaming bodies
    duplex: 'half',
  });
  const response = await ChiridionMcp.serve('/mcp').fetch(authenticatedRequest, env, ctx);
  console.log(`[MCP] ${request.method} ${url.pathname} → ${response.status} in ${(performance.now() - t0).toFixed(0)}ms`);
  return response;
}
