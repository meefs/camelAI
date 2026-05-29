import { describe, expect, it, vi } from 'vitest';
import { createConnections } from '../../../sandbox/create-worker/templates/starter/app/lib/connections';
import { ConnectionsService } from '../src/connections-service';

describe('ConnectionsService compatibility', () => {
  it('keeps the legacy hidden invoke entrypoint for already-deployed apps', async () => {
    const legacyInvokeMethod = ['_', '_', 'invoke'].join('');
    const invoke = vi.fn(async (request: unknown) => ({ ok: true, request }));
    const service = { invoke };
    const request = {
      connection: 'remoteMcpAdmin',
      method: 'getDashboardSummary',
      input: { date: '2026-05-29' },
    };

    const result = await (ConnectionsService.prototype as any)[legacyInvokeMethod].call(
      service,
      request,
    );

    expect(result).toEqual({ ok: true, request });
    expect(invoke).toHaveBeenCalledWith(request);
  });

  it('starter createConnections calls the service binding method without detaching it', async () => {
    const invoke = vi.fn(async function(this: unknown, request: unknown) {
      return { receiver: this, request };
    });
    const binding = {
      invoke,
      find: vi.fn(async () => ({ alias: 'remoteMcpAdmin' })),
    };
    const connections = createConnections({ CONNECTIONS: binding as any });
    const admin = await (binding.find as any)('admin');

    const result = await (connections as any)[admin.alias].getDashboardSummary({
      date: '2026-05-29',
    });

    expect(result).toEqual({
      receiver: binding,
      request: {
        connection: 'remoteMcpAdmin',
        method: 'getDashboardSummary',
        input: { date: '2026-05-29' },
      },
    });
  });
});
