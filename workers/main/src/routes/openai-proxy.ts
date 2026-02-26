/**
 * OpenAI-compatible proxy route for sandbox containers.
 *
 * Trust boundary: requests must be forwarded through sandbox-host `/proxy/:threadId/*`,
 * which injects sandbox identity headers verified by `validateSandboxProxy`.
 */

import type { RouteContext } from '../types.js';
import { validateSandboxProxy } from '../sandbox-auth.js';
import { proxyOpenAIRequest } from '../openai-proxy.js';

const ROUTE_PREFIX = '/api/openai';

function unauthorizedResponse(): Response {
  return new Response(JSON.stringify({ error: 'Unauthorized: sandbox proxy auth required' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function handleOpenAIProxy({ req, env, url }: RouteContext): Promise<Response> {
  const proxyAuth = validateSandboxProxy(req, env);
  if (!proxyAuth.valid) {
    return unauthorizedResponse();
  }

  const pathname = url.pathname;
  if (!pathname.startsWith(ROUTE_PREFIX + '/')) {
    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const subpath = pathname.slice(ROUTE_PREFIX.length);
  if (!subpath.startsWith('/v1')) {
    return new Response(JSON.stringify({ error: 'Invalid OpenAI proxy path' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const threadId = req.headers.get('x-chiridion-thread-id') ?? undefined;

  try {
    const upstream = await proxyOpenAIRequest(env, {
      orgId: proxyAuth.orgId,
      workspaceId: proxyAuth.workspaceId,
      userId: proxyAuth.userId,
      threadId,
    }, req, subpath);
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    });
  } catch (error) {
    console.error('[openai-proxy] request failed', {
      error: error instanceof Error ? error.message : String(error),
      orgId: proxyAuth.orgId,
      workspaceId: proxyAuth.workspaceId,
      path: subpath,
    });
    return new Response(JSON.stringify({ error: 'OpenAI proxy request failed' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
