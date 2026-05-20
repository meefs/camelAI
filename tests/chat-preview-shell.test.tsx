import { createRef } from "react";
import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_NOTEBOOK_PREVIEW_STATE,
  PreviewPanelShell,
  type TabRenderState,
} from "@/components/chat-preview/chat-preview-shell";
import type { PreviewTab, PreviewTarget } from "@/types";

vi.mock("@/lib/shiki-config", () => ({
  codeToHtml: vi.fn(() => new Promise<string>(() => {})),
  SHIKI_DEFAULT_THEMES: {
    light: "github-light",
    dark: "github-dark",
  },
  SUPPORTED_LANGUAGES: new Set(["html", "text"]),
}));

const appTarget: PreviewTarget = {
  kind: "app",
  scriptName: "demo-app",
  isPublic: false,
};

const fileTarget: PreviewTarget = {
  kind: "file",
  source: "workspace",
  workspaceId: "workspace_1",
  path: "index.html",
  filename: "index.html",
  contentType: "text/html",
};

const previewTabs: PreviewTab[] = [
  { id: "app:demo-app", target: appTarget },
  { id: "file:workspace_1:workspace:index.html", target: fileTarget },
];

const tabRenderStates: TabRenderState[] = [
  {
    tabId: "app:demo-app",
    target: appTarget,
    appPreviewUrl: "https://demo.example.test",
    vanityHost: "demo.example.test",
    iframeKey: 0,
    isLoading: false,
    filePreviewUrl: "",
    filePreviewOpenUrl: "",
    previewFileName: "",
    notebookViewMode: "report",
    fileViewMode: "preview",
    isNotebookPreview: false,
  },
  {
    tabId: "file:workspace_1:workspace:index.html",
    target: fileTarget,
    appPreviewUrl: "",
    vanityHost: "",
    iframeKey: 0,
    isLoading: false,
    filePreviewUrl: "/api/workspaces/workspace_1/fs/content/index.html?v=0",
    filePreviewOpenUrl: "/api/workspaces/workspace_1/fs/content/index.html",
    previewFileName: "index.html",
    notebookViewMode: "report",
    fileViewMode: "source",
    isNotebookPreview: false,
  },
];

function renderShell(activeTabId: string, previewTarget: PreviewTarget) {
  return render(
    <PreviewPanelShell
      previewTabs={previewTabs}
      activeTabId={activeTabId}
      previewTarget={previewTarget}
      onTabSelect={vi.fn()}
      onTabClose={vi.fn()}
      onRefresh={vi.fn()}
      openElsewhereKind={null}
      onOpenElsewhere={vi.fn()}
      notebookViewMode="report"
      onNotebookViewModeChange={vi.fn()}
      fileViewMode="preview"
      onFileViewModeChange={vi.fn()}
      filePreviewOpenUrl=""
      activeNotebookState={DEFAULT_NOTEBOOK_PREVIEW_STATE}
      isNotebookPdfExporting={false}
      onNotebookStateChange={vi.fn()}
      onNotebookReportPdfDownload={vi.fn()}
      iframeRef={createRef<HTMLIFrameElement>()}
      tabRenderStates={tabRenderStates}
      vanityUrl=""
      vanityHost=""
    />,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PreviewPanelShell", () => {
  it("mounts only the active app preview body and does not fetch inactive files", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { container } = renderShell("app:demo-app", appTarget);

    expect(container.querySelectorAll("iframe")).toHaveLength(1);
    expect(container.querySelector("iframe")).toHaveAttribute(
      "src",
      "https://demo.example.test",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("mounts the active file preview and fetches source on demand", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: vi.fn().mockResolvedValue("<!doctype html><h1>Active file</h1>"),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = renderShell(
      "file:workspace_1:workspace:index.html",
      fileTarget,
    );

    expect(container.querySelectorAll("iframe")).toHaveLength(0);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/workspaces/workspace_1/fs/content/index.html?v=0",
    );
  });
});
