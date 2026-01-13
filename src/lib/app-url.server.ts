/**
 * Server-side environment-aware app URL generation utilities.
 * Use this in Server Components and Route Handlers.
 */
import { headers } from 'next/headers';
import { getAppUrl as getAppUrlBase, getAppIframeUrl as getAppIframeUrlBase, getVanityDomain as getVanityDomainBase } from './app-url';

/**
 * Get hostname from request headers (for Server Components).
 */
async function getHostname(): Promise<string> {
  const headerStore = await headers();
  const host = headerStore.get('host');
  return host?.split(':')[0] ?? 'chiridion.ai';
}

/**
 * Get the vanity URL domain for deployed apps (server-side).
 */
export async function getVanityDomain(): Promise<string> {
  const hostname = await getHostname();
  return getVanityDomainBase(hostname);
}

/**
 * Get the full vanity URL for a deployed app (server-side).
 */
export async function getAppUrl(scriptName: string): Promise<string> {
  const hostname = await getHostname();
  return getAppUrlBase(scriptName, hostname);
}

/**
 * Get the full iframe URL for a deployed app (server-side).
 */
export async function getAppIframeUrl(scriptName: string): Promise<string> {
  const hostname = await getHostname();
  return getAppIframeUrlBase(scriptName, hostname);
}
