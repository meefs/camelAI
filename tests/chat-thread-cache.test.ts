import { describe, expect, it } from "vitest";
import {
  hasServerThreadHistory,
  shouldFetchThreadHistory,
  upsertThreadSnapshot,
} from "@/hooks/use-chat-thread-cache";

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

  it("does not treat local optimistic snapshots as server history", () => {
    const [snapshot] = Array.from(
      upsertThreadSnapshot(new Map(), {
        workspaceId: "ws_1",
        threadId: "thread_1",
        threadTitle: "One",
        threadModel: "haiku",
        threadProvider: "claude",
        historyState: "local",
        messages: [
          {
            id: "client_1",
            clientMessageId: "client_1",
            thread_id: "thread_1",
            role: "user",
            content: "hello",
            created_at: 1,
          },
        ],
      }).values(),
    );

    expect(hasServerThreadHistory(snapshot)).toBe(false);
    expect(shouldFetchThreadHistory(snapshot)).toBe(true);
  });

  it("treats server snapshots with messages as warm history", () => {
    const [snapshot] = Array.from(
      upsertThreadSnapshot(new Map(), {
        workspaceId: "ws_1",
        threadId: "thread_1",
        threadTitle: "One",
        threadModel: "haiku",
        threadProvider: "claude",
        historyState: "server",
        messages: [
          {
            id: "server_1",
            thread_id: "thread_1",
            role: "assistant",
            content: "done",
            created_at: 1,
          },
        ],
      }).values(),
    );

    expect(hasServerThreadHistory(snapshot)).toBe(true);
    expect(shouldFetchThreadHistory(snapshot)).toBe(false);
  });
});
