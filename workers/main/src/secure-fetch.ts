import type { OrgDO } from './auth.js';
import {
  getAppIframeUrl,
  getAppUrl,
  getPreferredAppUrl,
  isAppCustomDomainReady,
} from '../../../src/lib/app-url.js';
import {
  createDispatcherSession,
  DISPATCHER_SESSION_COOKIE,
} from './worker-auth.js';

export interface SecureFetchContext {
  orgId: string;
  workspaceId: string;
}

export interface SecureFetchEnv {
  SESSIONS?: KVNamespace;
  ORG: DurableObjectNamespace<OrgDO>;
  WORKER_BASE_URL?: string;
  LOCAL_APP_VANITY_DOMAIN?: string;
  LOCAL_APP_IFRAME_DOMAIN?: string;
}

export interface WorkspaceAppHostIndex {
  hostnames: ReadonlySet<string>;
}

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/:\d+$/, '');
}

function appUrlContext(env: SecureFetchEnv) {
  return {
    hostname: env.WORKER_BASE_URL,
    vanityDomain: env.LOCAL_APP_VANITY_DOMAIN,
    iframeDomain: env.LOCAL_APP_IFRAME_DOMAIN,
  };
}

export async function buildWorkspaceAppHostIndex(
  env: SecureFetchEnv,
  context: SecureFetchContext,
): Promise<WorkspaceAppHostIndex> {
  const orgStub = env.ORG.get(env.ORG.idFromName(context.orgId));
  const info = await orgStub.getInfo();
  const orgSlug = typeof info?.slug === 'string' && info.slug.trim()
    ? info.slug.trim()
    : undefined;
  const scripts = await orgStub.listWorkerScriptsByWorkspace(context.workspaceId);
  const hostnames = new Set<string>();
  const urlContext = appUrlContext(env);

  for (const script of scripts) {
    hostnames.add(normalizeHostname(new URL(getPreferredAppUrl(script, {
      hostname: urlContext,
      orgSlug,
    })).hostname));
    hostnames.add(normalizeHostname(new URL(getAppUrl(script.script_name, urlContext, orgSlug)).hostname));
    hostnames.add(normalizeHostname(new URL(getAppUrl(script.script_name, urlContext)).hostname));
    hostnames.add(normalizeHostname(new URL(getAppIframeUrl(script.script_name, urlContext, orgSlug)).hostname));
    if (isAppCustomDomainReady(script)) {
      hostnames.add(normalizeHostname(script.custom_domain_hostname!));
    }
  }

  return { hostnames };
}

export function isWorkspaceAppHostname(
  index: WorkspaceAppHostIndex,
  hostname: string,
): boolean {
  return index.hostnames.has(normalizeHostname(hostname));
}

export function normalizeSecureFetchRequest(
  input: RequestInfo | URL,
  init?: RequestInit,
): Request {
  if (input instanceof Request) {
    return init ? new Request(input, init) : input;
  }
  return new Request(input, init);
}

export async function createSecureFetchDispatcherSession(
  env: SecureFetchEnv,
  context: SecureFetchContext,
): Promise<string> {
  if (!env.SESSIONS) {
    throw new Error('Secure fetch requires SESSIONS KV but it is not configured');
  }
  const { sessionId } = await createDispatcherSession(
    env.SESSIONS,
    `sandbox:${context.workspaceId}`,
    context.orgId,
  );
  return sessionId;
}

export async function performSecureFetch(
  env: SecureFetchEnv,
  context: SecureFetchContext,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  deps: {
    getHostIndex: () => Promise<WorkspaceAppHostIndex>;
    getSessionId: () => Promise<string>;
  },
): Promise<Response> {
  const request = normalizeSecureFetchRequest(input, init);
  const url = new URL(request.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return fetch(request);
  }

  const hostIndex = await deps.getHostIndex();
  if (!isWorkspaceAppHostname(hostIndex, url.hostname)) {
    return fetch(request);
  }

  const sessionId = await deps.getSessionId();
  const headers = new Headers(request.headers);
  const sessionCookie = `${DISPATCHER_SESSION_COOKIE}=${sessionId}`;
  const existingCookie = headers.get('Cookie');
  headers.set(
    'Cookie',
    existingCookie ? `${existingCookie}; ${sessionCookie}` : sessionCookie,
  );

  const forwardedInit: RequestInit = {
    method: request.method,
    headers,
    redirect: request.redirect,
    signal: request.signal,
  };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    forwardedInit.body = request.body;
  }

  return fetch(request.url, forwardedInit);
}
