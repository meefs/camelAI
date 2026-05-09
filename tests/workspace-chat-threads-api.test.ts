import { beforeEach, describe, expect, it, vi } from "vitest";

const waitUntilMock = vi.fn();
const requireSessionWorkspaceAccessMock = vi.fn();
const getEnvMock = vi.fn();
const getAuthEnvMock = vi.fn();
const createThreadMock = vi.fn();

vi.mock("@/lib/wait-until", () => ({
  waitUntil: waitUntilMock,
}));

vi.mock("@/lib/auth.server", () => ({
  requireSessionWorkspaceAccess: requireSessionWorkspaceAccessMock,
}));

vi.mock("@/lib/cloudflare.server", () => ({
  getEnv: getEnvMock,
}));

vi.mock("@/lib/auth-helpers", () => ({
  getAuthEnv: getAuthEnvMock,
}));

vi.mock("@/lib/auth-do", () => ({
  getWorkerScript: vi.fn(),
}));

vi.mock("@/lib/chat-do.server", () => ({
  createThread: createThreadMock,
  deleteThread: vi.fn(),
  generateThreadTitle: vi.fn(),
  setThreadPreviewTarget: vi.fn(),
}));

vi.mock("@/lib/chat-groups.server", () => ({
  addThreadToExistingGroup: vi.fn(),
  createGroupForNewThread: vi.fn().mockResolvedValue({ id: "group_1" }),
}));

const route = await import("@/routes/api/workspaces.$id.chat.threads");

describe("workspace chat threads API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireSessionWorkspaceAccessMock.mockResolvedValue({
      session: { workspace_id: "ws_1" },
      orgId: "org_1",
      workspaceId: "ws_1",
      userId: "user_1",
    });
    getEnvMock.mockReturnValue({});
    getAuthEnvMock.mockReturnValue({});
    createThreadMock.mockResolvedValue({
      id: "thread_1",
      workspace_id: "ws_1",
      title: "New Chat",
    });
  });

  it("returns 400 for malformed JSON", async () => {
    const response = await route.action({
      request: new Request("https://camelai.test/api/workspaces/ws_1/chat/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{",
      }),
      context: {},
      params: { id: "ws_1" },
    } as never);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid JSON" });
    expect(createThreadMock).not.toHaveBeenCalled();
  });
});
