import { decryptCredentials } from '../../../src/lib/integration-crypto';
import { getProviderMcpDefinition } from '../../../src/lib/provider-mcp-registry';
import { mintBigQueryAccessTokenFromServiceAccount } from './google-service-account';
import type { WorkspaceIntegrationRecord } from './workspace.js';

type JsonValue =
  | null
  | string
  | number
  | boolean
  | JsonValue[]
  | { [key: string]: JsonValue };

interface BigQueryMcpEnv {
  INTEGRATION_SECRET_KEY: string;
}

interface BigQueryConfig {
  projectId: string;
  defaultDataset: string | null;
}

interface BigQueryField {
  name?: string;
  type?: string;
  mode?: string;
  fields?: BigQueryField[];
}

interface BigQueryTableSchema {
  fields?: BigQueryField[];
}

interface BigQueryQueryResponse {
  jobComplete?: boolean;
  jobReference?: { jobId?: string; projectId?: string; location?: string };
  schema?: BigQueryTableSchema;
  rows?: Array<{ f?: Array<{ v?: unknown }> }>;
  totalRows?: string;
  totalBytesProcessed?: string;
  cacheHit?: boolean;
}

interface BigQueryJobResponse {
  statistics?: {
    totalBytesProcessed?: string;
    query?: {
      totalBytesProcessed?: string;
      totalBytesBilled?: string;
      cacheHit?: boolean;
    };
  };
}

interface BigQueryErrorResponse {
  error?: {
    message?: string;
    status?: string;
    errors?: Array<{ message?: string; reason?: string }>;
  };
}

const BIGQUERY_API_BASE = 'https://bigquery.googleapis.com/bigquery/v2';
const BIGQUERY_TOKEN_REFRESH_SKEW_MS = 60 * 1000;
const DEFAULT_MAX_RESULTS = 100;
const MAX_MAX_RESULTS = 1000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_MAXIMUM_BYTES_BILLED = '1000000000';
const BIGQUERY_ID_RE = /^[A-Za-z_][A-Za-z0-9_]{0,1023}$/;
const BIGQUERY_PROVIDER_MCP = getProviderMcpDefinition('bigquery');
if (!BIGQUERY_PROVIDER_MCP) {
  throw new Error('BigQuery provider MCP definition is missing');
}

export const BIGQUERY_MCP_SERVER = {
  ...BIGQUERY_PROVIDER_MCP,
  server_name: BIGQUERY_PROVIDER_MCP.serverName,
  direct_connect: BIGQUERY_PROVIDER_MCP.directConnect,
  auth_strategy: BIGQUERY_PROVIDER_MCP.authStrategy,
  docs_url: BIGQUERY_PROVIDER_MCP.docsUrl,
};

export function isBigQueryMcpIntegration(integrationType: string): boolean {
  return integrationType === 'bigquery';
}

export function listBigQueryMcpTools(): Array<Record<string, unknown>> {
  return [
    {
      name: 'list_dataset_ids',
      description: 'List BigQuery dataset ids in the connected project.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: 'get_dataset_info',
      description: 'Get metadata for one BigQuery dataset.',
      inputSchema: {
        type: 'object',
        properties: {
          datasetId: {
            type: 'string',
            description: 'Dataset id in the connected project.',
          },
        },
        required: ['datasetId'],
        additionalProperties: false,
      },
    },
    {
      name: 'list_table_ids',
      description: 'List table ids in a BigQuery dataset. Uses the connection default dataset when datasetId is omitted.',
      inputSchema: {
        type: 'object',
        properties: {
          datasetId: {
            type: 'string',
            description: 'Dataset id. Optional when the connection has a default dataset.',
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'get_table_info',
      description: 'Get metadata and schema for one BigQuery table.',
      inputSchema: {
        type: 'object',
        properties: {
          datasetId: {
            type: 'string',
            description: 'Dataset id. Optional when the connection has a default dataset.',
          },
          tableId: {
            type: 'string',
            description: 'Table id in the dataset.',
          },
        },
        required: ['tableId'],
        additionalProperties: false,
      },
    },
    {
      name: 'execute_sql_readonly',
      description:
        'Execute a Standard SQL query against BigQuery. The broker dry-runs the query first and enforces result and bytes limits.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Standard SQL query to execute.',
          },
          datasetId: {
            type: 'string',
            description: 'Default dataset for unqualified table names. Optional when the connection has a default dataset.',
          },
          maxResults: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_MAX_RESULTS,
            description: `Maximum rows to return. Defaults to ${DEFAULT_MAX_RESULTS}.`,
          },
          maximumBytesBilled: {
            type: 'string',
            description: `Maximum bytes BigQuery may bill for the query. Defaults to ${DEFAULT_MAXIMUM_BYTES_BILLED}.`,
          },
          timeoutMs: {
            type: 'integer',
            minimum: 1000,
            maximum: MAX_TIMEOUT_MS,
            description: `Query timeout in milliseconds. Defaults to ${DEFAULT_TIMEOUT_MS}.`,
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  ];
}

export async function bigQueryMcpRpc(
  env: BigQueryMcpEnv,
  record: WorkspaceIntegrationRecord,
  method: string,
  params: Record<string, unknown> = {}
): Promise<unknown> {
  if (!isBigQueryMcpIntegration(record.integration_type)) {
    throw Object.assign(new Error(`Integration type "${record.integration_type}" is not BigQuery.`), {
      status: 404,
    });
  }

  switch (method) {
    case 'initialize':
      return {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'camelai-bigquery', version: '1.0.0' },
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: listBigQueryMcpTools() };
    case 'tools/call':
      return callBigQueryTool(env, record, params);
    default:
      throw Object.assign(new Error(`Method not found: ${method}`), { status: 404 });
  }
}

async function callBigQueryTool(
  env: BigQueryMcpEnv,
  record: WorkspaceIntegrationRecord,
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const name = requireString(params.name, 'name');
  const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
    ? params.arguments as Record<string, unknown>
    : {};
  const client = await createBigQueryClient(env, record);

  switch (name) {
    case 'list_dataset_ids':
      return textToolResult(await listDatasetIds(client));
    case 'get_dataset_info':
      return textToolResult(await getDatasetInfo(client, requireBigQueryId(args.datasetId, 'datasetId')));
    case 'list_table_ids':
      return textToolResult(await listTableIds(client, datasetFromArgs(client.config, args)));
    case 'get_table_info':
      return textToolResult(await getTableInfo(
        client,
        datasetFromArgs(client.config, args),
        requireBigQueryId(args.tableId, 'tableId')
      ));
    case 'execute_sql_readonly':
      return textToolResult(await executeSqlReadonly(client, args));
    default:
      throw Object.assign(new Error(`Unknown BigQuery tool: ${name}`), { status: 404 });
  }
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

async function createBigQueryClient(
  env: BigQueryMcpEnv,
  record: WorkspaceIntegrationRecord
): Promise<{ config: BigQueryConfig; token: string }> {
  return {
    config: parseBigQueryConfig(record),
    token: await getBigQueryAccessToken(env, record),
  };
}

function parseBigQueryConfig(record: WorkspaceIntegrationRecord): BigQueryConfig {
  const config = parseJsonObject(record.config);
  const projectId = requireString(config.project_id, 'project_id');
  const defaultDataset = typeof config.dataset === 'string' && config.dataset.trim()
    ? requireBigQueryId(config.dataset, 'dataset')
    : null;

  return { projectId, defaultDataset };
}

async function getBigQueryAccessToken(
  env: BigQueryMcpEnv,
  record: WorkspaceIntegrationRecord
): Promise<string> {
  if (!record.credentials_encrypted) {
    throw Object.assign(new Error('BigQuery integration has no stored credentials.'), { status: 400 });
  }

  const credentials = await decryptCredentials<Record<string, unknown>>(
    record.credentials_encrypted,
    env.INTEGRATION_SECRET_KEY
  );
  const accessToken = typeof credentials.access_token === 'string' ? credentials.access_token.trim() : '';
  const expiresAt = typeof credentials.expires_at === 'number'
    ? credentials.expires_at
    : record.token_expires_at;

  if (accessToken && (!expiresAt || expiresAt > Date.now() + BIGQUERY_TOKEN_REFRESH_SKEW_MS)) {
    return accessToken;
  }

  const serviceAccountJson = credentials.service_account_json;
  if (typeof serviceAccountJson === 'string' && serviceAccountJson.trim()) {
    const minted = await mintBigQueryAccessTokenFromServiceAccount(serviceAccountJson);
    return minted.accessToken;
  }

  throw Object.assign(new Error('BigQuery integration does not have a usable access token.'), { status: 400 });
}

async function listDatasetIds(client: { config: BigQueryConfig; token: string }): Promise<Record<string, JsonValue>> {
  const payload = await bigQueryFetch<{ datasets?: Array<{ datasetReference?: { datasetId?: string } }> }>(
    client,
    `/projects/${encodeURIComponent(client.config.projectId)}/datasets`
  );
  return {
    projectId: client.config.projectId,
    datasetIds: (payload.datasets ?? [])
      .map((dataset) => dataset.datasetReference?.datasetId)
      .filter((datasetId): datasetId is string => Boolean(datasetId)),
  };
}

async function getDatasetInfo(
  client: { config: BigQueryConfig; token: string },
  datasetId: string
): Promise<Record<string, JsonValue>> {
  return await bigQueryFetch<Record<string, JsonValue>>(
    client,
    `/projects/${encodeURIComponent(client.config.projectId)}/datasets/${encodeURIComponent(datasetId)}`
  );
}

async function listTableIds(
  client: { config: BigQueryConfig; token: string },
  datasetId: string
): Promise<Record<string, JsonValue>> {
  const payload = await bigQueryFetch<{
    tables?: Array<{
      tableReference?: { tableId?: string };
      type?: string;
    }>;
  }>(
    client,
    `/projects/${encodeURIComponent(client.config.projectId)}/datasets/${encodeURIComponent(datasetId)}/tables`
  );
  return {
    projectId: client.config.projectId,
    datasetId,
    tables: (payload.tables ?? [])
      .map((table) => ({
        tableId: table.tableReference?.tableId ?? '',
        type: table.type ?? null,
      }))
      .filter((table) => table.tableId),
  };
}

async function getTableInfo(
  client: { config: BigQueryConfig; token: string },
  datasetId: string,
  tableId: string
): Promise<Record<string, JsonValue>> {
  return await bigQueryFetch<Record<string, JsonValue>>(
    client,
    `/projects/${encodeURIComponent(client.config.projectId)}/datasets/${encodeURIComponent(datasetId)}/tables/${encodeURIComponent(tableId)}`
  );
}

async function executeSqlReadonly(
  client: { config: BigQueryConfig; token: string },
  args: Record<string, unknown>
): Promise<Record<string, JsonValue>> {
  const query = requireString(args.query, 'query');

  const datasetId = datasetFromArgs(client.config, args, false) || null;
  const maxResults = boundedInteger(args.maxResults, DEFAULT_MAX_RESULTS, 1, MAX_MAX_RESULTS, 'maxResults');
  const timeoutMs = boundedInteger(args.timeoutMs, DEFAULT_TIMEOUT_MS, 1000, MAX_TIMEOUT_MS, 'timeoutMs');
  const maximumBytesBilled = maximumBytesBilledFromArgs(args.maximumBytesBilled);
  const queryConfig = {
    query,
    useLegacySql: false,
    maximumBytesBilled,
    ...(datasetId
      ? { defaultDataset: { projectId: client.config.projectId, datasetId } }
      : {}),
  };

  const dryRun = await bigQueryFetch<BigQueryJobResponse>(
    client,
    `/projects/${encodeURIComponent(client.config.projectId)}/jobs`,
    {
      method: 'POST',
      body: {
        configuration: {
          dryRun: true,
          query: queryConfig,
        },
      },
    }
  );

  const response = await bigQueryFetch<BigQueryQueryResponse>(
    client,
    `/projects/${encodeURIComponent(client.config.projectId)}/queries`,
    {
      method: 'POST',
      body: {
        ...queryConfig,
        maxResults,
        timeoutMs,
      },
    }
  );

  return {
    projectId: client.config.projectId,
    datasetId,
    jobReference: (response.jobReference ?? null) as JsonValue,
    jobComplete: Boolean(response.jobComplete),
    totalRows: response.totalRows ?? '0',
    totalBytesProcessed:
      response.totalBytesProcessed
      ?? dryRun.statistics?.query?.totalBytesProcessed
      ?? dryRun.statistics?.totalBytesProcessed
      ?? null,
    totalBytesBilled: dryRun.statistics?.query?.totalBytesBilled ?? null,
    cacheHit: response.cacheHit ?? dryRun.statistics?.query?.cacheHit ?? null,
    schema: (response.schema ?? { fields: [] }) as JsonValue,
    rows: formatRows(response.schema?.fields ?? [], response.rows ?? []) as JsonValue,
  };
}

async function bigQueryFetch<T>(
  client: { config?: BigQueryConfig; token: string },
  path: string,
  init: { method?: string; body?: unknown } = {}
): Promise<T> {
  const response = await fetch(`${BIGQUERY_API_BASE}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${client.token}`,
      'content-type': 'application/json',
      ...(client.config?.projectId ? { 'x-goog-user-project': client.config.projectId } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) as T & BigQueryErrorResponse : {} as T & BigQueryErrorResponse;

  if (!response.ok) {
    const detail = payload.error?.message
      || payload.error?.errors?.map((item) => item.message).filter(Boolean).join('; ')
      || `BigQuery API request failed with HTTP ${response.status}`;
    throw Object.assign(new Error(detail), { status: response.status });
  }

  return payload as T;
}

function formatRows(
  fields: BigQueryField[],
  rows: Array<{ f?: Array<{ v?: unknown }> }>
): Array<Record<string, JsonValue>> {
  return rows.map((row) => {
    const values = row.f ?? [];
    const formatted: Record<string, JsonValue> = {};
    fields.forEach((field, index) => {
      const name = field.name || `field_${index}`;
      formatted[name] = convertBigQueryValue(field, values[index]?.v) as JsonValue;
    });
    return formatted;
  });
}

function convertBigQueryValue(field: BigQueryField, value: unknown): JsonValue {
  if (value == null) return null;
  if (field.mode === 'REPEATED' && Array.isArray(value)) {
    return value.map((item) => convertBigQueryValue({ ...field, mode: undefined }, (item as { v?: unknown })?.v));
  }
  if (field.type === 'RECORD' && typeof value === 'object' && value !== null && Array.isArray((value as { f?: unknown }).f)) {
    return formatRows(field.fields ?? [], [{ f: (value as { f: Array<{ v?: unknown }> }).f }])[0] ?? {};
  }
  if (field.type === 'BOOLEAN' || field.type === 'BOOL') {
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function datasetFromArgs(
  config: BigQueryConfig,
  args: Record<string, unknown>,
  required = true
): string {
  const datasetId = typeof args.datasetId === 'string' && args.datasetId.trim()
    ? requireBigQueryId(args.datasetId, 'datasetId')
    : config.defaultDataset;
  if (!datasetId && required) {
    throw Object.assign(new Error('datasetId is required because the connection has no default dataset.'), {
      status: 400,
    });
  }
  return datasetId ?? '';
}

function requireBigQueryId(value: unknown, field: string): string {
  const id = requireString(value, field);
  if (!BIGQUERY_ID_RE.test(id)) {
    throw Object.assign(new Error(`${field} must be a valid BigQuery identifier.`), { status: 400 });
  }
  return id;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw Object.assign(new Error(`${field} is required`), { status: 400 });
  }
  return value.trim();
}

function boundedInteger(
  value: unknown,
  defaultValue: number,
  min: number,
  max: number,
  field: string
): number {
  if (value == null) return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw Object.assign(new Error(`${field} must be an integer from ${min} to ${max}.`), { status: 400 });
  }
  return parsed;
}

function maximumBytesBilledFromArgs(value: unknown): string {
  if (value == null || value === '') return DEFAULT_MAXIMUM_BYTES_BILLED;
  const raw = typeof value === 'number' ? String(value) : requireString(value, 'maximumBytesBilled');
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw Object.assign(new Error('maximumBytesBilled must be a positive integer string.'), { status: 400 });
  }
  return raw;
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
