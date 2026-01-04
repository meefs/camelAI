// Custom worker that wraps OpenNext and handles WebSocket + Durable Objects
// @ts-ignore - .open-next/worker.js is generated at build time
import openNextHandler from "../../../.open-next/worker.js";
import { ChatIndexDO, ChatThreadDO, type ChatEnv } from "./durable-objects.js";
import { SessionDO, UserDO, OrgDO, type AuthEnv } from "./auth.js";
import { OrgContainer, handleWebSocketUpgrade, type OrgContainerEnv } from './org-container.js';
export { DoRpcService } from './rpc-service.js';

// Export OrgContainer as ThreadSandbox to match wrangler.jsonc class_name
export { OrgContainer as ThreadSandbox };

const SESSION_COOKIE_NAME = 'chiridion_session';
const CHIRIDION_SESSION_HEADER = 'X-Chiridion-Session-Id';

function getCookieValue(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=') || '';
  }
  return null;
}

interface Env extends ChatEnv, AuthEnv, OrgContainerEnv {
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

/**
 * Return a Cloudflare API-formatted error response.
 * Wrangler expects this format to parse errors correctly.
 */
function cfApiError(code: number, message: string, status: number): Response {
  return json({
    success: false,
    errors: [{ code, message }],
    messages: [],
    result: null,
  }, { status });
}

const DISPATCH_SCRIPT_UPLOAD = /^\/client\/v4\/accounts\/[^/]+\/workers\/dispatch\/namespaces\/[^/]+\/scripts\/[^/]+$/;
const DISPATCH_SCRIPT_BASE = /^\/client\/v4\/accounts\/([^/]+)\/workers\/dispatch\/namespaces\/([^/]+)\/scripts\/([^/]+)$/;
const ASSETS_UPLOAD = /^\/client\/v4\/accounts\/[^/]+\/workers\/assets\/upload$/;

function isAllowedCloudflareApiProxyRequest(pathname: string, method: string): boolean {
  const m = method.toUpperCase();
  // All paths are rewritten to WFP dispatch namespace format
  // Base pattern: /client/v4/accounts/{account}/workers/dispatch/namespaces/{ns}/scripts/{script}
  const dispatchScript = /^\/client\/v4\/accounts\/[^/]+\/workers\/dispatch\/namespaces\/[^/]+\/scripts\/[^/]+$/;
  const dispatchScriptDeployments = /^\/client\/v4\/accounts\/[^/]+\/workers\/dispatch\/namespaces\/[^/]+\/scripts\/[^/]+\/deployments$/;
  const dispatchScriptSettings = /^\/client\/v4\/accounts\/[^/]+\/workers\/dispatch\/namespaces\/[^/]+\/scripts\/[^/]+\/settings$/;
  const dispatchAssetsUploadSession = /^\/client\/v4\/accounts\/[^/]+\/workers\/dispatch\/namespaces\/[^/]+\/scripts\/[^/]+\/assets-upload-session$/;
  const dispatchScriptSecrets = /^\/client\/v4\/accounts\/[^/]+\/workers\/dispatch\/namespaces\/[^/]+\/scripts\/[^/]+\/secrets$/;
  const dispatchScriptSecretBinding = /^\/client\/v4\/accounts\/[^/]+\/workers\/dispatch\/namespaces\/[^/]+\/scripts\/[^/]+\/secrets\/[^/]+$/;

  switch (m) {
    case 'GET':
      return dispatchScript.test(pathname) ||
        dispatchScriptDeployments.test(pathname) ||
        dispatchScriptSettings.test(pathname) ||
        dispatchScriptSecrets.test(pathname) ||
        dispatchScriptSecretBinding.test(pathname);
    case 'PUT':
      return dispatchScript.test(pathname) || dispatchScriptSecrets.test(pathname);
    case 'PATCH':
      return dispatchScriptSettings.test(pathname);
    case 'POST':
      return dispatchAssetsUploadSession.test(pathname) || ASSETS_UPLOAD.test(pathname);
    case 'DELETE':
      return dispatchScriptSecretBinding.test(pathname);
    default:
      return false;
  }
}

function isUploadRequest(pathname: string, method: string): boolean {
  const m = method.toUpperCase();
  return (m === 'PUT' && DISPATCH_SCRIPT_UPLOAD.test(pathname)) || (m === 'POST' && ASSETS_UPLOAD.test(pathname));
}

function parseMultipartUploads(body: ArrayBuffer, contentType: string) {
  const boundaryMatch = contentType.match(/boundary=([^;]+)/i);
  const boundary = boundaryMatch?.[1]?.trim().replace(/^"|"$/g, '');
  if (!boundary) {
    return null;
  }

  const decoder = new TextDecoder('utf-8');
  const text = decoder.decode(body);
  const delimiter = `--${boundary}`;
  const parts = text.split(delimiter);
  const files: string[] = [];
  const wranglerConfigs: Array<{ filename: string; content: string; size: number; truncated: boolean }> = [];
  const formParts: Array<{
    name: string | null;
    filename: string | null;
    contentType: string | null;
    size: number;
    preview: string;
    truncated: boolean;
  }> = [];
  const maxConfigLogChars = 20000;
  const maxPartLogChars = 2000;

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed || trimmed === '--') continue;

    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    const headerText = part.slice(0, headerEnd);
    const bodyText = part.slice(headerEnd + 4).replace(/\r\n$/, '');

    const dispositionMatch = headerText.match(/Content-Disposition:[^\n]*\n?/i);
    if (!dispositionMatch) continue;

    const nameMatch = headerText.match(/name="([^"]+)"/i);
    const filenameMatch = headerText.match(/filename="([^"]+)"/i);
    const contentTypeMatch = headerText.match(/Content-Type:\s*([^\r\n]+)/i);

    const name = nameMatch?.[1]?.trim() ?? null;
    const filename = filenameMatch?.[1]?.trim() ?? null;
    const partContentType = contentTypeMatch?.[1]?.trim() ?? null;
    const size = bodyText.length;

    if (filename) {
      files.push(filename);
    }

    const previewTruncated = bodyText.length > maxPartLogChars;
    const preview = previewTruncated ? `${bodyText.slice(0, maxPartLogChars)}\n...[truncated]` : bodyText;
    formParts.push({
      name,
      filename,
      contentType: partContentType,
      size,
      preview,
      truncated: previewTruncated,
    });

    const wranglerKey = filename ?? name;
    if (wranglerKey === 'wrangler.toml' || wranglerKey === 'wrangler.jsonc') {
      const truncated = bodyText.length > maxConfigLogChars;
      const content = truncated ? `${bodyText.slice(0, maxConfigLogChars)}\n...[truncated]` : bodyText;
      wranglerConfigs.push({
        filename: wranglerKey,
        content,
        size,
        truncated,
      });
    }
  }

  return { files, wranglerConfigs, formParts };
}

function deriveOrgPrefix(orgId: string): string {
  return orgId.slice(0, 32).replace(/[^a-zA-Z0-9_-]/g, '_');
}

async function resolveOrgContext(tokenKv: KVNamespace, tokenValue: string): Promise<{ orgPrefix: string; orgId: string | null }> {
  let orgPrefix = tokenValue;
  let orgId: string | null = null;

  if (tokenValue.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(tokenValue) as { orgId?: string; orgPrefix?: string };
      if (parsed.orgId) {
        orgId = parsed.orgId;
        orgPrefix = parsed.orgPrefix ?? deriveOrgPrefix(parsed.orgId);
      } else if (parsed.orgPrefix) {
        orgPrefix = parsed.orgPrefix;
      }
    } catch {
      // fall back to treating token value as prefix
      orgPrefix = tokenValue;
    }
  }

  if (!orgId) {
    const mappedOrgId = await tokenKv.get(`platform_script_prefix:${orgPrefix}`);
    if (mappedOrgId) {
      orgId = mappedOrgId;
    }
  }

  return { orgPrefix, orgId };
}

async function callCloudflareApi<T>(
  url: string,
  init: RequestInit,
  context: string
): Promise<T | null> {
  const resp = await fetch(url, init);
  if (!resp.ok) {
    const bodyText = await resp.text();
    console.warn(`[cf-api] ${context} failed`, {
      status: resp.status,
      statusText: resp.statusText,
      bodyPreview: bodyText.slice(0, 512),
    });
    return null;
  }
  const data = await resp.json() as { success?: boolean; result?: T; errors?: unknown[] };
  if (data.success === false) {
    console.warn(`[cf-api] ${context} returned error`, { errors: data.errors });
    return null;
  }
  return data.result ?? null;
}

async function listDispatchScriptSecrets(
  accountId: string,
  dispatchNamespace: string,
  scriptName: string,
  apiToken: string
): Promise<Array<{ name: string }>> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}` +
    `/workers/dispatch/namespaces/${encodeURIComponent(dispatchNamespace)}` +
    `/scripts/${encodeURIComponent(scriptName)}/secrets`;
  const headers = { Authorization: `Bearer ${apiToken}` };
  return (await callCloudflareApi<Array<{ name: string }>>(url, { method: 'GET', headers }, 'list script secrets')) ?? [];
}

async function upsertDispatchScriptSecret(
  accountId: string,
  dispatchNamespace: string,
  scriptName: string,
  apiToken: string,
  name: string,
  text: string
): Promise<void> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}` +
    `/workers/dispatch/namespaces/${encodeURIComponent(dispatchNamespace)}` +
    `/scripts/${encodeURIComponent(scriptName)}/secrets`;
  const headers = {
    Authorization: `Bearer ${apiToken}`,
    'Content-Type': 'application/json',
  };
  await callCloudflareApi(
    url,
    {
      method: 'PUT',
      headers,
      body: JSON.stringify({ name, text, type: 'secret_text' }),
    },
    `upsert script secret ${name}`
  );
}

async function deleteDispatchScriptSecret(
  accountId: string,
  dispatchNamespace: string,
  scriptName: string,
  apiToken: string,
  name: string
): Promise<void> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}` +
    `/workers/dispatch/namespaces/${encodeURIComponent(dispatchNamespace)}` +
    `/scripts/${encodeURIComponent(scriptName)}/secrets/${encodeURIComponent(name)}`;
  const headers = { Authorization: `Bearer ${apiToken}` };
  await callCloudflareApi(
    url,
    { method: 'DELETE', headers },
    `delete script secret ${name}`
  );
}

async function syncDispatchScriptSecrets(
  env: Env,
  orgId: string,
  accountId: string,
  dispatchNamespace: string,
  scriptName: string,
  apiToken: string
): Promise<void> {
  const rpc = env.DO_RPC as typeof env.DO_RPC & { [Symbol.dispose]?: () => void };
  let integrationEnvVars: Record<string, string>;
  try {
    integrationEnvVars = await rpc.getOrgIntegrationEnvVars(orgId);
  } finally {
    rpc[Symbol.dispose]?.();
  }
  const secretEntries = Object.entries(integrationEnvVars);

  if (secretEntries.length === 0) {
    const existing = await listDispatchScriptSecrets(accountId, dispatchNamespace, scriptName, apiToken);
    const managed = existing.filter(secret => secret.name.startsWith('INT_'));
    if (managed.length) {
      await Promise.all(managed.map(secret =>
        deleteDispatchScriptSecret(accountId, dispatchNamespace, scriptName, apiToken, secret.name)
      ));
    }
    return;
  }

  const existingSecrets = await listDispatchScriptSecrets(accountId, dispatchNamespace, scriptName, apiToken);
  const desiredNames = new Set(secretEntries.map(([name]) => name));
  const stale = existingSecrets.filter(secret => secret.name.startsWith('INT_') && !desiredNames.has(secret.name));

  await Promise.all(secretEntries.map(([name, value]) =>
    upsertDispatchScriptSecret(accountId, dispatchNamespace, scriptName, apiToken, name, value)
  ));

  if (stale.length) {
    await Promise.all(stale.map(secret =>
      deleteDispatchScriptSecret(accountId, dispatchNamespace, scriptName, apiToken, secret.name)
    ));
  }
}

async function proxyCloudflareApi(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);

  const upstreamApiToken = env.CF_API_TOKEN?.trim();
  if (!upstreamApiToken) {
    return cfApiError(10000, 'Missing CF_API_TOKEN for Cloudflare API proxy', 500);
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
    return cfApiError(10001, 'Authentication error: Missing deploy token', 401);
  }

  // Token -> org prefix mapping (stored in KV). If PLATFORM_SCRIPT_TOKENS isn't bound yet, fall back
  // to EMAIL_TO_USER for the proof-of-concept (prefix-isolated).
  const tokenKv = env.PLATFORM_SCRIPT_TOKENS ?? env.EMAIL_TO_USER;
  const tokenValue = await tokenKv.get(`platform_script_token:${proxyToken}`);
  if (!tokenValue) {
    console.warn('[cf-api-proxy] invalid deploy token', {
      method: request.method,
      path: url.pathname,
      tokenPrefix: proxyToken.slice(0, 8),
    });
    return cfApiError(10002, 'Authentication error: Invalid deploy token', 401);
  }
  const { orgPrefix, orgId } = await resolveOrgContext(tokenKv, tokenValue);

  const accountId = env.CF_ACCOUNT_ID?.trim();
  const dispatchNamespace = env.CF_DISPATCH_NAMESPACE?.trim();

  let pathname = url.pathname;

  // Helper to prefix script name with org ID (e.g., "my-worker" -> "abc123-my-worker")
  const prefixScriptName = (name: string) => {
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
    return `${orgPrefix}-${safeName}`.slice(0, 63);
  };

  // Rewrite WFP dispatch namespace (and optionally account id) on the fly.
  // /client/v4/accounts/:account_id/workers/dispatch/namespaces/:dispatch_namespace/...
  const dispatchMatch = pathname.match(/^\/client\/v4\/accounts\/([^\/]+)\/workers\/dispatch\/namespaces\/([^\/]+)\/(.*)$/);
  if (dispatchMatch) {
    const rest = dispatchMatch[3] ?? '';
    const rewrittenAccount = accountId ?? dispatchMatch[1]!;
    const rewrittenNs = dispatchNamespace ?? dispatchMatch[2]!;
    pathname = `/client/v4/accounts/${encodeURIComponent(rewrittenAccount)}/workers/dispatch/namespaces/${encodeURIComponent(rewrittenNs)}/${rest}`;

    // Prefix the script name with org ID
    const restUrl = `/${rest}`;
    const scriptsMatch = restUrl.match(/^\/scripts\/([^\/]+)(\/.*)?$/);
    if (scriptsMatch) {
      const userScriptName = scriptsMatch[1]!;
      const prefixedName = prefixScriptName(userScriptName);
      const tail = scriptsMatch[2] ?? '';
      pathname = `/client/v4/accounts/${encodeURIComponent(rewrittenAccount)}/workers/dispatch/namespaces/${encodeURIComponent(rewrittenNs)}/scripts/${encodeURIComponent(prefixedName)}${tail}`;
    }
  }
  // Convert regular worker script calls to WFP dispatch namespace format when configured.
  // This allows wrangler in the container to use standard deploy commands while we route to WFP.
  if (!dispatchMatch) {
    const scriptsMatch = pathname.match(/^\/client\/v4\/accounts\/([^\/]+)\/workers\/scripts\/([^\/]+)(\/.*)?$/);
    if (scriptsMatch) {
      const rewrittenAccount = accountId ?? scriptsMatch[1]!;
      const userScriptName = scriptsMatch[2]!;
      const prefixedName = prefixScriptName(userScriptName);
      const tail = scriptsMatch[3] ?? '';
      if (dispatchNamespace) {
        // Rewrite to WFP dispatch namespace format with prefixed name
        pathname = `/client/v4/accounts/${encodeURIComponent(rewrittenAccount)}/workers/dispatch/namespaces/${encodeURIComponent(dispatchNamespace)}/scripts/${encodeURIComponent(prefixedName)}${tail}`;
      } else {
        // Just prefix the script name
        pathname = `/client/v4/accounts/${encodeURIComponent(rewrittenAccount)}/workers/scripts/${encodeURIComponent(prefixedName)}${tail}`;
      }
    }

    // Rewrite /workers/services/{name} to WFP dispatch namespace format
    // Wrangler uses this to check if a worker exists before deploying
    const servicesMatch = pathname.match(/^\/client\/v4\/accounts\/([^\/]+)\/workers\/services\/([^\/]+)(\/.*)?$/);
    if (servicesMatch && dispatchNamespace) {
      const rewrittenAccount = accountId ?? servicesMatch[1]!;
      const userScriptName = servicesMatch[2]!;
      const prefixedName = prefixScriptName(userScriptName);
      const tail = servicesMatch[3] ?? '';
      pathname = `/client/v4/accounts/${encodeURIComponent(rewrittenAccount)}/workers/dispatch/namespaces/${encodeURIComponent(dispatchNamespace)}/scripts/${encodeURIComponent(prefixedName)}${tail}`;
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
    return cfApiError(10003, 'Forbidden: Request blocked by API proxy allowlist', 403);
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

  if (body && isUploadRequest(pathname, method)) {
    const contentType = request.headers.get('Content-Type') ?? '';
    if (contentType.toLowerCase().includes('multipart/form-data')) {
      const uploadInfo = parseMultipartUploads(body, contentType);
      if (uploadInfo?.files.length) {
        console.log('[cf-api-proxy] upload files', {
          method,
          path: pathname,
          files: uploadInfo.files,
        });
      }
      if (uploadInfo?.formParts.length) {
        console.log('[cf-api-proxy] upload form parts', {
          method,
          path: pathname,
          partCount: uploadInfo.formParts.length,
          parts: uploadInfo.formParts,
        });
      }
      if (uploadInfo?.wranglerConfigs.length) {
        for (const config of uploadInfo.wranglerConfigs) {
          console.log('[cf-api-proxy] wrangler config upload', {
            method,
            path: pathname,
            filename: config.filename,
            size: config.size,
            truncated: config.truncated,
            content: config.content,
          });
        }
      }
    }
  }

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
    return new Response(respBody, { status: resp.status, headers: resp.headers });
  }

  if (method === 'PUT') {
    const scriptMatch = pathname.match(DISPATCH_SCRIPT_BASE);
    if (scriptMatch) {
      const account = decodeURIComponent(scriptMatch[1]!);
      const dispatchNs = decodeURIComponent(scriptMatch[2]!);
      const scriptName = decodeURIComponent(scriptMatch[3]!);
      if (!orgId) {
        console.warn('[cf-api-proxy] unable to resolve org for script secrets sync', {
          account,
          dispatchNamespace: dispatchNs,
          scriptName,
          orgPrefix,
        });
      } else {
        ctx.waitUntil(
          syncDispatchScriptSecrets(env, orgId, account, dispatchNs, scriptName, upstreamApiToken)
            .catch(err => {
              console.error('[cf-api-proxy] failed to sync script secrets', {
                account,
                dispatchNamespace: dispatchNs,
                scriptName,
                orgId,
                error: String(err),
              });
            })
        );
      }
    }
  }

  return new Response(respBody, { status: resp.status, headers: resp.headers });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Cloudflare API proxy for Wrangler: set `CLOUDFLARE_API_BASE_URL` to `${origin}/client/v4`.
    if (url.pathname.startsWith('/client/v4/')) {
      try {
        return await proxyCloudflareApi(request, env, ctx);
      } catch (e) {
        return cfApiError(10004, `Cloudflare API proxy failed: ${String(e)}`, 502);
      }
    }

    // Handle WebSocket upgrade for thread preview state at /ws/thread/{threadId}
    const threadWsMatch = url.pathname.match(/^\/ws\/thread\/([^\/]+)$/);
    if (threadWsMatch && request.headers.get('Upgrade') === 'websocket') {
      const threadId = threadWsMatch[1];

      // Authenticate the request
      const headerSessionId = request.headers.get(CHIRIDION_SESSION_HEADER);
      const cookieSessionId = getCookieValue(request.headers.get('Cookie'), SESSION_COOKIE_NAME);
      const sessionId = headerSessionId || cookieSessionId;

      if (!sessionId) {
        return new Response('Unauthorized', { status: 401 });
      }

      const sessionStub = env.SESSION.get(env.SESSION.idFromName(sessionId));
      const session = await sessionStub.getData();
      if (!session) {
        return new Response('Unauthorized', { status: 401 });
      }

      // Verify thread belongs to user's org (prevents cross-tenant leak)
      const indexStub = env.CHAT_INDEX.get(env.CHAT_INDEX.idFromName(session.org_id));
      const thread = await indexStub.getThread(threadId);
      if (!thread) {
        return new Response('Thread not found', { status: 404 });
      }

      // Route to thread DO for preview state updates
      const threadStub = env.CHAT_THREAD.get(env.CHAT_THREAD.idFromName(threadId));
      return threadStub.fetch(request);
    }

    // Handle WebSocket upgrade requests at /ws/{org}
    // The org is used to route to the correct container (one per org)
    // Thread/session management happens in the WebSocket protocol
    const wsMatch = url.pathname.match(/^\/ws\/([^\/]+)$/);
    if (wsMatch && request.headers.get('Upgrade') === 'websocket') {
      const orgFromPath = wsMatch[1];

      console.log('[ws] WebSocket upgrade request received', {
        path: url.pathname,
        orgFromPath,
        upgrade: request.headers.get('Upgrade'),
        connection: request.headers.get('Connection'),
        secWebSocketKey: request.headers.get('Sec-WebSocket-Key') ? 'present' : 'missing',
        secWebSocketVersion: request.headers.get('Sec-WebSocket-Version'),
      });

      // Authenticate the request
      const headerSessionId = request.headers.get(CHIRIDION_SESSION_HEADER);
      const cookieSessionId = getCookieValue(request.headers.get('Cookie'), SESSION_COOKIE_NAME);
      const sessionId = headerSessionId || cookieSessionId;

      if (!sessionId) {
        console.log('[ws] No session ID found, returning 401');
        return new Response('Unauthorized', { status: 401 });
      }

      const sessionStub = env.SESSION.get(env.SESSION.idFromName(sessionId));
      const session = await sessionStub.getData();
      if (!session) {
        console.log('[ws] Invalid session, returning 401', { sessionId });
        return new Response('Unauthorized', { status: 401 });
      }

      // Use the org from session (ignore path org for security)
      const org = session.org_id;
      if (!org) {
        console.log('[ws] No org in session, returning 400', { sessionId });
        return new Response('No organization selected', { status: 400 });
      }

      console.log('[ws] Authenticated, forwarding to container', {
        sessionId,
        org,
        userId: session.user_id,
      });

      // Handle WebSocket upgrade with container management
      return handleWebSocketUpgrade(request, env, org);
    }

    // Handle preview API with deploy token auth (called from container wrangler wrapper)
    const previewMatch = url.pathname.match(/^\/api\/threads\/([^\/]+)\/preview$/);
    if (previewMatch && request.method === 'POST') {
      const threadId = previewMatch[1];

      // Validate deploy token
      const authHeader = request.headers.get('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return new Response(JSON.stringify({ error: 'Missing authorization' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const token = authHeader.slice(7);
      const tokenKv = env.PLATFORM_SCRIPT_TOKENS ?? env.EMAIL_TO_USER;
      const orgPrefix = await tokenKv.get(`platform_script_token:${token}`);
      if (!orgPrefix) {
        return new Response(JSON.stringify({ error: 'Invalid token' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Parse body and set preview
      try {
        const body = await request.json() as { workers?: string[] };
        if (!body.workers || !Array.isArray(body.workers)) {
          return new Response(JSON.stringify({ error: 'Missing workers array' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        const threadStub = env.CHAT_THREAD.get(env.CHAT_THREAD.idFromName(threadId));
        const response = await threadStub.fetch(new Request('http://internal/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workers: body.workers }),
        }));

        return new Response(response.body, {
          status: response.status,
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // Pass all other requests to OpenNext/Next.js if dev env var is not set
	if (env.NEXTJS_ENV == 'development') {
	  return new Response('Not Found', { status: 404 });
	}
    return openNextHandler.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

// Export Durable Object classes
export { ChatIndexDO, ChatThreadDO };
export { SessionDO, UserDO, OrgDO };
