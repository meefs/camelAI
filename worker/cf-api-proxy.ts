export interface ProxyEnv {
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  CF_DISPATCH_NAMESPACE?: string;
}

const DISPATCH_SCRIPT_UPLOAD = /^\/client\/v4\/accounts\/[^/]+\/workers\/dispatch\/namespaces\/[^/]+\/scripts\/[^/]+$/;
const ASSETS_UPLOAD = /^\/client\/v4\/accounts\/[^/]+\/workers\/assets\/upload$/;

export function jsonResponse(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
}

export function isAllowedCloudflareApiProxyRequest(pathname: string, method: string): boolean {
  const m = method.toUpperCase();
  const scriptSettings = /^\/client\/v4\/accounts\/[^/]+\/workers\/scripts\/[^/]+\/settings$/;
  const assetsUploadSession = /^\/client\/v4\/accounts\/[^/]+\/workers\/dispatch\/namespaces\/[^/]+\/scripts\/[^/]+\/assets-upload-session$/;

  switch (m) {
    case 'GET':
      return DISPATCH_SCRIPT_UPLOAD.test(pathname) || scriptSettings.test(pathname);
    case 'PUT':
      return DISPATCH_SCRIPT_UPLOAD.test(pathname);
    case 'PATCH':
      return scriptSettings.test(pathname);
    case 'POST':
      return assetsUploadSession.test(pathname) || ASSETS_UPLOAD.test(pathname);
    default:
      return false;
  }
}

function rewriteCloudflareApiPath(
  pathname: string,
  accountId: string | undefined,
  dispatchNamespace: string | undefined,
  scriptName: string | null
): string {
  let rewritten = pathname;
  const dispatchMatch = rewritten.match(
    /^\/client\/v4\/accounts\/([^\/]+)\/workers\/dispatch\/namespaces\/([^\/]+)\/(.*)$/
  );
  if (dispatchMatch) {
    const rest = dispatchMatch[3] ?? '';
    const rewrittenAccount = accountId ?? dispatchMatch[1]!;
    const rewrittenNs = dispatchNamespace ?? dispatchMatch[2]!;
    rewritten = `/client/v4/accounts/${encodeURIComponent(rewrittenAccount)}/workers/dispatch/namespaces/${encodeURIComponent(rewrittenNs)}/${rest}`;

    if (scriptName) {
      const restUrl = `/${rest}`;
      const scriptsMatch = restUrl.match(/^\/scripts\/([^\/]+)(\/.*)?$/);
      if (scriptsMatch) {
        const tail = scriptsMatch[2] ?? '';
        rewritten = `/client/v4/accounts/${encodeURIComponent(rewrittenAccount)}/workers/dispatch/namespaces/${encodeURIComponent(rewrittenNs)}/scripts/${encodeURIComponent(scriptName)}${tail}`;
      }
    }
  }

  if (!dispatchMatch && scriptName) {
    const scriptsMatch = rewritten.match(
      /^\/client\/v4\/accounts\/([^\/]+)\/workers\/scripts\/([^\/]+)(\/.*)?$/
    );
    if (scriptsMatch) {
      const rewrittenAccount = accountId ?? scriptsMatch[1]!;
      const tail = scriptsMatch[3] ?? '';
      rewritten = `/client/v4/accounts/${encodeURIComponent(rewrittenAccount)}/workers/scripts/${encodeURIComponent(scriptName)}${tail}`;
    }
  }

  if (accountId) {
    const accountMatch = rewritten.match(/^\/client\/v4\/accounts\/([^\/]+)\/(.*)$/);
    if (accountMatch) {
      rewritten = `/client/v4/accounts/${encodeURIComponent(accountId)}/${accountMatch[2] ?? ''}`;
    }
  }

  return rewritten;
}

async function proxyCloudflareApiBase(
  request: Request,
  env: ProxyEnv,
  scriptName: string | null
): Promise<Response> {
  const url = new URL(request.url);
  const upstreamApiToken = env.CF_API_TOKEN?.trim();
  if (!upstreamApiToken) {
    return jsonResponse({ error: 'Missing CF_API_TOKEN for Cloudflare API proxy' }, { status: 500 });
  }

  const accountId = env.CF_ACCOUNT_ID?.trim();
  const dispatchNamespace = env.CF_DISPATCH_NAMESPACE?.trim();
  const pathname = rewriteCloudflareApiPath(url.pathname, accountId, dispatchNamespace, scriptName);

  if (!isAllowedCloudflareApiProxyRequest(pathname, request.method)) {
    return jsonResponse({ error: 'Blocked by API proxy allowlist' }, { status: 403 });
  }

  const upstreamUrl = new URL(`https://api.cloudflare.com${pathname}${url.search}`);
  const headers = new Headers(request.headers);

  headers.set('Authorization', `Bearer ${upstreamApiToken}`);
  headers.delete('cookie');
  headers.delete('host');

  const method = request.method.toUpperCase();
  const body =
    method === 'GET' || method === 'HEAD'
      ? undefined
      : await request.arrayBuffer();

  return await fetch(upstreamUrl, { method, headers, body });
}

export async function proxyCloudflareApiInternal(
  request: Request,
  env: ProxyEnv,
  scriptName: string | null
): Promise<Response> {
  return proxyCloudflareApiBase(request, env, scriptName);
}
