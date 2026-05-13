import { describe, expect, it } from "vitest";
import { calculateEffectiveUsageCostUsd } from "./usage-pricing";

describe("calculateEffectiveUsageCostUsd", () => {
  it("adds reported and upstream inference costs", () => {
    expect(
      calculateEffectiveUsageCostUsd({
        model: "anthropic/claude-4.6-sonnet-20260217",
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        reportedCostUsd: 0.0012,
        upstreamInferenceCostUsd: 0.0048,
      }),
    ).toBeCloseTo(0.006);
  });

  it("falls back to table pricing when reported cost is zero", () => {
    expect(
      calculateEffectiveUsageCostUsd({
        model: "anthropic/claude-4.6-sonnet-20260217",
        inputTokens: 0,
        outputTokens: 1000,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        reportedCostUsd: 0,
      }),
    ).toBeCloseTo(0.015);
  });
});
