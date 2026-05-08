import { decryptCredentials } from '../../../src/lib/integration-crypto';
import { getIntegrationDefinition } from '../../../src/lib/integration-registry';
import type { WorkspaceDO, WorkspaceIntegrationRecord } from './workspace.js';

type JsonValue =
  | null
  | string
  | number
  | boolean
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface ConnectionsRuntimeEnv {
  INTEGRATION_SECRET_KEY: string;
  WORKSPACE: DurableObjectNamespace<WorkspaceDO>;
}

export interface ConnectionsContext {
  orgId: string;
  workspaceId: string;
  userId?: string;
}

export interface ConnectionSummary {
  id: string;
  type: string;
  name: string;
  displayName: string;
  category: string;
  authMethod: string;
  hasCredentials: boolean;
  capabilities: string[];
  nativeMcp: {
    serverName: string;
    transport: 'streamable_http';
    directConnect: false;
  } | null;
}

interface NativeMcpDefinition {
  serverName: string;
  url: string;
  transport: 'streamable_http';
}

const NATIVE_MCP_SERVERS: Record<string, NativeMcpDefinition> = {
  github: {
    serverName: 'github',
    url: 'https://api.githubcopilot.com/mcp/',
    transport: 'streamable_http',
  },
  linear: {
    serverName: 'linear',
    url: 'https://mcp.linear.app/mcp',
    transport: 'streamable_http',
  },
  notion: {
    serverName: 'notion',
    url: 'https://mcp.notion.com/mcp',
    transport: 'streamable_http',
  },
  stripe: {
    serverName: 'stripe',
    url: 'https://mcp.stripe.com',
    transport: 'streamable_http',
  },
};

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

function summarizeConnection(record: WorkspaceIntegrationRecord): ConnectionSummary {
  const config = parseJsonObject(record.config);
  const definition = getIntegrationDefinition(record.integration_type);
  const nativeMcp = NATIVE_MCP_SERVERS[record.integration_type] ?? null;
  return {
    id: record.id,
    type: record.integration_type,
    name: record.name,
    displayName:
      (record.integration_type === 'other' && typeof config.display_name === 'string'
        ? config.display_name
        : definition?.displayName) ?? record.name,
    category: record.category,
    authMethod: record.auth_method,
    hasCredentials: Boolean(record.credentials_encrypted),
    capabilities: [
      ...(nativeMcp ? ['mcp_tools'] : []),
      ...fallbackCapabilities(record.integration_type, config),
    ],
    nativeMcp: nativeMcp
      ? {
          serverName: nativeMcp.serverName,
          transport: nativeMcp.transport,
          directConnect: false,
        }
      : null,
  };
}

function compactIntegrationRef(record: WorkspaceIntegrationRecord): Record<string, string> {
  return {
    id: record.id,
    type: record.integration_type,
    name: record.name,
  };
}

function resolveIntegration(records: WorkspaceIntegrationRecord[], query: string):
  | { ok: true; record: WorkspaceIntegrationRecord }
  | { ok: false; status: number; error: string; matches?: Record<string, string>[] } {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return { ok: false, status: 400, error: 'connection is required' };
  }

  const idMatch = records.find((record) => record.id.toLowerCase() === normalized);
  if (idMatch) return { ok: true, record: idMatch };

  const nameMatches = records.filter((record) => record.name.toLowerCase() === normalized);
  if (nameMatches.length === 1) return { ok: true, record: nameMatches[0]! };
  if (nameMatches.length > 1) {
    return {
      ok: false,
      status: 409,
      error: `Multiple connected integrations matched "${query}". Retry with an integration id.`,
      matches: nameMatches.map(compactIntegrationRef),
    };
  }

  const typeMatches = records.filter((record) => record.integration_type.toLowerCase() === normalized);
  if (typeMatches.length === 1) return { ok: true, record: typeMatches[0]! };
  if (typeMatches.length > 1) {
    return {
      ok: false,
      status: 409,
      error: `Multiple connected integrations matched "${query}". Retry with an integration id.`,
      matches: typeMatches.map(compactIntegrationRef),
    };
  }

  return {
    ok: false,
    status: 404,
    error: `No connected integration matched "${query}"`,
    matches: records.map(compactIntegrationRef),
  };
}

async function getWorkspaceIntegrations(
  env: ConnectionsRuntimeEnv,
  workspaceId: string
): Promise<WorkspaceIntegrationRecord[]> {
  const workspaceStub = env.WORKSPACE.get(
    env.WORKSPACE.idFromName(workspaceId)
  ) as DurableObjectStub<WorkspaceDO>;
  return workspaceStub.getIntegrations();
}

export async function listConnections(
  env: ConnectionsRuntimeEnv,
  context: ConnectionsContext
): Promise<ConnectionSummary[]> {
  const records = await getWorkspaceIntegrations(env, context.workspaceId);
  return records.map(summarizeConnection);
}

export async function getConnection(
  env: ConnectionsRuntimeEnv,
  context: ConnectionsContext,
  connection: string
): Promise<ConnectionSummary> {
  const records = await getWorkspaceIntegrations(env, context.workspaceId);
  const resolved = resolveIntegration(records, connection);
  if (!resolved.ok) {
    throw Object.assign(new Error(resolved.error), {
      status: resolved.status,
      matches: resolved.matches,
    });
  }
  return summarizeConnection(resolved.record);
}

export async function listConnectionTools(
  env: ConnectionsRuntimeEnv,
  context: ConnectionsContext,
  connection: string
): Promise<unknown[]> {
  const records = await getWorkspaceIntegrations(env, context.workspaceId);
  const resolved = resolveIntegration(records, connection);
  if (!resolved.ok) {
    throw Object.assign(new Error(resolved.error), {
      status: resolved.status,
      matches: resolved.matches,
    });
  }
  const result = await nativeMcpRpc(env, resolved.record, 'tools/list');
  const tools = (result as { tools?: unknown[] })?.tools;
  return Array.isArray(tools) ? tools : [];
}

export async function callConnectionTool(
  env: ConnectionsRuntimeEnv,
  context: ConnectionsContext,
  connection: string,
  tool: string,
  input: Record<string, unknown> = {}
): Promise<unknown> {
  const records = await getWorkspaceIntegrations(env, context.workspaceId);
  const resolved = resolveIntegration(records, connection);
  if (!resolved.ok) {
    throw Object.assign(new Error(resolved.error), {
      status: resolved.status,
      matches: resolved.matches,
    });
  }
  return nativeMcpRpc(env, resolved.record, 'tools/call', {
    name: tool,
    arguments: input,
  });
}

async function nativeMcpRpc(
  env: ConnectionsRuntimeEnv,
  record: WorkspaceIntegrationRecord,
  method: string,
  params: Record<string, unknown> = {}
): Promise<unknown> {
  const nativeDefinition = NATIVE_MCP_SERVERS[record.integration_type];
  if (!nativeDefinition) {
    throw Object.assign(
      new Error(`Connection type "${record.integration_type}" does not have MCP-backed tools.`),
      { status: 404 }
    );
  }

  const credentials = record.credentials_encrypted
    ? await decryptCredentials<Record<string, unknown>>(record.credentials_encrypted, env.INTEGRATION_SECRET_KEY)
    : {};
  const token = credentialToken(credentials);
  if (!token) {
    throw Object.assign(
      new Error(`Connected ${record.integration_type} integration does not have a usable token credential for MCP proxying.`),
      { status: 400 }
    );
  }

  const sessionId = await nativeMcpHttp(nativeDefinition, token, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: {
      name: 'camelai-connections',
      version: '1.0.0',
    },
  }).then((result) => result.sessionId);

  return nativeMcpHttp(nativeDefinition, token, method, params, sessionId)
    .then((result) => result.result);
}

async function nativeMcpHttp(
  definition: NativeMcpDefinition,
  token: string,
  method: string,
  params: Record<string, unknown>,
  sessionId?: string | null
): Promise<{ result: unknown; sessionId: string | null }> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    'mcp-protocol-version': '2025-06-18',
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;

  const response = await fetch(definition.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method,
      params,
    }),
  });
  const text = await response.text();
  const payload = parseNativePayload(text);
  if (!response.ok) {
    const message = extractMcpError(payload) || `Native MCP request failed with HTTP ${response.status}`;
    throw Object.assign(new Error(message), { status: response.status });
  }
  const error = extractMcpError(payload);
  if (error) {
    throw Object.assign(new Error(error), { status: 502 });
  }
  return {
    result: (payload as { result?: unknown }).result ?? payload,
    sessionId: response.headers.get('mcp-session-id') || sessionId || null,
  };
}

function parseNativePayload(text: string): JsonValue | Record<string, unknown> {
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    const dataLines = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trim())
      .filter((line) => line && line !== '[DONE]');
    if (dataLines.length > 0) {
      return JSON.parse(dataLines.join('\n')) as JsonValue;
    }
    return { raw: text };
  }
}

function extractMcpError(payload: unknown): string {
  const error = (payload as { error?: unknown })?.error;
  if (!error) return '';
  if (typeof error === 'string') return error;
  const message = (error as { message?: unknown })?.message;
  return typeof message === 'string' ? message : JSON.stringify(error);
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
