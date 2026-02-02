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
import type { ChatThreadDO, ConnectionSetupRequest, ConnectionSetupResponse, DynamicIntegrationSchema, DynamicField } from './durable-objects';
import type { WorkspaceContainer, WorkspaceContainerEnv } from './workspace-container';
import { getWorkspaceContainer } from './workspace-container';
import type { Integration } from '../../../src/types';
import { getAllIntegrations, getIntegrationsByCategory, getIntegrationDefinition, validateConfig, validateCredentials } from '../../../src/lib/integration-registry';
import { encryptCredentials } from '../../../src/lib/integration-crypto';
import { normalizeEnvVarName, getEnvVarSuffixesForType } from './integration-env';
import { isSignedToken, validateSignedToken } from './signed-tokens';

export interface McpEnv extends WorkspaceContainerEnv {
  CHAT_THREAD: DurableObjectNamespace<ChatThreadDO>;
  MCP_OBJECT: DurableObjectNamespace<ChiridionMcp>;
  APP_KV: KVNamespace;
}

type AuthContext = {
  tokenId: string;
  token: ApiTokenData;
  workspaceId: string | null;
  threadId: string | null;
};

type AuthResult =
  | { ok: true; auth: AuthContext }
  | { ok: false; error: string };

// Headers used to pass auth context to the MCP DO
const AUTH_HEADER_ORG_ID = 'x-chiridion-org-id';
const AUTH_HEADER_USER_ID = 'x-chiridion-user-id';
const AUTH_HEADER_WORKSPACE_ID = 'x-chiridion-workspace-id';
const AUTH_HEADER_THREAD_ID = 'x-chiridion-thread-id';

// Pending connection setup request with resolver
interface PendingConnectionSetup {
  resolve: (response: ConnectionSetupResponse) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
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
  private userId: string | null = null;
  private workspaceId: string | null = null;
  private threadId: string | null = null;

  // Pending connection setup promises (requestId -> resolver)
  private pendingConnectionSetups: Map<string, PendingConnectionSetup> = new Map();

  /**
   * Override fetch to extract auth context from headers before processing
   */
  async fetch(request: Request): Promise<Response> {
    // Extract auth context from headers (set by handleMcpRequest)
    this.orgId = request.headers.get(AUTH_HEADER_ORG_ID);
    this.userId = request.headers.get(AUTH_HEADER_USER_ID);
    this.workspaceId = request.headers.get(AUTH_HEADER_WORKSPACE_ID);
    this.threadId = request.headers.get(AUTH_HEADER_THREAD_ID);

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
        const data = await this.env.APP_KV.get(`script_org:${script_name}`);

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
            enabled: Boolean(r.enabled),
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
        if (enabled_only) {
          filtered = filtered.filter((i) => i.enabled);
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
            enabled: i.enabled,
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
        const { userId, workspaceId } = this.requireAuth();
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

          // Push updated env vars to running container (fire-and-forget)
          getWorkspaceContainer(this.env, workspaceId)
            .refreshIntegrationEnvVars(workspaceId)
            .catch(() => {});

          const envVarPrefix = `INT_${normalizeEnvVarName(integration_type)}_${normalizeEnvVarName(name)}`;
          const envVarSuffixes = getEnvVarSuffixesForType(integration_type);
          return this.textResponse({
            success: true,
            integration: {
              id: integrationId,
              type: integration_type,
              name,
              category: definition.category,
              enabled: true,
              env_var_prefix: envVarPrefix,
              env_vars: envVarSuffixes.map(suffix => `${envVarPrefix}_${suffix}`),
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
        const { userId, workspaceId } = this.requireAuth();
        if (!workspaceId) {
          return this.textResponse({ error: 'No workspace context available' });
        }

        // Thread ID comes from the signed token (can't be spoofed)
        const threadId = this.threadId;
        if (!threadId) {
          return this.textResponse({
            success: false,
            error: 'No thread context available. This tool requires a per-thread MCP token.',
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
            const envVarPrefix = `INT_${normalizeEnvVarName(type)}_${normalizeEnvVarName(name)}`;
            const envVarSuffixes = getEnvVarSuffixesForType(type);
            return this.textResponse({
              success: true,
              integration: {
                id: integrationId,
                type,
                name,
                category: intDefinition.category,
                enabled: true,
                env_var_prefix: envVarPrefix,
                env_vars: envVarSuffixes.map(suffix => `${envVarPrefix}_${suffix}`),
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

          // Push updated env vars to running container (fire-and-forget)
          getWorkspaceContainer(this.env, workspaceId)
            .refreshIntegrationEnvVars(workspaceId)
            .catch(() => {});

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
              enabled: true,
              env_var_prefix: envVarPrefix,
              env_vars: envVarSuffixes.map(suffix => `${envVarPrefix}_${suffix}`),
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
  return {
    ok: true,
    auth: {
      tokenId: apiKey,
      token,
      workspaceId: payload.workspace_id ?? null,
      threadId: payload.thread_id ?? null,
    },
  };
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

  // Create a new request with auth context headers (from validated token)
  const { token, workspaceId, threadId } = authResult.auth;
  const headers = new Headers(request.headers);
  headers.set(AUTH_HEADER_ORG_ID, token.org_id);
  headers.set(AUTH_HEADER_USER_ID, token.user_id);
  if (workspaceId) {
    headers.set(AUTH_HEADER_WORKSPACE_ID, workspaceId);
  }
  if (threadId) {
    headers.set(AUTH_HEADER_THREAD_ID, threadId);
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
