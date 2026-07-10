import { describe, it, expect } from 'vitest';
import {
  handleMssqlQuery,
  handleMysqlQuery,
  handlePostgresQuery,
} from '../src/routes/data-proxy.js';
import { fakeDbQuerySandboxNamespace } from './fake-db-query-sandbox.js';

function buildRouteContext(req: Request, env: Record<string, unknown>) {
  return {
    req,
    env: env as never,
    ctx: { waitUntil: (_p: Promise<unknown>) => undefined } as never,
    url: new URL(req.url),
    match: [] as unknown as RegExpMatchArray,
  };
}

const cases = [
  {
    name: 'mssql',
    path: '/api/mssql/query',
    handler: handleMssqlQuery,
    body: {
      mode: 'read',
      server: 'db.example.com',
      user: 'user',
      password: 'pass',
      query: 'SELECT 1',
    },
    // Legacy Go defaults the compat layer must reproduce.
    expectedRequest: {
      engine: 'mssql',
      mode: 'read',
      sql: 'SELECT 1',
      target: { host: 'db.example.com', port: 1433, database: 'master', sslMode: 'require' },
    },
  },
  {
    name: 'postgres',
    path: '/api/postgres/query',
    handler: handlePostgresQuery,
    body: {
      mode: 'read',
      host: 'db.example.com',
      user: 'user',
      password: 'pass',
      query: 'SELECT $1::int as value',
      params: [123],
    },
    expectedRequest: {
      engine: 'postgres',
      mode: 'read',
      sql: 'SELECT $1::int as value',
      params: [123],
      target: { host: 'db.example.com', port: 5432, database: 'postgres', sslMode: 'require' },
    },
  },
  {
    name: 'mysql',
    path: '/api/mysql/query',
    handler: handleMysqlQuery,
    body: {
      mode: 'read',
      host: 'db.example.com',
      user: 'user',
      password: 'pass',
      query: 'SELECT ? as value',
      params: [321],
    },
    expectedRequest: {
      engine: 'mysql',
      mode: 'read',
      sql: 'SELECT ? as value',
      params: [321],
      target: { host: 'db.example.com', port: 3306, database: '', sslMode: 'prefer' },
    },
  },
] as const;

describe('data-proxy routes', () => {
  for (const testCase of cases) {
    it(`rejects ${testCase.name} query without sandbox proxy auth`, async () => {
      const fake = fakeDbQuerySandboxNamespace(() => ({ ok: true, rows: [], fields: [], rowCount: 0, truncated: false, durationMs: 1 }));
      const req = new Request(`https://camelai.dev${testCase.path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(testCase.body),
      });

      const res = await testCase.handler(buildRouteContext(req, {
        SANDBOX_PROXY_SECRET: 'test-secret',
        DB_QUERY_SANDBOX: fake.namespace,
      }));

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'Unauthorized: sandbox proxy auth required' });
      expect(fake.calls).toHaveLength(0);
    });

    it(`runs ${testCase.name} query in the db-query sandbox with the legacy request mapping`, async () => {
      const fake = fakeDbQuerySandboxNamespace((request) => {
        expect(request).toMatchObject(testCase.expectedRequest);
        // Legacy surfaces are uncapped-rows + byte-capped, never row-limited.
        expect(request.rowLimit).toBeNull();
        return { ok: true, rows: [{ value: 1 }], fields: [{ name: 'value' }], rowCount: 1, truncated: false, durationMs: 2 };
      });

      const req = new Request(`https://camelai.dev${testCase.path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-sandbox-secret': 'test-secret',
          'x-chiridion-org-id': 'org-1',
          'x-chiridion-workspace-id': 'ws-1',
        },
        body: JSON.stringify(testCase.body),
      });

      const res = await testCase.handler(buildRouteContext(req, {
        SANDBOX_PROXY_SECRET: 'test-secret',
        DB_QUERY_SANDBOX: fake.namespace,
      }));

      expect(fake.calls).toHaveLength(1);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ recordset: [{ value: 1 }] });
    });
  }

  it('modify mode returns rowsAffected only', async () => {
    const fake = fakeDbQuerySandboxNamespace((request) => {
      expect(request.mode).toBe('modify');
      return { ok: true, rows: [], fields: [], rowCount: 0, truncated: false, durationMs: 2, rowsAffected: [3] };
    });
    const req = new Request('https://camelai.dev/api/postgres/query', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-sandbox-secret': 'test-secret',
        'x-chiridion-org-id': 'org-1',
        'x-chiridion-workspace-id': 'ws-1',
      },
      body: JSON.stringify({
        mode: 'modify',
        host: 'db.example.com',
        user: 'user',
        password: 'pass',
        query: 'UPDATE t SET x = 1',
      }),
    });

    const res = await handlePostgresQuery(buildRouteContext(req, {
      SANDBOX_PROXY_SECRET: 'test-secret',
      DB_QUERY_SANDBOX: fake.namespace,
    }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rowsAffected: [3] });
  });

  it('surfaces runner errors with the legacy status', async () => {
    const fake = fakeDbQuerySandboxNamespace(() => ({
      ok: false,
      error: { message: 'connect ECONNREFUSED', code: 'ECONNREFUSED' },
    }));
    const req = new Request('https://camelai.dev/api/postgres/query', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-sandbox-secret': 'test-secret',
        'x-chiridion-org-id': 'org-1',
        'x-chiridion-workspace-id': 'ws-1',
      },
      body: JSON.stringify({
        mode: 'read',
        host: 'db.example.com',
        user: 'user',
        password: 'pass',
        query: 'SELECT 1',
      }),
    });

    const res = await handlePostgresQuery(buildRouteContext(req, {
      SANDBOX_PROXY_SECRET: 'test-secret',
      DB_QUERY_SANDBOX: fake.namespace,
    }));

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'connect ECONNREFUSED' });
  });
});
