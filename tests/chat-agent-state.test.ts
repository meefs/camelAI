import { describe, expect, it } from "vitest";
import {
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
  it("shows a notice only while its fallback model remains selected", () => {
    const now = Date.parse("2026-07-15T12:00:00.000Z");
    expect(
      shouldShowModelFallbackNotice(notice(now - 1_000), "deepseek-v4-auto"),
    ).toBe(true);
    expect(
      shouldShowModelFallbackNotice(notice(now - 1_000), "gpt-5.6-sol"),
    ).toBe(false);
  });

  it("does not expire an old notice while Camel Free remains selected", () => {
    expect(
      shouldShowModelFallbackNotice(notice(1), "deepseek-v4-auto"),
    ).toBe(true);
  });
});
