import { decryptCredentials } from '../../../src/lib/integration-crypto';
import { getIntegrationDefinition } from '../../../src/lib/integration-registry';
import {
  PROVIDER_MCP_REGISTRY,
  type ProviderMcpDefinition,
} from '../../../src/lib/provider-mcp-registry';
import {
  airtableMcpRpc,
  isAirtableMcpIntegration,
} from './airtable-mcp.js';
import {
  bigQueryMcpRpc,
  isBigQueryMcpIntegration,
} from './bigquery-mcp.js';
import {
  clickHouseMcpRpc,
  isClickHouseMcpIntegration,
} from './clickhouse-mcp.js';
import {
  isSentryMcpIntegration,
  sentryMcpRpc,
} from './sentry-mcp.js';
import {
  isMailchimpMcpIntegration,
  mailchimpMcpRpc,
} from './mailchimp-mcp.js';
import {
  isSendGridMcpIntegration,
  sendGridMcpRpc,
} from './sendgrid-mcp.js';
import {
  isTwilioMcpIntegration,
  twilioMcpRpc,
} from './twilio-mcp.js';
import {
  isPostHogMcpIntegration,
  postHogMcpRpc,
} from './posthog-mcp.js';
import {
  isMixpanelMcpIntegration,
  mixpanelMcpRpc,
} from './mixpanel-mcp.js';
import {
  amplitudeMcpRpc,
  isAmplitudeMcpIntegration,
} from './amplitude-mcp.js';
import {
  isZendeskMcpIntegration,
  zendeskMcpRpc,
} from './zendesk-mcp.js';
import {
  isSqlDatabaseMcpIntegration,
  sqlDatabaseMcpRpc,
} from './sql-database-mcp.js';
import {
  databricksMcpRpc,
  isDatabricksMcpIntegration,
} from './databricks-mcp.js';
import {
  isMongoDbMcpIntegration,
  mongoDbMcpRpc,
} from './mongodb-mcp.js';
import {
  isRedisMcpIntegration,
  redisMcpRpc,
} from './redis-mcp.js';
import {
  isSnowflakeMcpIntegration,
  snowflakeMcpRpc,
} from './snowflake-mcp.js';
import {
  isTursoMcpIntegration,
  tursoMcpRpc,
} from './turso-mcp.js';
import {
  isShopifyMcpIntegration,
  shopifyMcpRpc,
} from './shopify-mcp.js';
import {
  isSegmentMcpIntegration,
  segmentMcpRpc,
} from './segment-mcp.js';
import {
  isTeamsMcpIntegration,
  teamsMcpRpc,
} from './teams-mcp.js';
import type {
  WorkspaceDO,
  WorkspaceIntegrationAuthStatus,
  WorkspaceIntegrationRecord,
} from './workspace.js';
import type { DataProxyEnv } from './data-proxy.js';

type JsonValue =
  | null
  | string
  | number
  | boolean
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface ConnectionsRuntimeEnv extends DataProxyEnv {
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
  authStatus: WorkspaceIntegrationAuthStatus;
  authErrorCode: string | null;
  authErrorMessage: string | null;
  authCheckedAt: string | null;
  reauthRequiredAt: string | null;
  reauthUrl: string | null;
  hasCredentials: boolean;
  capabilities: string[];
  nativeMcp: {
    serverName: string;
    transport: ProviderMcpDefinition['transport'];
    directConnect: boolean;
    brokered: boolean;
    authStrategy: string;
    preferredMode?: 'direct' | 'brokered';
    direct?: {
      serverName: string;
      url: string;
      transport: ProviderMcpDefinition['transport'];
      authStrategy: string;
      docsUrl?: string;
      notes?: string;
    };
    broker?: {
      serverName: string;
      url: string;
      transport: ProviderMcpDefinition['transport'];
      authStrategy: string;
      brokerPath: string;
      docsUrl?: string;
      notes?: string;
    };
  } | null;
}

export interface ConnectionMethodSummary {
  name: string;
  tool: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
}

export interface ConnectionMethodCatalogEntry {
  alias: string;
  connection: ConnectionSummary;
  methods: ConnectionMethodSummary[];
  error?: {
    message: string;
    code?: unknown;
    data?: unknown;
  };
}

export interface ConnectionInvokeRequest {
  connection: string;
  method?: string;
  input?: Record<string, unknown>;
}

const NATIVE_MCP_SERVERS = PROVIDER_MCP_REGISTRY;

type ConnectionAuthErrorData = {
  code: string;
  authStatus: WorkspaceIntegrationAuthStatus;
  reauthUrl: string | null;
  integration: Record<string, string>;
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
  if (integrationType === 'other' && typeof config.base_url === 'string' && config.base_url.trim()) {
    return ['authenticated_fetch'];
  }
  const nativeMcp = NATIVE_MCP_SERVERS[integrationType];
  if (!nativeMcp) {
    if (integrationType === 'postgres' || integrationType === 'mysql') {
      return ['query_database'];
    }
    return ['authenticated_fetch'];
  }
  return [
    nativeMcp.authStrategy === 'camelai_hosted_broker'
      ? 'camelai_hosted_mcp'
      : 'first_party_mcp_brokered',
  ];
}

function timestamp(value: number | null | undefined): string | null {
  return value ? new Date(value).toISOString() : null;
}

function authStatus(record: WorkspaceIntegrationRecord): WorkspaceIntegrationAuthStatus {
  return record.auth_status ?? (record.credentials_encrypted ? 'connected' : 'setup_incomplete');
}

function reauthUrl(record: WorkspaceIntegrationRecord, context: ConnectionsContext): string | null {
  if (record.auth_method === 'oauth2') {
    const params = new URLSearchParams({
      workspace_id: context.workspaceId,
      integration_id: record.id,
      redirect: '/connections',
    });
    return `/api/integrations/${encodeURIComponent(record.integration_type)}/oauth?${params.toString()}`;
  }
  return `/connections?${new URLSearchParams({ connection: record.id, reauth: '1' }).toString()}`;
}

function authErrorData(
  record: WorkspaceIntegrationRecord,
  context: ConnectionsContext,
  status: WorkspaceIntegrationAuthStatus,
  code: string
): ConnectionAuthErrorData {
  return {
    code,
    authStatus: status,
    reauthUrl: reauthUrl(record, context),
    integration: compactIntegrationRef(record),
  };
}

function connectionAuthError(
  record: WorkspaceIntegrationRecord,
  context: ConnectionsContext,
  status: WorkspaceIntegrationAuthStatus,
  code: string,
  message: string,
  httpStatus = 401
): Error {
  return Object.assign(new Error(message), {
    status: httpStatus,
    code,
    data: authErrorData(record, context, status, code),
  });
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

async function markConnectionAuthStatus(
  env: ConnectionsRuntimeEnv,
  context: ConnectionsContext,
  record: WorkspaceIntegrationRecord,
  status: WorkspaceIntegrationAuthStatus,
  code: string,
  message: string
): Promise<void> {
  try {
    const workspaceStub = env.WORKSPACE.get(
      env.WORKSPACE.idFromName(context.workspaceId)
    ) as DurableObjectStub<WorkspaceDO>;
    await workspaceStub.updateIntegrationAuthStatus(
      record.id,
      status,
      code,
      message,
      context.userId ?? 'system'
    );
  } catch (error) {
    console.warn('[connections-runtime] failed to update connection auth status', {
      integrationId: record.id,
      status,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function summarizeConnection(record: WorkspaceIntegrationRecord, context: ConnectionsContext): ConnectionSummary {
  const config = parseJsonObject(record.config);
  const definition = getIntegrationDefinition(record.integration_type);
  const nativeMcp = NATIVE_MCP_SERVERS[record.integration_type] ?? null;
  const resolvedAuthStatus = authStatus(record);
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
    authStatus: resolvedAuthStatus,
    authErrorCode: record.auth_error_code ?? null,
    authErrorMessage: record.auth_error_message ?? null,
    authCheckedAt: timestamp(record.auth_checked_at),
    reauthRequiredAt: timestamp(record.reauth_required_at),
    reauthUrl: resolvedAuthStatus === 'connected' ? null : reauthUrl(record, context),
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
          brokered: true,
          authStrategy: nativeMcp.authStrategy === 'first_party_oauth_direct'
            ? 'connected_credentials_broker'
            : nativeMcp.authStrategy,
          preferredMode: 'brokered',
          broker: {
            serverName: nativeMcp.broker?.serverName ?? nativeMcp.serverName,
            url: nativeMcp.broker?.url ?? nativeMcp.url,
            transport: nativeMcp.broker?.transport ?? nativeMcp.transport,
            authStrategy: nativeMcp.broker?.authStrategy ?? (
              nativeMcp.authStrategy === 'first_party_oauth_direct'
                ? 'connected_credentials_broker'
                : nativeMcp.authStrategy
            ),
            brokerPath: `/mcp/integrations/native/${encodeURIComponent(record.id)}`,
            docsUrl: nativeMcp.broker?.docsUrl ?? nativeMcp.docsUrl,
            notes: nativeMcp.broker?.notes,
          },
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

function toIdentifier(value: string, fallback: string): string {
  const parts = value
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return fallback;
  const [first, ...rest] = parts;
  const identifier = [
    first!.charAt(0).toLowerCase() + first!.slice(1),
    ...rest.map((part) => part.charAt(0).toUpperCase() + part.slice(1)),
  ].join('');
  return /^[A-Za-z_$]/.test(identifier) ? identifier : `${fallback}${identifier}`;
}

function connectionAlias(connection: ConnectionSummary, used: Set<string>): string {
  const base = toIdentifier(`${connection.type} ${connection.name}`, 'connection');
  let candidate = base;
  let index = 2;
  while (used.has(candidate)) {
    candidate = `${base}${index}`;
    index += 1;
  }
  used.add(candidate);
  return candidate;
}

function toolToMethod(tool: unknown): ConnectionMethodSummary | null {
  if (!tool || typeof tool !== 'object') return null;
  const record = tool as {
    name?: unknown;
    description?: unknown;
    inputSchema?: unknown;
    input_schema?: unknown;
    outputSchema?: unknown;
    output_schema?: unknown;
  };
  if (typeof record.name !== 'string' || !record.name.trim()) return null;
  return {
    name: toIdentifier(record.name, 'method'),
    tool: record.name,
    description: typeof record.description === 'string' ? record.description : undefined,
    inputSchema: record.inputSchema ?? record.input_schema,
    outputSchema: record.outputSchema ?? record.output_schema,
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
  return records.map((record) => summarizeConnection(record, context));
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
  return summarizeConnection(resolved.record, context);
}

async function invokeNativeMcpRpc(
  env: ConnectionsRuntimeEnv,
  context: ConnectionsContext,
  record: WorkspaceIntegrationRecord,
  method: string,
  params: Record<string, unknown> = {}
): Promise<unknown> {
  try {
    return await nativeMcpRpc(env, context, record, method, params);
  } catch (error) {
    const status = (error as { status?: unknown })?.status;
    const message = error instanceof Error
      ? error.message
      : `Connection ${record.name} requires reauthorization.`;
    const auth = typeof status === 'number'
      ? providerAuthStatus(status) ?? providerSetupStatus(status, message)
      : null;
    if (auth) {
      const code = auth === 'missing_scopes'
        ? 'AUTH_MISSING_SCOPES'
        : auth === 'setup_incomplete'
          ? 'AUTH_SETUP_INCOMPLETE'
          : 'AUTH_REAUTH_REQUIRED';
      await markConnectionAuthStatus(env, context, record, auth, code, message);
      throw connectionAuthError(record, context, auth, code, message, status as number);
    }
    throw error;
  }
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
  const result = await invokeNativeMcpRpc(env, context, resolved.record, 'tools/list');
  const tools = (result as { tools?: unknown[] })?.tools;
  return Array.isArray(tools) ? tools : [];
}

export async function listConnectionMethods(
  env: ConnectionsRuntimeEnv,
  context: ConnectionsContext
): Promise<ConnectionMethodCatalogEntry[]> {
  const connections = await listConnections(env, context);
  const usedAliases = new Set<string>();
  return Promise.all(connections.map(async (connection) => {
    const entry: ConnectionMethodCatalogEntry = {
      alias: connectionAlias(connection, usedAliases),
      connection,
      methods: [],
    };
    if (!connection.nativeMcp || connection.nativeMcp.brokered === false) {
      return entry;
    }
    try {
      const tools = await listConnectionTools(env, context, connection.id);
      entry.methods = tools
        .map(toolToMethod)
        .filter((method): method is ConnectionMethodSummary => method !== null);
    } catch (error) {
      entry.error = {
        message: error instanceof Error ? error.message : String(error),
        code: (error as { code?: unknown })?.code,
        data: (error as { data?: unknown })?.data,
      };
    }
    return entry;
  }));
}

export async function invokeConnectionMethod(
  env: ConnectionsRuntimeEnv,
  context: ConnectionsContext,
  request: ConnectionInvokeRequest
): Promise<unknown> {
  const input = request.input && typeof request.input === 'object' && !Array.isArray(request.input)
    ? request.input
    : {};
  const method = typeof request.method === 'string' ? request.method : '';
  if (!method.trim()) {
    throw Object.assign(new Error('method is required'), { status: 400 });
  }

  const catalog = await listConnectionMethods(env, context);
  const normalizedConnection = request.connection.trim().toLowerCase();
  const matches = catalog.filter((entry) => (
    entry.alias.toLowerCase() === normalizedConnection ||
    entry.connection.id.toLowerCase() === normalizedConnection ||
    entry.connection.name.toLowerCase() === normalizedConnection ||
    entry.connection.type.toLowerCase() === normalizedConnection
  ));
  if (matches.length === 0) {
    throw Object.assign(new Error(`No connected integration matched "${request.connection}"`), {
      status: 404,
      matches: catalog.map((entry) => ({
        alias: entry.alias,
        id: entry.connection.id,
        type: entry.connection.type,
        name: entry.connection.name,
      })),
    });
  }
  if (matches.length > 1) {
    throw Object.assign(
      new Error(`Multiple connected integrations matched "${request.connection}". Retry with a connection alias or id.`),
      {
        status: 409,
        matches: matches.map((entry) => ({
          alias: entry.alias,
          id: entry.connection.id,
          type: entry.connection.type,
          name: entry.connection.name,
        })),
      }
    );
  }

  const target = matches[0]!;
  if (target.error) {
    const authStatus = (target.error.data as { authStatus?: unknown } | undefined)?.authStatus;
    throw Object.assign(new Error(target.error.message), {
      status: target.error.code === 'AUTH_SETUP_INCOMPLETE'
        ? 400
        : authStatus === 'needs_reauth' || authStatus === 'missing_scopes'
          ? 401
          : 502,
      code: target.error.code,
      data: target.error.data,
    });
  }
  const targetMethod = target.methods.find((candidate) => (
    candidate.name === method || candidate.tool === method
  ));
  if (!targetMethod) {
    throw Object.assign(new Error(`No method "${method}" exists on connection "${target.alias}"`), {
      status: 404,
      methods: target.methods,
    });
  }

  return callConnectionTool(env, context, target.connection.id, targetMethod.tool, input);
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
  return invokeNativeMcpRpc(env, context, resolved.record, 'tools/call', {
    name: tool,
    arguments: input,
  });
}

async function nativeMcpRpc(
  env: ConnectionsRuntimeEnv,
  context: ConnectionsContext,
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
  if (isBigQueryMcpIntegration(record.integration_type)) {
    return bigQueryMcpRpc(env, record, method, params);
  }
  if (isClickHouseMcpIntegration(record.integration_type)) {
    return clickHouseMcpRpc(env, record, method, params);
  }
  if (isSqlDatabaseMcpIntegration(record.integration_type)) {
    return sqlDatabaseMcpRpc(env, context, record, method, params);
  }
  if (isDatabricksMcpIntegration(record.integration_type)) {
    return databricksMcpRpc(env, record, method, params);
  }
  if (isMongoDbMcpIntegration(record.integration_type)) {
    return mongoDbMcpRpc(env, record, method, params);
  }
  if (isRedisMcpIntegration(record.integration_type)) {
    return redisMcpRpc(env, record, method, params);
  }
  if (isSnowflakeMcpIntegration(record.integration_type)) {
    return snowflakeMcpRpc(env, record, method, params);
  }
  if (isTursoMcpIntegration(record.integration_type)) {
    return tursoMcpRpc(env, record, method, params);
  }
  if (isAirtableMcpIntegration(record.integration_type)) {
    return airtableMcpRpc(env, record, method, params);
  }
  if (isSentryMcpIntegration(record.integration_type)) {
    return sentryMcpRpc(env, record, method, params);
  }
  if (isMailchimpMcpIntegration(record.integration_type)) {
    return mailchimpMcpRpc(env, record, method, params);
  }
  if (isSendGridMcpIntegration(record.integration_type)) {
    return sendGridMcpRpc(env, record, method, params);
  }
  if (isTwilioMcpIntegration(record.integration_type)) {
    return twilioMcpRpc(env, record, method, params);
  }
  if (isPostHogMcpIntegration(record.integration_type)) {
    return postHogMcpRpc(env, record, method, params);
  }
  if (isMixpanelMcpIntegration(record.integration_type)) {
    return mixpanelMcpRpc(env, record, method, params);
  }
  if (isAmplitudeMcpIntegration(record.integration_type)) {
    return amplitudeMcpRpc(env, record, method, params);
  }
  if (isZendeskMcpIntegration(record.integration_type)) {
    return zendeskMcpRpc(env, record, method, params);
  }
  if (isShopifyMcpIntegration(record.integration_type)) {
    return shopifyMcpRpc(env, record, method, params);
  }
  if (isSegmentMcpIntegration(record.integration_type)) {
    return segmentMcpRpc(env, record, method, params);
  }
  if (isTeamsMcpIntegration(record.integration_type)) {
    return teamsMcpRpc(env, record, method, params);
  }

  const credentials = record.credentials_encrypted
    ? await decryptCredentials<Record<string, unknown>>(record.credentials_encrypted, env.INTEGRATION_SECRET_KEY)
    : {};
  const token = credentialToken(credentials);
  if (!token) {
    const status = record.auth_method === 'oauth2' ? 'needs_reauth' : 'setup_incomplete';
    const code = status === 'needs_reauth' ? 'AUTH_REAUTH_REQUIRED' : 'AUTH_SETUP_INCOMPLETE';
    const message = `Connected ${record.integration_type} integration does not have a usable token credential for MCP proxying.`;
    await markConnectionAuthStatus(env, context, record, status, code, message);
    throw connectionAuthError(
      record,
      context,
      status,
      code,
      message,
      status === 'needs_reauth' ? 401 : 400
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
  definition: ProviderMcpDefinition,
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
    const events = text.split(/\r?\n\r?\n/);
    const parsedEvents: JsonValue[] = [];
    for (const event of events) {
      const dataLines = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice('data:'.length).trim())
        .filter((line) => line && line !== '[DONE]');
      if (dataLines.length === 0) continue;
      try {
        parsedEvents.push(JSON.parse(dataLines.join('\n')) as JsonValue);
      } catch {
        // Keep scanning later SSE events; streamable HTTP may include progress
        // frames before the JSON-RPC response frame.
      }
    }
    if (parsedEvents.length > 0) {
      return parsedEvents[parsedEvents.length - 1]!;
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
