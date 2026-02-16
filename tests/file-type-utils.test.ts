import { describe, expect, it } from 'vitest';
import { getFileCategory, getPreviewType } from '@/components/chat-file-preview/file-type-utils';

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
});
