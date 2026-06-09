import { beforeEach, describe, expect, it, vi } from "vitest";

const getEnvMock = vi.fn();
const getPiCoreMessagesMock = vi.fn();
const hydratePiCoreFromParsedMessagesMock = vi.fn();
const getLegacyClaudeSessionIdMock = vi.fn();
const getCodexSessionIdMock = vi.fn();

vi.mock("@/lib/cloudflare.server", () => ({
  getEnv: getEnvMock,
}));

vi.mock("@/lib/chat-do.server", () => ({
  getPiCoreMessages: getPiCoreMessagesMock,
  hydratePiCoreFromParsedMessages: hydratePiCoreFromParsedMessagesMock,
  getLegacyClaudeSessionId: getLegacyClaudeSessionIdMock,
  getCodexSessionId: getCodexSessionIdMock,
}));

const { readThreadMessages } = await import("@/lib/chat-history.server");

describe("readThreadMessages legacy fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPiCoreMessagesMock.mockResolvedValue([]);
    hydratePiCoreFromParsedMessagesMock.mockResolvedValue({
      hydrated: true,
      count: 1,
      existingCount: 0,
    });
    getLegacyClaudeSessionIdMock.mockResolvedValue("claude-session");
    getCodexSessionIdMock.mockResolvedValue("codex-session");
  });

  it("hydrates legacy sandbox-host messages into Pi core history when Pi core is empty", async () => {
    getPiCoreMessagesMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "message-1",
          thread_id: "thread-1",
          role: "user",
          content: "hello",
          created_at: 123,
        },
      ]);
    const fetchMock = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      expect(url.pathname).toBe("/v1/workspaces/org-1/workspace-1/chat/messages");
      expect(url.searchParams.get("threadId")).toBe("thread-1");
      expect(url.searchParams.get("claudeSessionId")).toBe("claude-session");
      expect(url.searchParams.get("codexSessionId")).toBe("codex-session");

      return Response.json({
        messages: [
          {
            id: "message-1",
            thread_id: "thread-1",
            role: "user",
            content: "hello",
            created_at: 123,
          },
        ],
      });
    });
    getEnvMock.mockReturnValue({
      LEGACY_WORKSPACE_HOST: { fetch: fetchMock },
    });

    const messages = await readThreadMessages({} as never, {
      orgId: "org-1",
      workspaceId: "workspace-1",
      threadId: "thread-1",
    });

    expect(messages).toEqual([
      {
        id: "message-1",
        thread_id: "thread-1",
        role: "user",
        content: "hello",
        created_at: 123,
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(hydratePiCoreFromParsedMessagesMock).toHaveBeenCalledTimes(1);
  });

  it("hydrates sentDuringStreaming from legacy history messages", async () => {
    getPiCoreMessagesMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "message-1",
          thread_id: "thread-1",
          role: "user",
          content: "also add dark mode",
          created_at: 123,
          sentDuringStreaming: true,
        },
      ]);
    getEnvMock.mockReturnValue({
      LEGACY_WORKSPACE_HOST: {
        fetch: vi.fn(async () =>
          Response.json({
            messages: [
              {
                id: "message-1",
                thread_id: "thread-1",
                role: "user",
                content: "also add dark mode",
                created_at: 123,
                sentDuringStreaming: true,
              },
            ],
          }),
        ),
      },
    });

    const messages = await readThreadMessages({} as never, {
      orgId: "org-1",
      workspaceId: "workspace-1",
      threadId: "thread-1",
    });

    expect(messages[0]).toMatchObject({
      id: "message-1",
      role: "user",
      sentDuringStreaming: true,
    });
  });

  it("merges legacy history before Pi core bug-period messages", async () => {
    const bugPeriodMessage = {
      id: "pi-message",
      thread_id: "thread-1",
      role: "user",
      content: "new message from broken window",
      created_at: 456,
    };
    const hydratedLegacyMessage = {
      id: "legacy-message",
      thread_id: "thread-1",
      role: "user",
      content: "original message",
      created_at: 123,
    };
    getPiCoreMessagesMock
      .mockResolvedValueOnce([bugPeriodMessage])
      .mockResolvedValueOnce([
        hydratedLegacyMessage,
        bugPeriodMessage,
      ]);
    hydratePiCoreFromParsedMessagesMock.mockResolvedValue({
      hydrated: true,
      count: 1,
      existingCount: 1,
    });
    getEnvMock.mockReturnValue({
      LEGACY_WORKSPACE_HOST: {
        fetch: vi.fn(async () =>
          Response.json({
            messages: [
              {
                id: "legacy-message",
                thread_id: "thread-1",
                role: "user",
                content: "original message",
                created_at: 123,
              },
            ],
          }),
        ),
      },
    });

    const messages = await readThreadMessages({} as never, {
      orgId: "org-1",
      workspaceId: "workspace-1",
      threadId: "thread-1",
    });

    expect(messages).toHaveLength(2);
    expect(messages[0]?.id).toBe("legacy-message");
    expect(messages[0]?.content).toBe("original message");
    expect(messages[1]?.id).toBe("pi-message");
    expect(messages[1]?.content).toBe("new message from broken window");
    expect(hydratePiCoreFromParsedMessagesMock).toHaveBeenCalledTimes(1);
  });

  it("returns current Pi core messages when legacy hydration is deferred", async () => {
    const currentPiMessage = {
      id: "pi-message",
      thread_id: "thread-1",
      role: "user",
      content: "message from active turn",
      created_at: 456,
    };
    getPiCoreMessagesMock.mockResolvedValue([currentPiMessage]);
    hydratePiCoreFromParsedMessagesMock.mockResolvedValue({
      hydrated: false,
      count: 0,
      existingCount: 0,
      deferred: true,
    });
    getEnvMock.mockReturnValue({
      LEGACY_WORKSPACE_HOST: {
        fetch: vi.fn(async () =>
          Response.json({
            messages: [
              {
                id: "legacy-message",
                thread_id: "thread-1",
                role: "user",
                content: "original message",
                created_at: 123,
              },
            ],
          }),
        ),
      },
    });

    const messages = await readThreadMessages({} as never, {
      orgId: "org-1",
      workspaceId: "workspace-1",
      threadId: "thread-1",
    });

    expect(messages).toEqual([currentPiMessage]);
    expect(hydratePiCoreFromParsedMessagesMock).toHaveBeenCalledTimes(1);
  });

  it("throws when legacy messages cannot be hydrated into Pi core history", async () => {
    hydratePiCoreFromParsedMessagesMock.mockRejectedValue(new Error("hydrate failed"));
    getEnvMock.mockReturnValue({
      LEGACY_WORKSPACE_HOST: {
        fetch: vi.fn(async () =>
          Response.json({
            messages: [
              {
                id: "legacy-message",
                thread_id: "thread-1",
                role: "user",
                content: "original message",
                created_at: 123,
              },
            ],
          }),
        ),
      },
    });

    await expect(
      readThreadMessages({} as never, {
        orgId: "org-1",
        workspaceId: "workspace-1",
        threadId: "thread-1",
      }),
    ).rejects.toThrow("hydrate failed");
  });
});
