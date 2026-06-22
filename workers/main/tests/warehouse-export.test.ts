import { describe, expect, it } from 'vitest';
import { buildSqlExportPlan, sqlClientToExportBody, warehouseExportKey } from '../src/warehouse-export.js';
import { listSqlDatabaseMcpTools } from '../src/sql-database-mcp.js';
import { listBigQueryMcpTools } from '../src/bigquery-mcp.js';

describe('warehouseExportKey', () => {
  it('is deterministic and namespaced by workspace + connection', () => {
    const k = warehouseExportKey('ws_1', 'Infinity-D365', 'SELECT 1');
    expect(k).toBe(warehouseExportKey('ws_1', 'Infinity-D365', 'SELECT 1'));
    expect(k).toMatch(/^warehouse\/ws_1\/infinity-d365\/[0-9a-f]{8}\.ndjson$/);
  });

  it('changes with the query, the connection, and the workspace', () => {
    const base = warehouseExportKey('ws_1', 'c', 'SELECT 1');
    expect(warehouseExportKey('ws_1', 'c', 'SELECT 2')).not.toBe(base);
    expect(warehouseExportKey('ws_1', 'other', 'SELECT 1')).not.toBe(base);
    expect(warehouseExportKey('ws_2', 'c', 'SELECT 1')).not.toBe(base);
  });
});

describe('sqlClientToExportBody', () => {
  const base = { host: 'db', port: 5432, database: 'd', schema: 'public', username: 'u', password: 'p' };

  it('maps a mysql client to the mysql export body (tls)', () => {
    const { engine, body } = sqlClientToExportBody({ ...base, type: 'mysql', tls: 'preferred' }, 'SELECT 1');
    expect(engine).toBe('mysql');
    expect(body).toMatchObject({ mode: 'read', host: 'db', user: 'u', password: 'p', database: 'd', query: 'SELECT 1', tls: 'preferred' });
  });

  it('maps a postgres client to the postgres export body (sslmode)', () => {
    const { engine, body } = sqlClientToExportBody({ ...base, type: 'postgres', sslMode: 'require' }, 'SELECT 2');
    expect(engine).toBe('postgres');
    expect(body).toMatchObject({ mode: 'read', user: 'u', query: 'SELECT 2', sslmode: 'require' });
  });

  it('buildSqlExportPlan combines the export body with the R2 staging key', () => {
    const plan = buildSqlExportPlan('ws_1', 'Infinity-D365', { ...base, type: 'mysql', tls: 'preferred' }, 'SELECT 1');
    expect(plan.engine).toBe('mysql');
    expect(plan.body).toMatchObject({ mode: 'read', query: 'SELECT 1', tls: 'preferred' });
    expect(plan.r2Key).toMatch(/^warehouse\/ws_1\/infinity-d365\/[0-9a-f]{8}\.ndjson$/);
  });
});

describe('export is a first-class connection method', () => {
  it('appears in the SQL database and BigQuery method catalogs (next to execute_sql_readonly)', () => {
    for (const tools of [listSqlDatabaseMcpTools(), listBigQueryMcpTools()]) {
      const names = tools.map((t) => t.name);
      expect(names).toContain('execute_sql_readonly');
      expect(names).toContain('export');
    }
  });
});
