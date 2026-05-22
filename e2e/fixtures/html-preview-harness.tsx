import { useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  DEFAULT_NOTEBOOK_PREVIEW_STATE,
  PreviewPanelShell,
  type TabRenderState,
} from '@/components/chat-preview/chat-preview-shell';
import {
  getPreviewTabId,
  shouldAutoRefreshFilePreview,
} from '@/components/preview-panel/preview-utils';
import type { PreviewTab, PreviewTarget } from '@/types';

declare global {
  interface Window {
    previewMessages?: Record<'active' | 'inactive', number>;
    previewBoots?: Record<'active' | 'inactive', number>;
    previewTicks?: Record<'active' | 'inactive', number>;
    previewHarnessListenerInstalled?: boolean;
  }
}

window.previewMessages = { active: 0, inactive: 0 };
window.previewBoots = { active: 0, inactive: 0 };
window.previewTicks = { active: 0, inactive: 0 };
if (!window.previewHarnessListenerInstalled) {
  window.previewHarnessListenerInstalled = true;
  window.addEventListener('message', (event) => {
    const data = event.data as {
      type?: unknown;
      name?: unknown;
      event?: unknown;
      tick?: unknown;
    };
    if (
      data.type !== 'html-preview-fixture' ||
      (data.name !== 'active' && data.name !== 'inactive')
    ) {
      return;
    }
    window.previewMessages ??= { active: 0, inactive: 0 };
    window.previewMessages[data.name] += 1;
    if (data.event === 'boot') {
      window.previewBoots ??= { active: 0, inactive: 0 };
      window.previewBoots[data.name] += 1;
    }
    if (data.event === 'tick' && typeof data.tick === 'number') {
      window.previewTicks ??= { active: 0, inactive: 0 };
      window.previewTicks[data.name] = data.tick;
    }
  });
}

const activeTarget: PreviewTarget = {
  kind: 'file',
  source: 'workspace',
  workspaceId: 'workspace_1',
  path: '/active.html',
  filename: 'active.html',
  contentType: 'text/html',
};

const inactiveTarget: PreviewTarget = {
  kind: 'file',
  source: 'workspace',
  workspaceId: 'workspace_1',
  path: '/inactive.html',
  filename: 'inactive.html',
  contentType: 'text/html',
};

const previewTabs: PreviewTab[] = [activeTarget, inactiveTarget].map((target) => ({
  id: getPreviewTabId(target),
  target,
}));

function toRenderState(tab: PreviewTab, fileKey: number): TabRenderState {
  const fixtureName =
    tab.target.kind === 'file' && tab.target.filename === 'inactive.html'
      ? 'html-preview-inactive.html'
      : 'html-preview-active.html';
  return {
    tabId: tab.id,
    target: tab.target,
    appPreviewUrl: '',
    vanityHost: '',
    iframeKey: 0,
    isLoading: false,
    filePreviewUrl: `/e2e/fixtures/${fixtureName}?v=${fileKey}`,
    filePreviewOpenUrl: `/e2e/fixtures/${fixtureName}`,
    previewFileName:
      tab.target.kind === 'file' ? (tab.target.filename ?? tab.target.path) : '',
    notebookViewMode: 'report',
    fileViewMode: 'preview',
    isNotebookPreview: false,
  };
}

function Harness() {
  const [activeTabId, setActiveTabId] = useState(previewTabs[0].id);
  const [filePreviewKeys, setFilePreviewKeys] = useState<Record<string, number>>(
    {},
  );
  const [, setAutoRefreshChurn] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const previewTarget =
    previewTabs.find((tab) => tab.id === activeTabId)?.target ?? null;
  const tabRenderStates = useMemo(
    () =>
      previewTabs.map((tab) => toRenderState(tab, filePreviewKeys[tab.id] ?? 0)),
    [filePreviewKeys],
  );
  const activeRenderState = tabRenderStates.find(
    (state) => state.tabId === activeTabId,
  );
  const bumpActiveFilePreview = () => {
    setFilePreviewKeys((prev) => ({
      ...prev,
      [activeTabId]: (prev[activeTabId] ?? 0) + 1,
    }));
  };
  const simulateAutoRefresh = () => {
    setAutoRefreshChurn((count) => count + 1);
    if (
      previewTarget?.kind === 'file' &&
      shouldAutoRefreshFilePreview(previewTarget, 'preview')
    ) {
      bumpActiveFilePreview();
    }
  };

  return (
    <div style={{ display: 'flex', height: '100vh', flexDirection: 'column' }}>
      <div>
        <button type="button" onClick={simulateAutoRefresh}>
          Simulate auto refresh
        </button>
        <button type="button" onClick={bumpActiveFilePreview}>
          Manual refresh
        </button>
      </div>
      <PreviewPanelShell
        previewTabs={previewTabs}
        activeTabId={activeTabId}
        previewTarget={previewTarget}
        onTabSelect={setActiveTabId}
        onTabClose={() => {}}
        onRefresh={() => {}}
        openElsewhereKind={null}
        onOpenElsewhere={() => {}}
        notebookViewMode="report"
        onNotebookViewModeChange={() => {}}
        fileViewMode="preview"
        onFileViewModeChange={() => {}}
        filePreviewOpenUrl={activeRenderState?.filePreviewOpenUrl ?? ''}
        activeNotebookState={DEFAULT_NOTEBOOK_PREVIEW_STATE}
        isNotebookPdfExporting={false}
        onNotebookStateChange={() => {}}
        onNotebookReportPdfDownload={() => {}}
        iframeRef={iframeRef}
        tabRenderStates={tabRenderStates}
        vanityUrl=""
        vanityHost=""
      />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
