import type { IntegrationCategory, IntegrationAuthMethod } from '@/types';

export interface ConfigField {
  name: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'select';
  required: boolean;
  default?: unknown;
  options?: { value: string; label: string }[];
  placeholder?: string;
}

export interface CredentialField {
  name: string;
  label: string;
  type: 'password' | 'text';
  required: boolean;
  placeholder?: string;
}

export interface OAuthConfig {
  authorizationUrl: string;
  tokenUrl: string;
  scopes: string[];
}

/**
 * Proxy configuration for HTTP passthrough integrations
 */
export interface ProxyConfig {
  /** Base URL for the API */
  baseUrl: string;

  /**
   * How to format the auth header:
   * - 'bearer': Authorization: Bearer {api_key}
   * - 'basic': Authorization: Basic base64({api_key}:{api_secret})
   * - 'header': {authHeader}: {api_key}
   * - 'query': Append api_key as query param (not recommended)
   */
  authType: 'bearer' | 'basic' | 'header' | 'query';

  /** Custom auth header name (for authType: 'header') */
  authHeader?: string;

  /** Default headers to include with every request */
  defaultHeaders?: Record<string, string>;

  /**
   * Header to set from config field (e.g., { 'Stripe-Version': 'api_version' })
   * Maps header name -> config field name
   */
  configHeaders?: Record<string, string>;
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

  /**
   * Proxy config for HTTP passthrough.
   * If undefined, integration requires special handling (e.g., databases)
   */
  proxyConfig?: ProxyConfig;
}

export const INTEGRATION_REGISTRY: Record<string, IntegrationDefinition> = {
  // ============================================
  // DATABASE INTEGRATIONS (no proxy - need container)
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
    // No proxyConfig - requires container execution
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
    // No proxyConfig - requires container execution
  },

  // ============================================
  // HTTP PASSTHROUGH INTEGRATIONS
  // ============================================

  stripe: {
    type: 'stripe',
    displayName: 'Stripe',
    description: 'Accept payments with Stripe',
    category: 'saas',
    authMethod: 'api_key',
    configSchema: [
      {
        name: 'api_version',
        label: 'API Version',
        type: 'string',
        required: false,
        default: '2024-12-18.acacia',
        placeholder: '2024-12-18.acacia',
      },
    ],
    credentialSchema: [
      { name: 'api_key', label: 'Secret Key', type: 'password', required: true, placeholder: 'sk_...' },
    ],
    proxyConfig: {
      baseUrl: 'https://api.stripe.com',
      authType: 'bearer',
      configHeaders: {
        'Stripe-Version': 'api_version',
      },
    },
  },

  notion: {
    type: 'notion',
    displayName: 'Notion',
    description: 'Connect to Notion workspaces',
    category: 'saas',
    authMethod: 'api_key',
    configSchema: [],
    credentialSchema: [
      { name: 'api_key', label: 'Integration Token', type: 'password', required: true, placeholder: 'secret_...' },
    ],
    proxyConfig: {
      baseUrl: 'https://api.notion.com',
      authType: 'bearer',
      defaultHeaders: {
        'Notion-Version': '2022-06-28',
      },
    },
  },

  slack: {
    type: 'slack',
    displayName: 'Slack',
    description: 'Send messages and notifications to Slack',
    category: 'communication',
    authMethod: 'oauth2',
    configSchema: [
      { name: 'team_id', label: 'Team ID', type: 'string', required: false },
      { name: 'default_channel', label: 'Default Channel', type: 'string', required: false },
    ],
    credentialSchema: [],
    oauthConfig: {
      authorizationUrl: 'https://slack.com/oauth/v2/authorize',
      tokenUrl: 'https://slack.com/api/oauth.v2.access',
      scopes: ['chat:write', 'channels:read'],
    },
    proxyConfig: {
      baseUrl: 'https://slack.com/api',
      authType: 'bearer',
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
      { name: 'default_model', label: 'Default Model', type: 'string', required: false, default: 'gpt-4' },
    ],
    credentialSchema: [
      { name: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'sk-...' },
    ],
    proxyConfig: {
      baseUrl: 'https://api.openai.com',
      authType: 'bearer',
      configHeaders: {
        'OpenAI-Organization': 'organization_id',
      },
    },
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
    proxyConfig: {
      baseUrl: 'https://api.anthropic.com',
      authType: 'header',
      authHeader: 'x-api-key',
      defaultHeaders: {
        'anthropic-version': '2023-06-01',
      },
    },
  },

  github: {
    type: 'github',
    displayName: 'GitHub',
    description: 'Access GitHub repositories and APIs',
    category: 'saas',
    authMethod: 'api_key',
    configSchema: [],
    credentialSchema: [
      { name: 'api_key', label: 'Personal Access Token', type: 'password', required: true, placeholder: 'ghp_...' },
    ],
    proxyConfig: {
      baseUrl: 'https://api.github.com',
      authType: 'bearer',
      defaultHeaders: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  },

  linear: {
    type: 'linear',
    displayName: 'Linear',
    description: 'Project management and issue tracking',
    category: 'saas',
    authMethod: 'api_key',
    configSchema: [],
    credentialSchema: [
      { name: 'api_key', label: 'API Key', type: 'password', required: true },
    ],
    proxyConfig: {
      baseUrl: 'https://api.linear.app',
      authType: 'bearer',
    },
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
    proxyConfig: {
      baseUrl: 'https://api.sendgrid.com',
      authType: 'bearer',
    },
  },

  twilio: {
    type: 'twilio',
    displayName: 'Twilio',
    description: 'Send SMS and make calls',
    category: 'communication',
    authMethod: 'api_key',
    configSchema: [
      { name: 'account_sid', label: 'Account SID', type: 'string', required: true },
    ],
    credentialSchema: [
      { name: 'api_key', label: 'Account SID', type: 'text', required: true },
      { name: 'api_secret', label: 'Auth Token', type: 'password', required: true },
    ],
    proxyConfig: {
      baseUrl: 'https://api.twilio.com',
      authType: 'basic',
    },
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
    // Salesforce uses instance_url from config as base URL
    proxyConfig: {
      baseUrl: '', // Will be set from config.instance_url
      authType: 'bearer',
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
      { name: 'api_key', label: 'Personal Access Token', type: 'password', required: true, placeholder: 'pat...' },
    ],
    proxyConfig: {
      baseUrl: 'https://api.airtable.com',
      authType: 'bearer',
    },
  },

  hubspot: {
    type: 'hubspot',
    displayName: 'HubSpot',
    description: 'CRM and marketing automation',
    category: 'saas',
    authMethod: 'api_key',
    configSchema: [],
    credentialSchema: [
      { name: 'api_key', label: 'Private App Token', type: 'password', required: true },
    ],
    proxyConfig: {
      baseUrl: 'https://api.hubapi.com',
      authType: 'bearer',
    },
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
    // No proxyConfig - requires SigV4 signing (special handler)
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
    // No proxyConfig - requires Google auth
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
    // proxyConfig is dynamic based on config.auth_type and config.base_url
    // Will be handled specially in the proxy handler
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

/**
 * Check if an integration supports HTTP proxy passthrough
 */
export function isProxyable(type: string): boolean {
  const def = INTEGRATION_REGISTRY[type];
  return def?.proxyConfig !== undefined;
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
