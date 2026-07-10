import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useChatPreviewRenderState } from '@/components/chat-preview/use-chat-preview-render-state';
import type { PreviewTab, PreviewTarget } from '@/types';

function renderFilePreviewState(target: Extract<PreviewTarget, { kind: 'file' }>) {
  const previewTabs: PreviewTab[] = [{ id: 'tab-1', target }];
  return renderHook(() => useChatPreviewRenderState({
    previewTabs,
    previewTarget: target,
    tabIframeKeys: {},
    tabAppLoading: {},
    tabFilePreviewKeys: { 'tab-1': 0 },
    tabNotebookViewModes: {},
    tabFileViewModes: {},
  }));
}

describe('useChatPreviewRenderState file preview routes', () => {
  it('builds project file routes', () => {
    const { result } = renderFilePreviewState({
      kind: 'file',
      source: 'project',
      workspaceId: 'thread-ws',
      project: 'demo-app',
      path: '/src/App.tsx',
      filename: 'App.tsx',
    });

    expect(result.current.filePreviewOpenUrl).toBe(
      '/api/workspaces/thread-ws/projects/demo-app/fs/content/src/App.tsx',
    );
    expect(result.current.tabRenderStates[0].filePreviewOpenUrl).toBe(
      '/api/workspaces/thread-ws/projects/demo-app/fs/content/src/App.tsx',
    );
  });

  it('builds output file routes from unprefixed target paths', () => {
    const { result } = renderFilePreviewState({
      kind: 'file',
      source: 'output',
      workspaceId: 'thread-ws',
      path: 'report.html',
      filename: 'report.html',
    });

    expect(result.current.filePreviewOpenUrl).toBe(
      '/api/workspaces/thread-ws/outputs/report.html',
    );
  });

  it('builds upload file routes from unprefixed target paths', () => {
    const { result } = renderFilePreviewState({
      kind: 'file',
      source: 'upload',
      workspaceId: 'thread-ws',
      path: 'data.csv',
      filename: 'data.csv',
    });

    expect(result.current.filePreviewOpenUrl).toBe(
      '/api/workspaces/thread-ws/uploads/data.csv',
    );
  });

  it('builds durable workspace file routes', () => {
    const { result } = renderFilePreviewState({
      kind: 'file',
      source: 'workspace',
      workspaceId: 'thread-ws',
      path: '/notes.md',
      filename: 'notes.md',
    });

    expect(result.current.filePreviewOpenUrl).toBe(
      '/api/workspaces/thread-ws/fs/content/notes.md',
    );
  });
});
