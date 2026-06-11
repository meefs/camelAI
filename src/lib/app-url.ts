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

export interface AppUrlContext {
  /**
   * Host of the main app request. Production/staging Cloudflare domains are
   * derived from this when explicit app domains are not configured.
   */
  hostname?: string;
  /** Explicit cross-site app domain for self-host deployments. */
  vanityDomain?: string | null;
  /** Explicit iframe app domain for self-host deployments. */
  iframeDomain?: string | null;
}

export type AppUrlInput = string | AppUrlContext | undefined;

/**
 * Extract the environment prefix from a hostname.
 * Returns empty string for production, otherwise returns the env prefix (e.g., "staging", "dev-miguel", "local").
 */
function normalizeHost(host?: string | null): string {
  const fallback = typeof window !== 'undefined' ? window.location.host : 'camelai.dev';
  const raw = (host ?? fallback).trim();
  if (!raw) return 'camelai.dev';
  try {
    return new URL(raw.includes('://') ? raw : `https://${raw}`).host.toLowerCase();
  } catch {
    return raw.replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
  }
}

function getHostname(host?: string): string {
  return normalizeHost(host).replace(/:\d+$/, '');
}

function getHostInput(input?: AppUrlInput): string | undefined {
  return typeof input === 'string' ? input : input?.hostname;
}

function getConfiguredDomain(value?: string | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return normalizeHost(trimmed);
}

function getConfiguredVanityDomain(input?: AppUrlInput): string | null {
  return typeof input === 'string' ? null : getConfiguredDomain(input?.vanityDomain);
}

function getConfiguredIframeDomain(input?: AppUrlInput): string | null {
  return typeof input === 'string' ? null : getConfiguredDomain(input?.iframeDomain);
}

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

  // Default to production
  return '';
}

/**
 * Get the vanity URL domain for deployed apps (cross-site).
 * e.g., "camelai.app" for production, "staging.camelai.app" for staging
 */
export function getVanityDomain(input?: AppUrlInput): string {
  const configuredDomain = getConfiguredVanityDomain(input);
  if (configuredDomain) {
    return configuredDomain;
  }

  const host = normalizeHost(getHostInput(input));
  const envPrefix = getEnvPrefix(getHostname(host));

  if (envPrefix) {
    return `${envPrefix}.camelai.app`;
  }

  if (getHostname(host) !== 'camelai.dev' && !getHostname(host).endsWith('.camelai.dev')) {
    return host;
  }

  return 'camelai.app';
}

/**
 * Get the iframe URL domain for deployed apps (same-site).
 * e.g., "apps.camelai.dev" for production, "apps.staging.camelai.dev" for staging
 */
export function getIframeDomain(input?: AppUrlInput): string {
  const configuredDomain = getConfiguredIframeDomain(input);
  if (configuredDomain) {
    return configuredDomain;
  }

  const host = normalizeHost(getHostInput(input));
  const envPrefix = getEnvPrefix(getHostname(host));

  if (envPrefix) {
    return `apps.${envPrefix}.camelai.dev`;
  }
  return 'apps.camelai.dev';
}

/**
 * Get the full vanity URL for a deployed app with org slug.
 * New-style slugs use single hyphen, old-style use double hyphen.
 */
export function getAppUrl(scriptName: string, hostname?: AppUrlInput, orgSlug?: string): string {
  const domain = getVanityDomain(hostname);
  if (orgSlug) {
    return `https://${buildAppLabel(scriptName, orgSlug)}.${domain}`;
  }
  return `https://${scriptName}.${domain}`;
}

/**
 * Get the custom domain URL for a deployed app when the app has an exact custom hostname.
 */
export function getCustomDomainAppUrl(customHostname: string): string {
  return `https://${customHostname}`;
}

type AppCustomDomainState = Pick<
  WorkerScript,
  | 'script_name'
  | 'custom_domain_hostname'
  | 'custom_domain_status'
  | 'custom_domain_ssl_status'
>;

export function isAppCustomDomainReady(
  app: AppCustomDomainState,
  orgCustomDomain?: string | null
): boolean {
  void orgCustomDomain;

  return (
    !!app.custom_domain_hostname &&
    app.custom_domain_status === 'active' &&
    app.custom_domain_ssl_status === 'active'
  );
}

export function getPreferredAppUrl(
  app: AppCustomDomainState,
  options: {
    hostname?: AppUrlInput;
    orgSlug?: string;
    orgCustomDomain?: string | null;
  }
): string {
  const { hostname, orgSlug, orgCustomDomain } = options;
  if (isAppCustomDomainReady(app, orgCustomDomain)) {
    return getCustomDomainAppUrl(app.custom_domain_hostname!);
  }
  return getAppUrl(app.script_name, hostname, orgSlug);
}

/**
 * Get the full iframe URL for a deployed app (used for same-site embedding).
 * New-style slugs use single hyphen, old-style use double hyphen.
 */
export function getAppIframeUrl(scriptName: string, hostname?: AppUrlInput, orgSlug?: string): string {
  const domain = getIframeDomain(hostname);
  if (orgSlug) {
    return `https://${buildAppLabel(scriptName, orgSlug)}.${domain}`;
  }
  return `https://${scriptName}.${domain}`;
}
