
import { DEFAULT_ROW_HEIGHT } from './constants';
import { getFileExtension } from '../file-type-utils';
import type { SpreadsheetSheet, SpreadsheetWorkbook } from './types';
import { parseNumericLikeValue } from './utils';

export function getSpreadsheetDelimiter(filename: string, contentType?: string): ',' | '\t' {
  const normalizedContentType = contentType?.toLowerCase();
  if (getFileExtension(filename) === 'tsv') return '\t';
  if (normalizedContentType?.includes('tab-separated-values')) return '\t';
  return ',';
}

export function parseDelimitedRows(text: string, delimiter: string) {
  const rows: string[][] = [];
  let current: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const nextChar = text[index + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        field += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && char === delimiter) {
      current.push(field);
      field = '';
      continue;
    }

    if (!inQuotes && (char === '\n' || char === '\r')) {
      current.push(field);
      field = '';
      if (current.some((value) => value.length > 0)) {
        rows.push(current);
      }
      current = [];
      if (char === '\r' && text[index + 1] === '\n') {
        index += 1;
      }
      continue;
    }

    field += char;
  }

  current.push(field);
  if (current.some((value) => value.length > 0)) {
    rows.push(current);
  }

  return rows;
}

export function parseDelimitedWorkbook(
  text: string,
  filename: string,
  contentType?: string,
): SpreadsheetWorkbook | null {
  const rows = parseDelimitedRows(text, getSpreadsheetDelimiter(filename, contentType));
  if (rows.length === 0) return null;
  const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const normalizedRows = rows.map((row) =>
    Array.from({ length: columnCount }, (_, index) => ({
      value: row[index] ?? '',
      formula: null,
      numberValue: parseNumericLikeValue(row[index] ?? ''),
    })),
  );

  const sheets: SpreadsheetSheet[] = [
    {
      name: 'Data',
      rows: normalizedRows,
      rowCount: normalizedRows.length,
      columnCount,
      sourceStartRow: 0,
      sourceStartCol: 0,
      rowHeights: Array.from({ length: normalizedRows.length }, () => DEFAULT_ROW_HEIGHT),
      columnWidths: [],
      merges: [],
      rowKinds: normalizedRows.map((_, index) => (index === 0 ? 'header' : 'body')),
      isFirstRowHeader: true,
      wasTrimmed: false,
    },
  ];

  return {
    kind: 'delimited',
    sheets,
    charts: [],
  };
}
