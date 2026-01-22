/**
 * MCP Server Handler
 *
 * Handles MCP protocol requests with API key authentication.
 * Uses the agents package with streamable HTTP transport.
 */

import { McpAgent } from 'agents/mcp';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiTokenData } from './api-tokens';
import type { OrgDO, WorkerScript } from './auth';
import type { WorkspaceDO } from './workspace';
import type { Integration } from '../../../src/types';
import { getAllIntegrations, getIntegrationsByCategory } from '../../../src/lib/integration-registry';
import { isSignedToken, validateSignedToken } from './signed-tokens';

export interface McpEnv {
  ORG: DurableObjectNamespace<OrgDO>;
  WORKSPACE: DurableObjectNamespace<WorkspaceDO>;
  MCP_OBJECT: DurableObjectNamespace<ChiridionMcp>;
  API_TOKENS: KVNamespace;
  TOKEN_SIGNING_SECRET: string;
}

type AuthContext = {
  tokenId: string;
  token: ApiTokenData;
  workspaceId: string | null;
};

type AuthResult =
  | { ok: true; auth: AuthContext }
  | { ok: false; error: string };

// Headers used to pass auth context to the MCP DO
const AUTH_HEADER_ORG_ID = 'x-chiridion-org-id';
const AUTH_HEADER_USER_ID = 'x-chiridion-user-id';
const AUTH_HEADER_WORKSPACE_ID = 'x-chiridion-workspace-id';

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
  private userId: string | null = null;
  private workspaceId: string | null = null;

  /**
   * Override fetch to extract auth context from headers before processing
   */
  async fetch(request: Request): Promise<Response> {
    // Extract auth context from headers (set by handleMcpRequest)
    this.orgId = request.headers.get(AUTH_HEADER_ORG_ID);
    this.userId = request.headers.get(AUTH_HEADER_USER_ID);
    this.workspaceId = request.headers.get(AUTH_HEADER_WORKSPACE_ID);

    // Call parent fetch to handle MCP protocol
    return super.fetch(request);
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

  async init() {
    // ==========================================
    // Deployment Management Tools
    // ==========================================

    // List deployed apps/workers
    this.server.tool(
      'list_apps',
      'List deployed apps/workers for the current workspace. Returns script names, visibility status, and creation info.',
      {},
      async () => {
        const { workspaceId } = this.requireAuth();
        if (!workspaceId) {
          return this.textResponse({ error: 'No workspace context available' });
        }

        const orgStub = this.getOrgStub();
        const scripts: WorkerScript[] = await orgStub.listWorkerScriptsByWorkspace(workspaceId);

        const apps = scripts.map((s: WorkerScript) => ({
          name: s.script_name,
          is_public: s.is_public,
          created_by: s.created_by,
          created_at: new Date(s.created_at).toISOString(),
          updated_at: new Date(s.updated_at).toISOString(),
          preview_status: s.preview_status,
        }));

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
            is_public: result.is_public,
            updated_at: new Date(result.updated_at).toISOString(),
          },
          message: `App '${script_name}' is now ${is_public ? 'public' : 'private'}`,
        });
      }
    );

    // Check if an app name is available
    this.server.tool(
      'check_app_name_available',
      'Check if a worker/app script name is available or already taken. Script names must be globally unique.',
      {
        script_name: z.string().describe('The script name to check availability for'),
      },
      async ({ script_name }) => {
        // Use KV lookup for fast check (no auth context needed for availability check)
        const data = await this.env.API_TOKENS.get(`script_org:${script_name}`);

        if (data) {
          const { org_id } = JSON.parse(data) as { org_id: string; is_public: boolean };
          const isOwnOrg = org_id === this.orgId;

          return this.textResponse({
            available: false,
            script_name,
            owned_by_current_org: isOwnOrg,
            message: isOwnOrg
              ? `Script name '${script_name}' is already used by your organization`
              : `Script name '${script_name}' is already taken by another organization`,
          });
        }

        return this.textResponse({
          available: true,
          script_name,
          message: `Script name '${script_name}' is available`,
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
        enabled_only: z
          .boolean()
          .optional()
          .default(false)
          .describe('If true, only return enabled integrations'),
      },
      async ({ category, enabled_only }) => {
        const { workspaceId } = this.requireAuth();
        if (!workspaceId) {
          return this.textResponse({ error: 'No workspace context available' });
        }

        const workspaceStub = this.getWorkspaceStub(workspaceId);
        const rawIntegrations = await workspaceStub.getIntegrations();

        // Map from DO format to Integration type
        const integrations = rawIntegrations.map(r => ({
          id: r.id,
          integration_type: r.integration_type,
          name: r.name,
          category: r.category,
          auth_method: r.auth_method,
          enabled: Boolean(r.enabled),
          has_credentials: Boolean(r.credentials_encrypted),
          created_at: r.created_at,
          updated_at: r.updated_at,
        }));

        let filtered = integrations;
        if (category) {
          filtered = filtered.filter((i) => i.category === category);
        }
        if (enabled_only) {
          filtered = filtered.filter((i) => i.enabled);
        }

        const result = filtered.map((i) => ({
          id: i.id,
          type: i.integration_type,
          name: i.name,
          category: i.category,
          auth_method: i.auth_method,
          enabled: i.enabled,
          has_credentials: i.has_credentials,
          created_at: new Date(i.created_at).toISOString(),
          updated_at: new Date(i.updated_at).toISOString(),
        }));

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
          supports_proxy: !!def.proxyConfig,
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

  }
}

/**
 * Extract API key from Authorization header (Bearer token) or x-api-key header
 */
function extractApiKey(request: Request): string | null {
  const auth = request.headers.get('authorization');
  if (auth) {
    const [scheme, token] = auth.split(' ');
    if (scheme?.toLowerCase() === 'bearer' && token) {
      return token.trim();
    }
  }
  return request.headers.get('x-api-key')?.trim() || null;
}

/**
 * Validate API key and return auth context
 * Only accepts signed tokens (no KV lookup)
 */
async function authorizeRequest(
  apiKey: string | null,
  env: McpEnv
): Promise<AuthResult> {
  if (!apiKey) {
    return { ok: false, error: 'Missing API key' };
  }

  if (!env.TOKEN_SIGNING_SECRET) {
    return { ok: false, error: 'Token signing not configured' };
  }

  if (!isSignedToken(apiKey)) {
    return { ok: false, error: 'Invalid API key format' };
  }

  const payload = await validateSignedToken(env.TOKEN_SIGNING_SECRET, apiKey);
  if (!payload) {
    return { ok: false, error: 'Invalid API key' };
  }

  if (!hasMcpScope(payload.scopes)) {
    return { ok: false, error: 'API key lacks MCP scope' };
  }

  // Convert SignedTokenPayload to ApiTokenData format for compatibility
  const token: ApiTokenData = {
    org_id: payload.org_id,
    user_id: payload.user_id,
    integration_id: null,
    name: payload.name || 'signed-token',
    scopes: payload.scopes,
    created_at: payload.iat,
    expires_at: payload.exp,
  };
  return { ok: true, auth: { tokenId: apiKey, token, workspaceId: payload.workspace_id ?? null } };
}

/**
 * Check if token has MCP scope
 */
function hasMcpScope(scopes: string[] | undefined): boolean {
  if (!scopes || scopes.length === 0) return false;
  const normalized = scopes.map((s) => s.toLowerCase());
  return normalized.some(
    (scope) =>
      scope === 'mcp' ||
      scope.startsWith('mcp:') ||
      scope === '*' ||
      scope === 'all' ||
      scope === 'admin'
  );
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

  // Authenticate the request
  const apiKey = extractApiKey(request);
  const authResult = await authorizeRequest(apiKey, env);

  if (!authResult.ok) {
    return new Response(JSON.stringify({ error: authResult.error }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }

  // Create a new request with auth context headers
  const { token, workspaceId } = authResult.auth;
  const headers = new Headers(request.headers);
  headers.set(AUTH_HEADER_ORG_ID, token.org_id);
  headers.set(AUTH_HEADER_USER_ID, token.user_id);
  if (workspaceId) {
    headers.set(AUTH_HEADER_WORKSPACE_ID, workspaceId);
  }

  const authenticatedRequest = new Request(request.url, {
    method: request.method,
    headers,
    body: request.body,
    // @ts-expect-error - duplex is required for streaming bodies
    duplex: 'half',
  });

  // Delegate to MCP handler with auth context in headers
  return ChiridionMcp.serve('/mcp').fetch(authenticatedRequest, env, ctx);
}
