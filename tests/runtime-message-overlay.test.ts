import { describe, expect, it } from "vitest";

import { mergeOverlay } from "@/lib/runtime-message-state";
import type { Message } from "@/types";

function assistant(id: string, text: string, isStreaming = false): Message {
  return {
    id,
    thread_id: "thread-1",
    role: "assistant",
    content: [{ type: "text", text }],
    created_at: 1,
    isStreaming,
  } as Message;
}

function user(id: string, text: string, sentDuringStreaming = false): Message {
  return {
    id,
    clientMessageId: id,
    thread_id: "thread-1",
    role: "user",
    content: text,
    created_at: 2,
    sentDuringStreaming,
  } as Message;
}

describe("mergeOverlay", () => {
  it("returns the base untouched for an empty overlay", () => {
    const base = [assistant("a", "hi")];
    expect(mergeOverlay(base, [])).toBe(base);
  });

  it("appends overlay messages not present in the base", () => {
    const base = [assistant("committed", "done")];
    const merged = mergeOverlay(base, [assistant("stream_1", "typ", true)]);
    expect(merged.map((m) => m.id)).toEqual(["committed", "stream_1"]);
  });

  it("replaces a base message in place when ids match (no duplicate)", () => {
    const base = [assistant("committed", "done"), assistant("stream_1", "typ", true)];
    const merged = mergeOverlay(base, [assistant("stream_1", "typing more", true)]);
    expect(merged.map((m) => m.id)).toEqual(["committed", "stream_1"]);
    expect(merged[1].content).toEqual([{ type: "text", text: "typing more" }]);
  });

  it("does not duplicate when a wholesale overlay re-ids the streaming message at completion", () => {
    // Mirrors the client flow: `messages` (committed) holds only finalized
    // history; the streaming entry lives solely in the wholesale overlay. When
    // turn/completed re-ids stream_1 -> fork_1, the overlay is replaced whole,
    // so the temp id is gone and the finalized message folds in exactly once.
    const committed = [assistant("turn-0", "earlier answer")];

    // Mid-stream: overlay holds the temp-id streaming message.
    const streaming = mergeOverlay(committed, [assistant("stream_1", "partial", true)]);
    expect(streaming.map((m) => m.id)).toEqual(["turn-0", "stream_1"]);

    // Completion: client folds the finalized (re-id'd) message into committed
    // and the overlay is the same finalized snapshot.
    const finalized = assistant("fork_1", "final answer");
    const newCommitted = mergeOverlay(committed, [finalized]);
    const display = mergeOverlay(newCommitted, [finalized]);

    const forkEntries = display.filter((m) => m.id === "fork_1");
    expect(forkEntries).toHaveLength(1);
    expect(display.some((m) => m.id === "stream_1")).toBe(false);
    expect(display.map((m) => m.id)).toEqual(["turn-0", "fork_1"]);
  });

  it("reconciles an optimistic message with its server copy by clientMessageId", () => {
    const optimistic = {
      id: "client_123",
      clientMessageId: "client_123",
      thread_id: "thread-1",
      role: "user",
      content: "steer this",
      created_at: 1,
    } as Message;
    const serverCopy = {
      id: "pi_user_456",
      clientMessageId: "client_123",
      thread_id: "thread-1",
      role: "user",
      content: "steer this",
      created_at: 1,
    } as Message;

    const merged = mergeOverlay([optimistic], [serverCopy]);
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe("pi_user_456");
  });

  it("renders the streaming assistant above an optimistic steering echo", () => {
    // The browser appends the steering message to committed history; the
    // streaming assistant lives only in the overlay. It must render below the
    // assistant it is steering, not above it.
    const base = [user("turn-starter", "do the thing"), user("steer", "actually also this", true)];
    const merged = mergeOverlay(base, [assistant("stream_1", "working...", true)]);
    expect(merged.map((m) => m.id)).toEqual(["turn-starter", "stream_1", "steer"]);
  });

  it("keeps the steering echo below the assistant when the turn folds at completion", () => {
    const base = [user("turn-starter", "do the thing"), user("steer", "actually also this", true)];
    const folded = mergeOverlay(base, [assistant("fork_1", "done")]);
    expect(folded.map((m) => m.id)).toEqual(["turn-starter", "fork_1", "steer"]);
  });

  it("orders multiple steering echoes after the assistant, preserving their order", () => {
    const base = [
      user("turn-starter", "go"),
      user("steer-1", "one", true),
      user("steer-2", "two", true),
    ];
    const merged = mergeOverlay(base, [assistant("stream_1", "...", true)]);
    expect(merged.map((m) => m.id)).toEqual([
      "turn-starter",
      "stream_1",
      "steer-1",
      "steer-2",
    ]);
  });

  it("appends a fresh turn's assistant after a non-steering turn-starter", () => {
    // A turn-starter (not sent during streaming) must keep the assistant below
    // it, even when an earlier completed turn ended with a steered message.
    const base = [
      assistant("prev-turn", "earlier"),
      user("prev-steer", "earlier steer", true),
      user("turn-starter", "next prompt"),
    ];
    const merged = mergeOverlay(base, [assistant("stream_2", "...", true)]);
    expect(merged.map((m) => m.id)).toEqual([
      "prev-turn",
      "prev-steer",
      "turn-starter",
      "stream_2",
    ]);
  });
});
