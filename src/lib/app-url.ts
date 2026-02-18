/**
 * Environment-aware app URL generation utilities.
 *
 * These functions derive the correct app domain based on the current environment,
 * detected from the hostname. This ensures workers deploy to and are accessible
 * from environment-specific domains.
 *
 * New flat URL format (with org slug, uses -- separator to avoid nested subdomain issues):
 * Production: {scriptName}--{orgSlug}.camelai.app, {scriptName}--{orgSlug}.apps.camelai.dev
 * Staging: {scriptName}--{orgSlug}.staging.camelai.app, {scriptName}--{orgSlug}.apps.staging.camelai.dev
 * Dev: {scriptName}--{orgSlug}.dev-{name}.camelai.app, {scriptName}--{orgSlug}.apps.dev-{name}.camelai.dev
 * Local: {scriptName}--{orgSlug}.local.camelai.app, {scriptName}--{orgSlug}.apps.local.camelai.dev
 *
 * Legacy URL format (backwards compatibility, no org slug):
 * Production: {scriptName}.camelai.app, {scriptName}.apps.camelai.dev
 */

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
 * Uses flat format with -- separator to avoid nested subdomain issues.
 * e.g., "https://my-app--acme-85b.camelai.app" for production
 * e.g., "https://my-app--acme-85b.staging.camelai.app" for staging
 */
export function getAppUrl(scriptName: string, hostname?: string, orgSlug?: string): string {
  const domain = getVanityDomain(hostname);
  if (orgSlug) {
    return `https://${scriptName}--${orgSlug}.${domain}`;
  }
  // Legacy format without org slug
  return `https://${scriptName}.${domain}`;
}

/**
 * Get the full iframe URL for a deployed app (used for same-site embedding).
 * Uses flat format with -- separator to avoid nested subdomain issues.
 * e.g., "https://my-app--acme-85b.apps.camelai.dev" for production
 * e.g., "https://my-app--acme-85b.apps.staging.camelai.dev" for staging
 */
export function getAppIframeUrl(scriptName: string, hostname?: string, orgSlug?: string): string {
  const domain = getIframeDomain(hostname);
  if (orgSlug) {
    return `https://${scriptName}--${orgSlug}.${domain}`;
  }
  // Legacy format without org slug
  return `https://${scriptName}.${domain}`;
}
