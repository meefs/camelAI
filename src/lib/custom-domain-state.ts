import { getExpectedCustomDomainHostname, isAppCustomDomainReady } from './app-url';

export const CUSTOM_DOMAIN_REFRESH_INTERVAL_MS = 60 * 1000;

interface AppCustomDomainBaseState {
  script_name: string;
  custom_domain_hostname: string | null;
  custom_domain_status: string | null;
  custom_domain_ssl_status: string | null;
}

export interface AppCustomDomainRefreshState extends AppCustomDomainBaseState {
  custom_domain_updated_at: number | null;
}

export interface AppCustomDomainProvisioningState extends AppCustomDomainRefreshState {
  custom_domain_cf_hostname_id: string | null;
  custom_domain_error: string | null;
}

export function hasExpectedCustomDomainHostname(
  app: Pick<AppCustomDomainBaseState, 'script_name' | 'custom_domain_hostname'>,
  orgCustomDomain: string | null | undefined
): boolean {
  if (!orgCustomDomain) return false;
  return app.custom_domain_hostname === getExpectedCustomDomainHostname(app.script_name, orgCustomDomain);
}

export function shouldRefreshAppCustomDomainState(
  app: AppCustomDomainRefreshState,
  orgCustomDomain: string | null | undefined,
  now: number,
  refreshIntervalMs = CUSTOM_DOMAIN_REFRESH_INTERVAL_MS
): boolean {
  if (!orgCustomDomain || isAppCustomDomainReady(app, orgCustomDomain)) {
    return false;
  }

  if (app.custom_domain_hostname && !hasExpectedCustomDomainHostname(app, orgCustomDomain)) {
    return true;
  }

  if (!app.custom_domain_updated_at) {
    return true;
  }

  return now - app.custom_domain_updated_at >= refreshIntervalMs;
}

export function shouldRetryAppCustomDomainProvisioning(
  app: AppCustomDomainProvisioningState,
  orgCustomDomain: string | null | undefined
): boolean {
  if (!orgCustomDomain || isAppCustomDomainReady(app, orgCustomDomain)) {
    return false;
  }

  if (!hasExpectedCustomDomainHostname(app, orgCustomDomain)) {
    return true;
  }

  return (
    !app.custom_domain_cf_hostname_id ||
    !!app.custom_domain_error ||
    !app.custom_domain_status ||
    !app.custom_domain_ssl_status ||
    app.custom_domain_status === 'failed' ||
    app.custom_domain_ssl_status === 'failed'
  );
}

export function getAppCustomDomainDiagnosticState(
  app: AppCustomDomainProvisioningState,
  orgCustomDomain: string | null | undefined
): {
  hostname: string | null;
  cf_hostname_id: string | null;
  status: string | null;
  ssl_status: string | null;
  error: string | null;
  updated_at: number | null;
} {
  if (!orgCustomDomain) {
    return {
      hostname: app.custom_domain_hostname ?? null,
      cf_hostname_id: app.custom_domain_cf_hostname_id ?? null,
      status: app.custom_domain_status ?? null,
      ssl_status: app.custom_domain_ssl_status ?? null,
      error: app.custom_domain_error ?? null,
      updated_at: app.custom_domain_updated_at ?? null,
    };
  }

  const expectedHostname = getExpectedCustomDomainHostname(app.script_name, orgCustomDomain);
  if (!hasExpectedCustomDomainHostname(app, orgCustomDomain)) {
    return {
      hostname: expectedHostname,
      cf_hostname_id: null,
      status: null,
      ssl_status: null,
      error: null,
      updated_at: null,
    };
  }

  return {
    hostname: expectedHostname,
    cf_hostname_id: app.custom_domain_cf_hostname_id ?? null,
    status: app.custom_domain_status ?? null,
    ssl_status: app.custom_domain_ssl_status ?? null,
    error: app.custom_domain_error ?? null,
    updated_at: app.custom_domain_updated_at ?? null,
  };
}
