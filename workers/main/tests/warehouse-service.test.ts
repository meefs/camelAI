import { describe, expect, it } from 'vitest';
import {
  annotateWarehouseConnections,
  extractWarehouseError,
  extractWarehouseStdio,
  runWarehouseCode,
  withWarehouseParams,
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

  it('injects params and surfaces flattened stdout/stderr', async () => {
    const sandbox = fakeSandbox({ runImpl: async () => ({ logs: { stdout: ['46\n'], stderr: [] } }) });
    const result = await runWarehouseCode(
      { code: "print(params['r2_key'])", params: { r2_key: 'warehouse/ws/c/a.parquet' } },
      { sandbox, newSessionId: seqId },
    );
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe('46\n'); // flat, not result.logs.stdout[0]
    const [session] = [...sandbox.sessions.values()];
    expect(session.ranCode[0]).toContain('params = _wh_json.loads(');
    expect(session.ranCode[0]).toContain("print(params['r2_key'])");
  });

  it('returns ok: false when the interpreter resolves with a Python error', async () => {
    // The SDK resolves (does not throw) on a Python failure, setting `error`.
    const sandbox = fakeSandbox({
      runImpl: async () => ({
        logs: { stdout: [], stderr: [] },
        error: { name: 'IOException', message: "No files found that match the pattern '/bad.parquet'", traceback: [] },
      }),
    });
    const result = await runWarehouseCode({ code: "duckdb.read_parquet('/bad.parquet')" }, { sandbox, newSessionId: seqId });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("IOException: No files found that match the pattern '/bad.parquet'");
    expect([...sandbox.sessions.values()][0].deleted).toBe(true); // still cleaned up
  });
});

describe('extractWarehouseError', () => {
  it('formats an interpreter error as "name: message"', () => {
    expect(extractWarehouseError({ error: { name: 'NameError', message: "name 'params' is not defined" } }))
      .toBe("NameError: name 'params' is not defined");
  });

  it('returns undefined for a successful run', () => {
    expect(extractWarehouseError({ logs: { stdout: ['ok'] } })).toBeUndefined();
    expect(extractWarehouseError({})).toBeUndefined();
    expect(extractWarehouseError(null)).toBeUndefined();
  });
});

describe('withWarehouseParams', () => {
  it('returns code unchanged when there are no params', () => {
    expect(withWarehouseParams('print(1)')).toBe('print(1)');
    expect(withWarehouseParams('print(1)', {})).toBe('print(1)');
  });

  it('injects a params dict that survives special characters', () => {
    const tricky = `warehouse/ws/c/a"b'c\n.parquet`;
    const code = withWarehouseParams("print(params['r2_key'])", { r2_key: tricky });
    expect(code).toContain('params = _wh_json.loads(');
    expect(code.endsWith("print(params['r2_key'])")).toBe(true);
    // The embedded literal round-trips back to the original value.
    const literal = code.match(/_wh_json\.loads\((".*?")\)\n/s)?.[1];
    expect(JSON.parse(JSON.parse(literal!)).r2_key).toBe(tricky);
  });
});

describe('extractWarehouseStdio', () => {
  it('joins array stdout/stderr chunks', () => {
    expect(extractWarehouseStdio({ logs: { stdout: ['a', 'b'], stderr: ['x'] } })).toEqual({ stdout: 'ab', stderr: 'x' });
  });

  it('passes through string logs and tolerates missing/odd shapes', () => {
    expect(extractWarehouseStdio({ logs: { stdout: 'hi' } })).toEqual({ stdout: 'hi', stderr: undefined });
    expect(extractWarehouseStdio(null)).toEqual({ stdout: undefined, stderr: undefined });
    expect(extractWarehouseStdio({})).toEqual({ stdout: undefined, stderr: undefined });
  });
});

describe('annotateWarehouseConnections', () => {
  const summary = (id: string, name: string, type: string) => ({ id, name, type, displayName: name });

  it('returns ALL connections, marking the ones with an export method exportable', () => {
    const all = [
      summary('1', 'Infinity-D365', 'mysql'),
      summary('2', 'analytics-pg', 'postgres'),
      summary('3', 'neon-db', 'neon'),
      summary('4', 'ps-db', 'planetscale'),
      summary('5', 'BigQuery', 'bigquery'),
      summary('6', 'warehouse-ch', 'clickhouse'),
      summary('7', 'sql-server', 'mssql'),
      summary('8', 'stripe-acct', 'stripe'),
    ];
    const annotated = annotateWarehouseConnections(all);

    // Every connection is returned (none dropped).
    expect(annotated.map((c) => c.name)).toEqual(all.map((c) => c.name));
    // SQL family + BigQuery + ClickHouse have an export method.
    const exportable = annotated.filter((c) => c.exportable).map((c) => c.name);
    expect(exportable).toEqual(['Infinity-D365', 'analytics-pg', 'neon-db', 'ps-db', 'BigQuery', 'warehouse-ch']);
    // mssql / stripe have no export method yet.
    expect(annotated.find((c) => c.name === 'sql-server')?.exportable).toBe(false);
    expect(annotated.find((c) => c.name === 'stripe-acct')?.exportable).toBe(false);
    expect(annotated[0]).toEqual({
      id: '1', name: 'Infinity-D365', type: 'mysql', displayName: 'Infinity-D365',
      exportable: true, exportFormat: 'parquet',
    });
  });

  it('reports exportFormat per source: SQL + ClickHouse are Parquet, BigQuery is NDJSON', () => {
    const annotated = annotateWarehouseConnections([
      summary('1', 'Infinity-D365', 'mysql'),
      summary('2', 'analytics-pg', 'postgres'),
      summary('5', 'BigQuery', 'bigquery'),
      summary('6', 'warehouse-ch', 'clickhouse'),
      summary('7', 'sql-server', 'mssql'),
    ]);
    const fmt = (name: string) => annotated.find((c) => c.name === name)?.exportFormat;
    expect(fmt('Infinity-D365')).toBe('parquet');
    expect(fmt('analytics-pg')).toBe('parquet');
    expect(fmt('warehouse-ch')).toBe('parquet');
    // BigQuery's REST API only returns JSON, so its export stages NDJSON.
    expect(fmt('BigQuery')).toBe('ndjson');
    // Non-exportable connections have no format.
    expect(fmt('sql-server')).toBeNull();
  });
});
