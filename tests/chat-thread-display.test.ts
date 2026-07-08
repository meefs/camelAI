import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";

import { resolveDisplayChatData } from "@/lib/chat-thread-display";
import type { ChatThreadSnapshot } from "@/hooks/use-chat-thread-snapshots";
import type { Message } from "@/types";

function message(id: string, threadId: string): Message {
  return {
    id,
    thread_id: threadId,
    role: "user",
    content: `content-${id}`,
    created_at: 1,
  };
}

function uiMessage(id: string): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [{ type: "text", text: `ui-${id}`, state: "done" }],
  } as unknown as UIMessage;
}

// The loader payload the route builds; only the message-bearing subset matters
// here, so the extra fields ride along and must be preserved on the merge.
function loaderData() {
  return {
    messages: [message("prev-1", "thread-prev")],
    messagesError: null as string | null,
    initialUiMessages: [uiMessage("prev-ui-1")],
    todos: [],
    previewTabs: [],
    activeTabId: "prev-tab",
  };
}

function snapshotFor(threadId: string): ChatThreadSnapshot {
  return {
    messages: [message(`snap-1`, threadId)],
    uiMessages: [uiMessage(`snap-ui-${threadId}`)],
    todos: [],
    updatedAt: 123,
  };
}

describe("resolveDisplayChatData", () => {
  it("returns the loader payload untouched when no cached snapshot drives the render", () => {
    const resolved = loaderData();
    expect(resolveDisplayChatData(resolved, null, false)).toBe(resolved);
    expect(resolveDisplayChatData(resolved, snapshotFor("t"), false)).toBe(
      resolved,
    );
    expect(resolveDisplayChatData(resolved, null, true)).toBe(resolved);
  });

  it("never carries the previous loader result's initialUiMessages into a cached-snapshot render", () => {
    // Loader still holds the PREVIOUS thread's data (its second fetch has not
    // resolved), while the snapshot is for the newly-selected thread.
    const resolved = loaderData();
    const snapshot = snapshotFor("thread-next");

    const merged = resolveDisplayChatData(resolved, snapshot, true);

    // initialUiMessages must come from the snapshot, not the stale loader list —
    // otherwise the remounted Chat paints the previous thread's transcript.
    expect(merged.initialUiMessages).toBe(snapshot.uiMessages);
    expect(merged.initialUiMessages).not.toBe(resolved.initialUiMessages);
    expect(merged.messages).toBe(snapshot.messages);
    expect(merged.todos).toBe(snapshot.todos);

    // Non-message fields still come from the loader payload.
    expect(merged.activeTabId).toBe("prev-tab");
    expect(merged.previewTabs).toBe(resolved.previewTabs);
  });
});
