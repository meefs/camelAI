import { describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import type { WorkerLogsDO } from '../src/worker-logs-do';

interface TestEnvWithLogs {
  WORKER_LOGS: DurableObjectNamespace<WorkerLogsDO>;
}

describe('WorkerLogsDO (in-memory)', () => {
  const testEnv = env as unknown as TestEnvWithLogs;

  function logsStub(name = `logs-${crypto.randomUUID()}`) {
    return testEnv.WORKER_LOGS.get(
      testEnv.WORKER_LOGS.idFromName(name),
    ) as DurableObjectStub<WorkerLogsDO>;
  }

  it('ingests, lists, and reports stats from the in-memory buffer', async () => {
    const stub = logsStub();

    await stub.ingestLogs([
      {
        timestamp: 1_000,
        level: 'info',
        message: 'hello',
        exception: null,
        scriptVersion: 'v1',
      },
      {
        timestamp: 2_000,
        level: 'error',
        message: 'boom',
        exception: 'stack',
        scriptVersion: 'v1',
      },
    ]);

    const logs = await stub.getLogs({ limit: 10 });
    expect(logs.map((entry) => entry.message)).toEqual(['boom', 'hello']);
    expect(logs[0]?.exception).toBe('stack');

    const stats = await stub.getStats();
    expect(stats.logCount).toBe(2);
    expect(stats.lastLogAt).toBe(2_000);
  });

  it('filters by since and respects limit', async () => {
    const stub = logsStub();

    await stub.ingestLogs([
      { timestamp: 1_000, level: 'info', message: 'a', exception: null, scriptVersion: null },
      { timestamp: 2_000, level: 'info', message: 'b', exception: null, scriptVersion: null },
      { timestamp: 3_000, level: 'info', message: 'c', exception: null, scriptVersion: null },
    ]);

    const since = await stub.getLogs({ since: 1_000, limit: 10 });
    expect(since.map((entry) => entry.message)).toEqual(['c', 'b']);

    const limited = await stub.getLogs({ limit: 1 });
    expect(limited.map((entry) => entry.message)).toEqual(['c']);
  });

  it('clears the in-memory buffer', async () => {
    const stub = logsStub();

    await stub.ingestLogs([
      { timestamp: 1_000, level: 'info', message: 'x', exception: null, scriptVersion: null },
    ]);
    await stub.clearLogs();

    expect(await stub.getLogs()).toEqual([]);
    expect(await stub.getStats()).toEqual({ logCount: 0, lastLogAt: null });
  });

  it('samples when the write window is exceeded and does not touch SQLite', async () => {
    const stub = logsStub();

    const events = Array.from({ length: 250 }, (_, index) => ({
      timestamp: 10_000 + index,
      level: 'log',
      message: `m-${index}`,
      exception: null,
      scriptVersion: null,
    }));

    await stub.ingestLogs(events);

    const stats = await stub.getStats();
    // 199 regular events + 1 sampling warning (one slot reserved for the warning).
    expect(stats.logCount).toBe(200);

    const logs = await stub.getLogs({ limit: 5 });
    expect(logs.some((entry) => entry.message?.includes('Log sampling active'))).toBe(true);

    await runInDurableObject(stub, async (instance, state) => {
      expect(instance).toBeTruthy();
      // In-memory path must not create or use the old SQLite logs table.
      const tables = state.storage.sql
        .exec<{ name: string }>((`SELECT name FROM sqlite_master WHERE type = 'table'`))
        .toArray()
        .map((row) => row.name);
      expect(tables).not.toContain('logs');
    });
  });
});
