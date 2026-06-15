/**
 * Workspace integrations MCP registry endpoint.
 *
 * This endpoint is intentionally stateless and scoped by sandbox-host proxy
 * headers. It lets tools inside the sandbox discover connected integrations,
 * native upstream MCP servers, and camelAI fallback capabilities without
 * exposing raw integration credentials to the sandbox.
 */

import type { RouteContext } from '../types.js';
import { validateSandboxProxy } from '../sandbox-auth.js';
import { decryptCredentials } from '../../../../src/lib/integration-crypto';
import { getAllIntegrations, getIntegrationDefinition } from '../../../../src/lib/integration-registry';
import {
  PROVIDER_MCP_REGISTRY,
  type ProviderMcpAuthStrategy,
  type ProviderMcpDefinition,
  type ProviderMcpTransport,
} from '../../../../src/lib/provider-mcp-registry';
import { validateRemoteMcpUrl } from '../../../../src/lib/remote-mcp';
import {
  airtableMcpRpc,
  isAirtableMcpIntegration,
} from '../airtable-mcp.js';
import {
  bigQueryMcpRpc,
  isBigQueryMcpIntegration,
} from '../bigquery-mcp.js';
import {
  clickHouseMcpRpc,
  isClickHouseMcpIntegration,
} from '../clickhouse-mcp.js';
import {
  isSentryMcpIntegration,
  sentryMcpRpc,
} from '../sentry-mcp.js';
import {
  isMailchimpMcpIntegration,
  mailchimpMcpRpc,
} from '../mailchimp-mcp.js';
import {
  isSendGridMcpIntegration,
  sendGridMcpRpc,
} from '../sendgrid-mcp.js';
import {
  isTwilioMcpIntegration,
  twilioMcpRpc,
} from '../twilio-mcp.js';
import {
  isPostHogMcpIntegration,
  postHogMcpRpc,
} from '../posthog-mcp.js';
import {
  isMixpanelMcpIntegration,
  mixpanelMcpRpc,
} from '../mixpanel-mcp.js';
import {
  amplitudeMcpRpc,
  isAmplitudeMcpIntegration,
} from '../amplitude-mcp.js';
import {
  isZendeskMcpIntegration,
  zendeskMcpRpc,
} from '../zendesk-mcp.js';
import {
  isSqlDatabaseMcpIntegration,
  sqlDatabaseMcpRpc,
} from '../sql-database-mcp.js';
import {
  databricksMcpRpc,
  isDatabricksMcpIntegration,
} from '../databricks-mcp.js';
import {
  isMongoDbMcpIntegration,
  mongoDbMcpRpc,
} from '../mongodb-mcp.js';
import {
  isRedisMcpIntegration,
  redisMcpRpc,
} from '../redis-mcp.js';
import {
  isSnowflakeMcpIntegration,
  snowflakeMcpRpc,
} from '../snowflake-mcp.js';
import {
  isTursoMcpIntegration,
  tursoMcpRpc,
} from '../turso-mcp.js';
import {
  isShopifyMcpIntegration,
  shopifyMcpRpc,
} from '../shopify-mcp.js';
import {
  isSegmentMcpIntegration,
  segmentMcpRpc,
} from '../segment-mcp.js';
import {
  isTeamsMcpIntegration,
  teamsMcpRpc,
} from '../teams-mcp.js';
import type {
  WorkspaceIntegrationAuthStatus,
  WorkspaceIntegrationRecord,
} from '../workspace.js';
import type { OrgDO } from '../auth.js';

type JsonValue =
  | null
  | string
  | number
  | boolean
  | JsonValue[]
  | { [key: string]: JsonValue };

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

interface ToolCallParams {
  name?: string;
  arguments?: unknown;
}

interface IntegrationToolArgs {
  category?: string;
  integration?: string;
}

type IntegrationMcpAuthStrategy = ProviderMcpAuthStrategy | 'remote_mcp_config';

interface NativeMcpDefinition {
  server_name: string;
  url: string;
  transport: ProviderMcpTransport;
  auth_strategy: IntegrationMcpAuthStrategy;
  direct_connect: boolean;
  brokered: boolean;
  preferred_mode?: 'direct' | 'brokered';
  direct?: {
    server_name: string;
    url: string;
    transport: ProviderMcpTransport;
    auth_strategy: 'first_party_oauth_direct';
    docs_url?: string;
    notes?: string;
  };
  broker?: {
    server_name: string;
    url: string;
    transport: ProviderMcpTransport;
    auth_strategy: 'camelai_hosted_broker' | 'connected_credentials_broker' | 'remote_mcp_config';
    docs_url?: string;
    notes?: string;
  };
  docs_url?: string;
  notes?: string;
}

function nativeMcpDefinition(definition: ProviderMcpDefinition): NativeMcpDefinition {
  return {
    server_name: definition.serverName,
    url: definition.url,
    transport: definition.transport,
    auth_strategy: definition.authStrategy === 'first_party_oauth_direct'
      ? 'connected_credentials_broker'
      : definition.authStrategy,
    direct_connect: false,
    brokered: true,
    preferred_mode: 'brokered',
    broker: {
      server_name: definition.broker?.serverName ?? definition.serverName,
      url: definition.broker?.url ?? definition.url,
      transport: definition.broker?.transport ?? definition.transport,
      auth_strategy: definition.broker?.authStrategy ?? (
        definition.authStrategy === 'first_party_oauth_direct'
          ? 'connected_credentials_broker'
          : definition.authStrategy
      ),
      docs_url: definition.broker?.docsUrl ?? definition.docsUrl,
      notes: definition.broker?.notes,
    },
    docs_url: definition.docsUrl,
    notes: definition.notes,
  };
}

const NATIVE_MCP_SERVERS: Record<string, NativeMcpDefinition> = Object.fromEntries(
  Object.entries(PROVIDER_MCP_REGISTRY).map(([key, definition]) => [
    key,
    nativeMcpDefinition(definition),
  ])
);

const TOOL_LIST = [
  {
    name: 'list_connected_integrations',
    description: 'List integrations connected to the current workspace, including native MCP availability. Does not return credential values.',
    inputSchema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: ['databases', 'saas', 'ai_services', 'cloud_providers', 'communication'],
          description: 'Optional category filter.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_connected_integration',
    description: 'Get metadata, native MCP connection metadata, and fallback capabilities for one connected integration. Does not return credential values.',
    inputSchema: {
      type: 'object',
      properties: {
        integration: {
          type: 'string',
          description: 'Integration id, name, or type.',
        },
      },
      required: ['integration'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_mcp_servers',
    description: 'List native MCP servers available for the current workspace integrations.',
    inputSchema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: ['databases', 'saas', 'ai_services', 'cloud_providers', 'communication'],
          description: 'Optional integration category filter.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_mcp_server',
    description: 'Get native MCP connection metadata for a connected integration.',
    inputSchema: {
      type: 'object',
      properties: {
        integration: {
          type: 'string',
          description: 'Integration id, name, or type.',
        },
      },
      required: ['integration'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_available_integration_types',
    description: 'List integration types supported by camelAI and whether camelAI knows about a native MCP server for each type.',
    inputSchema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: ['databases', 'saas', 'ai_services', 'cloud_providers', 'communication'],
          description: 'Optional category filter.',
        },
      },
      additionalProperties: false,
    },
  },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function jsonRpcResult(id: JsonRpcRequest['id'], result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function jsonRpcError(
  id: JsonRpcRequest['id'],
  code: number,
  message: string,
  data?: unknown
): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: data === undefined ? { code, message } : { code, message, data },
  };
}

function jsonRpcErrorsForPayload(
  payload: JsonRpcRequest | JsonRpcRequest[],
  code: number,
  message: string,
  data?: unknown
): Record<string, unknown> | Record<string, unknown>[] {
  if (Array.isArray(payload)) {
    return payload.map((item) => jsonRpcError(item.id, code, message, data));
  }
  return jsonRpcError(payload.id, code, message, data);
}

function textToolResult(value: unknown): Record<string, unknown> {
  return {
    content: [
      {
        type: 'text',
        text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function timestamp(value: number | null | undefined): string | null {
  return value ? new Date(value).toISOString() : null;
}

function authStatus(record: WorkspaceIntegrationRecord): WorkspaceIntegrationAuthStatus {
  return record.auth_status ?? (record.credentials_encrypted ? 'connected' : 'setup_incomplete');
}

function isRemoteMcpOAuth(record: WorkspaceIntegrationRecord, config = parseJsonObject(record.config)): boolean {
  return record.integration_type === 'remote_mcp' && config.auth_type === 'oauth';
}

function compactIntegrationRef(record: WorkspaceIntegrationRecord): Record<string, string> {
  return {
    id: record.id,
    type: record.integration_type,
    name: record.name,
  };
}

function reauthUrl(record: WorkspaceIntegrationRecord, workspaceId: string): string | null {
  if (record.auth_method === 'oauth2' || isRemoteMcpOAuth(record)) {
    const params = new URLSearchParams({
      workspace_id: workspaceId,
      integration_id: record.id,
      redirect: '/connections',
    });
    return `/api/integrations/${encodeURIComponent(record.integration_type)}/oauth?${params.toString()}`;
  }
  return `/connections?${new URLSearchParams({ connection: record.id, reauth: '1' }).toString()}`;
}

function authErrorData(
  record: WorkspaceIntegrationRecord,
  workspaceId: string,
  status: WorkspaceIntegrationAuthStatus,
  code: string
): Record<string, unknown> {
  return {
    code,
    auth_status: status,
    reauth_url: reauthUrl(record, workspaceId),
    integration: compactIntegrationRef(record),
  };
}

function providerAuthStatus(httpStatus: number): WorkspaceIntegrationAuthStatus | null {
  if (httpStatus === 401) return 'needs_reauth';
  if (httpStatus === 403) return 'missing_scopes';
  return null;
}

function providerSetupStatus(httpStatus: number, message: string): WorkspaceIntegrationAuthStatus | null {
  if (httpStatus !== 400) return null;
  const normalized = message.toLowerCase();
  if (
    normalized.includes('no stored credentials') ||
    normalized.includes('usable access token') ||
    normalized.includes('connection_string is required') ||
    normalized.includes('requires atlas data api url') ||
    normalized.includes('requires rest_url') ||
    normalized.includes('requires rest token') ||
    normalized.includes('workspace_url is required') ||
    normalized.includes('warehouseid is required because the connection has no') ||
    normalized.includes('private_key_fingerprint is required') ||
    normalized.includes('database_url is required') ||
    normalized.includes('shop_domain is required') ||
    normalized.includes('tenant_id is required') ||
    normalized.includes('data_api_url must use https') ||
    normalized.includes('workspace_url must use https') ||
    normalized.includes('data_api_key is required') ||
    normalized.includes('rest_token is required') ||
    normalized.includes('api_key is required') ||
    normalized.includes('auth_token is required') ||
    normalized.includes('account_sid is required') ||
    normalized.includes('client_id is required') ||
    normalized.includes('client_secret is required') ||
    normalized.includes('private_key is required')
  ) {
    return 'setup_incomplete';
  }
  return null;
}

async function markIntegrationAuthStatus(
  orgStub: DurableObjectStub<OrgDO>,
  workspaceId: string,
  record: WorkspaceIntegrationRecord,
  status: WorkspaceIntegrationAuthStatus,
  code: string,
  message: string,
  actorId?: string
): Promise<void> {
  try {
    await orgStub.updateWorkspaceIntegrationAuthStatus(
      workspaceId,
      record.id,
      status,
      code,
      message,
      actorId ?? 'system'
    );
  } catch (error) {
    console.warn('[integrations-mcp] failed to update integration auth status', {
      integrationId: record.id,
      status,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function fallbackCapabilities(integrationType: string, config: Record<string, unknown>): string[] {
  if (integrationType === 'other' && typeof config.base_url === 'string' && config.base_url.trim()) {
    return ['authenticated_fetch'];
  }
  if (integrationType === 'slack') {
    return ['channel_send', 'slack_api'];
  }
  if (integrationType === 'telegram') {
    return ['channel_send'];
  }
  if (integrationType === 'remote_mcp') {
    return [];
  }
  if (!NATIVE_MCP_SERVERS[integrationType]) {
    if (integrationType === 'postgres' || integrationType === 'mysql') {
      return ['query_database'];
    }
    return ['authenticated_fetch'];
  }
  return [
    NATIVE_MCP_SERVERS[integrationType].auth_strategy === 'camelai_hosted_broker'
      ? 'camelai_hosted_mcp'
      : 'first_party_mcp_brokered',
  ];
}

function nativeMcpConnection(record: WorkspaceIntegrationRecord, workspaceId?: string): Record<string, JsonValue> | null {
  const config = parseJsonObject(record.config);
  const definition = nativeMcpDefinitionForRecord(record, config);
  if (!definition) return null;

  return {
    server_name: definition.server_name,
    integration_id: record.id,
    integration_type: record.integration_type,
    integration_name: record.name,
    url: definition.url,
    broker_path: `/mcp/integrations/native/${encodeURIComponent(record.id)}`,
    transport: definition.transport,
    auth_strategy: definition.auth_strategy,
    direct_connect: definition.direct_connect,
    brokered: definition.brokered,
    preferred_mode: definition.preferred_mode ?? null,
    direct: null,
    broker: {
      server_name: definition.broker?.server_name ?? definition.server_name,
      url: definition.broker?.url ?? definition.url,
      broker_path: `/mcp/integrations/native/${encodeURIComponent(record.id)}`,
      transport: definition.broker?.transport ?? definition.transport,
      auth_strategy: definition.broker?.auth_strategy ?? definition.auth_strategy,
      docs_url: definition.broker?.docs_url ?? definition.docs_url ?? null,
      notes: definition.broker?.notes ?? null,
    },
    requires_camelai_broker: true,
    has_connected_credentials: Boolean(record.credentials_encrypted),
    auth_status: authStatus(record),
    auth_error_code: record.auth_error_code ?? null,
    auth_error_message: record.auth_error_message ?? null,
    auth_checked_at: timestamp(record.auth_checked_at),
    reauth_required_at: timestamp(record.reauth_required_at),
    reauth_url: workspaceId && authStatus(record) !== 'connected'
      ? reauthUrl(record, workspaceId)
      : null,
    docs_url: definition.docs_url ?? null,
    notes: definition.notes ?? null,
  };
}

function nativeMcpDefinitionForRecord(
  record: WorkspaceIntegrationRecord,
  config = parseJsonObject(record.config)
): NativeMcpDefinition | null {
  if (record.integration_type === 'remote_mcp') {
    const serverUrl = typeof config.server_url === 'string' ? config.server_url.trim() : '';
    if (!serverUrl || validateRemoteMcpUrl(serverUrl).length > 0) return null;
    return {
      server_name: record.name,
      url: serverUrl,
      transport: 'streamable_http',
      auth_strategy: 'remote_mcp_config',
      direct_connect: false,
      brokered: true,
      preferred_mode: 'brokered',
      broker: {
        server_name: record.name,
        url: serverUrl,
        transport: 'streamable_http',
        auth_strategy: 'remote_mcp_config',
        notes:
          'User-configured remote MCP server. camelAI proxies this server and applies the configured auth header server-side.',
      },
      notes:
        'User-configured remote MCP server. camelAI proxies this server and applies the configured auth header server-side.',
    };
  }
  return NATIVE_MCP_SERVERS[record.integration_type] ?? null;
}

function summarizeIntegration(record: WorkspaceIntegrationRecord, workspaceId?: string): Record<string, JsonValue> {
  const config = parseJsonObject(record.config);
  const definition = getIntegrationDefinition(record.integration_type);
  const nativeMcp = nativeMcpConnection(record, workspaceId);
  const resolvedAuthStatus = authStatus(record);

  return {
    id: record.id,
    type: record.integration_type,
    name: record.name,
    display_name:
      (record.integration_type === 'other' && typeof config.display_name === 'string'
        ? config.display_name
        : definition?.displayName) ?? record.name,
    category: record.category,
    auth_method: record.auth_method,
    auth_status: resolvedAuthStatus,
    auth_error_code: record.auth_error_code ?? null,
    auth_error_message: record.auth_error_message ?? null,
    auth_checked_at: timestamp(record.auth_checked_at),
    reauth_required_at: timestamp(record.reauth_required_at),
    reauth_url: workspaceId && resolvedAuthStatus !== 'connected'
      ? reauthUrl(record, workspaceId)
      : null,
    has_credentials: Boolean(record.credentials_encrypted),
    config: config as JsonValue,
    native_mcp: nativeMcp,
    fallback_capabilities: fallbackCapabilities(record.integration_type, config),
    token_expires_at: timestamp(record.token_expires_at),
    created_at: new Date(record.created_at).toISOString(),
    updated_at: new Date(record.updated_at).toISOString(),
  };
}

interface IntegrationResolution {
  record: WorkspaceIntegrationRecord | null;
  ambiguous: WorkspaceIntegrationRecord[];
}

function resolveIntegration(records: WorkspaceIntegrationRecord[], query: string): IntegrationResolution {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return { record: null, ambiguous: [] };

  const idMatch = records.find((record) => record.id.toLowerCase() === normalized);
  if (idMatch) return { record: idMatch, ambiguous: [] };

  const nameMatches = records.filter((record) => record.name.toLowerCase() === normalized);
  if (nameMatches.length === 1) return { record: nameMatches[0], ambiguous: [] };
  if (nameMatches.length > 1) return { record: null, ambiguous: nameMatches };

  const typeMatches = records.filter((record) => record.integration_type.toLowerCase() === normalized);
  if (typeMatches.length === 1) return { record: typeMatches[0], ambiguous: [] };
  if (typeMatches.length > 1) return { record: null, ambiguous: typeMatches };

  return { record: null, ambiguous: [] };
}

async function resolveConnectedIntegration(
  orgStub: DurableObjectStub<OrgDO>,
  workspaceId: string,
  integration: string
): Promise<
  | { ok: true; record: WorkspaceIntegrationRecord }
  | { ok: false; status: number; payload: Record<string, unknown> }
> {
  const records = await orgStub.getWorkspaceIntegrations(workspaceId);
  const { record, ambiguous } = resolveIntegration(records, integration);
  if (ambiguous.length > 0) {
    return {
      ok: false,
      status: 409,
      payload: {
        error: `Multiple connected integrations matched "${integration}". Retry with an integration id.`,
        matches: ambiguous.map(compactIntegrationRef),
      },
    };
  }
  if (!record) {
    return {
      ok: false,
      status: 404,
      payload: {
        error: `No connected integration matched "${integration}"`,
        available: records.map(compactIntegrationRef),
      },
    };
  }
  return { ok: true, record };
}

async function listConnectedIntegrations(
  orgStub: DurableObjectStub<OrgDO>,
  args: IntegrationToolArgs,
  workspaceId: string
): Promise<Record<string, unknown>> {
  const records = await orgStub.getWorkspaceIntegrations(workspaceId);
  const integrations = records
    .map((record) => summarizeIntegration(record, workspaceId))
    .filter((integration) => !args.category || integration.category === args.category);

  return {
    count: integrations.length,
    integrations,
  };
}

async function getConnectedIntegration(
  orgStub: DurableObjectStub<OrgDO>,
  args: IntegrationToolArgs,
  workspaceId: string
): Promise<Record<string, unknown>> {
  if (!args.integration) {
    throw new Error('integration is required');
  }

  const records = await orgStub.getWorkspaceIntegrations(workspaceId);
  const { record, ambiguous } = resolveIntegration(records, args.integration);
  if (ambiguous.length > 0) {
    return {
      found: false,
      ambiguous: true,
      error: `Multiple connected integrations matched "${args.integration}". Retry with an integration id.`,
      matches: ambiguous.map(compactIntegrationRef),
    };
  }
  if (!record) {
    return {
      found: false,
      error: `No connected integration matched "${args.integration}"`,
      available: records.map(compactIntegrationRef),
    };
  }

  return {
    found: true,
    integration: summarizeIntegration(record, workspaceId),
  };
}

async function listMcpServers(
  orgStub: DurableObjectStub<OrgDO>,
  args: IntegrationToolArgs,
  workspaceId: string
): Promise<Record<string, unknown>> {
  const records = await orgStub.getWorkspaceIntegrations(workspaceId);
  const servers = records
    .filter((record) => !args.category || record.category === args.category)
    .map((record) => nativeMcpConnection(record, workspaceId))
    .filter((connection): connection is Record<string, JsonValue> => connection !== null);

  return {
    count: servers.length,
    servers,
  };
}

async function getMcpServer(
  orgStub: DurableObjectStub<OrgDO>,
  args: IntegrationToolArgs,
  workspaceId: string
): Promise<Record<string, unknown>> {
  const result = await getConnectedIntegration(orgStub, args, workspaceId);
  if (!result.found) return result;

  const integration = result.integration as Record<string, unknown>;
  const nativeMcp = integration.native_mcp;
  if (!nativeMcp) {
    return {
      found: false,
      error: `Integration "${args.integration}" does not have a known native MCP server.`,
      integration,
    };
  }

  return {
    found: true,
    server: nativeMcp,
  };
}

function listAvailableIntegrationTypes(args: IntegrationToolArgs): Record<string, unknown> {
  const integrations = getAllIntegrations()
    .filter((definition) => !args.category || definition.category === args.category)
    .map((definition) => ({
      type: definition.type,
      display_name: definition.displayName,
      description: definition.description,
      category: definition.category,
      auth_method: definition.authMethod,
      has_native_mcp: definition.type === 'remote_mcp' || Boolean(NATIVE_MCP_SERVERS[definition.type]),
      native_mcp: NATIVE_MCP_SERVERS[definition.type] ?? null,
      supports_authenticated_fetch_fallback:
        definition.type !== 'remote_mcp' &&
        definition.type !== 'telegram' &&
        !NATIVE_MCP_SERVERS[definition.type],
      supports_brokered_mcp_tools: definition.type === 'remote_mcp' || Boolean(NATIVE_MCP_SERVERS[definition.type]),
      requires_outbound_ip_allowlist: Boolean(definition.requiresOutboundIpAllowlist),
    }));

  return {
    count: integrations.length,
    integration_types: integrations,
  };
}

async function callTool(
  orgStub: DurableObjectStub<OrgDO>,
  params: ToolCallParams,
  workspaceId: string
): Promise<Record<string, unknown>> {
  const args = (params.arguments && typeof params.arguments === 'object'
    ? params.arguments
    : {}) as IntegrationToolArgs;

  switch (params.name) {
    case 'list_connected_integrations':
      return textToolResult(await listConnectedIntegrations(orgStub, args, workspaceId));
    case 'get_connected_integration':
      return textToolResult(await getConnectedIntegration(orgStub, args, workspaceId));
    case 'list_mcp_servers':
      return textToolResult(await listMcpServers(orgStub, args, workspaceId));
    case 'get_mcp_server':
      return textToolResult(await getMcpServer(orgStub, args, workspaceId));
    case 'list_available_integration_types':
      return textToolResult(listAvailableIntegrationTypes(args));
    default:
      throw new Error(`Unknown tool: ${params.name ?? ''}`);
  }
}

async function handleJsonRpcRequest(
  request: JsonRpcRequest,
  orgStub: DurableObjectStub<OrgDO>,
  workspaceId: string
): Promise<Record<string, unknown>> {
  try {
    switch (request.method) {
      case 'initialize':
        return jsonRpcResult(request.id, {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'camelai-connections-registry', version: '1.0.0' },
        });
      case 'ping':
        return jsonRpcResult(request.id, {});
      case 'tools/list':
        return jsonRpcResult(request.id, { tools: TOOL_LIST });
      case 'tools/call':
        return jsonRpcResult(
          request.id,
          await callTool(orgStub, (request.params ?? {}) as ToolCallParams, workspaceId)
        );
      default:
        return jsonRpcError(request.id, -32601, `Method not found: ${request.method ?? ''}`);
    }
  } catch (error) {
    return jsonRpcError(
      request.id,
      -32000,
      error instanceof Error ? error.message : String(error)
    );
  }
}

export async function handleIntegrationsMcp({ req, env }: RouteContext): Promise<Response> {
  const url = new URL(req.url);
  const nativePrefix = '/mcp/integrations/native/';

  if (url.pathname.startsWith(nativePrefix)) {
    return handleNativeMcpProxy(req, env, decodeURIComponent(url.pathname.slice(nativePrefix.length)));
  }

  if (req.method === 'GET') {
    return jsonResponse({
      ok: true,
      server: 'camelai-connections-registry',
      endpoint: '/mcp/integrations',
      methods: ['initialize', 'tools/list', 'tools/call', 'ping'],
    });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  const proxyAuth = validateSandboxProxy(req, env);
  if (!proxyAuth.valid) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  let payload: JsonRpcRequest | JsonRpcRequest[];
  try {
    payload = await req.json();
  } catch {
    return jsonResponse(jsonRpcError(null, -32700, 'Parse error'), 400);
  }

  const orgStub = env.ORG.get(env.ORG.idFromName(proxyAuth.orgId)) as DurableObjectStub<OrgDO>;

  if (Array.isArray(payload)) {
    const results = await Promise.all(
      payload.map((item) => handleJsonRpcRequest(item, orgStub, proxyAuth.workspaceId))
    );
    return jsonResponse(results);
  }

  return jsonResponse(await handleJsonRpcRequest(payload, orgStub, proxyAuth.workspaceId));
}

async function handleNativeMcpProxy(
  req: Request,
  env: RouteContext['env'],
  integrationQuery: string
): Promise<Response> {
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  const proxyAuth = validateSandboxProxy(req, env);
  if (!proxyAuth.valid) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const orgStub = env.ORG.get(env.ORG.idFromName(proxyAuth.orgId)) as DurableObjectStub<OrgDO>;
  const resolved = await resolveConnectedIntegration(
    orgStub,
    proxyAuth.workspaceId,
    integrationQuery,
  );
  if (!resolved.ok) {
    return jsonResponse(resolved.payload, resolved.status);
  }

  const config = parseJsonObject(resolved.record.config);
  const nativeDefinition = nativeMcpDefinitionForRecord(resolved.record, config);
  if (!nativeDefinition) {
    return jsonResponse({
      error: `Integration type "${resolved.record.integration_type}" does not have a known native MCP server.`,
      integration: compactIntegrationRef(resolved.record),
    }, 404);
  }

  const hostedAuthContext = {
    orgStub,
    record: resolved.record,
    workspaceId: proxyAuth.workspaceId,
    userId: proxyAuth.userId,
  };
  const handleHosted = (
    rpc: (method: string, params: Record<string, unknown>) => Promise<unknown>
  ) => handleHostedMcpBroker(req, rpc, hostedAuthContext);

  if (isBigQueryMcpIntegration(resolved.record.integration_type)) {
    return handleBigQueryMcpBroker(req, env, resolved.record, hostedAuthContext);
  }
  if (isClickHouseMcpIntegration(resolved.record.integration_type)) {
    return handleHosted((method, params) =>
      clickHouseMcpRpc(env, resolved.record, method, params)
    );
  }
  if (isSqlDatabaseMcpIntegration(resolved.record.integration_type)) {
    return handleHosted((method, params) =>
      sqlDatabaseMcpRpc(env, {
        orgId: proxyAuth.orgId,
        workspaceId: proxyAuth.workspaceId,
      }, resolved.record, method, params)
    );
  }
  if (isDatabricksMcpIntegration(resolved.record.integration_type)) {
    return handleHosted((method, params) =>
      databricksMcpRpc(env, resolved.record, method, params)
    );
  }
  if (isMongoDbMcpIntegration(resolved.record.integration_type)) {
    return handleHosted((method, params) =>
      mongoDbMcpRpc(env, resolved.record, method, params)
    );
  }
  if (isRedisMcpIntegration(resolved.record.integration_type)) {
    return handleHosted((method, params) =>
      redisMcpRpc(env, resolved.record, method, params)
    );
  }
  if (isSnowflakeMcpIntegration(resolved.record.integration_type)) {
    return handleHosted((method, params) =>
      snowflakeMcpRpc(env, resolved.record, method, params)
    );
  }
  if (isTursoMcpIntegration(resolved.record.integration_type)) {
    return handleHosted((method, params) =>
      tursoMcpRpc(env, resolved.record, method, params)
    );
  }
  if (isAirtableMcpIntegration(resolved.record.integration_type)) {
    return handleHosted((method, params) =>
      airtableMcpRpc(env, resolved.record, method, params)
    );
  }
  if (isSentryMcpIntegration(resolved.record.integration_type)) {
    return handleHosted((method, params) =>
      sentryMcpRpc(env, resolved.record, method, params)
    );
  }
  if (isMailchimpMcpIntegration(resolved.record.integration_type)) {
    return handleHosted((method, params) =>
      mailchimpMcpRpc(env, resolved.record, method, params)
    );
  }
  if (isSendGridMcpIntegration(resolved.record.integration_type)) {
    return handleHosted((method, params) =>
      sendGridMcpRpc(env, resolved.record, method, params)
    );
  }
  if (isTwilioMcpIntegration(resolved.record.integration_type)) {
    return handleHosted((method, params) =>
      twilioMcpRpc(env, resolved.record, method, params)
    );
  }
  if (isPostHogMcpIntegration(resolved.record.integration_type)) {
    return handleHosted((method, params) =>
      postHogMcpRpc(env, resolved.record, method, params)
    );
  }
  if (isMixpanelMcpIntegration(resolved.record.integration_type)) {
    return handleHosted((method, params) =>
      mixpanelMcpRpc(env, resolved.record, method, params)
    );
  }
  if (isAmplitudeMcpIntegration(resolved.record.integration_type)) {
    return handleHosted((method, params) =>
      amplitudeMcpRpc(env, resolved.record, method, params)
    );
  }
  if (isZendeskMcpIntegration(resolved.record.integration_type)) {
    return handleHosted((method, params) =>
      zendeskMcpRpc(env, resolved.record, method, params)
    );
  }
  if (isShopifyMcpIntegration(resolved.record.integration_type)) {
    return handleHosted((method, params) =>
      shopifyMcpRpc(env, resolved.record, method, params)
    );
  }
  if (isSegmentMcpIntegration(resolved.record.integration_type)) {
    return handleHosted((method, params) =>
      segmentMcpRpc(env, resolved.record, method, params)
    );
  }
  if (isTeamsMcpIntegration(resolved.record.integration_type)) {
    return handleHosted((method, params) =>
      teamsMcpRpc(env, resolved.record, method, params)
    );
  }

  const bodyText = await req.text();
  let payload: JsonRpcRequest | JsonRpcRequest[];
  try {
    payload = JSON.parse(bodyText) as JsonRpcRequest | JsonRpcRequest[];
  } catch {
    return jsonResponse(jsonRpcError(null, -32700, 'Parse error'), 400);
  }

  const credentials = resolved.record.credentials_encrypted
    ? await decryptCredentials<Record<string, unknown>>(resolved.record.credentials_encrypted, env.INTEGRATION_SECRET_KEY)
    : {};
  const authHeaders = mcpAuthHeaders(resolved.record, config, credentials);
  if (!authHeaders.ok) {
    const status = resolved.record.auth_method === 'oauth2' || isRemoteMcpOAuth(resolved.record, config)
      ? 'needs_reauth'
      : 'setup_incomplete';
    const code = status === 'needs_reauth' ? 'AUTH_REAUTH_REQUIRED' : 'AUTH_SETUP_INCOMPLETE';
    const message = authHeaders.error;
    await markIntegrationAuthStatus(
      orgStub,
      proxyAuth.workspaceId,
      resolved.record,
      status,
      code,
      message,
      proxyAuth.userId
    );
    return jsonResponse(
      jsonRpcErrorsForPayload(payload, status === 'needs_reauth' ? -32001 : -32002, message, authErrorData(
        resolved.record,
        proxyAuth.workspaceId,
        status,
        code
      )),
      status === 'needs_reauth' ? 401 : 400
    );
  }

  const headers: Record<string, string> = {
    ...authHeaders.headers,
    accept: 'application/json, text/event-stream',
    'content-type': req.headers.get('content-type') ?? 'application/json',
    'mcp-protocol-version': req.headers.get('mcp-protocol-version') ?? '2025-06-18',
  };
  const sessionId = req.headers.get('mcp-session-id');
  if (sessionId) {
    headers['mcp-session-id'] = sessionId;
  }

  const upstream = await fetch(nativeDefinition.url, {
    method: 'POST',
    headers,
    body: bodyText,
  });

  const upstreamAuthStatus = providerAuthStatus(upstream.status);
  if (upstreamAuthStatus) {
    const code = upstreamAuthStatus === 'missing_scopes' ? 'AUTH_MISSING_SCOPES' : 'AUTH_REAUTH_REQUIRED';
    const upstreamText = await upstream.text();
    const message = upstreamText.trim()
      ? `Native MCP provider rejected credentials: ${upstreamText.slice(0, 500)}`
      : `Native MCP provider rejected credentials with HTTP ${upstream.status}.`;
    await markIntegrationAuthStatus(
      orgStub,
      proxyAuth.workspaceId,
      resolved.record,
      upstreamAuthStatus,
      code,
      message,
      proxyAuth.userId
    );
    return jsonResponse(
      jsonRpcErrorsForPayload(
        payload,
        -32001,
        message,
        authErrorData(resolved.record, proxyAuth.workspaceId, upstreamAuthStatus, code)
      ),
      upstream.status
    );
  }

  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.delete('set-cookie');
  responseHeaders.delete('authorization');
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

function mcpAuthHeaders(
  record: WorkspaceIntegrationRecord,
  config: Record<string, unknown>,
  credentials: Record<string, unknown>
): { ok: true; headers: Record<string, string> } | { ok: false; error: string } {
  if (record.integration_type === 'remote_mcp') {
    const authType = typeof config.auth_type === 'string' ? config.auth_type : 'none';
    if (authType === 'none') return { ok: true, headers: {} };

    const token = authType === 'oauth'
      ? (typeof credentials.access_token === 'string' ? credentials.access_token.trim() : '')
      : (typeof credentials.token === 'string' ? credentials.token.trim() : '');
    if (!token) {
      return {
        ok: false,
        error: authType === 'oauth'
          ? `Remote MCP connection "${record.name}" needs OAuth authorization.`
          : `Remote MCP connection "${record.name}" requires a token for ${authType} authentication.`,
      };
    }
    if (authType === 'custom_header') {
      const headerName = typeof config.auth_header === 'string' ? config.auth_header.trim() : '';
      if (!headerName) {
        return {
          ok: false,
          error: `Remote MCP connection "${record.name}" is missing a custom auth header name.`,
        };
      }
      return { ok: true, headers: { [headerName]: token } };
    }
    return { ok: true, headers: { authorization: `Bearer ${token}` } };
  }

  const token = credentialToken(credentials);
  if (!token) {
    return {
      ok: false,
      error: `Connected ${record.integration_type} integration does not have a usable token credential for MCP proxying.`,
    };
  }
  return { ok: true, headers: { authorization: `Bearer ${token}` } };
}

async function handleBigQueryMcpBroker(
  req: Request,
  env: RouteContext['env'],
  record: WorkspaceIntegrationRecord,
  authContext?: HostedMcpAuthContext
): Promise<Response> {
  return handleHostedMcpBroker(
    req,
    (method, params) => bigQueryMcpRpc(env, record, method, params),
    authContext
  );
}

interface HostedMcpAuthContext {
  orgStub: DurableObjectStub<OrgDO>;
  record: WorkspaceIntegrationRecord;
  workspaceId: string;
  userId?: string;
}

async function handleHostedMcpBroker(
  req: Request,
  rpc: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  authContext?: HostedMcpAuthContext
): Promise<Response> {
  let payload: JsonRpcRequest | JsonRpcRequest[];
  try {
    payload = await req.json();
  } catch {
    return jsonResponse(jsonRpcError(null, -32700, 'Parse error'), 400);
  }

  const handleOne = async (item: JsonRpcRequest): Promise<Record<string, unknown>> => {
    try {
      return jsonRpcResult(
        item.id,
        await rpc(
          item.method ?? '',
          item.params && typeof item.params === 'object' && !Array.isArray(item.params)
            ? item.params as Record<string, unknown>
            : {}
        )
      );
    } catch (error) {
      const status = (error as { status?: unknown })?.status;
      const message = error instanceof Error ? error.message : String(error);
      const hostedAuthStatus = typeof status === 'number'
        ? providerAuthStatus(status) ?? providerSetupStatus(status, message)
        : null;
      if (authContext && hostedAuthStatus) {
        const code = hostedAuthStatus === 'missing_scopes'
          ? 'AUTH_MISSING_SCOPES'
          : hostedAuthStatus === 'setup_incomplete'
            ? 'AUTH_SETUP_INCOMPLETE'
            : 'AUTH_REAUTH_REQUIRED';
        await markIntegrationAuthStatus(
          authContext.orgStub,
          authContext.workspaceId,
          authContext.record,
          hostedAuthStatus,
          code,
          message,
          authContext.userId
        );
        return jsonRpcError(
          item.id,
          hostedAuthStatus === 'setup_incomplete' ? -32002 : -32001,
          message,
          authErrorData(authContext.record, authContext.workspaceId, hostedAuthStatus, code)
        );
      }
      return jsonRpcError(
        item.id,
        status === 404 ? -32601 : -32000,
        message
      );
    }
  };

  if (Array.isArray(payload)) {
    return jsonResponse(await Promise.all(payload.map(handleOne)));
  }
  return jsonResponse(await handleOne(payload));
}

function credentialToken(credentials: Record<string, unknown>): string {
  for (const key of ['access_token', 'api_key', 'token', 'bot_token', 'user_access_token']) {
    const value = credentials[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}
