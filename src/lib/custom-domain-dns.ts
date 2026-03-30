const DEFAULT_CUSTOM_HOSTNAME_TARGET = 'custom-domains.camelai.app';

function normalizeHostname(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
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
