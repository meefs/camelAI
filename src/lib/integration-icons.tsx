import type { CSSProperties, ReactNode } from 'react';
import { Settings } from 'lucide-react';
import { integrationLogoAliases, logoRegistry } from '@/lib/integration-logo-registry';
import { cn } from '@/lib/utils';

interface IntegrationIconProps {
  type: string;
  className?: string;
  size?: number;
}

/**
 * Returns the logo for an integration type.
 * Uses SVG files from public/logos/.
 *
 * File naming convention:
 * - Single variant: public/logos/{type}.svg (camelAI uses the existing root favicon)
 * - Themed variants: public/logos/{type}_light.svg and public/logos/{type}_dark.svg
 */
export function IntegrationIcon({
  type,
  className,
  size = 20,
}: IntegrationIconProps): ReactNode {
  const logoType = integrationLogoAliases[type] ?? type;
  const variant = logoRegistry[logoType];

  if (!variant) {
    // No logo registered - show fallback
    return <Settings className={cn('size-5', className)} />;
  }

  if (variant === 'themed') {
    const style = {
      width: size,
      height: size,
      '--integration-icon-light': `url(/logos/${logoType}_light.svg)`,
      '--integration-icon-dark': `url(/logos/${logoType}_dark.svg)`,
    } as CSSProperties;

    return (
      <span
        role="img"
        aria-label={type}
        style={style}
        className={cn(
          'inline-block shrink-0 bg-contain bg-center bg-no-repeat [background-image:var(--integration-icon-light)] dark:[background-image:var(--integration-icon-dark)]',
          className,
        )}
      />
    );
  }

  // The camelAI mark is the application favicon, rather than an integration
  // asset. Reference it directly so nested SVG image loading cannot hide it.
  const src = logoType === 'camelai' ? '/favicon.svg' : `/logos/${logoType}.svg`;

  return (
    <img
      src={src}
      alt={type}
      width={size}
      height={size}
      className={className}
    />
  );
}

/**
 * Check if a logo exists for an integration type
 */
export function hasIntegrationIcon(type: string): boolean {
  return Object.hasOwn(logoRegistry, integrationLogoAliases[type] ?? type);
}

/**
 * Resolve the best logo type for a connection.
 *
 * When integration_type is "other" (custom integrations), tries to match
 * the display name or connection name to a known logo in the registry.
 */
export function resolveLogoType(
  integrationType: string,
  nameHints?: (string | undefined | null)[]
): string {
  if (Object.hasOwn(integrationLogoAliases, integrationType)) return integrationType;
  if (Object.hasOwn(logoRegistry, integrationType)) return integrationType;

  if (nameHints) {
    for (const hint of nameHints) {
      if (!hint || typeof hint !== 'string') continue;
      const normalized = hint.toLowerCase().replace(/[^a-z0-9]/g, '');

      // Exact match after normalization (e.g. "ClickHouse" → "clickhouse")
      if (Object.hasOwn(logoRegistry, normalized)) return normalized;

      // Substring match — skip keys shorter than 3 chars to avoid false
      // positives (e.g. "x" would match almost anything)
      for (const key of Object.keys(logoRegistry)) {
        if (key.length >= 3 && normalized.includes(key)) return key;
      }
    }
  }

  return integrationType;
}
