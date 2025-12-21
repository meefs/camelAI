/**
 * MySQL Handler
 *
 * Executes SQL queries against a MySQL database.
 * This handler requires container execution for native mysql2 driver support.
 */

import type {
  IntegrationHandler,
  ExecuteRequest,
  ExecuteResponse,
  ExecutionContext,
  QueryParams,
  DatabaseCredentials,
} from '../types';

export class MySQLHandler implements IntegrationHandler {
  readonly type = 'mysql';
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
    };
    const credentials = context.credentials as DatabaseCredentials;

    const startTime = Date.now();

    try {
      // Placeholder - actual execution happens in container
      return {
        success: false,
        error: 'MySQL handler must be executed in container environment',
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
