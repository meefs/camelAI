/**
 * Integration Execution Library
 *
 * HTTP-based integrations use the transparent proxy route:
 *   /api/orgs/[orgId]/integrations/[integrationId]/proxy/[...path]
 *
 * Special handlers exist for:
 * - AWS (requires SigV4 signing)
 * - Databases (require container execution)
 */

// Types
export type {
  ExecuteRequest,
  ExecuteResponse,
  ExecutionContext,
  ExecutionEnvironment,
  QueryParams,
  RequestParams,
  IntegrationHandler,
  IntegrationCredentials,
  ApiKeyCredentials,
  OAuth2Credentials,
  DatabaseCredentials,
} from './types';

// Handler registry (for special handlers only)
export {
  getHandler,
  getAllHandlers,
  hasHandler,
  getHandlerEnvironment,
} from './handlers';

// Special handlers (for direct use if needed)
export { AWSHandler, PostgresHandler, MySQLHandler } from './handlers';
