import { describe, expect, it, vi } from 'vitest';
import { mssqlQuery } from '../src/data-proxy.js';

describe('data-proxy response limits', () => {
  it('rejects oversized JSON responses', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      recordset: [{ value: 'this payload is intentionally long' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    await expect(mssqlQuery(
      {
        SANDBOX_HOST: { fetch: fetchMock } as unknown as Fetcher,
        DATA_PROXY_MAX_RESPONSE_BYTES: '32',
      },
      { orgId: 'org-1', workspaceId: 'ws-1' },
      {
        mode: 'read',
        server: 'db.example.com',
        user: 'user',
        password: 'pass',
        query: 'SELECT 1',
      },
    )).rejects.toMatchObject({
      status: 413,
    });
  });
});
