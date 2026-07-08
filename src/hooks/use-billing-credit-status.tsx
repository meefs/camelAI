import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { FetcherWithComponents } from "react-router";

import type { BillingCreditStatus } from "@/lib/chat-credit-status";
import type { LlmModel } from "@/types";

export type BillingCreditStatusResourceData =
  | {
      ok: true;
      billingCreditStatus: BillingCreditStatus | null;
    }
  | {
      ok: false;
      error?: string;
    };

export interface UseBillingCreditStatusResult {
  currentBillingCreditStatus: BillingCreditStatus | null;
  /**
   * Reload the credit status after a turn, deduped per completion key so the same
   * turn only triggers one fetch. Reads the model/dev flags from the passed refs
   * at call time.
   */
  refreshBillingCreditStatusAfterTurn: (
    completionKey: string | null | undefined,
  ) => void;
}

/**
 * Owns the chat's live billing-credit-status: seeds from the loader value,
 * updates it from a resource fetcher, and exposes a deduped post-turn refresh.
 * Extracted from Chat.tsx as pure code motion — behavior is unchanged.
 */
export function useBillingCreditStatus(options: {
  /**
   * The resource fetcher, created by the caller so its `useFetcher()` call keeps
   * its position in the component's hook order (some tests key fetchers by order).
   */
  billingStatusFetcher: FetcherWithComponents<BillingCreditStatusResourceData>;
  initialStatus: BillingCreditStatus | null | undefined;
  selectedThreadModelRef: RefObject<LlmModel>;
  locationSearchRef: RefObject<string>;
}): UseBillingCreditStatusResult {
  const {
    billingStatusFetcher,
    initialStatus,
    selectedThreadModelRef,
    locationSearchRef,
  } = options;
  const [currentBillingCreditStatus, setCurrentBillingCreditStatus] =
    useState<BillingCreditStatus | null>(() => initialStatus ?? null);
  const lastBillingRefreshCompletionKeyRef = useRef<string | null>(null);

  useEffect(() => {
    setCurrentBillingCreditStatus(initialStatus ?? null);
    lastBillingRefreshCompletionKeyRef.current = null;
  }, [initialStatus]);

  useEffect(() => {
    if (!billingStatusFetcher.data) return;
    if (!billingStatusFetcher.data.ok) return;
    setCurrentBillingCreditStatus(billingStatusFetcher.data.billingCreditStatus);
  }, [billingStatusFetcher.data]);

  const refreshBillingCreditStatusAfterTurn = useCallback(
    (completionKey: string | null | undefined) => {
      const normalizedCompletionKey = completionKey?.trim();
      if (!normalizedCompletionKey) return;
      if (
        lastBillingRefreshCompletionKeyRef.current === normalizedCompletionKey
      ) {
        return;
      }
      lastBillingRefreshCompletionKeyRef.current = normalizedCompletionKey;

      const params = new URLSearchParams();
      params.set("model", selectedThreadModelRef.current);
      const currentSearchParams = new URLSearchParams(
        locationSearchRef.current,
      );
      for (const key of ["devCreditState", "devChatError"]) {
        const value = currentSearchParams.get(key);
        if (value) params.set(key, value);
      }
      if (typeof billingStatusFetcher.load !== "function") return;
      billingStatusFetcher.load(
        `/api/billing/chat-credit-status?${params.toString()}`,
      );
    },
    [billingStatusFetcher, selectedThreadModelRef, locationSearchRef],
  );

  return { currentBillingCreditStatus, refreshBillingCreditStatusAfterTurn };
}
