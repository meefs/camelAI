import { describe, expect, it } from "vitest";
import {
  calculateEffectiveUsageCostUsd,
  calculateUsageCostUsd,
} from "@/lib/usage-pricing";

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

describe("calculateUsageCostUsd", () => {
  it("calculates Gemini 3.5 Flash fallback pricing exactly from OpenRouter meters", () => {
    expect(
      calculateUsageCostUsd({
        model: "google/gemini-3.5-flash",
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheCreationInputTokens: 1_000_000,
        cacheReadInputTokens: 1_000_000,
      }),
    ).toBeCloseTo(10.733333333333333);
  });

  it("normalizes prefixed Gemini 3.5 Flash model strings to the same pricing", () => {
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheCreationInputTokens: 1_000_000,
      cacheReadInputTokens: 1_000_000,
    };

    expect(
      calculateUsageCostUsd({ ...usage, model: "gemini-3.5-flash" }),
    ).toBeCloseTo(10.733333333333333);
    expect(
      calculateUsageCostUsd({
        ...usage,
        model: "camel/google/gemini-3.5-flash",
      }),
    ).toBeCloseTo(10.733333333333333);
    expect(
      calculateUsageCostUsd({
        ...usage,
        model: "openrouter/google/gemini-3.5-flash",
      }),
    ).toBeCloseTo(10.733333333333333);
    expect(
      calculateUsageCostUsd({
        ...usage,
        model: "camelai-openrouter/google/gemini-3.5-flash",
      }),
    ).toBeCloseTo(10.733333333333333);
  });

  it("keeps historical Gemini 3.1 Pro Preview pricing available", () => {
    expect(
      calculateUsageCostUsd({
        model: "google/gemini-3.1-pro-preview",
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheCreationInputTokens: 1_000_000,
        cacheReadInputTokens: 1_000_000,
      }),
    ).toBeCloseTo(14.575);
  });
});
