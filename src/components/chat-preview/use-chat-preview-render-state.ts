import { useMemo } from "react";
import type { PreviewTarget, PreviewTab } from "@/types";
import type { OpenElsewhereKind } from "@/components/preview-panel/preview-toolbar";
import {
  type AppUrlInput,
  getAppIframeUrl,
  getAppUrl,
} from "@/lib/app-url";
import {
  buildRawFilePreviewRoute,
  buildTextPreviewUrls,
  getFilePreviewUrlDescriptor,
} from "@/components/chat-file-preview/file-preview-urls";
import type { TabRenderState } from "./chat-preview-shell";

type NotebookViewMode = "report" | "notebook";
type FileViewMode = "preview" | "source";

function buildPreviewDomains(
  target: PreviewTarget | null,
  hostname?: AppUrlInput,
  orgSlug?: string,
): { appPreviewUrl: string; vanityHost: string } {
  if (target?.kind !== "app" || !orgSlug) {
    return { appPreviewUrl: "", vanityHost: "" };
  }

  const scriptName = target.scriptName;
  const appPreviewUrl = getAppIframeUrl(scriptName, hostname, orgSlug);
  const vanityUrl = getAppUrl(scriptName, hostname, orgSlug);
  return {
    appPreviewUrl,
    vanityHost: new URL(vanityUrl).host,
  };
}

export function useChatPreviewRenderState({
  previewTabs,
  previewTarget,
  tabIframeKeys,
  tabAppLoading,
  tabFilePreviewKeys,
  tabNotebookViewModes,
  tabFileViewModes,
  hostname,
  orgSlug,
}: {
  previewTabs: PreviewTab[];
  previewTarget: PreviewTarget | null;
  tabIframeKeys: Record<string, number>;
  tabAppLoading: Record<string, boolean>;
  tabFilePreviewKeys: Record<string, number>;
  tabNotebookViewModes: Record<string, NotebookViewMode>;
  tabFileViewModes: Record<string, FileViewMode>;
  hostname?: AppUrlInput;
  orgSlug?: string;
}) {
  const tabRenderStates = useMemo((): TabRenderState[] => {
    return previewTabs.map((tab) => {
      const target = tab.target;
      const tabId = tab.id;

      if (target.kind === "runtime_artifact") {
        return {
          tabId,
          target,
          appPreviewUrl: "",
          vanityHost: "",
          iframeKey: 0,
          isLoading: false,
          filePreviewUrl: "",
          filePreviewOpenUrl: "",
          fileTextPreviewUrl: "",
          fileFullTextPreviewUrl: "",
          previewFileName: "",
          notebookViewMode: "report",
          fileViewMode: "preview",
          isNotebookPreview: false,
        };
      }

      if (target.kind === "app") {
        const domains = buildPreviewDomains(target, hostname, orgSlug);
        return {
          tabId,
          target,
          appPreviewUrl: domains.appPreviewUrl,
          vanityHost: domains.vanityHost,
          iframeKey: tabIframeKeys[tabId] ?? 0,
          isLoading: tabAppLoading[tabId] ?? false,
          filePreviewUrl: "",
          filePreviewOpenUrl: "",
          fileTextPreviewUrl: "",
          fileFullTextPreviewUrl: "",
          previewFileName: "",
          notebookViewMode: "report",
          fileViewMode: "preview",
          isNotebookPreview: false,
        };
      }

      const descriptor = getFilePreviewUrlDescriptor(target);
      const rawPreviewUrl = buildRawFilePreviewRoute(descriptor);
      const fileKey = tabFilePreviewKeys[tabId] ?? 0;
      const textPreviewUrls = buildTextPreviewUrls(descriptor, {
        refreshKey: fileKey,
      });
      const filename =
        target.filename ||
        target.path.split("/").filter(Boolean).pop() ||
        "file";
      const isNotebook = filename.toLowerCase().endsWith(".ipynb");
      return {
        tabId,
        target,
        appPreviewUrl: "",
        vanityHost: "",
        iframeKey: 0,
        isLoading: false,
        filePreviewUrl: `${rawPreviewUrl}?v=${fileKey}`,
        filePreviewOpenUrl: rawPreviewUrl,
        fileTextPreviewUrl: textPreviewUrls.initialUrl,
        fileFullTextPreviewUrl: textPreviewUrls.fullUrl,
        previewFileName: filename,
        notebookViewMode: tabNotebookViewModes[tabId] ?? "report",
        fileViewMode: tabFileViewModes[tabId] ?? "preview",
        isNotebookPreview: isNotebook,
      };
    });
  }, [
    previewTabs,
    tabIframeKeys,
    tabAppLoading,
    tabFilePreviewKeys,
    tabNotebookViewModes,
    tabFileViewModes,
    hostname,
    orgSlug,
  ]);

  const previewDomains = useMemo(
    () => buildPreviewDomains(previewTarget, hostname, orgSlug),
    [previewTarget, hostname, orgSlug],
  );
  const appPreviewVanityUrl = previewDomains.vanityHost
    ? `https://${previewDomains.vanityHost}`
    : "";

  const filePreviewOpenUrl = useMemo(() => {
    if (previewTarget?.kind !== "file") return "";
    return buildRawFilePreviewRoute(getFilePreviewUrlDescriptor(previewTarget));
  }, [previewTarget]);

  const openElsewhereKind: OpenElsewhereKind | null =
    previewTarget?.kind === "app" ? "app" : null;

  return {
    tabRenderStates,
    previewDomains,
    appPreviewVanityUrl,
    filePreviewOpenUrl,
    openElsewhereKind,
  };
}
