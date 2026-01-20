/**
 * Cloudflare API Proxy
 *
 * Handles proxying wrangler deploy requests to Cloudflare's API.
 * Provides auth, path rewriting, and post-deploy side effects.
 */

import { isSignedToken, validateSignedToken } from './signed-tokens.js';

// Re-export for index.ts to use
export const CHIRIDION_DEPLOY_TOKEN_HEADER = 'X-Chiridion-Deploy-Token';

const DISPATCH_SCRIPT_UPLOAD = /^\/client\/v4\/accounts\/[^/]+\/workers\/dispatch\/namespaces\/[^/]+\/scripts\/[^/]+$/;
const DISPATCH_SCRIPT_BASE = /^\/client\/v4\/accounts\/([^/]+)\/workers\/dispatch\/namespaces\/([^/]+)\/scripts\/([^/]+)$/;
const DISPATCH_SCRIPT_ANY = /^\/client\/v4\/accounts\/[^/]+\/workers\/dispatch\/namespaces\/[^/]+\/scripts\/([^/]+)(?:\/|$)/;
const ASSETS_UPLOAD = /^\/client\/v4\/accounts\/[^/]+\/workers\/assets\/upload$/;
const SCRIPT_ORG_PREFIX = 'script_org:';

export interface CfApiProxyEnv {
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  CF_DISPATCH_NAMESPACE?: string;
  TOKEN_SIGNING_SECRET: string;
  EMAIL_TO_USER: KVNamespace;
  API_TOKENS: KVNamespace;
  WORKSPACE: DurableObjectNamespace;
  ORG: DurableObjectNamespace;
  CHAT_THREAD: DurableObjectNamespace;
  DO_RPC: Service;
  WORKER_BASE_URL?: string;
}

export interface DeploySideEffectsInfo {
  scriptName: string;
  orgId: string;
  workspaceId: string;
  hostname: string;
  threadId?: string;
}

/**
 * Return a Cloudflare API-formatted error response.
 * Wrangler expects this format to parse errors correctly.
 */
export function cfApiError(code: number, message: string, status: number): Response {
  return new Response(JSON.stringify({
    success: false,
    errors: [{ code, message }],
    messages: [],
    result: null,
  }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Extract environment prefix from hostname.
 * E.g., "staging.chiridion.ai" -> "staging", "chiridion.ai" -> ""
 */
export function getEnvPrefix(hostname: string): string {
  if (hostname.endsWith('.chiridion.ai') || hostname === 'chiridion.ai') {
    const parts = hostname.split('.');
    if (parts.length <= 2 || parts[0] === 'www') {
      return '';
    }
    return parts[0] ?? '';
  }

  if (hostname === 'localhost' || hostname.startsWith('127.0.0.1') || hostname.endsWith('.local')) {
    return 'local';
  }

  return '';
}

/**
 * Resolve environment prefix, preferring WORKER_BASE_URL if set.
 */
export function resolveEnvPrefix(baseUrl: string | undefined, hostname: string): string {
  if (baseUrl) {
    try {
      return getEnvPrefix(new URL(baseUrl).hostname);
    } catch {
      return getEnvPrefix(hostname);
    }
  }
  return getEnvPrefix(hostname);
}

/**
 * Build the vanity domain for a deployed script based on environment.
 * E.g., "my-app" in staging -> "https://my-app.staging.chiridion.app"
 */
function buildDeployUrl(scriptName: string, envPrefix: string): string {
  if (envPrefix) {
    return `https://${scriptName}.${envPrefix}.chiridion.app`;
  }
  // Prod has no prefix
  return `https://${scriptName}.chiridion.app`;
}

/**
 * Extract script name from a dispatch namespace API path.
 */
function extractScriptName(pathname: string): string | null {
  const match = pathname.match(DISPATCH_SCRIPT_ANY);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1] ?? '').trim() || null;
  } catch {
    return match[1]?.trim() || null;
  }
}

/**
 * Check if a script is owned by a different org.
 * Returns null if not owned, the owning org_id if owned by same org, or throws if owned by different org.
 */
async function checkScriptOwnership(
  kv: KVNamespace,
  scriptName: string,
  requestingOrgId: string
): Promise<{ owned: boolean; orgId: string | null }> {
  const data = await kv.get(`${SCRIPT_ORG_PREFIX}${scriptName}`);
  if (!data) {
    return { owned: false, orgId: null };
  }
  try {
    const parsed = JSON.parse(data) as { org_id: string; is_public?: boolean };
    return { owned: true, orgId: parsed.org_id };
  } catch {
    // Legacy format: just org_id string
    return { owned: true, orgId: data };
  }
}

function isAllowedCloudflareApiProxyRequest(pathname: string, method: string): boolean {
  const m = method.toUpperCase();
  // All paths are rewritten to WFP dispatch namespace format
  // Base pattern: /client/v4/accounts/{account}/workers/dispatch/namespaces/{ns}/scripts/{script}
  const dispatchScript = /^\/client\/v4\/accounts\/[^/]+\/workers\/dispatch\/namespaces\/[^/]+\/scripts\/[^/]+$/;
  const dispatchScriptDeployments = /^\/client\/v4\/accounts\/[^/]+\/workers\/dispatch\/namespaces\/[^/]+\/scripts\/[^/]+\/deployments$/;
  const dispatchScriptSettings = /^\/client\/v4\/accounts\/[^/]+\/workers\/dispatch\/namespaces\/[^/]+\/scripts\/[^/]+\/settings$/;
  const dispatchScriptScriptSettings = /^\/client\/v4\/accounts\/[^/]+\/workers\/dispatch\/namespaces\/[^/]+\/scripts\/[^/]+\/script-settings$/;
  const dispatchAssetsUploadSession = /^\/client\/v4\/accounts\/[^/]+\/workers\/dispatch\/namespaces\/[^/]+\/scripts\/[^/]+\/assets-upload-session$/;
  const dispatchScriptSecrets = /^\/client\/v4\/accounts\/[^/]+\/workers\/dispatch\/namespaces\/[^/]+\/scripts\/[^/]+\/secrets$/;
  const dispatchScriptSecretBinding = /^\/client\/v4\/accounts\/[^/]+\/workers\/dispatch\/namespaces\/[^/]+\/scripts\/[^/]+\/secrets\/[^/]+$/;
  const dispatchScriptVersions = /^\/client\/v4\/accounts\/[^/]+\/workers\/dispatch\/namespaces\/[^/]+\/scripts\/[^/]+\/versions$/;

  switch (m) {
    case 'GET':
      return dispatchScript.test(pathname) ||
        dispatchScriptDeployments.test(pathname) ||
        dispatchScriptSettings.test(pathname) ||
        dispatchScriptSecrets.test(pathname) ||
        dispatchScriptSecretBinding.test(pathname) ||
        dispatchScriptVersions.test(pathname);
    case 'PUT':
      return dispatchScript.test(pathname) || dispatchScriptSecrets.test(pathname);
    case 'PATCH':
      return dispatchScriptSettings.test(pathname) || dispatchScriptScriptSettings.test(pathname);
    case 'POST':
      return dispatchAssetsUploadSession.test(pathname) ||
        dispatchScriptVersions.test(pathname) ||
        ASSETS_UPLOAD.test(pathname);
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
  env: CfApiProxyEnv,
  workspaceId: string,
  orgId: string,
  accountId: string,
  dispatchNamespace: string,
  scriptName: string,
  apiToken: string
): Promise<void> {
  const rpc = env.DO_RPC as typeof env.DO_RPC & { [Symbol.dispose]?: () => void };
  let integrationEnvVars: Record<string, string>;
  try {
    integrationEnvVars = await (rpc as any).getWorkspaceIntegrationEnvVars(workspaceId);
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

export interface ProxyCloudflareApiOptions {
  onDeploySideEffects: (info: DeploySideEffectsInfo) => Promise<void>;
}

export async function proxyCloudflareApi(
  request: Request,
  env: CfApiProxyEnv,
  ctx: ExecutionContext,
  options: ProxyCloudflareApiOptions
): Promise<Response> {
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

  const accountId = env.CF_ACCOUNT_ID?.trim();
  const dispatchNamespace = env.CF_DISPATCH_NAMESPACE?.trim();

  // Asset uploads use Cloudflare-issued JWTs from assets-upload-session.
  // Skip our deploy token validation and pass through - Cloudflare validates the JWT.
  // Security: JWTs can only be obtained via assets-upload-session (which requires deploy token auth)
  // and are tied to the script name.
  if (ASSETS_UPLOAD.test(url.pathname) && request.method.toUpperCase() === 'POST') {
    let pathname = url.pathname;
    // Rewrite account ID if configured
    if (accountId) {
      const accountMatch = pathname.match(/^\/client\/v4\/accounts\/([^\/]+)\/(.*)$/);
      if (accountMatch) {
        pathname = `/client/v4/accounts/${encodeURIComponent(accountId)}/${accountMatch[2] ?? ''}`;
      }
    }

    const upstreamUrl = new URL(`https://api.cloudflare.com${pathname}${url.search}`);
    const headers = new Headers(request.headers);
    // Keep the original Authorization header (Cloudflare JWT)
    headers.delete('cookie');
    headers.delete('host');

    const body = await request.arrayBuffer();
    const resp = await fetch(upstreamUrl, { method: 'POST', headers, body });
    return new Response(resp.body, { status: resp.status, headers: resp.headers });
  }

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

  // Validate signed deploy token (no KV lookup needed)
  if (!isSignedToken(proxyToken)) {
    console.warn('[cf-api-proxy] invalid deploy token format', {
      method: request.method,
      path: url.pathname,
      tokenPrefix: proxyToken.slice(0, 8),
    });
    return cfApiError(10002, 'Authentication error: Invalid deploy token format', 401);
  }

  const tokenPayload = await validateSignedToken(env.TOKEN_SIGNING_SECRET, proxyToken);
  if (!tokenPayload) {
    console.warn('[cf-api-proxy] invalid deploy token signature', {
      method: request.method,
      path: url.pathname,
      tokenPrefix: proxyToken.slice(0, 8),
    });
    return cfApiError(10002, 'Authentication error: Invalid deploy token', 401);
  }

  // Check for deploy scope
  if (!tokenPayload.scopes.includes('deploy')) {
    console.warn('[cf-api-proxy] deploy token lacks deploy scope', {
      method: request.method,
      path: url.pathname,
      scopes: tokenPayload.scopes,
    });
    return cfApiError(10002, 'Authentication error: Token lacks deploy scope', 401);
  }

  if (!tokenPayload.workspace_id) {
    console.warn('[cf-api-proxy] deploy token missing workspace_id', {
      method: request.method,
      path: url.pathname,
    });
    return cfApiError(10003, 'Authentication error: Invalid workspace', 401);
  }

  const orgId = tokenPayload.org_id;
  const workspaceId = tokenPayload.workspace_id;
  const threadId = tokenPayload.thread_id;

  let pathname = url.pathname;

  // Rewrite WFP dispatch namespace (and optionally account id) on the fly.
  // /client/v4/accounts/:account_id/workers/dispatch/namespaces/:dispatch_namespace/...
  const dispatchMatch = pathname.match(/^\/client\/v4\/accounts\/([^\/]+)\/workers\/dispatch\/namespaces\/([^\/]+)\/(.*)$/);
  if (dispatchMatch) {
    const rest = dispatchMatch[3] ?? '';
    const rewrittenAccount = accountId ?? dispatchMatch[1]!;
    const rewrittenNs = dispatchNamespace ?? dispatchMatch[2]!;
    pathname = `/client/v4/accounts/${encodeURIComponent(rewrittenAccount)}/workers/dispatch/namespaces/${encodeURIComponent(rewrittenNs)}/${rest}`;
  }
  // Block regular worker script/service endpoints - users must use the globally installed wrangler
  // which is configured to deploy to the dispatch namespace directly
  if (!dispatchMatch) {
    const scriptsMatch = pathname.match(/^\/client\/v4\/accounts\/[^\/]+\/workers\/scripts\/[^\/]+/);
    const servicesMatch = pathname.match(/^\/client\/v4\/accounts\/[^\/]+\/workers\/services\/[^\/]+/);

    if (scriptsMatch || servicesMatch) {
      console.warn('[cf-api-proxy] blocked non-dispatch worker endpoint', {
        method: request.method,
        path: pathname,
      });
      return cfApiError(
        10000,
        'Direct worker deployments are not supported. Please use the globally installed wrangler binary (just run "wrangler deploy" without npx or local installation).',
        403
      );
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

  // Enforce script ownership - prevent org A from deploying to a script owned by org B
  const scriptName = extractScriptName(pathname);
  if (scriptName) {
    const ownership = await checkScriptOwnership(env.API_TOKENS, scriptName, orgId);
    if (ownership.owned && ownership.orgId !== orgId) {
      console.warn('[cf-api-proxy] script ownership violation', {
        method: request.method,
        path: pathname,
        scriptName,
        requestingOrgId: orgId,
        owningOrgId: ownership.orgId,
      });
      return cfApiError(
        10014,
        `Script "${scriptName}" is owned by another organization`,
        403
      );
    }
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

      // Register script ownership and enqueue screenshots
      ctx.waitUntil(
        options.onDeploySideEffects({
          scriptName,
          orgId,
          workspaceId,
          hostname: url.hostname,
          threadId,
        }).catch(err => {
          console.error('[cf-api-proxy] failed to process deploy side effects', {
            scriptName,
            orgId,
            workspaceId,
            error: String(err),
          });
        })
      );

      // Sync integration secrets to deployed worker
      ctx.waitUntil(
        syncDispatchScriptSecrets(env, workspaceId, orgId, account, dispatchNs, scriptName, upstreamApiToken)
          .catch(err => {
            console.error('[cf-api-proxy] failed to sync script secrets', {
              account,
              dispatchNamespace: dispatchNs,
              scriptName,
              orgId,
              workspaceId,
              error: String(err),
            });
          })
      );

      // Auto-set preview if threadId is in the deploy token
      if (threadId) {
        ctx.waitUntil(
          (async () => {
            try {
              const threadStub = env.CHAT_THREAD.get(env.CHAT_THREAD.idFromName(threadId));
              await threadStub.fetch(new Request('http://internal/preview', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ workers: [scriptName] }),
              }));
              console.log('[cf-api-proxy] auto-set preview', {
                threadId,
                scriptName,
                orgId,
              });
            } catch (err) {
              console.error('[cf-api-proxy] failed to auto-set preview', {
                threadId,
                scriptName,
                orgId,
                error: String(err),
              });
            }
          })()
        );
      }

      // Inject URLs into the response for successful deploys
      // This allows wrangler to display the app URLs after deploy
      try {
        const respJson = JSON.parse(new TextDecoder().decode(respBody)) as {
          success?: boolean;
          result?: { urls?: string[] };
        };
        if (respJson.success && respJson.result) {
          const envPrefix = resolveEnvPrefix(env.WORKER_BASE_URL, url.hostname);
          respJson.result.urls = [
            buildDeployUrl(scriptName, envPrefix),
          ];
          const modifiedBody = JSON.stringify(respJson);
          const modifiedHeaders = new Headers(resp.headers);
          modifiedHeaders.set('Content-Length', String(new TextEncoder().encode(modifiedBody).length));
          return new Response(modifiedBody, { status: resp.status, headers: modifiedHeaders });
        }
      } catch {
        // If JSON parsing fails, return original response
      }
    }
  }

  return new Response(respBody, { status: resp.status, headers: resp.headers });
}
