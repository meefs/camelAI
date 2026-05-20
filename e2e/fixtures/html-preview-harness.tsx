import { useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  DEFAULT_NOTEBOOK_PREVIEW_STATE,
  PreviewPanelShell,
  type TabRenderState,
} from '@/components/chat-preview/chat-preview-shell';
import { getPreviewTabId } from '@/components/preview-panel/preview-utils';
import type { PreviewTab, PreviewTarget } from '@/types';

declare global {
  interface Window {
    previewMessages?: Record<'active' | 'inactive', number>;
    previewHarnessListenerInstalled?: boolean;
  }
}

window.previewMessages = { active: 0, inactive: 0 };
if (!window.previewHarnessListenerInstalled) {
  window.previewHarnessListenerInstalled = true;
  window.addEventListener('message', (event) => {
    const data = event.data as { type?: unknown; name?: unknown };
    if (
      data.type !== 'html-preview-fixture' ||
      (data.name !== 'active' && data.name !== 'inactive')
    ) {
      return;
    }
    window.previewMessages ??= { active: 0, inactive: 0 };
    window.previewMessages[data.name] += 1;
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

function toRenderState(tab: PreviewTab): TabRenderState {
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
    filePreviewUrl: `/e2e/fixtures/${fixtureName}`,
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
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const previewTarget =
    previewTabs.find((tab) => tab.id === activeTabId)?.target ?? null;
  const tabRenderStates = useMemo(
    () => previewTabs.map((tab) => toRenderState(tab)),
    [],
  );
  const activeRenderState = tabRenderStates.find(
    (state) => state.tabId === activeTabId,
  );

  return (
    <div style={{ display: 'flex', height: '100vh', flexDirection: 'column' }}>
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
