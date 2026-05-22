import { describe, expect, it } from 'vitest';
import type { PreviewTarget } from '@/types';
import {
  getPreviewTabId,
  getToolbarFileType,
  shouldAutoRefreshFilePreview,
  supportsPreviewSourceToggle,
} from '@/components/preview-panel/preview-utils';

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
      { path: 'index.html', expected: 'html' },
      { path: 'index.htm', expected: 'html' },
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

  it('maps toolbar file types by content type for extensionless targets', () => {
    const cases: Array<{
      contentType: string;
      expected: ReturnType<typeof getToolbarFileType>;
    }> = [
      { contentType: 'text/html; charset=utf-8', expected: 'html' },
      { contentType: 'image/svg+xml', expected: 'svg' },
      { contentType: 'application/json', expected: 'json' },
      { contentType: 'application/x-ndjson', expected: 'json' },
      { contentType: 'text/tab-separated-values', expected: 'spreadsheet' },
    ];

    for (const testCase of cases) {
      const target: PreviewTarget = {
        kind: 'file',
        source: 'workspace',
        workspaceId: 'ws_123',
        path: '/tmp/file',
        contentType: testCase.contentType,
      };
      expect(getToolbarFileType(target)).toBe(testCase.expected);
    }
  });

  it('lets source-toggleable content types override generic text extensions', () => {
    const jsonTextTarget: PreviewTarget = {
      kind: 'file',
      source: 'workspace',
      workspaceId: 'ws_123',
      path: '/tmp/config.txt',
      contentType: 'application/json',
    };
    const csvTextTarget: PreviewTarget = {
      kind: 'file',
      source: 'workspace',
      workspaceId: 'ws_123',
      path: '/tmp/data.txt',
      contentType: 'text/csv',
    };

    expect(getToolbarFileType(jsonTextTarget)).toBe('json');
    expect(supportsPreviewSourceToggle(jsonTextTarget)).toBe(true);
    expect(getToolbarFileType(csvTextTarget)).toBe('spreadsheet');
    expect(supportsPreviewSourceToggle(csvTextTarget)).toBe(true);
  });

  it('reports preview/source toggle support for source-toggleable file types', () => {
    const targetFor = (path: string, contentType?: string): PreviewTarget => ({
      kind: 'file',
      source: 'workspace',
      workspaceId: 'ws_123',
      path: `/tmp/${path}`,
      contentType,
    });

    for (const target of [
      targetFor('readme.md'),
      targetFor('index.html'),
      targetFor('index.htm'),
      targetFor('icon.svg'),
      targetFor('config.json'),
      targetFor('events.jsonl'),
      targetFor('table.csv'),
      targetFor('table.tsv'),
      targetFor('file', 'text/html'),
    ]) {
      expect(supportsPreviewSourceToggle(target)).toBe(true);
    }

    for (const target of [
      targetFor('report.xlsx'),
      targetFor('report.xls'),
      targetFor('image.png'),
      targetFor('report.pdf'),
      targetFor('main.py'),
      targetFor('notes.txt'),
    ]) {
      expect(supportsPreviewSourceToggle(target)).toBe(false);
    }
  });

  it('does not auto-refresh running HTML previews', () => {
    const htmlTarget: Extract<PreviewTarget, { kind: 'file' }> = {
      kind: 'file',
      source: 'workspace',
      workspaceId: 'ws_123',
      path: '/tmp/game.html',
      contentType: 'text/html',
    };
    const textTarget: Extract<PreviewTarget, { kind: 'file' }> = {
      kind: 'file',
      source: 'workspace',
      workspaceId: 'ws_123',
      path: '/tmp/notes.txt',
      contentType: 'text/plain',
    };

    expect(shouldAutoRefreshFilePreview(htmlTarget, 'preview')).toBe(false);
    expect(shouldAutoRefreshFilePreview(htmlTarget, 'source')).toBe(true);
    expect(shouldAutoRefreshFilePreview(textTarget, 'preview')).toBe(true);
  });
});
