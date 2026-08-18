import { describe, expect, it } from "vitest";
import {
  deriveIsAwaitingAssistant,
  deriveShowGlobalAssistantIndicator,
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

const awaiting = (over: Partial<Parameters<typeof deriveIsAwaitingAssistant>[0]> = {}) =>
  deriveIsAwaitingAssistant({
    loading: false,
    isStreaming: false,
    isRunning: false,
    lastMessage: userMessage(),
    ...over,
  });

describe("deriveIsAwaitingAssistant", () => {
  it("shows while durable workspace state says the turn is running", () => {
    expect(awaiting({ isRunning: true })).toBe(true);
  });

  it("shows while the live stream is active", () => {
    expect(awaiting({ isStreaming: true })).toBe(true);
  });

  it("shows while a send is queued or in flight", () => {
    expect(awaiting({ loading: true })).toBe(true);
  });

  it("does not infer running from a trailing user message alone", () => {
    expect(awaiting()).toBe(false);
  });

  it("turns off once an assistant reply is the transcript tail", () => {
    expect(awaiting({ isRunning: true, lastMessage: assistantMessage() })).toBe(false);
  });

  it("treats a compaction summary as assistant-like", () => {
    expect(
      awaiting({ isRunning: true, lastMessage: userMessage({ isCompactSummary: true }) }),
    ).toBe(false);
  });

  it("does not spin for an empty transcript", () => {
    expect(awaiting({ isRunning: true, lastMessage: null })).toBe(false);
  });
});

describe("deriveShowGlobalAssistantIndicator", () => {
  it("hides only the display Camel after a stall clamp while durable turn state stays authoritative", () => {
    const authoritativeAwaiting = awaiting({ isRunning: true });

    expect(authoritativeAwaiting).toBe(true);
    expect(
      deriveShowGlobalAssistantIndicator({
        assistantTurnActive: authoritativeAwaiting,
        isCompacting: false,
        isStreamStallClamped: true,
      }),
    ).toBe(false);
  });

  it("shows for an active, unclamped, non-compacting turn", () => {
    expect(
      deriveShowGlobalAssistantIndicator({
        assistantTurnActive: true,
        isCompacting: false,
        isStreamStallClamped: false,
      }),
    ).toBe(true);
  });
});

describe("isAssistantLikeMessage", () => {
  it("recognizes assistant messages and compact summaries", () => {
    expect(isAssistantLikeMessage(assistantMessage())).toBe(true);
    expect(isAssistantLikeMessage(userMessage({ isCompactSummary: true }))).toBe(true);
  });

  it("rejects plain user and absent messages", () => {
    expect(isAssistantLikeMessage(userMessage())).toBe(false);
    expect(isAssistantLikeMessage(null)).toBe(false);
    expect(isAssistantLikeMessage(undefined)).toBe(false);
  });
});

describe("deriveTurnSettled", () => {
  it("is true for a completed assistant reply", () => {
    expect(deriveTurnSettled(assistantMessage({ completedAtMs: 100 }))).toBe(true);
  });

  it("is false for an assistant message without completion metadata", () => {
    expect(deriveTurnSettled(assistantMessage({ isStreaming: true }))).toBe(false);
  });

  it("is false when a newer user message is the transcript tail", () => {
    expect(deriveTurnSettled(userMessage({ completedAtMs: 100 }))).toBe(false);
  });

  it("treats a completed compact summary as settled", () => {
    expect(
      deriveTurnSettled(userMessage({ isCompactSummary: true, completedAtMs: 100 })),
    ).toBe(true);
  });
});
