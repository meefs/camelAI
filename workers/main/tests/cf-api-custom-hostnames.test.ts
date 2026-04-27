import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createOrRefreshCustomHostname } from '../src/cf-api-proxy';

function cfResponse(result: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify({ success: true, result }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

function cfError(status = 400) {
  return new Response(JSON.stringify({ success: false, errors: [{ code: 1406 }] }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('createOrRefreshCustomHostname', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a newly-created custom hostname without refreshing validation', async () => {
    const created = {
      id: 'hostname-1',
      hostname: 'demo.apps.example.com',
      ssl: { status: 'pending_validation', method: 'txt', type: 'dv' },
      status: 'pending',
      created_at: '2026-04-27T00:00:00Z',
    };
    const fetchMock = vi.fn().mockResolvedValueOnce(cfResponse(created));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      createOrRefreshCustomHostname('zone-1', 'token-1', 'demo.apps.example.com')
    ).resolves.toEqual(created);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      hostname: 'demo.apps.example.com',
      ssl: { method: 'txt', type: 'dv', wildcard: false },
    });
  });

  it('refreshes validation when a matching hostname already exists', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const existing = {
      id: 'hostname-1',
      hostname: 'demo.apps.example.com',
      ssl: { status: 'expired', method: 'txt', type: 'dv' },
      status: 'moved',
      created_at: '2026-04-20T00:00:00Z',
    };
    const refreshed = {
      ...existing,
      ssl: { status: 'pending_validation', method: 'txt', type: 'dv' },
      status: 'pending',
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(cfError())
      .mockResolvedValueOnce(cfResponse([existing]))
      .mockResolvedValueOnce(cfResponse(refreshed));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      createOrRefreshCustomHostname('zone-1', 'token-1', 'demo.apps.example.com')
    ).resolves.toEqual(refreshed);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2][1].method).toBe('PATCH');
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({
      ssl: { method: 'txt', type: 'dv', wildcard: false },
    });
    consoleWarn.mockRestore();
  });
});
