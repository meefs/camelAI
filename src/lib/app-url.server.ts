/**
 * Server-side environment-aware app URL generation utilities.
 * Use this in React Router loaders and actions.
 */
import type { AppLoadContext } from 'react-router';
import type { CloudflareEnv } from './cloudflare.server';
import {
  type AppUrlContext,
  getAppUrl as getAppUrlBase,
  getAppIframeUrl as getAppIframeUrlBase,
  getVanityDomain as getVanityDomainBase,
} from './app-url';

/**
 * Get host from request or context.
 */
function getHostFromRequest(request: Request): string {
  const headerHost = request.headers.get('host')?.trim();
  if (headerHost) return headerHost;
  const url = new URL(request.url);
  return url.host;
}

export function getAppUrlContext(env: Pick<CloudflareEnv, 'LOCAL_APP_VANITY_DOMAIN' | 'LOCAL_APP_IFRAME_DOMAIN'>, request?: Request): AppUrlContext {
  return {
    hostname: request ? getHostFromRequest(request) : 'camelai.dev',
    vanityDomain: env.LOCAL_APP_VANITY_DOMAIN,
    iframeDomain: env.LOCAL_APP_IFRAME_DOMAIN,
  };
}

/**
 * Get the vanity URL domain for deployed apps (server-side).
 * Can accept either a Request, AppLoadContext with request, or nothing (defaults to camelai.dev).
 */
export async function getVanityDomain(contextOrRequest?: AppLoadContext | Request): Promise<string> {
  let hostname = 'camelai.dev';

  if (contextOrRequest instanceof Request) {
    hostname = getHostFromRequest(contextOrRequest);
  } else if (contextOrRequest && 'cloudflare' in contextOrRequest) {
    // AppLoadContext doesn't have direct request access, use default
    // The caller should pass the request if hostname matters
  }

  return getVanityDomainBase(hostname);
}

/**
 * Get the full vanity URL for a deployed app (server-side).
 */
export async function getAppUrl(scriptName: string, request?: Request, orgSlug?: string): Promise<string> {
  const hostname = request ? getHostFromRequest(request) : 'camelai.dev';
  return getAppUrlBase(scriptName, hostname, orgSlug);
}

/**
 * Get the full iframe URL for a deployed app (server-side).
 */
export async function getAppIframeUrl(scriptName: string, request?: Request, orgSlug?: string): Promise<string> {
  const hostname = request ? getHostFromRequest(request) : 'camelai.dev';
  return getAppIframeUrlBase(scriptName, hostname, orgSlug);
}
