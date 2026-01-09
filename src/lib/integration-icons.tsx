'use client';

import type { ReactNode } from 'react';
import Image from 'next/image';
import { useTheme } from 'next-themes';
import { Settings } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Registry of integration logos.
 *
 * - 'single': one SVG works for both light and dark themes
 * - 'themed': has _light.svg and _dark.svg variants
 */
const logoRegistry: Record<string, 'single' | 'themed'> = {
  // Themed (light/dark variants)
  anthropic: 'themed',
  aws: 'themed',
  github: 'themed',
  mysql: 'themed',
  openai: 'themed',
  // Single (works for both themes)
  airtable: 'single',
  bigquery: 'single',
  hubspot: 'single',
  linear: 'single',
  notion: 'single',
  postgres: 'single',
  salesforce: 'single',
  sendgrid: 'single',
  slack: 'single',
  stripe: 'single',
  twilio: 'single',
};

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
  const { resolvedTheme } = useTheme();

  const variant = logoRegistry[type];

  if (!variant) {
    // No logo registered - show fallback
    return <Settings className={cn('size-5', className)} />;
  }

  const isDark = resolvedTheme === 'dark';

  // Build the image path
  const src =
    variant === 'themed'
      ? `/logos/${type}_${isDark ? 'dark' : 'light'}.svg`
      : `/logos/${type}.svg`;

  return (
    <Image
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
  return type in logoRegistry;
}
