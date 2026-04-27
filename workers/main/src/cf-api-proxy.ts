/**
 * Cloudflare API Proxy
 *
 * Handles proxying wrangler deploy requests to Cloudflare's API.
 * Provides auth, path rewriting, and post-deploy side effects.
 */

import { waitUntil } from 'cloudflare:workers';
import { isSignedToken, validateSignedToken, createSignedToken } from './signed-tokens.js';
import { mapCredentialsToEnvVars } from './integration-env.js';
import { decryptCredentials } from '../../../src/lib/integration-crypto.js';
import { validateSandboxProxy } from './sandbox-auth.js';
import type { OrgDO } from './auth.js';
import type { WorkspaceDO } from './workspace.js';

// Secrets managed by Chiridion (will be cleaned up if removed)
const MANAGED_SECRET_PREFIXES = ['INT_'];
const VIRTUAL_DATA_PROXY_BINDING_NAME = 'DATA_PROXY';

function isManagedSecret(name: string): boolean {
  return MANAGED_SECRET_PREFIXES.some(p => name.startsWith(p));
}

// =============================================================================
// Binding Security Filter
// =============================================================================
// Users can only use bindings that are safe and self-contained.
// They CANNOT access external resources like KV, D1, R2, Queues, etc.
// For Durable Objects, they can only use DOs defined in their own script.

/** Binding types that are completely forbidden */
const FORBIDDEN_BINDING_TYPES = new Set([
  'kv_namespace',           // KV storage
  'd1',                     // D1 database
  // r2_bucket is NOT forbidden — it's transparently replaced with a virtual R2 service binding
  'queue',                  // Queue producer
  'analytics_engine',       // Analytics Engine
  'hyperdrive',             // Hyperdrive database connections
  'vectorize',              // Vectorize vector indexes
  'browser',                // Browser Rendering API
  'mtls_certificate',       // mTLS certificates
  'dispatch_namespace',     // Workers for Platforms dispatch
  'send_email',             // Email sending
  'version_metadata',       // Version metadata (internal)
]);

/** Binding types that pass validation but are transformed before forwarding to CF API */
const TRANSFORMED_BINDING_TYPES = new Set([
  'r2_bucket',              // Replaced with virtual R2 service binding
  'ai',                     // Replaced with virtual AI binding
]);

/** Binding types that are always allowed (safe, self-contained) */
const ALLOWED_BINDING_TYPES = new Set([
  'plain_text',             // Plain text env vars
  'secret_text',            // Secret text env vars (we manage secrets separately)
  'json',                   // JSON env vars
  'wasm_module',            // WASM modules (bundled with script)
  'text_blob',              // Text blobs (bundled)
  'data_blob',              // Data blobs (bundled)
  'assets',                 // Static assets (bundled with worker)
  'worker_loader',          // Worker loaders for codemode (ephemeral isolates, no external resource access)
]);

export interface WorkerBinding {
  type: string;
  name: string;
  // For durable_object_namespace bindings
  class_name?: string;
  script_name?: string;
  // For other binding types (not all fields used by all types)
  namespace_id?: string;
  database_id?: string;
  bucket_name?: string;
  [key: string]: unknown;
}

interface WorkerMetadata {
  main_module?: string;
  bindings?: WorkerBinding[];
  config_path?: string;
  [key: string]: unknown;
}

export interface BindingValidationResult {
  valid: boolean;
  forbiddenBindings: Array<{ name: string; type: string; reason: string }>;
}

/**
 * Validate bindings in worker metadata.
 * Returns which bindings are forbidden and why.
 */
export function validateBindings(bindings: WorkerBinding[]): BindingValidationResult {
  const forbiddenBindings: Array<{ name: string; type: string; reason: string }> = [];

  for (const binding of bindings) {
    const { type, name } = binding;

    // Allow virtual DATA_PROXY service binding (platform-virtualized at deploy time).
    if (type === 'service') {
      if (name === VIRTUAL_DATA_PROXY_BINDING_NAME) {
        continue;
      }
      forbiddenBindings.push({
        name,
        type,
        reason: `Service binding "${name}" is not allowed. Only "${VIRTUAL_DATA_PROXY_BINDING_NAME}" is permitted.`,
      });
      continue;
    }

    // Check completely forbidden types
    if (FORBIDDEN_BINDING_TYPES.has(type)) {
      forbiddenBindings.push({
        name,
        type,
        reason: `Binding type "${type}" is not allowed. User workers cannot access external resources.`,
      });
      continue;
    }

    // Check Durable Object bindings - only allow local DOs (no script_name)
    if (type === 'durable_object_namespace') {
      if (binding.script_name) {
        forbiddenBindings.push({
          name,
          type,
          reason: `External Durable Object binding to script "${binding.script_name}" is not allowed. Only Durable Objects defined in your own script are permitted.`,
        });
      }
      // Local DO (no script_name) is allowed
      continue;
    }

    // Check if it's a transformed type (allowed through, rewritten before forwarding)
    if (TRANSFORMED_BINDING_TYPES.has(type)) {
      continue;
    }

    // Check if it's an allowed type
    if (ALLOWED_BINDING_TYPES.has(type)) {
      continue;
    }

    // Unknown binding type - block it for safety
    forbiddenBindings.push({
      name,
      type,
      reason: `Unknown binding type "${type}" is not allowed.`,
    });
  }

  return {
    valid: forbiddenBindings.length === 0,
    forbiddenBindings,
  };
}

// Re-export for index.ts to use
export const CHIRIDION_DEPLOY_TOKEN_HEADER = 'X-Chiridion-Deploy-Token';

const DISPATCH_SCRIPT_UPLOAD = /^\/client\/v4\/accounts\/[^/]+\/workers\/dispatch\/namespaces\/[^/]+\/scripts\/[^/]+$/;
const DISPATCH_SCRIPT_BASE = /^\/client\/v4\/accounts\/([^/]+)\/workers\/dispatch\/namespaces\/([^/]+)\/scripts\/([^/]+)$/;
const DISPATCH_SCRIPT_ANY = /^\/client\/v4\/accounts\/[^/]+\/workers\/dispatch\/namespaces\/[^/]+\/scripts\/([^/]+)(?:\/|$)/;
const ASSETS_UPLOAD = /^\/client\/v4\/accounts\/[^/]+\/workers\/assets\/upload$/;

// Legacy prefix for script ownership (being phased out)
const SCRIPT_ORG_PREFIX_LEGACY = 'script_org:';
// New prefix with org-slug namespacing: script:{script-name}--{org-slug}
const SCRIPT_PREFIX = 'script:';

export interface CfApiProxyEnv {
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  CF_DISPATCH_NAMESPACE?: string;
  CF_WORKER_NAME?: string;
  TAIL_WORKER_NAME?: string;
  TOKEN_SIGNING_SECRET: string;
  INTEGRATION_SECRET_KEY: string;
  EMAIL_TO_USER: KVNamespace;
  APP_KV: KVNamespace;
  WORKSPACE: DurableObjectNamespace<WorkspaceDO>;
  ORG: DurableObjectNamespace<OrgDO>;
  CHAT_THREAD: DurableObjectNamespace;
  WORKER_BASE_URL?: string;
  SANDBOX_PROXY_SECRET?: string;
  CF_ZONE_ID?: string;
  CF_CUSTOM_HOSTNAME_FALLBACK?: string;
  CF_CUSTOM_HOSTNAME_CNAME_TARGET?: string;
}

export interface DeploySideEffectsInfo {
  /** Original script name (user-facing, e.g., "my-app") */
  scriptName: string;
  /** Dispatch namespace script name (e.g., "my-app--acme-85b") */
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
 * E.g., "staging.camelai.dev" -> "staging", "camelai.dev" -> ""
 */
export function getEnvPrefix(hostname: string): string {
  if (hostname.endsWith('.camelai.dev') || hostname === 'camelai.dev') {
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

// Pattern for tail creation (wrangler tail)
const DISPATCH_SCRIPT_TAILS = /^\/client\/v4\/accounts\/[^/]+\/workers\/dispatch\/namespaces\/[^/]+\/scripts\/([^/]+)\/tails$/;

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
        DISPATCH_SCRIPT_TAILS.test(pathname) ||
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

// Patterns for requests that may contain bindings in JSON body
const DISPATCH_SCRIPT_SETTINGS = /^\/client\/v4\/accounts\/[^/]+\/workers\/dispatch\/namespaces\/[^/]+\/scripts\/[^/]+\/settings$/;
const DISPATCH_SCRIPT_SCRIPT_SETTINGS = /^\/client\/v4\/accounts\/[^/]+\/workers\/dispatch\/namespaces\/[^/]+\/scripts\/[^/]+\/script-settings$/;
const DISPATCH_SCRIPT_VERSIONS = /^\/client\/v4\/accounts\/[^/]+\/workers\/dispatch\/namespaces\/[^/]+\/scripts\/[^/]+\/versions$/;

/**
 * Check if this is a request that may contain bindings in JSON body.
 * These need to be validated separately from multipart uploads.
 */
function isBindingsJsonRequest(pathname: string, method: string): boolean {
  const m = method.toUpperCase();
  // PATCH to settings/script-settings can modify bindings
  if (m === 'PATCH') {
    return DISPATCH_SCRIPT_SETTINGS.test(pathname) || DISPATCH_SCRIPT_SCRIPT_SETTINGS.test(pathname);
  }
  // POST to versions can include bindings
  if (m === 'POST') {
    return DISPATCH_SCRIPT_VERSIONS.test(pathname);
  }
  return false;
}

interface SettingsRequestBody {
  bindings?: WorkerBinding[];
  [key: string]: unknown;
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
  let bindings: WorkerBinding[] | undefined;
  let rawMetadataJson: string | undefined;
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

    // Extract config_path and bindings from metadata JSON
    if (name === 'metadata' && !filename) {
      try {
        const metadata = JSON.parse(bodyText) as WorkerMetadata;
        if (metadata.config_path) {
          configPath = metadata.config_path;
        }
        if (metadata.bindings) {
          bindings = metadata.bindings;
        }
        rawMetadataJson = bodyText;
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

  return { files, wranglerConfigs, formParts, configPath, bindings, rawMetadataJson };
}

/**
 * Transform virtualized bindings in the multipart upload body by finding the raw
 * metadata JSON (already extracted by parseMultipartUploads) in the body bytes
 * and replacing it with modified metadata. This avoids fragile multipart parsing
 * and works regardless of line ending conventions.
 */
function transformVirtualBindings(
  body: ArrayBuffer,
  rawMetadataJson: string,
  bindings: WorkerBinding[],
  workspaceId: string,
  orgId: string,
  userId: string | undefined,
  workerServiceName: string
): ArrayBuffer {
  const r2Bindings = bindings.filter(b => b.type === 'r2_bucket');
  const dataProxyBindings = bindings.filter(b => b.type === 'service' && b.name === VIRTUAL_DATA_PROXY_BINDING_NAME);
  const aiBindings = bindings.filter(b => b.type === 'ai');
  if (r2Bindings.length === 0 && dataProxyBindings.length === 0 && aiBindings.length === 0) return body;

  // Parse and transform the metadata
  let metadata: WorkerMetadata;
  try {
    metadata = JSON.parse(rawMetadataJson);
  } catch {
    console.warn('[cf-api-proxy] failed to parse metadata JSON for R2 binding transformation');
    return body;
  }

  if (!metadata.bindings) return body;

  metadata.bindings = mapVirtualizedBindings(metadata.bindings, workspaceId, orgId, userId, workerServiceName);

  const newMetadataJson = JSON.stringify(metadata);

  // Find the raw metadata bytes in the body and replace them.
  // Metadata JSON is always ASCII, so text bytes == body bytes for this region.
  const encoder = new TextEncoder();
  const oldBytes = encoder.encode(rawMetadataJson);
  const newBytes = encoder.encode(newMetadataJson);
  const bodyBytes = new Uint8Array(body);

  // Byte-level search for the old metadata
  let matchPos = -1;
  outer: for (let i = 0; i <= bodyBytes.length - oldBytes.length; i++) {
    for (let j = 0; j < oldBytes.length; j++) {
      if (bodyBytes[i + j] !== oldBytes[j]) continue outer;
    }
    matchPos = i;
    break;
  }

  if (matchPos === -1) {
    console.warn('[cf-api-proxy] could not find metadata bytes in body for R2 transformation', {
      metadataLength: rawMetadataJson.length,
      bodyLength: body.byteLength,
    });
    return body;
  }

  // Reconstruct: before + new metadata + after
  const before = bodyBytes.slice(0, matchPos);
  const after = bodyBytes.slice(matchPos + oldBytes.length);
  const result = new Uint8Array(before.length + newBytes.length + after.length);
  result.set(before, 0);
  result.set(newBytes, before.length);
  result.set(after, before.length + newBytes.length);

  console.log('[cf-api-proxy] transformed virtual bindings', {
    workspaceId,
    orgId,
    workerServiceName,
    r2Bindings: r2Bindings.map(b => ({ name: b.name, bucket_name: b.bucket_name })),
    dataProxyBindings: dataProxyBindings.map(b => ({ name: b.name })),
    aiBindings: aiBindings.map(b => ({ name: b.name })),
    originalSize: body.byteLength,
    newSize: result.length,
  });

  return result.buffer as ArrayBuffer;
}

export function mapVirtualizedBindings(
  bindings: WorkerBinding[],
  workspaceId: string,
  orgId: string,
  userId: string | undefined,
  workerServiceName: string
): WorkerBinding[] {
  return bindings.map(binding => {
    if (binding.type === 'r2_bucket') {
      return {
        type: 'service',
        name: binding.name,
        service: workerServiceName,
        entrypoint: 'R2VirtualBucket',
        props: { workspaceId, bucketName: binding.bucket_name ?? binding.name },
      };
    }

    if (binding.type === 'service' && binding.name === VIRTUAL_DATA_PROXY_BINDING_NAME) {
      return {
        type: 'service',
        name: binding.name,
        service: workerServiceName,
        entrypoint: 'DataProxyService',
        props: { workspaceId, orgId },
      };
    }

    if (binding.type === 'ai') {
      const props: Record<string, string> = { workspaceId, orgId };
      if (userId) {
        props.userId = userId;
      }
      return {
        type: 'service',
        name: binding.name,
        service: workerServiceName,
        entrypoint: 'AIVirtualBinding',
        props,
      };
    }

    return binding;
  });
}

async function callCloudflareApi<T>(
  url: string,
  init: RequestInit,
  context: string,
  options?: { suppressMissingWorkerWarning?: boolean }
): Promise<T | null> {
  const isMissingWorkerError = (status: number, errors: unknown[]): boolean =>
    status === 404 &&
    errors.some((error) => {
      if (!error || typeof error !== 'object') return false;
      const code = (error as { code?: unknown }).code;
      return code === 10007;
    });

  const resp = await fetch(url, init);
  if (!resp.ok) {
    const bodyText = await resp.text();
    let errors: unknown[] = [];
    try {
      const parsed = JSON.parse(bodyText) as { errors?: unknown };
      errors = Array.isArray(parsed.errors) ? parsed.errors : [];
    } catch {
      // Non-JSON response body: keep default empty errors array
    }

    if (options?.suppressMissingWorkerWarning && isMissingWorkerError(resp.status, errors)) {
      return null;
    }

    console.warn(`[cf-api] ${context} failed`, {
      status: resp.status,
      statusText: resp.statusText,
      bodyPreview: bodyText.slice(0, 512),
    });
    return null;
  }
  const data = await resp.json() as { success?: boolean; result?: T; errors?: unknown[] };
  if (data.success === false) {
    const errors = Array.isArray(data.errors) ? data.errors : [];
    if (options?.suppressMissingWorkerWarning && isMissingWorkerError(resp.status, errors)) {
      return null;
    }
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
  return (await callCloudflareApi<Array<{ name: string }>>(
    url,
    { method: 'GET', headers },
    'list script secrets',
    { suppressMissingWorkerWarning: true }
  )) ?? [];
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
 * Configure tail_consumers for a dispatch script to enable log capture.
 * This attaches the tail worker to the user's deployed script.
 */
async function syncDispatchScriptSettings(
  accountId: string,
  dispatchNamespace: string,
  scriptName: string,
  apiToken: string,
  tailWorkerName: string
): Promise<void> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}` +
    `/workers/dispatch/namespaces/${encodeURIComponent(dispatchNamespace)}` +
    `/scripts/${encodeURIComponent(scriptName)}/settings`;

  const headers = {
    Authorization: `Bearer ${apiToken}`,
  };

  const settings = {
    tail_consumers: [
      { service: tailWorkerName }
    ]
  };

  // Cloudflare expects multipart settings updates with a "settings" JSON part.
  const formData = new FormData();
  formData.set(
    'settings',
    new Blob([JSON.stringify(settings)], { type: 'application/json' }),
    'settings.json'
  );

  const resp = await fetch(url, { method: 'PATCH', headers, body: formData });
  if (!resp.ok) {
    const text = await resp.text();
    console.error('[cf-api-proxy] failed to set tail_consumers', {
      status: resp.status,
      scriptName,
      tailWorkerName,
      body: text.slice(0, 500),
    });
    throw new Error(`Failed to set tail_consumers: ${resp.status}`);
  }

  console.log('[cf-api-proxy] configured tail_consumers', {
    scriptName,
    tailWorkerName,
  });
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

// ── Custom Hostnames (Cloudflare for SaaS) ─────────────────────────

export interface CfCustomHostname {
  id: string;
  hostname: string;
  ssl: {
    status: string;
    method: string;
    type: string;
    dcv_delegation_record?: CfCustomHostnameDcvRecord;
    dcv_delegation_records?: CfCustomHostnameDcvRecord[];
    validation_records?: CfCustomHostnameDcvRecord[];
  };
  status: string;
  created_at: string;
}

export interface CfCustomHostnameDcvRecord {
  cname?: string;
  cname_target?: string;
  name?: string;
  target?: string;
  value?: string;
  type?: string;
  status?: string;
}

export interface CustomHostnameDcvRecord {
  cname: string;
  cname_target: string;
}

const CUSTOM_HOSTNAME_SSL_SETTINGS = {
  method: 'txt',
  type: 'dv',
  wildcard: false,
} as const;

interface CustomHostnameOptions {
  customOriginServer?: string;
  wildcard?: boolean;
}

function buildCustomHostnameSslSettings(options: CustomHostnameOptions = {}) {
  return {
    ...CUSTOM_HOSTNAME_SSL_SETTINGS,
    wildcard: options.wildcard ?? CUSTOM_HOSTNAME_SSL_SETTINGS.wildcard,
  };
}

export function extractCustomHostnameDcvRecord(
  record: CfCustomHostname | null | undefined
): CustomHostnameDcvRecord | null {
  const candidates = [
    ...(record?.ssl.dcv_delegation_records ?? []),
    ...(record?.ssl.validation_records ?? []),
    ...(record?.ssl.dcv_delegation_record ? [record.ssl.dcv_delegation_record] : []),
  ];

  for (const candidate of candidates) {
    const cname = candidate.cname ?? candidate.name;
    const cnameTarget = candidate.cname_target ?? candidate.target ?? candidate.value;
    if (cname && cnameTarget) {
      return {
        cname,
        cname_target: cnameTarget.replace(/\.$/, ''),
      };
    }
  }

  return null;
}

export async function createCustomHostname(
  zoneId: string,
  apiToken: string,
  hostname: string,
  options: CustomHostnameOptions | string = {}
): Promise<CfCustomHostname | null> {
  const normalizedOptions =
    typeof options === 'string' ? { customOriginServer: options } : options;
  const url = `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zoneId)}/custom_hostnames`;
  const headers = {
    Authorization: `Bearer ${apiToken}`,
    'Content-Type': 'application/json',
  };
  const body: Record<string, unknown> = {
    hostname,
    ssl: buildCustomHostnameSslSettings(normalizedOptions),
  };
  if (normalizedOptions.customOriginServer) {
    body.custom_origin_server = normalizedOptions.customOriginServer;
  }
  return callCloudflareApi<CfCustomHostname>(
    url,
    {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    },
    `create custom hostname ${hostname}`
  );
}

export async function refreshCustomHostnameValidation(
  zoneId: string,
  apiToken: string,
  hostnameId: string,
  options: CustomHostnameOptions | string = {}
): Promise<CfCustomHostname | null> {
  const normalizedOptions =
    typeof options === 'string' ? { customOriginServer: options } : options;
  const url = `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zoneId)}/custom_hostnames/${encodeURIComponent(hostnameId)}`;
  const headers = {
    Authorization: `Bearer ${apiToken}`,
    'Content-Type': 'application/json',
  };
  const body: Record<string, unknown> = {
    ssl: buildCustomHostnameSslSettings(normalizedOptions),
  };
  if (normalizedOptions.customOriginServer) {
    body.custom_origin_server = normalizedOptions.customOriginServer;
  }
  return callCloudflareApi<CfCustomHostname>(
    url,
    {
      method: 'PATCH',
      headers,
      body: JSON.stringify(body),
    },
    `refresh custom hostname validation ${hostnameId}`
  );
}

export async function createOrRefreshCustomHostname(
  zoneId: string,
  apiToken: string,
  hostname: string,
  options: CustomHostnameOptions | string = {}
): Promise<CfCustomHostname | null> {
  const created = await createCustomHostname(zoneId, apiToken, hostname, options);
  if (created) {
    return created;
  }

  const existing = await findCustomHostnameByHostname(zoneId, apiToken, hostname);
  if (!existing) {
    return null;
  }

  return (
    await refreshCustomHostnameValidation(zoneId, apiToken, existing.id, options)
  ) ?? existing;
}

export async function getCustomHostnameStatus(
  zoneId: string,
  apiToken: string,
  hostnameId: string
): Promise<CfCustomHostname | null> {
  const url = `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zoneId)}/custom_hostnames/${encodeURIComponent(hostnameId)}`;
  const headers = { Authorization: `Bearer ${apiToken}` };
  return callCloudflareApi<CfCustomHostname>(
    url,
    { method: 'GET', headers },
    `get custom hostname status ${hostnameId}`
  );
}

export async function deleteCustomHostname(
  zoneId: string,
  apiToken: string,
  hostnameId: string
): Promise<boolean> {
  const url = `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zoneId)}/custom_hostnames/${encodeURIComponent(hostnameId)}`;
  try {
    const resp = await fetch(url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${apiToken}` },
    });
    if (resp.ok || resp.status === 404) return true;
    const body = await resp.text();
    console.warn('[cf-api] delete custom hostname failed', {
      hostnameId,
      status: resp.status,
      bodyPreview: body.slice(0, 512),
    });
    return false;
  } catch (err) {
    console.error('[cf-api] delete custom hostname error', err);
    return false;
  }
}

export async function getDcvDelegationUuid(
  zoneId: string,
  apiToken: string
): Promise<string | null> {
  const url = `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zoneId)}/dcv_delegation/uuid`;
  try {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${apiToken}` },
    });
    if (!resp.ok) return null;
    const data = await resp.json() as { result?: { uuid: string } };
    return data.result?.uuid ?? null;
  } catch (err) {
    console.error('[cf-api] get DCV delegation UUID error', err);
    return null;
  }
}

export async function listCustomHostnames(
  zoneId: string,
  apiToken: string,
  hostnameContains: string
): Promise<CfCustomHostname[]> {
  const results: CfCustomHostname[] = [];
  let page = 1;
  const perPage = 50;
  while (true) {
    const url = `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zoneId)}/custom_hostnames?hostname_contains=${encodeURIComponent(hostnameContains)}&per_page=${perPage}&page=${page}`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${apiToken}` },
    });
    if (!resp.ok) break;
    const data = await resp.json() as { result?: CfCustomHostname[]; result_info?: { total_pages: number } };
    if (!data.result?.length) break;
    results.push(...data.result);
    if (page >= (data.result_info?.total_pages ?? 1)) break;
    page++;
  }
  return results;
}

export async function findCustomHostnameByHostname(
  zoneId: string,
  apiToken: string,
  hostname: string
): Promise<CfCustomHostname | null> {
  const normalizedHostname = hostname.trim().toLowerCase();
  const hostnames = await listCustomHostnames(zoneId, apiToken, normalizedHostname);
  return hostnames.find((entry) => entry.hostname.trim().toLowerCase() === normalizedHostname) ?? null;
}

export async function listCustomHostnamesByBaseDomain(
  zoneId: string,
  apiToken: string,
  baseDomain: string
): Promise<CfCustomHostname[]> {
  const normalizedBaseDomain = baseDomain.trim().toLowerCase();
  const suffix = `.${normalizedBaseDomain}`;
  const hostnames = await listCustomHostnames(zoneId, apiToken, normalizedBaseDomain);
  return hostnames.filter((entry) => entry.hostname.trim().toLowerCase().endsWith(suffix));
}

/**
 * Sync integration secrets to a single deployed worker.
 * Called after deploys and when secrets need to be updated.
 */
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
    const credentials = await decryptCredentials(record.credentials_encrypted, env.INTEGRATION_SECRET_KEY);
    const config = JSON.parse(record.config) as Record<string, unknown>;
    Object.assign(secretsToSync, mapCredentialsToEnvVars(record.name, record.integration_type, credentials, config));
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

/**
 * Sync integration secrets to ALL deployed workers in a workspace.
 * Called when integrations are created/updated/deleted or when OAuth tokens are refreshed.
 *
 * This ensures deployed workers always have up-to-date credentials.
 */
export async function syncAllWorkspaceWorkerSecrets(
  env: CfApiProxyEnv,
  workspaceId: string,
  orgId: string
): Promise<{ synced: number; failed: number }> {
  const accountId = env.CF_ACCOUNT_ID?.trim();
  const dispatchNamespace = env.CF_DISPATCH_NAMESPACE?.trim();
  const apiToken = env.CF_API_TOKEN?.trim();

  if (!accountId || !dispatchNamespace || !apiToken) {
    console.warn('[cf-api-proxy] syncAllWorkspaceWorkerSecrets: missing CF config, skipping');
    return { synced: 0, failed: 0 };
  }

  // Get org slug for dispatch script name format
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  const orgSlug = await orgStub.getSlug();
  if (!orgSlug) {
    console.warn('[cf-api-proxy] syncAllWorkspaceWorkerSecrets: org has no slug, skipping');
    return { synced: 0, failed: 0 };
  }

  // Get all workers deployed from this workspace
  const workers = await orgStub.listWorkerScriptsByWorkspace(workspaceId);
  if (workers.length === 0) {
    return { synced: 0, failed: 0 };
  }

  console.log(`[cf-api-proxy] syncing secrets to ${workers.length} workers in workspace ${workspaceId}`);

  let synced = 0;
  let failed = 0;

  // Sync secrets to each worker
  await Promise.all(workers.map(async (worker) => {
    // Dispatch script name format: {script-name}--{org-slug}
    const dispatchScriptName = `${worker.script_name}--${orgSlug}`;
    try {
      await syncDispatchScriptSecrets(
        env,
        workspaceId,
        orgId,
        accountId,
        dispatchNamespace,
        dispatchScriptName,
        apiToken
      );
      synced++;
      console.log(`[cf-api-proxy] synced secrets to worker ${worker.script_name}`);
    } catch (err) {
      failed++;
      console.error(`[cf-api-proxy] failed to sync secrets to worker ${worker.script_name}:`, err);
    }
  }));

  return { synced, failed };
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

    const resp = await fetch(upstreamUrl, {
      method: 'POST',
      headers,
      body: request.body,
    });
    return new Response(resp.body, { status: resp.status, headers: resp.headers });
  }

  // Check sandbox proxy secret first (static secret from sandbox host)
  let orgId: string;
  let orgSlug: string | undefined;
  let workspaceId: string;
  let userId: string | undefined;
  let threadId: string | undefined;

  const proxyAuth = validateSandboxProxy(request, env);
  if (proxyAuth.valid) {
    orgId = proxyAuth.orgId;
    workspaceId = proxyAuth.workspaceId;
    userId = proxyAuth.userId;
    threadId = proxyAuth.threadId;

    // Look up org_slug from OrgDO (needed for script namespacing)
    const orgStub = env.ORG.get(env.ORG.idFromName(orgId)) as DurableObjectStub<OrgDO>;
    orgSlug = await orgStub.getSlug() ?? undefined;
    if (!orgSlug) {
      console.warn('[cf-api-proxy] sandbox proxy: org has no slug', { orgId });
      return cfApiError(10003, 'Authentication error: Org has no slug', 401);
    }

    console.log('[cf-api-proxy] authenticated via sandbox proxy', { orgId, workspaceId, orgSlug });
  } else {
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

    orgId = tokenPayload.org_id;
    orgSlug = tokenPayload.org_slug;
    workspaceId = tokenPayload.workspace_id;
    userId = tokenPayload.user_id;
    threadId = tokenPayload.thread_id;

    // Require org_slug for deploy operations
    if (!orgSlug) {
      console.warn('[cf-api-proxy] deploy token missing org_slug', {
        method: request.method,
        path: url.pathname,
        orgId,
      });
      return cfApiError(10003, 'Authentication error: Deploy token missing org_slug', 401);
    }
  }

  let pathname = url.pathname;

  // Extract original script name before rewriting
  const originalScriptName = extractScriptName(pathname);

  // Rewrite WFP dispatch namespace (and optionally account id) on the fly.
  // Also rewrite script name to include org-slug suffix: {script-name}--{org-slug}
  // /client/v4/accounts/:account_id/workers/dispatch/namespaces/:dispatch_namespace/scripts/:script/...
  const dispatchMatch = pathname.match(/^\/client\/v4\/accounts\/([^\/]+)\/workers\/dispatch\/namespaces\/([^\/]+)\/(.*)$/);
  if (dispatchMatch) {
    let rest = dispatchMatch[3] ?? '';
    const rewrittenAccount = accountId ?? dispatchMatch[1]!;
    const rewrittenNs = dispatchNamespace ?? dispatchMatch[2]!;

    // Rewrite script name to include org-slug suffix
    // rest might be: scripts/{scriptName} or scripts/{scriptName}/settings etc.
    const scriptPathMatch = rest.match(/^scripts\/([^\/]+)(\/.*)?$/);
    if (scriptPathMatch && originalScriptName) {
      const suffix = scriptPathMatch[2] ?? '';
      const dispatchScriptName = `${originalScriptName}--${orgSlug}`;
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

  // Intercept R2 bucket verification requests from wrangler.
  // Wrangler checks if the bucket exists before deploying a worker with r2_bucket bindings.
  // Since we virtualize all R2 buckets, return a synthetic success response.
  const r2BucketMatch = pathname.match(/^\/client\/v4\/accounts\/[^/]+\/r2\/buckets\/([^/]+)$/);
  if (r2BucketMatch && request.method === 'GET') {
    const bucketName = decodeURIComponent(r2BucketMatch[1]!);
    console.log('[cf-api-proxy] intercepted R2 bucket verification (virtual bucket)', {
      bucketName,
      workspaceId,
      orgId,
    });
    return new Response(JSON.stringify({
      success: true,
      errors: [],
      messages: [],
      result: {
        name: bucketName,
        creation_date: new Date().toISOString(),
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
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
  // Scripts are named {script-name}--{org-slug}, so org A cannot deploy to org B's scripts.
  // The org-slug in the token is verified, so the script name prefix is trusted.
  const dispatchScriptName = originalScriptName ? `${originalScriptName}--${orgSlug}` : null;

  // Intercept tail creation requests (wrangler tail) and return our WebSocket URL
  const tailMatch = pathname.match(DISPATCH_SCRIPT_TAILS);
  if (tailMatch && request.method.toUpperCase() === 'POST' && originalScriptName && dispatchScriptName) {
    // Generate a tail token for WebSocket auth
    const tailToken = await createSignedToken(env.TOKEN_SIGNING_SECRET, {
      org_id: orgId,
      org_slug: orgSlug,
      scopes: ['tail'],
      exp: Date.now() + 60 * 60 * 1000, // 1 hour
      workspace_id: workspaceId,
      script_name: originalScriptName,
      dispatch_script_name: dispatchScriptName,
      name: `tail-${dispatchScriptName}`,
    });

    // Build WebSocket URL - use WORKER_BASE_URL or derive from request
    const baseUrl = env.WORKER_BASE_URL || `https://${url.hostname}`;
    const wsUrl = `${baseUrl.replace(/^http/, 'ws')}/ws/logs?scriptName=${encodeURIComponent(originalScriptName)}&token=${encodeURIComponent(tailToken)}`;

    console.log('[cf-api-proxy] intercepted tail request', {
      scriptName: originalScriptName,
      dispatchScriptName,
      orgId,
    });

    // Return Cloudflare-compatible tail response
    return new Response(JSON.stringify({
      success: true,
      errors: [],
      messages: [],
      result: {
        id: crypto.randomUUID(),
        url: wsUrl,
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const upstreamUrl = new URL(`https://api.cloudflare.com${pathname}${url.search}`);
  const headers = new Headers(request.headers);

  // Always use our Worker token when proxying (POC).
  headers.set('Authorization', `Bearer ${upstreamApiToken}`);
  headers.delete('cookie');
  headers.delete('host');

  const method = request.method.toUpperCase();
  let body: ArrayBuffer | undefined =
    method === 'GET' || method === 'HEAD'
      ? undefined
      : await request.arrayBuffer();

  // Extract configPath and validate bindings from metadata if present in upload
  let configPath: string | undefined;
  if (body && isUploadRequest(pathname, method)) {
    const contentType = request.headers.get('Content-Type') ?? '';
    if (contentType.toLowerCase().includes('multipart/form-data')) {
      const uploadInfo = parseMultipartUploads(body, contentType);
      if (uploadInfo?.configPath) {
        configPath = uploadInfo.configPath;
      }

      // Validate bindings - block forbidden binding types
      if (uploadInfo?.bindings?.length) {
        const validationResult = validateBindings(uploadInfo.bindings);
        if (!validationResult.valid) {
          const forbiddenList = validationResult.forbiddenBindings
            .map(b => `${b.name} (${b.type})`)
            .join(', ');
          console.warn('[cf-api-proxy] blocked deploy: forbidden bindings', {
            method,
            path: pathname,
            scriptName: originalScriptName,
            orgId,
            workspaceId,
            forbiddenBindings: validationResult.forbiddenBindings,
          });
          return cfApiError(
            10005,
            `Deploy blocked: Your worker contains forbidden bindings: ${forbiddenList}. ` +
            `User workers can only use environment variables and Durable Objects defined in the same script. ` +
            `External resources (KV, D1, Queues, etc.) are not allowed unless virtualized by the platform (R2, DATA_PROXY, AI).`,
            403
          );
        }
        console.log('[cf-api-proxy] bindings validated', {
          method,
          path: pathname,
          bindingCount: uploadInfo.bindings.length,
          bindingTypes: [...new Set(uploadInfo.bindings.map(b => b.type))],
        });
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

  // Validate bindings in JSON body requests (settings PATCH, versions POST)
  if (body && isBindingsJsonRequest(pathname, method)) {
    const contentType = request.headers.get('Content-Type') ?? '';
    if (contentType.toLowerCase().includes('application/json')) {
      try {
        const decoder = new TextDecoder('utf-8');
        const jsonBody = JSON.parse(decoder.decode(body)) as SettingsRequestBody;
        if (jsonBody.bindings?.length) {
          const validationResult = validateBindings(jsonBody.bindings);
          if (!validationResult.valid) {
            const forbiddenList = validationResult.forbiddenBindings
              .map(b => `${b.name} (${b.type})`)
              .join(', ');
            console.warn('[cf-api-proxy] blocked settings update: forbidden bindings', {
              method,
              path: pathname,
              scriptName: originalScriptName,
              orgId,
              workspaceId,
              forbiddenBindings: validationResult.forbiddenBindings,
            });
            return cfApiError(
              10005,
              `Settings update blocked: Request contains forbidden bindings: ${forbiddenList}. ` +
              `User workers can only use environment variables and Durable Objects defined in the same script. ` +
              `External resources (KV, D1, Queues, etc.) are not allowed unless virtualized by the platform (R2, DATA_PROXY, AI).`,
              403
            );
          }
          console.log('[cf-api-proxy] settings bindings validated', {
            method,
            path: pathname,
            bindingCount: jsonBody.bindings.length,
            bindingTypes: [...new Set(jsonBody.bindings.map(b => b.type))],
          });

          if (env.CF_WORKER_NAME) {
            const transformedBindings = mapVirtualizedBindings(
              jsonBody.bindings,
              workspaceId,
              orgId,
              userId,
              env.CF_WORKER_NAME
            );
            const changed = transformedBindings.some((binding, idx) => {
              const original = jsonBody.bindings?.[idx];
              return JSON.stringify(binding) !== JSON.stringify(original);
            });
            if (changed) {
              jsonBody.bindings = transformedBindings;
              body = new TextEncoder().encode(JSON.stringify(jsonBody)).buffer as ArrayBuffer;
              headers.set('Content-Length', String(body.byteLength));
              console.log('[cf-api-proxy] transformed JSON bindings to virtual bindings', {
                method,
                path: pathname,
                scriptName: originalScriptName,
                orgId,
                workspaceId,
              });
            }
          }
        }
      } catch (e) {
        // If we can't parse the JSON, let Cloudflare handle the error
        console.warn('[cf-api-proxy] failed to parse JSON body for binding validation', {
          method,
          path: pathname,
          error: String(e),
        });
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

  // Transform virtualized bindings into internal service bindings.
  if (body && isUploadRequest(pathname, method) && env.CF_WORKER_NAME) {
    const contentType = request.headers.get('Content-Type') ?? '';
    if (contentType.toLowerCase().includes('multipart/form-data')) {
      const uploadInfo2 = parseMultipartUploads(body, contentType);
      if (uploadInfo2?.rawMetadataJson && uploadInfo2?.bindings) {
        body = transformVirtualBindings(
          body,
          uploadInfo2.rawMetadataJson,
          uploadInfo2.bindings,
          workspaceId,
          orgId,
          userId,
          env.CF_WORKER_NAME
        );
        headers.set('Content-Length', String(body.byteLength));
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

      // Attach tail worker for log capture
      if (env.TAIL_WORKER_NAME) {
        waitUntil(
          syncDispatchScriptSettings(account, dispatchNs, dispatchScriptName, upstreamApiToken, env.TAIL_WORKER_NAME)
            .catch(err => {
              console.error('[cf-api-proxy] failed to configure tail worker', {
                account,
                dispatchNamespace: dispatchNs,
                dispatchScriptName,
                tailWorkerName: env.TAIL_WORKER_NAME,
                error: String(err),
              });
            })
        );
      }

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
                body: JSON.stringify({
                  target: {
                    kind: 'app',
                    scriptName: originalScriptName,
                    isPublic,
                  },
                }),
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
