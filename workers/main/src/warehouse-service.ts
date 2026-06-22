import { WorkerEntrypoint } from 'cloudflare:workers';
import { listConnections, type ConnectionsRuntimeEnv } from './connections-runtime.js';
import { isSqlDatabaseMcpIntegration } from './sql-database-mcp.js';
import { isBigQueryMcpIntegration } from './bigquery-mcp.js';
import { isClickHouseMcpIntegration } from './clickhouse-mcp.js';
import { warehouseWorkspacePrefix } from './warehouse-export.js';

/**
 * Virtual WAREHOUSE service binding entrypoint for user-uploaded workers.
 *
 * User workers bind `WAREHOUSE` as a service binding; cf-api-proxy rewrites that
 * binding to this entrypoint with workspace/org props for tenant isolation
 * (mirroring DataProxyService). It's a thin wrapper over the Cloudflare Sandbox
 * SDK code interpreter: the app runs its own Python/JS (DuckDB, pandas, …) in a
 * per-workspace container to do heavy cross-source analytics off the Durable
 * Object.
 *
 * ISOLATION: one warm container per workspace (sandboxId = workspaceId), but a
 * fresh SESSION per call (own working directory), so concurrent calls on the
 * same workspace never clobber each other's files. The session is deleted when
 * the call finishes.
 *
 * DATA: the container is SEALED (no network). Data reaches it via R2 — a
 * connection's `export` method (see sql-database-mcp / bigquery-mcp) streams a
 * read query's full result to an R2 staging object server-side; the container's
 * DuckDB reads that object. No credential ever enters the container.
 * See docs/warehouse-binding-design.md.
 */

export interface WarehouseRunRequest {
  /** Python source to execute in the workspace's sandbox (DuckDB strongly preferred). */
  code: string;
  /**
   * Optional values injected into the Python runtime as a `params` dict (e.g.
   * `{ r2_key }`), so callers reference `params["r2_key"]` instead of
   * interpolating values into the code string (which is fragile with special
   * characters). JSON-serializable values only.
   */
  params?: Record<string, unknown>;
}

export interface WarehouseRunResult {
  ok: boolean;
  /** Captured stdout (everything the code `print()`ed), already joined. */
  stdout?: string;
  /** Captured stderr. */
  stderr?: string;
  /** Raw code-interpreter result (rich outputs, execution metadata) passed through. */
  result?: unknown;
  error?: string;
}

/** A workspace connection, annotated for warehouse use. */
export interface WarehouseConnection {
  id: string;
  name: string;
  type: string;
  displayName: string;
  /**
   * True if this connection has an `export` method — i.e. its full query result
   * can be staged to R2 for the warehouse (`connections[alias].export({ query })`).
   * That's the SQL database family (Postgres/MySQL/Neon/PlanetScale), BigQuery,
   * and ClickHouse today; other types don't have an `export` method yet.
   */
  exportable: boolean;
}

/**
 * Annotate a workspace's connection catalog with whether each has an `export`
 * method (and can therefore feed the warehouse). Pure + unit-testable.
 */
export function annotateWarehouseConnections(
  summaries: ReadonlyArray<{ id: string; name: string; type: string; displayName: string }>,
): WarehouseConnection[] {
  return summaries.map((c) => ({
    id: c.id,
    name: c.name,
    type: c.type,
    displayName: c.displayName,
    exportable:
      isSqlDatabaseMcpIntegration(c.type) ||
      isBigQueryMcpIntegration(c.type) ||
      isClickHouseMcpIntegration(c.type),
  }));
}

/** Minimal shape of the Sandbox we depend on (keeps WarehouseService testable). */
export interface WarehouseSandboxLike {
  createSession(options: { id: string; cwd?: string }): Promise<WarehouseSessionLike>;
  deleteSession(id: string): Promise<unknown>;
}

/**
 * The real sandbox stub adds the container-side mount method (a custom method on
 * WarehouseSandbox, reachable via the getSandbox DO-RPC proxy).
 */
export interface WarehouseSandboxStub extends WarehouseSandboxLike {
  ensureExportsMounted(bucketBinding: string, prefix: string): Promise<void>;
}

/** The R2 binding name the container's s3fs egress mount routes to. */
export const WAREHOUSE_EXPORT_BUCKET_BINDING = 'WAREHOUSE_EXPORT_BUCKET';

export interface WarehouseSessionLike {
  runCode(code: string, options?: { language?: string }): Promise<unknown>;
}

/**
 * Run code in a fresh, isolated session of the workspace's sandbox. A unique
 * session id + working directory per call prevents file overlap between
 * concurrent calls; the session is always cleaned up. Pure of `this`, so it can
 * be unit-tested with a fake sandbox.
 */
export async function runWarehouseCode(
  request: WarehouseRunRequest,
  deps: { sandbox: WarehouseSandboxLike; newSessionId: () => string },
): Promise<WarehouseRunResult> {
  if (!request.code || !request.code.trim()) {
    return { ok: false, error: 'Warehouse code is empty' };
  }
  const sessionId = `call-${deps.newSessionId()}`;
  let session: WarehouseSessionLike;
  try {
    session = await deps.sandbox.createSession({ id: sessionId, cwd: `/sessions/${sessionId}` });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Failed to create session' };
  }
  try {
    // Python-only by design — DuckDB's first-class API is Python, and this tier
    // is for DuckDB-via-Python analytics.
    const code = withWarehouseParams(request.code, request.params);
    const result = await session.runCode(code, { language: 'python' });
    const { stdout, stderr } = extractWarehouseStdio(result);
    // The interpreter RESOLVES (doesn't throw) on a Python error, setting
    // result.error — surface it as ok: false so callers don't treat a failed
    // analysis (bad read_parquet path, DuckDB exception, …) as success.
    const codeError = extractWarehouseError(result);
    if (codeError) return { ok: false, error: codeError, result, stdout, stderr };
    return { ok: true, result, stdout, stderr };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Warehouse code failed' };
  } finally {
    // Best-effort cleanup; never mask the run result with a teardown error.
    try {
      await deps.sandbox.deleteSession(sessionId);
    } catch {
      /* session teardown is best-effort */
    }
  }
}

/**
 * Prepend a `params` dict to the Python code so callers reference
 * `params["r2_key"]` instead of interpolating values into the code string.
 * The values are embedded as a JSON string and parsed with `json.loads`, so
 * arbitrary content (special characters, quotes) is safe.
 */
export function withWarehouseParams(code: string, params?: Record<string, unknown>): string {
  if (!params || Object.keys(params).length === 0) return code;
  // Double-encode: inner produces JSON, outer produces a Python string literal of it.
  const literal = JSON.stringify(JSON.stringify(params));
  return `import json as _wh_json\nparams = _wh_json.loads(${literal})\ndel _wh_json\n${code}`;
}

/**
 * Flatten the code-interpreter result's nested logs into plain stdout/stderr
 * strings so callers don't have to dig through `result.logs.stdout[0]`.
 */
export function extractWarehouseStdio(result: unknown): { stdout?: string; stderr?: string } {
  const logs = (result as { logs?: { stdout?: unknown; stderr?: unknown } } | null | undefined)?.logs;
  const join = (value: unknown): string | undefined => {
    if (Array.isArray(value)) return value.map((part) => String(part)).join('');
    if (typeof value === 'string') return value;
    return undefined;
  };
  return { stdout: join(logs?.stdout), stderr: join(logs?.stderr) };
}

/**
 * The code interpreter reports a Python failure by resolving with an `error`
 * field (name/message/traceback) rather than throwing. Return a human-readable
 * message when that happened, else undefined.
 */
export function extractWarehouseError(result: unknown): string | undefined {
  const error = (result as { error?: { name?: unknown; message?: unknown } } | null | undefined)?.error;
  if (!error || typeof error !== 'object') return undefined;
  const name = typeof error.name === 'string' ? error.name : '';
  const message = typeof error.message === 'string' ? error.message : '';
  return [name, message].filter(Boolean).join(': ') || 'Warehouse code raised an error';
}

interface WarehouseEnv {
  /** DurableObjectNamespace for the Sandbox container (Cloudflare Containers). */
  WAREHOUSE_SANDBOX?: unknown;
  /** Auto-expiring R2 staging bucket; mounted read-only into the container. */
  WAREHOUSE_EXPORT_BUCKET?: R2Bucket;
}

interface WarehouseServiceProps {
  workspaceId: string;
  orgId: string;
}

export class WarehouseService extends WorkerEntrypoint<WarehouseEnv, WarehouseServiceProps> {
  private sandbox?: WarehouseSandboxStub;

  /** Test seam: override the sandbox. */
  setSandbox(sandbox: WarehouseSandboxStub): void {
    this.sandbox = sandbox;
  }

  async runCode(request: WarehouseRunRequest): Promise<WarehouseRunResult> {
    const sandbox = await this.resolveSandbox();
    // Mount the workspace's staged exports read-only so DuckDB can read them.
    // The container mounts once per its lifecycle (see WarehouseSandbox); this is
    // a cheap no-op on a warm container.
    if (this.env.WAREHOUSE_EXPORT_BUCKET) {
      try {
        await sandbox.ensureExportsMounted(
          WAREHOUSE_EXPORT_BUCKET_BINDING,
          warehouseWorkspacePrefix(this.ctx.props.workspaceId),
        );
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? `warehouse mount failed: ${error.message}` : 'warehouse mount failed',
        };
      }
    }
    return runWarehouseCode(request, {
      sandbox,
      newSessionId: () => crypto.randomUUID(),
    });
  }

  /**
   * List the workspace connections reachable from the warehouse, annotated with
   * whether each is stream-queryable (SQL) or invoke-only.
   */
  async listConnections(): Promise<WarehouseConnection[]> {
    const summaries = await listConnections(this.env as unknown as ConnectionsRuntimeEnv, {
      orgId: this.ctx.props.orgId,
      workspaceId: this.ctx.props.workspaceId,
    });
    return annotateWarehouseConnections(summaries);
  }

  private async resolveSandbox(): Promise<WarehouseSandboxStub> {
    if (this.sandbox) return this.sandbox;
    if (!this.env.WAREHOUSE_SANDBOX) {
      throw new Error('WAREHOUSE_SANDBOX container binding is not configured');
    }
    const { getSandbox } = await import('@cloudflare/sandbox');
    // One warm container per workspace; per-call isolation is via sessions.
    this.sandbox = getSandbox(
      this.env.WAREHOUSE_SANDBOX as Parameters<typeof getSandbox>[0],
      this.ctx.props.workspaceId,
      { normalizeId: true },
    ) as unknown as WarehouseSandboxStub;
    return this.sandbox;
  }
}
