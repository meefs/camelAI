// Custom worker that wraps OpenNext and handles WebSocket + Durable Objects
// @ts-ignore - .open-next/worker.js is generated at build time
import openNextHandler from "../.open-next/worker.js";
import { ChatIndexDO, ChatThreadDO, type ChatEnv } from "./durable-objects.js";
import { SessionDO, UserDO, OrgDO, type AuthEnv } from "./auth.js";
import { Sandbox } from '@cloudflare/sandbox';

// Export Sandbox as ThreadSandbox to match wrangler.jsonc class_name
export { Sandbox as ThreadSandbox };

interface Env extends ChatEnv, AuthEnv {
  ASSETS: Fetcher;
  NEXTJS_ENV?: string;
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  CF_DISPATCH_NAMESPACE?: string;
  PLATFORM_SCRIPT_TOKENS?: KVNamespace;
}

const CHIRIDION_DEPLOY_TOKEN_HEADER = 'X-Chiridion-Deploy-Token';

function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
}

function isAllowedCloudflareApiProxyRequest(pathname: string, method: string): boolean {
  const m = method.toUpperCase();
  const dispatchScript = /^\/client\/v4\/accounts\/[^/]+\/workers\/dispatch\/namespaces\/[^/]+\/scripts\/[^/]+$/;
  const scriptSettings = /^\/client\/v4\/accounts\/[^/]+\/workers\/scripts\/[^/]+\/settings$/;
  const assetsUploadSession = /^\/client\/v4\/accounts\/[^/]+\/workers\/dispatch\/namespaces\/[^/]+\/scripts\/[^/]+\/assets-upload-session$/;
  const assetsUpload = /^\/client\/v4\/accounts\/[^/]+\/workers\/assets\/upload$/;

  switch (m) {
    case 'GET':
      return dispatchScript.test(pathname) || scriptSettings.test(pathname);
    case 'PUT':
      return dispatchScript.test(pathname);
    case 'PATCH':
      return scriptSettings.test(pathname);
    case 'POST':
      return assetsUploadSession.test(pathname) || assetsUpload.test(pathname);
    default:
      return false;
  }
}

async function proxyCloudflareApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  const upstreamApiToken = env.CF_API_TOKEN?.trim();
  if (!upstreamApiToken) {
    return json({ error: 'Missing CF_API_TOKEN for Cloudflare API proxy' }, { status: 500 });
  }

  console.log('[cf-api-proxy] request', {
    method: request.method,
    path: url.pathname,
    search: url.search,
  });

  const proxyToken =
    request.headers.get(CHIRIDION_DEPLOY_TOKEN_HEADER)?.trim() ||
    (() => {
      const authHeader = request.headers.get('Authorization') ?? '';
      const bearerMatch = authHeader.match(/^Bearer\s+(.+)\s*$/i);
      return bearerMatch?.[1]?.trim() || null;
    })();

  if (!proxyToken) {
    console.warn('[cf-api-proxy] missing deploy token', {
      method: request.method,
      path: url.pathname,
      hasAuthorizationHeader: !!request.headers.get('Authorization'),
      hasDeployTokenHeader: !!request.headers.get(CHIRIDION_DEPLOY_TOKEN_HEADER),
    });
    return json({ error: 'Missing deploy token' }, { status: 401 });
  }

  // Token -> script name mapping (stored in KV). If PLATFORM_SCRIPT_TOKENS isn't bound yet, fall back
  // to EMAIL_TO_USER for the proof-of-concept (prefix-isolated).
  const tokenKv = env.PLATFORM_SCRIPT_TOKENS ?? env.EMAIL_TO_USER;
  const scriptNameForToken = await tokenKv.get(`platform_script_token:${proxyToken}`);
  if (!scriptNameForToken) {
    console.warn('[cf-api-proxy] invalid deploy token', {
      method: request.method,
      path: url.pathname,
      tokenPrefix: proxyToken.slice(0, 8),
    });
    return json({ error: 'Invalid deploy token' }, { status: 401 });
  }

  const accountId = env.CF_ACCOUNT_ID?.trim();
  const dispatchNamespace = env.CF_DISPATCH_NAMESPACE?.trim();

  let pathname = url.pathname;

  // Rewrite WFP dispatch namespace (and optionally account id) on the fly.
  // /client/v4/accounts/:account_id/workers/dispatch/namespaces/:dispatch_namespace/...
  const dispatchMatch = pathname.match(/^\/client\/v4\/accounts\/([^\/]+)\/workers\/dispatch\/namespaces\/([^\/]+)\/(.*)$/);
  if (dispatchMatch) {
    const rest = dispatchMatch[3] ?? '';
    const rewrittenAccount = accountId ?? dispatchMatch[1]!;
    const rewrittenNs = dispatchNamespace ?? dispatchMatch[2]!;
    pathname = `/client/v4/accounts/${encodeURIComponent(rewrittenAccount)}/workers/dispatch/namespaces/${encodeURIComponent(rewrittenNs)}/${rest}`;

    // If token has a mapped script name, override it in the URL.
    if (scriptNameForToken) {
      const restUrl = `/${rest}`;
      const scriptsMatch = restUrl.match(/^\/scripts\/([^\/]+)(\/.*)?$/);
      if (scriptsMatch) {
        const tail = scriptsMatch[2] ?? '';
        pathname = `/client/v4/accounts/${encodeURIComponent(rewrittenAccount)}/workers/dispatch/namespaces/${encodeURIComponent(rewrittenNs)}/scripts/${encodeURIComponent(scriptNameForToken)}${tail}`;
      }
    }
  }
  // Also override the script name for the "workers/scripts/:scriptName/*" API family.
  if (!dispatchMatch && scriptNameForToken) {
    const scriptsMatch = pathname.match(/^\/client\/v4\/accounts\/([^\/]+)\/workers\/scripts\/([^\/]+)(\/.*)?$/);
    if (scriptsMatch) {
      const rewrittenAccount = accountId ?? scriptsMatch[1]!;
      const tail = scriptsMatch[3] ?? '';
      pathname = `/client/v4/accounts/${encodeURIComponent(rewrittenAccount)}/workers/scripts/${encodeURIComponent(scriptNameForToken)}${tail}`;
    }
  }

  // Opportunistically rewrite account id for any /accounts/:id/... calls.
  if (accountId) {
    const accountMatch = pathname.match(/^\/client\/v4\/accounts\/([^\/]+)\/(.*)$/);
    if (accountMatch) {
      pathname = `/client/v4/accounts/${encodeURIComponent(accountId)}/${accountMatch[2] ?? ''}`;
    }
  }

  if (!isAllowedCloudflareApiProxyRequest(pathname, request.method)) {
    console.warn('[cf-api-proxy] blocked', {
      method: request.method,
      originalPath: url.pathname,
      rewrittenPath: pathname,
      search: url.search,
      hasToken: true,
    });
    return json({ error: 'Blocked by API proxy allowlist' }, { status: 403 });
  }

  const upstreamUrl = new URL(`https://api.cloudflare.com${pathname}${url.search}`);
  const headers = new Headers(request.headers);

  // Always use our Worker token when proxying (POC).
  headers.set('Authorization', `Bearer ${upstreamApiToken}`);
  headers.delete('cookie');
  headers.delete('host');

  const method = request.method.toUpperCase();
  const body =
    method === 'GET' || method === 'HEAD'
      ? undefined
      : await request.arrayBuffer();

  const resp = await fetch(upstreamUrl, { method, headers, body });
  const respBody = await resp.arrayBuffer();

  if (!resp.ok) {
    const ct = resp.headers.get('Content-Type') ?? '';
    let preview = '';
    if (ct.includes('application/json') || ct.startsWith('text/')) {
      try {
        preview = new TextDecoder().decode(respBody.slice(0, 1024));
      } catch {
        preview = '';
      }
    }
    console.warn('[cf-api-proxy] upstream error', {
      status: resp.status,
      method,
      upstreamPath: upstreamUrl.pathname,
      search: upstreamUrl.search,
      contentType: ct,
      bodyPreview: preview,
    });
  }

  return new Response(respBody, { status: resp.status, headers: resp.headers });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Cloudflare API proxy for Wrangler: set `CLOUDFLARE_API_BASE_URL` to `${origin}/client/v4`.
    if (url.pathname.startsWith('/client/v4/')) {
      try {
        return await proxyCloudflareApi(request, env);
      } catch (e) {
        return json({ error: `Cloudflare API proxy failed: ${String(e)}` }, { status: 502 });
      }
    }

    // Handle WebSocket upgrade requests at /ws/{threadId}
    const wsMatch = url.pathname.match(/^\/ws\/([^\/]+)$/);
    if (wsMatch && request.headers.get('Upgrade') === 'websocket') {
      const threadId = wsMatch[1];
      const threadStub = env.CHAT_THREAD.get(env.CHAT_THREAD.idFromName(threadId));
      // Forward the upgrade request directly. The DO reads the external origin from forwarded headers.
      return threadStub.fetch(request);
    }

    // Pass all other requests to OpenNext/Next.js
    return openNextHandler.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

// Export Durable Object classes
export { ChatIndexDO, ChatThreadDO };
export { SessionDO, UserDO, OrgDO };

// Re-export OpenNext's DO handlers if needed for caching
// @ts-ignore - .open-next/worker.js is generated at build time
export { DOQueueHandler, DOShardedTagCache } from "../.open-next/worker.js";
