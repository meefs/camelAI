import type { SqlDatabaseClient } from './sql-database-mcp.js';

/**
 * Warehouse export — the deterministic, Worker-side pieces of a connection's
 * `export` method: the R2 staging key + the data-proxy export request body.
 *
 * The Python warehouse container is SEALED (no network). Data reaches it only via
 * R2: a connection's `export` method resolves credentials server-side and streams
 * the read result to an R2 staging object (SQL streams run on the project-runtime
 * data-proxy VM with no Worker wall-clock limit; ClickHouse/BigQuery stream from
 * the Worker); the container then reads that object via a read-only R2 mount.
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

export type WarehouseExportFormat = 'parquet' | 'ndjson';

/**
 * R2 key prefix for a workspace's warehouse exports. The sealed container mounts
 * exactly this prefix (read-only), so a workspace can only ever see its own
 * staged objects — the bucket is multi-tenant-safe.
 */
export function warehouseWorkspacePrefix(workspaceId: string): string {
  return `warehouse/${slug(workspaceId)}`;
}

/**
 * Deterministic R2 staging key for a (workspace, connection, query) export.
 * Same inputs → same key, so a re-export overwrites/reuses the same object.
 * Namespaced by workspace (see warehouseWorkspacePrefix).
 *
 * `connectionId` MUST be the integration's unique id, not its display name — two
 * different integrations (e.g. a Postgres and a ClickHouse) can share a name
 * (uniqueness is only enforced per integration_type), so keying by name would
 * collide and silently overwrite/cross-read each other's exports.
 */
export function warehouseExportKey(
  workspaceId: string,
  connectionId: string,
  sql: string,
  format: WarehouseExportFormat = 'parquet',
): string {
  return `${warehouseWorkspacePrefix(workspaceId)}/${slug(connectionId)}/${fnv1a(sql)}.${format}`;
}

/**
 * Where an export's `r2_key` is readable inside the sealed container. The bucket
 * is mounted at `/${prefix}`, so the object lands at exactly `/${r2_key}`.
 */
export function warehouseContainerPath(r2Key: string): string {
  return `/${r2Key}`;
}

const EXPORT_CONTENT_TYPE: Record<WarehouseExportFormat, string> = {
  parquet: 'application/vnd.apache.parquet',
  ndjson: 'application/x-ndjson',
};

// R2 multipart parts (except the last) must be >= 5 MiB; buffer to 8 MiB so a
// large export streams through in bounded memory.
const WAREHOUSE_EXPORT_PART_SIZE = 8 * 1024 * 1024;

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Stream an export body into the warehouse R2 staging bucket via a multipart
 * upload and return the object handle.
 *
 * The export bodies are chunked (ClickHouse/data-proxy responses, the BigQuery
 * pager) with no Content-Length, so `R2.put(stream)` rejects them ("readable
 * stream must have a known length"). Multipart upload sidesteps that: each part
 * has a known length while the total stays unknown, and only ~one part (8 MiB)
 * is ever held in memory, so a multi-GB export never OOMs the Worker. Aborts the
 * upload on any failure so no partial object is left behind.
 */
export async function stageWarehouseExport(
  bucket: R2Bucket,
  key: string,
  body: ReadableStream<Uint8Array> | null,
  format: WarehouseExportFormat,
): Promise<{ ok: true; r2_key: string }> {
  if (!body) {
    throw Object.assign(new Error('export source returned no body'), { status: 502 });
  }
  const httpMetadata = { contentType: EXPORT_CONTENT_TYPE[format] };
  const upload = await bucket.createMultipartUpload(key, { httpMetadata });
  try {
    const reader = body.getReader();
    const parts: R2UploadedPart[] = [];
    let buffered: Uint8Array[] = [];
    let bufferedBytes = 0;

    const flushPart = async () => {
      const data = concatChunks(buffered, bufferedBytes);
      parts.push(await upload.uploadPart(parts.length + 1, data));
      buffered = [];
      bufferedBytes = 0;
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length) {
        buffered.push(value);
        bufferedBytes += value.length;
        if (bufferedBytes >= WAREHOUSE_EXPORT_PART_SIZE) await flushPart();
      }
    }
    if (bufferedBytes > 0) await flushPart();

    if (parts.length === 0) {
      // Empty result: a multipart upload needs >= 1 part, so write an empty object instead.
      await upload.abort();
      await bucket.put(key, new Uint8Array(0), { httpMetadata });
    } else {
      await upload.complete(parts);
    }
    return { ok: true, r2_key: key };
  } catch (error) {
    await upload.abort().catch(() => {});
    throw error;
  }
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
  connectionId: string,
  client: SqlDatabaseClient,
  sql: string,
): SqlExportPlan {
  const { engine, body } = sqlClientToExportBody(client, sql);
  // The data-proxy /export streams Parquet (see project-runtime-service cmd/data-proxy).
  return { engine, body, r2Key: warehouseExportKey(workspaceId, connectionId, sql, 'parquet') };
}
