import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatThreadDO } from "../src/chat-thread-do";

function createFakeThread(options: { emojiFails?: boolean } = {}) {
  const waitUntilPromises: Promise<unknown>[] = [];
  const order: string[] = [];
  let resolveClaim:
    | ((claim: {
        id: string;
        name: string;
        avatar: { color: string; content: string; status: "fallback" };
      }) => void)
    | null = null;
  const claimPromise = new Promise<{
    id: string;
    name: string;
    avatar: { color: string; content: string; status: "fallback" };
  }>((resolve) => {
    resolveClaim = resolve;
  });
  const aiRun = vi.fn(async (_model: string, input: { max_tokens?: number }) => {
    if (input.max_tokens === 50) {
      order.push("title-ai");
      return { choices: [{ message: { content: "database migrations" } }] };
    }
    order.push("emoji-ai");
    if (options.emojiFails) {
      throw new Error("emoji unavailable");
    }
    return { choices: [{ message: { content: "🗄️" } }] };
  });
  const orgStub = {
    updateThread: vi.fn(async () => {
      order.push("update-thread");
      return { updated_at: 123 };
    }),
  };
  const userStub = {
    renameEmptySingleThreadGroupForThread: vi.fn(async () => {
      order.push("rename-group");
    }),
    claimChatGroupEmojiGenerationForThread: vi.fn(() => {
      order.push("claim-emoji");
      return claimPromise;
    }),
    setGeneratedChatGroupEmoji: vi.fn(async () => {
      order.push("set-generated");
      return { color: "#4F46E5", content: "🗄️", status: "generated" };
    }),
    setChatGroupAvatarFallback: vi.fn(async () => {
      order.push("set-fallback");
      return { color: "#4F46E5", content: "💬", status: "fallback" };
    }),
  };
  const fake = Object.create(ChatThreadDO.prototype) as any;
  fake.chatContext = {
    orgId: "org1",
    workspaceId: "workspace1",
    threadId: "thread1",
    userId: "user1",
  };
  fake.titleGenerationInFlight = true;
  fake.setTitle = vi.fn(async () => {
    order.push("set-title");
  });
  fake.broadcastChat = vi.fn((message: unknown) => {
    order.push("broadcast");
    return message;
  });
  fake.ctx = {
    waitUntil: vi.fn((promise: Promise<unknown>) => {
      order.push("wait-until");
      waitUntilPromises.push(promise);
    }),
  };
  fake.env = {
    CF_GATEWAY_NAME: "gw_1",
    AI: { run: aiRun },
    ORG: {
      idFromName: vi.fn((id: string) => id),
      get: vi.fn(() => orgStub),
    },
    USER: {
      idFromName: vi.fn((id: string) => id),
      get: vi.fn(() => userStub),
    },
  };

  return {
    fake,
    order,
    aiRun,
    orgStub,
    userStub,
    waitUntilPromises,
    resolveClaim: resolveClaim!,
  };
}

describe("ChatThreadDO title generation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renames the group before scheduling generated emoji work", async () => {
    const {
      fake,
      order,
      aiRun,
      orgStub,
      userStub,
      waitUntilPromises,
      resolveClaim,
    } = createFakeThread();

    await ChatThreadDO.prototype["generateThreadTitleFromMessage"].call(
      fake,
      "thread1",
      "help me plan database migrations",
    );

    expect(orgStub.updateThread).toHaveBeenCalledWith(
      "thread1",
      "Database Migrations",
    );
    expect(fake.setTitle).toHaveBeenCalledWith("Database Migrations", 123);
    expect(userStub.renameEmptySingleThreadGroupForThread).toHaveBeenCalledWith(
      "thread1",
      "Database Migrations",
    );
    expect(fake.titleGenerationInFlight).toBe(false);
    expect(waitUntilPromises).toHaveLength(1);
    expect(aiRun).toHaveBeenCalledTimes(1);
    expect(order.indexOf("rename-group")).toBeLessThan(
      order.indexOf("wait-until"),
    );

    resolveClaim({
      id: "group1",
      name: "Database Migrations",
      avatar: { color: "#4F46E5", content: "💬", status: "fallback" },
    });
    await Promise.all(waitUntilPromises);

    expect(aiRun).toHaveBeenCalledTimes(2);
    expect(userStub.setGeneratedChatGroupEmoji).toHaveBeenCalledWith(
      "group1",
      "🗄️",
    );
    expect(fake.broadcastChat).toHaveBeenNthCalledWith(1, {
      type: "chat_group_avatar_updated",
      threadId: "thread1",
      groupId: "group1",
      avatar: { color: "#4F46E5", content: "💬", status: "pending" },
    });
    expect(fake.broadcastChat).toHaveBeenNthCalledWith(2, {
      type: "chat_group_avatar_updated",
      threadId: "thread1",
      groupId: "group1",
      avatar: { color: "#4F46E5", content: "🗄️", status: "generated" },
    });
  });

  it("falls back after emoji generation failure without blocking title naming", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const {
      fake,
      aiRun,
      userStub,
      waitUntilPromises,
      resolveClaim,
    } = createFakeThread({ emojiFails: true });

    await ChatThreadDO.prototype["generateThreadTitleFromMessage"].call(
      fake,
      "thread1",
      "help me plan database migrations",
    );

    expect(fake.titleGenerationInFlight).toBe(false);
    expect(aiRun).toHaveBeenCalledTimes(1);

    resolveClaim({
      id: "group1",
      name: "Database Migrations",
      avatar: { color: "#4F46E5", content: "💬", status: "fallback" },
    });
    await Promise.all(waitUntilPromises);

    expect(userStub.setGeneratedChatGroupEmoji).not.toHaveBeenCalled();
    expect(userStub.setChatGroupAvatarFallback).toHaveBeenCalledWith("group1");
    expect(fake.broadcastChat).toHaveBeenLastCalledWith({
      type: "chat_group_avatar_updated",
      threadId: "thread1",
      groupId: "group1",
      avatar: { color: "#4F46E5", content: "💬", status: "fallback" },
    });
  });
});
