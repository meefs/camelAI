/**
 * PostgreSQL Handler
 *
 * Executes SQL queries against a PostgreSQL database.
 * This handler requires container execution for native pg driver support.
 *
 * Note: For HTTP-based Postgres (like Neon's serverless driver),
 * a separate handler could be created that runs in the worker.
 */

import type {
  IntegrationHandler,
  ExecuteRequest,
  ExecuteResponse,
  ExecutionContext,
  QueryParams,
  DatabaseCredentials,
} from '../types';

export class PostgresHandler implements IntegrationHandler {
  readonly type = 'postgres';
  readonly environment = 'container' as const;

  async execute(
    request: ExecuteRequest,
    context: ExecutionContext
  ): Promise<ExecuteResponse> {
    const params = request.params as QueryParams;
    const config = context.config as {
      host: string;
      port: number;
      database: string;
      schema?: string;
      ssl_mode?: string;
    };
    const credentials = context.credentials as DatabaseCredentials;

    // This handler runs in a container where we can use the pg library
    // The actual implementation would be in the container driver
    const startTime = Date.now();

    try {
      // In container environment, we would:
      // 1. Import the pg library
      // 2. Create a connection pool or client
      // 3. Execute the query
      // 4. Return results

      // Placeholder - actual execution happens in container
      return {
        success: false,
        error: 'PostgreSQL handler must be executed in container environment',
        metadata: {
          duration_ms: Date.now() - startTime,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Query execution failed',
        metadata: {
          duration_ms: Date.now() - startTime,
        },
      };
    }
  }
}

/**
 * Build a PostgreSQL connection string from config and credentials
 */
export function buildConnectionString(
  config: {
    host: string;
    port: number;
    database: string;
    ssl_mode?: string;
  },
  credentials: DatabaseCredentials
): string {
  const { host, port, database, ssl_mode } = config;
  const { username, password } = credentials;

  let connectionString = `postgresql://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}/${database}`;

  if (ssl_mode && ssl_mode !== 'disable') {
    connectionString += `?sslmode=${ssl_mode}`;
  }

  return connectionString;
}
