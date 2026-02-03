/**
 * Cloudflare API Proxy
 *
 * Handles proxying wrangler deploy requests to Cloudflare's API.
 * Provides auth, path rewriting, and post-deploy side effects.
 */

import { waitUntil } from 'cloudflare:workers';
import { isSignedToken, validateSignedToken } from './signed-tokens.js';
import { mapCredentialsToEnvVars } from './integration-env.js';
import { decryptCredentials } from '../../../src/lib/integration-crypto.js';
import { decryptOpenRouterKey } from './openrouter-keys.js';
import type { OrgDO } from './auth.js';
import type { WorkspaceDO } from './workspace.js';

// Secrets managed by Chiridion (will be cleaned up if removed)
const MANAGED_SECRET_PREFIXES = ['INT_'];
const MANAGED_SECRET_NAMES = ['OPENROUTER_API_KEY'];

function isManagedSecret(name: string): boolean {
  return MANAGED_SECRET_NAMES.includes(name) || MANAGED_SECRET_PREFIXES.some(p => name.startsWith(p));
}

// Re-export for index.ts to use
export const CHIRIDION_DEPLOY_TOKEN_HEADER = 'X-Chiridion-Deploy-Token';

const DISPATCH_SCRIPT_UPLOAD = /^\/client\/v4\/accounts\/[^/]+\/workers\/dispatch\/namespaces\/[^/]+\/scripts\/[^/]+$/;
const DISPATCH_SCRIPT_BASE = /^\/client\/v4\/accounts\/([^/]+)\/workers\/dispatch\/namespaces\/([^/]+)\/scripts\/([^/]+)$/;
const DISPATCH_SCRIPT_ANY = /^\/client\/v4\/accounts\/[^/]+\/workers\/dispatch\/namespaces\/[^/]+\/scripts\/([^/]+)(?:\/|$)/;
const ASSETS_UPLOAD = /^\/client\/v4\/accounts\/[^/]+\/workers\/assets\/upload$/;

// Legacy prefix for script ownership (being phased out)
const SCRIPT_ORG_PREFIX_LEGACY = 'script_org:';
// New prefix with org-slug namespacing: script:{org-slug}--{script-name}
const SCRIPT_PREFIX = 'script:';

export interface CfApiProxyEnv {
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  CF_DISPATCH_NAMESPACE?: string;
  TOKEN_SIGNING_SECRET: string;
  INTEGRATION_SECRET_KEY: string;
  EMAIL_TO_USER: KVNamespace;
  APP_KV: KVNamespace;
  WORKSPACE: DurableObjectNamespace<WorkspaceDO>;
  ORG: DurableObjectNamespace<OrgDO>;
  CHAT_THREAD: DurableObjectNamespace;
  WORKER_BASE_URL?: string;
}

export interface DeploySideEffectsInfo {
  /** Original script name (user-facing, e.g., "my-app") */
  scriptName: string;
  /** Dispatch namespace script name (e.g., "acme-85b--my-app") */
  dispatchScriptName: string;
  orgId: string;
  orgSlug: string;
  workspaceId: string;
  hostname: string;
  threadId?: string;
  configPath?: string;
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

  if (hostname === 'localhost' || hostname.startsWith('127.0.0.1') || hostname.endsWith('.local') || hostname === 'host.docker.internal') {
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
 * With org-slug namespacing, scripts are now org-scoped by name ({org-slug}--{script}).
 * This function is now only used for legacy compatibility during migration.
 * Returns null if not owned, the owning org_id if owned by same org.
 */
async function checkScriptOwnershipLegacy(
  kv: KVNamespace,
  scriptName: string,
  _requestingOrgId: string
): Promise<{ owned: boolean; orgId: string | null }> {
  const data = await kv.get(`${SCRIPT_ORG_PREFIX_LEGACY}${scriptName}`);
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
 * Get script access info from the new namespaced KV format.
 */
async function getScriptAccessInfo(
  kv: KVNamespace,
  dispatchScriptName: string
): Promise<{ org_id: string; is_public: boolean } | null> {
  const data = await kv.get(`${SCRIPT_PREFIX}${dispatchScriptName}`);
  if (!data) return null;
  try {
    return JSON.parse(data) as { org_id: string; is_public: boolean };
  } catch {
    return null;
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
  let configPath: string | undefined;
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

    // Extract config_path from metadata JSON
    if (name === 'metadata' && !filename) {
      try {
        const metadata = JSON.parse(bodyText) as { config_path?: string };
        if (metadata.config_path) {
          configPath = metadata.config_path;
        }
      } catch {
        // Ignore JSON parse errors
      }
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

  return { files, wranglerConfigs, formParts, configPath };
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

/**
 * Delete a worker script from the Cloudflare dispatch namespace.
 * Returns true if successful, false if the script didn't exist or deletion failed.
 */
export async function deleteDispatchScript(
  accountId: string,
  dispatchNamespace: string,
  scriptName: string,
  apiToken: string
): Promise<boolean> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}` +
    `/workers/dispatch/namespaces/${encodeURIComponent(dispatchNamespace)}` +
    `/scripts/${encodeURIComponent(scriptName)}`;
  const headers = { Authorization: `Bearer ${apiToken}` };
  const resp = await fetch(url, { method: 'DELETE', headers });

  if (!resp.ok) {
    // 404 means script doesn't exist - that's OK for delete
    if (resp.status === 404) {
      console.log('[cf-api] script not found in dispatch namespace (already deleted)', {
        accountId,
        dispatchNamespace,
        scriptName,
      });
      return true;
    }
    const bodyText = await resp.text();
    console.error('[cf-api] failed to delete dispatch script', {
      status: resp.status,
      statusText: resp.statusText,
      bodyPreview: bodyText.slice(0, 512),
      accountId,
      dispatchNamespace,
      scriptName,
    });
    return false;
  }

  console.log('[cf-api] deleted dispatch script', {
    accountId,
    dispatchNamespace,
    scriptName,
  });
  return true;
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
  const secretsToSync: Record<string, string> = {};

  // Get integration env vars from WorkspaceDO
  const workspaceStub = env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId));
  const records = await workspaceStub.getIntegrations();

  for (const record of records) {
    if (record.enabled !== 1) continue;
    const credentials = await decryptCredentials(record.credentials_encrypted, env.INTEGRATION_SECRET_KEY);
    const config = JSON.parse(record.config) as Record<string, unknown>;
    Object.assign(secretsToSync, mapCredentialsToEnvVars(record.name, record.integration_type, credentials, config));
  }

  // Get OpenRouter API key from OrgDO
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  const keyRecord = await orgStub.getOpenRouterKeyRecord();
  if (keyRecord) {
    try {
      const openRouterKey = await decryptOpenRouterKey(keyRecord.key_encrypted, env.INTEGRATION_SECRET_KEY);
      secretsToSync.OPENROUTER_API_KEY = openRouterKey;
    } catch (e) {
      console.error('[cf-api-proxy] Failed to decrypt OpenRouter key for script secrets:', e);
    }
  }

  const secretEntries = Object.entries(secretsToSync);

  if (secretEntries.length === 0) {
    // No secrets to sync - clean up any managed secrets that exist
    const existing = await listDispatchScriptSecrets(accountId, dispatchNamespace, scriptName, apiToken);
    const managed = existing.filter(secret => isManagedSecret(secret.name));
    if (managed.length) {
      await Promise.all(managed.map(secret =>
        deleteDispatchScriptSecret(accountId, dispatchNamespace, scriptName, apiToken, secret.name)
      ));
    }
    return;
  }

  const existingSecrets = await listDispatchScriptSecrets(accountId, dispatchNamespace, scriptName, apiToken);
  const desiredNames = new Set(secretEntries.map(([name]) => name));
  const stale = existingSecrets.filter(secret => isManagedSecret(secret.name) && !desiredNames.has(secret.name));

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
  const orgSlug = tokenPayload.org_slug;
  const workspaceId = tokenPayload.workspace_id;
  const threadId = tokenPayload.thread_id;

  // Require org_slug for deploy operations
  if (!orgSlug) {
    console.warn('[cf-api-proxy] deploy token missing org_slug', {
      method: request.method,
      path: url.pathname,
      orgId,
    });
    return cfApiError(10003, 'Authentication error: Deploy token missing org_slug', 401);
  }

  let pathname = url.pathname;

  // Extract original script name before rewriting
  const originalScriptName = extractScriptName(pathname);

  // Rewrite WFP dispatch namespace (and optionally account id) on the fly.
  // Also rewrite script name to include org-slug prefix: {org-slug}--{script-name}
  // /client/v4/accounts/:account_id/workers/dispatch/namespaces/:dispatch_namespace/scripts/:script/...
  const dispatchMatch = pathname.match(/^\/client\/v4\/accounts\/([^\/]+)\/workers\/dispatch\/namespaces\/([^\/]+)\/(.*)$/);
  if (dispatchMatch) {
    let rest = dispatchMatch[3] ?? '';
    const rewrittenAccount = accountId ?? dispatchMatch[1]!;
    const rewrittenNs = dispatchNamespace ?? dispatchMatch[2]!;

    // Rewrite script name to include org-slug prefix
    // rest might be: scripts/{scriptName} or scripts/{scriptName}/settings etc.
    const scriptPathMatch = rest.match(/^scripts\/([^\/]+)(\/.*)?$/);
    if (scriptPathMatch && originalScriptName) {
      const suffix = scriptPathMatch[2] ?? '';
      const dispatchScriptName = `${orgSlug}--${originalScriptName}`;
      rest = `scripts/${encodeURIComponent(dispatchScriptName)}${suffix}`;
    }

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
        'Direct worker deployments are not supported. Use `wrangler deploy --dispatch-namespace chiridion` instead.',
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

  // Script ownership is now enforced by org-slug namespacing in the script name.
  // Scripts are named {org-slug}--{script-name}, so org A cannot deploy to org B's scripts.
  // The org-slug in the token is verified, so the script name prefix is trusted.
  const dispatchScriptName = originalScriptName ? `${orgSlug}--${originalScriptName}` : null;

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

  // Extract configPath from metadata if present in upload
  let configPath: string | undefined;
  if (body && isUploadRequest(pathname, method)) {
    const contentType = request.headers.get('Content-Type') ?? '';
    if (contentType.toLowerCase().includes('multipart/form-data')) {
      const uploadInfo = parseMultipartUploads(body, contentType);
      if (uploadInfo?.configPath) {
        configPath = uploadInfo.configPath;
      }
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

  // Pre-deploy check: prevent cross-workspace name collisions
  // This must happen BEFORE the Cloudflare API call to prevent the deploy
  if (isUploadRequest(pathname, method) && originalScriptName) {
    const orgStub = env.ORG.get(env.ORG.idFromName(orgId)) as unknown as OrgDO;
    const existingScript = await orgStub.getWorkerScript(originalScriptName);
    if (existingScript && existingScript.workspace_id !== workspaceId) {
      console.warn('[cf-api-proxy] blocked deploy: script name collision', {
        scriptName: originalScriptName,
        existingWorkspaceId: existingScript.workspace_id,
        attemptedWorkspaceId: workspaceId,
        orgId,
      });
      return cfApiError(
        10004,
        `Script name "${originalScriptName}" is already in use by another workspace in this organization. Please choose a different name.`,
        409
      );
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
    if (scriptMatch && originalScriptName && dispatchScriptName) {
      const account = decodeURIComponent(scriptMatch[1]!);
      const dispatchNs = decodeURIComponent(scriptMatch[2]!);

      // Register script ownership and enqueue screenshots
      waitUntil(
        options.onDeploySideEffects({
          scriptName: originalScriptName,
          dispatchScriptName,
          orgId,
          orgSlug,
          workspaceId,
          hostname: url.hostname,
          threadId,
          configPath,
        }).catch(err => {
          console.error('[cf-api-proxy] failed to process deploy side effects', {
            scriptName: originalScriptName,
            dispatchScriptName,
            orgId,
            workspaceId,
            error: String(err),
          });
        })
      );

      // Sync integration secrets to deployed worker (uses dispatchScriptName for Cloudflare API)
      waitUntil(
        syncDispatchScriptSecrets(env, workspaceId, orgId, account, dispatchNs, dispatchScriptName, upstreamApiToken)
          .catch(err => {
            console.error('[cf-api-proxy] failed to sync script secrets', {
              account,
              dispatchNamespace: dispatchNs,
              dispatchScriptName,
              orgId,
              workspaceId,
              error: String(err),
            });
          })
      );

      // Auto-set preview if threadId is in the deploy token
      if (threadId) {
        waitUntil(
          (async () => {
            try {
              const threadStub = env.CHAT_THREAD.get(env.CHAT_THREAD.idFromName(threadId));
              let isPublic = false;
              try {
                const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
                // Use originalScriptName for OrgDO lookup (stores user-facing name)
                const script = await orgStub.getWorkerScript(originalScriptName);
                if (script) {
                  isPublic = script.is_public;
                } else {
                  // Check new KV format first, then legacy
                  let stored = await env.APP_KV.get(`${SCRIPT_PREFIX}${dispatchScriptName}`);
                  if (!stored) {
                    stored = await env.APP_KV.get(`${SCRIPT_ORG_PREFIX_LEGACY}${originalScriptName}`);
                  }
                  if (stored) {
                    try {
                      const parsed = JSON.parse(stored) as { is_public?: boolean };
                      if (typeof parsed.is_public === 'boolean') {
                        isPublic = parsed.is_public;
                      } else {
                        isPublic = true;
                      }
                    } catch {
                      isPublic = true;
                    }
                  } else {
                    // Default for newly registered scripts
                    isPublic = true;
                  }
                }
              } catch (err) {
                console.error('[cf-api-proxy] failed to load app visibility', {
                  threadId,
                  scriptName: originalScriptName,
                  orgId,
                  error: String(err),
                });
              }
              // Use originalScriptName for preview (user-facing)
              await threadStub.fetch(new Request('http://internal/preview', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ workers: [originalScriptName], isPublic }),
              }));
              console.log('[cf-api-proxy] auto-set preview', {
                threadId,
                scriptName: originalScriptName,
                orgId,
              });
            } catch (err) {
              console.error('[cf-api-proxy] failed to auto-set preview', {
                threadId,
                scriptName: originalScriptName,
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
