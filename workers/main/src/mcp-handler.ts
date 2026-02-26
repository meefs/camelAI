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
import { WorkspaceContainer, type WorkspaceContainerEnv } from './workspace-container';
import { getAllIntegrations, getIntegrationsByCategory, getIntegrationDefinition, validateConfig, validateCredentials } from '../../../src/lib/integration-registry';
import { encryptCredentials } from '../../../src/lib/integration-crypto';
import { normalizeEnvVarName, getEnvVarSuffixesForType } from './integration-env';
import { validateSandboxProxy } from './sandbox-auth';
import { getEnvPrefix, syncAllWorkspaceWorkerSecrets, type CfApiProxyEnv } from './cf-api-proxy';
import { captureScreenshotRaw } from './screenshot-queue';
import { createScreenshotToken } from './worker-auth';
import type { WorkerLogsDO } from './worker-logs-do';

export interface McpEnv extends WorkspaceContainerEnv {
  CHAT_THREAD: DurableObjectNamespace<ChatThreadDO>;
  MCP_OBJECT: DurableObjectNamespace<ChiridionMcp>;
  WORKER_LOGS: DurableObjectNamespace<WorkerLogsDO>;
  APP_KV: KVNamespace;
  BROWSER?: Fetcher;
  SANDBOX_PROXY_SECRET?: string;
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

  // Auth context extracted from request headers (set per-connection)
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

  /**
   * Get the full URL for a deployed app.
   * Uses flat format: {script}--{org-slug}.domain to avoid nested subdomain issues.
   */
  private async getAppUrl(scriptName: string): Promise<string> {
    const orgSlug = await this.getOrgSlug();
    if (orgSlug) {
      return `https://${scriptName}--${orgSlug}.${this.getVanityDomain()}`;
    }
    // Fallback to legacy format if no org slug
    return `https://${scriptName}.${this.getVanityDomain()}`;
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
          url: await this.getAppUrl(s.script_name),
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
            url: await this.getAppUrl(result.script_name),
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
            url: await this.getAppUrl(script.script_name),
            is_public: script.is_public,
          },
          message: `Preview set to app '${script.script_name}'`,
        });
      }
    );

    // Take a screenshot of a deployed app
    this.server.tool(
      'take_app_screenshot',
      'Take a screenshot of a deployed app and return the image. Useful for verifying the app looks correct after making changes.',
      {
        script_name: z.string().describe('The name of the app/worker script to screenshot'),
      },
      async ({ script_name }) => {
        const { orgId, workspaceId } = this.requireAuth();
        if (!workspaceId) {
          return this.textResponse({ error: 'No workspace context available' });
        }

        const orgStub = this.getOrgStub();

        // Verify script exists and belongs to current workspace
        const script: WorkerScript | null = await orgStub.getWorkerScript(script_name);
        if (!script) {
          return this.textResponse({ success: false, error: `App '${script_name}' not found` });
        }
        if (script.workspace_id !== workspaceId) {
          return this.textResponse({ success: false, error: `App '${script_name}' belongs to a different workspace` });
        }

        // Check for BROWSER binding
        if (!this.env.BROWSER) {
          return this.textResponse({
            success: false,
            error: 'Screenshot capture is not available (missing browser binding)',
          });
        }

        // Get env prefix for building screenshot URL
        const envPrefix = (() => {
          if (!this.env.WORKER_BASE_URL) return '';
          const hostname = new URL(this.env.WORKER_BASE_URL).hostname;
          const prefix = getEnvPrefix(hostname);
          if (prefix) return prefix;
          // WORKER_BASE_URL set but not a camelai.dev hostname (e.g. ngrok) → local dev
          if (hostname !== 'camelai.dev' && !hostname.endsWith('.camelai.dev')) return 'local';
          return '';
        })();

        // Create screenshot token for private apps
        let screenshotToken: string | undefined;
        if (!script.is_public && envPrefix !== 'local') {
          screenshotToken = await createScreenshotToken(this.env.APP_KV, {
            script_name,
            org_id: orgId,
          });
        }

        // Get org slug for URL construction (optional - falls back to legacy URL format)
        const orgSlug = await this.getOrgSlug();

        // Capture screenshot and return image directly
        const result = await captureScreenshotRaw(this.env.BROWSER, {
          scriptName: script_name,
          orgId,
          orgSlug: orgSlug ?? undefined,
          envPrefix,
          isPublic: script.is_public,
          screenshotToken,
          timeoutMs: 10_000,
        });

        if (result.success) {
          // Return image as base64 in MCP image content format
          const base64Image = result.image.toString('base64');
          return {
            content: [
              {
                type: 'image' as const,
                data: base64Image,
                mimeType: 'image/jpeg',
              },
            ],
          };
        } else {
          return this.textResponse({
            success: false,
            error: result.error || 'Failed to capture screenshot',
          });
        }
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
      'Prompt the user to set up a new integration/connection through a UI modal in the chat interface. This allows the user to securely enter credentials without exposing them in the chat. The tool will wait for the user to complete the setup and return the result. For custom integrations, use integration_type="other" with the fields parameter to define custom credential fields.',
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

  const headers = new Headers(request.headers);
  headers.set(AUTH_HEADER_ORG_ID, proxyAuth.orgId);
  headers.set(AUTH_HEADER_USER_ID, 'system');
  headers.set(AUTH_HEADER_WORKSPACE_ID, proxyAuth.workspaceId);
  const threadId = request.headers.get('x-chiridion-thread-id');
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
