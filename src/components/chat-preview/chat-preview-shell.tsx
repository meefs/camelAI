import { memo, type ReactNode, type RefObject } from "react";
import { RefreshCw } from "lucide-react";
import type { PreviewTab, PreviewTarget } from "@/types";
import {
  FilePreviewContent,
  type NotebookPreviewLoadState,
} from "@/components/chat-file-preview";
import { PreviewTabRow } from "@/components/preview-panel/preview-tabs";
import {
  PreviewToolbar,
  type OpenElsewhereKind,
} from "@/components/preview-panel/preview-toolbar";
import { getPreviewTabId } from "@/components/preview-panel/preview-utils";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export const DEFAULT_NOTEBOOK_PREVIEW_STATE: NotebookPreviewLoadState = {
  notebook: null,
  status: "idle",
};

export function coercePreviewTarget(value: unknown): PreviewTarget | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.kind === "app") {
    if (typeof record.scriptName !== "string") return null;
    return {
      kind: "app",
      scriptName: record.scriptName,
      isPublic: Boolean(record.isPublic),
    };
  }

  if (record.kind === "file") {
    if (
      typeof record.workspaceId !== "string" ||
      typeof record.path !== "string" ||
      (record.source !== "workspace" &&
        record.source !== "upload" &&
        record.source !== "output")
    ) {
      return null;
    }
    return {
      kind: "file",
      source: record.source,
      workspaceId: record.workspaceId,
      path: record.path,
      filename:
        typeof record.filename === "string" ? record.filename : undefined,
      contentType:
        typeof record.contentType === "string" ? record.contentType : undefined,
    };
  }

  return null;
}

export interface PreviewSessionState {
  tabs: PreviewTab[];
  activeTabId: string | null;
  target: PreviewTarget | null;
}

export function normalizePreviewSessionState(
  tabsInput: unknown,
  activeTabIdInput: unknown,
  fallbackTarget: unknown,
): PreviewSessionState {
  const tabs: PreviewTab[] = [];
  const tabIndexById = new Map<string, number>();

  const upsert = (rawTarget: unknown) => {
    const target = coercePreviewTarget(rawTarget);
    if (!target) return;

    const id = getPreviewTabId(target);
    const tab: PreviewTab = { id, target };
    const existingIndex = tabIndexById.get(id);
    if (existingIndex === undefined) {
      tabIndexById.set(id, tabs.length);
      tabs.push(tab);
      return;
    }
    tabs[existingIndex] = tab;
  };

  if (Array.isArray(tabsInput)) {
    for (const tabTarget of tabsInput) {
      upsert(tabTarget);
    }
  }

  if (tabs.length === 0) {
    upsert(fallbackTarget);
  }

  const activeTabId =
    typeof activeTabIdInput === "string" && tabIndexById.has(activeTabIdInput)
      ? activeTabIdInput
      : (tabs[0]?.id ?? null);
  const target = activeTabId
    ? (tabs.find((tab) => tab.id === activeTabId)?.target ?? null)
    : null;

  return { tabs, activeTabId, target };
}

export function MobileViewSwitcher({
  value,
  onChange,
}: {
  value: "chat" | "preview";
  onChange: (value: "chat" | "preview") => void;
}) {
  return (
    <div className="w-full bg-background px-4 py-3">
      <Tabs
        value={value}
        onValueChange={(nextValue) => onChange(nextValue as "chat" | "preview")}
        className="w-full"
      >
        <TabsList className="grid w-full grid-cols-2 overflow-hidden rounded-lg bg-muted/80 p-1 shadow-inner !h-11">
          <TabsTrigger
            value="chat"
            className="rounded-md text-sm font-semibold data-[state=active]:shadow-sm !h-9"
          >
            Chat
          </TabsTrigger>
          <TabsTrigger
            value="preview"
            className="rounded-md text-sm font-semibold data-[state=active]:shadow-sm !h-9"
          >
            Preview
          </TabsTrigger>
        </TabsList>
      </Tabs>
    </div>
  );
}

export type TabRenderState = {
  tabId: string;
  target: PreviewTarget;
  appPreviewUrl: string;
  vanityHost: string;
  iframeKey: number;
  isLoading: boolean;
  filePreviewUrl: string;
  filePreviewOpenUrl: string;
  previewFileName: string;
  notebookViewMode: "report" | "notebook";
  fileViewMode: "preview" | "source";
  isNotebookPreview: boolean;
};

interface PreviewPanelShellProps {
  previewTabs: PreviewTab[];
  activeTabId: string | null;
  previewTarget: PreviewTarget | null;
  onTabSelect: (tabId: string) => void;
  onTabClose: (tabId: string) => void;
  onRefresh: () => void;
  openElsewhereKind: OpenElsewhereKind | null;
  onOpenElsewhere: () => void;
  appShareButton?: ReactNode;
  notebookViewMode: "report" | "notebook";
  onNotebookViewModeChange: (mode: "report" | "notebook") => void;
  fileViewMode: "preview" | "source";
  onFileViewModeChange: (mode: "preview" | "source") => void;
  filePreviewOpenUrl: string;
  activeNotebookState: NotebookPreviewLoadState;
  isNotebookPdfExporting: boolean;
  onNotebookStateChange: (
    tabId: string,
    state: NotebookPreviewLoadState,
  ) => void;
  onNotebookReportPdfDownload: () => void | Promise<void>;
  iframeRef: RefObject<HTMLIFrameElement | null>;
  tabRenderStates: TabRenderState[];
  vanityUrl: string;
  vanityHost: string;
}

export const PreviewPanelShell = memo(function PreviewPanelShell({
  previewTabs,
  activeTabId,
  previewTarget,
  onTabSelect,
  onTabClose,
  onRefresh,
  openElsewhereKind,
  onOpenElsewhere,
  appShareButton,
  notebookViewMode,
  onNotebookViewModeChange,
  fileViewMode,
  onFileViewModeChange,
  filePreviewOpenUrl,
  activeNotebookState,
  isNotebookPdfExporting,
  onNotebookStateChange,
  onNotebookReportPdfDownload,
  iframeRef,
  tabRenderStates,
  vanityUrl,
  vanityHost,
}: PreviewPanelShellProps) {
  if (previewTabs.length === 0 || !previewTarget || !activeTabId) {
    return null;
  }

  const activeTabState = tabRenderStates.find((s) => s.tabId === activeTabId);
  const isNotebookPreview = activeTabState?.isNotebookPreview ?? false;

  return (
    <>
      <PreviewTabRow
        tabs={previewTabs}
        activeTabId={activeTabId}
        onTabSelect={onTabSelect}
        onTabClose={onTabClose}
      />

      <PreviewToolbar
        activeTarget={previewTarget}
        vanityUrl={vanityUrl}
        vanityHost={vanityHost}
        onRefresh={onRefresh}
        openElsewhereKind={openElsewhereKind}
        onOpenElsewhere={onOpenElsewhere}
        appShareButton={appShareButton}
        notebookViewMode={isNotebookPreview ? notebookViewMode : undefined}
        onNotebookViewModeChange={onNotebookViewModeChange}
        fileViewMode={fileViewMode}
        onFileViewModeChange={onFileViewModeChange}
        filePreviewOpenUrl={filePreviewOpenUrl}
        notebookState={isNotebookPreview ? activeNotebookState : undefined}
        isNotebookPdfExporting={
          isNotebookPreview ? isNotebookPdfExporting : undefined
        }
        onNotebookReportPdfDownload={
          isNotebookPreview ? onNotebookReportPdfDownload : undefined
        }
      />

      {activeTabState ? (
        <div
          key={activeTabState.tabId}
          className="flex-1 min-h-0 overflow-hidden"
        >
          {activeTabState.target.kind === "app" ? (
            activeTabState.isLoading ? (
              <div className="flex h-full w-full items-center justify-center bg-muted/30">
                <div className="flex flex-col items-center gap-3">
                  <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
                  <span className="text-sm text-muted-foreground">
                    Loading preview...
                  </span>
                </div>
              </div>
            ) : (
              <iframe
                ref={iframeRef}
                key={activeTabState.iframeKey}
                src={activeTabState.appPreviewUrl || "about:blank"}
                className="h-full w-full bg-white"
                title="Deployed App Preview"
              />
            )
          ) : (
            <div className="h-full">
              <FilePreviewContent
                filename={activeTabState.previewFileName}
                previewUrl={activeTabState.filePreviewUrl}
                contentType={activeTabState.target.contentType}
                layout="panel"
                notebookViewMode={
                  activeTabState.isNotebookPreview
                    ? activeTabState.notebookViewMode
                    : undefined
                }
                fileViewMode={activeTabState.fileViewMode}
                onNotebookStateChange={
                  activeTabState.isNotebookPreview
                    ? (nextState) =>
                        onNotebookStateChange(activeTabState.tabId, nextState)
                    : undefined
                }
              />
            </div>
          )}
        </div>
      ) : null}
    </>
  );
});
