/**
 * Data proxy HTTP adapter used by Worker routes.
 *
 * Used by internal Worker entrypoints and forwards requests through the
 * SANDBOX_HOST VPC binding.
 */

const DEFAULT_DATA_PROXY_TIMEOUT_MS = 30_000;
const DEFAULT_DATA_PROXY_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export interface DataProxyEnv {
  SANDBOX_HOST?: Fetcher;
  SANDBOX_HOST_URL?: string;
  DATA_PROXY_MAX_RESPONSE_BYTES?: string;
}

export interface DataProxyContext {
  orgId: string;
  workspaceId: string;
}

type DataProxyError = Error & {
  status?: number;
  code?: string;
  number?: number;
};

function createDataProxyError(message: string, status?: number): DataProxyError {
  const error = new Error(message) as DataProxyError;
  error.status = status;
  return error;
}

function resolveSandboxHostUrlOverride(env: DataProxyEnv): URL | null {
  const raw = (env.SANDBOX_HOST_URL ?? '').trim();
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw createDataProxyError('SANDBOX_HOST_URL is invalid', 500);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw createDataProxyError('SANDBOX_HOST_URL must use http or https', 500);
  }
  return parsed;
}

function normalizeBaseUrl(url: URL): URL {
  const copy = new URL(url.toString());
  copy.search = '';
  copy.hash = '';
  copy.pathname = copy.pathname.replace(/\/+$/, '');
  return copy;
}

function sandboxDataProxyUrl(
  env: DataProxyEnv,
  context: DataProxyContext,
  subpath: string
): string {
  const base = resolveSandboxHostUrlOverride(env);
  const url = base ? normalizeBaseUrl(base) : new URL('http://sandbox');
  const cleanedSubpath = subpath.startsWith('/') ? subpath : `/${subpath}`;
  const workspacePath = `/v1/workspaces/${encodeURIComponent(context.orgId)}/${encodeURIComponent(context.workspaceId)}/data-proxy${cleanedSubpath}`;
  const basePath = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
  url.pathname = `${basePath}${workspacePath}`;
  return url.toString();
}

async function fetchSandboxHost(
  env: DataProxyEnv,
  url: string,
  init: RequestInit
): Promise<Response> {
  if (resolveSandboxHostUrlOverride(env)) {
    return fetch(url, init);
  }
  if (!env.SANDBOX_HOST) {
    throw createDataProxyError(
      'SANDBOX_HOST binding is not configured (or set SANDBOX_HOST_URL for local mode)',
      500
    );
  }
  return env.SANDBOX_HOST.fetch(url, init);
}

function resolveMaxResponseBytes(env: DataProxyEnv): number {
  const raw = (env.DATA_PROXY_MAX_RESPONSE_BYTES ?? '').trim();
  if (!raw) return DEFAULT_DATA_PROXY_MAX_RESPONSE_BYTES;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_DATA_PROXY_MAX_RESPONSE_BYTES;
  }
  return parsed;
}

async function readTextResponseWithLimit(response: Response, maxBytes: number): Promise<string> {
  const contentLengthRaw = response.headers.get('content-length') ?? '';
  if (contentLengthRaw) {
    const contentLength = Number.parseInt(contentLengthRaw, 10);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw createDataProxyError(
        `Data proxy response too large (${contentLength} bytes > limit ${maxBytes} bytes)`,
        413
      );
    }
  }

  if (!response.body) {
    return response.text();
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel('response exceeds max bytes');
      throw createDataProxyError(
        `Data proxy response too large (${totalBytes} bytes > limit ${maxBytes} bytes)`,
        413
      );
    }

    text += decoder.decode(value, { stream: true });
  }

  text += decoder.decode();
  return text;
}

async function readJsonResponse(response: Response, maxBytes: number): Promise<unknown> {
  const text = await readTextResponseWithLimit(response, maxBytes);
  if (!text.trim()) return {};

  try {
    return JSON.parse(text);
  } catch {
    throw createDataProxyError(
      `Data proxy returned non-JSON response (status ${response.status})`,
      502
    );
  }
}

async function proxyRequest<T>(
  env: DataProxyEnv,
  context: DataProxyContext,
  path: string,
  requestBody: unknown
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_DATA_PROXY_TIMEOUT_MS);

  try {
    const response = await fetchSandboxHost(env, sandboxDataProxyUrl(env, context, path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    const payload = await readJsonResponse(response, resolveMaxResponseBytes(env));
    if (!response.ok) {
      const objectPayload = payload as Record<string, unknown>;
      const message =
        typeof objectPayload?.error === 'string'
          ? objectPayload.error
          : `Data proxy request failed with status ${response.status}`;
      const error = createDataProxyError(message, response.status);
      if (typeof objectPayload?.code === 'string') error.code = objectPayload.code;
      if (typeof objectPayload?.number === 'number') error.number = objectPayload.number;
      throw error;
    }

    return payload as T;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw createDataProxyError(`Data proxy request timed out after ${DEFAULT_DATA_PROXY_TIMEOUT_MS}ms`, 504);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function mssqlQuery(
  env: DataProxyEnv,
  context: DataProxyContext,
  request: MssqlQueryRequest
): Promise<MssqlQueryResponse> {
  return proxyRequest<MssqlQueryResponse>(env, context, '/mssql/query', request);
}

export async function postgresQuery(
  env: DataProxyEnv,
  context: DataProxyContext,
  request: PostgresQueryRequest
): Promise<PostgresQueryResponse> {
  return proxyRequest<PostgresQueryResponse>(env, context, '/postgres/query', request);
}

export async function mysqlQuery(
  env: DataProxyEnv,
  context: DataProxyContext,
  request: MysqlQueryRequest
): Promise<MysqlQueryResponse> {
  return proxyRequest<MysqlQueryResponse>(env, context, '/mysql/query', request);
}


// =============================================================================
// MS SQL Server Types
// =============================================================================

export type SqlQueryMode = 'read' | 'modify';

export interface MssqlQueryRequest {
  mode: SqlQueryMode;
  server: string;
  port?: number;
  user: string;
  password: string;
  database?: string;
  query: string;
  params?: Record<string, unknown>;
  encrypt?: boolean;
  trustServerCertificate?: boolean;
}

export interface MssqlQueryResponse {
  recordset?: Record<string, unknown>[];
  rowsAffected?: number[];
  error?: string;
  code?: string;
  number?: number;
}

// =============================================================================
// Postgres Types
// =============================================================================

export interface PostgresQueryRequest {
  mode: SqlQueryMode;
  host: string;
  port?: number;
  user: string;
  password: string;
  database?: string;
  query: string;
  params?: unknown[];
  sslmode?: string;
}

export interface PostgresQueryResponse {
  recordset?: Record<string, unknown>[];
  rowsAffected?: number[];
  error?: string;
  code?: string;
  number?: number;
}

// =============================================================================
// MySQL Types
// =============================================================================

export interface MysqlQueryRequest {
  mode: SqlQueryMode;
  host: string;
  port?: number;
  user: string;
  password: string;
  database?: string;
  query: string;
  params?: unknown[];
  tls?: string;
  charset?: string;
}

export interface MysqlQueryResponse {
  recordset?: Record<string, unknown>[];
  rowsAffected?: number[];
  error?: string;
  code?: string;
  number?: number;
}
