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
import type { WorkspaceDO, WorkspaceIntegrationRecord } from '../workspace.js';

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

type NativeMcpAuthStrategy =
  | 'connected_credentials_broker';

interface NativeMcpDefinition {
  server_name: string;
  url: string;
  transport: 'streamable_http';
  auth_strategy: NativeMcpAuthStrategy;
  direct_connect: boolean;
  docs_url?: string;
  notes?: string;
}

const NATIVE_MCP_SERVERS: Record<string, NativeMcpDefinition> = {
  github: {
    server_name: 'github',
    url: 'https://api.githubcopilot.com/mcp/',
    transport: 'streamable_http',
    auth_strategy: 'connected_credentials_broker',
    direct_connect: false,
    docs_url: 'https://github.com/github/github-mcp-server',
    notes: 'Official remote GitHub MCP server. camelAI proxies this server and injects the connected GitHub credential server-side.',
  },
  linear: {
    server_name: 'linear',
    url: 'https://mcp.linear.app/mcp',
    transport: 'streamable_http',
    auth_strategy: 'connected_credentials_broker',
    direct_connect: false,
    docs_url: 'https://linear.app/docs/mcp',
    notes: 'Official Linear MCP server. camelAI proxies this server and injects the connected Linear credential server-side.',
  },
  notion: {
    server_name: 'notion',
    url: 'https://mcp.notion.com/mcp',
    transport: 'streamable_http',
    auth_strategy: 'connected_credentials_broker',
    direct_connect: false,
    docs_url: 'https://developers.notion.com/guides/mcp/mcp',
    notes: 'Official Notion MCP server. camelAI proxies this server and injects the connected Notion credential server-side.',
  },
  stripe: {
    server_name: 'stripe',
    url: 'https://mcp.stripe.com',
    transport: 'streamable_http',
    auth_strategy: 'connected_credentials_broker',
    direct_connect: false,
    docs_url: 'https://docs.stripe.com/mcp',
    notes: 'Official Stripe MCP server. camelAI proxies this server and injects the connected Stripe key server-side.',
  },
};

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

function fallbackCapabilities(integrationType: string, config: Record<string, unknown>): string[] {
  if (integrationType === 'postgres' || integrationType === 'mysql') {
    return ['query_database'];
  }
  if (integrationType === 'other' && typeof config.base_url === 'string' && config.base_url.trim()) {
    return ['authenticated_fetch'];
  }
  if (!NATIVE_MCP_SERVERS[integrationType]) {
    return ['authenticated_fetch'];
  }
  return [];
}

function nativeMcpConnection(record: WorkspaceIntegrationRecord): Record<string, JsonValue> | null {
  const definition = NATIVE_MCP_SERVERS[record.integration_type];
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
    direct_connect: false,
    requires_camelai_broker: true,
    has_connected_credentials: Boolean(record.credentials_encrypted),
    docs_url: definition.docs_url ?? null,
    notes: definition.notes ?? null,
  };
}

function summarizeIntegration(record: WorkspaceIntegrationRecord): Record<string, JsonValue> {
  const config = parseJsonObject(record.config);
  const definition = getIntegrationDefinition(record.integration_type);
  const nativeMcp = nativeMcpConnection(record);

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
    has_credentials: Boolean(record.credentials_encrypted),
    config: config as JsonValue,
    native_mcp: nativeMcp,
    fallback_capabilities: fallbackCapabilities(record.integration_type, config),
    token_expires_at: record.token_expires_at ? new Date(record.token_expires_at).toISOString() : null,
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

function compactIntegrationRef(record: WorkspaceIntegrationRecord): Record<string, string> {
  return {
    id: record.id,
    type: record.integration_type,
    name: record.name,
  };
}

async function resolveConnectedIntegration(
  workspaceStub: DurableObjectStub<WorkspaceDO>,
  integration: string
): Promise<
  | { ok: true; record: WorkspaceIntegrationRecord }
  | { ok: false; status: number; payload: Record<string, unknown> }
> {
  const records = await workspaceStub.getIntegrations();
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
  workspaceStub: DurableObjectStub<WorkspaceDO>,
  args: IntegrationToolArgs
): Promise<Record<string, unknown>> {
  const records = await workspaceStub.getIntegrations();
  const integrations = records
    .map(summarizeIntegration)
    .filter((integration) => !args.category || integration.category === args.category);

  return {
    count: integrations.length,
    integrations,
  };
}

async function getConnectedIntegration(
  workspaceStub: DurableObjectStub<WorkspaceDO>,
  args: IntegrationToolArgs
): Promise<Record<string, unknown>> {
  if (!args.integration) {
    throw new Error('integration is required');
  }

  const records = await workspaceStub.getIntegrations();
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
    integration: summarizeIntegration(record),
  };
}

async function listMcpServers(
  workspaceStub: DurableObjectStub<WorkspaceDO>,
  args: IntegrationToolArgs
): Promise<Record<string, unknown>> {
  const records = await workspaceStub.getIntegrations();
  const servers = records
    .filter((record) => !args.category || record.category === args.category)
    .map(nativeMcpConnection)
    .filter((connection): connection is Record<string, JsonValue> => connection !== null);

  return {
    count: servers.length,
    servers,
  };
}

async function getMcpServer(
  workspaceStub: DurableObjectStub<WorkspaceDO>,
  args: IntegrationToolArgs
): Promise<Record<string, unknown>> {
  const result = await getConnectedIntegration(workspaceStub, args);
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
      has_native_mcp: Boolean(NATIVE_MCP_SERVERS[definition.type]),
      native_mcp: NATIVE_MCP_SERVERS[definition.type] ?? null,
      supports_authenticated_fetch_fallback: !NATIVE_MCP_SERVERS[definition.type],
      requires_outbound_ip_allowlist: Boolean(definition.requiresOutboundIpAllowlist),
    }));

  return {
    count: integrations.length,
    integration_types: integrations,
  };
}

async function callTool(
  workspaceStub: DurableObjectStub<WorkspaceDO>,
  params: ToolCallParams
): Promise<Record<string, unknown>> {
  const args = (params.arguments && typeof params.arguments === 'object'
    ? params.arguments
    : {}) as IntegrationToolArgs;

  switch (params.name) {
    case 'list_connected_integrations':
      return textToolResult(await listConnectedIntegrations(workspaceStub, args));
    case 'get_connected_integration':
      return textToolResult(await getConnectedIntegration(workspaceStub, args));
    case 'list_mcp_servers':
      return textToolResult(await listMcpServers(workspaceStub, args));
    case 'get_mcp_server':
      return textToolResult(await getMcpServer(workspaceStub, args));
    case 'list_available_integration_types':
      return textToolResult(listAvailableIntegrationTypes(args));
    default:
      throw new Error(`Unknown tool: ${params.name ?? ''}`);
  }
}

async function handleJsonRpcRequest(
  request: JsonRpcRequest,
  workspaceStub: DurableObjectStub<WorkspaceDO>
): Promise<Record<string, unknown>> {
  try {
    switch (request.method) {
      case 'initialize':
        return jsonRpcResult(request.id, {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'camelai-integrations-registry', version: '1.0.0' },
        });
      case 'ping':
        return jsonRpcResult(request.id, {});
      case 'tools/list':
        return jsonRpcResult(request.id, { tools: TOOL_LIST });
      case 'tools/call':
        return jsonRpcResult(
          request.id,
          await callTool(workspaceStub, (request.params ?? {}) as ToolCallParams)
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
      server: 'camelai-integrations-registry',
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

  const workspaceStub = env.WORKSPACE.get(
    env.WORKSPACE.idFromName(proxyAuth.workspaceId)
  ) as DurableObjectStub<WorkspaceDO>;

  if (Array.isArray(payload)) {
    const results = await Promise.all(
      payload.map((item) => handleJsonRpcRequest(item, workspaceStub))
    );
    return jsonResponse(results);
  }

  return jsonResponse(await handleJsonRpcRequest(payload, workspaceStub));
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

  const workspaceStub = env.WORKSPACE.get(
    env.WORKSPACE.idFromName(proxyAuth.workspaceId)
  ) as DurableObjectStub<WorkspaceDO>;
  const resolved = await resolveConnectedIntegration(workspaceStub, integrationQuery);
  if (!resolved.ok) {
    return jsonResponse(resolved.payload, resolved.status);
  }

  const nativeDefinition = NATIVE_MCP_SERVERS[resolved.record.integration_type];
  if (!nativeDefinition) {
    return jsonResponse({
      error: `Integration type "${resolved.record.integration_type}" does not have a known native MCP server.`,
      integration: compactIntegrationRef(resolved.record),
    }, 404);
  }

  const credentials = resolved.record.credentials_encrypted
    ? await decryptCredentials<Record<string, unknown>>(resolved.record.credentials_encrypted, env.INTEGRATION_SECRET_KEY)
    : {};
  const token = credentialToken(credentials);
  if (!token) {
    return jsonResponse({
      error: `Connected ${resolved.record.integration_type} integration does not have a usable token credential for MCP proxying.`,
      integration: compactIntegrationRef(resolved.record),
    }, 400);
  }

  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
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
    body: req.body,
    // @ts-expect-error duplex is required for streaming request bodies.
    duplex: 'half',
  });

  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.delete('set-cookie');
  responseHeaders.delete('authorization');
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
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
