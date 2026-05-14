/**
 * Connections API route for sandbox containers.
 *
 * This endpoint is only trusted when called by an internal sandbox-authenticated
 * proxy that injects workspace identity.
 */

import type { RouteContext } from '../types.js';
import { validateSandboxProxy } from '../sandbox-auth.js';
import {
  findConnectionMethodEntry,
  getConnection,
  invokeConnectionMethod,
  listConnectionMethods,
  listConnections,
  listConnectionTools,
  testConnectionMethodEntry,
  type ConnectionFindQuery,
} from '../connections-runtime.js';

type ConnectionsAction =
  | { action: 'list' }
  | { action: 'get'; connection?: unknown }
  | { action: 'tools'; connection?: unknown }
  | { action: 'methods' }
  | { action: 'find'; query?: unknown }
  | { action: 'test'; query?: unknown }
  | { action: 'invoke'; connection?: unknown; method?: unknown; input?: unknown };

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(message: string, status: number, extra?: Record<string, unknown>): Response {
  return jsonResponse({ error: message, ...extra }, status);
}

function statusForError(error: unknown, fallback: number): number {
  const status = (error as { status?: unknown })?.status;
  return typeof status === 'number' ? status : fallback;
}

async function parseJSONBody(req: Request): Promise<ConnectionsAction> {
  try {
    return await req.json() as ConnectionsAction;
  } catch {
    throw Object.assign(new Error('Invalid JSON body'), { status: 400 });
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw Object.assign(new Error(`${field} is required`), { status: 400 });
  }
  return value;
}

function optionalObject(value: unknown): Record<string, unknown> {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new Error('input must be an object'), { status: 400 });
  }
  return value as Record<string, unknown>;
}

function requireFindQuery(value: unknown): ConnectionFindQuery {
  if (typeof value === 'string' && value.trim()) return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const query = value as Record<string, unknown>;
    const normalized = {
      id: typeof query.id === 'string' ? query.id : undefined,
      alias: typeof query.alias === 'string' ? query.alias : undefined,
      type: typeof query.type === 'string' ? query.type : undefined,
      name: typeof query.name === 'string' ? query.name : undefined,
    };
    if (Object.values(normalized).some((item) => typeof item === 'string' && item.trim())) {
      return normalized;
    }
  }
  throw Object.assign(new Error('query is required'), { status: 400 });
}

export async function handleConnections({ req, env }: RouteContext): Promise<Response> {
  if (req.method !== 'POST') {
    return errorResponse('Method not allowed', 405);
  }

  const auth = validateSandboxProxy(req, env);
  if (!auth.valid) {
    return errorResponse('Unauthorized: sandbox proxy auth required', 401);
  }

  try {
    const payload = await parseJSONBody(req);
    switch (payload.action) {
      case 'list':
        return jsonResponse(await listConnections(env, auth));

      case 'get':
        return jsonResponse(await getConnection(env, auth, requireString(payload.connection, 'connection')));

      case 'tools':
        return jsonResponse(await listConnectionTools(env, auth, requireString(payload.connection, 'connection')));

      case 'methods':
        return jsonResponse(await listConnectionMethods(env, auth));

      case 'find':
        return jsonResponse(await findConnectionMethodEntry(env, auth, requireFindQuery(payload.query)));

      case 'test':
        return jsonResponse(await testConnectionMethodEntry(env, auth, requireFindQuery(payload.query)));

      case 'invoke':
        return jsonResponse(await invokeConnectionMethod(
          env,
          auth,
          {
            connection: requireString(payload.connection, 'connection'),
            method: typeof payload.method === 'string' ? payload.method : undefined,
            input: optionalObject(payload.input),
          }
        ));

      default:
        return errorResponse('Unknown connections action', 400);
    }
  } catch (error) {
    console.error('[connections] request failed', {
      error: error instanceof Error ? error.message : String(error),
      orgId: auth.orgId,
      workspaceId: auth.workspaceId,
    });
    return errorResponse(
      error instanceof Error ? error.message : 'Connections request failed',
      statusForError(error, 500),
      {
        code: (error as { code?: unknown })?.code,
        data: (error as { data?: unknown })?.data,
        matches: (error as { matches?: unknown })?.matches,
      }
    );
  }
}
