export interface D1MigrationTableExportInput {
  table: string;
  cursor?: string | number | null;
  limit?: number;
}

export interface D1MigrationTableExport {
  exportVersion: 1;
  exportedAt: number;
  schemaVersion: number | null;
  table: string;
  keyColumns: string[];
  cursor: string | null;
  nextCursor: string | null;
  hasMore: boolean;
  rows: Array<Record<string, unknown>>;
}

type SqlParam = string | number | null;

export interface D1MigrationTableSpec {
  table: string;
  keyColumns: string[];
  orderBy: string;
  whereAfterCursor: (cursor: string) => { sql: string; params: SqlParam[] };
  cursorFromRow: (row: Record<string, unknown>) => string;
}

export type D1MigrationTableSpecs = Record<string, D1MigrationTableSpec>;

const DEFAULT_EXPORT_PAGE_LIMIT = 500;
const MAX_EXPORT_PAGE_LIMIT = 1000;

function normalizeCursor(cursor: string | number | null | undefined): string | null {
  if (cursor === null || cursor === undefined) return null;
  const value = String(cursor);
  return value.length > 0 ? value : null;
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_EXPORT_PAGE_LIMIT;
  if (!Number.isFinite(limit)) return DEFAULT_EXPORT_PAGE_LIMIT;
  return Math.max(1, Math.min(MAX_EXPORT_PAGE_LIMIT, Math.floor(limit)));
}

function textKeyCursor(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function parseCompositeCursor(cursor: string, expectedParts: number): string[] {
  try {
    const parsed = JSON.parse(cursor);
    if (
      Array.isArray(parsed) &&
      parsed.length === expectedParts &&
      parsed.every((part) => typeof part === "string" || typeof part === "number")
    ) {
      return parsed.map((part) => String(part));
    }
  } catch {
    // Fall through to the validation error below.
  }
  throw new Error("Invalid D1 migration cursor");
}

export function singleTextKeyTableSpec(
  table: string,
  keyColumn: string,
): D1MigrationTableSpec {
  return {
    table,
    keyColumns: [keyColumn],
    orderBy: `${keyColumn} ASC`,
    whereAfterCursor: (cursor) => ({
      sql: `WHERE ${keyColumn} > ?`,
      params: [cursor],
    }),
    cursorFromRow: (row) => textKeyCursor(row[keyColumn]),
  };
}

export function singleIntegerKeyTableSpec(
  table: string,
  keyColumn: string,
): D1MigrationTableSpec {
  return {
    table,
    keyColumns: [keyColumn],
    orderBy: `${keyColumn} ASC`,
    whereAfterCursor: (cursor) => ({
      sql: `WHERE ${keyColumn} > ?`,
      params: [Number(cursor)],
    }),
    cursorFromRow: (row) => String(Number(row[keyColumn] ?? 0)),
  };
}

export function compositeTextKeyTableSpec(
  table: string,
  firstKeyColumn: string,
  secondKeyColumn: string,
): D1MigrationTableSpec {
  return {
    table,
    keyColumns: [firstKeyColumn, secondKeyColumn],
    orderBy: `${firstKeyColumn} ASC, ${secondKeyColumn} ASC`,
    whereAfterCursor: (cursor) => {
      const [first, second] = parseCompositeCursor(cursor, 2);
      return {
        sql: `WHERE (${firstKeyColumn} > ? OR (${firstKeyColumn} = ? AND ${secondKeyColumn} > ?))`,
        params: [first, first, second],
      };
    },
    cursorFromRow: (row) =>
      JSON.stringify([
        textKeyCursor(row[firstKeyColumn]),
        textKeyCursor(row[secondKeyColumn]),
      ]),
  };
}

export function compositeTextIntegerKeyTableSpec(
  table: string,
  firstKeyColumn: string,
  secondKeyColumn: string,
): D1MigrationTableSpec {
  return {
    table,
    keyColumns: [firstKeyColumn, secondKeyColumn],
    orderBy: `${firstKeyColumn} ASC, ${secondKeyColumn} ASC`,
    whereAfterCursor: (cursor) => {
      const [first, second] = parseCompositeCursor(cursor, 2);
      return {
        sql: `WHERE (${firstKeyColumn} > ? OR (${firstKeyColumn} = ? AND ${secondKeyColumn} > ?))`,
        params: [first, first, Number(second)],
      };
    },
    cursorFromRow: (row) =>
      JSON.stringify([
        textKeyCursor(row[firstKeyColumn]),
        String(Number(row[secondKeyColumn] ?? 0)),
      ]),
  };
}

export function exportD1MigrationTablePage(
  sql: SqlStorage,
  specs: D1MigrationTableSpecs,
  input: D1MigrationTableExportInput,
  schemaVersion: number | null,
): D1MigrationTableExport {
  const spec = specs[input.table];
  if (!spec) {
    throw new Error(`Unsupported D1 migration export table: ${input.table}`);
  }

  const limit = normalizeLimit(input.limit);
  const cursor = normalizeCursor(input.cursor);
  const where = cursor ? spec.whereAfterCursor(cursor) : { sql: "", params: [] };

  let rows: Array<Record<string, SqlStorageValue>>;
  try {
    rows = sql
      .exec<Record<string, SqlStorageValue>>(
        `SELECT * FROM ${spec.table} ${where.sql} ORDER BY ${spec.orderBy} LIMIT ?`,
        ...where.params,
        limit + 1,
      )
      .toArray();
  } catch (error) {
    if (error instanceof Error && /no such table/i.test(error.message)) {
      rows = [];
    } else {
      throw error;
    }
  }

  const page = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  return {
    exportVersion: 1,
    exportedAt: Date.now(),
    schemaVersion,
    table: spec.table,
    keyColumns: spec.keyColumns,
    cursor,
    nextCursor: hasMore && page.length > 0 ? spec.cursorFromRow(page[page.length - 1]!) : null,
    hasMore,
    rows: page,
  };
}
