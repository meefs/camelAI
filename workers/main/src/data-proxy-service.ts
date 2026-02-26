import { WorkerEntrypoint } from 'cloudflare:workers';
import {
  mysqlQuery as dataProxyMysqlQuery,
  mssqlQuery as dataProxyMssqlQuery,
  postgresQuery as dataProxyPostgresQuery,
  type DataProxyEnv,
  type MysqlQueryRequest,
  type MysqlQueryResponse,
  type MssqlQueryRequest,
  type MssqlQueryResponse,
  type PostgresQueryRequest,
  type PostgresQueryResponse,
} from './data-proxy.js';

interface DataProxyServiceProps {
  orgId: string;
  workspaceId: string;
}

export interface DataProxyServiceError {
  message: string;
  status?: number;
  code?: string;
  number?: number;
}

export type DataProxyServiceResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: DataProxyServiceError };

function toServiceError(error: unknown, fallbackMessage: string): DataProxyServiceError {
  return {
    message: error instanceof Error ? error.message : fallbackMessage,
    status: typeof (error as { status?: unknown })?.status === 'number'
      ? (error as { status: number }).status
      : undefined,
    code: typeof (error as { code?: unknown })?.code === 'string'
      ? (error as { code: string }).code
      : undefined,
    number: typeof (error as { number?: unknown })?.number === 'number'
      ? (error as { number: number }).number
      : undefined,
  };
}

/**
 * Virtual service binding entrypoint for user uploaded workers.
 *
 * User workers bind `DATA_PROXY` as a service binding; cf-api-proxy rewrites that
 * binding to this entrypoint with workspace/org props for tenant isolation.
 */
export class DataProxyService extends WorkerEntrypoint<DataProxyEnv, DataProxyServiceProps> {
  private get context(): DataProxyServiceProps {
    return this.ctx.props;
  }

  async mssqlQuery(request: MssqlQueryRequest): Promise<DataProxyServiceResult<MssqlQueryResponse>> {
    try {
      const data = await dataProxyMssqlQuery(this.env, this.context, request);
      return { ok: true, data };
    } catch (error) {
      return {
        ok: false,
        error: toServiceError(error, 'Data proxy query failed'),
      };
    }
  }

  async postgresQuery(request: PostgresQueryRequest): Promise<DataProxyServiceResult<PostgresQueryResponse>> {
    try {
      const data = await dataProxyPostgresQuery(this.env, this.context, request);
      return { ok: true, data };
    } catch (error) {
      return {
        ok: false,
        error: toServiceError(error, 'Data proxy query failed'),
      };
    }
  }

  async mysqlQuery(request: MysqlQueryRequest): Promise<DataProxyServiceResult<MysqlQueryResponse>> {
    try {
      const data = await dataProxyMysqlQuery(this.env, this.context, request);
      return { ok: true, data };
    } catch (error) {
      return {
        ok: false,
        error: toServiceError(error, 'Data proxy query failed'),
      };
    }
  }

}
