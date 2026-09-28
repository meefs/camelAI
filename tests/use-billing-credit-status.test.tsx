import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  useBillingCreditStatus,
  type BillingCreditStatusResourceData,
} from "@/hooks/use-billing-credit-status";
import type { LlmModel } from "@/types";

describe("useBillingCreditStatus", () => {
  it("requests and exposes the canonical thread model after a turn", () => {
    const fetcher = {
      data: undefined as BillingCreditStatusResourceData | undefined,
      load: vi.fn(),
    };
    const selectedThreadModelRef = {
      current: "gemini-3.8-flash" as LlmModel,
    };
    const locationSearchRef = { current: "" };

    const { result, rerender } = renderHook(() =>
      useBillingCreditStatus({
        billingStatusFetcher: fetcher as never,
        initialStatus: null,
        threadId: "thread_123",
        selectedThreadModelRef,
        locationSearchRef,
      }),
    );

    act(() => {
      result.current.refreshBillingCreditStatusAfterTurn("thread_123:turn:1");
    });
    expect(fetcher.load).toHaveBeenCalledWith(
      "/api/billing/chat-credit-status?model=gemini-3.8-flash&threadId=thread_123",
    );

    fetcher.data = {
      ok: true,
      billingCreditStatus: {
        availableCreditsCents: 0,
        totalCreditLimitCents: 500,
        isExhausted: true,
        hasByokProvider: false,
      },
      requestedModel: "gemini-3.8-flash",
      threadModel: "deepseek-v4-auto",
      threadModelUpdatedAt: 1234,
    };
    rerender();

    expect(result.current.refreshedThreadModel).toEqual({
      requestedModel: "gemini-3.8-flash",
      model: "deepseek-v4-auto",
      updatedAt: 1234,
    });
    expect(result.current.currentBillingCreditStatus?.isExhausted).toBe(true);
  });

  it("preserves exhausted org status across a subsequent BYOK-covered turn", () => {
    const fetcher = {
      data: undefined as BillingCreditStatusResourceData | undefined,
      load: vi.fn(),
    };
    const selectedThreadModelRef = {
      current: "gpt-6-sol" as LlmModel,
    };
    const locationSearchRef = { current: "" };
    const { result, rerender } = renderHook(() =>
      useBillingCreditStatus({
        billingStatusFetcher: fetcher as never,
        initialStatus: null,
        threadId: "thread_123",
        selectedThreadModelRef,
        locationSearchRef,
      }),
    );

    fetcher.data = {
      ok: true,
      billingCreditStatus: {
        availableCreditsCents: 0,
        totalCreditLimitCents: 500,
        isExhausted: true,
        hasByokProvider: true,
        billingStatus: "active",
      },
      requestedModel: "gpt-6-sol",
      threadModel: "deepseek-v4-auto",
      threadModelUpdatedAt: 1234,
    };
    rerender();
    expect(result.current.currentBillingCreditStatus?.isExhausted).toBe(true);

    selectedThreadModelRef.current = "sonnet";
    fetcher.data = {
      ok: true,
      billingCreditStatus: {
        availableCreditsCents: 0,
        totalCreditLimitCents: 500,
        isExhausted: true,
        hasByokProvider: true,
        billingStatus: "active",
      },
      requestedModel: "sonnet",
      threadModel: "sonnet",
      threadModelUpdatedAt: 2345,
    };
    rerender();

    expect(result.current.currentBillingCreditStatus).toMatchObject({
      availableCreditsCents: 0,
      isExhausted: true,
      hasByokProvider: true,
    });
  });
});
