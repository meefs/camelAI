import { describe, expect, it, vi } from "vitest";

import { editAutomationVirtualFile } from "../src/deterministic-automation-virtual-files";

describe("editAutomationVirtualFile", () => {
  it("uses the shared edit engine and conditionally updates the source version", async () => {
    const updateDeterministicAutomation = vi.fn(async (input: Record<string, unknown>) => ({
      id: input.id,
      source_version: 8,
    }));
    const cronStub = {
      getDeterministicAutomationSource: vi.fn(async () => ({
        automation_id: "daily",
        workspace_id: "workspace-1",
        source_version: 7,
        source: "const label = “daily”;  \n",
        created_by: "user-1",
      })),
      updateDeterministicAutomation,
    };

    const result = await editAutomationVirtualFile({
      cronStub: cronStub as never,
      workspaceId: "workspace-1",
      path: "/workspace/.camelai/automations/daily.js",
      edits: [{ oldText: 'const label = "daily";', newText: 'const label = "weekly";' }],
    });

    expect(updateDeterministicAutomation).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      id: "daily",
      source: 'const label = "weekly";\n',
      expectedSourceVersion: 7,
    });
    expect(result?.details).toMatchObject({
      source_version: 8,
      usedFuzzyMatch: true,
      replacementCount: 1,
    });
  });

  it("preserves an optimistic concurrency conflict", async () => {
    const cronStub = {
      getDeterministicAutomationSource: vi.fn(async () => ({
        automation_id: "daily",
        workspace_id: "workspace-1",
        source_version: 7,
        source: "old",
        created_by: "user-1",
      })),
      updateDeterministicAutomation: vi.fn(async () => {
        throw new Error("Automation edit conflict: source version changed");
      }),
    };

    await expect(editAutomationVirtualFile({
      cronStub: cronStub as never,
      workspaceId: "workspace-1",
      path: "/workspace/.camelai/automations/daily.js",
      edits: [{ oldText: "old", newText: "new" }],
    })).rejects.toThrow("Automation edit conflict");
  });
});
