'use client';

import type { ReactNode } from 'react';
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
  clickhouse: 'themed',
  github: 'themed',
  mysql: 'themed',
  openai: 'themed',
  openrouter: 'themed', // NOTE: dark variant may look off — might swap to light icon in white
  typeform: 'themed',
  x: 'themed',
  // Single (works for both themes)
  airtable: 'single',
  bigquery: 'single',
  databricks: 'single',
  hubspot: 'single',
  linear: 'single',
  mailchimp: 'single',
  mixpanel: 'single',
  neon: 'single',
  notion: 'single',
  posthog: 'single',
  postgres: 'single',
  salesforce: 'single',
  sendgrid: 'single',
  sentry: 'single',
  slack: 'single',
  snowflake: 'single',
  stripe: 'single',
  supabase: 'single',
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
  return type in logoRegistry;
}
