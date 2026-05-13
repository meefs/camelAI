export type ProviderMcpAuthStrategy =
  | 'camelai_hosted_broker'
  | 'connected_credentials_broker'
  | 'first_party_oauth_direct';

export type ProviderMcpTransport = 'streamable_http' | 'sse';

export interface ProviderMcpDefinition {
  integrationType: string;
  serverName: string;
  url: string;
  transport: ProviderMcpTransport;
  authStrategy: ProviderMcpAuthStrategy;
  brokered: boolean;
  directConnect: boolean;
  preferredMode?: 'direct' | 'brokered';
  direct?: {
    serverName?: string;
    url: string;
    transport: ProviderMcpTransport;
    authStrategy: 'first_party_oauth_direct';
    docsUrl?: string;
    notes?: string;
  };
  broker?: {
    serverName?: string;
    url: string;
    transport: ProviderMcpTransport;
    authStrategy: 'camelai_hosted_broker' | 'connected_credentials_broker';
    docsUrl?: string;
    notes?: string;
  };
  docsUrl?: string;
  notes?: string;
}

export const PROVIDER_MCP_REGISTRY: Record<string, ProviderMcpDefinition> = {
  bigquery: {
    integrationType: 'bigquery',
    serverName: 'bigquery',
    url: 'camelai://integrations/bigquery',
    transport: 'streamable_http',
    authStrategy: 'camelai_hosted_broker',
    brokered: true,
    directConnect: false,
    docsUrl: 'https://cloud.google.com/bigquery/docs/reference/rest',
    notes:
      'camelAI-hosted BigQuery MCP broker. camelAI uses the connected service account server-side and exposes read-only BigQuery tools.',
  },
  clickhouse: {
    integrationType: 'clickhouse',
    serverName: 'clickhouse',
    url: 'camelai://integrations/clickhouse',
    transport: 'streamable_http',
    authStrategy: 'camelai_hosted_broker',
    brokered: true,
    directConnect: false,
    docsUrl: 'https://clickhouse.com/docs/interfaces/http',
    notes:
      'camelAI-hosted ClickHouse MCP broker. camelAI uses the connected ClickHouse credentials server-side and exposes read-only SQL and schema tools.',
  },
  postgres: {
    integrationType: 'postgres',
    serverName: 'postgres',
    url: 'camelai://integrations/postgres',
    transport: 'streamable_http',
    authStrategy: 'camelai_hosted_broker',
    brokered: true,
    directConnect: false,
    docsUrl: 'https://www.postgresql.org/docs/current/infoschema.html',
    notes:
      'camelAI-hosted PostgreSQL MCP broker. camelAI uses the connected database credentials server-side through the sandbox data proxy and exposes read-only SQL and schema tools.',
  },
  mysql: {
    integrationType: 'mysql',
    serverName: 'mysql',
    url: 'camelai://integrations/mysql',
    transport: 'streamable_http',
    authStrategy: 'camelai_hosted_broker',
    brokered: true,
    directConnect: false,
    docsUrl: 'https://dev.mysql.com/doc/refman/8.4/en/information-schema.html',
    notes:
      'camelAI-hosted MySQL MCP broker. camelAI uses the connected database credentials server-side through the sandbox data proxy and exposes read-only SQL and schema tools.',
  },
  neon: {
    integrationType: 'neon',
    serverName: 'neon',
    url: 'camelai://integrations/neon',
    transport: 'streamable_http',
    authStrategy: 'camelai_hosted_broker',
    brokered: true,
    directConnect: false,
    docsUrl: 'https://neon.com/docs/connect/connect-from-any-app',
    notes:
      'camelAI-hosted Neon MCP broker. camelAI uses the connected Postgres connection string server-side through the sandbox data proxy and exposes read-only SQL and schema tools.',
  },
  planetscale: {
    integrationType: 'planetscale',
    serverName: 'planetscale',
    url: 'camelai://integrations/planetscale',
    transport: 'streamable_http',
    authStrategy: 'camelai_hosted_broker',
    brokered: true,
    directConnect: false,
    docsUrl: 'https://planetscale.com/docs/concepts/connection-strings',
    notes:
      'camelAI-hosted PlanetScale MCP broker. camelAI uses the connected MySQL connection string server-side through the sandbox data proxy and exposes read-only SQL and schema tools.',
  },
  snowflake: {
    integrationType: 'snowflake',
    serverName: 'snowflake',
    url: 'camelai://integrations/snowflake',
    transport: 'streamable_http',
    authStrategy: 'camelai_hosted_broker',
    brokered: true,
    directConnect: false,
    docsUrl: 'https://docs.snowflake.com/en/developer-guide/sql-api/index',
    notes:
      'camelAI-hosted Snowflake MCP broker. camelAI uses key-pair credentials server-side through the Snowflake SQL API and exposes read-only SQL and metadata tools.',
  },
  mongodb: {
    integrationType: 'mongodb',
    serverName: 'mongodb',
    url: 'camelai://integrations/mongodb',
    transport: 'streamable_http',
    authStrategy: 'camelai_hosted_broker',
    brokered: true,
    directConnect: false,
    docsUrl: 'https://www.mongodb.com/docs/atlas/app-services/data-api/',
    notes:
      'camelAI-hosted MongoDB MCP broker. camelAI uses Atlas Data API credentials server-side and exposes read-only collection and document query tools.',
  },
  redis: {
    integrationType: 'redis',
    serverName: 'redis',
    url: 'camelai://integrations/redis',
    transport: 'streamable_http',
    authStrategy: 'camelai_hosted_broker',
    brokered: true,
    directConnect: false,
    docsUrl: 'https://upstash.com/docs/redis/features/restapi',
    notes:
      'camelAI-hosted Redis MCP broker. camelAI uses an HTTP Redis REST endpoint server-side and exposes a conservative read-only command allowlist.',
  },
  turso: {
    integrationType: 'turso',
    serverName: 'turso',
    url: 'camelai://integrations/turso',
    transport: 'streamable_http',
    authStrategy: 'camelai_hosted_broker',
    brokered: true,
    directConnect: false,
    docsUrl: 'https://docs.turso.tech/api-reference/http',
    notes:
      'camelAI-hosted Turso MCP broker. camelAI uses the connected libSQL URL and auth token server-side and exposes read-only SQL and schema tools.',
  },
  databricks: {
    integrationType: 'databricks',
    serverName: 'databricks',
    url: 'camelai://integrations/databricks',
    transport: 'streamable_http',
    authStrategy: 'camelai_hosted_broker',
    brokered: true,
    directConnect: false,
    docsUrl: 'https://docs.databricks.com/api/workspace/statementexecution',
    notes:
      'camelAI-hosted Databricks MCP broker. camelAI uses the connected workspace PAT server-side and exposes SQL warehouse discovery plus read-only statement execution.',
  },
  github: {
    integrationType: 'github',
    serverName: 'github',
    url: 'https://api.githubcopilot.com/mcp/',
    transport: 'streamable_http',
    authStrategy: 'connected_credentials_broker',
    brokered: true,
    directConnect: false,
    preferredMode: 'brokered',
    direct: {
      url: 'https://api.githubcopilot.com/mcp/',
      transport: 'streamable_http',
      authStrategy: 'first_party_oauth_direct',
      docsUrl: 'https://docs.github.com/en/copilot/how-tos/context/model-context-protocol/using-the-github-mcp-server',
      notes:
        'Official remote GitHub MCP server. camelAI brokers access so workers and containers use the same connection path.',
    },
    broker: {
      url: 'https://api.githubcopilot.com/mcp/',
      transport: 'streamable_http',
      authStrategy: 'connected_credentials_broker',
    },
    docsUrl: 'https://docs.github.com/en/copilot/how-tos/context/model-context-protocol/using-the-github-mcp-server',
    notes:
      'Official remote GitHub MCP server. camelAI proxies this server and injects the connected GitHub credential server-side.',
  },
  linear: {
    integrationType: 'linear',
    serverName: 'linear',
    url: 'https://mcp.linear.app/mcp',
    transport: 'streamable_http',
    authStrategy: 'connected_credentials_broker',
    brokered: true,
    directConnect: false,
    preferredMode: 'brokered',
    direct: {
      url: 'https://mcp.linear.app/mcp',
      transport: 'streamable_http',
      authStrategy: 'first_party_oauth_direct',
      docsUrl: 'https://linear.app/docs/mcp',
      notes:
        'Official Linear MCP server. camelAI brokers access so workers and containers use the same connection path.',
    },
    broker: {
      url: 'https://mcp.linear.app/mcp',
      transport: 'streamable_http',
      authStrategy: 'connected_credentials_broker',
    },
    docsUrl: 'https://linear.app/docs/mcp',
    notes:
      'Official Linear MCP server. camelAI proxies this server and injects the connected Linear credential server-side.',
  },
  notion: {
    integrationType: 'notion',
    serverName: 'notion',
    url: 'https://mcp.notion.com/mcp',
    transport: 'streamable_http',
    authStrategy: 'first_party_oauth_direct',
    brokered: true,
    directConnect: false,
    docsUrl: 'https://developers.notion.com/guides/mcp/mcp',
    notes:
      'Official hosted Notion MCP server. Notion requires first-party MCP OAuth; camelAI brokers this first-party MCP server using connected credentials where available.',
  },
  supabase: {
    integrationType: 'supabase',
    serverName: 'supabase',
    url: 'https://mcp.supabase.com/mcp',
    transport: 'streamable_http',
    authStrategy: 'first_party_oauth_direct',
    brokered: true,
    directConnect: false,
    docsUrl: 'https://supabase.com/docs/guides/getting-started/mcp',
    notes:
      'Official hosted Supabase MCP server. Supports provider OAuth plus project scoping/read-only query parameters; camelAI brokers this first-party MCP server using connected credentials where available.',
  },
  stripe: {
    integrationType: 'stripe',
    serverName: 'stripe',
    url: 'https://mcp.stripe.com',
    transport: 'streamable_http',
    authStrategy: 'connected_credentials_broker',
    brokered: true,
    directConnect: false,
    preferredMode: 'brokered',
    direct: {
      url: 'https://mcp.stripe.com',
      transport: 'streamable_http',
      authStrategy: 'first_party_oauth_direct',
      docsUrl: 'https://docs.stripe.com/mcp',
      notes:
        'Official Stripe MCP server. camelAI brokers access so workers and containers use the same connection path.',
    },
    broker: {
      url: 'https://mcp.stripe.com',
      transport: 'streamable_http',
      authStrategy: 'connected_credentials_broker',
    },
    docsUrl: 'https://docs.stripe.com/mcp',
    notes:
      'Official Stripe MCP server. camelAI proxies this server and injects the connected Stripe key server-side.',
  },
  sentry: {
    integrationType: 'sentry',
    serverName: 'sentry',
    url: 'camelai://integrations/sentry',
    transport: 'streamable_http',
    authStrategy: 'camelai_hosted_broker',
    brokered: true,
    directConnect: false,
    docsUrl: 'https://docs.sentry.io/api/',
    notes:
      'camelAI-hosted Sentry MCP broker. camelAI uses the connected Sentry auth token server-side and exposes read-oriented Sentry tools.',
  },
  mailchimp: {
    integrationType: 'mailchimp',
    serverName: 'mailchimp',
    url: 'camelai://integrations/mailchimp',
    transport: 'streamable_http',
    authStrategy: 'camelai_hosted_broker',
    brokered: true,
    directConnect: false,
    docsUrl: 'https://mailchimp.com/developer/marketing/api/',
    notes:
      'camelAI-hosted Mailchimp MCP broker. camelAI uses the connected Mailchimp API key server-side and exposes read-oriented audience and campaign tools.',
  },
  sendgrid: {
    integrationType: 'sendgrid',
    serverName: 'sendgrid',
    url: 'camelai://integrations/sendgrid',
    transport: 'streamable_http',
    authStrategy: 'camelai_hosted_broker',
    brokered: true,
    directConnect: false,
    docsUrl: 'https://www.twilio.com/docs/sendgrid/api-reference',
    notes:
      'camelAI-hosted SendGrid MCP broker. camelAI uses the connected SendGrid API key server-side and exposes read-oriented sender identity and template tools.',
  },
  twilio: {
    integrationType: 'twilio',
    serverName: 'twilio',
    url: 'camelai://integrations/twilio',
    transport: 'streamable_http',
    authStrategy: 'camelai_hosted_broker',
    brokered: true,
    directConnect: false,
    docsUrl: 'https://www.twilio.com/docs/usage/api',
    notes:
      'camelAI-hosted Twilio MCP broker. camelAI uses the connected Twilio Account SID/Auth Token server-side and exposes read-only messages and calls tools.',
  },
  posthog: {
    integrationType: 'posthog',
    serverName: 'posthog',
    url: 'camelai://integrations/posthog',
    transport: 'streamable_http',
    authStrategy: 'camelai_hosted_broker',
    brokered: true,
    directConnect: false,
    docsUrl: 'https://posthog.com/docs/api',
    notes:
      'camelAI-hosted PostHog MCP broker. camelAI uses the connected PostHog personal API key server-side and exposes read-oriented analytics tools.',
  },
  mixpanel: {
    integrationType: 'mixpanel',
    serverName: 'mixpanel',
    url: 'camelai://integrations/mixpanel',
    transport: 'streamable_http',
    authStrategy: 'camelai_hosted_broker',
    brokered: true,
    directConnect: false,
    docsUrl: 'https://developer.mixpanel.com/reference/query-api',
    notes:
      'camelAI-hosted Mixpanel MCP broker. camelAI uses the connected Mixpanel service account server-side and exposes read-oriented analytics tools.',
  },
  amplitude: {
    integrationType: 'amplitude',
    serverName: 'amplitude',
    url: 'camelai://integrations/amplitude',
    transport: 'streamable_http',
    authStrategy: 'camelai_hosted_broker',
    brokered: true,
    directConnect: false,
    docsUrl: 'https://amplitude.com/docs/apis/analytics',
    notes:
      'camelAI-hosted Amplitude MCP broker. camelAI uses the connected Amplitude project credentials server-side and exposes read-oriented analytics tools.',
  },
  airtable: {
    integrationType: 'airtable',
    serverName: 'airtable',
    url: 'camelai://integrations/airtable',
    transport: 'streamable_http',
    authStrategy: 'camelai_hosted_broker',
    brokered: true,
    directConnect: false,
    docsUrl: 'https://airtable.com/developers/web/api/introduction',
    notes:
      'camelAI-hosted Airtable MCP broker. camelAI uses the connected Airtable token server-side and exposes read-oriented Airtable tools.',
  },
  zendesk: {
    integrationType: 'zendesk',
    serverName: 'zendesk',
    url: 'camelai://integrations/zendesk',
    transport: 'streamable_http',
    authStrategy: 'camelai_hosted_broker',
    brokered: true,
    directConnect: false,
    docsUrl: 'https://developer.zendesk.com/api-reference/ticketing/ticket-management/search/',
    notes:
      'camelAI-hosted Zendesk MCP broker. camelAI uses the connected Zendesk API token server-side and exposes read-oriented ticket search and lookup tools.',
  },
  shopify: {
    integrationType: 'shopify',
    serverName: 'shopify',
    url: 'camelai://integrations/shopify',
    transport: 'streamable_http',
    authStrategy: 'camelai_hosted_broker',
    brokered: true,
    directConnect: false,
    docsUrl: 'https://shopify.dev/docs/api/admin-graphql',
    notes:
      'camelAI-hosted Shopify MCP broker. camelAI uses the connected Admin API access token server-side and exposes read-oriented shop, product, and order tools.',
  },
  segment: {
    integrationType: 'segment',
    serverName: 'segment',
    url: 'camelai://integrations/segment',
    transport: 'streamable_http',
    authStrategy: 'camelai_hosted_broker',
    brokered: true,
    directConnect: false,
    docsUrl: 'https://docs.segmentapis.com/',
    notes:
      'camelAI-hosted Segment MCP broker. camelAI uses a Segment Public API token server-side and exposes read-oriented source and destination catalog tools.',
  },
  teams: {
    integrationType: 'teams',
    serverName: 'teams',
    url: 'camelai://integrations/teams',
    transport: 'streamable_http',
    authStrategy: 'camelai_hosted_broker',
    brokered: true,
    directConnect: false,
    docsUrl: 'https://learn.microsoft.com/en-us/graph/teams-concept-overview',
    notes:
      'camelAI-hosted Microsoft Teams MCP broker. camelAI uses app-only Microsoft Graph credentials server-side and exposes read-oriented teams, channels, and message tools.',
  },
  intercom: {
    integrationType: 'intercom',
    serverName: 'intercom',
    url: 'https://mcp.intercom.com/mcp',
    transport: 'streamable_http',
    authStrategy: 'connected_credentials_broker',
    brokered: true,
    directConnect: false,
    preferredMode: 'brokered',
    direct: {
      url: 'https://mcp.intercom.com/mcp',
      transport: 'streamable_http',
      authStrategy: 'first_party_oauth_direct',
      docsUrl: 'https://developers.intercom.com/docs/guides/mcp',
      notes:
        'Official Intercom remote MCP server. camelAI brokers access so workers and containers use the same connection path.',
    },
    broker: {
      url: 'https://mcp.intercom.com/mcp',
      transport: 'streamable_http',
      authStrategy: 'connected_credentials_broker',
    },
    docsUrl: 'https://developers.intercom.com/docs/guides/mcp',
    notes:
      'Official Intercom remote MCP server. camelAI proxies this server and injects the connected Intercom access token server-side.',
  },
  typeform: {
    integrationType: 'typeform',
    serverName: 'typeform',
    url: 'https://api.typeform.com/mcp',
    transport: 'streamable_http',
    authStrategy: 'connected_credentials_broker',
    brokered: true,
    directConnect: false,
    preferredMode: 'brokered',
    direct: {
      url: 'https://api.typeform.com/mcp',
      transport: 'streamable_http',
      authStrategy: 'first_party_oauth_direct',
      docsUrl: 'https://www.typeform.com/developers/get-started/mcp/',
      notes:
        'Official Typeform remote MCP server. camelAI brokers access so workers and containers use the same connection path.',
    },
    broker: {
      url: 'https://api.typeform.com/mcp',
      transport: 'streamable_http',
      authStrategy: 'connected_credentials_broker',
    },
    docsUrl: 'https://www.typeform.com/developers/get-started/mcp/',
    notes:
      'Official Typeform remote MCP server. camelAI proxies this server and injects the connected Typeform personal access token server-side.',
  },
  asana: {
    integrationType: 'asana',
    serverName: 'asana',
    url: 'https://mcp.asana.com/v2/mcp',
    transport: 'streamable_http',
    authStrategy: 'first_party_oauth_direct',
    brokered: true,
    directConnect: false,
    docsUrl: 'https://developers.asana.com/docs/using-asanas-mcp-server',
    notes:
      'Official Asana MCP server. camelAI brokers this first-party MCP server using connected credentials where available.',
  },
  hubspot: {
    integrationType: 'hubspot',
    serverName: 'hubspot',
    url: 'https://mcp.hubspot.com',
    transport: 'streamable_http',
    authStrategy: 'first_party_oauth_direct',
    brokered: true,
    directConnect: false,
    docsUrl: 'https://developers.hubspot.com/mcp',
    notes:
      'Official HubSpot MCP server. camelAI brokers this first-party MCP server using connected credentials where available.',
  },
  salesforce: {
    integrationType: 'salesforce',
    serverName: 'salesforce',
    url: 'https://api.salesforce.com/platform/mcp/v1/platform/sobject-reads',
    transport: 'streamable_http',
    authStrategy: 'first_party_oauth_direct',
    brokered: true,
    directConnect: false,
    docsUrl: 'https://developer.salesforce.com/docs/platform/hosted-mcp-servers/guide/sobject-reads.html',
    notes:
      'Official Salesforce Hosted MCP read-only SObject server. camelAI brokers this first-party Hosted MCP server using connected credentials where available.',
  },
  figma: {
    integrationType: 'figma',
    serverName: 'figma',
    url: 'https://mcp.figma.com/mcp',
    transport: 'streamable_http',
    authStrategy: 'first_party_oauth_direct',
    brokered: true,
    directConnect: false,
    docsUrl: 'https://help.figma.com/hc/en-us/articles/32132100833559-Guide-to-the-Figma-MCP-server',
    notes:
      'Official Figma MCP server. camelAI brokers this first-party MCP server using connected credentials where available.',
  },
  jira: {
    integrationType: 'jira',
    serverName: 'atlassian',
    url: 'https://mcp.atlassian.com/v1/mcp/authv2',
    transport: 'streamable_http',
    authStrategy: 'first_party_oauth_direct',
    brokered: true,
    directConnect: false,
    docsUrl: 'https://support.atlassian.com/atlassian-rovo-mcp-server/docs/getting-started-with-the-atlassian-remote-mcp-server/',
    notes:
      'Official Atlassian Rovo MCP server for Jira and other Atlassian products. camelAI brokers this first-party MCP server using connected credentials where available.',
  },
  slack: {
    integrationType: 'slack',
    serverName: 'slack',
    url: 'https://mcp.slack.com/mcp',
    transport: 'streamable_http',
    authStrategy: 'first_party_oauth_direct',
    brokered: true,
    directConnect: false,
    docsUrl: 'https://slack.com/help/articles/48855576908307-Guide-to-the-Slack-MCP-server',
    notes:
      'Official Slack MCP server. Access may depend on Slack MCP client availability; camelAI keeps the existing Slack OAuth integration for bot workflows.',
  },
  vercel: {
    integrationType: 'vercel',
    serverName: 'vercel',
    url: 'https://mcp.vercel.com',
    transport: 'streamable_http',
    authStrategy: 'first_party_oauth_direct',
    brokered: true,
    directConnect: false,
    docsUrl: 'https://vercel.com/docs/agent-resources/vercel-mcp',
    notes:
      'Official Vercel MCP server. camelAI brokers this first-party MCP server using connected credentials where available.',
  },
  cloudflare: {
    integrationType: 'cloudflare',
    serverName: 'cloudflare',
    url: 'https://mcp.cloudflare.com/mcp',
    transport: 'streamable_http',
    authStrategy: 'first_party_oauth_direct',
    brokered: true,
    directConnect: false,
    docsUrl: 'https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/',
    notes:
      'Official Cloudflare MCP server. camelAI brokers this first-party MCP server using connected credentials where available.',
  },
};

export function getProviderMcpDefinition(integrationType: string): ProviderMcpDefinition | null {
  return PROVIDER_MCP_REGISTRY[integrationType] ?? null;
}

export function hasBrokeredProviderMcp(integrationType: string): boolean {
  return Boolean(PROVIDER_MCP_REGISTRY[integrationType]?.brokered);
}
