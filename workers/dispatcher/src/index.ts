/**
 * camelAI Dispatch Worker
 *
 * Routes requests to user workers deployed in the Workers for Platforms
 * dispatch namespace. Supports subdomain-based routing with private worker
 * access control.
 *
 * Example: hello-world.apps.camelai.dev -> routes to worker "hello-world" (same-site for iframe)
 *          hello-world.camelai.app -> routes to worker "hello-world" (vanity URL)
 *
 * Private worker authentication:
 *
 * Same-site requests (*.camelai.dev):
 * - Main app session cookie is available (same domain)
 * - Validates session directly via RPC, no redirect needed
 * - Checks if user is a member of the workspace that deployed the worker
 *
 * Cross-site requests (*.camelai.app vanity URLs):
 * 1. User visits private worker
 * 2. Dispatcher checks dispatcher session cookie
 * 3. If no session, redirects to main app for auth
 * 4. Main app validates user and redirects back with token
 * 5. Dispatcher validates token and creates session cookie
 */

import { DurableObject } from 'cloudflare:workers';

import {
  getDispatcherSession,
  createDispatcherSession,
  validateAndConsumeAuthToken,
  validateAndConsumeScreenshotToken,
  createScreenshotSession,
  getScreenshotSession,
  SCREENSHOT_SESSION_COOKIE,
  SCREENSHOT_SESSION_TTL_SECONDS,
  createAuthState,
  DISPATCHER_SESSION_COOKIE,
  type DispatcherSession,
} from '../../main/src/worker-auth';
import {
  getWorkerAccessInfo,
  resolveMissingRegistryMode,
  shouldFailOpenForMissingRegistry,
  type WorkerAccessInfo,
} from './access-control';
import {
  errorResponse,
  error401Page,
  error403Page,
  error404Page,
  error500Page,
  error503Page,
} from './error-pages';
import { getSessionCookieName } from '../../main/src/cookies';
import { parseSignedSession } from '../../main/src/signed-session';
import type { OrgDO } from '../../main/src/auth';
import {
  selfhostWorkerKey,
  type SelfhostWorkerModule,
  type SelfhostWorkerRecord,
} from '../../main/src/selfhost-worker-registry';
export { AIVirtualBinding } from '../../main/src/ai-virtual-binding';
export { AssetsVirtualBinding } from '../../main/src/assets-virtual-binding';
export { CamelAiService } from '../../main/src/camelai-service';
export { ConnectionsService } from '../../main/src/connections-service';
export { DataProxyService } from '../../main/src/data-proxy-service';
export { KVVirtualNamespace } from '../../main/src/kv-virtual-namespace';
export { R2VirtualBucket } from '../../main/src/r2-virtual-bucket';

interface Env {
  DISPATCHER: {
    get(
      name: string,
      args?: Record<string, unknown>,
      options?: { limits?: { subRequests?: number } }
    ): {
      fetch(request: Request): Promise<Response>;
    };
  };
  APP_KV: KVNamespace;
  SESSIONS: KVNamespace;
  ORG: DurableObjectNamespace<OrgDO>;
  SELFHOST_WORKER_LOADER?: WorkerLoader;
  SELFHOST_APP_RUNNER?: DurableObjectNamespace<SelfhostAppRunner>;
  SELFHOST_DO_DISPATCH?: Fetcher;
  SELFHOST_DO_BRIDGE_SECRET?: string;
  R2_BUCKET?: R2Bucket;
  AI?: Ai;
  INTEGRATION_SECRET_KEY?: string;
  TOKEN_SIGNING_SECRET: string;
  // Set to "true" to skip all auth checks (local development only)
  SKIP_AUTH?: string;
  // Policy for workers missing KV access metadata ("open" during migration, "closed" for strict enforcement)
  DISPATCHER_MISSING_REGISTRY_MODE?: string;
  MAIN_APP_URL?: string;
  CF_ACCOUNT_ID?: string;
  CF_GATEWAY_NAME?: string;
  CF_GATEWAY_TOKEN?: string;
  AI_GATEWAY_AUTH_TOKEN?: string;
  AI_VIRTUAL_MODEL?: string;
  SANDBOX_HOST?: Fetcher;
  SANDBOX_HOST_URL?: string;
  DATA_PROXY_MAX_RESPONSE_BYTES?: string;
  LOCAL_APP_VANITY_DOMAIN?: string;
  LOCAL_APP_IFRAME_DOMAIN?: string;
}

const USER_WORKER_SUBREQUEST_LIMIT = 10_000_000;

function getUserWorker(env: Env, dispatchScriptName: string) {
  return env.DISPATCHER.get(dispatchScriptName, {}, {
    limits: {
      subRequests: USER_WORKER_SUBREQUEST_LIMIT,
    },
  });
}
type UserWorkerBinding = ReturnType<typeof getUserWorker>;

async function fetchUserWorker(worker: UserWorkerBinding, request: Request): Promise<Response> {
  return worker.fetch(request);
}

function isSelfhostPublishingMode(env: Env): boolean {
  const accountId = env.CF_ACCOUNT_ID?.trim().toLowerCase();
  return accountId === 'selfhost';
}

function selfhostDoBridgeSecret(env: Env): string {
  const secret = env.SELFHOST_DO_BRIDGE_SECRET?.trim() || env.TOKEN_SIGNING_SECRET?.trim();
  if (!secret) {
    throw new Error('Missing self-host Durable Object bridge secret');
  }
  return secret;
}

function base64ToArrayBuffer(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

function workerLoaderModule(module: SelfhostWorkerModule): WorkerLoaderModule | string {
  switch (module.type) {
    case 'text':
      return { text: module.content };
    case 'json':
      return { json: JSON.parse(module.content) };
    case 'data':
      return { data: base64ToArrayBuffer(module.content) };
    case 'wasm':
      return { wasm: base64ToArrayBuffer(module.content) };
    case 'js':
    default:
      return module.content;
  }
}

function getDoBindings(record: SelfhostWorkerRecord): Record<string, string> {
  const result: Record<string, string> = {};
  for (const binding of record.bindings) {
    if (
      binding.type === 'durable_object_namespace' &&
      typeof binding.name === 'string' &&
      typeof binding.class_name === 'string' &&
      !binding.script_name
    ) {
      result[binding.name] = binding.class_name;
    }
  }
  return result;
}

function bindingPartName(binding: Record<string, unknown>): string | null {
  return typeof binding.part === 'string'
    ? binding.part
    : typeof binding.name === 'string'
      ? binding.name
      : null;
}

function moduleBytes(module: SelfhostWorkerModule): ArrayBuffer {
  if (module.type === 'data' || module.type === 'wasm') {
    return base64ToArrayBuffer(module.content);
  }
  return new TextEncoder().encode(module.content).buffer;
}

function moduleText(module: SelfhostWorkerModule): string {
  if (module.type === 'data' || module.type === 'wasm') {
    return new TextDecoder().decode(base64ToArrayBuffer(module.content));
  }
  return module.content;
}

function bindingModule(record: SelfhostWorkerRecord, binding: Record<string, unknown>): SelfhostWorkerModule | null {
  const partName = bindingPartName(binding);
  return partName ? record.modules[partName] ?? null : null;
}

function getPlainEnv(record: SelfhostWorkerRecord): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const binding of record.bindings) {
    if (typeof binding.name !== 'string') continue;
    if (binding.type === 'plain_text' || binding.type === 'secret_text') {
      result[binding.name] =
        typeof binding.text === 'string'
          ? binding.text
          : typeof binding.value === 'string'
            ? binding.value
            : '';
    } else if (binding.type === 'json') {
      if (typeof binding.json === 'string') {
        result[binding.name] = JSON.parse(binding.json);
      } else if ('json' in binding) {
        result[binding.name] = binding.json;
      }
    } else if (binding.type === 'text_blob') {
      const module = bindingModule(record, binding);
      if (module) result[binding.name] = moduleText(module);
    } else if (binding.type === 'data_blob') {
      const module = bindingModule(record, binding);
      if (module) result[binding.name] = moduleBytes(module);
    } else if (binding.type === 'wasm_module') {
      const module = bindingModule(record, binding);
      if (module) result[binding.name] = new WebAssembly.Module(moduleBytes(module));
    }
  }
  return result;
}

type SelfhostRuntimeExports = {
  AIVirtualBinding?: (options: { props: Record<string, unknown> }) => unknown;
  AssetsVirtualBinding?: (options: { props: Record<string, unknown> }) => unknown;
  CamelAiService?: (options: { props: Record<string, unknown> }) => unknown;
  ConnectionsService?: (options: { props: Record<string, unknown> }) => unknown;
  DataProxyService?: (options: { props: Record<string, unknown> }) => unknown;
  KVVirtualNamespace?: (options: { props: Record<string, unknown> }) => unknown;
  R2VirtualBucket?: (options: { props: Record<string, unknown> }) => unknown;
};

const SELFHOST_STATIC_PATHS = new Set([
  '/favicon.ico',
  '/favicon.svg',
  '/favicon-16x16.png',
  '/favicon-32x32.png',
  '/apple-touch-icon.png',
  '/android-chrome-192x192.png',
  '/android-chrome-512x512.png',
  '/site.webmanifest',
  '/robots.txt',
]);

function hasFileExtension(pathname: string): boolean {
  const slash = pathname.lastIndexOf('/');
  const lastSegment = slash === -1 ? pathname : pathname.slice(slash + 1);
  return /\.[A-Za-z0-9]{1,16}$/.test(lastSegment);
}

function shouldTrySelfhostAssets(request: Request, url: URL): boolean {
  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return false;
  return (
    url.pathname.startsWith('/assets/') ||
    SELFHOST_STATIC_PATHS.has(url.pathname) ||
    hasFileExtension(url.pathname)
  );
}

function hasAssetsBinding(record: SelfhostWorkerRecord): boolean {
  return record.bindings.some((binding) =>
    binding.type === 'assets' ||
    (binding.type === 'service' && binding.entrypoint === 'AssetsVirtualBinding')
  );
}

type FetcherLike = {
  fetch(request: Request): Promise<Response>;
};

function isFetcherLike(value: unknown): value is FetcherLike {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof (value as { fetch?: unknown }).fetch === 'function'
  );
}

function getServiceBindingProps(binding: Record<string, unknown>): Record<string, unknown> {
  return binding.props && typeof binding.props === 'object' && !Array.isArray(binding.props)
    ? binding.props as Record<string, unknown>
    : {};
}

function addVirtualServiceBinding(
  result: Record<string, unknown>,
  binding: Record<string, unknown>,
  exports: SelfhostRuntimeExports,
): void {
  if (typeof binding.name !== 'string') return;
  const props = getServiceBindingProps(binding);
  const entrypoint = typeof binding.entrypoint === 'string' ? binding.entrypoint : '';

  if (entrypoint === 'R2VirtualBucket') {
    if (!exports.R2VirtualBucket) throw new Error('R2VirtualBucket is not exported');
    result[binding.name] = exports.R2VirtualBucket({ props });
    return;
  }
  if (entrypoint === 'KVVirtualNamespace') {
    if (!exports.KVVirtualNamespace) throw new Error('KVVirtualNamespace is not exported');
    result[binding.name] = exports.KVVirtualNamespace({ props });
    return;
  }
  if (entrypoint === 'AssetsVirtualBinding') {
    if (!exports.AssetsVirtualBinding) throw new Error('AssetsVirtualBinding is not exported');
    result[binding.name] = exports.AssetsVirtualBinding({ props });
    return;
  }
  if (entrypoint === 'AIVirtualBinding') {
    if (!exports.AIVirtualBinding) throw new Error('AIVirtualBinding is not exported');
    result[binding.name] = exports.AIVirtualBinding({ props });
    return;
  }
  if (entrypoint === 'DataProxyService') {
    if (!exports.DataProxyService) throw new Error('DataProxyService is not exported');
    result[binding.name] = exports.DataProxyService({ props });
    return;
  }
  if (entrypoint === 'ConnectionsService') {
    if (!exports.ConnectionsService) throw new Error('ConnectionsService is not exported');
    result[binding.name] = exports.ConnectionsService({ props });
    return;
  }
  if (entrypoint === 'CamelAiService') {
    if (!exports.CamelAiService) throw new Error('CamelAiService is not exported');
    result[binding.name] = exports.CamelAiService({ props });
  }
}

function getVirtualBindingEnv(
  record: SelfhostWorkerRecord,
  exports: SelfhostRuntimeExports,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const binding of record.bindings) {
    if (typeof binding.name !== 'string') continue;

    if (binding.type === 'service') {
      addVirtualServiceBinding(result, binding, exports);
      continue;
    }

    if (binding.type === 'r2_bucket') {
      if (!exports.R2VirtualBucket) throw new Error('R2VirtualBucket is not exported');
      result[binding.name] = exports.R2VirtualBucket({
        props: {
          workspaceId: record.workspaceId,
          bucketName: typeof binding.bucket_name === 'string' ? binding.bucket_name : binding.name,
        },
      });
      continue;
    }

    if (binding.type === 'kv_namespace') {
      if (!exports.KVVirtualNamespace) throw new Error('KVVirtualNamespace is not exported');
      result[binding.name] = exports.KVVirtualNamespace({
        props: {
          workspaceId: record.workspaceId,
          appId: record.appId,
          namespaceId: typeof binding.namespace_id === 'string' ? binding.namespace_id : binding.name,
        },
      });
      continue;
    }

    if (binding.type === 'assets') {
      if (!exports.AssetsVirtualBinding) throw new Error('AssetsVirtualBinding is not exported');
      result[binding.name] = exports.AssetsVirtualBinding({
        props: { appId: record.appId },
      });
      continue;
    }

    if (binding.type === 'ai') {
      if (!exports.AIVirtualBinding) throw new Error('AIVirtualBinding is not exported');
      result[binding.name] = exports.AIVirtualBinding({
        props: {
          orgId: record.orgId,
          workspaceId: record.workspaceId,
        },
      });
    }
  }
  return result;
}

function quotedModuleSpecifier(moduleName: string): string {
  return JSON.stringify(moduleName.startsWith('.') ? moduleName : `./${moduleName}`);
}

function dynamicWorkerWrapperSource(record: SelfhostWorkerRecord, bridgeSecret: string): string {
  const classNames = [...new Set(Object.values(getDoBindings(record)))];
  const reexports = classNames.length > 0
    ? `export { ${classNames.join(', ')} } from ${quotedModuleSpecifier(record.mainModule)};`
    : '';

  return `
${reexports}
import userDefault from ${quotedModuleSpecifier(record.mainModule)};

const SELFHOST_DO_BRIDGE_SECRET = ${JSON.stringify(bridgeSecret)};

class SelfhostDurableObjectId {
  constructor(value, name) {
    this.value = String(value);
    if (name !== undefined) this.name = name;
  }
  toString() {
    return this.value;
  }
  equals(other) {
    return Boolean(other) && String(other) === this.value;
  }
}

class SelfhostDurableObjectStub {
  constructor(dispatcher, appId, className, id, name) {
    this.dispatcher = dispatcher;
    this.appId = appId;
    this.className = className;
    this.id = id;
    if (name !== undefined) this.name = name;
  }
  fetch(input, init) {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL("http://selfhost.local/__selfhost_do/fetch");
    url.searchParams.set("appId", this.appId);
    url.searchParams.set("className", this.className);
    url.searchParams.set("id", this.id.toString());
    const headers = new Headers(request.headers);
    headers.set("x-camelai-selfhost-do-bridge", SELFHOST_DO_BRIDGE_SECRET);
    headers.set("x-camelai-selfhost-do-original-url", request.url);
    const forwardedInit = {
      method: request.method,
      headers,
    };
    if (request.method !== "GET" && request.method !== "HEAD") {
      forwardedInit.body = request.body;
    }
    return this.dispatcher.fetch(new Request(url, forwardedInit));
  }
  async rpc(method, args) {
    const url = new URL("http://selfhost.local/__selfhost_do_rpc");
    url.searchParams.set("payload", JSON.stringify({ method, args }));
    const response = await this.fetch(new Request(url));
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error(await response.text());
    }
    if (!response.ok || !payload?.ok) {
      throw new Error(payload?.error || "Self-host Durable Object RPC failed");
    }
    return payload.result;
  }
}

class SelfhostDurableObjectNamespace {
  constructor(dispatcher, appId, className) {
    this.dispatcher = dispatcher;
    this.appId = appId;
    this.className = className;
  }
  idFromName(name) {
    return new SelfhostDurableObjectId("name:" + String(name), String(name));
  }
  idFromString(id) {
    return new SelfhostDurableObjectId(String(id));
  }
  newUniqueId() {
    return new SelfhostDurableObjectId("unique:" + crypto.randomUUID());
  }
  get(id) {
    const stub = new SelfhostDurableObjectStub(this.dispatcher, this.appId, this.className, id, id.name);
    return new Proxy(stub, {
      get(target, property, receiver) {
        if (typeof property !== "string") {
          return Reflect.get(target, property, receiver);
        }
        if (property in target || property === "then") {
          return Reflect.get(target, property, receiver);
        }
        return (...args) => target.rpc(property, args);
      },
    });
  }
  getByName(name) {
    return this.get(this.idFromName(name));
  }
  jurisdiction() {
    return this;
  }
}

function withSelfhostNamespaces(env) {
  const nextEnv = Object.create(env);
  for (const [bindingName, className] of Object.entries(env.__SELFHOST_DO_BINDINGS || {})) {
    nextEnv[bindingName] = new SelfhostDurableObjectNamespace(
      env.__SELFHOST_DO_DISPATCH,
      env.__SELFHOST_APP_ID,
      className,
    );
  }
  return nextEnv;
}

export default {
  fetch(request, env, ctx) {
    return userDefault.fetch(request, withSelfhostNamespaces(env), ctx);
  }
};
`;
}

export class SelfhostAppRunner extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const appId = request.headers.get('x-camelai-selfhost-app-id')?.trim() ||
      url.searchParams.get('appId')?.trim();
    if (!appId) {
      return new Response('Missing self-host app id', { status: 400 });
    }

    const record = await this.loadRecord(appId);
    if (!record) {
      return new Response('Worker not found', {
        status: 404,
        headers: { 'x-camelai-selfhost-runner-error': 'worker_not_found' },
      });
    }

    if (url.pathname === '/__selfhost_do/facet') {
      return this.fetchFacet(request, url, record);
    }
    const assetResponse = await this.fetchStaticAsset(request, url, record);
    if (assetResponse) return assetResponse;

    const worker = this.loadWorker(record);
    const headers = new Headers(request.headers);
    headers.delete('x-camelai-selfhost-app-id');
    return worker.getEntrypoint().fetch(new Request(request, { headers }));
  }

  private async fetchFacet(
    request: Request,
    url: URL,
    record: SelfhostWorkerRecord,
  ): Promise<Response> {
    const className = url.searchParams.get('className')?.trim();
    const objectId = url.searchParams.get('id')?.trim();
    if (!className || !objectId) {
      return new Response('Missing Durable Object facet target', { status: 400 });
    }

    const worker = this.loadWorker(record);
    const facetName = `${record.appId}:${className}:${objectId}`;
    const facet = this.ctx.facets.get(facetName, () => ({
      id: objectId,
      class: worker.getDurableObjectClass(className),
    }));
    const originalUrl = request.headers.get('x-camelai-selfhost-do-original-url') || request.url;
    const originalParsedUrl = new URL(originalUrl);
    if (originalParsedUrl.pathname === '/__selfhost_do_rpc') {
      return this.fetchRpc(originalParsedUrl, facet);
    }
    const headers = new Headers(request.headers);
    headers.delete('x-camelai-selfhost-do-bridge');
    headers.delete('x-camelai-selfhost-do-original-url');
    headers.delete('x-camelai-selfhost-app-id');
    const forwardedInit: RequestInit = {
      method: request.method,
      headers,
    };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      forwardedInit.body = request.body;
    }
    return facet.fetch(new Request(originalUrl, forwardedInit));
  }

  private async fetchRpc(
    url: URL,
    facet: unknown,
  ): Promise<Response> {
    let payload: { method?: unknown; args?: unknown };
    try {
      payload = JSON.parse(url.searchParams.get('payload') ?? '') as { method?: unknown; args?: unknown };
    } catch {
      return Response.json({ ok: false, error: 'Invalid Durable Object RPC payload' }, { status: 400 });
    }

    if (typeof payload.method !== 'string' || !payload.method || payload.method === 'fetch') {
      return Response.json({ ok: false, error: 'Invalid Durable Object RPC method' }, { status: 400 });
    }
    if (!Array.isArray(payload.args)) {
      return Response.json({ ok: false, error: 'Invalid Durable Object RPC arguments' }, { status: 400 });
    }

    const rpcFacet = facet as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const method = rpcFacet[payload.method];
    if (typeof method !== 'function') {
      return Response.json({
        ok: false,
        error: `Durable Object method not found: ${payload.method}`,
      }, { status: 404 });
    }

    try {
      const result = await rpcFacet[payload.method](...payload.args);
      return Response.json({ ok: true, result });
    } catch (error) {
      return Response.json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }, { status: 500 });
    }
  }

  private async fetchStaticAsset(
    request: Request,
    url: URL,
    record: SelfhostWorkerRecord,
  ): Promise<Response | null> {
    if (!shouldTrySelfhostAssets(request, url) || !hasAssetsBinding(record)) {
      return null;
    }
    const exports = this.ctx.exports as unknown as SelfhostRuntimeExports;
    const binding = exports.AssetsVirtualBinding?.({ props: { appId: record.appId } });
    if (!isFetcherLike(binding)) {
      throw new Error('AssetsVirtualBinding is not exported');
    }
    const response = await binding.fetch(request);
    return response.status === 404 ? null : response;
  }

  private async loadRecord(appId: string): Promise<SelfhostWorkerRecord | null> {
    const stored = await this.env.APP_KV.get(selfhostWorkerKey(appId));
    if (!stored) return null;
    return JSON.parse(stored) as SelfhostWorkerRecord;
  }

  private loadWorker(record: SelfhostWorkerRecord): WorkerStub {
    if (!this.env.SELFHOST_WORKER_LOADER) {
      throw new Error('Missing SELFHOST_WORKER_LOADER binding');
    }
    if (!this.env.SELFHOST_DO_DISPATCH) {
      throw new Error('Missing SELFHOST_DO_DISPATCH binding');
    }

    return this.env.SELFHOST_WORKER_LOADER.get(
      `${record.appId}:${record.version}`,
      () => {
        const modules: Record<string, WorkerLoaderModule | string> = {
          'selfhost-wrapper.js': dynamicWorkerWrapperSource(record, selfhostDoBridgeSecret(this.env)),
        };
        for (const [moduleName, module] of Object.entries(record.modules)) {
          modules[moduleName] = workerLoaderModule(module);
        }

        return {
          compatibilityDate: record.compatibilityDate,
          compatibilityFlags: record.compatibilityFlags,
          mainModule: 'selfhost-wrapper.js',
          modules,
          env: {
            ...getPlainEnv(record),
            ...getVirtualBindingEnv(record, this.ctx.exports as unknown as SelfhostRuntimeExports),
            __SELFHOST_APP_ID: record.appId,
            __SELFHOST_DO_BINDINGS: getDoBindings(record),
            __SELFHOST_DO_DISPATCH: this.env.SELFHOST_DO_DISPATCH,
          },
        };
      },
    );
  }
}

// Helper functions to replace RPC calls

/**
 * Check if a string looks like an environment prefix.
 */
function isEnvPrefix(s: string): boolean {
  return s.startsWith('dev-') || s === 'staging' || s === 'prod';
}

/**
 * New-style org slugs are 6+ purely alphanumeric characters (no hyphens).
 * Old-style slugs (e.g. "ms-workspace-b3c") contain hyphens.
 */
function isNewStyleSlug(slug: string): boolean {
  return /^[a-z0-9]{6,}$/.test(slug);
}

/**
 * Parse worker route from hostname.
 * Returns script name and org slug for new format, or just script name for legacy.
 *
 * New single-hyphen format: {script}-{org-slug}.camelai.app (org slug is 6+ alphanumeric, no hyphens)
 * Old double-hyphen format: {script}--{org-slug}.camelai.app (backwards compat)
 * Legacy format: {script}.camelai.app -> { scriptName, orgSlug: null, dispatchScriptName: scriptName }
 *
 * Dispatch namespace always uses: {script}--{org-slug} (internal, not URL-facing)
 */
interface ParsedWorkerRoute {
  scriptName: string;
  orgSlug: string | null;
  dispatchScriptName: string;
  /**
   * When a single-hyphen parse matched (ambiguous case), this holds the legacy
   * fallback interpretation where the entire segment is treated as the script name.
   * Used to resolve ambiguity at runtime via KV lookup.
   * Example: "report-alpha12" could be script="report" + slug="alpha12" OR legacy script="report-alpha12"
   */
  legacyFallback?: { scriptName: string; dispatchScriptName: string };
}

function getConfiguredDomain(configValue: string | null | undefined): string | null {
  const trimmed = configValue?.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return trimmed || null;
}

function getRequestHostname(request: Request, url: URL): string {
  const host = request.headers.get('Host')?.trim();
  if (!host) return url.hostname;
  return host.replace(/:\d+$/, '').toLowerCase();
}

function parseConfiguredDomainRoute(hostname: string, domain: string): ParsedWorkerRoute | null {
  if (hostname === domain || !hostname.endsWith(`.${domain}`)) {
    return null;
  }
  const prefix = hostname.slice(0, -(domain.length + 1));
  const firstPart = prefix.split('.')[0];
  if (!firstPart) return null;
  const parsed = parseScriptSlug(firstPart);
  if (parsed) return parsed;
  return { scriptName: firstPart, orgSlug: null, dispatchScriptName: firstPart };
}

function parseWorkerRoute(hostname: string, env?: Pick<Env, 'LOCAL_APP_VANITY_DOMAIN' | 'LOCAL_APP_IFRAME_DOMAIN'>): ParsedWorkerRoute | null {
  const configuredVanityDomain = getConfiguredDomain(env?.LOCAL_APP_VANITY_DOMAIN);
  if (configuredVanityDomain) {
    const route = parseConfiguredDomainRoute(hostname, configuredVanityDomain);
    if (route) return route;
  }

  const configuredIframeDomain = getConfiguredDomain(env?.LOCAL_APP_IFRAME_DOMAIN);
  if (configuredIframeDomain) {
    const route = parseConfiguredDomainRoute(hostname, configuredIframeDomain);
    if (route) return route;
  }

  const parts = hostname.split('.');

  // .camelai.app domain
  if (hostname.endsWith('.camelai.app')) {
    if (parts.length < 3) return null;
    const firstPart = parts[0]!;
    const parsed = parseScriptSlug(firstPart);
    if (parsed) return parsed;
    return { scriptName: firstPart, orgSlug: null, dispatchScriptName: firstPart };
  }

  // .apps.camelai.dev domain (same-site for iframes)
  if (hostname.endsWith('.camelai.dev') && hostname.includes('.apps.')) {
    if (parts.length < 4) return null;
    const firstPart = parts[0]!;
    const parsed = parseScriptSlug(firstPart);
    if (parsed) return parsed;
    return { scriptName: firstPart, orgSlug: null, dispatchScriptName: firstPart };
  }

  return null;
}

/**
 * Parse "{script}--{org-slug}" or "{script}-{org-slug}" from a hostname segment.
 * Tries double-hyphen first (old format), then single-hyphen with new-style slug detection.
 */
function parseScriptSlug(segment: string): ParsedWorkerRoute | null {
  // Old format: double-hyphen separator (e.g. "my-app--ms-workspace-b3c")
  if (segment.includes('--')) {
    const separatorIndex = segment.indexOf('--');
    const scriptName = segment.slice(0, separatorIndex);
    const orgSlug = segment.slice(separatorIndex + 2);
    if (!orgSlug || !scriptName) return null;
    return { scriptName, orgSlug, dispatchScriptName: `${scriptName}--${orgSlug}` };
  }

  // New format: last hyphen is the separator, slug is 6+ alphanumeric (e.g. "my-app-k7m2p3")
  // This is ambiguous: "report-alpha12" could be script="report" + slug="alpha12"
  // OR a legacy script named "report-alpha12". We include a legacyFallback so the
  // dispatcher can resolve the ambiguity at runtime via KV lookup.
  const lastHyphen = segment.lastIndexOf('-');
  if (lastHyphen > 0) {
    const candidate = segment.slice(lastHyphen + 1);
    if (isNewStyleSlug(candidate)) {
      const scriptName = segment.slice(0, lastHyphen);
      return {
        scriptName,
        orgSlug: candidate,
        dispatchScriptName: `${scriptName}--${candidate}`,
        legacyFallback: { scriptName: segment, dispatchScriptName: segment },
      };
    }
  }

  return null;
}

/**
 * Check if user is a member of an org
 */
async function isOrgMember(
  orgNamespace: DurableObjectNamespace<OrgDO>,
  userId: string,
  orgId: string
): Promise<boolean> {
  const stub = orgNamespace.get(orgNamespace.idFromName(orgId)) as DurableObjectStub<OrgDO>;
  return stub.isMember(userId);
}

/**
 * Get org slug from OrgDO
 */
async function getOrgSlug(
  orgNamespace: DurableObjectNamespace<OrgDO>,
  orgId: string
): Promise<string | null> {
  try {
    const stub = orgNamespace.get(orgNamespace.idFromName(orgId)) as DurableObjectStub<OrgDO>;
    return await stub.getSlug();
  } catch {
    return null;
  }
}

/**
 * Build the canonical URL for a worker.
 * New-style slugs (6+ alphanumeric) use single hyphen: {script}-{slug}.domain
 * Old-style slugs (contain hyphens) use double hyphen: {script}--{slug}.domain
 */
function appendCurrentPort(url: URL, hostname: string): string {
  return url.port ? `${hostname}:${url.port}` : hostname;
}

function buildNewFormatUrl(url: URL, hostname: string, scriptName: string, orgSlug: string, env?: Env): string {
  const parts = hostname.split('.');
  const separator = isNewStyleSlug(orgSlug) ? '-' : '--';
  const label = `${scriptName}${separator}${orgSlug}`;

  const configuredVanityDomain = getConfiguredDomain(env?.LOCAL_APP_VANITY_DOMAIN);
  if (configuredVanityDomain && parseConfiguredDomainRoute(hostname, configuredVanityDomain)) {
    return `${url.protocol}//${appendCurrentPort(url, `${label}.${configuredVanityDomain}`)}${url.pathname}${url.search}`;
  }

  const configuredIframeDomain = getConfiguredDomain(env?.LOCAL_APP_IFRAME_DOMAIN);
  if (configuredIframeDomain && parseConfiguredDomainRoute(hostname, configuredIframeDomain)) {
    return `${url.protocol}//${appendCurrentPort(url, `${label}.${configuredIframeDomain}`)}${url.pathname}${url.search}`;
  }

  // For .camelai.app domains
  if (hostname.endsWith('.camelai.app')) {
    if (parts.length === 3) {
      return `${url.protocol}//${appendCurrentPort(url, `${label}.camelai.app`)}${url.pathname}${url.search}`;
    }
    if (parts.length === 4 && (parts[1]?.startsWith('dev-') || parts[1] === 'staging')) {
      return `${url.protocol}//${appendCurrentPort(url, `${label}.${parts[1]}.camelai.app`)}${url.pathname}${url.search}`;
    }
  }

  // For .apps.camelai.dev domains
  if (hostname.endsWith('.camelai.dev') && hostname.includes('.apps.')) {
    if (parts.length === 4 && parts[1] === 'apps') {
      return `${url.protocol}//${appendCurrentPort(url, `${label}.apps.camelai.dev`)}${url.pathname}${url.search}`;
    }
    if (parts.length === 5 && parts[1] === 'apps') {
      return `${url.protocol}//${appendCurrentPort(url, `${label}.apps.${parts[2]}.camelai.dev`)}${url.pathname}${url.search}`;
    }
  }

  return url.toString();
}

// Cookie settings for dispatcher session
const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days
const SCREENSHOT_SESSION_MAX_AGE = SCREENSHOT_SESSION_TTL_SECONDS;

// Main app URL for auth redirects (determined from request hostname)
function getMainAppUrl(hostname: string, configuredMainAppUrl?: string): string {
  const explicitUrl = configuredMainAppUrl?.trim();
  if (explicitUrl) {
    return explicitUrl;
  }

  // Extract environment from hostname
  // New format: worker.org-slug.camelai.app -> camelai.dev (main app)
  // New format: worker.org-slug.dev-miguel.camelai.app -> dev-miguel.camelai.dev (main app)
  // Legacy: worker.camelai.app -> camelai.dev (main app)
  // Legacy: worker.dev-miguel.camelai.app -> dev-miguel.camelai.dev (main app)
  // Local: worker.local.camelai.app -> local.camelai.dev (main app)
  const parts = hostname.split('.');

  const isKnownEnvPrefix = (s: string | undefined): boolean =>
    s !== undefined && (s.startsWith('dev-') || s === 'staging' || s === 'prod' || s === 'local');

  // For .camelai.app domains
  if (hostname.endsWith('.camelai.app')) {
    // Find the environment prefix if any (e.g., dev-miguel, staging, local)
    // It's the part before .camelai.app that looks like an env prefix
    for (let i = parts.length - 3; i >= 1; i--) {
      if (isKnownEnvPrefix(parts[i])) {
        const envPrefix = parts[i];
        return `https://${envPrefix}.camelai.dev`;
      }
    }
    return 'https://camelai.dev';
  }

  // For .camelai.dev domains (same-site)
  if (hostname.endsWith('.camelai.dev')) {
    // Remove worker and org-slug subdomains
    for (let i = parts.length - 3; i >= 1; i--) {
      if (isKnownEnvPrefix(parts[i])) {
        const envPrefix = parts[i];
        return `https://${envPrefix}.camelai.dev`;
      }
    }
    return 'https://camelai.dev';
  }

  // Fallback to camelai.dev
  return 'https://camelai.dev';
}

// Parse cookie value from Cookie header
function getCookieValue(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  const cookies = cookieHeader.split(';').map((c) => c.trim());
  for (const cookie of cookies) {
    const [key, ...valueParts] = cookie.split('=');
    if (key === name) {
      return valueParts.join('=');
    }
  }
  return null;
}

// Create Set-Cookie header for session
function createSessionCookie(sessionId: string, hostname: string, cookieDomain?: string): string {
  // Get domain for cookie (e.g., .camelai.app to cover all subdomains)
  // For custom domains, the caller provides the exact hostname.
  let domain: string;
  if (cookieDomain) {
    domain = `.${cookieDomain}`;
  } else {
    const parts = hostname.split('.');
    domain = parts.length >= 2 ? `.${parts.slice(-2).join('.')}` : hostname;
  }

  return [
    `${DISPATCHER_SESSION_COOKIE}=${sessionId}`,
    `Path=/`,
    `Domain=${domain}`,
    `Max-Age=${SESSION_MAX_AGE}`,
    `HttpOnly`,
    `Secure`,
    `SameSite=Lax`,
  ].join('; ');
}

// Create Set-Cookie header for screenshot sessions (host-only)
function createScreenshotSessionCookie(sessionId: string): string {
  return [
    `${SCREENSHOT_SESSION_COOKIE}=${sessionId}`,
    `Path=/`,
    `Max-Age=${SCREENSHOT_SESSION_MAX_AGE}`,
    `HttpOnly`,
    `Secure`,
    `SameSite=Lax`,
  ].join('; ');
}

// Check if request is from same-site (any *.camelai.dev subdomain)
// These requests will have the main app session cookie available since they share the same domain
function isSameSiteRequest(hostname: string): boolean {
  return hostname.endsWith('.camelai.dev');
}

// Auth callback route
const AUTH_CALLBACK_PATH = '/__chiridion_auth/callback';

/**
 * Resolve an exact custom domain hostname to a worker route.
 */
async function resolveCustomDomainRoute(
  env: Env,
  hostname: string
): Promise<{ scriptName: string; orgSlug: string; dispatchScriptName: string; cookieDomain: string } | null> {
  const kvData = await env.APP_KV.get(`custom_domain_host:${hostname}`);
  if (!kvData) return null;

  try {
    const data = JSON.parse(kvData) as {
      org_slug: string;
      script_name: string;
      dispatch_script_name?: string;
    };
    const dispatchScriptName = data.dispatch_script_name ?? `${data.script_name}--${data.org_slug}`;
    console.log(`[dispatcher] Custom domain route: ${hostname} -> ${dispatchScriptName}`);
    return {
      scriptName: data.script_name,
      orgSlug: data.org_slug,
      dispatchScriptName,
      cookieDomain: hostname,
    };
  } catch (e) {
    console.error(`[dispatcher] Error parsing custom domain host data for ${hostname}:`, e);
  }
  return null;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const hostname = getRequestHostname(request, url);

    if (url.pathname === '/__selfhost_do/fetch') {
      const bridgeToken = request.headers.get('x-camelai-selfhost-do-bridge')?.trim();
      if (!bridgeToken || bridgeToken !== selfhostDoBridgeSecret(env)) {
        return new Response('Not found', { status: 404 });
      }
      const appId = url.searchParams.get('appId')?.trim();
      if (!appId || !env.SELFHOST_APP_RUNNER) {
        return new Response('Self-host Durable Object dispatch is not configured', { status: 500 });
      }
      const facetUrl = new URL(url);
      facetUrl.pathname = '/__selfhost_do/facet';
      const headers = new Headers(request.headers);
      headers.set('x-camelai-selfhost-app-id', appId);
      const runner = env.SELFHOST_APP_RUNNER.get(env.SELFHOST_APP_RUNNER.idFromName(appId));
      const forwardedInit: RequestInit = {
        headers,
        method: request.method,
      };
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        forwardedInit.body = request.body;
      }
      return runner.fetch(new Request(facetUrl.toString(), forwardedInit));
    }

    // Parse worker route from hostname
    const route = parseWorkerRoute(hostname, env);
    if (route) {
      const { scriptName, orgSlug, dispatchScriptName, legacyFallback } = route;

      // Handle auth callback route
      if (url.pathname === AUTH_CALLBACK_PATH) {
        return handleAuthCallback(request, env, scriptName, orgSlug, dispatchScriptName, legacyFallback);
      }

      // Check worker access
      return handleWorkerRequest(request, env, ctx, scriptName, orgSlug, dispatchScriptName, legacyFallback);
    }

    // Not a known *.camelai.app or *.apps.camelai.dev hostname — try custom domain zone lookup
    // Look up exact custom hostname in KV
    const customDomainRoute = await resolveCustomDomainRoute(env, hostname);
    if (customDomainRoute) {
      const { scriptName, orgSlug, dispatchScriptName, cookieDomain } = customDomainRoute;
      if (url.pathname === AUTH_CALLBACK_PATH) {
        return handleAuthCallback(request, env, scriptName, orgSlug, dispatchScriptName, undefined, cookieDomain);
      }
      return handleWorkerRequest(request, env, ctx, scriptName, orgSlug, dispatchScriptName);
    }

    // Default response for apex domain or unknown hostname
    return new Response(
      JSON.stringify(
        {
          message: 'camelAI Dispatch Worker',
          routes: {
            vanity: '<worker-name>-<org-slug>.camelai.app',
            iframe: '<worker-name>-<org-slug>.apps.camelai.dev',
          },
          example: 'my-app-k7m2p3.camelai.app',
        },
        null,
        2
      ),
      {
        headers: { 'Content-Type': 'application/json' },
      }
    );
  },
};

/**
 * Handle auth callback - validates token and creates session
 */
async function handleAuthCallback(
  request: Request,
  env: Env,
  scriptName: string,
  _orgSlug: string | null,
  _dispatchScriptName: string,
  legacyFallback?: { scriptName: string; dispatchScriptName: string },
  cookieDomain?: string
): Promise<Response> {
  const url = new URL(request.url);
  const hostname = getRequestHostname(request, url);
  const token = url.searchParams.get('token');
  const state = url.searchParams.get('state');

  if (!token || !state) {
    return new Response('Missing token or state parameter', { status: 400 });
  }

  // Validate and consume the one-time token
  const tokenData = await validateAndConsumeAuthToken(env.APP_KV, token);
  if (!tokenData) {
    return new Response('Invalid or expired token', { status: 400 });
  }

  // Verify state matches (CSRF protection)
  if (tokenData.state !== state) {
    return new Response('State mismatch', { status: 400 });
  }

  // Verify script name matches (user-facing name, not dispatch name).
  // For ambiguous single-hyphen hostnames, also accept the legacy fallback
  // script name (e.g. token issued for "report-alpha12" should match
  // hostname "report-alpha12.camelai.app" even though the parser initially
  // splits it as script="report" + slug="alpha12").
  if (tokenData.script_name !== scriptName && tokenData.script_name !== legacyFallback?.scriptName) {
    return new Response('Script name mismatch', { status: 400 });
  }

  // Create dispatcher session
  const { sessionId } = await createDispatcherSession(
    env.SESSIONS,
    tokenData.user_id,
    tokenData.org_id
  );

  // Build redirect URL (remove the callback path and query params)
  const redirectUrl = new URL(`${url.protocol}//${appendCurrentPort(url, hostname)}`);
  redirectUrl.pathname = '/';

  // Redirect with session cookie
  return new Response(null, {
    status: 302,
    headers: {
      'Location': redirectUrl.toString(),
      'Set-Cookie': createSessionCookie(sessionId, hostname, cookieDomain),
    },
  });
}

/**
 * Handle worker request - checks access and dispatches or redirects
 */
async function handleWorkerRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  scriptName: string,
  orgSlug: string | null,
  dispatchScriptName: string,
  legacyFallback?: { scriptName: string; dispatchScriptName: string }
): Promise<Response> {
  const url = new URL(request.url);
  const hostname = getRequestHostname(request, url);
  const legacyDispatchScriptName = orgSlug ? scriptName : undefined;

  // Skip all auth checks in local development mode
  if (env.SKIP_AUTH === 'true') {
    console.log(`[dispatcher] SKIP_AUTH enabled, dispatching directly to: ${dispatchScriptName}`);
    return dispatchToWorker(request, env, ctx, dispatchScriptName, scriptName, legacyDispatchScriptName);
  }

  const cookieHeader = request.headers.get('Cookie');
  const screenshotHeader = request.headers.get('x-chiridion-screenshot-token')?.trim();
  const authHeader = request.headers.get('Authorization') ?? '';
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)\s*$/i);
  const bearerToken = bearerMatch?.[1]?.trim();
  const screenshotToken = screenshotHeader || bearerToken || null;
  const hasScreenshotBearer = Boolean(bearerToken && bearerToken.startsWith('stkn_'));

  // Resolve effective script identity early so screenshot auth checks the
  // correct scriptName. For ambiguous single-hyphen hostnames (e.g.
  // "report-alpha12") the initial parse may split incorrectly; the KV lookup
  // + legacy fallback here corrects it before any token validation.
  let accessInfo: WorkerAccessInfo | null = null;
  let effectiveScriptName = scriptName;
  let effectiveOrgSlug = orgSlug;
  let effectiveDispatchScriptName = dispatchScriptName;
  let effectiveLegacyDispatchScriptName = legacyDispatchScriptName;
  try {
    accessInfo = await getWorkerAccessInfo(env.APP_KV, dispatchScriptName, scriptName, orgSlug);
  } catch (e) {
    console.error(`[dispatcher] Error getting worker access info: ${e}`);
    return errorResponse(error503Page(getMainAppUrl(hostname, env.MAIN_APP_URL)));
  }

  // Ambiguity resolution: If the single-hyphen parse found no KV entry, retry
  // with the full segment as a legacy script name. This handles legacy apps like
  // "report-alpha12" where "alpha12" looks like a new-style slug but isn't.
  if (!accessInfo && legacyFallback) {
    try {
      const fallbackAccessInfo = await getWorkerAccessInfo(
        env.APP_KV,
        legacyFallback.dispatchScriptName,
        legacyFallback.scriptName,
        null
      );
      if (fallbackAccessInfo) {
        console.log(`[dispatcher] Ambiguous hostname resolved as legacy script: ${legacyFallback.scriptName}`);
        accessInfo = fallbackAccessInfo;
        effectiveScriptName = legacyFallback.scriptName;
        effectiveOrgSlug = null;
        effectiveDispatchScriptName = legacyFallback.dispatchScriptName;
        effectiveLegacyDispatchScriptName = undefined;
      }
    } catch (e) {
      console.error(`[dispatcher] Error checking legacy fallback: ${e}`);
    }
  }

  const screenshotSessionId = getCookieValue(cookieHeader, SCREENSHOT_SESSION_COOKIE);
  if (screenshotSessionId) {
    const session = await getScreenshotSession(env.SESSIONS, screenshotSessionId);
    // Screenshot session stores user-facing scriptName — use resolved effectiveScriptName
    if (session && session.script_name === effectiveScriptName) {
      if (screenshotHeader || hasScreenshotBearer) {
        const forwardHeaders = new Headers(request.headers);
        forwardHeaders.delete('x-chiridion-screenshot-token');
        if (hasScreenshotBearer) {
          forwardHeaders.delete('Authorization');
        }
        return dispatchToWorker(new Request(request, { headers: forwardHeaders }), env, ctx, effectiveDispatchScriptName, effectiveScriptName, effectiveLegacyDispatchScriptName);
      }
      return dispatchToWorker(request, env, ctx, effectiveDispatchScriptName, effectiveScriptName, effectiveLegacyDispatchScriptName);
    }
  }

  if (screenshotToken?.startsWith('stkn_')) {
    const tokenData = await validateAndConsumeScreenshotToken(env.APP_KV, screenshotToken);
    // Token stores user-facing scriptName — use resolved effectiveScriptName
    if (!tokenData || tokenData.script_name !== effectiveScriptName) {
      return new Response('Invalid screenshot token', { status: 401 });
    }

    const { sessionId } = await createScreenshotSession(env.SESSIONS, {
      script_name: tokenData.script_name,
      org_id: tokenData.org_id,
    });

    const forwardHeaders = new Headers(request.headers);
    forwardHeaders.delete('x-chiridion-screenshot-token');
    if (screenshotToken === bearerToken) {
      forwardHeaders.delete('Authorization');
    }

    const response = await dispatchToWorker(
      new Request(request, { headers: forwardHeaders }),
      env,
      ctx,
      effectiveDispatchScriptName,
      effectiveScriptName,
      effectiveLegacyDispatchScriptName
    );
    const headers = new Headers(response.headers);
    headers.append('Set-Cookie', createScreenshotSessionCookie(sessionId));
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } else if (screenshotHeader) {
    return new Response('Invalid screenshot token', { status: 401 });
  }

  const missingRegistryMode = resolveMissingRegistryMode(env.DISPATCHER_MISSING_REGISTRY_MODE);

  if (!accessInfo) {
    if (shouldFailOpenForMissingRegistry(missingRegistryMode, effectiveOrgSlug)) {
      console.warn(`[dispatcher] Worker "${effectiveDispatchScriptName}" not in registry, dispatching anyway (fail open)`); // TEMP migration mode
      return dispatchToWorker(request, env, ctx, effectiveDispatchScriptName, effectiveScriptName, effectiveLegacyDispatchScriptName);
    }
    console.warn(`[dispatcher] Worker "${effectiveDispatchScriptName}" not in registry, denying access (fail closed)`);
    return errorResponse(error404Page(getMainAppUrl(hostname, env.MAIN_APP_URL), effectiveScriptName));
  }

  // Legacy URL redirect: If using old URL format AND the worker was deployed with the
  // new system (has org_slug in KV), redirect to the new URL format.
  //
  // Cases:
  // 1. orgSlug !== null: Already using new URL format, no redirect needed
  // 2. is_legacy: false: Found in new KV format (means dispatchScriptName already has org-slug prefix)
  // 3. is_legacy: true AND has org_slug: Worker was redeployed with new system, redirect to new URL
  // 4. is_legacy: true AND no org_slug: Old worker, serve from legacy dispatch (no redirect)
  if (effectiveOrgSlug === null && accessInfo && accessInfo.org_slug && accessInfo.is_legacy) {
    const newUrl = buildNewFormatUrl(url, hostname, effectiveScriptName, accessInfo.org_slug, env);
    console.log(`[dispatcher] Legacy URL redirect: ${hostname} -> ${new URL(newUrl).hostname}`);
    return Response.redirect(newUrl, 301);
  }

  // If public, dispatch directly
  if (accessInfo.is_public) {
    return dispatchToWorker(request, env, ctx, effectiveDispatchScriptName, effectiveScriptName, effectiveLegacyDispatchScriptName);
  }

  // Private worker - check session
  const dispatcherSessionId = getCookieValue(cookieHeader, DISPATCHER_SESSION_COOKIE);

  if (dispatcherSessionId) {
    // Validate dispatcher session
    const session = await getDispatcherSession(env.SESSIONS, dispatcherSessionId);
    if (session && session.org_id === accessInfo.org_id) {
      // Valid session with matching org - dispatch
      return dispatchToWorker(request, env, ctx, effectiveDispatchScriptName, effectiveScriptName, effectiveLegacyDispatchScriptName);
    }
  }

  // For same-site requests (*.camelai.dev), check main app session cookie directly
  // No redirect dance needed - the cookie is already available or the user isn't logged in
  if (isSameSiteRequest(hostname)) {
    // Use the environment-aware cookie name (matches what the main app sets)
    const currentCookieName = getSessionCookieName(hostname);
    const mainSessionId = getCookieValue(cookieHeader, currentCookieName);

    console.log(`[dispatcher] Same-site auth for ${effectiveScriptName}: cookie=${currentCookieName}, found=${mainSessionId ? 'yes' : 'no'}`);

    if (!mainSessionId) {
      // No session cookie - user is not logged in
      console.log(`[dispatcher] No session cookie found for ${effectiveScriptName}`);
      return errorResponse(error401Page(getMainAppUrl(hostname, env.MAIN_APP_URL)));
    }

    try {
      const session = await parseSignedSession(env.TOKEN_SIGNING_SECRET, mainSessionId);
      if (!session) {
        console.log(`[dispatcher] Session invalid for ${effectiveScriptName}, token prefix: ${mainSessionId.slice(0, 8)}...`);
        return errorResponse(error401Page(getMainAppUrl(hostname, env.MAIN_APP_URL)));
      }

      // Check if user is a member of the org that owns this worker
      console.log(`[dispatcher] Session found for user ${session.user_id}, checking org membership for org ${accessInfo.org_id}`);
      const memberCheck = await isOrgMember(env.ORG, session.user_id, accessInfo.org_id);
      if (!memberCheck) {
        // User is logged in but not a member of this workspace
        console.log(`[dispatcher] User ${session.user_id} is not a member of org ${accessInfo.org_id}`);
        return errorResponse(error403Page(getMainAppUrl(hostname, env.MAIN_APP_URL)));
      }

      console.log(`[dispatcher] Same-site auth: user ${session.user_id} accessing ${effectiveScriptName} via main session`);
      return dispatchToWorker(request, env, ctx, effectiveDispatchScriptName, effectiveScriptName, effectiveLegacyDispatchScriptName);
    } catch (e) {
      console.error(`[dispatcher] Error validating main session: ${e}`);
      return errorResponse(error503Page(getMainAppUrl(hostname, env.MAIN_APP_URL)));
    }
  }

  // Cross-site request (*.camelai.app) - redirect to auth
  return redirectToAuth(env, url, hostname, effectiveScriptName, accessInfo.org_id);
}

/**
 * Dispatch request to the user worker
 * @param dispatchScriptName - The script name in the dispatch namespace ({org-slug}--{script})
 * @param userFacingScriptName - The user-facing script name for error messages
 * @param fallbackDispatchScriptName - Optional legacy script name fallback ({script})
 */
async function dispatchToWorker(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
  dispatchScriptName: string,
  userFacingScriptName: string,
  fallbackDispatchScriptName?: string
): Promise<Response> {
  try {
    console.log(`[dispatcher] Routing to worker: ${dispatchScriptName}`);
    if (isSelfhostPublishingMode(env)) {
      if (!env.SELFHOST_APP_RUNNER) {
        throw new Error('Self-host app runner is not configured');
      }
      const headers = new Headers(request.headers);
      headers.set('x-camelai-selfhost-app-id', dispatchScriptName);
      const runner = env.SELFHOST_APP_RUNNER.get(
        env.SELFHOST_APP_RUNNER.idFromName(dispatchScriptName),
      );
      const response = await runner.fetch(
        new Request(request, { headers }),
      );
      if (
        response.status === 404 &&
        response.headers.get('x-camelai-selfhost-runner-error') === 'worker_not_found' &&
        fallbackDispatchScriptName &&
        fallbackDispatchScriptName !== dispatchScriptName
      ) {
        console.log(`[dispatcher] Primary self-host worker not found, retrying legacy worker: ${fallbackDispatchScriptName}`);
        headers.set('x-camelai-selfhost-app-id', fallbackDispatchScriptName);
        const legacyRunner = env.SELFHOST_APP_RUNNER.get(
          env.SELFHOST_APP_RUNNER.idFromName(fallbackDispatchScriptName),
        );
        return legacyRunner.fetch(new Request(request, { headers }));
      }
      return response;
    }

    const userWorker = getUserWorker(env, dispatchScriptName);
    let response: Response;

    try {
      response = await fetchUserWorker(userWorker, request);
    } catch (e) {
      const error = e as Error;
      if (error.message?.startsWith('Worker not found') && fallbackDispatchScriptName && fallbackDispatchScriptName !== dispatchScriptName) {
        console.log(`[dispatcher] Primary worker not found, retrying legacy worker: ${fallbackDispatchScriptName}`);
        const legacyWorker = getUserWorker(env, fallbackDispatchScriptName);
        response = await fetchUserWorker(legacyWorker, request);
      } else {
        throw e;
      }
    }

    return response;
  } catch (e) {
    const error = e as Error;
    console.error('[dispatcher] failed to route user worker', {
      dispatchScriptName,
      userFacingScriptName,
      error: error.message,
      stack: error.stack,
    });
    const requestUrl = new URL(request.url);
    const pageHomeUrl = getMainAppUrl(getRequestHostname(request, requestUrl), env.MAIN_APP_URL);
    if (error.message?.startsWith('Worker not found')) {
      return errorResponse(error404Page(pageHomeUrl, userFacingScriptName));
    }
    return errorResponse(error500Page(pageHomeUrl));
  }
}

/**
 * Redirect to main app for authentication
 */
async function redirectToAuth(
  env: Env,
  url: URL,
  hostname: string,
  scriptName: string,
  requiredOrgId: string
): Promise<Response> {
  // Create auth state with return URL
  const returnUrl = `${url.protocol}//${appendCurrentPort(url, hostname)}`; // Just the origin, callback will add the path
  const state = await createAuthState(env.APP_KV, {
    return_url: returnUrl,
    script_name: scriptName,
    required_org_id: requiredOrgId,
  });

  // Build main app auth URL
  const mainAppUrl = getMainAppUrl(hostname, env.MAIN_APP_URL);
  const authUrl = new URL('/auth/worker', mainAppUrl);
  authUrl.searchParams.set('state', state);

  return new Response(null, {
    status: 302,
    headers: {
      'Location': authUrl.toString(),
    },
  });
}
