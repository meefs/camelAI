import { beforeEach, describe, expect, it, vi } from "vitest";

const requireSessionWorkspaceAccessMock = vi.fn();
const getEnvMock = vi.fn();
const getAuthEnvMock = vi.fn();
const getThreadMock = vi.fn();
const getChatGroupMock = vi.fn();
const getChatGroupSummaryMock = vi.fn();
const closeThreadTabMock = vi.fn();
const reopenThreadTabMock = vi.fn();
const reorderThreadTabsMock = vi.fn();
const updateChatGroupMock = vi.fn();

vi.mock("@/lib/auth.server", () => ({
  requireSessionWorkspaceAccess: requireSessionWorkspaceAccessMock,
}));

vi.mock("@/lib/cloudflare.server", () => ({
  getEnv: getEnvMock,
}));

vi.mock("@/lib/auth-helpers", () => ({
  getAuthEnv: getAuthEnvMock,
}));

vi.mock("@/lib/chat-do.server", () => ({
  getThread: getThreadMock,
}));

const closeRoute = await import("@/routes/api/chat-groups.$id.members.$threadId");
const groupRoute = await import("@/routes/api/chat-groups.$id");
const addRoute = await import("@/routes/api/chat-groups.$id.members");
const reopenRoute = await import(
  "@/routes/api/chat-groups.$id.members.$threadId.reopen"
);
const reorderRoute = await import("@/routes/api/chat-groups.$id.reorder-tabs");

const group = {
  id: "group_1",
  org_id: "org_1",
  workspace_id: "workspace_1",
  name: "Launch",
  avatar: { color: "#4F46E5", content: "💬" },
  last_active_thread_id: null,
  created_at: 1,
  updated_at: 1,
};

function makeArgs(method: string) {
  return {
    request: new Request(
      "https://camelai.com/api/chat-groups/group_1/members/thread_1",
      { method },
    ),
    context: {},
    params: { id: "group_1", threadId: "thread_1" },
  } as never;
}

function makeAddArgs(body: unknown) {
  return {
    request: new Request(
      "https://camelai.com/api/chat-groups/group_1/members",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
    context: {},
    params: { id: "group_1" },
  } as never;
}

function makeGroupArgs(method: string) {
  return {
    request: new Request(
      "https://camelai.com/api/chat-groups/group_1",
      { method },
    ),
    context: {},
    params: { id: "group_1" },
  } as never;
}

function makePatchGroupArgs(body: unknown) {
  return {
    request: new Request("https://camelai.com/api/chat-groups/group_1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    context: {},
    params: { id: "group_1" },
  } as never;
}

function makeReorderArgs(orderedThreadIds: unknown) {
  return {
    request: new Request(
      "https://camelai.com/api/chat-groups/group_1/reorder-tabs",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderedThreadIds }),
      },
    ),
    context: {},
    params: { id: "group_1" },
  } as never;
}

describe("chat group tab routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireSessionWorkspaceAccessMock.mockResolvedValue({
      orgId: "org_1",
      workspaceId: "workspace_1",
      userId: "user_1",
    });
    getThreadMock.mockResolvedValue({
      id: "thread_1",
      workspace_id: "workspace_1",
      title: "Thread",
    });
    getEnvMock.mockReturnValue({});
    getAuthEnvMock.mockReturnValue({
      USER: {
        idFromName: (id: string) => id,
        get: () => ({
          getChatGroup: getChatGroupMock,
          getChatGroupSummary: getChatGroupSummaryMock,
          closeThreadTab: closeThreadTabMock,
          reopenThreadTab: reopenThreadTabMock,
          reorderThreadTabs: reorderThreadTabsMock,
          updateChatGroup: updateChatGroupMock,
        }),
      },
    });
    getChatGroupMock.mockResolvedValue(group);
  });

  it("rejects closing a thread that is not open in the URL group", async () => {
    getChatGroupSummaryMock.mockResolvedValue({
      ...group,
      open_thread_ids: ["thread_2"],
      closed_thread_ids: ["thread_1"],
    });

    const response = await closeRoute.action(makeArgs("DELETE"));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Thread is not an open tab in this group",
    });
    expect(closeThreadTabMock).not.toHaveBeenCalled();
  });

  it("closes a thread only when it is open in the URL group", async () => {
    getChatGroupSummaryMock.mockResolvedValue({
      ...group,
      open_thread_ids: ["thread_1"],
      closed_thread_ids: [],
    });

    const response = await closeRoute.action(makeArgs("DELETE"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true });
    expect(closeThreadTabMock).toHaveBeenCalledWith("thread_1");
  });

  it("returns 404 JSON when adding a stale thread to a group", async () => {
    getThreadMock.mockResolvedValue(null);

    const response = await addRoute.action(makeAddArgs({ threadId: "thread_1" }));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Thread not found",
    });
  });

  it("returns 404 JSON when deleting a stale group", async () => {
    getChatGroupMock.mockResolvedValue(null);

    const response = await groupRoute.action(makeGroupArgs("DELETE"));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Chat group not found",
    });
  });

  it("returns 404 JSON when adding a thread to a stale group", async () => {
    getChatGroupMock.mockResolvedValue(null);

    const response = await addRoute.action(makeAddArgs({ threadId: "thread_1" }));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Chat group not found",
    });
  });

  it("returns generic 500 JSON when adding a thread fails unexpectedly", async () => {
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    getThreadMock.mockRejectedValueOnce(new Error("database exploded"));

    const response = await addRoute.action(makeAddArgs({ threadId: "thread_1" }));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Failed to add thread to group",
    });
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it("rejects reopening a thread that is not closed in the URL group", async () => {
    getChatGroupSummaryMock.mockResolvedValue({
      ...group,
      open_thread_ids: ["thread_1"],
      closed_thread_ids: [],
    });

    const response = await reopenRoute.action(makeArgs("POST"));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Thread is not a closed tab in this group",
    });
    expect(reopenThreadTabMock).not.toHaveBeenCalled();
  });

  it("reopens a thread only when it is closed in the URL group", async () => {
    getChatGroupSummaryMock.mockResolvedValue({
      ...group,
      open_thread_ids: [],
      closed_thread_ids: ["thread_1"],
    });

    const response = await reopenRoute.action(makeArgs("POST"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true });
    expect(reopenThreadTabMock).toHaveBeenCalledWith("thread_1");
  });

  it("rejects reorders that include closed tab IDs", async () => {
    getChatGroupSummaryMock.mockResolvedValue({
      ...group,
      open_thread_ids: ["thread_1", "thread_2"],
      closed_thread_ids: ["thread_3"],
    });

    const response = await reorderRoute.action(
      makeReorderArgs(["thread_2", "thread_3"]),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Tab order must exactly match open tabs",
    });
    expect(reorderThreadTabsMock).not.toHaveBeenCalled();
  });

  it("rejects duplicate or incomplete reorder payloads", async () => {
    getChatGroupSummaryMock.mockResolvedValue({
      ...group,
      open_thread_ids: ["thread_1", "thread_2"],
      closed_thread_ids: [],
    });

    const duplicateResponse = await reorderRoute.action(
      makeReorderArgs(["thread_1", "thread_1"]),
    );
    const missingResponse = await reorderRoute.action(
      makeReorderArgs(["thread_1"]),
    );

    expect(duplicateResponse.status).toBe(400);
    expect(missingResponse.status).toBe(400);
    expect(reorderThreadTabsMock).not.toHaveBeenCalled();
  });

  it("accepts exact open-tab reorder payloads", async () => {
    getChatGroupSummaryMock.mockResolvedValue({
      ...group,
      open_thread_ids: ["thread_1", "thread_2"],
      closed_thread_ids: ["thread_3"],
    });

    const response = await reorderRoute.action(
      makeReorderArgs(["thread_2", "thread_1"]),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true });
    expect(reorderThreadTabsMock).toHaveBeenCalledWith("group_1", [
      "thread_2",
      "thread_1",
    ]);
  });

  it("updates a group name and avatar through PATCH", async () => {
    const response = await groupRoute.action(
      makePatchGroupArgs({
        name: "  Planning  ",
        avatar: { color: "#e0476b", content: "🌊" },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true });
    expect(updateChatGroupMock).toHaveBeenCalledWith("group_1", {
      name: "Planning",
      avatar: { color: "#E0476B", content: "🌊" },
    });
  });

  it("rejects invalid PATCH avatar payloads", async () => {
    const response = await groupRoute.action(
      makePatchGroupArgs({
        avatar: { color: "#e0476b", content: "JS" },
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid avatar" });
    expect(updateChatGroupMock).not.toHaveBeenCalled();
  });
});
