import { describe, expect, it } from 'vitest';
import { parseDelimitedTable } from '@/components/chat-file-preview/spreadsheet-preview';

describe('spreadsheet-preview parser', () => {
  it('returns null for empty content', () => {
    expect(parseDelimitedTable('', ',')).toBeNull();
  });

  it('parses comma-delimited rows with headers', () => {
    const table = parseDelimitedTable('name,amount\nWidget,12.5\nGadget,9', ',');
    expect(table).not.toBeNull();
    expect(table?.headers).toEqual(['name', 'amount']);
    expect(table?.rows).toEqual([
      ['Widget', '12.5'],
      ['Gadget', '9'],
    ]);
  });

  it('parses quoted fields with commas and escaped quotes', () => {
    const table = parseDelimitedTable(
      'name,notes\n"Widget, A","Says ""hello"""',
      ','
    );
    expect(table?.headers).toEqual(['name', 'notes']);
    expect(table?.rows).toEqual([['Widget, A', 'Says "hello"']]);
  });

  it('parses quoted fields with embedded newlines', () => {
    const table = parseDelimitedTable(
      'name,notes\nWidget,"Line 1\nLine 2"',
      ','
    );
    expect(table?.rows).toEqual([['Widget', 'Line 1\nLine 2']]);
  });

  it('parses tab-delimited rows', () => {
    const table = parseDelimitedTable('name\tcount\nalpha\t2', '\t');
    expect(table?.headers).toEqual(['name', 'count']);
    expect(table?.rows).toEqual([['alpha', '2']]);
  });
});

