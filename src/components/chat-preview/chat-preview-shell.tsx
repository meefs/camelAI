import { memo, type ReactNode, type RefObject } from "react";
import { AlertCircle, CheckCircle2, Mail, MessageCircle, RefreshCw, Send } from "lucide-react";
import type { PreviewTab, PreviewTarget } from "@/types";
import type { RuntimeCallArtifact } from "@/lib/runtime-artifacts";
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

  if (record.kind === "runtime_artifact") {
    const artifact = record.artifact;
    if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
      return null;
    }
    const artifactRecord = artifact as Record<string, unknown>;
    if (
      typeof artifactRecord.id !== "string" ||
      typeof artifactRecord.kind !== "string" ||
      typeof artifactRecord.title !== "string" ||
      typeof artifactRecord.status !== "string" ||
      typeof artifactRecord.createdAt !== "number" ||
      typeof artifactRecord.updatedAt !== "number" ||
      !artifactRecord.summary ||
      typeof artifactRecord.summary !== "object" ||
      Array.isArray(artifactRecord.summary)
    ) {
      return null;
    }
    return {
      kind: "runtime_artifact",
      artifact: artifact as RuntimeCallArtifact,
    } as PreviewTarget;
  }

  if (record.kind === "file") {
    if (
      typeof record.workspaceId !== "string" ||
      typeof record.path !== "string" ||
      (record.source !== "workspace" &&
        record.source !== "project" &&
        record.source !== "upload" &&
        record.source !== "output")
    ) {
      return null;
    }
    const project =
      record.source === "project" && typeof record.project === "string"
        ? record.project.trim()
        : undefined;
    if (record.source === "project" && !project) {
      return null;
    }
    return {
      kind: "file",
      source: record.source,
      workspaceId: record.workspaceId,
      path: record.path,
      project,
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

function RuntimeArtifactPreviewContent({
  target,
}: {
  target: Extract<PreviewTarget, { kind: "runtime_artifact" }>;
}) {
  const { artifact } = target;
  const isFailed = artifact.status === "failed";
  const Icon = artifact.kind === "outbound_email"
    ? Mail
    : artifact.kind === "outbound_slack_message"
      ? MessageCircle
      : Send;
  const entries = Object.entries({ ...artifact.summary, ...artifact.result })
    .filter(([, value]) => value !== undefined && value !== null && value !== "");

  return (
    <div className="h-full overflow-auto bg-background p-6">
      <div className="mx-auto max-w-xl rounded-xl border border-border bg-card p-5 shadow-sm">
        <div className="flex items-start gap-3">
          <div className="rounded-full bg-muted p-2">
            <Icon className="h-5 w-5 text-muted-foreground" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              {isFailed ? (
                <AlertCircle className="h-4 w-4 text-destructive" />
              ) : (
                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              )}
              <h2 className="truncate text-base font-semibold text-foreground">
                {artifact.title}
              </h2>
            </div>
            {artifact.subtitle ? (
              <p className="mt-1 text-sm text-muted-foreground">{artifact.subtitle}</p>
            ) : null}
            <p className="mt-2 text-xs text-muted-foreground">
              {new Date(artifact.updatedAt).toLocaleString()}
            </p>
          </div>
        </div>

        {artifact.error ? (
          <div className="mt-4 rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">
            {artifact.error.message}
          </div>
        ) : null}

        {entries.length > 0 ? (
          <dl className="mt-5 grid gap-3 text-sm">
            {entries.map(([key, value]) => (
              <div key={key} className="grid grid-cols-[140px_1fr] gap-3 border-t border-border pt-3 first:border-t-0 first:pt-0">
                <dt className="text-muted-foreground">{key}</dt>
                <dd className="min-w-0 break-words font-mono text-xs text-foreground">
                  {typeof value === "string" || typeof value === "number" || typeof value === "boolean"
                    ? String(value)
                    : JSON.stringify(value)}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
      </div>
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
  fileTextPreviewUrl: string;
  fileFullTextPreviewUrl: string;
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
          {activeTabState.target.kind === "runtime_artifact" ? (
            <RuntimeArtifactPreviewContent target={activeTabState.target} />
          ) : activeTabState.target.kind === "app" ? (
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
                sandbox="allow-downloads allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
                className="h-full w-full bg-white"
                title="Deployed App Preview"
              />
            )
          ) : (
            <div className="h-full">
              <FilePreviewContent
                filename={activeTabState.previewFileName}
                previewUrl={activeTabState.filePreviewUrl}
                fileTextPreviewUrl={activeTabState.fileTextPreviewUrl}
                fileFullTextPreviewUrl={activeTabState.fileFullTextPreviewUrl}
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
