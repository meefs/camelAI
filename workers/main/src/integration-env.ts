/**
 * Integration environment variable mapping.
 * Maps integration credentials + config to environment variables for containers.
 */

/**
 * Map integration credentials and config to environment variables.
 * Returns vars prefixed with INT_ for namespacing.
 */
export function mapCredentialsToEnvVars(
  integrationType: string,
  credentials: Record<string, unknown>,
  config: Record<string, unknown>
): Record<string, string> {
  const env: Record<string, string> = {};

  // Helper to safely get string value
  const str = (val: unknown): string | null => {
    if (val === undefined || val === null || val === '') return null;
    return String(val);
  };

  // Helper to set env var with INT_ prefix
  const set = (name: string, value: string) => {
    env[`INT_${name}`] = value;
  };

  switch (integrationType) {
    case 'stripe':
      if (str(credentials.api_key)) set('STRIPE_API_KEY', str(credentials.api_key)!);
      if (str(credentials.api_key)) set('STRIPE_SECRET_KEY', str(credentials.api_key)!);
      break;

    case 'openai':
      if (str(credentials.api_key)) set('OPENAI_API_KEY', str(credentials.api_key)!);
      break;

    case 'anthropic':
      if (str(credentials.api_key)) set('ANTHROPIC_API_KEY', str(credentials.api_key)!);
      break;

    case 'github':
      if (str(credentials.api_key)) set('GITHUB_TOKEN', str(credentials.api_key)!);
      break;

    case 'notion':
      // OAuth flow stores access_token, fall back to api_key for manual entry
      if (str(credentials.access_token)) set('NOTION_API_KEY', str(credentials.access_token)!);
      else if (str(credentials.api_key)) set('NOTION_API_KEY', str(credentials.api_key)!);
      // Expose workspace info if available (from OAuth)
      if (str(credentials.notion_workspace_id)) set('NOTION_WORKSPACE_ID', str(credentials.notion_workspace_id)!);
      if (str(credentials.notion_workspace_name)) set('NOTION_WORKSPACE_NAME', str(credentials.notion_workspace_name)!);
      // Note: refresh_token and expires_at are intentionally NOT exposed to containers
      break;

    case 'slack':
      // OAuth flow stores access_token, fall back to api_key for manual entry
      if (str(credentials.access_token)) set('SLACK_BOT_TOKEN', str(credentials.access_token)!);
      else if (str(credentials.api_key)) set('SLACK_BOT_TOKEN', str(credentials.api_key)!);
      // Also expose team info if available
      if (str(credentials.team_id)) set('SLACK_TEAM_ID', str(credentials.team_id)!);
      if (str(credentials.team_name)) set('SLACK_TEAM_NAME', str(credentials.team_name)!);
      break;

    case 'linear':
      if (str(credentials.api_key)) set('LINEAR_API_KEY', str(credentials.api_key)!);
      break;

    case 'sendgrid':
      if (str(credentials.api_key)) set('SENDGRID_API_KEY', str(credentials.api_key)!);
      break;

    case 'twilio':
      if (str(credentials.account_sid)) set('TWILIO_ACCOUNT_SID', str(credentials.account_sid)!);
      if (str(credentials.auth_token)) set('TWILIO_AUTH_TOKEN', str(credentials.auth_token)!);
      break;

    case 'salesforce':
      if (str(credentials.access_token)) set('SALESFORCE_ACCESS_TOKEN', str(credentials.access_token)!);
      if (str(config.instance_url)) set('SALESFORCE_INSTANCE_URL', str(config.instance_url)!);
      break;

    case 'airtable':
      if (str(credentials.api_key)) set('AIRTABLE_API_KEY', str(credentials.api_key)!);
      break;

    case 'hubspot':
      if (str(credentials.api_key)) set('HUBSPOT_API_KEY', str(credentials.api_key)!);
      break;

    case 'aws':
      if (str(credentials.access_key_id)) set('AWS_ACCESS_KEY_ID', str(credentials.access_key_id)!);
      if (str(credentials.secret_access_key)) set('AWS_SECRET_ACCESS_KEY', str(credentials.secret_access_key)!);
      if (str(config.region)) set('AWS_REGION', str(config.region)!);
      break;

    case 'postgres': {
      // Build DATABASE_URL from config + credentials
      const host = str(config.host);
      const port = str(config.port) || '5432';
      const database = str(config.database);
      const user = str(credentials.username);
      const password = str(credentials.password);
      const sslMode = str(config.ssl_mode) || 'require';
      if (host && database && user && password) {
        const url = `postgresql://${user}:${encodeURIComponent(password)}@${host}:${port}/${database}?sslmode=${sslMode}`;
        set('DATABASE_URL', url);
        set('POSTGRES_URL', url);
      }
      break;
    }

    case 'mysql': {
      // Build MYSQL_URL from config + credentials
      const host = str(config.host);
      const port = str(config.port) || '3306';
      const database = str(config.database);
      const user = str(credentials.username);
      const password = str(credentials.password);
      if (host && database && user && password) {
        const url = `mysql://${user}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
        set('MYSQL_URL', url);
        set('DATABASE_URL', url);
      }
      break;
    }

    case 'mongodb': {
      // Build MONGODB_URL from config + credentials
      const host = str(config.host);
      const port = str(config.port) || '27017';
      const database = str(config.database);
      const user = str(credentials.username);
      const password = str(credentials.password);
      if (host && database && user && password) {
        const url = `mongodb://${user}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
        set('MONGODB_URL', url);
        set('MONGODB_URI', url);
      }
      break;
    }

    case 'redis': {
      // Build REDIS_URL from config + credentials
      const host = str(config.host);
      const port = str(config.port) || '6379';
      const password = str(credentials.password);
      if (host) {
        const url = password
          ? `redis://:${encodeURIComponent(password)}@${host}:${port}`
          : `redis://${host}:${port}`;
        set('REDIS_URL', url);
      }
      break;
    }

    case 'bigquery':
      // BigQuery uses service account JSON
      if (str(credentials.service_account_json)) {
        set('GOOGLE_APPLICATION_CREDENTIALS_JSON', str(credentials.service_account_json)!);
      }
      if (str(config.project_id)) set('BIGQUERY_PROJECT_ID', str(config.project_id)!);
      break;

    case 'other': {
      // Generic "other" integration - use display_name or a generic prefix
      const displayName = str(config.display_name);
      const prefix = displayName
        ? displayName.toUpperCase().replace(/[^A-Z0-9]/g, '_').replace(/_+/g, '_')
        : 'CUSTOM';
      if (str(credentials.api_key)) set(`${prefix}_API_KEY`, str(credentials.api_key)!);
      if (str(credentials.api_secret)) set(`${prefix}_API_SECRET`, str(credentials.api_secret)!);
      if (str(credentials.client_id)) set(`${prefix}_CLIENT_ID`, str(credentials.client_id)!);
      if (str(credentials.client_secret)) set(`${prefix}_CLIENT_SECRET`, str(credentials.client_secret)!);
      if (str(config.base_url)) set(`${prefix}_BASE_URL`, str(config.base_url)!);
      break;
    }

    // Default: use integration type as prefix for api_key
    default: {
      const prefix = integrationType.toUpperCase().replace(/-/g, '_');
      if (str(credentials.api_key)) set(`${prefix}_API_KEY`, str(credentials.api_key)!);
      break;
    }
  }

  return env;
}
