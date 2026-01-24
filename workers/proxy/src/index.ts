import type { ApiTokenData } from '../../main/src/api-tokens';
import { isSignedToken, validateSignedToken } from '../../main/src/signed-tokens';

interface Env {
  TOKEN_SIGNING_SECRET?: string;
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_API_URL?: string;
  ANTHROPIC_VERSION?: string;
}

type AuthContext = {
  tokenId: string;
  token: ApiTokenData;
};

const DEFAULT_ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' },
      });
    }

    // Drop telemetry calls silently
    if (url.pathname === '/api/event_logging/batch') {
      return new Response(null, { status: 204 });
    }

    // Only POST allowed for API endpoints
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    // Validate path
    const validPaths = ['/v1/messages', '/v1/messages/count_tokens'];
    if (!validPaths.includes(url.pathname)) {
      return new Response('Not Found', { status: 404 });
    }

    // Auth
    const clientKey = extractClientKey(request);
    const authResult = await authorizeClient(clientKey, env);
    if (!authResult.ok) {
      return errorResponse(401, 'authentication_error', authResult.error ?? 'Invalid API key');
    }

    // Check Anthropic key
    if (!env.ANTHROPIC_API_KEY) {
      console.error('[proxy] missing ANTHROPIC_API_KEY');
      return errorResponse(500, 'api_error', 'Anthropic API key not configured');
    }

    // Build upstream URL
    const baseUrl = env.ANTHROPIC_API_URL || ANTHROPIC_BASE_URL;
    const upstreamUrl = new URL(url.pathname, baseUrl);
    upstreamUrl.search = url.search;

    // Build headers for Anthropic
    const headers = new Headers();
    headers.set('content-type', request.headers.get('content-type') || 'application/json');
    headers.set('x-api-key', env.ANTHROPIC_API_KEY);
    headers.set('anthropic-version', env.ANTHROPIC_VERSION || DEFAULT_ANTHROPIC_VERSION);

    // Forward relevant headers
    const forwardHeaders = ['anthropic-beta', 'anthropic-dangerous-direct-browser-access'];
    for (const h of forwardHeaders) {
      const val = request.headers.get(h);
      if (val) headers.set(h, val);
    }

    console.log('[proxy]', request.method, url.pathname);

    try {
      const response = await fetch(upstreamUrl.toString(), {
        method: 'POST',
        headers,
        body: request.body,
      });

      console.log('[proxy] upstream response', response.status);

      // Clone headers, forward response
      const responseHeaders = new Headers(response.headers);
      return new Response(response.body, {
        status: response.status,
        headers: responseHeaders,
      });
    } catch (error) {
      console.error('[proxy] fetch error', error);
      return errorResponse(502, 'api_error', 'Upstream request failed');
    }
  },
};

function extractClientKey(request: Request): string | null {
  const auth = request.headers.get('authorization');
  if (auth) {
    const [scheme, token] = auth.split(' ');
    if (scheme?.toLowerCase() === 'bearer' && token) return token.trim();
  }
  return request.headers.get('x-api-key')?.trim() || null;
}

async function authorizeClient(
  clientKey: string | null,
  env: Env
): Promise<{ ok: boolean; error?: string; auth?: AuthContext }> {
  if (!clientKey) return { ok: false, error: 'Missing API key' };
  if (!env.TOKEN_SIGNING_SECRET) return { ok: false, error: 'Token signing not configured' };

  if (!isSignedToken(clientKey)) {
    return { ok: false, error: 'Invalid API key format' };
  }

  const payload = await validateSignedToken(env.TOKEN_SIGNING_SECRET, clientKey);
  if (!payload) {
    return { ok: false, error: 'Invalid API key' };
  }

  if (!hasProxyScope(payload.scopes)) {
    return { ok: false, error: 'API key lacks proxy scope' };
  }

  const token: ApiTokenData = {
    org_id: payload.org_id,
    user_id: payload.user_id,
    integration_id: null,
    name: payload.name || 'signed-token',
    scopes: payload.scopes,
    created_at: payload.iat,
    expires_at: payload.exp,
  };
  return { ok: true, auth: { tokenId: clientKey, token } };
}

function hasProxyScope(scopes: string[] | undefined): boolean {
  if (!scopes || scopes.length === 0) return false;
  return scopes.some(
    (s) =>
      s === 'proxy' ||
      s.startsWith('proxy:') ||
      s === '*' ||
      s === 'all' ||
      s === 'admin'
  );
}

function errorResponse(status: number, type: string, message: string): Response {
  return new Response(JSON.stringify({ type: 'error', error: { type, message } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
