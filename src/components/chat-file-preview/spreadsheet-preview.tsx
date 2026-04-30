import type { ParsedTable } from './notebook-preview/types';
import { parseDelimitedRows } from './spreadsheet';

export {
  SpreadsheetPreview,
  extractEmbeddedChartsFromWorkbookFiles,
  getSpreadsheetDelimiter,
  parseDelimitedRows,
  parseDelimitedWorkbook,
  parseExcelWorkbook,
  parseSpreadsheetWorkbook,
} from './spreadsheet';
export type { SpreadsheetPreviewProps } from './spreadsheet';

export function parseDelimitedTable(text: string, delimiter: string): ParsedTable | null {
  const rows = parseDelimitedRows(text, delimiter);
  if (rows.length === 0) return null;

  return {
    headers: rows[0] ?? [],
    rows: rows.slice(1),
    indexColumns: 0,
    caption: null,
    sourceRowCount: null,
  };
}
