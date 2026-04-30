import { describe, expect, it } from 'vitest';
import {
  getFileCategory,
  getPreviewType,
  getShikiLanguage,
  isBinarySpreadsheet,
} from '@/components/chat-file-preview/file-type-utils';

describe('file-type-utils', () => {
  it('classifies tsv as spreadsheet', () => {
    expect(getFileCategory('data.tsv')).toBe('spreadsheet');
  });

  it('classifies jsonl as code', () => {
    expect(getFileCategory('events.jsonl')).toBe('code');
  });

  it('classifies markdown preview type separately from text', () => {
    expect(getPreviewType('README.md')).toBe('markdown');
    expect(getPreviewType('notes.txt')).toBe('text');
  });

  it('routes supported code files to code preview type', () => {
    expect(getPreviewType('main.py')).toBe('code');
    expect(getPreviewType('main.py', 'text/plain')).toBe('code');
    expect(getPreviewType('index.ts')).toBe('code');
    expect(getPreviewType('config.json')).toBe('code');
  });

  it('routes spreadsheet files to spreadsheet preview and keeps plain text on text preview', () => {
    expect(getPreviewType('data.csv')).toBe('spreadsheet');
    expect(getPreviewType('data.csv', 'text/csv')).toBe('spreadsheet');
    expect(getPreviewType('dataset', 'text/csv')).toBe('spreadsheet');
    expect(getPreviewType('dataset', 'text/tab-separated-values')).toBe('spreadsheet');
    expect(getPreviewType('notes.log')).toBe('text');
  });

  it('routes binary excel formats to spreadsheet preview', () => {
    expect(getPreviewType('report.xlsx')).toBe('spreadsheet');
    expect(getPreviewType('report.xls')).toBe('spreadsheet');
    expect(
      getPreviewType(
        'report.xlsx',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      )
    ).toBe('spreadsheet');
    expect(isBinarySpreadsheet('report.xlsx')).toBe(true);
    expect(isBinarySpreadsheet('report.xls')).toBe(true);
    expect(isBinarySpreadsheet('data.csv', 'text/csv')).toBe(false);
    expect(isBinarySpreadsheet('data.csv', 'application/vnd.ms-excel')).toBe(false);
    expect(isBinarySpreadsheet('data.tsv', 'application/vnd.ms-excel')).toBe(false);
  });

  it('does not route unsupported spreadsheet formats to the spreadsheet preview', () => {
    expect(getFileCategory('budget.ods')).toBe('other');
    expect(getFileCategory('budget.ods', 'application/vnd.oasis.opendocument.spreadsheet')).toBe(
      'spreadsheet'
    );
    expect(getPreviewType('budget.ods', 'application/vnd.oasis.opendocument.spreadsheet')).toBe(
      'other'
    );
  });

  it('maps file extensions to shiki languages', () => {
    expect(getShikiLanguage('main.py')).toBe('python');
    expect(getShikiLanguage('app.tsx')).toBe('tsx');
    expect(getShikiLanguage('notes.txt')).toBeNull();
  });
});
