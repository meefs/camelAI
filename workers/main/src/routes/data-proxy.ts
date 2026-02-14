/**
 * Data Proxy API Routes
 *
 * Exposes HTTP endpoints for accessing data sources via the DataProxy container.
 * Requires a signed token with 'data-proxy' scope.
 */

import type { Env } from '../types.js';
import { isSignedToken, validateSignedToken } from '../signed-tokens.js';
import { validateSandboxProxy } from '../sandbox-auth.js';
import type { MssqlQueryRequest } from '../data-proxy.js';

/**
 * Extract Bearer token from Authorization header
 */
function extractBearerToken(request: Request): string | null {
  const authHeader = request.headers.get('Authorization') ?? '';
  const match = authHeader.match(/^Bearer\s+(.+)\s*$/i);
  return match?.[1]?.trim() || null;
}

/**
 * Create error response
 */
function errorResponse(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Validate token and check for data-proxy scope
 */
async function validateDataProxyToken(
  request: Request,
  env: Env
): Promise<{ valid: true; orgId: string; workspaceId?: string } | { valid: false; response: Response }> {
  // Check sandbox proxy secret first (static secret from sandbox host)
  const proxyAuth = validateSandboxProxy(request, env);
  if (proxyAuth.valid) {
    return {
      valid: true,
      orgId: proxyAuth.orgId,
      workspaceId: proxyAuth.workspaceId,
    };
  }

  // Fall back to signed token validation
  const token = extractBearerToken(request);

  if (!token) {
    return {
      valid: false,
      response: errorResponse('Missing Authorization header', 401),
    };
  }

  if (!isSignedToken(token)) {
    return {
      valid: false,
      response: errorResponse('Invalid token format', 401),
    };
  }

  const payload = await validateSignedToken(env.TOKEN_SIGNING_SECRET, token);
  if (!payload) {
    return {
      valid: false,
      response: errorResponse('Invalid or expired token', 401),
    };
  }

  if (!payload.scopes.includes('data-proxy')) {
    return {
      valid: false,
      response: errorResponse('Token lacks data-proxy scope', 403),
    };
  }

  return {
    valid: true,
    orgId: payload.org_id,
    workspaceId: payload.workspace_id,
  };
}

// =============================================================================
// MS SQL Server Routes
// =============================================================================

/**
 * POST /api/mssql/query
 *
 * Execute a SQL query against an MS SQL Server.
 */
export async function handleMssqlQuery(
  request: Request,
  env: Env
): Promise<Response> {
  // Validate token
  const auth = await validateDataProxyToken(request, env);
  if (!auth.valid) {
    return auth.response;
  }

  // Parse request body
  let body: MssqlQueryRequest;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  // Validate required fields
  if (!body.server || !body.user || !body.password || !body.query) {
    return errorResponse('Missing required fields: server, user, password, query', 400);
  }

  // Get the shared proxy instance
  const proxyId = env.DATA_PROXY.idFromName('default');
  const proxy = env.DATA_PROXY.get(proxyId);

  try {
    const result = await proxy.mssqlQuery(body);
    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('[data-proxy] mssql query error:', error);
    return errorResponse(
      error instanceof Error ? error.message : 'Query execution failed',
      500
    );
  }
}

// =============================================================================
// Health Routes
// =============================================================================

/**
 * GET /api/data-proxy/health
 *
 * Check if the data proxy container is running.
 */
export async function handleDataProxyHealth(
  request: Request,
  env: Env
): Promise<Response> {
  // Validate token
  const auth = await validateDataProxyToken(request, env);
  if (!auth.valid) {
    return auth.response;
  }

  const proxyId = env.DATA_PROXY.idFromName('default');
  const proxy = env.DATA_PROXY.get(proxyId);

  try {
    const result = await proxy.health();
    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('[data-proxy] health check error:', error);
    return errorResponse('Data proxy container unavailable', 503);
  }
}
