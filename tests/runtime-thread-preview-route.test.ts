import { describe, expect, it, vi } from "vitest";

const getThreadUiState = vi.fn();
vi.mock("@/lib/runtime-threads.server", () => ({
  requestWorkspaceId: () => null,
  requireRuntimeThread: vi.fn(async () => ({
    env: { ORG: { idFromName: (name: string) => name, get: () => ({ getThreadUiState }) } },
    context: { orgId: "org1", workspaceId: "ws1", threadId: "t1" },
  })),
}));

const { loader } = await import("@/routes/api/threads.$id.preview");

describe("GET /api/threads/:id/preview", () => {
  it("answers the thread's saved preview, normalized as stored", async () => {
    getThreadUiState.mockResolvedValue({
      preview: {
        tabs: [
          { kind: "file", source: "project", workspaceId: "ws1", project: "sales", path: "analysis.ipynb" },
          { kind: "app", scriptName: "shop", isPublic: false },
          { kind: "file", source: "workspace", workspaceId: "other", path: "/x" },
        ],
        activeTabId: "app:shop",
      },
      previewVersion: 4,
    });
    const response = await loader({ request: new Request("https://camelai.test/api/threads/t1/preview"), context: {}, params: { id: "t1" } } as never) as Response;
    expect(await response.json()).toEqual({
      preview: {
        tabs: [
          expect.objectContaining({ kind: "file", source: "project", project: "sales", path: "analysis.ipynb" }),
          { kind: "app", scriptName: "shop", isPublic: false },
        ],
        activeTabId: "app:shop",
      },
      previewVersion: 4,
    });
  });

  it("answers no tabs for a thread that saved none", async () => {
    getThreadUiState.mockResolvedValue(null);
    const response = await loader({ request: new Request("https://camelai.test/api/threads/t1/preview"), context: {}, params: { id: "t1" } } as never) as Response;
    expect(await response.json()).toEqual({ preview: { tabs: [], activeTabId: null }, previewVersion: 0 });
  });
});
