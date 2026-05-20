import { useMemo } from "react";
import type { PreviewTarget, PreviewTab } from "@/types";
import type { OpenElsewhereKind } from "@/components/preview-panel/preview-toolbar";
import {
  buildAppLabel,
  getIframeDomain,
  getVanityDomain,
} from "@/lib/app-url";
import type { TabRenderState } from "./chat-preview-shell";

type NotebookViewMode = "report" | "notebook";
type FileViewMode = "preview" | "source";

function encodePathSegments(path: string) {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function buildFilePreviewRoute(target: Extract<PreviewTarget, { kind: "file" }>) {
  const normalizedPath = target.path.replace(/^\/+/, "");
  const encodedPath = encodePathSegments(normalizedPath);
  return target.source === "workspace"
    ? `fs/content/${encodedPath}`
    : `${target.source === "upload" ? "uploads" : "outputs"}/${encodedPath}`;
}

function buildPreviewDomains(
  target: PreviewTarget | null,
  hostname?: string,
  orgSlug?: string,
) {
  if (target?.kind !== "app") {
    return { iframeHost: "", vanityHost: "" };
  }

  const scriptName = target.scriptName;
  if (orgSlug) {
    return {
      iframeHost: `${buildAppLabel(scriptName, orgSlug)}.${getIframeDomain(hostname)}`,
      vanityHost: `${buildAppLabel(scriptName, orgSlug)}.${getVanityDomain(hostname)}`,
    };
  }

  return {
    iframeHost: `${scriptName}.${getIframeDomain(hostname)}`,
    vanityHost: `${scriptName}.${getVanityDomain(hostname)}`,
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
  readOnly,
}: {
  previewTabs: PreviewTab[];
  previewTarget: PreviewTarget | null;
  tabIframeKeys: Record<string, number>;
  tabAppLoading: Record<string, boolean>;
  tabFilePreviewKeys: Record<string, number>;
  tabNotebookViewModes: Record<string, NotebookViewMode>;
  tabFileViewModes: Record<string, FileViewMode>;
  hostname?: string;
  orgSlug?: string;
  readOnly: boolean;
}) {
  const tabRenderStates = useMemo((): TabRenderState[] => {
    return previewTabs.map((tab) => {
      const target = tab.target;
      const tabId = tab.id;

      if (target.kind === "app") {
        const domains = buildPreviewDomains(target, hostname, orgSlug);
        return {
          tabId,
          target,
          appPreviewUrl: `https://${domains.iframeHost}`,
          vanityHost: domains.vanityHost,
          iframeKey: tabIframeKeys[tabId] ?? 0,
          isLoading: tabAppLoading[tabId] ?? false,
          filePreviewUrl: "",
          filePreviewOpenUrl: "",
          previewFileName: "",
          notebookViewMode: "report",
          fileViewMode: "preview",
          isNotebookPreview: false,
        };
      }

      const route = buildFilePreviewRoute(target);
      const fileKey = tabFilePreviewKeys[tabId] ?? 0;
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
        filePreviewUrl: `/api/workspaces/${target.workspaceId}/${route}?v=${fileKey}`,
        filePreviewOpenUrl: `/api/workspaces/${target.workspaceId}/${route}`,
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
    const route = buildFilePreviewRoute(previewTarget);
    return `/api/workspaces/${previewTarget.workspaceId}/${route}`;
  }, [previewTarget]);

  const fileExternalOpenUrl = useMemo(() => {
    if (previewTarget?.kind !== "file") return "";
    if (previewTarget.source !== "workspace") return "";
    const query = new URLSearchParams();
    query.set("file", previewTarget.path);
    if (readOnly) {
      query.set("adminReadonly", "1");
    }
    return `/computer/${previewTarget.workspaceId}?${query.toString()}`;
  }, [previewTarget, readOnly]);

  const openElsewhereKind: OpenElsewhereKind | null =
    previewTarget?.kind === "app"
      ? "app"
      : previewTarget?.kind === "file" && previewTarget.source === "workspace"
        ? "computer"
        : null;

  return {
    tabRenderStates,
    previewDomains,
    appPreviewVanityUrl,
    filePreviewOpenUrl,
    fileExternalOpenUrl,
    openElsewhereKind,
  };
}
