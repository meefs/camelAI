import { WorkerEntrypoint } from 'cloudflare:workers';
import {
  callConnectionTool,
  getConnection,
  listConnections,
  listConnectionTools,
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

  async call<T = unknown>(
    connection: string,
    tool: string,
    input: Record<string, unknown> = {}
  ): Promise<T> {
    return callConnectionTool(this.env, this.context, connection, tool, input) as Promise<T>;
  }
}
