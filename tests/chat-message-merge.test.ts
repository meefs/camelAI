import { describe, expect, it } from "vitest";

import { mergeServerAndLocalMessages } from "@/lib/chat-message-merge";
import type { Message } from "@/types";

function message(args: {
  id: string;
  role: Message["role"];
  createdAt: number;
  content: Message["content"];
  clientMessageId?: string;
}): Message {
  return {
    id: args.id,
    thread_id: "thread-1",
    role: args.role,
    content: args.content,
    created_at: args.createdAt,
    clientMessageId: args.clientMessageId,
  };
}

describe("mergeServerAndLocalMessages", () => {
  it("returns server history as-is when there are no pending messages", () => {
    const serverMessages = [
      message({ id: "server-user", role: "user", createdAt: 1000, content: "hello" }),
      message({ id: "server-assistant", role: "assistant", createdAt: 2000, content: "hi" }),
    ];
    const staleLocalMessages = [
      message({ id: "local-assistant", role: "assistant", createdAt: 1500, content: "stale" }),
    ];

    const merged = mergeServerAndLocalMessages(serverMessages, staleLocalMessages);

    expect(merged).toBe(serverMessages);
  });

  it("appends explicit pending user messages after server history", () => {
    const serverMessages = [
      message({ id: "server-user", role: "user", createdAt: 1000, content: "first" }),
      message({ id: "server-assistant", role: "assistant", createdAt: 2000, content: "done" }),
    ];
    const pendingMessages = [
      message({
        id: "client-1",
        clientMessageId: "client-1",
        role: "user",
        createdAt: 1500,
        content: "second",
      }),
    ];

    const merged = mergeServerAndLocalMessages(serverMessages, pendingMessages);

    expect(merged.map((entry) => entry.id)).toEqual([
      "server-user",
      "server-assistant",
      "client-1",
    ]);
  });

  it("does not append pending messages already represented by server ids", () => {
    const serverMessages = [
      message({
        id: "server-user",
        role: "user",
        createdAt: 1000,
        content: "hello",
        clientMessageId: "client-1",
      }),
    ];
    const pendingMessages = [
      message({
        id: "client-1",
        clientMessageId: "client-1",
        role: "user",
        createdAt: 900,
        content: "hello",
      }),
    ];

    const merged = mergeServerAndLocalMessages(serverMessages, pendingMessages);

    expect(merged).toEqual(serverMessages);
  });

  it("never overlays pending assistant messages", () => {
    const serverMessages = [
      message({ id: "server-user", role: "user", createdAt: 1000, content: "hello" }),
    ];
    const pendingMessages = [
      message({
        id: "local-assistant",
        role: "assistant",
        createdAt: 1500,
        content: "working",
      }),
    ];

    const merged = mergeServerAndLocalMessages(serverMessages, pendingMessages);

    expect(merged).toEqual(serverMessages);
  });
});
