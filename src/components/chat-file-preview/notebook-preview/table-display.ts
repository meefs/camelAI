import type { ParsedTable } from './types';

export const MAX_DISPLAY_ROWS = 100;
export const REPORT_MAX_CELL_CHARS = 50;

export interface TableDisplayModel {
  columnCount: number;
  parsedRows: number;
  totalRows: number;
  displayCapped: boolean;
  displayRows: string[][];
  displayedCount: number;
  dataColumns: number;
  captionText: string;
  truncationNote: string | null;
  hasCsvData: boolean;
}

export function truncateCell(value: string, maxChars = REPORT_MAX_CELL_CHARS): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\u2026`;
}

export function isNumericValue(value: string): boolean {
  const normalized = value.trim();
  if (!normalized || normalized === '...' || normalized === 'NaN' || normalized === 'None') {
    return false;
  }
  return /^-?[\d,]+(?:\.\d+)?(?:[eE][+-]?\d+)?%?$/.test(normalized);
}

export function getMaxRowLength(rows: readonly string[][]): number {
  let max = 0;
  for (const row of rows) {
    if (row.length > max) {
      max = row.length;
    }
  }
  return max;
}

export function getTableDisplayModel(table: ParsedTable): TableDisplayModel {
  const columnCount = Math.max(table.headers.length, getMaxRowLength(table.rows));
  const parsedRows = table.rows.length;
  const totalRows = table.sourceRowCount ?? parsedRows;
  const displayCapped = parsedRows > MAX_DISPLAY_ROWS;
  const displayRows = displayCapped ? table.rows.slice(0, MAX_DISPLAY_ROWS) : table.rows;
  const displayedCount = displayRows.length;
  const dataColumns = Math.max(0, columnCount - table.indexColumns);
  const colLabel = `${dataColumns.toLocaleString()} column${dataColumns === 1 ? '' : 's'}`;

  const captionText =
    displayedCount < totalRows
      ? `Showing ${displayedCount.toLocaleString()} of ${totalRows.toLocaleString()} rows × ${colLabel}`
      : (table.caption ?? `${totalRows.toLocaleString()} row${totalRows === 1 ? '' : 's'} × ${colLabel}`);

  const truncationNote = displayedCount < totalRows
    ? `Showing first ${displayedCount.toLocaleString()} rows of ${totalRows.toLocaleString()} total rows.`
    : null;

  const hasCsvData = table.headers.length > 0 || table.rows.some((row) => row.length > 0);

  return {
    columnCount,
    parsedRows,
    totalRows,
    displayCapped,
    displayRows,
    displayedCount,
    dataColumns,
    captionText,
    truncationNote,
    hasCsvData,
  };
}
