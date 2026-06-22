import { describe, expect, it } from 'vitest';
import {
  annotateWarehouseConnections,
  runWarehouseCode,
  type WarehouseSandboxLike,
  type WarehouseSessionLike,
} from '../src/warehouse-service.js';

interface SessionRecord {
  id: string;
  cwd?: string;
  ranCode: string[];
  deleted: boolean;
}

/** Fake sandbox recording session lifecycle so we can assert per-call isolation. */
function fakeSandbox(opts?: {
  runImpl?: (code: string) => Promise<unknown>;
  failCreate?: boolean;
}): WarehouseSandboxLike & { sessions: Map<string, SessionRecord> } {
  const sessions = new Map<string, SessionRecord>();
  return {
    sessions,
    async createSession({ id, cwd }) {
      if (opts?.failCreate) throw new Error('container unavailable');
      const rec: SessionRecord = { id, cwd, ranCode: [], deleted: false };
      sessions.set(id, rec);
      const session: WarehouseSessionLike = {
        async runCode(code) {
          rec.ranCode.push(code);
          return await (opts?.runImpl ? opts.runImpl(code) : { stdout: 'ok' });
        },
      };
      return session;
    },
    async deleteSession(id) {
      const rec = sessions.get(id);
      if (rec) rec.deleted = true;
      return { deleted: true };
    },
  };
}

let counter = 0;
const seqId = () => `id${++counter}`;

describe('runWarehouseCode', () => {
  it('runs code in a fresh isolated session and returns the interpreter result', async () => {
    const sandbox = fakeSandbox({ runImpl: async () => ({ stdout: '[{"n":1}]' }) });
    const result = await runWarehouseCode(
      { code: "import duckdb; print('hi')" },
      { sandbox, newSessionId: seqId },
    );

    expect(result.ok).toBe(true);
    expect(result.result).toEqual({ stdout: '[{"n":1}]' });

    const [session] = [...sandbox.sessions.values()];
    expect(session.id).toMatch(/^call-/);
    expect(session.cwd).toBe(`/sessions/${session.id}`); // per-call working dir
    expect(session.ranCode).toEqual(["import duckdb; print('hi')"]);
    expect(session.deleted).toBe(true); // cleaned up
  });

  it('gives concurrent calls on the same workspace distinct sessions (no file overlap)', async () => {
    const sandbox = fakeSandbox();
    await Promise.all([
      runWarehouseCode({ code: 'a' }, { sandbox, newSessionId: seqId }),
      runWarehouseCode({ code: 'b' }, { sandbox, newSessionId: seqId }),
      runWarehouseCode({ code: 'c' }, { sandbox, newSessionId: seqId }),
    ]);
    const ids = [...sandbox.sessions.keys()];
    expect(new Set(ids).size).toBe(3); // unique sessions
    const cwds = [...sandbox.sessions.values()].map((s) => s.cwd);
    expect(new Set(cwds).size).toBe(3); // unique working dirs
    expect([...sandbox.sessions.values()].every((s) => s.deleted)).toBe(true);
  });

  it('deletes the session even when the code throws', async () => {
    const sandbox = fakeSandbox({
      runImpl: async () => {
        throw new Error('boom in duckdb');
      },
    });
    const result = await runWarehouseCode({ code: 'x' }, { sandbox, newSessionId: seqId });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/boom in duckdb/);
    expect([...sandbox.sessions.values()][0].deleted).toBe(true);
  });

  it('rejects empty code without creating a session', async () => {
    const sandbox = fakeSandbox();
    const result = await runWarehouseCode({ code: '   ' }, { sandbox, newSessionId: seqId });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/code is empty/);
    expect(sandbox.sessions.size).toBe(0);
  });

  it('returns an error if the session cannot be created', async () => {
    const sandbox = fakeSandbox({ failCreate: true });
    const result = await runWarehouseCode({ code: 'x' }, { sandbox, newSessionId: seqId });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/container unavailable/);
  });
});

describe('annotateWarehouseConnections', () => {
  const summary = (id: string, name: string, type: string) => ({ id, name, type, displayName: name });

  it('returns ALL connections, marking Postgres/MySQL-family ones streamable', () => {
    const all = [
      summary('1', 'Infinity-D365', 'mysql'),
      summary('2', 'analytics-pg', 'postgres'),
      summary('3', 'neon-db', 'neon'),
      summary('4', 'ps-db', 'planetscale'),
      summary('5', 'warehouse-ch', 'clickhouse'),
      summary('6', 'sql-server', 'mssql'),
      summary('7', 'stripe-acct', 'stripe'),
    ];
    const annotated = annotateWarehouseConnections(all);

    // Every connection is reachable (none dropped).
    expect(annotated.map((c) => c.name)).toEqual(all.map((c) => c.name));
    // Only the Postgres/MySQL family is streamable.
    const streamable = annotated.filter((c) => c.streamable).map((c) => c.name);
    expect(streamable).toEqual(['Infinity-D365', 'analytics-pg', 'neon-db', 'ps-db']);
    // clickhouse / mssql / stripe are reachable but invoke-only.
    expect(annotated.find((c) => c.name === 'warehouse-ch')?.streamable).toBe(false);
    expect(annotated.find((c) => c.name === 'sql-server')?.streamable).toBe(false);
    expect(annotated.find((c) => c.name === 'stripe-acct')?.streamable).toBe(false);
    expect(annotated[0]).toEqual({
      id: '1', name: 'Infinity-D365', type: 'mysql', displayName: 'Infinity-D365', streamable: true,
    });
  });
});
