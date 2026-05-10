import { beforeEach, describe, expect, it, vi } from "vitest";

const waitUntilMock = vi.fn();
const requireWorkspaceAccessMock = vi.fn();
const setThreadFirstUserMessageMock = vi.fn();
const generateThreadTitleMock = vi.fn();

vi.mock("@/lib/wait-until", () => ({
  waitUntil: waitUntilMock,
}));

vi.mock("@/routes/api/workspaces.utils", () => ({
  requireWorkspaceAccess: requireWorkspaceAccessMock,
}));

vi.mock("@/lib/chat-do.server", () => ({
  setThreadFirstUserMessage: setThreadFirstUserMessageMock,
  generateThreadTitle: generateThreadTitleMock,
}));

const route = await import(
  "@/routes/api/workspaces.$id.chat.$threadId.first-user-message"
);

describe("first user message API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireWorkspaceAccessMock.mockResolvedValue({ userId: "user_1" });
    setThreadFirstUserMessageMock.mockResolvedValue({
      id: "thread_1",
      workspace_id: "ws_1",
      title: "New Chat",
      first_user_message: "First prompt",
    });
    generateThreadTitleMock.mockResolvedValue(undefined);
  });

  it("persists the first user message and kicks off title generation for placeholder titles", async () => {
    const response = await route.action({
      request: new Request(
        "https://camelai.test/api/workspaces/ws_1/chat/thread_1/first-user-message",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ firstUserMessage: "  First prompt  " }),
        },
      ),
      context: {},
      params: { id: "ws_1", threadId: "thread_1" },
    } as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true });
    expect(setThreadFirstUserMessageMock).toHaveBeenCalledWith(
      {},
      "thread_1",
      "First prompt",
      "ws_1",
    );
    expect(waitUntilMock).toHaveBeenCalledTimes(1);
    expect(generateThreadTitleMock).toHaveBeenCalledWith(
      {},
      "thread_1",
      "ws_1",
      "First prompt",
      "user_1",
    );
  });

  it("does not regenerate the title after a real title already exists", async () => {
    setThreadFirstUserMessageMock.mockResolvedValue({
      id: "thread_1",
      workspace_id: "ws_1",
      title: "Real title",
      first_user_message: "First prompt",
    });

    const response = await route.action({
      request: new Request(
        "https://camelai.test/api/workspaces/ws_1/chat/thread_1/first-user-message",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ firstUserMessage: "First prompt" }),
        },
      ),
      context: {},
      params: { id: "ws_1", threadId: "thread_1" },
    } as never);

    expect(response.status).toBe(200);
    expect(waitUntilMock).not.toHaveBeenCalled();
    expect(generateThreadTitleMock).not.toHaveBeenCalled();
  });

  it("rejects empty first user messages without touching thread metadata", async () => {
    const response = await route.action({
      request: new Request(
        "https://camelai.test/api/workspaces/ws_1/chat/thread_1/first-user-message",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ firstUserMessage: "   " }),
        },
      ),
      context: {},
      params: { id: "ws_1", threadId: "thread_1" },
    } as never);

    expect(response.status).toBe(400);
    expect(setThreadFirstUserMessageMock).not.toHaveBeenCalled();
    expect(waitUntilMock).not.toHaveBeenCalled();
  });

  it("returns 400 for malformed JSON without touching thread metadata", async () => {
    const response = await route.action({
      request: new Request(
        "https://camelai.test/api/workspaces/ws_1/chat/thread_1/first-user-message",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{",
        },
      ),
      context: {},
      params: { id: "ws_1", threadId: "thread_1" },
    } as never);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid JSON" });
    expect(setThreadFirstUserMessageMock).not.toHaveBeenCalled();
    expect(waitUntilMock).not.toHaveBeenCalled();
  });
});
