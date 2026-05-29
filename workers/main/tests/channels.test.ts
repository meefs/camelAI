import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getOrgStubMock,
  getWorkspaceStubMock,
  startInitialUserMessageMock,
} = vi.hoisted(() => ({
  getOrgStubMock: vi.fn(),
  getWorkspaceStubMock: vi.fn(),
  startInitialUserMessageMock: vi.fn(),
}));

vi.mock("../src/helpers/stubs.js", () => ({
  getOrgStub: getOrgStubMock,
  getWorkspaceStub: getWorkspaceStubMock,
}));

import {
  buildChannelReplySystemMessage,
  enqueueChannelMessage,
  getChannelDedupeKey,
  getChannelReplyToolName,
  getChannelThreadMapKey,
  getEmailReplyReferenceKey,
  getOrCreateChannelThread,
} from "../src/channels.js";

function createMockKvStore(initial?: Record<string, string>) {
  const store = new Map<string, string>(Object.entries(initial || {}));
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    _store: store,
  };
}

describe("channels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("normalizes channel thread map keys", () => {
    expect(
      getChannelThreadMapKey({
        kind: "telegram",
        workspaceId: "Workspace 1",
        orgId: "org-1",
        connectionId: "Bot #1",
        remoteConversationId: "Chat #123",
      }),
    ).toBe("channel_thread:telegram:workspace_1:bot__1:chat__123");
    expect(
      getChannelThreadMapKey({
        kind: "telegram",
        workspaceId: "Workspace 1",
        orgId: "org-1",
        connectionId: "Bot #2",
        remoteConversationId: "Chat #123",
      }),
    ).toBe("channel_thread:telegram:workspace_1:bot__2:chat__123");
  });

  it("normalizes email reply reference keys shared by ingress and outbound tools", () => {
    expect(getEmailReplyReferenceKey("workspace-1", "<Message.ID+bad@example.com>"))
      .toBe("email_reply_ref:workspace-1:message.id_bad@example.com");
  });

  it("keeps generated KV keys below Cloudflare key length limits", () => {
    const longValue = "Very Long Value ".repeat(80);
    expect(
      getChannelThreadMapKey({
        kind: "telegram",
        workspaceId: longValue,
        orgId: "org-1",
        connectionId: longValue,
        remoteConversationId: longValue,
      }).length,
    ).toBeLessThan(512);
    expect(getChannelDedupeKey("slack", longValue, longValue).length)
      .toBeLessThan(512);
    expect(getEmailReplyReferenceKey(longValue, longValue).length)
      .toBeLessThan(512);
  });

  it("builds hidden channel reply instructions for js_exec provider tools", () => {
    expect(getChannelReplyToolName("email")).toBe("send_email");
    expect(getChannelReplyToolName("slack")).toBe("send_slack_message");
    expect(getChannelReplyToolName("telegram")).toBe("send_telegram_message");
    expect(getChannelReplyToolName("discord")).toBeNull();

    const message = buildChannelReplySystemMessage("email", {
      userEmail: "user@example.com",
    });

    expect(message).toContain("<camelai system message>");
    expect(message).toContain("call the js_exec tool");
    expect(message).toContain("await tools.send_email");
    expect(message).toContain("user@example.com");
    expect(message).toContain("will not be sent to the external channel automatically");
  });

  it("tells Telegram replies to use js_exec without a chat id", () => {
    const message = buildChannelReplySystemMessage("telegram", {
      userEmail: null,
    });

    expect(message).toContain("await tools.send_telegram_message");
    expect(message).toContain("do not need to provide the channel/chat id");
    expect(message).toContain("originating conversation");
  });

  it("reuses an existing channel thread map", async () => {
    const kv = createMockKvStore({
      "channel_thread:slack:workspace-1:slack-int:t1:c1:1700.0001": "thread-1",
    });
    const orgStub = {
      getThread: vi.fn().mockResolvedValue({
        id: "thread-1",
        title: "Existing channel thread",
      }),
      createThread: vi.fn(),
    };
    getOrgStubMock.mockReturnValue(orgStub);

    const result = await getOrCreateChannelThread(
      { APP_KV: kv } as never,
      {
        kind: "slack",
        workspaceId: "workspace-1",
        orgId: "org-1",
        connectionId: "slack-int",
        remoteConversationId: "T1:C1:1700.0001",
        title: "New title",
      },
    );

    expect(result).toEqual({
      threadId: "thread-1",
      title: "Existing channel thread",
      created: false,
    });
    expect(orgStub.createThread).not.toHaveBeenCalled();
  });

  it("recreates a channel thread when an existing map points at a missing thread", async () => {
    const key = "channel_thread:slack:workspace-1:slack-int:t1:c1:1700.0001";
    const kv = createMockKvStore({ [key]: "missing-thread" });
    const orgStub = {
      getThread: vi.fn().mockResolvedValue(null),
      getLlmProviderConfig: vi.fn().mockResolvedValue(null),
      getExperimentalSettings: vi
        .fn()
        .mockResolvedValue({ claude_proxy_models: false }),
      createThread: vi.fn().mockResolvedValue({
        id: "thread-2",
        title: "Recreated channel thread",
      }),
    };
    getOrgStubMock.mockReturnValue(orgStub);
    getWorkspaceStubMock.mockReturnValue({});

    const result = await getOrCreateChannelThread(
      { APP_KV: kv } as never,
      {
        kind: "slack",
        workspaceId: "workspace-1",
        orgId: "org-1",
        connectionId: "slack-int",
        remoteConversationId: "T1:C1:1700.0001",
        title: "Recreated channel thread",
        firstUserMessage: "hello again",
      },
    );

    expect(result).toEqual({
      threadId: "thread-2",
      title: "Recreated channel thread",
      created: true,
    });
    expect(kv.delete).toHaveBeenCalledWith(key);
    expect(kv._store.get(key)).toBe("thread-2");
  });

  it("creates a channel thread with the workspace default model", async () => {
    const kv = createMockKvStore();
    const orgStub = {
      getLlmProviderConfig: vi.fn().mockResolvedValue(null),
      getExperimentalSettings: vi
        .fn()
        .mockResolvedValue({ claude_proxy_models: false }),
      createThread: vi.fn().mockResolvedValue({
        id: "thread-2",
        title: "Telegram chat",
      }),
    };
    const workspaceStub = {};
    getOrgStubMock.mockReturnValue(orgStub);
    getWorkspaceStubMock.mockReturnValue(workspaceStub);

    const result = await getOrCreateChannelThread(
      { APP_KV: kv } as never,
      {
        kind: "telegram",
        workspaceId: "workspace-1",
        orgId: "org-1",
        remoteConversationId: "bot-1:chat-9",
        connectionId: "telegram-bot-1",
        title: "Telegram chat",
        createdBy: "telegram",
        firstUserMessage: "hello from Telegram",
        firstRemoteMessageId: "message-1",
      },
    );

    expect(result).toEqual({
      threadId: "thread-2",
      title: "Telegram chat",
      created: true,
    });
    expect(orgStub.createThread).toHaveBeenCalledWith(
      "workspace-1",
      "Telegram chat",
      "telegram",
      "hello from Telegram",
      "sonnet",
      "claude",
      expect.objectContaining({
        source: "channel",
        channelKind: "telegram",
        channelConnectionId: "telegram-bot-1",
        channelConversationId: "bot-1:chat-9",
        channelMessageId: "message-1",
      }),
    );
    expect(
      kv._store.get(
        "channel_thread:telegram:workspace-1:telegram-bot-1:bot-1:chat-9",
      ),
    ).toBe("thread-2");
  });

  it("enqueues channel messages through the normal initial message path", async () => {
    startInitialUserMessageMock.mockResolvedValue({ status: "accepted" });

    const result = await enqueueChannelMessage(
      {
        CHAT_THREAD: {
          idFromName: (threadId: string) => threadId,
          get: () => ({
            startInitialUserMessage: startInitialUserMessageMock,
          }),
        },
      } as never,
      {
        channelKind: "slack",
        threadId: "thread-1",
        workspaceId: "workspace-1",
        orgId: "org-1",
        message: "hello",
      },
    );

    expect(result).toEqual({ status: "accepted" });
    expect(startInitialUserMessageMock).toHaveBeenCalledWith({
      threadId: "thread-1",
      workspaceId: "workspace-1",
      orgId: "org-1",
      messageSource: "slack",
      message: expect.stringContaining("send_slack_message"),
    });
    expect(startInitialUserMessageMock.mock.calls[0]?.[0].message).toContain(
      "\n\nhello",
    );
  });
});
