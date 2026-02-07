'use client';

import { IntegrationIcon } from '@/lib/integration-icons';
import { cn } from '@/lib/utils';

export const FEATURED_CONNECTIONS = [
  { type: 'stripe', displayName: 'Stripe' },
  { type: 'slack', displayName: 'Slack' },
  { type: 'postgres', displayName: 'PostgreSQL' },
  { type: 'github', displayName: 'GitHub' },
  { type: 'notion', displayName: 'Notion' },
];

export const LOGO_STACK_CONNECTIONS = [
  { type: 'hubspot', displayName: 'HubSpot' },
  { type: 'airtable', displayName: 'Airtable' },
  { type: 'snowflake', displayName: 'Snowflake' },
  { type: 'openai', displayName: 'OpenAI' },
  { type: 'bigquery', displayName: 'BigQuery' },
];

export const FEATURED_INTEGRATIONS = [
  ...FEATURED_CONNECTIONS,
  { type: 'hubspot', displayName: 'HubSpot' },
  { type: 'airtable', displayName: 'Airtable' },
  { type: 'openai', displayName: 'OpenAI' },
];

interface IntegrationButtonsProps {
  onSelect: (integration: { type: string; displayName: string }) => void;
  integrations?: { type: string; displayName: string }[];
}

export function IntegrationButtons({ onSelect, integrations = FEATURED_INTEGRATIONS }: IntegrationButtonsProps) {
  const displayIntegrations = integrations.slice(0, 6);
  return (
    <div className="flex flex-wrap gap-3">
      {displayIntegrations.map((integration) => (
        <button
          key={integration.type}
          type="button"
          onClick={() => onSelect(integration)}
          className={cn(
            'inline-flex items-center gap-2 px-4 py-2.5 rounded-lg cursor-pointer',
            'border border-border bg-card hover:bg-accent/50',
            'transition-all duration-200 ease-out text-sm',
            'hover:border-ring hover:shadow-md'
          )}
        >
          <IntegrationIcon type={integration.type} size={16} />
          <span className="text-foreground">{integration.displayName}</span>
        </button>
      ))}
    </div>
  );
}
