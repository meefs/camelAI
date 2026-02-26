/**
 * Data Proxy API routes for sandbox containers.
 *
 * These endpoints are only trusted when forwarded through sandbox-host's
 * `/proxy/:threadId/*` path, which injects `x-sandbox-secret` and workspace identity.
 */

import type { RouteContext } from '../types.js';
import { validateSandboxProxy } from '../sandbox-auth.js';
import {
  mssqlQuery as runMssqlQuery,
  postgresQuery as runPostgresQuery,
  mysqlQuery as runMySQLQuery,
  type MssqlQueryRequest,
  type PostgresQueryRequest,
  type MysqlQueryRequest,
} from '../data-proxy.js';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(message: string, status: number): Response {
  return jsonResponse({ error: message }, status);
}

function statusForError(error: unknown, fallback: number): number {
  const status = (error as { status?: unknown })?.status;
  return typeof status === 'number' ? status : fallback;
}

async function parseJSONBody<T>(req: Request): Promise<T> {
  try {
    return await req.json() as T;
  } catch {
    throw createBadRequestError('Invalid JSON body');
  }
}

function createBadRequestError(message: string): Error & { status: number } {
  const error = new Error(message) as Error & { status: number };
  error.status = 400;
  return error;
}

function requireSandboxProxyAuth({ req, env }: Pick<RouteContext, 'req' | 'env'>):
  | { valid: true; orgId: string; workspaceId: string }
  | { valid: false; response: Response } {
  const proxyAuth = validateSandboxProxy(req, env);
  if (!proxyAuth.valid) {
    return {
      valid: false,
      response: errorResponse('Unauthorized: sandbox proxy auth required', 401),
    };
  }
  return {
    valid: true,
    orgId: proxyAuth.orgId,
    workspaceId: proxyAuth.workspaceId,
  };
}

/**
 * POST /api/mssql/query
 */
export async function handleMssqlQuery({ req, env }: RouteContext): Promise<Response> {
  if (req.method !== 'POST') {
    return errorResponse('Method not allowed', 405);
  }

  const auth = requireSandboxProxyAuth({ req, env });
  if (!auth.valid) {
    return auth.response;
  }

  try {
    const payload = await parseJSONBody<MssqlQueryRequest>(req);
    const upstream = await runMssqlQuery(env, {
      orgId: auth.orgId,
      workspaceId: auth.workspaceId,
    }, payload);
    return jsonResponse(upstream, 200);
  } catch (error) {
    console.error('[data-proxy] mssql query error', {
      error: error instanceof Error ? error.message : String(error),
      orgId: auth.orgId,
      workspaceId: auth.workspaceId,
    });
    return errorResponse(
      error instanceof Error ? error.message : 'Query execution failed',
      statusForError(error, 500)
    );
  }
}

/**
 * POST /api/postgres/query
 */
export async function handlePostgresQuery({ req, env }: RouteContext): Promise<Response> {
  if (req.method !== 'POST') {
    return errorResponse('Method not allowed', 405);
  }

  const auth = requireSandboxProxyAuth({ req, env });
  if (!auth.valid) {
    return auth.response;
  }

  try {
    const payload = await parseJSONBody<PostgresQueryRequest>(req);
    const upstream = await runPostgresQuery(env, {
      orgId: auth.orgId,
      workspaceId: auth.workspaceId,
    }, payload);
    return jsonResponse(upstream, 200);
  } catch (error) {
    console.error('[data-proxy] postgres query error', {
      error: error instanceof Error ? error.message : String(error),
      orgId: auth.orgId,
      workspaceId: auth.workspaceId,
    });
    return errorResponse(
      error instanceof Error ? error.message : 'Query execution failed',
      statusForError(error, 500)
    );
  }
}

/**
 * POST /api/mysql/query
 */
export async function handleMysqlQuery({ req, env }: RouteContext): Promise<Response> {
  if (req.method !== 'POST') {
    return errorResponse('Method not allowed', 405);
  }

  const auth = requireSandboxProxyAuth({ req, env });
  if (!auth.valid) {
    return auth.response;
  }

  try {
    const payload = await parseJSONBody<MysqlQueryRequest>(req);
    const upstream = await runMySQLQuery(env, {
      orgId: auth.orgId,
      workspaceId: auth.workspaceId,
    }, payload);
    return jsonResponse(upstream, 200);
  } catch (error) {
    console.error('[data-proxy] mysql query error', {
      error: error instanceof Error ? error.message : String(error),
      orgId: auth.orgId,
      workspaceId: auth.workspaceId,
    });
    return errorResponse(
      error instanceof Error ? error.message : 'Query execution failed',
      statusForError(error, 500)
    );
  }
}
