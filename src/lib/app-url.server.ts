/**
 * Server-side environment-aware app URL generation utilities.
 * Use this in React Router loaders and actions.
 */
import type { AppLoadContext } from 'react-router';
import { getAppUrl as getAppUrlBase, getAppIframeUrl as getAppIframeUrlBase, getVanityDomain as getVanityDomainBase } from './app-url';

/**
 * Get hostname from request or context.
 */
function getHostnameFromRequest(request: Request): string {
  const url = new URL(request.url);
  return url.hostname;
}

/**
 * Get the vanity URL domain for deployed apps (server-side).
 * Can accept either a Request, AppLoadContext with request, or nothing (defaults to camelai.dev).
 */
export async function getVanityDomain(contextOrRequest?: AppLoadContext | Request): Promise<string> {
  let hostname = 'camelai.dev';

  if (contextOrRequest instanceof Request) {
    hostname = getHostnameFromRequest(contextOrRequest);
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
  const hostname = request ? getHostnameFromRequest(request) : 'camelai.dev';
  return getAppUrlBase(scriptName, hostname, orgSlug);
}

/**
 * Get the full iframe URL for a deployed app (server-side).
 */
export async function getAppIframeUrl(scriptName: string, request?: Request, orgSlug?: string): Promise<string> {
  const hostname = request ? getHostnameFromRequest(request) : 'camelai.dev';
  return getAppIframeUrlBase(scriptName, hostname, orgSlug);
}
