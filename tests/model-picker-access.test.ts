import { describe, expect, it } from "vitest";
import { CAMEL_CODE_LLM_MODEL } from "@/lib/llm-provider-config";
import { MODEL_CATALOG } from "@/lib/model-catalog";
import {
  deriveHostedCreditPause,
  type ModelPickerOption,
} from "@/lib/model-picker-access";

const BASE_OPTIONS: ModelPickerOption[] = [
  MODEL_CATALOG[CAMEL_CODE_LLM_MODEL],
  MODEL_CATALOG.sonnet,
  MODEL_CATALOG["gpt-5.6-sol"],
  MODEL_CATALOG["grok-4.5"],
];

describe("deriveHostedCreditPause", () => {
  it("locks hosted premium rows as soon as a refreshed balance is exhausted", () => {
    const result = deriveHostedCreditPause({
      modelOptions: BASE_OPTIONS,
      billingAccessMode: "subscription",
      llmProvider: null,
      allowOpenAiSubscription: false,
      billing: {
        billingStatus: "active",
        availableCreditsCents: 0,
      },
    });

    expect(result.hostedCreditsPaused).toEqual({
      reason: "included_credits_exhausted",
    });
    expect(
      result.modelOptions.find(
        (option) => option.id === CAMEL_CODE_LLM_MODEL,
      )?.locked,
    ).not.toBe(true);
    expect(
      result.modelOptions.find((option) => option.id === "sonnet"),
    ).toMatchObject({
      locked: true,
      pausedReason: "included_credits_exhausted",
    });
  });

  it("keeps models covered by mixed BYOK and OpenAI credentials usable", () => {
    const result = deriveHostedCreditPause({
      modelOptions: BASE_OPTIONS,
      billingAccessMode: "subscription",
      llmProvider: "anthropic",
      allowOpenAiSubscription: true,
      billing: {
        billingStatus: "active",
        availableCreditsCents: 0,
      },
    });

    expect(
      result.modelOptions.find((option) => option.id === "sonnet")?.locked,
    ).not.toBe(true);
    expect(
      result.modelOptions.find((option) => option.id === "gpt-5.6-sol")
        ?.locked,
    ).not.toBe(true);
    expect(
      result.modelOptions.find((option) => option.id === "grok-4.5"),
    ).toMatchObject({
      locked: true,
      pausedReason: "included_credits_exhausted",
    });
  });

  it("injects camelCode when a pause locks every custom picker model", () => {
    const result = deriveHostedCreditPause({
      modelOptions: [
        MODEL_CATALOG.sonnet,
        MODEL_CATALOG["gpt-5.6-sol"],
      ],
      billingAccessMode: "subscription",
      llmProvider: null,
      allowOpenAiSubscription: false,
      billing: {
        billingStatus: "active",
        availableCreditsCents: 0,
      },
    });

    expect(result.modelOptions.map((entry) => entry.id)).toEqual([
      CAMEL_CODE_LLM_MODEL,
      "sonnet",
      "gpt-5.6-sol",
    ]);
    expect(
      result.modelOptions
        .filter((entry) => !entry.locked)
        .map((entry) => entry.id),
    ).toEqual([CAMEL_CODE_LLM_MODEL]);
  });

  it("does not report a pause for a camelCode-only custom picker", () => {
    const result = deriveHostedCreditPause({
      modelOptions: [MODEL_CATALOG[CAMEL_CODE_LLM_MODEL]],
      billingAccessMode: "subscription",
      llmProvider: null,
      allowOpenAiSubscription: false,
      billing: {
        billingStatus: "active",
        availableCreditsCents: 0,
      },
    });

    expect(result.hostedCreditsPaused).toBeNull();
    expect(result.modelOptions).toEqual([
      MODEL_CATALOG[CAMEL_CODE_LLM_MODEL],
    ]);
  });

  it("does not report a pause when every model is credential-covered", () => {
    const result = deriveHostedCreditPause({
      modelOptions: [
        MODEL_CATALOG.sonnet,
        MODEL_CATALOG["gpt-5.6-sol"],
      ],
      billingAccessMode: "subscription",
      llmProvider: "anthropic",
      allowOpenAiSubscription: true,
      billing: {
        billingStatus: "active",
        availableCreditsCents: 0,
      },
    });

    expect(result.hostedCreditsPaused).toBeNull();
    expect(result.modelOptions.every((entry) => !entry.locked)).toBe(true);
    expect(
      result.modelOptions.every((entry) => !entry.pausedReason),
    ).toBe(true);
  });

  it("clears loader-time pause locks after a live balance recovery", () => {
    const paused = BASE_OPTIONS.map((entry) =>
      entry.id === "sonnet"
        ? {
            ...entry,
            locked: true,
            pausedReason: "included_credits_exhausted" as const,
          }
        : entry,
    );
    const result = deriveHostedCreditPause({
      modelOptions: paused,
      billingAccessMode: "subscription",
      llmProvider: null,
      allowOpenAiSubscription: false,
      billing: {
        billingStatus: "active",
        availableCreditsCents: 100,
      },
    });

    expect(result.hostedCreditsPaused).toBeNull();
    expect(
      result.modelOptions.find((option) => option.id === "sonnet"),
    ).not.toMatchObject({
      locked: true,
    });
  });
});
