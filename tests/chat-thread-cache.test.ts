import { describe, expect, it } from "vitest";
import { upsertThreadSnapshot } from "@/hooks/use-chat-thread-cache";

describe("upsertThreadSnapshot", () => {
  it("keeps a bounded least-recently-used cache", () => {
    let cache = new Map();
    cache = upsertThreadSnapshot(cache, {
      workspaceId: "ws_1",
      threadId: "thread_1",
      threadTitle: "One",
      threadModel: "haiku",
      threadProvider: "claude",
    }, 2);
    cache = upsertThreadSnapshot(cache, {
      workspaceId: "ws_1",
      threadId: "thread_2",
      threadTitle: "Two",
      threadModel: "haiku",
      threadProvider: "claude",
    }, 2);
    cache = upsertThreadSnapshot(cache, {
      workspaceId: "ws_1",
      threadId: "thread_1",
      messages: [],
    }, 2);
    cache = upsertThreadSnapshot(cache, {
      workspaceId: "ws_1",
      threadId: "thread_3",
      threadTitle: "Three",
      threadModel: "haiku",
      threadProvider: "claude",
    }, 2);

    expect(cache.has("ws_1:thread_1")).toBe(true);
    expect(cache.has("ws_1:thread_2")).toBe(false);
    expect(cache.has("ws_1:thread_3")).toBe(true);
  });
});
