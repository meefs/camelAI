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
      current: "gemini-3-flash-preview" as LlmModel,
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
      "/api/billing/chat-credit-status?model=gemini-3-flash-preview&threadId=thread_123",
    );

    fetcher.data = {
      ok: true,
      billingCreditStatus: {
        availableCreditsCents: 0,
        totalCreditLimitCents: 500,
        isExhausted: true,
        hasByokProvider: false,
      },
      requestedModel: "gemini-3-flash-preview",
      threadModel: "deepseek-v4-auto",
      threadModelUpdatedAt: 1234,
    };
    rerender();

    expect(result.current.refreshedThreadModel).toEqual({
      requestedModel: "gemini-3-flash-preview",
      model: "deepseek-v4-auto",
      updatedAt: 1234,
    });
    expect(result.current.currentBillingCreditStatus?.isExhausted).toBe(true);
  });
});
