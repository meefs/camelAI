import { describe, expect, it } from 'vitest';
import type { PreviewTarget } from '@/types';
import { getPreviewTabId, getToolbarFileType } from '@/components/preview-panel/preview-utils';

describe('preview-utils', () => {
  it('builds stable app tab IDs', () => {
    const target: PreviewTarget = {
      kind: 'app',
      scriptName: 'analytics-app',
      isPublic: false,
    };

    expect(getPreviewTabId(target)).toBe('app:analytics-app');
  });

  it('builds stable file tab IDs with workspace/source/path', () => {
    const target: PreviewTarget = {
      kind: 'file',
      source: 'upload',
      workspaceId: 'ws_123',
      path: '/reports/q1/analysis.ipynb',
    };

    expect(getPreviewTabId(target)).toBe('file:ws_123:upload:/reports/q1/analysis.ipynb');
  });

  it('maps toolbar file types by extension', () => {
    const cases: Array<{ path: string; expected: ReturnType<typeof getToolbarFileType> }> = [
      { path: 'notebook.ipynb', expected: 'notebook' },
      { path: 'readme.md', expected: 'markdown' },
      { path: 'notes.txt', expected: 'text' },
      { path: 'table.csv', expected: 'spreadsheet' },
      { path: 'table.tsv', expected: 'spreadsheet' },
      { path: 'config.json', expected: 'json' },
      { path: 'events.jsonl', expected: 'json' },
      { path: 'icon.svg', expected: 'svg' },
      { path: 'image.png', expected: 'image' },
      { path: 'main.py', expected: 'code' },
      { path: 'archive.bin', expected: 'other' },
    ];

    for (const testCase of cases) {
      const target: PreviewTarget = {
        kind: 'file',
        source: 'workspace',
        workspaceId: 'ws_123',
        path: `/tmp/${testCase.path}`,
      };
      expect(getToolbarFileType(target)).toBe(testCase.expected);
    }
  });
});
