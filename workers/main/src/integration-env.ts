/**
 * Integration environment variable mapping.
 * Maps integration credentials + config to environment variables for containers.
 *
 * Env vars are namespaced with INT_<TYPE>_<NAME>_ to support multiple connections
 * of the same type and prevent collisions between different types.
 *
 * Example: Stripe integration named "Production" → INT_STRIPE_PRODUCTION_API_KEY
 * Example: Notion integration named "Production" → INT_NOTION_PRODUCTION_API_KEY
 */

/**
 * Dynamic field definition (matches DynamicField from durable-objects.ts)
 */
export interface DynamicFieldForEnv {
  name: string;
  label: string;
  type: 'password' | 'text' | 'url' | 'number';
  required: boolean;
  placeholder?: string;
  description?: string;
}

/**
 * Get the env var suffixes that will be generated for a given integration type.
 * Used to inform users/agents what env vars will be available.
 *
 * @param integrationType - The integration type (e.g., "stripe", "other")
 * @param dynamicFields - Optional: For "other" type, the dynamic field definitions
 */
export function getEnvVarSuffixesForType(integrationType: string, dynamicFields?: DynamicFieldForEnv[]): string[] {
  // For "other" type with dynamic fields, generate suffixes from field names
  if (integrationType === 'other' && dynamicFields && dynamicFields.length > 0) {
    return dynamicFields.map(f => normalizeEnvVarName(f.name));
  }

  switch (integrationType) {
    case 'stripe':
      return ['API_KEY', 'SECRET_KEY'];
    case 'openai':
      return ['API_KEY', 'ORGANIZATION_ID'];
    case 'anthropic':
      return ['API_KEY'];
    case 'supabase':
      return ['API_KEY', 'PROJECT_URL', 'KEY_TYPE'];
    case 'databricks':
      return ['API_KEY', 'WORKSPACE_URL'];
    case 'sentry':
      return ['API_KEY', 'ORGANIZATION'];
    case 'mailchimp':
      return ['API_KEY', 'DATA_CENTER'];
    case 'posthog':
      return ['API_KEY', 'HOST', 'PROJECT_ID'];
    case 'mixpanel':
      return ['USERNAME', 'SECRET', 'PROJECT_ID', 'REGION'];
    case 'linear':
    case 'sendgrid':
    case 'airtable':
    case 'hubspot':
      return ['API_KEY'];
    case 'github':
      return ['TOKEN'];
    case 'notion':
      return ['API_KEY', 'WORKSPACE_ID', 'WORKSPACE_NAME'];
    case 'slack':
      return ['BOT_TOKEN', 'TEAM_ID', 'TEAM_NAME'];
    case 'twilio':
      return ['ACCOUNT_SID', 'AUTH_TOKEN'];
    case 'salesforce':
      return ['ACCESS_TOKEN', 'INSTANCE_URL'];
    case 'aws':
      return ['ACCESS_KEY_ID', 'SECRET_ACCESS_KEY', 'REGION'];
    case 'postgres':
      return ['DATABASE_URL', 'URL'];
    case 'mysql':
      return ['URL', 'DATABASE_URL'];
    case 'mongodb':
      return ['URL', 'URI'];
    case 'redis':
      return ['URL'];
    case 'bigquery':
      return ['ACCESS_TOKEN', 'PROJECT_ID'];
    case 'other':
      return ['API_KEY', 'API_SECRET', 'CLIENT_ID', 'CLIENT_SECRET', 'BASE_URL'];
    default:
      return ['API_KEY'];
  }
}

/**
 * Normalize an integration name to a valid env var prefix.
 * - Converts to uppercase
 * - Replaces non-alphanumeric chars with underscores
 * - Collapses multiple underscores
 * - Trims leading/trailing underscores
 */
export function normalizeEnvVarName(name: string): string {
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
}

/**
 * Map integration credentials and config to environment variables.
 * Returns vars prefixed with INT_<TYPE>_<NORMALIZED_NAME>_ for namespacing.
 *
 * Including the type in the prefix prevents collisions when different
 * integration types have the same name (e.g., "Production" for both
 * Stripe and Notion would otherwise both create INT_PRODUCTION_API_KEY).
 *
 * @param integrationName - User-provided name for the integration (e.g., "My Stripe Account")
 * @param integrationType - Integration type (e.g., "stripe", "postgres")
 * @param credentials - Decrypted credentials
 * @param config - Integration config (may include dynamic_fields for "other" type)
 */
export function mapCredentialsToEnvVars(
  integrationName: string,
  integrationType: string,
  credentials: Record<string, unknown>,
  config: Record<string, unknown>
): Record<string, string> {
  const env: Record<string, string> = {};
  const typePrefix = normalizeEnvVarName(integrationType);
  const namePrefix = normalizeEnvVarName(integrationName);

  // Helper to safely get string value
  const str = (val: unknown): string | null => {
    if (val === undefined || val === null || val === '') return null;
    return String(val);
  };

  // Helper to set env var with INT_<TYPE>_<NAME>_ namespace
  const set = (suffix: string, value: string) => {
    env[`INT_${typePrefix}_${namePrefix}_${suffix}`] = value;
  };

  switch (integrationType) {
    case 'stripe':
      if (str(credentials.api_key)) set('API_KEY', str(credentials.api_key)!);
      if (str(credentials.api_key)) set('SECRET_KEY', str(credentials.api_key)!);
      break;

    case 'openai':
      if (str(credentials.api_key)) set('API_KEY', str(credentials.api_key)!);
      if (str(config.organization_id)) set('ORGANIZATION_ID', str(config.organization_id)!);
      break;

    case 'anthropic':
      if (str(credentials.api_key)) set('API_KEY', str(credentials.api_key)!);
      break;

    case 'supabase':
      if (str(credentials.api_key)) set('API_KEY', str(credentials.api_key)!);
      if (str(config.project_url)) set('PROJECT_URL', str(config.project_url)!);
      if (str(config.key_type)) set('KEY_TYPE', str(config.key_type)!);
      break;

    case 'databricks':
      if (str(credentials.api_key)) set('API_KEY', str(credentials.api_key)!);
      if (str(config.workspace_url)) set('WORKSPACE_URL', str(config.workspace_url)!);
      break;

    case 'sentry':
      if (str(credentials.api_key)) set('API_KEY', str(credentials.api_key)!);
      if (str(config.organization)) set('ORGANIZATION', str(config.organization)!);
      break;

    case 'mailchimp':
      if (str(credentials.api_key)) set('API_KEY', str(credentials.api_key)!);
      if (str(config.data_center)) set('DATA_CENTER', str(config.data_center)!);
      break;

    case 'posthog':
      if (str(credentials.api_key)) set('API_KEY', str(credentials.api_key)!);
      if (str(config.host)) set('HOST', str(config.host)!);
      if (str(config.project_id)) set('PROJECT_ID', str(config.project_id)!);
      break;

    case 'mixpanel':
      if (str(credentials.api_key)) set('USERNAME', str(credentials.api_key)!);
      if (str(credentials.api_secret)) set('SECRET', str(credentials.api_secret)!);
      if (str(config.project_id)) set('PROJECT_ID', str(config.project_id)!);
      if (str(config.region)) set('REGION', str(config.region)!);
      break;

    case 'github':
      if (str(credentials.api_key)) set('TOKEN', str(credentials.api_key)!);
      break;

    case 'notion':
      // OAuth flow stores access_token, fall back to api_key for manual entry
      if (str(credentials.access_token)) set('API_KEY', str(credentials.access_token)!);
      else if (str(credentials.api_key)) set('API_KEY', str(credentials.api_key)!);
      // Expose workspace info if available (from OAuth)
      if (str(credentials.notion_workspace_id)) set('WORKSPACE_ID', str(credentials.notion_workspace_id)!);
      if (str(credentials.notion_workspace_name)) set('WORKSPACE_NAME', str(credentials.notion_workspace_name)!);
      // Note: refresh_token and expires_at are intentionally NOT exposed to containers
      break;

    case 'slack':
      // OAuth flow stores access_token, fall back to api_key for manual entry
      if (str(credentials.access_token)) set('BOT_TOKEN', str(credentials.access_token)!);
      else if (str(credentials.api_key)) set('BOT_TOKEN', str(credentials.api_key)!);
      // Also expose team info if available
      if (str(credentials.team_id)) set('TEAM_ID', str(credentials.team_id)!);
      if (str(credentials.team_name)) set('TEAM_NAME', str(credentials.team_name)!);
      break;

    case 'linear':
      if (str(credentials.api_key)) set('API_KEY', str(credentials.api_key)!);
      break;

    case 'sendgrid':
      if (str(credentials.api_key)) set('API_KEY', str(credentials.api_key)!);
      break;

    case 'twilio':
      if (str(credentials.account_sid)) set('ACCOUNT_SID', str(credentials.account_sid)!);
      if (str(credentials.auth_token)) set('AUTH_TOKEN', str(credentials.auth_token)!);
      break;

    case 'salesforce':
      if (str(credentials.access_token)) set('ACCESS_TOKEN', str(credentials.access_token)!);
      if (str(config.instance_url)) set('INSTANCE_URL', str(config.instance_url)!);
      break;

    case 'airtable':
      if (str(credentials.api_key)) set('API_KEY', str(credentials.api_key)!);
      break;

    case 'hubspot':
      if (str(credentials.api_key)) set('API_KEY', str(credentials.api_key)!);
      break;

    case 'aws':
      if (str(credentials.access_key_id)) set('ACCESS_KEY_ID', str(credentials.access_key_id)!);
      if (str(credentials.secret_access_key)) set('SECRET_ACCESS_KEY', str(credentials.secret_access_key)!);
      if (str(config.region)) set('REGION', str(config.region)!);
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
        set('URL', url);
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
        set('URL', url);
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
        set('URL', url);
        set('URI', url);
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
        set('URL', url);
      }
      break;
    }

    case 'bigquery':
      // BigQuery uses short-lived access tokens minted from service account JSON.
      if (str(credentials.access_token)) set('ACCESS_TOKEN', str(credentials.access_token)!);
      if (str(config.project_id)) set('PROJECT_ID', str(config.project_id)!);
      break;

    case 'other': {
      // Check for dynamic fields in config (set during dynamic integration creation)
      const dynamicFields = config.dynamic_fields as DynamicFieldForEnv[] | undefined;

      if (dynamicFields && Array.isArray(dynamicFields) && dynamicFields.length > 0) {
        // Dynamic "other" integration - map each dynamic field to an env var
        for (const field of dynamicFields) {
          const value = str(credentials[field.name]);
          if (value) {
            set(normalizeEnvVarName(field.name), value);
          }
        }
      } else {
        // Legacy "other" integration - expose standard credential fields
        if (str(credentials.api_key)) set('API_KEY', str(credentials.api_key)!);
        if (str(credentials.api_secret)) set('API_SECRET', str(credentials.api_secret)!);
        if (str(credentials.client_id)) set('CLIENT_ID', str(credentials.client_id)!);
        if (str(credentials.client_secret)) set('CLIENT_SECRET', str(credentials.client_secret)!);
        if (str(config.base_url)) set('BASE_URL', str(config.base_url)!);
      }
      break;
    }

    // Default: expose api_key if present
    default: {
      if (str(credentials.api_key)) set('API_KEY', str(credentials.api_key)!);
      break;
    }
  }

  return env;
}
