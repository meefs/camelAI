import type { SqlDatabaseClient } from './sql-database-mcp.js';

/**
 * Warehouse export — the deterministic, Worker-side pieces of a connection's
 * `export` method: the R2 staging key + the data-proxy export request body.
 *
 * The Python warehouse container is SEALED (no network). Data reaches it only via
 * R2: a connection's `export` method resolves credentials server-side and streams
 * the read result to an R2 staging object (the long-running stream runs on the
 * sandbox-host VM, no Worker wall-clock limit); the container reads that object.
 * See docs/warehouse-binding-design.md.
 */

/** Stable, non-cryptographic hash for the R2 staging key (cache identity, not security). */
function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
}

/**
 * Deterministic R2 staging key for a (workspace, connection, query) export.
 * Same inputs → same key, so a re-export overwrites/reuses the same object.
 */
export function warehouseExportKey(workspaceId: string, connection: string, sql: string): string {
  return `warehouse/${slug(workspaceId)}/${slug(connection)}/${fnv1a(sql)}.ndjson`;
}

/**
 * Map a resolved SQL connection client to the engine + data-proxy export body.
 * Pure + unit-testable.
 */
export function sqlClientToExportBody(
  client: SqlDatabaseClient,
  sql: string,
): { engine: 'mysql' | 'postgres'; body: Record<string, unknown> } {
  const base: Record<string, unknown> = {
    mode: 'read',
    host: client.host,
    port: client.port,
    user: client.username,
    password: client.password,
    database: client.database,
    query: sql,
  };
  return client.type === 'postgres'
    ? { engine: 'postgres', body: { ...base, sslmode: client.sslMode } }
    : { engine: 'mysql', body: { ...base, tls: client.tls } };
}

/** A planned export: which engine, the data-proxy request body, and the R2 staging key. */
export interface SqlExportPlan {
  engine: 'mysql' | 'postgres';
  body: Record<string, unknown>;
  r2Key: string;
}

/**
 * Build the full export plan for a SQL connection client — the data-proxy export
 * body + the R2 staging key. Pure; the deploy-gated step is handing the body +
 * a presigned PUT for `r2Key` to the VM `/export-to-r2`.
 */
export function buildSqlExportPlan(
  workspaceId: string,
  connection: string,
  client: SqlDatabaseClient,
  sql: string,
): SqlExportPlan {
  const { engine, body } = sqlClientToExportBody(client, sql);
  return { engine, body, r2Key: warehouseExportKey(workspaceId, connection, sql) };
}
