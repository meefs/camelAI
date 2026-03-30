import type { WorkerScript } from '../types';

/**
 * Environment-aware app URL generation utilities.
 *
 * These functions derive the correct app domain based on the current environment,
 * detected from the hostname. This ensures workers deploy to and are accessible
 * from environment-specific domains.
 *
 * New URL format (new-style 6+ alphanumeric slugs use single hyphen):
 * Production: {scriptName}-{orgSlug}.camelai.app, {scriptName}-{orgSlug}.apps.camelai.dev
 *
 * Old URL format (old-style slugs with hyphens use double-hyphen separator):
 * Production: {scriptName}--{orgSlug}.camelai.app, {scriptName}--{orgSlug}.apps.camelai.dev
 *
 * Legacy URL format (backwards compatibility, no org slug):
 * Production: {scriptName}.camelai.app, {scriptName}.apps.camelai.dev
 */

/**
 * New-style org slugs are 6+ purely alphanumeric characters (no hyphens).
 * Old-style slugs (e.g. "ms-workspace-b3c") contain hyphens and use "--" separator.
 */
function isNewStyleSlug(slug: string): boolean {
  return /^[a-z0-9]{6,}$/.test(slug);
}

/**
 * Build the hostname label for an app: "{script}-{slug}" or "{script}--{slug}".
 */
export function buildAppLabel(scriptName: string, orgSlug: string): string {
  const separator = isNewStyleSlug(orgSlug) ? '-' : '--';
  return `${scriptName}${separator}${orgSlug}`;
}

/**
 * Extract the environment prefix from a hostname.
 * Returns empty string for production, otherwise returns the env prefix (e.g., "staging", "dev-miguel", "local").
 */
function getEnvPrefix(hostname: string): string {
  // Handle camelai.dev domains (main app)
  // e.g., staging.camelai.dev -> staging
  // e.g., dev-miguel.camelai.dev -> dev-miguel
  // e.g., camelai.dev -> "" (production)
  if (hostname.endsWith('.camelai.dev') || hostname === 'camelai.dev') {
    const parts = hostname.split('.');
    // camelai.dev or www.camelai.dev = production
    if (parts.length <= 2 || parts[0] === 'www') {
      return '';
    }
    // {env}.camelai.dev
    return parts[0];
  }

  // Handle localhost - use "local" environment
  if (
    hostname === 'localhost' ||
    hostname.startsWith('localhost:') ||
    hostname.startsWith('127.0.0.1') ||
    hostname.endsWith('.local')
  ) {
    return 'local';
  }

  // Default to production
  return '';
}

/**
 * Get the vanity URL domain for deployed apps (cross-site).
 * e.g., "camelai.app" for production, "staging.camelai.app" for staging
 */
export function getVanityDomain(hostname?: string): string {
  const host = hostname ?? (typeof window !== 'undefined' ? window.location.hostname : 'camelai.dev');
  const envPrefix = getEnvPrefix(host);

  if (envPrefix) {
    return `${envPrefix}.camelai.app`;
  }
  return 'camelai.app';
}

/**
 * Get the iframe URL domain for deployed apps (same-site).
 * e.g., "apps.camelai.dev" for production, "apps.staging.camelai.dev" for staging
 */
export function getIframeDomain(hostname?: string): string {
  const host = hostname ?? (typeof window !== 'undefined' ? window.location.hostname : 'camelai.dev');
  const envPrefix = getEnvPrefix(host);

  if (envPrefix) {
    return `apps.${envPrefix}.camelai.dev`;
  }
  return 'apps.camelai.dev';
}

/**
 * Get the full vanity URL for a deployed app with org slug.
 * New-style slugs use single hyphen, old-style use double hyphen.
 */
export function getAppUrl(scriptName: string, hostname?: string, orgSlug?: string): string {
  const domain = getVanityDomain(hostname);
  if (orgSlug) {
    return `https://${buildAppLabel(scriptName, orgSlug)}.${domain}`;
  }
  return `https://${scriptName}.${domain}`;
}

/**
 * Get the custom domain URL for a deployed app when the org has a wildcard domain configured.
 * e.g., getCustomDomainAppUrl("my-app", "apps.example.com") -> "https://my-app.apps.example.com"
 */
export function getCustomDomainAppUrl(scriptName: string, orgCustomDomain: string): string {
  return `https://${scriptName}.${orgCustomDomain}`;
}

type AppCustomDomainState = Pick<
  WorkerScript,
  | 'script_name'
  | 'custom_domain_hostname'
  | 'custom_domain_status'
  | 'custom_domain_ssl_status'
>;

export function getExpectedCustomDomainHostname(scriptName: string, orgCustomDomain: string): string {
  return `${scriptName}.${orgCustomDomain}`;
}

export function isAppCustomDomainReady(
  app: AppCustomDomainState,
  orgCustomDomain: string | null | undefined
): boolean {
  if (!orgCustomDomain) return false;

  return (
    app.custom_domain_hostname === getExpectedCustomDomainHostname(app.script_name, orgCustomDomain) &&
    app.custom_domain_status === 'active' &&
    app.custom_domain_ssl_status === 'active'
  );
}

export function getPreferredAppUrl(
  app: AppCustomDomainState,
  options: {
    hostname?: string;
    orgSlug?: string;
    orgCustomDomain?: string | null;
  }
): string {
  const { hostname, orgSlug, orgCustomDomain } = options;
  if (isAppCustomDomainReady(app, orgCustomDomain)) {
    return getCustomDomainAppUrl(app.script_name, orgCustomDomain!);
  }
  return getAppUrl(app.script_name, hostname, orgSlug);
}

/**
 * Get the full iframe URL for a deployed app (used for same-site embedding).
 * New-style slugs use single hyphen, old-style use double hyphen.
 */
export function getAppIframeUrl(scriptName: string, hostname?: string, orgSlug?: string): string {
  const domain = getIframeDomain(hostname);
  if (orgSlug) {
    return `https://${buildAppLabel(scriptName, orgSlug)}.${domain}`;
  }
  return `https://${scriptName}.${domain}`;
}
