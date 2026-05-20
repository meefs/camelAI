import type { PreviewTab, PreviewTarget } from "@/types";

function arePreviewTargetsSemanticallyEqual(
  left: PreviewTarget,
  right: PreviewTarget,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "app" && right.kind === "app") {
    return left.scriptName === right.scriptName;
  }
  if (left.kind === "file" && right.kind === "file") {
    return (
      left.workspaceId === right.workspaceId &&
      left.source === right.source &&
      left.path === right.path &&
      left.contentType === right.contentType &&
      left.filename === right.filename
    );
  }
  return false;
}

export function arePreviewSessionsSemanticallyEqual(
  currentTabs: PreviewTab[],
  currentActiveTabId: string | null,
  nextTabs: PreviewTab[],
  nextActiveTabId: string | null,
): boolean {
  if (currentActiveTabId !== nextActiveTabId) return false;
  if (currentTabs.length !== nextTabs.length) return false;

  for (let index = 0; index < currentTabs.length; index += 1) {
    const currentTab = currentTabs[index];
    const nextTab = nextTabs[index];
    if (currentTab.id !== nextTab.id) return false;
    if (!arePreviewTargetsSemanticallyEqual(currentTab.target, nextTab.target)) {
      return false;
    }
  }

  return true;
}

export function arePreviewSessionsExactlyEqual(
  currentTabs: PreviewTab[],
  currentActiveTabId: string | null,
  nextTabs: PreviewTab[],
  nextActiveTabId: string | null,
): boolean {
  if (!arePreviewSessionsSemanticallyEqual(
    currentTabs,
    currentActiveTabId,
    nextTabs,
    nextActiveTabId,
  )) {
    return false;
  }

  return currentTabs.every((currentTab, index) => {
    const nextTab = nextTabs[index];
    if (currentTab.target.kind !== "app" || nextTab.target.kind !== "app") {
      return true;
    }
    return currentTab.target.isPublic === nextTab.target.isPublic;
  });
}
