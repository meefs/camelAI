import { describe, expect, it } from "vitest";
import {
  MODEL_FALLBACK_NOTICE_MAX_AGE_MS,
  shouldShowModelFallbackNotice,
  type ChatAgentModelFallbackNotice,
} from "@/lib/chat-agent-state";

const notice = (createdAt: number): ChatAgentModelFallbackNotice => ({
  id: "notice-1",
  fromModel: "gpt-5.6-sol",
  toModel: "deepseek-v4-auto",
  reason: "hosted_credits_exhausted",
  createdAt,
});

describe("model fallback notices", () => {
  it("shows a recent notice only while its fallback model remains selected", () => {
    const now = Date.parse("2026-07-15T12:00:00.000Z");
    expect(shouldShowModelFallbackNotice(notice(now - 1_000), "deepseek-v4-auto", now)).toBe(true);
    expect(shouldShowModelFallbackNotice(notice(now - 1_000), "gpt-5.6-sol", now)).toBe(false);
  });

  it("does not replay stale or future notices", () => {
    const now = Date.parse("2026-07-15T12:00:00.000Z");
    expect(shouldShowModelFallbackNotice(
      notice(now - MODEL_FALLBACK_NOTICE_MAX_AGE_MS),
      "deepseek-v4-auto",
      now,
    )).toBe(false);
    expect(shouldShowModelFallbackNotice(notice(now + 1), "deepseek-v4-auto", now)).toBe(false);
  });
});
