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

/** Fake R2 bucket recording multipart upload lifecycle + the empty-object fallback. */
function fakeMultipartBucket() {
  const uploads: Array<{
    key: string;
    contentType?: string;
    parts: Array<{ partNumber: number; bytes: Uint8Array }>;
    completed: boolean;
    aborted: boolean;
    emptyPut?: Uint8Array;
  }> = [];
  const bucket = {
    async createMultipartUpload(key: string, opts?: { httpMetadata?: { contentType?: string } }) {
      const rec = { key, contentType: opts?.httpMetadata?.contentType, parts: [] as Array<{ partNumber: number; bytes: Uint8Array }>, completed: false, aborted: false };
      uploads.push(rec);
      return {
        async uploadPart(partNumber: number, data: Uint8Array) {
          rec.parts.push({ partNumber, bytes: data });
          return { partNumber, etag: `etag-${partNumber}` };
        },
        async complete() { rec.completed = true; },
        async abort() { rec.aborted = true; },
      };
    },
    async put(key: string, body: Uint8Array, _opts: unknown) {
      const rec = uploads.find((u) => u.key === key);
      if (rec) rec.emptyPut = body;
      return { key };
    },
  } as unknown as R2Bucket;
  return { bucket, uploads };
}

describe('stageWarehouseExport', () => {
  it('streams the body to R2 via multipart with the format content-type', async () => {
    const { bucket, uploads } = fakeMultipartBucket();
    const data = new TextEncoder().encode('hello world');
    const result = await stageWarehouseExport(bucket, 'warehouse/ws/c/abc.parquet', streamOf(data), 'parquet');
    expect(result).toEqual({ ok: true, r2_key: 'warehouse/ws/c/abc.parquet' });
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.contentType).toBe('application/vnd.apache.parquet');
    expect(uploads[0]!.completed).toBe(true);
    // The streamed bytes are uploaded as part(s) reassembling to the original.
    const assembled = uploads[0]!.parts.flatMap((p) => [...p.bytes]);
    expect(new TextDecoder().decode(new Uint8Array(assembled))).toBe('hello world');
    expect(uploads[0]!.parts[0]!.partNumber).toBe(1);
  });

  it('writes an empty object (no dangling multipart) when the result is empty', async () => {
    const { bucket, uploads } = fakeMultipartBucket();
    await stageWarehouseExport(bucket, 'warehouse/ws/c/empty.ndjson', streamOf(), 'ndjson');
    expect(uploads[0]!.parts).toHaveLength(0);
    expect(uploads[0]!.aborted).toBe(true);
    expect(uploads[0]!.emptyPut).toEqual(new Uint8Array(0));
  });

  it('fails loudly when the export source produced no body', async () => {
    const { bucket, uploads } = fakeMultipartBucket();
    await expect(stageWarehouseExport(bucket, 'k', null, 'parquet')).rejects.toThrow(/no body/);
    expect(uploads).toHaveLength(0);
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
