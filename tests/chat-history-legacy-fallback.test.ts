import { beforeEach, describe, expect, it, vi } from "vitest";

const getEnvMock = vi.fn();
const getPiCoreMessagesMock = vi.fn();
const getLegacyClaudeSessionIdMock = vi.fn();
const getCodexSessionIdMock = vi.fn();

vi.mock("@/lib/cloudflare.server", () => ({
  getEnv: getEnvMock,
}));

vi.mock("@/lib/chat-do.server", () => ({
  getPiCoreMessages: getPiCoreMessagesMock,
  getLegacyClaudeSessionId: getLegacyClaudeSessionIdMock,
  getCodexSessionId: getCodexSessionIdMock,
}));

const { readThreadMessages } = await import("@/lib/chat-history.server");

describe("readThreadMessages legacy fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPiCoreMessagesMock.mockResolvedValue([]);
    getLegacyClaudeSessionIdMock.mockResolvedValue("claude-session");
    getCodexSessionIdMock.mockResolvedValue("codex-session");
  });

  it("loads legacy sandbox-host messages when Pi core history is empty", async () => {
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
        forkEntryId: undefined,
        isCompactSummary: false,
        isMeta: false,
        sourceToolUseID: undefined,
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("prefers legacy sandbox-host messages over Pi core bug-period messages", async () => {
    getPiCoreMessagesMock.mockResolvedValue([
      {
        id: "pi-message",
        thread_id: "thread-1",
        role: "user",
        content: "new message from broken window",
        created_at: 456,
      },
    ]);
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

    expect(messages).toHaveLength(1);
    expect(messages[0]?.id).toBe("legacy-message");
    expect(messages[0]?.content).toBe("original message");
  });
});
