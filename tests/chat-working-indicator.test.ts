import { describe, expect, it } from "vitest";
import {
  deriveIsAwaitingAssistant,
  deriveTurnSettled,
  isAssistantLikeMessage,
} from "@/lib/chat-working-indicator";
import type { Message } from "@/types";

const userMessage = (over: Partial<Message> = {}): Message =>
  ({
    id: "u1",
    thread_id: "t1",
    role: "user",
    content: "hello",
    created_at: 1,
    ...over,
  }) as Message;

const assistantMessage = (over: Partial<Message> = {}): Message =>
  ({
    id: "a1",
    thread_id: "t1",
    role: "assistant",
    content: "hi",
    created_at: 2,
    ...over,
  }) as Message;

describe("deriveIsAwaitingAssistant", () => {
  it("shows for a freshly-started new chat (pendingFirstTurn, trailing user message)", () => {
    expect(
      deriveIsAwaitingAssistant({
        loading: false,
        isStreaming: false,
        pendingFirstTurn: true,
        lastMessage: userMessage(),
      }),
    ).toBe(true);
  });

  it("shows while the agent is streaming", () => {
    expect(
      deriveIsAwaitingAssistant({
        loading: false,
        isStreaming: true,
        pendingFirstTurn: false,
        lastMessage: userMessage(),
      }),
    ).toBe(true);
  });

  it("shows while a send is queued / in-flight (loading)", () => {
    expect(
      deriveIsAwaitingAssistant({
        loading: true,
        isStreaming: false,
        pendingFirstTurn: false,
        lastMessage: userMessage(),
      }),
    ).toBe(true);
  });

  it("does NOT spin for a thread that merely ends on a user message with no pending turn (e.g. a fork)", () => {
    expect(
      deriveIsAwaitingAssistant({
        loading: false,
        isStreaming: false,
        pendingFirstTurn: false,
        lastMessage: userMessage(),
      }),
    ).toBe(false);
  });

  it("turns off once the assistant reply is the last message", () => {
    expect(
      deriveIsAwaitingAssistant({
        loading: false,
        isStreaming: true,
        pendingFirstTurn: true,
        lastMessage: assistantMessage(),
      }),
    ).toBe(false);
  });

  it("treats a compaction summary as an assistant-like reply (no spinner)", () => {
    expect(
      deriveIsAwaitingAssistant({
        loading: false,
        isStreaming: false,
        pendingFirstTurn: true,
        lastMessage: userMessage({ isCompactSummary: true }),
      }),
    ).toBe(false);
  });

  it("does NOT spin for an empty thread (no messages yet)", () => {
    expect(
      deriveIsAwaitingAssistant({
        loading: false,
        isStreaming: true,
        pendingFirstTurn: true,
        lastMessage: null,
      }),
    ).toBe(false);
  });

  it("stops spinning when the background first turn fails (terminal error clears pendingFirstTurn)", () => {
    // pendingFirstTurn is a loader prop that never flips false on its own; a
    // failed first turn clears loading/isStreaming but leaves the synthesized
    // user message last. Without the terminal-error gate this would spin forever
    // and keep the composer in steer mode.
    expect(
      deriveIsAwaitingAssistant({
        loading: false,
        isStreaming: false,
        pendingFirstTurn: true,
        lastMessage: userMessage(),
        hasTerminalError: true,
      }),
    ).toBe(false);
  });

  it("keeps spinning on a terminal error while the agent is still actively streaming", () => {
    // hasTerminalError only cancels the pendingFirstTurn signal — an in-flight
    // stream (or queued send) still drives the indicator on its own.
    expect(
      deriveIsAwaitingAssistant({
        loading: false,
        isStreaming: true,
        pendingFirstTurn: true,
        lastMessage: userMessage(),
        hasTerminalError: true,
      }),
    ).toBe(true);
  });
});

describe("isAssistantLikeMessage", () => {
  it("is true for an assistant message", () => {
    expect(isAssistantLikeMessage(assistantMessage())).toBe(true);
  });
  it("is true for a compaction summary", () => {
    expect(isAssistantLikeMessage(userMessage({ isCompactSummary: true }))).toBe(
      true,
    );
  });
  it("is false for a plain user message", () => {
    expect(isAssistantLikeMessage(userMessage())).toBe(false);
  });
  it("is false for null/undefined", () => {
    expect(isAssistantLikeMessage(null)).toBe(false);
    expect(isAssistantLikeMessage(undefined)).toBe(false);
  });
});

describe("deriveTurnSettled", () => {
  it("is true for a completed assistant reply", () => {
    expect(deriveTurnSettled(assistantMessage({ completedAtMs: 100 }))).toBe(
      true,
    );
  });

  it("is false for an assistant message without completion metadata", () => {
    expect(deriveTurnSettled(assistantMessage({ isStreaming: true }))).toBe(
      false,
    );
  });

  it("is false when a newer user message is the transcript tail", () => {
    expect(deriveTurnSettled(userMessage({ completedAtMs: 100 }))).toBe(false);
  });

  it("treats a completed compact summary as settled", () => {
    expect(
      deriveTurnSettled(
        userMessage({ isCompactSummary: true, completedAtMs: 100 }),
      ),
    ).toBe(true);
  });
});
