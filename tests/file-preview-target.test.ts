import { describe, expect, it } from 'vitest';
import {
  buildFilePreviewLinkTarget,
  parseFilePreviewTargetFromToolResultText,
} from '@/lib/file-preview-target';

describe('buildFilePreviewLinkTarget', () => {
  it('normalizes workspace paths and strips legacy roots', () => {
    expect(buildFilePreviewLinkTarget({
      location: 'workspace',
      path: '/workspace/./src/App.tsx',
    })).toEqual({
      source: 'workspace',
      path: '/src/App.tsx',
      filename: 'App.tsx',
    });
  });

  it('requires a project for project file targets', () => {
    expect(buildFilePreviewLinkTarget({
      location: 'project',
      path: 'src/App.tsx',
    })).toBeNull();

    expect(buildFilePreviewLinkTarget({
      location: 'project',
      project: 'demo-app',
      path: 'src/App.tsx',
    })).toEqual({
      source: 'project',
      path: '/src/App.tsx',
      filename: 'App.tsx',
      project: 'demo-app',
    });
  });

  it('maps R2 uploads and outputs to unprefixed preview paths', () => {
    expect(buildFilePreviewLinkTarget({
      location: 'r2',
      path: 'outputs/report.html',
      content_type: 'text/html',
    })).toEqual({
      source: 'output',
      path: 'report.html',
      filename: 'report.html',
      contentType: 'text/html',
    });

    expect(buildFilePreviewLinkTarget({
      location: 'r2',
      path: 'uploads/data.csv',
    })).toEqual({
      source: 'upload',
      path: 'data.csv',
      filename: 'data.csv',
    });
  });

  it('infers legacy R2 mount paths when location is missing', () => {
    expect(buildFilePreviewLinkTarget({
      path: '/mnt/user-outputs/charts/plot.png',
    })).toEqual({
      source: 'output',
      path: 'charts/plot.png',
      filename: 'plot.png',
    });
  });

  it('rejects non-previewable R2 temp paths and parent traversal', () => {
    expect(buildFilePreviewLinkTarget({
      location: 'r2',
      path: 'tmp/private.txt',
    })).toBeNull();

    expect(buildFilePreviewLinkTarget({
      location: 'workspace',
      path: '/src/../secret.txt',
    })).toBeNull();
  });
});

describe('parseFilePreviewTargetFromToolResultText', () => {
  it('parses canonical file preview result targets', () => {
    expect(parseFilePreviewTargetFromToolResultText(JSON.stringify({
      success: true,
      target: {
        kind: 'file',
        source: 'project',
        project: 'demo-app',
        path: '/workspace/src/App.tsx',
        filename: 'App.tsx',
        contentType: 'text/typescript',
      },
    }))).toEqual({
      source: 'project',
      project: 'demo-app',
      path: '/src/App.tsx',
      filename: 'App.tsx',
      contentType: 'text/typescript',
    });
  });

  it('returns null for invalid or incomplete result targets', () => {
    expect(parseFilePreviewTargetFromToolResultText('not json')).toBeNull();
    expect(parseFilePreviewTargetFromToolResultText(JSON.stringify({
      target: {
        kind: 'file',
        source: 'project',
        path: '/src/App.tsx',
      },
    }))).toBeNull();
  });
});
