/**
 * OpenAI-compatible proxy adapter used by worker routes.
 *
 * Requests are forwarded to sandbox-host control routes, which then
 * forward to Cloudflare AI Gateway with workspace-scoped metadata.
 */

export interface OpenAIProxyEnv {
  SANDBOX_HOST?: Fetcher;
  SANDBOX_HOST_URL?: string;
}

export interface OpenAIProxyContext {
  orgId: string;
  workspaceId: string;
  userId?: string;
  threadId?: string;
}

function resolveSandboxHostUrlOverride(env: OpenAIProxyEnv): URL | null {
  const raw = (env.SANDBOX_HOST_URL ?? '').trim();
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('SANDBOX_HOST_URL is invalid');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('SANDBOX_HOST_URL must use http or https');
  }
  return parsed;
}

function normalizeBaseUrl(url: URL): URL {
  const copy = new URL(url.toString());
  copy.search = '';
  copy.hash = '';
  copy.pathname = copy.pathname.replace(/\/+$/, '');
  return copy;
}

function sandboxOpenAIProxyUrl(
  env: OpenAIProxyEnv,
  context: OpenAIProxyContext,
  subpath: string
): string {
  const base = resolveSandboxHostUrlOverride(env);
  const url = base ? normalizeBaseUrl(base) : new URL('http://sandbox');
  const cleanedSubpath = subpath.startsWith('/') ? subpath : `/${subpath}`;
  const workspacePath =
    `/v1/workspaces/${encodeURIComponent(context.orgId)}/${encodeURIComponent(context.workspaceId)}` +
    `/openai-proxy${cleanedSubpath}`;
  const basePath = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
  url.pathname = `${basePath}${workspacePath}`;
  return url.toString();
}

async function fetchSandboxHost(
  env: OpenAIProxyEnv,
  url: string,
  init: RequestInit
): Promise<Response> {
  if (resolveSandboxHostUrlOverride(env)) {
    return fetch(url, init);
  }
  if (!env.SANDBOX_HOST) {
    throw new Error('SANDBOX_HOST binding is not configured (or set SANDBOX_HOST_URL for local mode)');
  }
  return env.SANDBOX_HOST.fetch(url, init);
}

export async function proxyOpenAIRequest(
  env: OpenAIProxyEnv,
  context: OpenAIProxyContext,
  req: Request,
  subpath: string
): Promise<Response> {
  const target = new URL(sandboxOpenAIProxyUrl(env, context, subpath));
  target.search = new URL(req.url).search;

  const headers = new Headers(req.headers);
  headers.delete('host');
  headers.delete('content-length');
  headers.delete('x-sandbox-secret');
  headers.delete('x-chiridion-org-id');
  headers.delete('x-chiridion-workspace-id');
  headers.delete('x-chiridion-user-id');
  headers.delete('x-chiridion-thread-id');
  if (context.userId) {
    headers.set('x-chiridion-user-id', context.userId);
  }
  if (context.threadId) {
    headers.set('x-chiridion-thread-id', context.threadId);
  }

  const method = req.method.toUpperCase();
  const body =
    method === 'GET' || method === 'HEAD'
      ? undefined
      : req.body;

  return fetchSandboxHost(env, target.toString(), {
    method,
    headers,
    body,
    redirect: 'manual',
  });
}
