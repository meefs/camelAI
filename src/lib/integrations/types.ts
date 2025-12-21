/**
 * Integration Executor Types
 *
 * Defines the interface for executing actions against connected integrations.
 */

export type ExecutionEnvironment = 'worker' | 'container';

/**
 * Request to execute an action on an integration
 */
export interface ExecuteRequest {
  /** Parameters for the request (QueryParams for DBs, RequestParams for HTTP) */
  params: QueryParams | RequestParams;
}

/**
 * Parameters for database queries
 */
export interface QueryParams {
  /** SQL query to execute */
  sql: string;

  /** Query parameters (for prepared statements) */
  values?: unknown[];
}

/**
 * Parameters for HTTP requests
 */
export interface RequestParams {
  /** HTTP method */
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

  /** API path (appended to base URL) */
  path: string;

  /** Query string parameters */
  query?: Record<string, string | number | boolean>;

  /** Request body (for POST/PUT/PATCH) */
  body?: unknown;

  /** Additional headers */
  headers?: Record<string, string>;
}

/**
 * Response from executing an action
 */
export interface ExecuteResponse {
  /** Whether the action succeeded */
  success: boolean;

  /** Result data (rows for queries, response body for requests) */
  data?: unknown;

  /** Error message if failed */
  error?: string;

  /** Execution metadata */
  metadata?: {
    /** Execution duration in milliseconds */
    duration_ms: number;

    /** Number of rows affected (for database writes) */
    rows_affected?: number;

    /** HTTP status code (for requests) */
    status_code?: number;

    /** Response headers (for requests) */
    headers?: Record<string, string>;
  };
}

/**
 * Credentials structure for different auth methods
 */
export interface ApiKeyCredentials {
  api_key: string;
  api_secret?: string;
}

export interface OAuth2Credentials {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_at?: number;
}

export interface DatabaseCredentials {
  username: string;
  password: string;
}

export type IntegrationCredentials =
  | ApiKeyCredentials
  | OAuth2Credentials
  | DatabaseCredentials;

/**
 * Context passed to handlers for execution
 */
export interface ExecutionContext {
  /** Integration type (e.g., 'stripe', 'postgres') */
  integrationType: string;

  /** Integration config */
  config: Record<string, unknown>;

  /** Decrypted credentials */
  credentials: IntegrationCredentials;
}

/**
 * Base interface for integration handlers
 */
export interface IntegrationHandler {
  /** Integration type this handler supports */
  readonly type: string;

  /** Where this handler can run */
  readonly environment: ExecutionEnvironment;

  /** Execute an action */
  execute(
    request: ExecuteRequest,
    context: ExecutionContext
  ): Promise<ExecuteResponse>;
}
