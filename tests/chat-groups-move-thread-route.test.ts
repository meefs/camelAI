import { beforeEach, describe, expect, it, vi } from "vitest";

const requireSessionWorkspaceAccessMock = vi.fn();
const moveThreadToGroupMock = vi.fn();

vi.mock("@/lib/auth.server", () => ({
  requireSessionWorkspaceAccess: requireSessionWorkspaceAccessMock,
}));

vi.mock("@/lib/chat-groups.server", () => ({
  moveThreadToGroup: moveThreadToGroupMock,
}));

const route = await import("@/routes/api/chat-groups.move-thread");

function makeRequest(body: unknown) {
  return {
    request: new Request("https://camelai.test/api/chat-groups/move-thread", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    context: {},
    params: {},
  } as never;
}

describe("chat groups move-thread route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireSessionWorkspaceAccessMock.mockResolvedValue({
      orgId: "org_1",
      workspaceId: "ws_1",
      userId: "user_1",
    });
    moveThreadToGroupMock.mockResolvedValue({ id: "group_1" });
  });

  it("returns the moved group", async () => {
    const response = await route.action(
      makeRequest({ threadId: "thread_1", targetGroupId: "group_1" }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ group: { id: "group_1" } });
    expect(moveThreadToGroupMock).toHaveBeenCalledWith(
      {},
      {
        userId: "user_1",
        orgId: "org_1",
        workspaceId: "ws_1",
        threadId: "thread_1",
        targetGroupId: "group_1",
        name: undefined,
      },
    );
  });

  it("returns 404 JSON for expected stale thread or group errors", async () => {
    moveThreadToGroupMock.mockRejectedValueOnce(new Error("Chat group not found"));

    const response = await route.action(
      makeRequest({ threadId: "thread_1", targetGroupId: "missing_group" }),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Chat group not found",
    });
  });

  it("returns conflict JSON for other move races", async () => {
    moveThreadToGroupMock.mockRejectedValueOnce(new Error("Thread is already moving"));

    const response = await route.action(
      makeRequest({ threadId: "thread_1", targetGroupId: "group_1" }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Thread is already moving",
    });
  });
});
