export type IntegrationLogoVariant = 'single' | 'themed';

/**
 * Registry of integration logos in public/logos.
 *
 * - 'single': one SVG works for both light and dark themes
 * - 'themed': has _light.svg and _dark.svg variants
 */
export const logoRegistry: Record<string, IntegrationLogoVariant> = {
  // Themed (light/dark variants)
  anthropic: 'themed',
  aws: 'themed',
  clickhouse: 'themed',
  github: 'themed',
  mongodb: 'themed',
  mssql: 'themed',
  mysql: 'themed',
  openai: 'themed',
  openrouter: 'themed',
  typeform: 'themed',
  x: 'themed',
  // Single (works for both themes)
  airtable: 'single',
  amplitude: 'single',
  asana: 'single',
  azure: 'single',
  bigquery: 'single',
  cloudflare: 'single',
  databricks: 'single',
  discord: 'single',
  figma: 'single',
  gcp: 'single',
  hubspot: 'single',
  intercom: 'single',
  jira: 'single',
  linear: 'single',
  mailchimp: 'single',
  mixpanel: 'single',
  neon: 'single',
  netlify: 'single',
  notion: 'single',
  planetscale: 'single',
  posthog: 'single',
  postgres: 'single',
  redis: 'single',
  salesforce: 'single',
  segment: 'single',
  sendgrid: 'single',
  sentry: 'single',
  shopify: 'single',
  slack: 'single',
  snowflake: 'single',
  square: 'single',
  stripe: 'single',
  supabase: 'single',
  teams: 'single',
  turso: 'single',
  twilio: 'single',
  vercel: 'single',
  zendesk: 'single',
};
