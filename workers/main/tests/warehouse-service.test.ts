import { describe, expect, it } from 'vitest';
import {
  annotateWarehouseConnections,
  toWarehouseCompatResult,
  withWarehouseParams,
} from '../src/warehouse-service.js';

// WarehouseService is now a source-compat shim delegating runCode/listConnections
// to AnalysisService (see warehouse-service.ts); the session machinery it used to
// own lives in analysis-service.ts and is covered by analysis-service.test.ts.
// Only the pure helpers remain here.

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

describe('toWarehouseCompatResult', () => {
  it('synthesizes the pre-merge result.logs shape from stdout/stderr', () => {
    const wrapped = toWarehouseCompatResult({ ok: true, stdout: 'csv\n', stderr: 'warn' });
    expect(wrapped.result).toEqual({ logs: { stdout: ['csv\n'], stderr: ['warn'] } });
    expect(wrapped.ok).toBe(true);
    expect(wrapped.stdout).toBe('csv\n');
  });

  it('adds a result.error payload on failure', () => {
    const wrapped = toWarehouseCompatResult({ ok: false, error: 'boom' });
    expect(wrapped.result).toEqual({
      logs: { stdout: [], stderr: [] },
      error: { name: 'Error', message: 'boom' },
    });
  });

  it('passes through a result that already exists', () => {
    const original = { ok: true, result: { logs: { stdout: ['x'] } } };
    expect(toWarehouseCompatResult(original)).toBe(original);
  });
});
