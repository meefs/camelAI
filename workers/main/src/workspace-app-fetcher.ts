import type { OrgDO } from './auth.js';
import {
  getAppIframeUrl,
  getAppUrl,
  getPreferredAppUrl,
  isAppCustomDomainReady,
} from '../../../src/lib/app-url.js';

export interface WorkspaceAppContext {
  orgId: string;
  workspaceId: string;
}

export type DispatcherBinding = {
  fetchWorkspaceApp(request: Request): Promise<Response>;
};

export interface WorkspaceAppFetcherEnv {
  DISPATCHER?: DispatcherBinding;
  ORG: DurableObjectNamespace<OrgDO>;
  WORKER_BASE_URL?: string;
  LOCAL_APP_VANITY_DOMAIN?: string;
  LOCAL_APP_IFRAME_DOMAIN?: string;
}

export interface WorkspaceAppRoute {
  scriptName: string;
  orgSlug?: string;
  dispatchScriptName: string;
  legacyDispatchScriptName: string;
  workspaceId: string;
  orgId: string;
  isPublic: boolean;
}

export interface WorkspaceAppHostIndex {
  routesByHostname: ReadonlyMap<string, WorkspaceAppRoute>;
  hostnames: ReadonlySet<string>;
}

const MAX_REDIRECTS = 20;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const STRIPPED_COOKIE_NAMES = new Set([
  'chiridion_run_session',
]);

const CROSS_ORIGIN_REDIRECT_HEADERS = [
  'authorization',
  'cookie',
  'cookie2',
  'proxy-authorization',
];

export const PLATFORM_DISPATCH_SCRIPT_HEADER = 'x-camelai-platform-dispatch-script';
export const PLATFORM_DISPATCH_SCRIPT_NAME_HEADER = 'x-camelai-platform-script-name';
export const PLATFORM_DISPATCH_LEGACY_SCRIPT_HEADER = 'x-camelai-platform-legacy-dispatch-script';

const PLATFORM_DISPATCH_HEADERS = [
  PLATFORM_DISPATCH_SCRIPT_HEADER,
  PLATFORM_DISPATCH_SCRIPT_NAME_HEADER,
  PLATFORM_DISPATCH_LEGACY_SCRIPT_HEADER,
] as const;

function stripPlatformDispatchHeaders(headers: Headers): void {
  for (const name of PLATFORM_DISPATCH_HEADERS) {
    headers.delete(name);
  }
}

function syncRequestHostHeader(headers: Headers, url: URL): void {
  const host = url.port ? `${url.hostname}:${url.port}` : url.hostname;
  headers.set('Host', host);
}

function applyPlatformDispatchRoute(headers: Headers, route: WorkspaceAppRoute): void {
  headers.set(PLATFORM_DISPATCH_SCRIPT_HEADER, route.dispatchScriptName);
  headers.set(PLATFORM_DISPATCH_SCRIPT_NAME_HEADER, route.scriptName);
  if (route.legacyDispatchScriptName !== route.dispatchScriptName) {
    headers.set(PLATFORM_DISPATCH_LEGACY_SCRIPT_HEADER, route.legacyDispatchScriptName);
  }
}

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/:\d+$/, '');
}

function appUrlContext(env: WorkspaceAppFetcherEnv) {
  return {
    hostname: env.WORKER_BASE_URL,
    vanityDomain: env.LOCAL_APP_VANITY_DOMAIN,
    iframeDomain: env.LOCAL_APP_IFRAME_DOMAIN,
  };
}

export async function buildWorkspaceAppHostIndex(
  env: WorkspaceAppFetcherEnv,
  context: WorkspaceAppContext,
): Promise<WorkspaceAppHostIndex> {
  const orgStub = env.ORG.get(env.ORG.idFromName(context.orgId));
  const info = await orgStub.getInfo();
  const orgSlug = typeof info?.slug === 'string' && info.slug.trim()
    ? info.slug.trim()
    : undefined;
  const scripts = await orgStub.listWorkerScriptsByWorkspace(context.workspaceId);
  const routesByHostname = new Map<string, WorkspaceAppRoute>();
  const urlContext = appUrlContext(env);

  for (const script of scripts) {
    const dispatchScriptName = orgSlug
      ? `${script.script_name}--${orgSlug}`
      : script.script_name;
    const route: WorkspaceAppRoute = {
      scriptName: script.script_name,
      orgSlug,
      dispatchScriptName,
      legacyDispatchScriptName: script.script_name,
      workspaceId: context.workspaceId,
      orgId: context.orgId,
      isPublic: script.is_public,
    };

    const urls = [
      getPreferredAppUrl(script, { hostname: urlContext, orgSlug }),
      getAppUrl(script.script_name, urlContext, orgSlug),
      getAppUrl(script.script_name, urlContext),
      getAppIframeUrl(script.script_name, urlContext, orgSlug),
    ];
    for (const appUrl of urls) {
      routesByHostname.set(normalizeHostname(new URL(appUrl).hostname), route);
    }
    if (isAppCustomDomainReady(script) && script.custom_domain_hostname) {
      routesByHostname.set(normalizeHostname(script.custom_domain_hostname), route);
    }
  }

  return {
    routesByHostname,
    hostnames: new Set(routesByHostname.keys()),
  };
}

export function isWorkspaceAppHostname(
  index: WorkspaceAppHostIndex,
  hostname: string,
): boolean {
  return index.hostnames.has(normalizeHostname(hostname));
}

export function resolveWorkspaceAppRoute(
  index: WorkspaceAppHostIndex,
  hostname: string,
): WorkspaceAppRoute | null {
  return index.routesByHostname.get(normalizeHostname(hostname)) ?? null;
}

function configuredAppDomain(value?: string): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    return normalizeHostname(new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`).hostname);
  } catch {
    return normalizeHostname(trimmed.replace(/^https?:\/\//, '').split('/')[0] ?? '');
  }
}

export function isLocalAppHostname(hostname: string, env: WorkspaceAppFetcherEnv): boolean {
  const host = normalizeHostname(hostname);
  if (
    host === 'localhost'
    || host.endsWith('.localhost')
    || host.endsWith('.local')
    || host.startsWith('127.0.0.1')
  ) {
    return true;
  }
  for (const domain of [
    configuredAppDomain(env.LOCAL_APP_VANITY_DOMAIN),
    configuredAppDomain(env.LOCAL_APP_IFRAME_DOMAIN),
  ]) {
    if (domain && (host === domain || host.endsWith(`.${domain}`))) {
      return true;
    }
  }
  if (env.WORKER_BASE_URL) {
    try {
      const platformHost = normalizeHostname(new URL(env.WORKER_BASE_URL).hostname);
      if (platformHost && (host === platformHost || host.endsWith(`.${platformHost}`))) {
        return true;
      }
    } catch {
      // ignore invalid platform base URL
    }
  }
  return false;
}

function finalizeWorkspaceAppUrl(url: URL, env: WorkspaceAppFetcherEnv): string {
  const platformBase = env.WORKER_BASE_URL?.trim();
  if (!platformBase || !isLocalAppHostname(url.hostname, env)) {
    return url.toString();
  }
  try {
    const platform = new URL(platformBase);
    url.protocol = platform.protocol;
    if (platform.port) {
      url.port = platform.port;
    }
  } catch {
    // ignore invalid platform base URL
  }
  return url.toString();
}

export function shouldUseDispatchInterceptionForScreenshot(
  isPublic: boolean,
  env: Pick<WorkspaceAppFetcherEnv, 'DISPATCHER'>,
): boolean {
  return !isPublic && !!env.DISPATCHER;
}

export function applyWorkspaceAppPath(baseUrl: string, path: string): URL {
  const url = new URL(baseUrl);
  const trimmed = path.trim();
  if (!trimmed || trimmed === '/') {
    url.pathname = '/';
    url.search = '';
    url.hash = '';
    return url;
  }
  if (trimmed.startsWith('//')) {
    throw new Error('Workspace app path must stay on the app origin');
  }
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(trimmed)) {
    throw new Error('Workspace app path must stay on the app origin');
  }
  const normalized = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  const relative = new URL(normalized, 'http://workspace-app.local');
  url.pathname = relative.pathname;
  url.search = relative.search;
  url.hash = relative.hash;
  return url;
}

export async function buildWorkspaceAppUrl(
  env: WorkspaceAppFetcherEnv,
  context: WorkspaceAppContext,
  scriptName: string,
  path = '/',
): Promise<string> {
  const orgStub = env.ORG.get(env.ORG.idFromName(context.orgId));
  const script = await orgStub.getWorkerScript(scriptName);
  if (!script) {
    throw new Error(`App not found: ${scriptName}`);
  }
  if (script.workspace_id !== context.workspaceId) {
    throw new Error(`App ${scriptName} is not in this workspace`);
  }
  const info = await orgStub.getInfo();
  const orgSlug = typeof info?.slug === 'string' && info.slug.trim()
    ? info.slug.trim()
    : undefined;
  const base = getPreferredAppUrl(
    { ...script, script_name: scriptName },
    { hostname: appUrlContext(env), orgSlug },
  );
  const url = applyWorkspaceAppPath(base, path);
  return finalizeWorkspaceAppUrl(url, env);
}

function sanitizeWorkspaceAppRequest(request: Request): Request {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  stripPlatformDispatchHeaders(headers);
  const cookieHeader = headers.get('Cookie');
  if (cookieHeader) {
    const filtered = cookieHeader
      .split(';')
      .map((part) => part.trim())
      .filter((part) => {
        const name = part.split('=')[0]?.trim();
        return name && !STRIPPED_COOKIE_NAMES.has(name);
      });
    if (filtered.length > 0) {
      headers.set('Cookie', filtered.join('; '));
    } else {
      headers.delete('Cookie');
    }
  }
  syncRequestHostHeader(headers, url);
  return new Request(request, { headers });
}

function assertWorkspaceAppAccess(
  index: WorkspaceAppHostIndex,
  context: WorkspaceAppContext,
  hostname: string,
): WorkspaceAppRoute {
  const route = resolveWorkspaceAppRoute(index, hostname);
  if (!route) {
    throw new Error(`Hostname is not a workspace deployed app: ${hostname}`);
  }
  if (route.orgId !== context.orgId || route.workspaceId !== context.workspaceId) {
    throw new Error('Workspace app access denied');
  }
  return route;
}

function resolveRedirectMethod(status: number, method: string): string {
  if (status === 303) return 'GET';
  if ((status === 301 || status === 302) && method !== 'GET' && method !== 'HEAD') {
    return 'GET';
  }
  return method;
}

function stripCrossOriginRedirectHeaders(headers: Headers): void {
  for (const name of CROSS_ORIGIN_REDIRECT_HEADERS) {
    headers.delete(name);
  }
}

function buildRedirectRequest(
  sourceRequest: Request,
  responseStatus: number,
  nextUrl: URL,
  redirectMode: RequestRedirect,
  options?: { stripSensitiveHeaders?: boolean },
): Request {
  const method = resolveRedirectMethod(responseStatus, sourceRequest.method);
  const headers = new Headers(sourceRequest.headers);
  if (options?.stripSensitiveHeaders) {
    stripCrossOriginRedirectHeaders(headers);
  }
  if (method === 'GET' || method === 'HEAD') {
    headers.delete('Content-Length');
    headers.delete('Content-Type');
  }
  const init: RequestInit = {
    method,
    headers,
    redirect: redirectMode,
  };
  if (
    method !== 'GET'
    && method !== 'HEAD'
    && (responseStatus === 307 || responseStatus === 308)
  ) {
    init.body = sourceRequest.body;
  }
  return new Request(nextUrl, init);
}

async function fetchWorkspaceAppOnce(
  env: WorkspaceAppFetcherEnv,
  request: Request,
  route: WorkspaceAppRoute,
): Promise<Response> {
  const sanitized = sanitizeWorkspaceAppRequest(request);
  const headers = new Headers(sanitized.headers);
  applyPlatformDispatchRoute(headers, route);
  const forwarded = new Request(sanitized, { headers });
  if (!env.DISPATCHER || typeof env.DISPATCHER.fetchWorkspaceApp !== 'function') {
    throw new Error('DISPATCHER service binding is not configured');
  }
  return env.DISPATCHER.fetchWorkspaceApp(forwarded);
}

async function followWorkspaceAppRedirects(
  env: WorkspaceAppFetcherEnv,
  context: WorkspaceAppContext,
  request: Request,
  index: WorkspaceAppHostIndex,
): Promise<Response> {
  const redirectMode = request.redirect ?? 'follow';
  let currentRequest = request;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const url = new URL(currentRequest.url);
    const route = assertWorkspaceAppAccess(index, context, url.hostname);
    const response = await fetchWorkspaceAppOnce(env, currentRequest, route);

    if (redirectMode === 'manual' || !REDIRECT_STATUSES.has(response.status)) {
      return response;
    }

    if (redirectMode === 'error') {
      throw new Error('Redirect encountered while redirect mode is "error"');
    }

    const location = response.headers.get('Location');
    if (!location) {
      return response;
    }

    if (hop >= MAX_REDIRECTS) {
      throw new Error('Too many redirects');
    }

    const nextUrl = new URL(location, currentRequest.url);
    if (!isWorkspaceAppHostname(index, nextUrl.hostname)) {
      const externalRequest = buildRedirectRequest(
        currentRequest,
        response.status,
        nextUrl,
        'follow',
        { stripSensitiveHeaders: true },
      );
      return fetch(externalRequest);
    }

    assertWorkspaceAppAccess(index, context, nextUrl.hostname);
    currentRequest = buildRedirectRequest(
      currentRequest,
      response.status,
      nextUrl,
      redirectMode,
    );
  }

  throw new Error('Too many redirects');
}

export async function fetchWorkspaceAppViaDispatch(
  env: WorkspaceAppFetcherEnv,
  context: WorkspaceAppContext,
  request: Request,
  index: WorkspaceAppHostIndex,
): Promise<Response> {
  return followWorkspaceAppRedirects(env, context, request, index);
}

export function normalizeWorkspaceAppRequest(
  input: RequestInfo | URL,
  init?: RequestInit,
): Request {
  if (input instanceof Request) {
    return init ? new Request(input, init) : input;
  }
  return new Request(input, init);
}

export async function performWorkspaceAppFetch(
  env: WorkspaceAppFetcherEnv,
  context: WorkspaceAppContext,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  deps: { getHostIndex: () => Promise<WorkspaceAppHostIndex> },
): Promise<Response> {
  const request = normalizeWorkspaceAppRequest(input, init);
  const url = new URL(request.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return fetch(request);
  }

  const hostIndex = await deps.getHostIndex();
  if (!isWorkspaceAppHostname(hostIndex, url.hostname)) {
    return fetch(request);
  }

  return fetchWorkspaceAppViaDispatch(env, context, request, hostIndex);
}
