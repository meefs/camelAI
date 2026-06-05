import { describe, it, expect, vi } from 'vitest';
import {
  handleMssqlQuery,
  handleMysqlQuery,
  handlePostgresQuery,
} from '../src/routes/data-proxy.js';

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
    expectedPath: '/v1/workspaces/org-1/ws-1/data-proxy/mssql/query',
    handler: handleMssqlQuery,
    body: {
      mode: 'read',
      server: 'db.example.com',
      user: 'user',
      password: 'pass',
      query: 'SELECT 1',
    },
  },
  {
    name: 'postgres',
    path: '/api/postgres/query',
    expectedPath: '/v1/workspaces/org-1/ws-1/data-proxy/postgres/query',
    handler: handlePostgresQuery,
    body: {
      mode: 'read',
      host: 'db.example.com',
      user: 'user',
      password: 'pass',
      query: 'SELECT $1::int as value',
      params: [123],
    },
  },
  {
    name: 'mysql',
    path: '/api/mysql/query',
    expectedPath: '/v1/workspaces/org-1/ws-1/data-proxy/mysql/query',
    handler: handleMysqlQuery,
    body: {
      mode: 'read',
      host: 'db.example.com',
      user: 'user',
      password: 'pass',
      query: 'SELECT ? as value',
      params: [321],
    },
  },
] as const;

describe('data-proxy routes', () => {
  for (const testCase of cases) {
    it(`rejects ${testCase.name} query without sandbox proxy auth`, async () => {
      const req = new Request(`https://camelai.dev${testCase.path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(testCase.body),
      });

      const res = await testCase.handler(buildRouteContext(req, {
        SANDBOX_PROXY_SECRET: 'test-secret',
        SANDBOX_HOST: { fetch: vi.fn() } as unknown as Fetcher,
      }));

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'Unauthorized: sandbox proxy auth required' });
    });

    it(`forwards ${testCase.name} query through SANDBOX_HOST using sandbox identity`, async () => {
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string'
          ? new URL(input)
          : input instanceof URL
            ? input
            : new URL(input.url);
        expect(url.pathname).toBe(testCase.expectedPath);
        expect(init?.method).toBe('POST');

        const forwardedBody = JSON.parse(await new Response(init?.body ?? null).text());
        expect(forwardedBody).toEqual(testCase.body);

        return new Response(JSON.stringify({ recordset: [{ value: 1 }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
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
        SANDBOX_HOST: { fetch: fetchMock } as unknown as Fetcher,
      }));

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ recordset: [{ value: 1 }] });
    });

  }
});
