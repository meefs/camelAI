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
  example?: string;
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
  input?: unknown;
}

export type ConnectionFindQuery =
  | string
  | {
    id?: string;
    alias?: string;
    type?: string;
    name?: string;
  };

export interface ConnectionSmokeTestResult {
  ok: true;
  alias: string;
  connection: ConnectionSummary;
  method: string | null;
  result?: unknown;
}

const NATIVE_MCP_SERVERS = PROVIDER_MCP_REGISTRY;
const OTHER_CONNECTION_FETCH_TOOL = 'authenticated_fetch';
const OTHER_CONNECTION_FETCH_METHOD: ConnectionMethodSummary = {
  name: 'fetch',
  tool: OTHER_CONNECTION_FETCH_TOOL,
  description:
    'Fetch from this custom API connection like fetch(input, init). Relative URLs are resolved against the connection base_url and camelAI applies the stored auth settings.',
  example: 'await connections.<alias>.fetch("/v1/items", { method: "GET" })',
  inputSchema: {
    type: 'object',
    properties: {
      input: {
        type: 'string',
        description:
          'Fetch input: a relative URL such as "/v1/items" or an absolute http(s) URL. Relative URLs are resolved against the connection base_url.',
      },
      init: {
        type: 'object',
        description: 'Fetch init object. Supports method, headers, and body.',
        properties: {
          method: {
            type: 'string',
            enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'],
            description: 'HTTP method. Defaults to GET.',
          },
          headers: {
            type: 'object',
            additionalProperties: { type: 'string' },
            description: 'Optional request headers. Authentication headers are applied by camelAI.',
          },
          body: {
            description:
              'Optional request body. Strings are sent as-is; objects and arrays are JSON encoded.',
          },
        },
        additionalProperties: true,
      },
    },
    required: ['input'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      status: { type: 'number' },
      statusText: { type: 'string' },
      headers: { type: 'object', additionalProperties: { type: 'string' } },
      bodyText: { type: 'string' },
      truncated: { type: 'boolean' },
    },
    required: ['status', 'statusText', 'headers', 'bodyText', 'truncated'],
    additionalProperties: false,
  },
};
const OTHER_CONNECTION_RESPONSE_LIMIT = 1_000_000;
const DATABASE_QUERY_TOOL_NAMES = new Set([
  'execute_sql_readonly',
]);
const DATABASE_QUERY_INTEGRATION_TYPES = new Set([
  'bigquery',
  'clickhouse',
  'databricks',
  'mysql',
  'neon',
  'planetscale',
  'postgres',
  'snowflake',
  'turso',
]);

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
    example: undefined,
    inputSchema: record.inputSchema ?? record.input_schema,
    outputSchema: record.outputSchema ?? record.output_schema,
  };
}

function methodExample(alias: string, method: ConnectionMethodSummary): string {
  if (method.name === 'fetch') {
    return `await connections.${alias}.fetch("/v1/items", { method: "GET" })`;
  }
  if (method.name === 'query') {
    return `await connections.${alias}.query({ query: "SELECT 1 AS ok" })`;
  }
  if (method.inputSchema && typeof method.inputSchema === 'object') {
    const required = (method.inputSchema as { required?: unknown }).required;
    if (Array.isArray(required) && required.includes('query')) {
      return `await connections.${alias}.${method.name}({ query: "SELECT 1 AS ok" })`;
    }
  }
  return `await connections.${alias}.${method.name}({})`;
}

function attachMethodExamples(alias: string, methods: ConnectionMethodSummary[]): ConnectionMethodSummary[] {
  return methods.map((method) => ({
    ...method,
    example: method.example?.replace('<alias>', alias) ?? methodExample(alias, method),
  }));
}

function addNormalizedMethodAliases(
  connection: ConnectionSummary,
  methods: ConnectionMethodSummary[]
): ConnectionMethodSummary[] {
  const output = [...methods];
  const names = new Set(output.map((method) => method.name));
  const queryMethod = output.find((method) => (
    DATABASE_QUERY_TOOL_NAMES.has(method.tool) ||
    (DATABASE_QUERY_INTEGRATION_TYPES.has(connection.type) && method.name === 'executeSqlReadonly')
  ));
  if (queryMethod && !names.has('query')) {
    output.unshift({
      ...queryMethod,
      name: 'query',
      description: queryMethod.description
        ? `${queryMethod.description} Alias for ${queryMethod.name}.`
        : `Alias for ${queryMethod.name}.`,
    });
    names.add('query');
  }
  if (queryMethod && !names.has('executeQuery')) {
    output.push({
      ...queryMethod,
      name: 'executeQuery',
      description: queryMethod.description
        ? `${queryMethod.description} Alias for ${queryMethod.name}.`
        : `Alias for ${queryMethod.name}.`,
    });
  }
  return output;
}

function otherConnectionMethods(connection: ConnectionSummary): ConnectionMethodSummary[] {
  if (connection.type !== 'other' || !connection.capabilities.includes('authenticated_fetch')) {
    return [];
  }
  return [OTHER_CONNECTION_FETCH_METHOD];
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
      entry.methods = attachMethodExamples(entry.alias, addNormalizedMethodAliases(
        connection,
        otherConnectionMethods(connection)
      ));
      return entry;
    }
    try {
      const tools = await listConnectionTools(env, context, connection.id);
      entry.methods = attachMethodExamples(
        entry.alias,
        addNormalizedMethodAliases(
          connection,
          tools
            .map(toolToMethod)
            .filter((method): method is ConnectionMethodSummary => method !== null)
        )
      );
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

function compactCatalogEntry(entry: ConnectionMethodCatalogEntry): Record<string, unknown> {
  return {
    alias: entry.alias,
    id: entry.connection.id,
    type: entry.connection.type,
    name: entry.connection.name,
  };
}

function findCatalogMatches(
  catalog: ConnectionMethodCatalogEntry[],
  query: ConnectionFindQuery
): ConnectionMethodCatalogEntry[] {
  if (typeof query === 'string') {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return [];
    return catalog.filter((entry) => (
      entry.alias.toLowerCase() === normalized ||
      entry.connection.id.toLowerCase() === normalized ||
      entry.connection.name.toLowerCase() === normalized ||
      entry.connection.type.toLowerCase() === normalized
    ));
  }

  const id = query.id?.trim().toLowerCase();
  const alias = query.alias?.trim().toLowerCase();
  const type = query.type?.trim().toLowerCase();
  const name = query.name?.trim().toLowerCase();
  return catalog.filter((entry) => (
    (!id || entry.connection.id.toLowerCase() === id) &&
    (!alias || entry.alias.toLowerCase() === alias) &&
    (!type || entry.connection.type.toLowerCase() === type) &&
    (!name || entry.connection.name.toLowerCase() === name)
  ));
}

export async function findConnectionMethodEntry(
  env: ConnectionsRuntimeEnv,
  context: ConnectionsContext,
  query: ConnectionFindQuery
): Promise<ConnectionMethodCatalogEntry> {
  const catalog = await listConnectionMethods(env, context);
  const matches = findCatalogMatches(catalog, query);
  const label = typeof query === 'string' ? query : JSON.stringify(query);
  if (matches.length === 0) {
    throw Object.assign(new Error(`No connected integration matched ${label}`), {
      status: 404,
      matches: catalog.map(compactCatalogEntry),
    });
  }
  if (matches.length > 1) {
    throw Object.assign(new Error(`Multiple connected integrations matched ${label}. Retry with a connection alias or id.`), {
      status: 409,
      matches: matches.map(compactCatalogEntry),
    });
  }
  return matches[0]!;
}

export async function testConnectionMethodEntry(
  env: ConnectionsRuntimeEnv,
  context: ConnectionsContext,
  query: ConnectionFindQuery
): Promise<ConnectionSmokeTestResult> {
  const entry = await findConnectionMethodEntry(env, context, query);
  if (entry.error) {
    const authStatus = (entry.error.data as { authStatus?: unknown } | undefined)?.authStatus;
    throw Object.assign(new Error(entry.error.message), {
      status: entry.error.code === 'AUTH_SETUP_INCOMPLETE'
        ? 400
        : authStatus === 'needs_reauth' || authStatus === 'missing_scopes'
          ? 401
          : 502,
      code: entry.error.code,
      data: entry.error.data,
    });
  }

  const queryMethod = entry.methods.find((method) => method.name === 'query');
  if (queryMethod) {
    return {
      ok: true,
      alias: entry.alias,
      connection: entry.connection,
      method: queryMethod.name,
      result: await invokeConnectionMethod(env, context, {
        connection: entry.alias,
        method: queryMethod.name,
        input: { query: 'SELECT 1 AS ok' },
      }),
    };
  }

  return {
    ok: true,
    alias: entry.alias,
    connection: entry.connection,
    method: entry.methods[0]?.name ?? null,
  };
}

export async function invokeConnectionMethod(
  env: ConnectionsRuntimeEnv,
  context: ConnectionsContext,
  request: ConnectionInvokeRequest
): Promise<unknown> {
  const method = typeof request.method === 'string' ? request.method : '';
  if (!method.trim()) {
    throw Object.assign(new Error('method is required'), { status: 400 });
  }

  const target = await findConnectionMethodEntry(env, context, request.connection);
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

  if (target.connection.type === 'other' && targetMethod.tool === OTHER_CONNECTION_FETCH_TOOL) {
    return callOtherConnectionFetch(env, context, target.connection.id, request.input);
  }

  const input = request.input && typeof request.input === 'object' && !Array.isArray(request.input)
    ? request.input as Record<string, unknown>
    : {};
  return callConnectionTool(env, context, target.connection.id, targetMethod.tool, input);
}

async function callOtherConnectionFetch(
  env: ConnectionsRuntimeEnv,
  context: ConnectionsContext,
  connection: string,
  input: unknown
): Promise<unknown> {
  const records = await getWorkspaceIntegrations(env, context.workspaceId);
  const resolved = resolveIntegration(records, connection);
  if (!resolved.ok) {
    throw Object.assign(new Error(resolved.error), {
      status: resolved.status,
      matches: resolved.matches,
    });
  }
  const record = resolved.record;
  if (record.integration_type !== 'other') {
    throw Object.assign(new Error(`Connection "${record.name}" is not a custom API connection.`), { status: 400 });
  }

  const config = parseJsonObject(record.config);
  const baseUrl = requireConfiguredUrl(config.base_url, 'base_url');
  const request = normalizeOtherFetchInput(input);
  const requestUrl = resolveOtherFetchUrl(baseUrl, request.input);

  const credentials = record.credentials_encrypted
    ? await decryptCredentials<Record<string, unknown>>(record.credentials_encrypted, env.INTEGRATION_SECRET_KEY)
    : {};
  const method = otherFetchMethod(request.init.method);
  const headers = otherFetchHeaders(request.init.headers);
  applyOtherAuth(headers, config, credentials);

  const init: RequestInit = { method, headers };
  if (method !== 'GET' && method !== 'HEAD' && Object.prototype.hasOwnProperty.call(request.init, 'body')) {
    const body = request.init.body;
    if (typeof body === 'string') {
      init.body = body;
    } else if (body !== undefined) {
      if (!headers.has('content-type')) headers.set('content-type', 'application/json');
      init.body = JSON.stringify(body);
    }
  }

  const response = await fetch(requestUrl, init);
  const responseBody = await boundedResponseText(response, OTHER_CONNECTION_RESPONSE_LIMIT);
  return {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeadersObject(response.headers),
    bodyText: responseBody.text,
    truncated: responseBody.truncated,
  };
}

function requireConfiguredUrl(value: unknown, field: string): URL {
  if (typeof value !== 'string' || !value.trim()) {
    throw Object.assign(new Error(`Custom API connection is missing ${field}.`), { status: 400 });
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw Object.assign(new Error(`${field} must be a valid URL.`), { status: 400 });
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw Object.assign(new Error(`${field} must use http or https.`), { status: 400 });
  }
  if (url.username || url.password) {
    throw Object.assign(new Error(`${field} must not include embedded credentials.`), { status: 400 });
  }
  return url;
}

function normalizeOtherFetchInput(input: unknown): { input: string; init: Record<string, unknown> } {
  if (typeof input === 'string') {
    return { input, init: {} };
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw Object.assign(new Error('fetch input must be a URL string or { input, init } object.'), {
      status: 400,
    });
  }
  const record = input as Record<string, unknown>;
  if (typeof record.input !== 'string') {
    throw Object.assign(new Error('fetch input.input must be a URL string.'), { status: 400 });
  }
  const init = record.init === undefined
    ? {}
    : record.init && typeof record.init === 'object' && !Array.isArray(record.init)
      ? record.init as Record<string, unknown>
      : null;
  if (!init) {
    throw Object.assign(new Error('fetch input.init must be an object when provided.'), { status: 400 });
  }
  return { input: record.input, init };
}

function resolveOtherFetchUrl(baseUrl: URL, input: unknown): URL {
  if (typeof input !== 'string' || !input.trim()) {
    throw Object.assign(new Error('fetch input is required'), { status: 400 });
  }
  const pathValue = input.trim();
  let requestUrl: URL;
  try {
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(pathValue)) {
      requestUrl = new URL(pathValue);
    } else {
      const relativeBase = new URL(baseUrl.toString());
      if (!relativeBase.pathname.endsWith('/')) relativeBase.pathname += '/';
      requestUrl = new URL(pathValue, relativeBase);
    }
  } catch {
    throw Object.assign(new Error('fetch input must be a relative path or valid URL.'), { status: 400 });
  }
  if (requestUrl.protocol !== 'https:' && requestUrl.protocol !== 'http:') {
    throw Object.assign(new Error('Custom API fetch input must use http or https.'), { status: 400 });
  }
  // TODO: Restrict custom API fetches to trusted domains from the connection
  // configuration once existing plaintext-env usage has fully migrated.
  if (requestUrl.username || requestUrl.password) {
    throw Object.assign(new Error('fetch input must not include embedded credentials.'), { status: 400 });
  }
  return requestUrl;
}

function otherFetchMethod(value: unknown): string {
  const method = typeof value === 'string' && value.trim() ? value.trim().toUpperCase() : 'GET';
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(method)) {
    throw Object.assign(new Error(`Unsupported custom API request method: ${method}`), { status: 400 });
  }
  return method;
}

function otherFetchHeaders(value: unknown): Headers {
  const headers = new Headers();
  if (value === undefined || value === null) return headers;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new Error('headers must be an object when provided.'), { status: 400 });
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.trim().toLowerCase();
    if (!normalized || ['authorization', 'proxy-authorization', 'host', 'content-length'].includes(normalized)) {
      continue;
    }
    if (typeof item !== 'string') {
      throw Object.assign(new Error(`headers.${key} must be a string.`), { status: 400 });
    }
    headers.set(key, item);
  }
  return headers;
}

function credentialString(credentials: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = credentials[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function applyOtherAuth(headers: Headers, config: Record<string, unknown>, credentials: Record<string, unknown>): void {
  const authType = typeof config.auth_type === 'string' && config.auth_type.trim()
    ? config.auth_type.trim().toLowerCase()
    : 'bearer';
  switch (authType) {
    case 'none':
      return;
    case 'bearer': {
      const token = credentialString(credentials, 'api_key', 'access_token', 'token');
      if (!token) throw Object.assign(new Error('Custom API bearer auth requires api_key.'), { status: 400 });
      headers.set('authorization', `Bearer ${token}`);
      return;
    }
    case 'basic': {
      const username = credentialString(credentials, 'client_id', 'username', 'api_key');
      const password = credentialString(credentials, 'client_secret', 'password', 'api_secret');
      if (!username || !password) {
        throw Object.assign(new Error('Custom API basic auth requires username/client_id/api_key and password/client_secret/api_secret.'), { status: 400 });
      }
      headers.set('authorization', `Basic ${btoa(`${username}:${password}`)}`);
      return;
    }
    case 'header': {
      const headerName = typeof config.auth_header === 'string' && config.auth_header.trim()
        ? config.auth_header.trim()
        : 'X-API-Key';
      const token = credentialString(credentials, 'api_key', 'access_token', 'token');
      if (!token) throw Object.assign(new Error('Custom API header auth requires api_key.'), { status: 400 });
      headers.set(headerName, token);
      return;
    }
    default:
      throw Object.assign(new Error(`Unsupported custom API auth_type: ${authType}`), { status: 400 });
  }
}

async function boundedResponseText(response: Response, limit: number): Promise<{ text: string; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { text: '', truncated: false };
  const decoder = new TextDecoder();
  let text = '';
  let truncated = false;
  while (text.length < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (text.length > limit) {
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
  }
  text += decoder.decode();
  return {
    text: text.length > limit ? text.slice(0, limit) : text,
    truncated,
  };
}

function responseHeadersObject(headers: Headers): Record<string, string> {
  const output: Record<string, string> = {};
  headers.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie') return;
    output[key] = value;
  });
  return output;
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
