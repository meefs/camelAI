import { describe, expect, it } from "vitest";
import { buildRawFilePreviewRoute, buildTextPreviewUrls, getFilePreviewUrlDescriptor } from "@/components/chat-file-preview/file-preview-urls";
import { coercePreviewTarget } from "@/components/chat-preview/chat-preview-shell";
import { getPreviewTabId } from "@/components/preview-panel/preview-utils";
import type { PreviewTarget } from "@/types";

const target: Extract<PreviewTarget, { kind: "file" }> = {
  kind: "file", source: "scratch", workspaceId: "ws1", threadId: "t1", path: "/workspace/out/q3 report.html", filename: "q3 report.html",
};

describe("scratch files in the preview panel", () => {
  it("previews through the thread's files route, raw and as text, on chiridion's origin", () => {
    const descriptor = getFilePreviewUrlDescriptor(target);
    expect(buildRawFilePreviewRoute(descriptor)).toBe("/api/threads/t1/files/workspace/out/q3%20report.html");
    const text = buildTextPreviewUrls(descriptor, { refreshKey: 2, maxLines: 50 });
    expect(text.initialUrl).toBe("/api/threads/t1/files/workspace/out/q3%20report.html?text=initial&maxLines=50&v=2");
    expect(text.fullUrl).toBe("/api/threads/t1/files/workspace/out/q3%20report.html?text=full");
  });

  it("keeps a scratch target through the panel's coercion, and gives it its own tab id", () => {
    expect(coercePreviewTarget(target)).toMatchObject({ source: "scratch", threadId: "t1", path: target.path });
    expect(coercePreviewTarget({ ...target, threadId: undefined })).toBeNull();
    expect(getPreviewTabId(target)).toBe("file:ws1:scratch:t1:/workspace/out/q3 report.html");
  });
});
