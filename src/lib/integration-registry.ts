import type { IntegrationCategory, IntegrationAuthMethod } from '@/types';

/**
 * Dynamic field definition for custom "other" integrations.
 * Allows AI agents to define custom credential fields at runtime.
 */
export interface DynamicField {
  name: string;           // Field name for env var suffix (e.g., "api_key" -> "_API_KEY")
  label: string;          // Display label shown in UI
  type: 'password' | 'text' | 'url' | 'number';
  required: boolean;
  placeholder?: string;
  description?: string;   // Help text displayed below input
}

/**
 * Dynamic integration schema for custom "other" integrations.
 * Passed from MCP tool to UI to render custom form fields.
 */
export interface DynamicIntegrationSchema {
  displayName: string;
  description?: string;
  instructions?: string;  // Setup instructions shown above form
  fields: DynamicField[];
}

export interface ConfigField {
  name: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'select';
  required: boolean;
  default?: unknown;
  options?: { value: string; label: string }[];
  placeholder?: string;
  description?: string;
}

export interface CredentialField {
  name: string;
  label: string;
  type: 'password' | 'text' | 'textarea';
  required: boolean;
  placeholder?: string;
  description?: string;
}

export interface OAuthConfig {
  authorizationUrl: string;
  tokenUrl: string;
  scopes: string[];
}

export interface IntegrationDefinition {
  type: string;
  displayName: string;
  description: string;
  category: IntegrationCategory;
  authMethod: IntegrationAuthMethod;
  configSchema: ConfigField[];
  credentialSchema: CredentialField[];
  oauthConfig?: OAuthConfig;
}

export const INTEGRATION_REGISTRY: Record<string, IntegrationDefinition> = {
  // ============================================
  // DATABASE INTEGRATIONS (container execution)
  // ============================================

  postgres: {
    type: 'postgres',
    displayName: 'PostgreSQL',
    description: 'Connect to a PostgreSQL database',
    category: 'databases',
    authMethod: 'api_key',
    configSchema: [
      { name: 'host', label: 'Host', type: 'string', required: true, placeholder: 'localhost' },
      { name: 'port', label: 'Port', type: 'number', required: true, default: 5432 },
      { name: 'database', label: 'Database', type: 'string', required: true },
      { name: 'schema', label: 'Schema', type: 'string', required: false, default: 'public' },
      {
        name: 'ssl_mode',
        label: 'SSL Mode',
        type: 'select',
        required: false,
        default: 'require',
        options: [
          { value: 'disable', label: 'Disable' },
          { value: 'require', label: 'Require' },
          { value: 'verify-ca', label: 'Verify CA' },
          { value: 'verify-full', label: 'Verify Full' },
        ],
      },
    ],
    credentialSchema: [
      { name: 'username', label: 'Username', type: 'text', required: true },
      { name: 'password', label: 'Password', type: 'password', required: true },
    ],
    // Requires container execution.
  },

  mysql: {
    type: 'mysql',
    displayName: 'MySQL',
    description: 'Connect to a MySQL database',
    category: 'databases',
    authMethod: 'api_key',
    configSchema: [
      { name: 'host', label: 'Host', type: 'string', required: true, placeholder: 'localhost' },
      { name: 'port', label: 'Port', type: 'number', required: true, default: 3306 },
      { name: 'database', label: 'Database', type: 'string', required: true },
    ],
    credentialSchema: [
      { name: 'username', label: 'Username', type: 'text', required: true },
      { name: 'password', label: 'Password', type: 'password', required: true },
    ],
    // Requires container execution.
  },

  supabase: {
    type: 'supabase',
    displayName: 'Supabase',
    description: 'Connect to a Supabase project',
    category: 'databases',
    authMethod: 'api_key',
    configSchema: [
      {
        name: 'project_url',
        label: 'Project URL',
        type: 'string',
        required: true,
        placeholder: 'https://your-project.supabase.co',
      },
      {
        name: 'key_type',
        label: 'Key Type',
        type: 'select',
        required: true,
        default: 'anon',
        options: [
          { value: 'anon', label: 'Anon Key (respects RLS)' },
          { value: 'service_role', label: 'Service Role Key (bypasses RLS)' },
        ],
        description:
          'Service role keys bypass Row Level Security and have full access. Prefer anon keys for client-facing apps.',
      },
    ],
    credentialSchema: [
      { name: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'eyJ...' },
    ],
  },

  databricks: {
    type: 'databricks',
    displayName: 'Databricks',
    description: 'Connect to a Databricks workspace',
    category: 'databases',
    authMethod: 'api_key',
    configSchema: [
      {
        name: 'workspace_url',
        label: 'Workspace URL',
        type: 'string',
        required: true,
        placeholder: 'https://dbc-abc123.cloud.databricks.com',
      },
    ],
    credentialSchema: [
      {
        name: 'api_key',
        label: 'Personal Access Token',
        type: 'password',
        required: true,
        placeholder: 'dapi...',
      },
    ],
  },

  // ============================================
  // API KEY / OAUTH INTEGRATIONS (env vars only)
  // ============================================

  stripe: {
    type: 'stripe',
    displayName: 'Stripe',
    description: 'Accept payments with Stripe',
    category: 'saas',
    authMethod: 'api_key',
    configSchema: [],
    credentialSchema: [
      { name: 'api_key', label: 'Secret Key', type: 'password', required: true, placeholder: 'sk_...' },
    ],
  },

  notion: {
    type: 'notion',
    displayName: 'Notion',
    description: 'Connect to Notion workspaces and databases',
    category: 'saas',
    authMethod: 'oauth2',
    configSchema: [],
    credentialSchema: [],
    oauthConfig: {
      authorizationUrl: 'https://api.notion.com/v1/oauth/authorize',
      tokenUrl: 'https://api.notion.com/v1/oauth/token',
      scopes: [], // Notion doesn't use traditional scopes - capabilities are set in integration settings
    },
  },

  slack: {
    type: 'slack',
    displayName: 'Slack',
    description: 'Send messages and notifications to Slack',
    category: 'communication',
    authMethod: 'oauth2',
    configSchema: [],
    credentialSchema: [],
    oauthConfig: {
      authorizationUrl: 'https://slack.com/oauth/v2/authorize',
      tokenUrl: 'https://slack.com/api/oauth.v2.access',
      scopes: [
        // Messaging
        'chat:write',
        'chat:write.public',
        'chat:write.customize',
        'im:write',
        'im:read',
        'im:history',
        'mpim:write',
        'mpim:read',
        'mpim:history',
        // Channels
        'channels:read',
        'channels:history',
        'channels:join',
        'channels:manage',
        'groups:read',
        'groups:history',
        'groups:write',
        // Users & Team
        'users:read',
        'users:read.email',
        'users.profile:read',
        'team:read',
        // Files
        'files:read',
        'files:write',
        // Reactions & Pins
        'reactions:read',
        'reactions:write',
        'pins:read',
        'pins:write',
        // Bookmarks
        'bookmarks:read',
        'bookmarks:write',
        // Reminders
        'reminders:read',
        'reminders:write',
        // User Groups
        'usergroups:read',
        'usergroups:write',
        // Calls
        'calls:read',
        'calls:write',
        // Canvas
        'canvases:read',
        'canvases:write',
        // App management
        'commands',
        'app_mentions:read',
        // Metadata & Links
        'metadata.message:read',
        'links:read',
        'links:write',
        // DND
        'dnd:read',
      ],
    },
  },

  openai: {
    type: 'openai',
    displayName: 'OpenAI',
    description: 'Access OpenAI GPT models',
    category: 'ai_services',
    authMethod: 'api_key',
    configSchema: [
      { name: 'organization_id', label: 'Organization ID', type: 'string', required: false },
    ],
    credentialSchema: [
      { name: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'sk-...' },
    ],
  },

  anthropic: {
    type: 'anthropic',
    displayName: 'Anthropic',
    description: 'Access Claude AI models',
    category: 'ai_services',
    authMethod: 'api_key',
    configSchema: [],
    credentialSchema: [
      { name: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'sk-ant-...' },
    ],
  },

  openrouter: {
    type: 'openrouter',
    displayName: 'OpenRouter',
    description: 'Access LLMs via OpenRouter',
    category: 'ai_services',
    authMethod: 'api_key',
    configSchema: [],
    credentialSchema: [
      { name: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'sk-or-...' },
    ],
  },

  github: {
    type: 'github',
    displayName: 'GitHub',
    description: 'Access GitHub repositories and APIs',
    category: 'saas',
    authMethod: 'api_key',
    configSchema: [],
    credentialSchema: [
      {
        name: 'api_key',
        label: 'Personal Access Token',
        type: 'password',
        required: true,
        placeholder: 'ghp_... or github_pat_...',
        description: 'Create at github.com/settings/tokens (classic or fine-grained)',
      },
    ],
  },

  linear: {
    type: 'linear',
    displayName: 'Linear',
    description: 'Project management and issue tracking',
    category: 'saas',
    authMethod: 'api_key',
    configSchema: [],
    credentialSchema: [
      {
        name: 'api_key',
        label: 'API Key',
        type: 'password',
        required: true,
        placeholder: 'lin_api_...',
        description: 'Create at linear.app/settings/api',
      },
    ],
  },

  sentry: {
    type: 'sentry',
    displayName: 'Sentry',
    description: 'Error monitoring with Sentry',
    category: 'saas',
    authMethod: 'api_key',
    configSchema: [
      { name: 'organization', label: 'Organization Slug', type: 'string', required: false, placeholder: 'my-org' },
    ],
    credentialSchema: [
      {
        name: 'api_key',
        label: 'Auth Token',
        type: 'password',
        required: true,
        placeholder: 'sntrys_...',
        description:
          'Create an Organization Auth Token at Settings > Auth Tokens. Recommended scopes: project:read, org:read, event:read.',
      },
    ],
  },

  mailchimp: {
    type: 'mailchimp',
    displayName: 'Mailchimp',
    description: 'Email marketing with Mailchimp',
    category: 'saas',
    authMethod: 'api_key',
    configSchema: [
      {
        name: 'data_center',
        label: 'Data Center',
        type: 'string',
        required: true,
        placeholder: 'us21',
        description: 'The suffix after the dash in your API key (e.g., us21 from key-us21)',
      },
    ],
    credentialSchema: [
      {
        name: 'api_key',
        label: 'API Key',
        type: 'password',
        required: true,
        placeholder: 'xxxxxxxx-us21',
        description: 'Create at mailchimp.com/account/api',
      },
    ],
  },

  posthog: {
    type: 'posthog',
    displayName: 'PostHog',
    description: 'Product analytics with PostHog',
    category: 'saas',
    authMethod: 'api_key',
    configSchema: [
      {
        name: 'host',
        label: 'Host URL',
        type: 'string',
        required: true,
        placeholder: 'https://us.posthog.com',
        description:
          'US Cloud: https://us.posthog.com | EU Cloud: https://eu.posthog.com | Self-hosted: your instance URL',
      },
      { name: 'project_id', label: 'Project ID', type: 'string', required: false, placeholder: '12345' },
    ],
    credentialSchema: [
      { name: 'api_key', label: 'Personal API Key', type: 'password', required: true, placeholder: 'phx_...' },
    ],
  },

  mixpanel: {
    type: 'mixpanel',
    displayName: 'Mixpanel',
    description: 'Product analytics with Mixpanel',
    category: 'saas',
    authMethod: 'api_key',
    configSchema: [
      { name: 'project_id', label: 'Project ID', type: 'string', required: true, placeholder: '1234567' },
      {
        name: 'region',
        label: 'Region',
        type: 'select',
        required: true,
        default: 'us',
        options: [
          { value: 'us', label: 'US (mixpanel.com)' },
          { value: 'eu', label: 'EU (eu.mixpanel.com)' },
        ],
      },
    ],
    credentialSchema: [
      { name: 'api_key', label: 'Service Account Username', type: 'text', required: true },
      {
        name: 'api_secret',
        label: 'Service Account Secret',
        type: 'password',
        required: true,
        description:
          'Create a Service Account in Organization Settings > Service Accounts. The secret is shown only once at creation time.',
      },
    ],
  },

  typeform: {
    type: 'typeform',
    displayName: 'Typeform',
    description: 'Forms and surveys with Typeform',
    category: 'saas',
    authMethod: 'api_key',
    configSchema: [],
    credentialSchema: [
      {
        name: 'api_key',
        label: 'Personal Access Token',
        type: 'password',
        required: true,
        placeholder: 'tfp_...',
        description: 'Create at typeform.com/developers/get-started/personal-access-token',
      },
    ],
  },

  sendgrid: {
    type: 'sendgrid',
    displayName: 'SendGrid',
    description: 'Send transactional emails',
    category: 'communication',
    authMethod: 'api_key',
    configSchema: [],
    credentialSchema: [
      { name: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'SG...' },
    ],
  },

  twilio: {
    type: 'twilio',
    displayName: 'Twilio',
    description: 'Send SMS and make calls',
    category: 'communication',
    authMethod: 'api_key',
    configSchema: [],
    credentialSchema: [
      { name: 'account_sid', label: 'Account SID', type: 'text', required: true },
      { name: 'auth_token', label: 'Auth Token', type: 'password', required: true },
    ],
  },

  salesforce: {
    type: 'salesforce',
    displayName: 'Salesforce',
    description: 'Connect to Salesforce CRM',
    category: 'saas',
    authMethod: 'oauth2',
    configSchema: [
      { name: 'instance_url', label: 'Instance URL', type: 'string', required: true, placeholder: 'https://yourorg.salesforce.com' },
    ],
    credentialSchema: [],
    oauthConfig: {
      authorizationUrl: 'https://login.salesforce.com/services/oauth2/authorize',
      tokenUrl: 'https://login.salesforce.com/services/oauth2/token',
      scopes: ['api', 'refresh_token'],
    },
  },

  airtable: {
    type: 'airtable',
    displayName: 'Airtable',
    description: 'Access Airtable bases and records',
    category: 'saas',
    authMethod: 'api_key',
    configSchema: [],
    credentialSchema: [
      {
        name: 'api_key',
        label: 'Personal Access Token',
        type: 'password',
        required: true,
        placeholder: 'pat...',
        description: 'Create at airtable.com/create/tokens',
      },
    ],
  },

  hubspot: {
    type: 'hubspot',
    displayName: 'HubSpot',
    description: 'CRM and marketing automation',
    category: 'saas',
    authMethod: 'api_key',
    configSchema: [],
    credentialSchema: [
      {
        name: 'api_key',
        label: 'Private App Access Token',
        type: 'password',
        required: true,
        placeholder: 'pat-...',
        description: 'Create a private app at app.hubspot.com/private-apps',
      },
    ],
  },

  // ============================================
  // SPECIAL HANDLING REQUIRED
  // ============================================

  aws: {
    type: 'aws',
    displayName: 'Amazon Web Services',
    description: 'Connect to AWS services (requires SigV4 signing)',
    category: 'cloud_providers',
    authMethod: 'api_key',
    configSchema: [
      {
        name: 'region',
        label: 'Region',
        type: 'select',
        required: true,
        options: [
          { value: 'us-east-1', label: 'US East (N. Virginia)' },
          { value: 'us-east-2', label: 'US East (Ohio)' },
          { value: 'us-west-1', label: 'US West (N. California)' },
          { value: 'us-west-2', label: 'US West (Oregon)' },
          { value: 'eu-west-1', label: 'EU (Ireland)' },
          { value: 'eu-west-2', label: 'EU (London)' },
          { value: 'eu-central-1', label: 'EU (Frankfurt)' },
          { value: 'ap-northeast-1', label: 'Asia Pacific (Tokyo)' },
          { value: 'ap-southeast-1', label: 'Asia Pacific (Singapore)' },
        ],
      },
      { name: 'role_arn', label: 'IAM Role ARN', type: 'string', required: false },
    ],
    credentialSchema: [
      { name: 'access_key_id', label: 'Access Key ID', type: 'text', required: true },
      { name: 'secret_access_key', label: 'Secret Access Key', type: 'password', required: true },
    ],
    // Requires SigV4 signing (special handler).
  },

  bigquery: {
    type: 'bigquery',
    displayName: 'Google BigQuery',
    description: 'Query data in Google BigQuery',
    category: 'databases',
    authMethod: 'api_key',
    configSchema: [
      { name: 'project_id', label: 'Project ID', type: 'string', required: true },
      { name: 'dataset', label: 'Default Dataset', type: 'string', required: false },
    ],
    credentialSchema: [
      { name: 'service_account_json', label: 'Service Account JSON', type: 'password', required: true },
    ],
    // Requires Google auth.
  },

  neon: {
    type: 'neon',
    displayName: 'Neon',
    description: 'Serverless Postgres with branching',
    category: 'databases',
    authMethod: 'api_key',
    configSchema: [
      {
        name: 'project_id',
        label: 'Project ID',
        type: 'string',
        required: false,
        placeholder: 'project-abc123',
        description: 'Found in your Neon project dashboard',
      },
    ],
    credentialSchema: [
      {
        name: 'api_key',
        label: 'API Key',
        type: 'password',
        required: true,
        placeholder: 'neon_...',
        description: 'Create at Account Settings > API Keys',
      },
      {
        name: 'connection_string',
        label: 'Connection String',
        type: 'password',
        required: false,
        placeholder: 'postgresql://user:pass@ep-xxx.us-east-2.aws.neon.tech/neondb',
        description: 'Direct database connection string (optional)',
      },
    ],
  },

  snowflake: {
    type: 'snowflake',
    displayName: 'Snowflake',
    description: 'Cloud data warehouse',
    category: 'databases',
    authMethod: 'api_key',
    configSchema: [
      {
        name: 'account',
        label: 'Account Identifier',
        type: 'string',
        required: true,
        placeholder: 'xy12345.us-east-1',
        description: 'Your Snowflake account identifier (e.g., xy12345.us-east-1)',
      },
      { name: 'warehouse', label: 'Warehouse', type: 'string', required: false, placeholder: 'COMPUTE_WH' },
      { name: 'database', label: 'Database', type: 'string', required: false },
      { name: 'schema', label: 'Schema', type: 'string', required: false, default: 'PUBLIC' },
    ],
    credentialSchema: [
      { name: 'username', label: 'Username', type: 'text', required: true },
      {
        name: 'private_key',
        label: 'Private Key (PEM)',
        type: 'textarea',
        required: true,
        placeholder: '-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----',
        description: 'RSA private key in PEM format for key pair authentication',
      },
      {
        name: 'private_key_passphrase',
        label: 'Private Key Passphrase',
        type: 'password',
        required: false,
        description: 'Passphrase if your private key is encrypted (optional)',
      },
    ],
  },

  clickhouse: {
    type: 'clickhouse',
    displayName: 'ClickHouse',
    description: 'Fast analytics database',
    category: 'databases',
    authMethod: 'api_key',
    configSchema: [
      {
        name: 'host',
        label: 'Host',
        type: 'string',
        required: true,
        placeholder: 'abc123.clickhouse.cloud',
        description: 'ClickHouse Cloud host or self-hosted URL',
      },
      { name: 'port', label: 'Port', type: 'number', required: false, default: 8443 },
      { name: 'database', label: 'Database', type: 'string', required: false, default: 'default' },
    ],
    credentialSchema: [
      { name: 'username', label: 'Username', type: 'text', required: true, placeholder: 'default' },
      { name: 'password', label: 'Password', type: 'password', required: true },
    ],
  },

  planetscale: {
    type: 'planetscale',
    displayName: 'PlanetScale',
    description: 'Serverless MySQL platform',
    category: 'databases',
    authMethod: 'api_key',
    configSchema: [
      {
        name: 'organization',
        label: 'Organization',
        type: 'string',
        required: false,
        placeholder: 'my-org',
      },
      {
        name: 'database',
        label: 'Database',
        type: 'string',
        required: false,
        placeholder: 'my-database',
      },
    ],
    credentialSchema: [
      {
        name: 'api_key',
        label: 'Service Token ID',
        type: 'text',
        required: true,
        placeholder: 'pscale_tkn_...',
        description: 'Create at Organization Settings > Service Tokens',
      },
      {
        name: 'api_secret',
        label: 'Service Token Secret',
        type: 'password',
        required: true,
      },
      {
        name: 'connection_string',
        label: 'Connection String',
        type: 'password',
        required: false,
        placeholder: 'mysql://user:pass@aws.connect.psdb.cloud/db?sslaccept=strict',
        description: 'Direct database connection string (optional)',
      },
    ],
  },

  turso: {
    type: 'turso',
    displayName: 'Turso',
    description: 'Edge SQLite database',
    category: 'databases',
    authMethod: 'api_key',
    configSchema: [
      {
        name: 'database_url',
        label: 'Database URL',
        type: 'string',
        required: true,
        placeholder: 'libsql://db-org.turso.io',
        description: 'Your Turso database URL',
      },
    ],
    credentialSchema: [
      {
        name: 'api_key',
        label: 'Auth Token',
        type: 'password',
        required: true,
        description: 'Create with: turso db tokens create <db-name>',
      },
    ],
  },

  mongodb: {
    type: 'mongodb',
    displayName: 'MongoDB',
    description: 'Document database',
    category: 'databases',
    authMethod: 'api_key',
    configSchema: [
      {
        name: 'cluster_url',
        label: 'Cluster URL',
        type: 'string',
        required: false,
        placeholder: 'cluster0.abc123.mongodb.net',
        description: 'MongoDB Atlas cluster URL (without protocol)',
      },
      { name: 'database', label: 'Database', type: 'string', required: false },
    ],
    credentialSchema: [
      {
        name: 'connection_string',
        label: 'Connection String',
        type: 'password',
        required: true,
        placeholder: 'mongodb+srv://user:pass@cluster0.abc123.mongodb.net/mydb',
        description: 'Full MongoDB connection string',
      },
    ],
  },

  redis: {
    type: 'redis',
    displayName: 'Redis',
    description: 'In-memory data store',
    category: 'databases',
    authMethod: 'api_key',
    configSchema: [
      {
        name: 'host',
        label: 'Host',
        type: 'string',
        required: false,
        placeholder: 'redis-12345.c1.us-east-1-2.ec2.cloud.redislabs.com',
      },
      { name: 'port', label: 'Port', type: 'number', required: false, default: 6379 },
      { name: 'database', label: 'Database Number', type: 'number', required: false, default: 0 },
    ],
    credentialSchema: [
      {
        name: 'connection_string',
        label: 'Connection String',
        type: 'password',
        required: true,
        placeholder: 'redis://user:pass@host:6379/0',
        description: 'Redis connection URL (redis:// or rediss:// for TLS)',
      },
    ],
  },

  // ============================================
  // ADDITIONAL SAAS INTEGRATIONS
  // ============================================

  jira: {
    type: 'jira',
    displayName: 'Jira',
    description: 'Issue tracking and project management',
    category: 'saas',
    authMethod: 'api_key',
    configSchema: [
      {
        name: 'domain',
        label: 'Atlassian Domain',
        type: 'string',
        required: true,
        placeholder: 'your-company.atlassian.net',
        description: 'Your Atlassian cloud domain',
      },
    ],
    credentialSchema: [
      {
        name: 'email',
        label: 'Email',
        type: 'text',
        required: true,
        description: 'Email address for your Atlassian account',
      },
      {
        name: 'api_key',
        label: 'API Token',
        type: 'password',
        required: true,
        description: 'Create at id.atlassian.com/manage-profile/security/api-tokens',
      },
    ],
  },

  asana: {
    type: 'asana',
    displayName: 'Asana',
    description: 'Project and task management',
    category: 'saas',
    authMethod: 'api_key',
    configSchema: [],
    credentialSchema: [
      {
        name: 'api_key',
        label: 'Personal Access Token',
        type: 'password',
        required: true,
        description: 'Create at app.asana.com/0/my-apps',
      },
    ],
  },

  figma: {
    type: 'figma',
    displayName: 'Figma',
    description: 'Design files and collaboration',
    category: 'saas',
    authMethod: 'api_key',
    configSchema: [],
    credentialSchema: [
      {
        name: 'api_key',
        label: 'Personal Access Token',
        type: 'password',
        required: true,
        description: 'Create at figma.com/developers/api#access-tokens',
      },
    ],
  },

  intercom: {
    type: 'intercom',
    displayName: 'Intercom',
    description: 'Customer messaging platform',
    category: 'saas',
    authMethod: 'api_key',
    configSchema: [],
    credentialSchema: [
      {
        name: 'api_key',
        label: 'Access Token',
        type: 'password',
        required: true,
        description: 'Create in Developer Hub > Your App > Authentication',
      },
    ],
  },

  zendesk: {
    type: 'zendesk',
    displayName: 'Zendesk',
    description: 'Customer support platform',
    category: 'saas',
    authMethod: 'api_key',
    configSchema: [
      {
        name: 'subdomain',
        label: 'Subdomain',
        type: 'string',
        required: true,
        placeholder: 'your-company',
        description: 'Your Zendesk subdomain (from your-company.zendesk.com)',
      },
    ],
    credentialSchema: [
      {
        name: 'email',
        label: 'Email',
        type: 'text',
        required: true,
        description: 'Email address for your Zendesk account',
      },
      {
        name: 'api_key',
        label: 'API Token',
        type: 'password',
        required: true,
        description: 'Create at Admin Center > Apps and integrations > Zendesk API',
      },
    ],
  },

  segment: {
    type: 'segment',
    displayName: 'Segment',
    description: 'Customer data platform',
    category: 'saas',
    authMethod: 'api_key',
    configSchema: [],
    credentialSchema: [
      {
        name: 'api_key',
        label: 'Write Key',
        type: 'password',
        required: true,
        description: 'Source write key from Segment dashboard',
      },
    ],
  },

  amplitude: {
    type: 'amplitude',
    displayName: 'Amplitude',
    description: 'Product analytics platform',
    category: 'saas',
    authMethod: 'api_key',
    configSchema: [
      {
        name: 'region',
        label: 'Region',
        type: 'select',
        required: true,
        default: 'us',
        options: [
          { value: 'us', label: 'US (amplitude.com)' },
          { value: 'eu', label: 'EU (eu.amplitude.com)' },
        ],
      },
    ],
    credentialSchema: [
      {
        name: 'api_key',
        label: 'API Key',
        type: 'password',
        required: true,
        description: 'Project API key from Settings > Projects',
      },
      {
        name: 'api_secret',
        label: 'Secret Key',
        type: 'password',
        required: true,
        description: 'Project secret key for server-side API access',
      },
    ],
  },

  // ============================================
  // ADDITIONAL COMMUNICATION INTEGRATIONS
  // ============================================

  discord: {
    type: 'discord',
    displayName: 'Discord',
    description: 'Discord bot and webhook integration',
    category: 'communication',
    authMethod: 'api_key',
    configSchema: [
      {
        name: 'application_id',
        label: 'Application ID',
        type: 'string',
        required: false,
        description: 'Discord application ID (optional, for bot commands)',
      },
    ],
    credentialSchema: [
      {
        name: 'api_key',
        label: 'Bot Token',
        type: 'password',
        required: true,
        description: 'Bot token from discord.com/developers/applications',
      },
    ],
  },

  teams: {
    type: 'teams',
    displayName: 'Microsoft Teams',
    description: 'Microsoft Teams messaging',
    category: 'communication',
    authMethod: 'api_key',
    configSchema: [
      {
        name: 'tenant_id',
        label: 'Tenant ID',
        type: 'string',
        required: true,
        description: 'Azure AD tenant ID',
      },
    ],
    credentialSchema: [
      {
        name: 'client_id',
        label: 'Client ID',
        type: 'text',
        required: true,
        description: 'Azure AD app registration client ID',
      },
      {
        name: 'client_secret',
        label: 'Client Secret',
        type: 'password',
        required: true,
        description: 'Azure AD app registration client secret',
      },
    ],
  },

  // ============================================
  // ADDITIONAL CLOUD PROVIDER INTEGRATIONS
  // ============================================

  gcp: {
    type: 'gcp',
    displayName: 'Google Cloud Platform',
    description: 'Connect to GCP services',
    category: 'cloud_providers',
    authMethod: 'api_key',
    configSchema: [
      {
        name: 'project_id',
        label: 'Project ID',
        type: 'string',
        required: true,
        placeholder: 'my-project-123',
      },
    ],
    credentialSchema: [
      {
        name: 'service_account_json',
        label: 'Service Account JSON',
        type: 'password',
        required: true,
        description: 'Full JSON contents of your service account key file',
      },
    ],
  },

  azure: {
    type: 'azure',
    displayName: 'Microsoft Azure',
    description: 'Connect to Azure services',
    category: 'cloud_providers',
    authMethod: 'api_key',
    configSchema: [
      {
        name: 'tenant_id',
        label: 'Tenant ID',
        type: 'string',
        required: true,
        description: 'Azure AD tenant ID',
      },
      {
        name: 'subscription_id',
        label: 'Subscription ID',
        type: 'string',
        required: false,
        description: 'Azure subscription ID (optional)',
      },
    ],
    credentialSchema: [
      {
        name: 'client_id',
        label: 'Client ID',
        type: 'text',
        required: true,
        description: 'Azure AD app registration client ID',
      },
      {
        name: 'client_secret',
        label: 'Client Secret',
        type: 'password',
        required: true,
        description: 'Azure AD app registration client secret',
      },
    ],
  },

  vercel: {
    type: 'vercel',
    displayName: 'Vercel',
    description: 'Vercel deployment platform',
    category: 'cloud_providers',
    authMethod: 'api_key',
    configSchema: [
      {
        name: 'team_id',
        label: 'Team ID',
        type: 'string',
        required: false,
        placeholder: 'team_xxx',
        description: 'Vercel team ID (leave empty for personal account)',
      },
    ],
    credentialSchema: [
      {
        name: 'api_key',
        label: 'Access Token',
        type: 'password',
        required: true,
        description: 'Create at vercel.com/account/tokens',
      },
    ],
  },

  netlify: {
    type: 'netlify',
    displayName: 'Netlify',
    description: 'Netlify deployment platform',
    category: 'cloud_providers',
    authMethod: 'api_key',
    configSchema: [],
    credentialSchema: [
      {
        name: 'api_key',
        label: 'Personal Access Token',
        type: 'password',
        required: true,
        description: 'Create at app.netlify.com/user/applications#personal-access-tokens',
      },
    ],
  },

  cloudflare: {
    type: 'cloudflare',
    displayName: 'Cloudflare',
    description: 'Cloudflare API access',
    category: 'cloud_providers',
    authMethod: 'api_key',
    configSchema: [
      {
        name: 'account_id',
        label: 'Account ID',
        type: 'string',
        required: false,
        description: 'Cloudflare account ID (found in dashboard URL)',
      },
    ],
    credentialSchema: [
      {
        name: 'api_key',
        label: 'API Token',
        type: 'password',
        required: true,
        description: 'Create at dash.cloudflare.com/profile/api-tokens',
      },
    ],
  },

  // ============================================
  // PAYMENTS / COMMERCE INTEGRATIONS
  // ============================================

  shopify: {
    type: 'shopify',
    displayName: 'Shopify',
    description: 'E-commerce platform',
    category: 'saas',
    authMethod: 'api_key',
    configSchema: [
      {
        name: 'shop_domain',
        label: 'Shop Domain',
        type: 'string',
        required: true,
        placeholder: 'your-store.myshopify.com',
        description: 'Your Shopify store domain',
      },
    ],
    credentialSchema: [
      {
        name: 'api_key',
        label: 'Admin API Access Token',
        type: 'password',
        required: true,
        description: 'Create a custom app at Settings > Apps and sales channels > Develop apps',
      },
    ],
  },

  square: {
    type: 'square',
    displayName: 'Square',
    description: 'Payments and commerce',
    category: 'saas',
    authMethod: 'api_key',
    configSchema: [
      {
        name: 'environment',
        label: 'Environment',
        type: 'select',
        required: true,
        default: 'production',
        options: [
          { value: 'sandbox', label: 'Sandbox' },
          { value: 'production', label: 'Production' },
        ],
      },
    ],
    credentialSchema: [
      {
        name: 'api_key',
        label: 'Access Token',
        type: 'password',
        required: true,
        description: 'Create at developer.squareup.com/apps',
      },
    ],
  },

  // ============================================
  // GENERIC / CUSTOM INTEGRATION
  // ============================================

  other: {
    type: 'other',
    displayName: 'Other',
    description: 'Connect to any HTTP API with custom authentication',
    category: 'saas',
    authMethod: 'api_key',
    configSchema: [
      { name: 'display_name', label: 'Display Name', type: 'string', required: true, placeholder: 'My Custom API' },
      { name: 'description', label: 'Description', type: 'string', required: false, placeholder: 'What this integration does' },
      { name: 'base_url', label: 'Base URL', type: 'string', required: false, placeholder: 'https://api.example.com' },
      {
        name: 'auth_type',
        label: 'Authentication Type',
        type: 'select',
        required: false,
        default: 'bearer',
        options: [
          { value: 'none', label: 'None' },
          { value: 'bearer', label: 'Bearer Token' },
          { value: 'basic', label: 'Basic Auth' },
          { value: 'header', label: 'Custom Header' },
        ],
      },
      { name: 'auth_header', label: 'Custom Auth Header Name', type: 'string', required: false, placeholder: 'X-API-Key' },
    ],
    credentialSchema: [
      { name: 'api_key', label: 'API Key / Token', type: 'password', required: false },
      { name: 'api_secret', label: 'API Secret / Password', type: 'password', required: false },
      { name: 'client_id', label: 'Client ID', type: 'text', required: false },
      { name: 'client_secret', label: 'Client Secret', type: 'password', required: false },
    ],
    // Exposes config/credential fields for custom API connections.
  },
};

export function getIntegrationDefinition(type: string): IntegrationDefinition | undefined {
  return INTEGRATION_REGISTRY[type];
}

export function getIntegrationsByCategory(category: IntegrationCategory): IntegrationDefinition[] {
  return Object.values(INTEGRATION_REGISTRY).filter((def) => def.category === category);
}

export function getAllCategories(): IntegrationCategory[] {
  const categories = new Set(Object.values(INTEGRATION_REGISTRY).map((def) => def.category));
  return [...categories];
}

export function getAllIntegrations(): IntegrationDefinition[] {
  return Object.values(INTEGRATION_REGISTRY);
}

export function validateConfig(type: string, config: Record<string, unknown>): string[] {
  const definition = INTEGRATION_REGISTRY[type];
  if (!definition) {
    return [`Unknown integration type: ${type}`];
  }

  const errors: string[] = [];
  for (const field of definition.configSchema) {
    const value = config[field.name];
    if (field.required && (value === undefined || value === null || value === '')) {
      errors.push(`${field.label} is required`);
    }
  }
  return errors;
}

export function validateCredentials(type: string, credentials: Record<string, unknown>): string[] {
  const definition = INTEGRATION_REGISTRY[type];
  if (!definition) {
    return [`Unknown integration type: ${type}`];
  }

  const errors: string[] = [];
  for (const field of definition.credentialSchema) {
    const value = credentials[field.name];
    if (field.required && (value === undefined || value === null || value === '')) {
      errors.push(`${field.label} is required`);
    }
  }
  return errors;
}
