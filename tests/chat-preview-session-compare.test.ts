import { describe, expect, it } from "vitest";
import {
  arePreviewSessionsExactlyEqual,
  arePreviewSessionsSemanticallyEqual,
} from "@/components/chat-preview/preview-session-compare";
import type { PreviewTab } from "@/types";

const appTabs: PreviewTab[] = [
  {
    id: "app:demo",
    target: { kind: "app", scriptName: "demo", isPublic: false },
  },
];

describe("preview session comparison", () => {
  it("treats fresh but semantically equal app tabs as equal", () => {
    const nextTabs: PreviewTab[] = [
      {
        id: "app:demo",
        target: { kind: "app", scriptName: "demo", isPublic: false },
      },
    ];

    expect(
      arePreviewSessionsSemanticallyEqual(appTabs, "app:demo", nextTabs, "app:demo"),
    ).toBe(true);
    expect(
      arePreviewSessionsExactlyEqual(appTabs, "app:demo", nextTabs, "app:demo"),
    ).toBe(true);
  });

  it("allows isPublic metadata changes without a semantic reset", () => {
    const nextTabs: PreviewTab[] = [
      {
        id: "app:demo",
        target: { kind: "app", scriptName: "demo", isPublic: true },
      },
    ];

    expect(
      arePreviewSessionsSemanticallyEqual(appTabs, "app:demo", nextTabs, "app:demo"),
    ).toBe(true);
    expect(
      arePreviewSessionsExactlyEqual(appTabs, "app:demo", nextTabs, "app:demo"),
    ).toBe(false);
  });

  it("detects true target changes", () => {
    const currentTabs: PreviewTab[] = [
      {
        id: "file:workspace_1:workspace:index.html",
        target: {
          kind: "file",
          source: "workspace",
          workspaceId: "workspace_1",
          path: "index.html",
          filename: "index.html",
          contentType: "text/html",
        },
      },
    ];
    const nextTabs: PreviewTab[] = [
      {
        id: "file:workspace_1:workspace:index.html",
        target: {
          kind: "file",
          source: "workspace",
          workspaceId: "workspace_1",
          path: "index.html",
          filename: "index.html",
          contentType: "text/plain",
        },
      },
    ];

    expect(
      arePreviewSessionsSemanticallyEqual(
        currentTabs,
        currentTabs[0].id,
        nextTabs,
        nextTabs[0].id,
      ),
    ).toBe(false);
  });
});
