const DEFAULT_CUSTOM_HOSTNAME_TARGET = 'custom-domains.camelai.app';

function normalizeHostname(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function normalizeDnsNameForComparison(value: string): string {
  return value.trim().replace(/\.$/, '').toLowerCase();
}

export function getCustomHostnameFallbackOrigin(
  fallbackOrigin: string | null | undefined
): string {
  return normalizeHostname(fallbackOrigin) ?? DEFAULT_CUSTOM_HOSTNAME_TARGET;
}

export function getCustomHostnameDnsTarget(options: {
  cnameTarget?: string | null;
  fallbackOrigin?: string | null;
}): string {
  return (
    normalizeHostname(options.cnameTarget) ??
    getCustomHostnameFallbackOrigin(options.fallbackOrigin)
  );
}

export type CnameLookupResult =
  | { status: 'resolved'; target: string }
  | { status: 'missing' }
  | { status: 'unavailable'; error: string; http_status?: number | null };

export interface CustomDomainDnsCheck {
  queried: string;
  resolved_target: string | null;
  expected_target: string;
  ok: boolean | null;
  status: 'ok' | 'mismatch' | 'missing' | 'unavailable';
  error: string | null;
  http_status: number | null;
}

export function buildCustomDomainDnsCheck(options: {
  queried: string;
  expectedTarget: string;
  lookup: CnameLookupResult;
}): CustomDomainDnsCheck {
  const { queried, expectedTarget, lookup } = options;

  if (lookup.status === 'resolved') {
    const resolvedTarget = lookup.target.replace(/\.$/, '');
    const ok =
      normalizeDnsNameForComparison(resolvedTarget) ===
      normalizeDnsNameForComparison(expectedTarget);

    return {
      queried,
      resolved_target: resolvedTarget,
      expected_target: expectedTarget,
      ok,
      status: ok ? 'ok' : 'mismatch',
      error: null,
      http_status: null,
    };
  }

  if (lookup.status === 'missing') {
    return {
      queried,
      resolved_target: null,
      expected_target: expectedTarget,
      ok: false,
      status: 'missing',
      error: null,
      http_status: null,
    };
  }

  return {
    queried,
    resolved_target: null,
    expected_target: expectedTarget,
    ok: null,
    status: 'unavailable',
    error: lookup.error,
    http_status: lookup.http_status ?? null,
  };
}
