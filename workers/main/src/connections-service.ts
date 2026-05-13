import { WorkerEntrypoint } from 'cloudflare:workers';
import {
  getConnection,
  invokeConnectionMethod,
  listConnectionMethods,
  listConnections,
  listConnectionTools,
  type ConnectionInvokeRequest,
  type ConnectionMethodCatalogEntry,
  type ConnectionSummary,
  type ConnectionsRuntimeEnv,
} from './connections-runtime.js';

interface ConnectionsServiceProps {
  orgId: string;
  workspaceId: string;
  userId?: string;
}

/**
 * Virtual service binding entrypoint for user uploaded workers.
 *
 * User workers bind `CONNECTIONS` as a service binding; cf-api-proxy rewrites
 * that binding to this entrypoint with workspace/org props for tenant isolation.
 */
export class ConnectionsService extends WorkerEntrypoint<
  ConnectionsRuntimeEnv,
  ConnectionsServiceProps
> {
  private get context(): ConnectionsServiceProps {
    return this.ctx.props;
  }

  async list(): Promise<ConnectionSummary[]> {
    return listConnections(this.env, this.context);
  }

  async get(connection: string): Promise<ConnectionSummary> {
    return getConnection(this.env, this.context, connection);
  }

  async tools(connection: string): Promise<unknown[]> {
    return listConnectionTools(this.env, this.context, connection);
  }

  /**
   * Lists every workspace connection plus the method names and JSON schemas
   * exposed on the method facade, e.g. `connections.stripeProd.listCustomers`.
   */
  async methods(): Promise<ConnectionMethodCatalogEntry[]> {
    return listConnectionMethods(this.env, this.context);
  }

  async __invoke<T = unknown>(request: ConnectionInvokeRequest): Promise<T> {
    return invokeConnectionMethod(this.env, this.context, request) as Promise<T>;
  }
}
