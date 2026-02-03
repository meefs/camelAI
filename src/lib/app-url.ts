/**
 * Environment-aware app URL generation utilities.
 *
 * These functions derive the correct app domain based on the current environment,
 * detected from the hostname. This ensures workers deploy to and are accessible
 * from environment-specific domains.
 *
 * New flat URL format (with org slug, uses -- separator to avoid nested subdomain issues):
 * Production: {scriptName}--{orgSlug}.chiridion.app, {scriptName}--{orgSlug}.apps.chiridion.ai
 * Staging: {scriptName}--{orgSlug}.staging.chiridion.app, {scriptName}--{orgSlug}.apps.staging.chiridion.ai
 * Dev: {scriptName}--{orgSlug}.dev-{name}.chiridion.app, {scriptName}--{orgSlug}.apps.dev-{name}.chiridion.ai
 * Local: {scriptName}--{orgSlug}.local.chiridion.app, {scriptName}--{orgSlug}.apps.local.chiridion.ai
 *
 * Legacy URL format (backwards compatibility, no org slug):
 * Production: {scriptName}.chiridion.app, {scriptName}.apps.chiridion.ai
 */

/**
 * Extract the environment prefix from a hostname.
 * Returns empty string for production, otherwise returns the env prefix (e.g., "staging", "dev-miguel", "local").
 */
function getEnvPrefix(hostname: string): string {
  // Handle chiridion.ai domains (main app)
  // e.g., staging.chiridion.ai -> staging
  // e.g., dev-miguel.chiridion.ai -> dev-miguel
  // e.g., chiridion.ai -> "" (production)
  if (hostname.endsWith('.chiridion.ai') || hostname === 'chiridion.ai') {
    const parts = hostname.split('.');
    // chiridion.ai or www.chiridion.ai = production
    if (parts.length <= 2 || parts[0] === 'www') {
      return '';
    }
    // {env}.chiridion.ai
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
 * e.g., "chiridion.app" for production, "staging.chiridion.app" for staging
 */
export function getVanityDomain(hostname?: string): string {
  const host = hostname ?? (typeof window !== 'undefined' ? window.location.hostname : 'chiridion.ai');
  const envPrefix = getEnvPrefix(host);

  if (envPrefix) {
    return `${envPrefix}.chiridion.app`;
  }
  return 'chiridion.app';
}

/**
 * Get the iframe URL domain for deployed apps (same-site).
 * e.g., "apps.chiridion.ai" for production, "apps.staging.chiridion.ai" for staging
 */
export function getIframeDomain(hostname?: string): string {
  const host = hostname ?? (typeof window !== 'undefined' ? window.location.hostname : 'chiridion.ai');
  const envPrefix = getEnvPrefix(host);

  if (envPrefix) {
    return `apps.${envPrefix}.chiridion.ai`;
  }
  return 'apps.chiridion.ai';
}

/**
 * Get the full vanity URL for a deployed app with org slug.
 * Uses flat format with -- separator to avoid nested subdomain issues.
 * e.g., "https://my-app--acme-85b.chiridion.app" for production
 * e.g., "https://my-app--acme-85b.staging.chiridion.app" for staging
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
 * e.g., "https://my-app--acme-85b.apps.chiridion.ai" for production
 * e.g., "https://my-app--acme-85b.apps.staging.chiridion.ai" for staging
 */
export function getAppIframeUrl(scriptName: string, hostname?: string, orgSlug?: string): string {
  const domain = getIframeDomain(hostname);
  if (orgSlug) {
    return `https://${scriptName}--${orgSlug}.${domain}`;
  }
  // Legacy format without org slug
  return `https://${scriptName}.${domain}`;
}
