/**
 * DataProxy - A shared container for accessing data sources that Workers don't support natively.
 * Currently supports: MS SQL Server
 * Stateless - connects, queries, returns results per request.
 */
import { Container } from '@cloudflare/containers';

export interface DataProxyEnv {
  DATA_PROXY: DurableObjectNamespace<DataProxy>;
}

export class DataProxy extends Container<DataProxyEnv> {
  defaultPort = 8080;

  // =============================================================================
  // MS SQL Server
  // =============================================================================

  /**
   * Execute a SQL query against MS SQL Server
   */
  async mssqlQuery(request: MssqlQueryRequest): Promise<MssqlQueryResponse> {
    await this.ensureRunning();

    const response = await this.container!.fetch('http://container/mssql/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });

    return response.json();
  }

  // =============================================================================
  // Health & Lifecycle
  // =============================================================================

  /**
   * Health check
   */
  async health(): Promise<{ status: string }> {
    await this.ensureRunning();

    const response = await this.container!.fetch('http://container/health');
    return response.json();
  }

  /**
   * Ensure container is running
   */
  private async ensureRunning(): Promise<void> {
    if (!this.container) {
      await this.start();
    }
  }
}

// =============================================================================
// MS SQL Server Types
// =============================================================================

export interface MssqlQueryRequest {
  server: string;
  port?: number;
  user: string;
  password: string;
  database?: string;
  query: string;
  params?: Record<string, unknown>;
  encrypt?: boolean;
  trustServerCertificate?: boolean;
  timeout?: number;
}

export interface MssqlQueryResponse {
  recordset?: Record<string, unknown>[];
  recordsets?: Record<string, unknown>[][];
  rowsAffected?: number[];
  error?: string;
  code?: string;
  number?: number;
}
