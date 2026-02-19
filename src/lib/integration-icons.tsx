import { useEffect, useState, type ReactNode } from 'react';
import { Settings } from 'lucide-react';
import { logoRegistry } from '@/lib/integration-logo-registry';
import { cn } from '@/lib/utils';

function detectDarkMode(): boolean {
  if (typeof document === 'undefined') return false;

  const root = document.documentElement;
  if (root.classList.contains('dark')) return true;
  if (root.classList.contains('light')) return false;

  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  return false;
}

function useDarkMode(): boolean {
  const [isDark, setIsDark] = useState(() => detectDarkMode());

  useEffect(() => {
    if (typeof document === 'undefined') return;

    const update = () => setIsDark(detectDarkMode());
    update();

    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });

    let cleanupMedia: (() => void) | undefined;
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      const media = window.matchMedia('(prefers-color-scheme: dark)');
      const listener = () => update();
      media.addEventListener('change', listener);
      cleanupMedia = () => media.removeEventListener('change', listener);
    }

    return () => {
      observer.disconnect();
      cleanupMedia?.();
    };
  }, []);

  return isDark;
}

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
 * - Single variant: public/logos/{type}.svg
 * - Themed variants: public/logos/{type}_light.svg and public/logos/{type}_dark.svg
 */
export function IntegrationIcon({
  type,
  className,
  size = 20,
}: IntegrationIconProps): ReactNode {
  const isDark = useDarkMode();

  const variant = logoRegistry[type];

  if (!variant) {
    // No logo registered - show fallback
    return <Settings className={cn('size-5', className)} />;
  }

  // Build the image path
  const src =
    variant === 'themed'
      ? `/logos/${type}_${isDark ? 'dark' : 'light'}.svg`
      : `/logos/${type}.svg`;

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
  return Object.hasOwn(logoRegistry, type);
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
