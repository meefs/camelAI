import { afterEach, describe, expect, it, vi } from 'vitest';
import { encryptCredentials } from '../../../src/lib/integration-crypto';
import { bigQueryMcpRpc } from '../src/bigquery-mcp.js';
import type { WorkspaceIntegrationRecord } from '../src/workspace.js';

const SECRET = 'test-secret';

async function bigQueryRecord(config: Record<string, unknown> = { project_id: 'demo-project' }): Promise<WorkspaceIntegrationRecord> {
  return {
    id: 'bq1',
    name: 'analytics',
    integration_type: 'bigquery',
    category: 'databases',
    config: JSON.stringify(config),
    credentials_encrypted: await encryptCredentials(
      { access_token: 'tok', expires_at: Date.now() + 3_600_000 },
      SECRET,
    ),
  } as unknown as WorkspaceIntegrationRecord;
}

function fakeBucket() {
  // stageWarehouseExport streams via multipart upload; reassemble the parts (or
  // the empty-object fallback) into the final object text for assertions.
  const puts: Array<{ key: string; text: string; opts: unknown }> = [];
  const decode = (chunks: Uint8Array[]) => {
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return new TextDecoder().decode(out);
  };
  const bucket = {
    async createMultipartUpload(key: string, opts: unknown) {
      const parts: Uint8Array[] = [];
      return {
        async uploadPart(partNumber: number, data: Uint8Array) {
          parts.push(data);
          return { partNumber, etag: `e${partNumber}` };
        },
        async complete() { puts.push({ key, text: decode(parts), opts }); },
        async abort() {},
      };
    },
    async put(key: string, body: Uint8Array, opts: unknown) {
      puts.push({ key, text: decode([body ?? new Uint8Array(0)]), opts });
      return { key };
    },
    // stageWarehouseExport HEAD-verifies the object after writing.
    async head(key: string) {
      return puts.some((p) => p.key === key) ? { key } : null;
    },
  } as unknown as R2Bucket;
  return { bucket, puts };
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** The read-only guard dry-runs against /jobs; default it to a SELECT statement type. */
function dryRunResponse(statementType = 'SELECT'): Response {
  return jsonResponse({ statistics: { query: { statementType } } });
}
function isDryRun(u: string, method: string): boolean {
  return method === 'POST' && u.endsWith('/projects/demo-project/jobs');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('BigQuery warehouse export', () => {
  it('pages through every result page and streams NDJSON to R2', async () => {
    const record = await bigQueryRecord();
    const { bucket, puts } = fakeBucket();

    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      calls.push({ url: u, method });
      if (isDryRun(u, method)) return dryRunResponse();
      if (method === 'POST' && u.endsWith('/projects/demo-project/queries')) {
        return jsonResponse({
          jobComplete: true,
          jobReference: { jobId: 'job1', location: 'US' },
          schema: { fields: [{ name: 'id', type: 'INTEGER' }, { name: 'name', type: 'STRING' }] },
          rows: [{ f: [{ v: '1' }, { v: 'a' }] }],
          pageToken: 't2',
        });
      }
      if (method === 'GET' && u.includes('/queries/job1') && u.includes('pageToken=t2')) {
        return jsonResponse({
          jobComplete: true,
          rows: [{ f: [{ v: '2' }, { v: 'b' }] }],
        });
      }
      throw new Error(`unexpected fetch: ${method} ${u}`);
    }));

    const result = await bigQueryMcpRpc(
      { INTEGRATION_SECRET_KEY: SECRET, WAREHOUSE_EXPORT_BUCKET: bucket } as never,
      { workspaceId: 'ws1' },
      record,
      'tools/call',
      { name: 'export', arguments: { query: 'SELECT id, name FROM t' } },
    ) as { ok: boolean; r2_key: string; rows: number; columns: string[] };

    expect(result.ok).toBe(true);
    // Keyed by the unique integration id (bq1), not the display name.
    expect(result.r2_key).toMatch(/^warehouse\/ws1\/bq1\/[0-9a-f]{8}\.ndjson$/);
    expect(result.rows).toBe(2);
    expect(result.columns).toEqual(['id', 'name']);
    expect(puts).toHaveLength(1);
    expect(puts[0]!.text).toBe('{"id":"1","name":"a"}\n{"id":"2","name":"b"}\n');
    expect(puts[0]!.opts).toMatchObject({ httpMetadata: { contentType: 'application/x-ndjson' } });
    // The second page must have been fetched via getQueryResults with the page token + location.
    expect(calls.some((c) => c.method === 'GET' && c.url.includes('location=US') && c.url.includes('pageToken=t2'))).toBe(true);
  });

  it('returns rows: 0 + columns for an empty result (an empty NDJSON file is unreadable)', async () => {
    const record = await bigQueryRecord();
    const { bucket, puts } = fakeBucket();

    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (isDryRun(u, method)) return dryRunResponse();
      if (method === 'POST' && u.endsWith('/projects/demo-project/queries')) {
        // Completed with a schema but zero rows.
        return jsonResponse({
          jobComplete: true,
          jobReference: { jobId: 'job1' },
          schema: { fields: [{ name: 'id', type: 'INTEGER' }, { name: 'name', type: 'STRING' }] },
          rows: [],
        });
      }
      throw new Error(`unexpected fetch: ${method} ${u}`);
    }));

    const result = await bigQueryMcpRpc(
      { INTEGRATION_SECRET_KEY: SECRET, WAREHOUSE_EXPORT_BUCKET: bucket } as never,
      { workspaceId: 'ws1' },
      record,
      'tools/call',
      { name: 'export', arguments: { query: 'SELECT id, name FROM t WHERE 1 = 0' } },
    ) as { ok: boolean; rows: number; columns: string[] };

    expect(result.ok).toBe(true);
    expect(result.rows).toBe(0); // explicit no-rows signal
    expect(result.columns).toEqual(['id', 'name']); // schema the empty file can't convey
    expect(puts[0]!.text).toBe(''); // empty object written
  });

  it('rejects a non-read statement (DELETE) before launching the export job', async () => {
    const record = await bigQueryRecord();
    const { bucket, puts } = fakeBucket();

    let ranQuery = false;
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (isDryRun(u, method)) return dryRunResponse('DELETE'); // BigQuery's dry-run reports the statement type
      if (method === 'POST' && u.endsWith('/projects/demo-project/queries')) {
        ranQuery = true;
        return jsonResponse({ jobComplete: true });
      }
      throw new Error(`unexpected fetch: ${method} ${u}`);
    }));

    const error = await bigQueryMcpRpc(
      { INTEGRATION_SECRET_KEY: SECRET, WAREHOUSE_EXPORT_BUCKET: bucket } as never,
      { workspaceId: 'ws1' },
      record,
      'tools/call',
      { name: 'export', arguments: { query: 'DELETE FROM t WHERE id = 1' } },
    ).catch((caught: unknown) => caught);

    expect((error as Error | undefined)?.message).toMatch(/read-only/i);
    expect((error as Error | undefined)?.message).toMatch(/DELETE/);
    expect(ranQuery).toBe(false); // never executed the statement
    expect(puts).toHaveLength(0); // nothing staged
  });

  it("applies the connection's default dataset so unqualified queries resolve", async () => {
    const record = await bigQueryRecord({ project_id: 'demo-project', dataset: 'analytics_ds' });
    const { bucket } = fakeBucket();

    let postBody: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (isDryRun(u, method)) return dryRunResponse();
      if (method === 'POST' && u.endsWith('/projects/demo-project/queries')) {
        postBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({
          jobComplete: true,
          jobReference: { jobId: 'job1' },
          schema: { fields: [{ name: 'id', type: 'INTEGER' }] },
          rows: [{ f: [{ v: '1' }] }],
        });
      }
      throw new Error(`unexpected fetch: ${method} ${u}`);
    }));

    await bigQueryMcpRpc(
      { INTEGRATION_SECRET_KEY: SECRET, WAREHOUSE_EXPORT_BUCKET: bucket } as never,
      { workspaceId: 'ws1' },
      record,
      'tools/call',
      { name: 'export', arguments: { query: 'SELECT * FROM users' } },
    );

    // Unqualified `users` must resolve against the connection's default dataset,
    // exactly like execute_sql_readonly.
    expect(postBody?.defaultDataset).toEqual({ projectId: 'demo-project', datasetId: 'analytics_ds' });
    // ...and the default fail-without-charge billing cap is applied.
    expect(postBody?.maximumBytesBilled).toBe('1000000000');
  });

  it('applies a caller-provided maximumBytesBilled billing cap', async () => {
    const record = await bigQueryRecord();
    const { bucket } = fakeBucket();

    let postBody: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (isDryRun(u, method)) return dryRunResponse();
      if (method === 'POST' && u.endsWith('/projects/demo-project/queries')) {
        postBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({ jobComplete: true, jobReference: { jobId: 'j' }, schema: { fields: [] }, rows: [] });
      }
      throw new Error(`unexpected fetch: ${method} ${u}`);
    }));

    await bigQueryMcpRpc(
      { INTEGRATION_SECRET_KEY: SECRET, WAREHOUSE_EXPORT_BUCKET: bucket } as never,
      { workspaceId: 'ws1' },
      record,
      'tools/call',
      { name: 'export', arguments: { query: 'SELECT * FROM big', maximumBytesBilled: '50000000000' } },
    );

    expect(postBody?.maximumBytesBilled).toBe('50000000000');
  });

  it('lets a caller-provided datasetId override the default', async () => {
    const record = await bigQueryRecord({ project_id: 'demo-project', dataset: 'analytics_ds' });
    const { bucket } = fakeBucket();

    let postBody: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (isDryRun(u, method)) return dryRunResponse();
      if (method === 'POST' && u.endsWith('/projects/demo-project/queries')) {
        postBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({ jobComplete: true, jobReference: { jobId: 'j' }, schema: { fields: [] }, rows: [] });
      }
      throw new Error(`unexpected fetch: ${method} ${u}`);
    }));

    await bigQueryMcpRpc(
      { INTEGRATION_SECRET_KEY: SECRET, WAREHOUSE_EXPORT_BUCKET: bucket } as never,
      { workspaceId: 'ws1' },
      record,
      'tools/call',
      { name: 'export', arguments: { query: 'SELECT * FROM t', datasetId: 'other_ds' } },
    );

    expect(postBody?.defaultDataset).toEqual({ projectId: 'demo-project', datasetId: 'other_ds' });
  });
});
