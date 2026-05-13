import { decryptCredentials } from '../../../src/lib/integration-crypto';
import {
  mysqlQuery,
  postgresQuery,
  type DataProxyContext,
  type DataProxyEnv,
} from './data-proxy.js';
import type { WorkspaceIntegrationRecord } from './workspace.js';

type JsonValue =
  | null
  | string
  | number
  | boolean
  | JsonValue[]
  | { [key: string]: JsonValue };

interface SqlDatabaseMcpEnv extends DataProxyEnv {
  INTEGRATION_SECRET_KEY: string;
}

interface SqlDatabaseClient {
  type: 'postgres' | 'mysql';
  host: string;
  port?: number;
  database: string;
  schema: string;
  username: string;
  password: string;
  sslMode?: string;
  tls?: string;
}

type SqlDatabaseIntegrationType = 'postgres' | 'mysql' | 'neon' | 'planetscale';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

export function isSqlDatabaseMcpIntegration(integrationType: string): boolean {
  return integrationType === 'postgres' ||
    integrationType === 'mysql' ||
    integrationType === 'neon' ||
    integrationType === 'planetscale';
}

export function listSqlDatabaseMcpTools(): Array<Record<string, unknown>> {
  return [
    {
      name: 'list_schemas',
      description: 'List database schemas.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: 'list_tables',
      description: 'List tables in a schema. Uses the connection schema/database when omitted.',
      inputSchema: {
        type: 'object',
        properties: {
          schema: { type: 'string', description: 'Schema name. For MySQL this is the database name.' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, description: `Maximum tables to return. Defaults to ${DEFAULT_LIMIT}.` },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'get_table_info',
      description: 'Get table column metadata.',
      inputSchema: {
        type: 'object',
        properties: {
          schema: { type: 'string', description: 'Schema name. For MySQL this is the database name.' },
          table: { type: 'string', description: 'Table name.' },
        },
        required: ['table'],
        additionalProperties: false,
      },
    },
    {
      name: 'execute_sql_readonly',
      description: 'Execute a read-only SELECT/WITH/SHOW/DESCRIBE query and return rows.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Read-only SQL query.' },
          params: {
            type: 'array',
            description: 'Positional query parameters. Use $1, $2 for Postgres and ? for MySQL.',
          },
          limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, description: `Default LIMIT to append when the query has no LIMIT. Defaults to ${DEFAULT_LIMIT}.` },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  ];
}

export async function sqlDatabaseMcpRpc(
  env: SqlDatabaseMcpEnv,
  context: DataProxyContext,
  record: WorkspaceIntegrationRecord,
  method: string,
  params: Record<string, unknown> = {}
): Promise<unknown> {
  if (!isSqlDatabaseMcpIntegration(record.integration_type)) {
    throw Object.assign(new Error(`Integration type "${record.integration_type}" is not a SQL database.`), {
      status: 404,
    });
  }

  switch (method) {
    case 'initialize':
      return {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: `camelai-${record.integration_type}`, version: '1.0.0' },
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: listSqlDatabaseMcpTools() };
    case 'tools/call':
      return callSqlDatabaseTool(env, context, record, params);
    default:
      throw Object.assign(new Error(`Method not found: ${method}`), { status: 404 });
  }
}

async function callSqlDatabaseTool(
  env: SqlDatabaseMcpEnv,
  context: DataProxyContext,
  record: WorkspaceIntegrationRecord,
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const name = requireString(params.name, 'name');
  const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
    ? params.arguments as Record<string, unknown>
    : {};
  const client = await createSqlDatabaseClient(env, record);

  switch (name) {
    case 'list_schemas':
      return textToolResult(await executeQuery(env, context, client, listSchemasQuery(client), []));
    case 'list_tables': {
      const limit = boundedInteger(args.limit, DEFAULT_LIMIT, 1, MAX_LIMIT, 'limit');
      return textToolResult(await executeQuery(env, context, client, listTablesQuery(client), [
        schemaFromArgs(client, args),
        limit,
      ]));
    }
    case 'get_table_info':
      return textToolResult(await executeQuery(env, context, client, tableInfoQuery(client), [
        schemaFromArgs(client, args),
        requireString(args.table, 'table'),
      ]));
    case 'execute_sql_readonly':
      return textToolResult(await executeQuery(
        env,
        context,
        client,
        normalizeReadOnlyQuery(
          requireString(args.query, 'query'),
          boundedInteger(args.limit, DEFAULT_LIMIT, 1, MAX_LIMIT, 'limit')
        ),
        arrayArg(args.params, 'params')
      ));
    default:
      throw Object.assign(new Error(`Unknown ${client.type} tool: ${name}`), { status: 404 });
  }
}

async function createSqlDatabaseClient(
  env: SqlDatabaseMcpEnv,
  record: WorkspaceIntegrationRecord
): Promise<SqlDatabaseClient> {
  const type = record.integration_type;
  if (!isSqlDatabaseMcpIntegration(type)) {
    throw Object.assign(new Error(`Unsupported SQL database integration: ${type}`), { status: 400 });
  }

  const config = parseJsonObject(record.config);
  const credentials = record.credentials_encrypted
    ? await decryptCredentials<Record<string, unknown>>(record.credentials_encrypted, env.INTEGRATION_SECRET_KEY)
    : {};

  if (type === 'neon') {
    return createPostgresClientFromConnectionString(type, config, credentials);
  }
  if (type === 'planetscale') {
    return createMysqlClientFromConnectionString(type, config, credentials);
  }

  const sqlType = type === 'postgres' ? 'postgres' : 'mysql';
  return {
    type: sqlType,
    host: requireString(config.host, 'host'),
    port: optionalInteger(config.port, 'port'),
    database: requireString(config.database, 'database'),
    schema: sqlType === 'postgres'
      ? optionalString(config.schema) || 'public'
      : requireString(config.database, 'database'),
    username: requireString(credentials.username, 'username'),
    password: requireString(credentials.password, 'password'),
    sslMode: type === 'postgres' ? optionalString(config.ssl_mode) : undefined,
    tls: type === 'mysql' ? optionalString(config.tls) : undefined,
  };
}

function createPostgresClientFromConnectionString(
  integrationType: SqlDatabaseIntegrationType,
  config: Record<string, unknown>,
  credentials: Record<string, unknown>
): SqlDatabaseClient {
  const url = parseDatabaseUrl(
    optionalString(credentials.connection_string) || optionalString(config.connection_string),
    integrationType,
    ['postgres', 'postgresql']
  );
  return {
    type: 'postgres',
    host: requireString(url.hostname, 'connection_string host'),
    port: optionalPort(url),
    database: databaseFromUrl(url),
    schema: optionalString(config.schema) || 'public',
    username: decodeUrlComponent(url.username, 'connection_string username'),
    password: decodeUrlComponent(url.password, 'connection_string password'),
    sslMode: url.searchParams.get('sslmode') || 'require',
  };
}

function createMysqlClientFromConnectionString(
  integrationType: SqlDatabaseIntegrationType,
  config: Record<string, unknown>,
  credentials: Record<string, unknown>
): SqlDatabaseClient {
  const url = parseDatabaseUrl(
    optionalString(credentials.connection_string) || optionalString(config.connection_string),
    integrationType,
    ['mysql']
  );
  const database = databaseFromUrl(url);
  return {
    type: 'mysql',
    host: requireString(url.hostname, 'connection_string host'),
    port: optionalPort(url),
    database,
    schema: database,
    username: decodeUrlComponent(url.username, 'connection_string username'),
    password: decodeUrlComponent(url.password, 'connection_string password'),
    tls: url.searchParams.get('tls') || 'true',
  };
}

async function executeQuery(
  env: SqlDatabaseMcpEnv,
  context: DataProxyContext,
  client: SqlDatabaseClient,
  query: string,
  params: unknown[]
): Promise<Record<string, JsonValue>> {
  const base = {
    mode: 'read' as const,
    host: client.host,
    port: client.port,
    user: client.username,
    password: client.password,
    database: client.database,
    query,
    params,
  };

  const result = client.type === 'postgres'
    ? await postgresQuery(env, context, { ...base, sslmode: client.sslMode })
    : await mysqlQuery(env, context, { ...base, tls: client.tls });

  return {
    rows: (result.recordset ?? []) as JsonValue[],
    rowsAffected: (result.rowsAffected ?? []) as JsonValue[],
  };
}

function listSchemasQuery(client: SqlDatabaseClient): string {
  if (client.type === 'postgres') {
    return `
      SELECT schema_name
      FROM information_schema.schemata
      WHERE schema_name NOT LIKE 'pg_%'
        AND schema_name <> 'information_schema'
      ORDER BY schema_name
    `;
  }
  return `
    SELECT schema_name
    FROM information_schema.schemata
    ORDER BY schema_name
  `;
}

function listTablesQuery(client: SqlDatabaseClient): string {
  if (client.type === 'postgres') {
    return `
      SELECT table_schema, table_name, table_type
      FROM information_schema.tables
      WHERE table_schema = $1
      ORDER BY table_name
      LIMIT $2
    `;
  }
  return `
    SELECT table_schema, table_name, table_type
    FROM information_schema.tables
    WHERE table_schema = ?
    ORDER BY table_name
    LIMIT ?
  `;
}

function tableInfoQuery(client: SqlDatabaseClient): string {
  if (client.type === 'postgres') {
    return `
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = $1
        AND table_name = $2
      ORDER BY ordinal_position
    `;
  }
  return `
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = ?
      AND table_name = ?
    ORDER BY ordinal_position
  `;
}

function normalizeReadOnlyQuery(query: string, limit: number): string {
  const trimmed = query.trim().replace(/;+\s*$/, '');
  const withoutLeadingComments = trimmed
    .replace(/^(?:\s*--[^\n]*(?:\n|$))+/g, '')
    .replace(/^(?:\s*\/\*[\s\S]*?\*\/)+/g, '')
    .trim();
  if (!/^(select|with|show|describe|desc|explain)\b/i.test(withoutLeadingComments)) {
    throw Object.assign(
      new Error('SQL database MCP only accepts read-only SELECT, WITH, SHOW, DESCRIBE, or EXPLAIN queries.'),
      { status: 400 }
    );
  }
  if (/\blimit\b/i.test(trimmed)) {
    return trimmed;
  }
  return `${trimmed} LIMIT ${limit}`;
}

function schemaFromArgs(client: SqlDatabaseClient, args: Record<string, unknown>): string {
  return optionalString(args.schema) || client.schema;
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

function parseDatabaseUrl(
  raw: string | undefined,
  integrationType: SqlDatabaseIntegrationType,
  schemes: string[]
): URL {
  if (!raw) {
    throw Object.assign(new Error(`${integrationType} connection_string is required for MCP SQL tools`), {
      status: 400,
    });
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw Object.assign(new Error(`${integrationType} connection_string must be a valid database URL`), {
      status: 400,
    });
  }

  const scheme = url.protocol.replace(/:$/, '');
  if (!schemes.includes(scheme)) {
    throw Object.assign(
      new Error(`${integrationType} connection_string must use one of these schemes: ${schemes.join(', ')}`),
      { status: 400 }
    );
  }
  return url;
}

function optionalPort(url: URL): number | undefined {
  if (!url.port) return undefined;
  const port = Number.parseInt(url.port, 10);
  if (!Number.isInteger(port) || port <= 0) {
    throw Object.assign(new Error('connection_string port must be a positive integer'), { status: 400 });
  }
  return port;
}

function databaseFromUrl(url: URL): string {
  return decodeUrlComponent(url.pathname.replace(/^\/+/, ''), 'connection_string database');
}

function decodeUrlComponent(value: string, field: string): string {
  if (!value) {
    throw Object.assign(new Error(`${field} is required`), { status: 400 });
  }
  try {
    return decodeURIComponent(value);
  } catch {
    throw Object.assign(new Error(`${field} must be URL encoded correctly`), { status: 400 });
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

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw Object.assign(new Error(`${field} is required`), { status: 400 });
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function optionalInteger(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw Object.assign(new Error(`${field} must be a positive integer`), { status: 400 });
  }
  return value;
}

function boundedInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  field: string
): number {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw Object.assign(new Error(`${field} must be an integer between ${min} and ${max}`), {
      status: 400,
    });
  }
  return value;
}

function arrayArg(value: unknown, field: string): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw Object.assign(new Error(`${field} must be an array`), { status: 400 });
  }
  return value;
}
