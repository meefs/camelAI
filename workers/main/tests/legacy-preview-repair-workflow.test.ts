import { describe, expect, it } from "vitest";
import {
  buildPreviewRepairIndex,
  repairLegacyPreviewState,
} from "../src/legacy-preview-repair-workflow";
import type { PreviewTarget } from "../src/chat-thread-do";

const workspaceId = "workspace-1";

function workspaceNotebook(path: string): PreviewTarget {
  return {
    kind: "file",
    source: "workspace",
    workspaceId,
    path,
    filename: path.split("/").pop(),
    contentType: "application/x-ipynb+json",
  };
}

describe("legacy preview repair workflow", () => {
  it("rewrites old workspace notebook previews to migrated project VM previews", () => {
    const index = buildPreviewRepairIndex({
      projects: [
        {
          name: "oikos-glp-analysis",
          description: "Oikos analysis notebooks.",
          sourcePaths: [
            "/home/claude/oikos_analysis.ipynb",
            "/home/claude/oikos_sources_analysis.ipynb",
          ],
        },
      ],
    });
    const active = "file:workspace-1:workspace::/oikos_sources_analysis.ipynb";

    const repaired = repairLegacyPreviewState({
      target: workspaceNotebook("/oikos_sources_analysis.ipynb"),
      tabs: [
        workspaceNotebook("/oikos_analysis.ipynb"),
        workspaceNotebook("/oikos_sources_analysis.ipynb"),
      ],
      activeTabId: active,
    }, workspaceId, index);

    expect(repaired.changed).toBe(true);
    expect(repaired.repaired).toBe(2);
    expect(repaired.tabs).toEqual([
      {
        kind: "file",
        source: "vm",
        workspaceId,
        path: "/workspace/oikos_analysis.ipynb",
        project: "oikos-glp-analysis",
        filename: "oikos_analysis.ipynb",
        contentType: "application/x-ipynb+json",
      },
      {
        kind: "file",
        source: "vm",
        workspaceId,
        path: "/workspace/oikos_sources_analysis.ipynb",
        project: "oikos-glp-analysis",
        filename: "oikos_sources_analysis.ipynb",
        contentType: "application/x-ipynb+json",
      },
    ]);
    expect(repaired.activeTabId).toBe(
      "file:workspace-1:vm:oikos-glp-analysis:/workspace/oikos_sources_analysis.ipynb",
    );
  });

  it("maps previews inside migrated source directories to /workspace-relative VM paths", () => {
    const index = buildPreviewRepairIndex({
      projects: [
        {
          name: "analysis-project",
          description: "Analysis project.",
          sourcePaths: ["/home/claude/projects/analysis-project"],
        },
      ],
    });

    const repaired = repairLegacyPreviewState({
      target: workspaceNotebook("/projects/analysis-project/reports/final.ipynb"),
      tabs: [],
      activeTabId: null,
    }, workspaceId, index);

    expect(repaired.changed).toBe(true);
    expect(repaired.tabs[0]).toMatchObject({
      source: "vm",
      project: "analysis-project",
      path: "/workspace/reports/final.ipynb",
    });
  });

  it("uses the longest source path when parent and child migrated projects overlap", () => {
    const index = buildPreviewRepairIndex({
      projects: [
        {
          name: "projects-parent-support",
          description: "Parent project files.",
          sourcePaths: ["/home/claude/projects"],
        },
        {
          name: "sf-muni",
          description: "Nested app.",
          sourcePaths: ["/home/claude/projects/sf-muni"],
        },
      ],
    });

    const repaired = repairLegacyPreviewState({
      target: workspaceNotebook("/projects/sf-muni/notebook.ipynb"),
      tabs: [],
      activeTabId: null,
    }, workspaceId, index);

    expect(repaired.changed).toBe(true);
    expect(repaired.tabs[0]).toMatchObject({
      source: "vm",
      project: "sf-muni",
      path: "/workspace/notebook.ipynb",
    });
  });

  it("leaves ambiguous duplicate source file previews unchanged", () => {
    const index = buildPreviewRepairIndex({
      projects: [
        {
          name: "one",
          description: "First duplicate.",
          sourcePaths: ["/home/claude/analysis.ipynb"],
        },
        {
          name: "two",
          description: "Second duplicate.",
          sourcePaths: ["/home/claude/analysis.ipynb"],
        },
      ],
    });

    const repaired = repairLegacyPreviewState({
      target: workspaceNotebook("/analysis.ipynb"),
      tabs: [],
      activeTabId: null,
    }, workspaceId, index);

    expect(repaired.changed).toBe(false);
    expect(repaired.ambiguous).toBe(1);
    expect(repaired.tabs[0]).toMatchObject({
      source: "workspace",
      path: "/analysis.ipynb",
    });
  });
});

