import { describe, it, expect } from 'vitest';
import { normalizeEnvVarName, mapCredentialsToEnvVars, getEnvVarSuffixesForType } from '../workers/main/src/integration-env';

describe('normalizeEnvVarName', () => {
  it('converts to uppercase', () => {
    expect(normalizeEnvVarName('myStripe')).toBe('MYSTRIPE');
    expect(normalizeEnvVarName('My Stripe Account')).toBe('MY_STRIPE_ACCOUNT');
  });

  it('replaces non-alphanumeric chars with underscores', () => {
    expect(normalizeEnvVarName('stripe-prod')).toBe('STRIPE_PROD');
    expect(normalizeEnvVarName('stripe.test')).toBe('STRIPE_TEST');
    expect(normalizeEnvVarName('my@special#name')).toBe('MY_SPECIAL_NAME');
  });

  it('collapses multiple underscores', () => {
    expect(normalizeEnvVarName('my  stripe')).toBe('MY_STRIPE');
    expect(normalizeEnvVarName('my---stripe')).toBe('MY_STRIPE');
    expect(normalizeEnvVarName('my _ stripe')).toBe('MY_STRIPE');
  });

  it('trims leading and trailing underscores', () => {
    expect(normalizeEnvVarName('_myStripe')).toBe('MYSTRIPE');
    expect(normalizeEnvVarName('myStripe_')).toBe('MYSTRIPE');
    expect(normalizeEnvVarName('__my__stripe__')).toBe('MY_STRIPE');
    expect(normalizeEnvVarName(' my stripe ')).toBe('MY_STRIPE');
  });

  it('handles edge cases', () => {
    expect(normalizeEnvVarName('Production Stripe Account')).toBe('PRODUCTION_STRIPE_ACCOUNT');
    expect(normalizeEnvVarName('Sandbox (Dev)')).toBe('SANDBOX_DEV');
    expect(normalizeEnvVarName("Company's Main DB")).toBe('COMPANY_S_MAIN_DB');
  });
});

describe('getEnvVarSuffixesForType', () => {
  it('returns correct suffixes for stripe', () => {
    expect(getEnvVarSuffixesForType('stripe')).toEqual(['API_KEY', 'SECRET_KEY']);
  });

  it('returns correct suffixes for openai', () => {
    expect(getEnvVarSuffixesForType('openai')).toEqual(['API_KEY', 'ORGANIZATION_ID']);
  });

  it('returns correct suffixes for supabase', () => {
    expect(getEnvVarSuffixesForType('supabase')).toEqual(['API_KEY', 'PROJECT_URL', 'KEY_TYPE']);
  });

  it('returns correct suffixes for databricks', () => {
    expect(getEnvVarSuffixesForType('databricks')).toEqual(['API_KEY', 'WORKSPACE_URL']);
  });

  it('returns correct suffixes for sentry', () => {
    expect(getEnvVarSuffixesForType('sentry')).toEqual(['API_KEY', 'ORGANIZATION']);
  });

  it('returns correct suffixes for mailchimp', () => {
    expect(getEnvVarSuffixesForType('mailchimp')).toEqual(['API_KEY', 'DATA_CENTER']);
  });

  it('returns correct suffixes for posthog', () => {
    expect(getEnvVarSuffixesForType('posthog')).toEqual(['API_KEY', 'HOST', 'PROJECT_ID']);
  });

  it('returns correct suffixes for mixpanel', () => {
    expect(getEnvVarSuffixesForType('mixpanel')).toEqual(['USERNAME', 'SECRET', 'PROJECT_ID', 'REGION']);
  });

  it('returns correct suffixes for postgres', () => {
    expect(getEnvVarSuffixesForType('postgres')).toEqual(['DATABASE_URL', 'URL']);
  });

  it('returns correct suffixes for slack', () => {
    expect(getEnvVarSuffixesForType('slack')).toEqual(['BOT_TOKEN', 'TEAM_ID', 'TEAM_NAME']);
  });

  it('returns correct suffixes for github', () => {
    expect(getEnvVarSuffixesForType('github')).toEqual(['TOKEN']);
  });

  it('returns API_KEY for unknown types', () => {
    expect(getEnvVarSuffixesForType('some_unknown_type')).toEqual(['API_KEY']);
  });

  it('returns default "other" suffixes when no dynamic fields', () => {
    expect(getEnvVarSuffixesForType('other')).toEqual(['API_KEY', 'API_SECRET', 'CLIENT_ID', 'CLIENT_SECRET', 'BASE_URL']);
  });

  it('returns suffixes from dynamic fields for "other" type', () => {
    const dynamicFields = [
      { name: 'api_key', label: 'API Key', type: 'password' as const, required: true },
      { name: 'store_id', label: 'Store ID', type: 'text' as const, required: true },
      { name: 'webhook_secret', label: 'Webhook Secret', type: 'password' as const, required: false },
    ];
    expect(getEnvVarSuffixesForType('other', dynamicFields)).toEqual(['API_KEY', 'STORE_ID', 'WEBHOOK_SECRET']);
  });

  it('normalizes dynamic field names to valid env var suffixes', () => {
    const dynamicFields = [
      { name: 'api-key', label: 'API Key', type: 'password' as const, required: true },
      { name: 'My Custom Field', label: 'Custom', type: 'text' as const, required: false },
    ];
    expect(getEnvVarSuffixesForType('other', dynamicFields)).toEqual(['API_KEY', 'MY_CUSTOM_FIELD']);
  });
});

describe('mapCredentialsToEnvVars', () => {
  it('uses type and name in prefix for stripe', () => {
    const env = mapCredentialsToEnvVars(
      'My Stripe',
      'stripe',
      { api_key: 'sk_test_123' },
      {}
    );
    expect(env).toEqual({
      INT_STRIPE_MY_STRIPE_API_KEY: 'sk_test_123',
      INT_STRIPE_MY_STRIPE_SECRET_KEY: 'sk_test_123',
    });
  });

  it('supports multiple connections of the same type', () => {
    const prodEnv = mapCredentialsToEnvVars(
      'Production',
      'stripe',
      { api_key: 'sk_live_prod' },
      {}
    );
    const testEnv = mapCredentialsToEnvVars(
      'Test',
      'stripe',
      { api_key: 'sk_test_test' },
      {}
    );

    expect(prodEnv).toEqual({
      INT_STRIPE_PRODUCTION_API_KEY: 'sk_live_prod',
      INT_STRIPE_PRODUCTION_SECRET_KEY: 'sk_live_prod',
    });
    expect(testEnv).toEqual({
      INT_STRIPE_TEST_API_KEY: 'sk_test_test',
      INT_STRIPE_TEST_SECRET_KEY: 'sk_test_test',
    });

    // They should not conflict when merged
    const combined = { ...prodEnv, ...testEnv };
    expect(Object.keys(combined)).toHaveLength(4);
  });

  it('prevents collisions between different types with same name', () => {
    const stripeEnv = mapCredentialsToEnvVars(
      'Production',
      'stripe',
      { api_key: 'sk_live_123' },
      {}
    );
    const notionEnv = mapCredentialsToEnvVars(
      'Production',
      'notion',
      { access_token: 'ntn_prod_123' },
      {}
    );

    // Stripe has INT_STRIPE_PRODUCTION_* prefix
    expect(stripeEnv).toEqual({
      INT_STRIPE_PRODUCTION_API_KEY: 'sk_live_123',
      INT_STRIPE_PRODUCTION_SECRET_KEY: 'sk_live_123',
    });

    // Notion has INT_NOTION_PRODUCTION_* prefix - no collision
    expect(notionEnv.INT_NOTION_PRODUCTION_API_KEY).toBe('ntn_prod_123');

    // They should not conflict when merged
    const combined = { ...stripeEnv, ...notionEnv };
    expect(combined.INT_STRIPE_PRODUCTION_API_KEY).toBe('sk_live_123');
    expect(combined.INT_NOTION_PRODUCTION_API_KEY).toBe('ntn_prod_123');
  });

  it('handles postgres with custom name', () => {
    const env = mapCredentialsToEnvVars(
      'Main Database',
      'postgres',
      { username: 'admin', password: 'secret123' },
      { host: 'db.example.com', port: '5432', database: 'mydb' }
    );
    expect(env.INT_POSTGRES_MAIN_DATABASE_DATABASE_URL).toBe(
      'postgresql://admin:secret123@db.example.com:5432/mydb?sslmode=require'
    );
    expect(env.INT_POSTGRES_MAIN_DATABASE_URL).toBe(
      'postgresql://admin:secret123@db.example.com:5432/mydb?sslmode=require'
    );
  });

  it('handles notion oauth', () => {
    const env = mapCredentialsToEnvVars(
      'Work Notion',
      'notion',
      {
        access_token: 'ntn_abc123',
        notion_workspace_id: 'ws123',
        notion_workspace_name: 'My Workspace',
      },
      {}
    );
    expect(env).toEqual({
      INT_NOTION_WORK_NOTION_API_KEY: 'ntn_abc123',
      INT_NOTION_WORK_NOTION_WORKSPACE_ID: 'ws123',
      INT_NOTION_WORK_NOTION_WORKSPACE_NAME: 'My Workspace',
    });
  });

  it('handles slack oauth', () => {
    const env = mapCredentialsToEnvVars(
      'Team Slack',
      'slack',
      {
        access_token: 'xoxb-123',
        team_id: 'T123',
        team_name: 'My Team',
      },
      {}
    );
    expect(env).toEqual({
      INT_SLACK_TEAM_SLACK_BOT_TOKEN: 'xoxb-123',
      INT_SLACK_TEAM_SLACK_TEAM_ID: 'T123',
      INT_SLACK_TEAM_SLACK_TEAM_NAME: 'My Team',
    });
  });

  it('handles github', () => {
    const env = mapCredentialsToEnvVars(
      'Personal',
      'github',
      { api_key: 'ghp_abc123' },
      {}
    );
    expect(env).toEqual({
      INT_GITHUB_PERSONAL_TOKEN: 'ghp_abc123',
    });
  });

  it('handles twilio', () => {
    const env = mapCredentialsToEnvVars(
      'SMS Service',
      'twilio',
      { account_sid: 'AC123', auth_token: 'token456' },
      {}
    );
    expect(env).toEqual({
      INT_TWILIO_SMS_SERVICE_ACCOUNT_SID: 'AC123',
      INT_TWILIO_SMS_SERVICE_AUTH_TOKEN: 'token456',
    });
  });

  it('handles supabase', () => {
    const env = mapCredentialsToEnvVars(
      'My Project',
      'supabase',
      { api_key: 'eyJ_test_key' },
      { project_url: 'https://xyz.supabase.co', key_type: 'anon' }
    );
    expect(env).toEqual({
      INT_SUPABASE_MY_PROJECT_API_KEY: 'eyJ_test_key',
      INT_SUPABASE_MY_PROJECT_PROJECT_URL: 'https://xyz.supabase.co',
      INT_SUPABASE_MY_PROJECT_KEY_TYPE: 'anon',
    });
  });

  it('handles supabase with service_role key type', () => {
    const env = mapCredentialsToEnvVars(
      'Admin',
      'supabase',
      { api_key: 'eyJ_service_role' },
      { project_url: 'https://xyz.supabase.co', key_type: 'service_role' }
    );
    expect(env.INT_SUPABASE_ADMIN_KEY_TYPE).toBe('service_role');
  });

  it('handles databricks', () => {
    const env = mapCredentialsToEnvVars(
      'Workspace',
      'databricks',
      { api_key: 'dapi_test_123' },
      { workspace_url: 'https://dbc-abc123.cloud.databricks.com' }
    );
    expect(env).toEqual({
      INT_DATABRICKS_WORKSPACE_API_KEY: 'dapi_test_123',
      INT_DATABRICKS_WORKSPACE_WORKSPACE_URL: 'https://dbc-abc123.cloud.databricks.com',
    });
  });

  it('handles sentry', () => {
    const env = mapCredentialsToEnvVars(
      'Error Tracker',
      'sentry',
      { api_key: 'sntrys_test_123' },
      { organization: 'my-org' }
    );
    expect(env).toEqual({
      INT_SENTRY_ERROR_TRACKER_API_KEY: 'sntrys_test_123',
      INT_SENTRY_ERROR_TRACKER_ORGANIZATION: 'my-org',
    });
  });

  it('handles sentry without optional organization', () => {
    const env = mapCredentialsToEnvVars(
      'Sentry',
      'sentry',
      { api_key: 'sntrys_test_123' },
      {}
    );
    expect(env).toEqual({
      INT_SENTRY_SENTRY_API_KEY: 'sntrys_test_123',
    });
  });

  it('handles mailchimp', () => {
    const env = mapCredentialsToEnvVars(
      'Newsletter',
      'mailchimp',
      { api_key: 'abc123-us21' },
      { data_center: 'us21' }
    );
    expect(env).toEqual({
      INT_MAILCHIMP_NEWSLETTER_API_KEY: 'abc123-us21',
      INT_MAILCHIMP_NEWSLETTER_DATA_CENTER: 'us21',
    });
  });

  it('handles posthog', () => {
    const env = mapCredentialsToEnvVars(
      'Analytics',
      'posthog',
      { api_key: 'phx_test_123' },
      { host: 'https://eu.posthog.com', project_id: '12345' }
    );
    expect(env).toEqual({
      INT_POSTHOG_ANALYTICS_API_KEY: 'phx_test_123',
      INT_POSTHOG_ANALYTICS_HOST: 'https://eu.posthog.com',
      INT_POSTHOG_ANALYTICS_PROJECT_ID: '12345',
    });
  });

  it('handles posthog without optional project_id', () => {
    const env = mapCredentialsToEnvVars(
      'PH',
      'posthog',
      { api_key: 'phx_test' },
      { host: 'https://us.posthog.com' }
    );
    expect(env).toEqual({
      INT_POSTHOG_PH_API_KEY: 'phx_test',
      INT_POSTHOG_PH_HOST: 'https://us.posthog.com',
    });
  });

  it('handles mixpanel', () => {
    const env = mapCredentialsToEnvVars(
      'Product Analytics',
      'mixpanel',
      { api_key: 'sa_username.abc123', api_secret: 'sa_secret_xyz' },
      { project_id: '7654321', region: 'eu' }
    );
    expect(env).toEqual({
      INT_MIXPANEL_PRODUCT_ANALYTICS_USERNAME: 'sa_username.abc123',
      INT_MIXPANEL_PRODUCT_ANALYTICS_SECRET: 'sa_secret_xyz',
      INT_MIXPANEL_PRODUCT_ANALYTICS_PROJECT_ID: '7654321',
      INT_MIXPANEL_PRODUCT_ANALYTICS_REGION: 'eu',
    });
  });

  it('handles openai with organization_id', () => {
    const env = mapCredentialsToEnvVars(
      'GPT',
      'openai',
      { api_key: 'sk-test-123' },
      { organization_id: 'org-abc' }
    );
    expect(env).toEqual({
      INT_OPENAI_GPT_API_KEY: 'sk-test-123',
      INT_OPENAI_GPT_ORGANIZATION_ID: 'org-abc',
    });
  });

  it('handles openai without optional organization_id', () => {
    const env = mapCredentialsToEnvVars(
      'GPT',
      'openai',
      { api_key: 'sk-test-123' },
      {}
    );
    expect(env).toEqual({
      INT_OPENAI_GPT_API_KEY: 'sk-test-123',
    });
  });

  it('handles openrouter via default case', () => {
    const env = mapCredentialsToEnvVars(
      'Router',
      'openrouter',
      { api_key: 'sk-or-test' },
      {}
    );
    expect(env).toEqual({
      INT_OPENROUTER_ROUTER_API_KEY: 'sk-or-test',
    });
  });

  it('handles typeform via default case', () => {
    const env = mapCredentialsToEnvVars(
      'Forms',
      'typeform',
      { api_key: 'tfp_test_123' },
      {}
    );
    expect(env).toEqual({
      INT_TYPEFORM_FORMS_API_KEY: 'tfp_test_123',
    });
  });

  it('handles other/custom integration', () => {
    const env = mapCredentialsToEnvVars(
      'Custom API',
      'other',
      { api_key: 'key123', api_secret: 'secret456' },
      { base_url: 'https://api.custom.com' }
    );
    expect(env).toEqual({
      INT_OTHER_CUSTOM_API_API_KEY: 'key123',
      INT_OTHER_CUSTOM_API_API_SECRET: 'secret456',
      INT_OTHER_CUSTOM_API_BASE_URL: 'https://api.custom.com',
    });
  });

  it('handles unknown integration type', () => {
    const env = mapCredentialsToEnvVars(
      'My Service',
      'unknown_service',
      { api_key: 'key789' },
      {}
    );
    expect(env).toEqual({
      INT_UNKNOWN_SERVICE_MY_SERVICE_API_KEY: 'key789',
    });
  });

  it('handles dynamic "other" integration with custom fields', () => {
    const dynamicFields = [
      { name: 'api_key', label: 'API Key', type: 'password' as const, required: true },
      { name: 'store_id', label: 'Store ID', type: 'text' as const, required: true },
    ];
    const env = mapCredentialsToEnvVars(
      'Acme API',
      'other',
      { api_key: 'acme_key_123', store_id: 'store_456' },
      { dynamic_fields: dynamicFields, display_name: 'Acme API' }
    );
    expect(env).toEqual({
      INT_OTHER_ACME_API_API_KEY: 'acme_key_123',
      INT_OTHER_ACME_API_STORE_ID: 'store_456',
    });
  });

  it('handles dynamic fields with special characters in names', () => {
    const dynamicFields = [
      { name: 'api-key', label: 'API Key', type: 'password' as const, required: true },
      { name: 'webhook_secret', label: 'Secret', type: 'password' as const, required: false },
    ];
    const env = mapCredentialsToEnvVars(
      'My Service',
      'other',
      { 'api-key': 'key123', 'webhook_secret': 'secret456' },
      { dynamic_fields: dynamicFields }
    );
    expect(env).toEqual({
      INT_OTHER_MY_SERVICE_API_KEY: 'key123',
      INT_OTHER_MY_SERVICE_WEBHOOK_SECRET: 'secret456',
    });
  });

  it('falls back to legacy behavior for "other" without dynamic_fields', () => {
    const env = mapCredentialsToEnvVars(
      'Legacy Custom',
      'other',
      { api_key: 'key123', api_secret: 'secret456' },
      { base_url: 'https://api.legacy.com' }
    );
    expect(env).toEqual({
      INT_OTHER_LEGACY_CUSTOM_API_KEY: 'key123',
      INT_OTHER_LEGACY_CUSTOM_API_SECRET: 'secret456',
      INT_OTHER_LEGACY_CUSTOM_BASE_URL: 'https://api.legacy.com',
    });
  });
});
