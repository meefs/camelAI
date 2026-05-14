import { decryptCredentials } from '../../../src/lib/integration-crypto';
import type { WorkspaceIntegrationRecord } from './workspace.js';

type JsonValue =
  | null
  | string
  | number
  | boolean
  | JsonValue[]
  | { [key: string]: JsonValue };

interface ClickHouseMcpEnv {
  INTEGRATION_SECRET_KEY: string;
}

interface ClickHouseClient {
  endpoint: string;
  database: string;
  username: string;
  password: string;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const CLICKHOUSE_ID_RE = /^[A-Za-z_][A-Za-z0-9_]{0,255}$/;

export function isClickHouseMcpIntegration(integrationType: string): boolean {
  return integrationType === 'clickhouse';
}

export function listClickHouseMcpTools(): Array<Record<string, unknown>> {
  return [
    {
      name: 'list_databases',
      description: 'List ClickHouse databases.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: 'list_tables',
      description: 'List tables in a ClickHouse database. Uses the connection database when omitted.',
      inputSchema: {
        type: 'object',
        properties: {
          database: { type: 'string', description: 'ClickHouse database name.' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'get_table_info',
      description: 'Get ClickHouse table columns from system.columns.',
      inputSchema: {
        type: 'object',
        properties: {
          database: { type: 'string', description: 'ClickHouse database name. Optional when configured on the connection.' },
          table: { type: 'string', description: 'ClickHouse table name.' },
        },
        required: ['table'],
        additionalProperties: false,
      },
    },
    {
      name: 'execute_sql_readonly',
      description: 'Execute a ClickHouse query and return JSON.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'SQL query to execute.' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, description: `Default LIMIT to append when the query has no LIMIT. Defaults to ${DEFAULT_LIMIT}.` },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  ];
}

export async function clickHouseMcpRpc(
  env: ClickHouseMcpEnv,
  record: WorkspaceIntegrationRecord,
  method: string,
  params: Record<string, unknown> = {}
): Promise<unknown> {
  if (!isClickHouseMcpIntegration(record.integration_type)) {
    throw Object.assign(new Error(`Integration type "${record.integration_type}" is not ClickHouse.`), {
      status: 404,
    });
  }

  switch (method) {
    case 'initialize':
      return {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'camelai-clickhouse', version: '1.0.0' },
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: listClickHouseMcpTools() };
    case 'tools/call':
      return callClickHouseTool(env, record, params);
    default:
      throw Object.assign(new Error(`Method not found: ${method}`), { status: 404 });
  }
}

async function callClickHouseTool(
  env: ClickHouseMcpEnv,
  record: WorkspaceIntegrationRecord,
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const name = requireString(params.name, 'name');
  const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
    ? params.arguments as Record<string, unknown>
    : {};
  const client = await createClickHouseClient(env, record);

  switch (name) {
    case 'list_databases':
      return textToolResult(await executeClickHouseJson(client, 'SELECT name FROM system.databases ORDER BY name'));
    case 'list_tables':
      return textToolResult(await executeClickHouseJson(
        client,
        `SELECT name, engine, total_rows, total_bytes FROM system.tables WHERE database = ${sqlString(databaseFromArgs(client, args))} ORDER BY name`
      ));
    case 'get_table_info':
      return textToolResult(await executeClickHouseJson(
        client,
        `SELECT name, type, default_kind, comment FROM system.columns WHERE database = ${sqlString(databaseFromArgs(client, args))} AND table = ${sqlString(requireIdentifier(args.table, 'table'))} ORDER BY position`
      ));
    case 'execute_sql_readonly':
      return textToolResult(await executeClickHouseJson(
        client,
        normalizeReadOnlyQuery(
          requireString(args.query, 'query'),
          boundedInteger(args.limit, DEFAULT_LIMIT, 1, MAX_LIMIT, 'limit')
        )
      ));
    default:
      throw Object.assign(new Error(`Unknown ClickHouse tool: ${name}`), { status: 404 });
  }
}

async function createClickHouseClient(
  env: ClickHouseMcpEnv,
  record: WorkspaceIntegrationRecord
): Promise<ClickHouseClient> {
  const config = parseJsonObject(record.config);
  const credentials = record.credentials_encrypted
    ? await decryptCredentials<Record<string, unknown>>(record.credentials_encrypted, env.INTEGRATION_SECRET_KEY)
    : {};
  const host = requireString(config.host, 'host');
  const port = typeof config.port === 'number' && Number.isFinite(config.port)
    ? config.port
    : 8443;
  const database = typeof config.database === 'string' && config.database.trim()
    ? requireIdentifier(config.database, 'database')
    : 'default';
  const username = requireString(credentials.username, 'username');
  const password = requireString(credentials.password, 'password');
  return {
    endpoint: validateClickHouseEndpoint(host, port),
    database,
    username,
    password,
  };
}

async function executeClickHouseJson(client: ClickHouseClient, query: string): Promise<Record<string, JsonValue>> {
  const response = await fetch(`${client.endpoint}/?database=${encodeURIComponent(client.database)}`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${btoa(`${client.username}:${client.password}`)}`,
      'content-type': 'text/plain; charset=utf-8',
    },
    body: `${query.trim().replace(/;+\s*$/, '')} FORMAT JSON`,
  });
  const text = await response.text();
  if (!response.ok) {
    throw Object.assign(new Error(text || `ClickHouse request failed with HTTP ${response.status}`), {
      status: response.status,
    });
  }
  return JSON.parse(text) as Record<string, JsonValue>;
}

function normalizeReadOnlyQuery(query: string, limit: number): string {
  const trimmed = query.trim().replace(/;+\s*$/, '');
  if (/limit/i.test(trimmed)) return trimmed;
  return `${trimmed} LIMIT ${limit}`;
}
function validateClickHouseEndpoint(host: string, port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw Object.assign(new Error('port must be a valid TCP port.'), { status: 400 });
  }
  const raw = host.includes('://') ? host : `https://${host}`;
  const url = new URL(raw);
  if (url.protocol !== 'https:') {
    throw Object.assign(new Error('ClickHouse host must use HTTPS.'), { status: 400 });
  }
  if (url.username || url.password) {
    throw Object.assign(new Error('ClickHouse host must not include embedded credentials.'), { status: 400 });
  }
  if (!url.port) url.port = String(port);
  url.pathname = '';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

function databaseFromArgs(client: ClickHouseClient, args: Record<string, unknown>): string {
  if (typeof args.database === 'string' && args.database.trim()) {
    return requireIdentifier(args.database, 'database');
  }
  return client.database;
}

function requireIdentifier(value: unknown, field: string): string {
  const id = requireString(value, field);
  if (!CLICKHOUSE_ID_RE.test(id)) {
    throw Object.assign(new Error(`${field} must be a valid ClickHouse identifier.`), { status: 400 });
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

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
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
