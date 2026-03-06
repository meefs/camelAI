import { describe, expect, it } from 'vitest';
import {
  REPORT_MAX_CELL_CHARS,
  getTableDisplayModel,
  truncateCell,
} from '@/components/chat-file-preview/notebook-preview/table-display';
import type { ParsedTable } from '@/components/chat-file-preview/notebook-preview/types';

describe('notebook table display', () => {
  it('caps report rows and emits a truncation note', () => {
    const table: ParsedTable = {
      headers: ['Row', 'Value'],
      rows: Array.from({ length: 125 }, (_, index) => [
        `${index + 1}`,
        `Value ${index + 1}`,
      ]),
      indexColumns: 1,
      caption: '125 rows × 1 column',
      sourceRowCount: 125,
    };

    const display = getTableDisplayModel(table);

    expect(display.displayedCount).toBe(100);
    expect(display.displayRows).toHaveLength(100);
    expect(display.captionText).toBe('Showing 100 of 125 rows × 1 column');
    expect(display.truncationNote).toBe('Showing first 100 rows of 125 total rows.');
  });

  it('truncates long cell values with an ellipsis', () => {
    const longValue = 'x'.repeat(REPORT_MAX_CELL_CHARS + 5);

    expect(truncateCell(longValue)).toBe(`${'x'.repeat(REPORT_MAX_CELL_CHARS)}\u2026`);
  });
});
