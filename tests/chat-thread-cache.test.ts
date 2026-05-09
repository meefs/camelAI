import { describe, expect, it } from "vitest";
import {
  hasRenderableThreadSnapshot,
  hasServerThreadHistory,
  shouldFetchThreadHistory,
  upsertThreadSnapshot,
} from "@/hooks/use-chat-thread-cache";
import type { ContentBlock } from "@/types";

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
    expect(hasRenderableThreadSnapshot(snapshot)).toBe(true);
    expect(shouldFetchThreadHistory(snapshot)).toBe(false);
  });

  it("allows streaming snapshots with messages to render while still fetching server history later", () => {
    const [snapshot] = Array.from(
      upsertThreadSnapshot(new Map(), {
        workspaceId: "ws_1",
        threadId: "thread_1",
        threadTitle: "One",
        threadModel: "haiku",
        threadProvider: "claude",
        historyState: "streaming",
        messages: [
          {
            id: "stream_1",
            thread_id: "thread_1",
            role: "assistant",
            content: [{ type: "tool_use", id: "tool_1", name: "Edit", input: {} }],
            created_at: 1,
            isStreaming: true,
          },
          {
            id: "meta_1",
            thread_id: "thread_1",
            role: "user",
            content: [{ type: "text", text: "editing file" }],
            created_at: 2,
            isMeta: true,
            sourceToolUseID: "tool_1",
          },
        ],
      }).values(),
    );

    expect(hasRenderableThreadSnapshot(snapshot)).toBe(true);
    expect(hasServerThreadHistory(snapshot)).toBe(false);
    expect(shouldFetchThreadHistory(snapshot)).toBe(true);
  });

  it("does not let an empty server preview overwrite warm server message history", () => {
    let cache = new Map();
    cache = upsertThreadSnapshot(cache, {
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
    });

    cache = upsertThreadSnapshot(cache, {
      workspaceId: "ws_1",
      threadId: "thread_1",
      historyState: "server",
      messages: [],
      previewTabs: [{ kind: "app", scriptName: "preview", isPublic: false }],
      activeTabId: "app:preview",
      previewTarget: { kind: "app", scriptName: "preview", isPublic: false },
    });

    const snapshot = cache.get("ws_1:thread_1");
    expect(snapshot?.messages).toHaveLength(1);
    expect(snapshot?.messages[0]?.id).toBe("server_1");
    expect(snapshot?.previewTabs).toEqual([
      { kind: "app", scriptName: "preview", isPublic: false },
    ]);
    expect(hasServerThreadHistory(snapshot)).toBe(true);
  });

  it("does not let an empty server mount overwrite a warm streaming snapshot", () => {
    let cache = new Map();
    cache = upsertThreadSnapshot(cache, {
      workspaceId: "ws_1",
      threadId: "thread_1",
      threadTitle: "One",
      threadModel: "haiku",
      threadProvider: "claude",
      historyState: "streaming",
      messages: [
        {
          id: "stream_1",
          thread_id: "thread_1",
          role: "assistant",
          content: "working",
          created_at: 1,
          isStreaming: true,
        },
      ],
    });

    cache = upsertThreadSnapshot(cache, {
      workspaceId: "ws_1",
      threadId: "thread_1",
      historyState: "server",
      messages: [],
      previewTabs: [{ kind: "app", scriptName: "preview", isPublic: false }],
      activeTabId: "app:preview",
      previewTarget: { kind: "app", scriptName: "preview", isPublic: false },
    });

    const snapshot = cache.get("ws_1:thread_1");
    expect(snapshot?.messages).toHaveLength(1);
    expect(snapshot?.messages[0]?.id).toBe("stream_1");
    expect(snapshot?.historyState).toBe("streaming");
    expect(hasRenderableThreadSnapshot(snapshot)).toBe(true);
  });

  it("merges stale non-empty server history into a warm Kimi streaming snapshot", () => {
    let cache = new Map();
    cache = upsertThreadSnapshot(cache, {
      workspaceId: "ws_1",
      threadId: "thread_1",
      threadTitle: "One",
      threadModel: "kimi-k2.6",
      threadProvider: "codex",
      historyState: "streaming",
      messages: [
        {
          id: "server-user",
          thread_id: "thread_1",
          role: "user",
          content: [{ type: "text", text: "Inspect the app" }],
          created_at: 1,
        },
        {
          id: "pi-entry-leaf",
          thread_id: "thread_1",
          role: "assistant",
          isStreaming: true,
          content: [
            { type: "tool_use", id: "tool_1", name: "Bash", input: { command: "ls" } },
          ],
          created_at: 2,
        },
      ],
    });

    cache = upsertThreadSnapshot(cache, {
      workspaceId: "ws_1",
      threadId: "thread_1",
      historyState: "server",
      messages: [
        {
          id: "server-user",
          thread_id: "thread_1",
          role: "user",
          content: [{ type: "text", text: "Inspect the app" }],
          created_at: 1,
        },
        {
          id: "pi-entry-root",
          thread_id: "thread_1",
          role: "assistant",
          forkEntryId: "pi-entry-leaf",
          content: [{ type: "text", text: "I'll inspect it." }],
          created_at: 2,
        },
      ],
    });

    const snapshot = cache.get("ws_1:thread_1");

    expect(snapshot).toBeDefined();
    if (!snapshot) return;
    expect(snapshot?.historyState).toBe("streaming");
    expect(
      snapshot.messages.map((message: { id: string }) => message.id),
    ).toEqual([
      "server-user",
      "pi-entry-root",
    ]);
    expect(snapshot.messages[1]?.forkEntryId).toBe("pi-entry-leaf");
    expect((snapshot.messages[1]?.content as ContentBlock[])[0]).toMatchObject({
      type: "tool_use",
      id: "tool_1",
    });
  });
});
