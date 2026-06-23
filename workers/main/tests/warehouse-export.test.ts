import { describe, expect, it } from 'vitest';
import { buildSqlExportPlan, sqlClientToExportBody, stageWarehouseExport, warehouseExportKey } from '../src/warehouse-export.js';
import { listSqlDatabaseMcpTools } from '../src/sql-database-mcp.js';
import { listBigQueryMcpTools } from '../src/bigquery-mcp.js';
import { listClickHouseMcpTools } from '../src/clickhouse-mcp.js';

describe('warehouseExportKey', () => {
  it('is deterministic and namespaced by workspace + connection', () => {
    const k = warehouseExportKey('ws_1', 'Infinity-D365', 'SELECT 1');
    expect(k).toBe(warehouseExportKey('ws_1', 'Infinity-D365', 'SELECT 1'));
    expect(k).toMatch(/^warehouse\/ws_1\/infinity-d365\/[0-9a-f]{8}\.parquet$/);
  });

  it('changes with the query, the connection, and the workspace', () => {
    const base = warehouseExportKey('ws_1', 'c', 'SELECT 1');
    expect(warehouseExportKey('ws_1', 'c', 'SELECT 2')).not.toBe(base);
    expect(warehouseExportKey('ws_1', 'other', 'SELECT 1')).not.toBe(base);
    expect(warehouseExportKey('ws_2', 'c', 'SELECT 1')).not.toBe(base);
  });
});

describe('sqlClientToExportBody', () => {
  const base = { host: 'db', port: 5432, database: 'd', schema: 'public', username: 'u', password: 'p' };

  it('maps a mysql client to the mysql export body (tls)', () => {
    const { engine, body } = sqlClientToExportBody({ ...base, type: 'mysql', tls: 'preferred' }, 'SELECT 1');
    expect(engine).toBe('mysql');
    expect(body).toMatchObject({ mode: 'read', host: 'db', user: 'u', password: 'p', database: 'd', query: 'SELECT 1', tls: 'preferred' });
  });

  it('maps a postgres client to the postgres export body (sslmode)', () => {
    const { engine, body } = sqlClientToExportBody({ ...base, type: 'postgres', sslMode: 'require' }, 'SELECT 2');
    expect(engine).toBe('postgres');
    expect(body).toMatchObject({ mode: 'read', user: 'u', query: 'SELECT 2', sslmode: 'require' });
  });

  it('buildSqlExportPlan combines the export body with the R2 staging key', () => {
    const plan = buildSqlExportPlan('ws_1', 'Infinity-D365', { ...base, type: 'mysql', tls: 'preferred' }, 'SELECT 1');
    expect(plan.engine).toBe('mysql');
    expect(plan.body).toMatchObject({ mode: 'read', query: 'SELECT 1', tls: 'preferred' });
    expect(plan.r2Key).toMatch(/^warehouse\/ws_1\/infinity-d365\/[0-9a-f]{8}\.parquet$/);
  });
});

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

const PART_SIZE = 8 * 1024 * 1024;

/**
 * Fake R2 bucket backed by an object store. Records whether each key was written
 * via a single `put` or via a completed multipart upload, and serves `head` from
 * the store so the post-write durability check sees committed objects.
 */
function fakeBucket() {
  const store = new Map<string, { bytes: Uint8Array; contentType?: string; via: 'put' | 'multipart'; partCount?: number }>();
  const events = { puts: 0, multipartCompletes: 0, aborts: 0 };
  const bucket = {
    async createMultipartUpload(key: string, opts?: { httpMetadata?: { contentType?: string } }) {
      const parts: Uint8Array[] = [];
      return {
        async uploadPart(partNumber: number, data: Uint8Array) {
          parts[partNumber - 1] = data;
          return { partNumber, etag: `etag-${partNumber}` };
        },
        async complete() {
          events.multipartCompletes++;
          const total = parts.reduce((n, p) => n + p.length, 0);
          const all = new Uint8Array(total);
          let o = 0;
          for (const p of parts) { all.set(p, o); o += p.length; }
          store.set(key, { bytes: all, contentType: opts?.httpMetadata?.contentType, via: 'multipart', partCount: parts.length });
        },
        async abort() { events.aborts++; },
      };
    },
    async put(key: string, body: Uint8Array, opts?: { httpMetadata?: { contentType?: string } }) {
      events.puts++;
      store.set(key, { bytes: body, contentType: opts?.httpMetadata?.contentType, via: 'put' });
      return { key };
    },
    async head(key: string) {
      const rec = store.get(key);
      return rec ? { key, size: rec.bytes.length } : null;
    },
  } as unknown as R2Bucket;
  return { bucket, store, events };
}

describe('stageWarehouseExport', () => {
  it('commits a small body with a single put (no multipart) and the format content-type', async () => {
    const { bucket, store, events } = fakeBucket();
    const data = new TextEncoder().encode('hello world');
    const result = await stageWarehouseExport(bucket, 'warehouse/ws/c/abc.parquet', streamOf(data), 'parquet');
    expect(result).toEqual({ ok: true, r2_key: 'warehouse/ws/c/abc.parquet' });
    expect(events.puts).toBe(1);
    expect(events.multipartCompletes).toBe(0);
    const rec = store.get('warehouse/ws/c/abc.parquet')!;
    expect(rec.via).toBe('put');
    expect(rec.contentType).toBe('application/vnd.apache.parquet');
    expect(new TextDecoder().decode(rec.bytes)).toBe('hello world');
  });

  it('writes a 0-byte object via put when the result is empty', async () => {
    const { bucket, store, events } = fakeBucket();
    await stageWarehouseExport(bucket, 'warehouse/ws/c/empty.ndjson', streamOf(), 'ndjson');
    expect(events.puts).toBe(1);
    expect(events.multipartCompletes).toBe(0);
    expect(store.get('warehouse/ws/c/empty.ndjson')!.bytes).toEqual(new Uint8Array(0));
  });

  it('escalates to a multipart upload for a body larger than one part', async () => {
    const { bucket, store, events } = fakeBucket();
    const big = new Uint8Array(PART_SIZE + 1024).fill(7); // > one part
    const tail = new Uint8Array(16).fill(9);
    const result = await stageWarehouseExport(bucket, 'warehouse/ws/c/big.parquet', streamOf(big, tail), 'parquet');
    expect(result.ok).toBe(true);
    expect(events.puts).toBe(0);
    expect(events.multipartCompletes).toBe(1);
    const rec = store.get('warehouse/ws/c/big.parquet')!;
    expect(rec.via).toBe('multipart');
    expect(rec.partCount).toBeGreaterThanOrEqual(2); // never a single-part upload
    expect(rec.bytes.length).toBe(big.length + tail.length);
  });

  it('uses a single put for a one-chunk body of exactly one part (no multipart)', async () => {
    const { bucket, store, events } = fakeBucket();
    const exact = new Uint8Array(PART_SIZE).fill(3);
    await stageWarehouseExport(bucket, 'warehouse/ws/c/exact.parquet', streamOf(exact), 'parquet');
    expect(events.puts).toBe(1);
    expect(events.multipartCompletes).toBe(0);
    expect(store.get('warehouse/ws/c/exact.parquet')!.via).toBe('put');
  });

  it('never completes a single-part multipart when one chunk crosses the threshold then ends', async () => {
    // Regression: a source (e.g. BigQuery enqueuing a whole page) delivers one
    // chunk just over a part and the stream ends. Must split into >= 2 parts and
    // reassemble exactly — not flush the chunk as a lone part and commit nothing.
    const { bucket, store, events } = fakeBucket();
    const oneBigChunk = new Uint8Array(PART_SIZE + 4096).fill(5);
    const result = await stageWarehouseExport(bucket, 'warehouse/ws/c/page.ndjson', streamOf(oneBigChunk), 'ndjson');
    expect(result.ok).toBe(true);
    expect(events.puts).toBe(0);
    const rec = store.get('warehouse/ws/c/page.ndjson')!;
    expect(rec.via).toBe('multipart');
    expect(rec.partCount).toBeGreaterThanOrEqual(2);
    expect(rec.bytes.length).toBe(oneBigChunk.length);
  });

  it('fails loudly when the export source produced no body', async () => {
    const { bucket } = fakeBucket();
    await expect(stageWarehouseExport(bucket, 'k', null, 'parquet')).rejects.toThrow(/no body/);
  });

  it('fails loudly when the write does not persist (HEAD finds no object)', async () => {
    // A bucket whose put silently no-ops — the post-write HEAD must catch it.
    const bucket = {
      async put() { return { key: 'k' }; },
      async head() { return null; },
    } as unknown as R2Bucket;
    await expect(
      stageWarehouseExport(bucket, 'warehouse/ws/c/ghost.ndjson', streamOf(new TextEncoder().encode('x')), 'ndjson'),
    ).rejects.toThrow(/did not persist/);
  });
});

describe('export is a first-class connection method', () => {
  it('appears in the SQL database, BigQuery, and ClickHouse method catalogs (next to execute_sql_readonly)', () => {
    for (const tools of [listSqlDatabaseMcpTools(), listBigQueryMcpTools(), listClickHouseMcpTools()]) {
      const names = tools.map((t) => t.name);
      expect(names).toContain('execute_sql_readonly');
      expect(names).toContain('export');
    }
  });
});
