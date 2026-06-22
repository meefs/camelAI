import { WorkerEntrypoint } from 'cloudflare:workers';
import { listConnections, type ConnectionsRuntimeEnv } from './connections-runtime.js';
import { isSqlDatabaseMcpIntegration } from './sql-database-mcp.js';

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
 * CREDENTIALS: the app's code reaches data through the Sandbox egress proxy
 * (e.g. read_json_auto('http://data-proxy.internal/...?connection=<name>')); the
 * proxy resolves the connection by name — scoped to the container's workspace —
 * and injects credentials server-side. No secrets ever enter the container.
 * See docs/warehouse-binding-design.md.
 */

export interface WarehouseRunRequest {
  /** Python source to execute in the workspace's sandbox (DuckDB strongly preferred). */
  code: string;
}

export interface WarehouseRunResult {
  ok: boolean;
  /** Raw code-interpreter result (stdout/stderr/rich outputs) passed through. */
  result?: unknown;
  error?: string;
}

/** A workspace connection reachable from the warehouse via the connections bridge. */
export interface WarehouseConnection {
  id: string;
  name: string;
  type: string;
  displayName: string;
  /**
   * True if this connection can be STREAMED uncapped into DuckDB via the export
   * bridge (`read_json_auto('http://connections.internal/export?connection=…')`)
   * — the SQL data-proxy types (Postgres/MySQL family). All other connections
   * are still reachable via the invoke bridge (`/invoke`), but go through
   * `invokeConnectionMethod` (JSON result, their own limits), exactly like
   * env.CONNECTIONS in js_exec.
   */
  streamable: boolean;
}

/**
 * Annotate a workspace's full connection catalog with whether each is
 * stream-queryable via the export bridge. Every connection is reachable from the
 * warehouse (via the invoke bridge); `streamable` marks the ones the data-proxy
 * `/export` + createSqlDatabaseClient resolver can stream uncapped. Pure +
 * unit-testable.
 */
export function annotateWarehouseConnections(
  summaries: ReadonlyArray<{ id: string; name: string; type: string; displayName: string }>,
): WarehouseConnection[] {
  return summaries.map((c) => ({
    id: c.id,
    name: c.name,
    type: c.type,
    displayName: c.displayName,
    streamable: isSqlDatabaseMcpIntegration(c.type),
  }));
}

/** Minimal shape of the Sandbox we depend on (keeps WarehouseService testable). */
export interface WarehouseSandboxLike {
  createSession(options: { id: string; cwd?: string }): Promise<WarehouseSessionLike>;
  deleteSession(id: string): Promise<unknown>;
}

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
    const result = await session.runCode(request.code, { language: 'python' });
    return { ok: true, result };
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

interface WarehouseEnv {
  /** DurableObjectNamespace for the Sandbox container (Cloudflare Containers). */
  WAREHOUSE_SANDBOX?: unknown;
}

interface WarehouseServiceProps {
  workspaceId: string;
  orgId: string;
}

export class WarehouseService extends WorkerEntrypoint<WarehouseEnv, WarehouseServiceProps> {
  private sandbox?: WarehouseSandboxLike;

  /** Test seam: override the sandbox. */
  setSandbox(sandbox: WarehouseSandboxLike): void {
    this.sandbox = sandbox;
  }

  async runCode(request: WarehouseRunRequest): Promise<WarehouseRunResult> {
    const sandbox = await this.resolveSandbox();
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

  private async resolveSandbox(): Promise<WarehouseSandboxLike> {
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
    ) as unknown as WarehouseSandboxLike;
    return this.sandbox;
  }
}
