// Custom worker that wraps OpenNext and handles WebSocket + Durable Objects
// @ts-ignore - .open-next/worker.js is generated at build time
import openNextHandler from "../../../.open-next/worker.js";
import { ChatThreadDO, type ChatEnv } from "./durable-objects.js";
import { UserDO, OrgDO, type AuthEnv } from "./auth.js";
import { WorkspaceContainer, handleWebSocketUpgrade, type WorkspaceContainerEnv } from './workspace-container.js';
import { WorkspaceDO, type WorkspaceInfo } from './workspace.js';
import { getSession as getSessionKV } from './session-kv.js';
import { createScreenshotToken } from './worker-auth.js';
export { DoRpcService } from './rpc-service.js';

// Export WorkspaceContainer as ThreadSandbox to match wrangler.jsonc class_name
export { WorkspaceContainer as ThreadSandbox };

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

interface AppScreenshotJob {
  script_name: string;
  org_id: string;
  workspace_id: string;
  deploy_ts: number;
  env_prefix: string;
  is_public: boolean;
  screenshot_token?: string;
}

interface Env extends ChatEnv, AuthEnv, WorkspaceContainerEnv {
  ASSETS: Fetcher;
  WORKSPACE: DurableObjectNamespace<WorkspaceDO>;
  SESSIONS: KVNamespace;
  NEXTJS_ENV?: string;
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  CF_DISPATCH_NAMESPACE?: string;
  PLATFORM_SCRIPT_TOKENS?: KVNamespace;
  ERROR_ANALYTICS?: AnalyticsEngineDataset;
  APP_SCREENSHOT_QUEUE?: Queue<AppScreenshotJob>;
}

const CHIRIDION_DEPLOY_TOKEN_HEADER = 'X-Chiridion-Deploy-Token';
const CHIRIDION_THREAD_TOKEN_HEADER = 'X-Chiridion-Thread-Deploy-Token';

// Token TTL (24 hours in seconds)
const TOKEN_TTL_SECONDS = 86400;

/**
 * Generate a per-thread deploy token and store in KV.
 * This token includes both workspaceId and threadId for auto-preview after deploys.
 */
async function mintPerThreadDeployToken(
  kv: KVNamespace,
  workspaceId: string,
  threadId: string
): Promise<string> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const base64 = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
  const token = `ctok_${base64}`;

  const tokenData = JSON.stringify({ workspaceId, threadId });
  await kv.put(`platform_script_token:${token}`, tokenData, { expirationTtl: TOKEN_TTL_SECONDS });

  return token;
}

function getEnvPrefix(hostname: string): string {
  if (hostname.endsWith('.chiridion.ai') || hostname === 'chiridion.ai') {
    const parts = hostname.split('.');
    if (parts.length <= 2 || parts[0] === 'www') {
      return '';
    }
    return parts[0] ?? '';
  }

  if (hostname === 'localhost' || hostname.startsWith('127.0.0.1')) {
    return 'local';
  }

  return '';
}

function resolveEnvPrefix(baseUrl: string | undefined, hostname: string): string {
  if (baseUrl) {
    try {
      return getEnvPrefix(new URL(baseUrl).hostname);
    } catch {
      return getEnvPrefix(hostname);
    }
  }
  return getEnvPrefix(hostname);
}

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
const DISPATCH_SCRIPT_ANY = /^\/client\/v4\/accounts\/[^/]+\/workers\/dispatch\/namespaces\/[^/]+\/scripts\/([^/]+)(?:\/|$)/;
const ASSETS_UPLOAD = /^\/client\/v4\/accounts\/[^/]+\/workers\/assets\/upload$/;
const SCRIPT_ORG_PREFIX = 'script_org:';

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

/**
 * Register script ownership after successful deploy.
 */
async function registerScriptOwnership(
  env: Env,
  scriptName: string,
  orgId: string,
  workspaceId: string
) {
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  // Use "system:deploy" as actor for automated deploys
  // registerWorkerScript preserves existing is_public on redeploy, or defaults to true for new scripts
  const script = await orgStub.registerWorkerScript(scriptName, workspaceId, 'system:deploy');
  // Update the denormalized KV index with the actual is_public value
  await env.API_TOKENS.put(
    `${SCRIPT_ORG_PREFIX}${scriptName}`,
    JSON.stringify({ org_id: orgId, is_public: script.is_public })
  );
  return script;
}

async function handleDeploySideEffects(
  env: Env,
  info: {
    scriptName: string;
    orgId: string;
    workspaceId: string;
    hostname: string;
  }
): Promise<void> {
  const { scriptName, orgId, workspaceId, hostname } = info;
  const script = await registerScriptOwnership(env, scriptName, orgId, workspaceId);
  console.log('[cf-api-proxy] registered script ownership', {
    scriptName,
    orgId,
    workspaceId,
  });

  if (!env.APP_SCREENSHOT_QUEUE) {
    return;
  }

  const envPrefix = resolveEnvPrefix(env.WORKER_BASE_URL, hostname);
  if (envPrefix === 'local') {
    console.log('[cf-api-proxy] skipping screenshot for local env', {
      scriptName,
      orgId,
    });
    return;
  }

  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  const previewResult = await orgStub.updateWorkerScriptPreview(scriptName, {
    status: 'pending',
    preview_key: null,
    preview_error: null,
    deploy_ts: script.updated_at,
  });

  if (previewResult.stale) {
    console.log('[cf-api-proxy] skipping stale screenshot request', {
      scriptName,
      orgId,
      deployTs: script.updated_at,
      updatedAt: previewResult.script?.updated_at ?? null,
    });
    return;
  }

  const screenshotToken = script.is_public
    ? undefined
    : await createScreenshotToken(env.API_TOKENS, {
        script_name: scriptName,
        org_id: orgId,
      });

  const job: AppScreenshotJob = {
    script_name: scriptName,
    org_id: orgId,
    workspace_id: workspaceId,
    deploy_ts: script.updated_at,
    env_prefix: envPrefix,
    is_public: script.is_public,
    ...(screenshotToken ? { screenshot_token: screenshotToken } : {}),
  };

  try {
    await env.APP_SCREENSHOT_QUEUE.send(job, {
      contentType: 'json',
      messageId: `${scriptName}:${script.updated_at}`,
    });
    console.log('[cf-api-proxy] queued app screenshot', {
      scriptName,
      orgId,
      workspaceId,
      deployTs: script.updated_at,
    });
  } catch (err) {
    console.error('[cf-api-proxy] failed to enqueue app screenshot', {
      scriptName,
      orgId,
      workspaceId,
      error: String(err),
    });
    await orgStub.updateWorkerScriptPreview(scriptName, {
      status: 'failed',
      preview_key: null,
      preview_error: String(err),
      deploy_ts: script.updated_at,
    });
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

interface TokenData {
  workspaceId: string;
  threadId?: string;
}

async function resolveWorkspaceContext(
  env: Env,
  tokenValue: string
): Promise<{ workspaceId: string; orgId: string; threadId?: string } | null> {
  // Token value can be either:
  // - Legacy format: just the workspaceId string
  // - New format: JSON object { workspaceId, threadId }
  let workspaceId: string;
  let threadId: string | undefined;

  if (tokenValue.startsWith('{')) {
    try {
      const data = JSON.parse(tokenValue) as TokenData;
      workspaceId = data.workspaceId;
      threadId = data.threadId;
    } catch {
      // Malformed JSON - treat as workspaceId
      workspaceId = tokenValue;
    }
  } else {
    workspaceId = tokenValue;
  }

  const workspaceStub = env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId));
  const info = await workspaceStub.getInfo() as WorkspaceInfo | null;
  if (!info || info.archived) return null;
  return {
    workspaceId,
    orgId: info.org_id,
    threadId,
  };
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
    integrationEnvVars = await rpc.getWorkspaceIntegrationEnvVars(workspaceId);
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

  // Token -> workspace mapping (stored in KV). If PLATFORM_SCRIPT_TOKENS isn't bound yet, fall back
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
  const workspaceContext = await resolveWorkspaceContext(env, tokenValue);
  if (!workspaceContext) {
    console.warn('[cf-api-proxy] invalid deploy token workspace', {
      method: request.method,
      path: url.pathname,
      tokenValue: tokenValue.slice(0, 20),
    });
    return cfApiError(10003, 'Authentication error: Invalid workspace', 401);
  }
  const { orgId, workspaceId, threadId } = workspaceContext;

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
        handleDeploySideEffects(env, {
          scriptName,
          orgId,
          workspaceId,
          hostname: url.hostname,
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

      const session = await getSessionKV(env.SESSIONS, sessionId);
      if (!session) {
        return new Response('Unauthorized', { status: 401 });
      }

      const workspaceId = session.workspace_id;
      if (!workspaceId) {
        return new Response('No workspace selected', { status: 400 });
      }

      // Verify thread belongs to user's workspace (prevents cross-tenant leak)
      // Use RPC service since threads are now stored in OrgDO
      const rpc = env.DO_RPC as typeof env.DO_RPC & { [Symbol.dispose]?: () => void };
      let thread;
      try {
        thread = await rpc.getThread(threadId, workspaceId);
      } finally {
        rpc[Symbol.dispose]?.();
      }
      if (!thread) {
        return new Response('Thread not found', { status: 404 });
      }

      // Route to thread DO for preview state updates
      const threadStub = env.CHAT_THREAD.get(env.CHAT_THREAD.idFromName(threadId));
      return threadStub.fetch(request);
    }

    // Handle WebSocket upgrade requests at /ws/{workspace}
    // The workspace is used to route to the correct container (one per workspace)
    // Thread/session management happens in the WebSocket protocol
    const wsMatch = url.pathname.match(/^\/ws\/([^\/]+)$/);
    if (wsMatch && request.headers.get('Upgrade') === 'websocket') {
      const workspaceFromPath = wsMatch[1];

      console.log('[ws] WebSocket upgrade request received', {
        path: url.pathname,
        workspaceFromPath,
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

      const session = await getSessionKV(env.SESSIONS, sessionId);
      if (!session) {
        console.log('[ws] Invalid session, returning 401', { sessionId });
        return new Response('Unauthorized', { status: 401 });
      }

      const orgId = session.org_id;
      const workspaceId = session.workspace_id;
      if (!orgId) {
        console.log('[ws] No org in session, returning 400', { sessionId });
        return new Response('No organization selected', { status: 400 });
      }
      if (!workspaceId) {
        console.log('[ws] No workspace in session, returning 400', { sessionId });
        return new Response('No workspace selected', { status: 400 });
      }
      // FIXME: Enforce viewer role restrictions when publishing is implemented.
      // Viewers should only access published apps, not chat or computer.

      let accessLevel: 'full' | 'read_only' | 'none' = 'none';
      try {
        const rpc = env.DO_RPC as typeof env.DO_RPC & { [Symbol.dispose]?: () => void };
        try {
          accessLevel = await rpc.getWorkspaceAccess(workspaceId, session.user_id);
        } finally {
          rpc[Symbol.dispose]?.();
        }
      } catch (err) {
        console.warn('[ws] Failed to resolve workspace access', {
          sessionId,
          orgId,
          workspaceId,
          userId: session.user_id,
          error: String(err),
        });
        return new Response('Forbidden', { status: 403 });
      }

      if (accessLevel !== 'full') {
        console.log('[ws] Workspace access denied', {
          sessionId,
          orgId,
          workspaceId,
          userId: session.user_id,
          accessLevel,
        });
        return new Response('Forbidden', { status: 403 });
      }

      // Extract threadId from query param for per-thread deploy token
      const threadIdFromUrl = url.searchParams.get('threadId');

      console.log('[ws] Authenticated, forwarding to container', {
        sessionId,
        orgId,
        workspaceId,
        userId: session.user_id,
        threadId: threadIdFromUrl,
      });

      // Mint per-thread deploy token if threadId provided
      // This token stores {workspaceId, threadId} so the proxy can auto-set preview after deploys
      let modifiedRequest = request;
      if (threadIdFromUrl) {
        const tokenKv = env.PLATFORM_SCRIPT_TOKENS ?? env.EMAIL_TO_USER;
        const threadToken = await mintPerThreadDeployToken(tokenKv, workspaceId, threadIdFromUrl);
        console.log('[ws] Minted per-thread deploy token', {
          threadId: threadIdFromUrl,
          tokenPrefix: threadToken.slice(0, 12),
        });

        // Create new request with deploy token header
        const headers = new Headers(request.headers);
        headers.set(CHIRIDION_THREAD_TOKEN_HEADER, threadToken);
        modifiedRequest = new Request(request.url, {
          method: request.method,
          headers,
          body: request.body,
        });
      }

      // Handle WebSocket upgrade with container management
      return handleWebSocketUpgrade(modifiedRequest, env, workspaceId, orgId);
    }

    // Handle preview API with deploy token auth (called from container wrangler wrapper)
    const previewMatch = url.pathname.match(/^\/api\/threads\/([^\/]+)\/preview$/);
    if (previewMatch && request.method === 'POST') {
      const previewThreadId = previewMatch[1];

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
      const previewTokenValue = await tokenKv.get(`platform_script_token:${token}`);
      if (!previewTokenValue) {
        return new Response(JSON.stringify({ error: 'Invalid token' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const previewWorkspaceContext = await resolveWorkspaceContext(env, previewTokenValue);
      if (!previewWorkspaceContext) {
        return new Response(JSON.stringify({ error: 'Invalid workspace' }), {
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

        // Sanitize worker names (no prefix)
        const sanitizedWorkers = body.workers.map(name => {
          return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 63);
        });

        const threadStub = env.CHAT_THREAD.get(env.CHAT_THREAD.idFromName(previewThreadId));
        const response = await threadStub.fetch(new Request('http://internal/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workers: sanitizedWorkers }),
        }));

        if (!response.ok) {
          return new Response(response.body, {
            status: response.status,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // Return full URLs for the deployed workers
        const urls = prefixedWorkers.map(w => `https://${w}.chiridion.app`);
        return new Response(JSON.stringify({ workers: prefixedWorkers, urls }), {
          status: 200,
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
export { ChatThreadDO };
export { UserDO, OrgDO };
export { WorkspaceDO };
