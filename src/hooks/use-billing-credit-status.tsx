import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { FetcherWithComponents } from "react-router";

import type { BillingCreditStatus } from "@/lib/chat-credit-status";
import type { LlmModel } from "@/types";

export type BillingCreditStatusResourceData =
  | {
      ok: true;
      billingCreditStatus: BillingCreditStatus | null;
      requestedModel?: LlmModel | null;
      threadModel?: LlmModel | null;
      threadModelUpdatedAt?: number | null;
    }
  | {
      ok: false;
      error?: string;
    };

export interface UseBillingCreditStatusResult {
  currentBillingCreditStatus: BillingCreditStatus | null;
  refreshedThreadModel: RefreshedThreadModel | null;
  /**
   * Reload the credit status after a turn, deduped per completion key so the same
   * turn only triggers one fetch. Reads the model/dev flags from the passed refs
   * at call time.
   */
  refreshBillingCreditStatusAfterTurn: (
    completionKey: string | null | undefined,
  ) => void;
}

export interface RefreshedThreadModel {
  requestedModel: LlmModel;
  model: LlmModel;
  updatedAt: number | null;
}

/**
 * Owns the chat's live billing-credit status and the canonical thread-model
 * snapshot returned by the same deduped post-turn resource refresh.
 */
export function useBillingCreditStatus(options: {
  /**
   * The resource fetcher, created by the caller so its `useFetcher()` call keeps
   * its position in the component's hook order (some tests key fetchers by order).
   */
  billingStatusFetcher: FetcherWithComponents<BillingCreditStatusResourceData>;
  initialStatus: BillingCreditStatus | null | undefined;
  threadId: string | null | undefined;
  selectedThreadModelRef: RefObject<LlmModel>;
  locationSearchRef: RefObject<string>;
}): UseBillingCreditStatusResult {
  const {
    billingStatusFetcher,
    initialStatus,
    threadId,
    selectedThreadModelRef,
    locationSearchRef,
  } = options;
  const [currentBillingCreditStatus, setCurrentBillingCreditStatus] =
    useState<BillingCreditStatus | null>(() => initialStatus ?? null);
  const [refreshedThreadModel, setRefreshedThreadModel] =
    useState<RefreshedThreadModel | null>(null);
  const lastBillingRefreshCompletionKeyRef = useRef<string | null>(null);

  useEffect(() => {
    setCurrentBillingCreditStatus(initialStatus ?? null);
    setRefreshedThreadModel(null);
    lastBillingRefreshCompletionKeyRef.current = null;
  }, [initialStatus, threadId]);

  useEffect(() => {
    if (!billingStatusFetcher.data) return;
    if (!billingStatusFetcher.data.ok) return;
    setCurrentBillingCreditStatus(billingStatusFetcher.data.billingCreditStatus);
    const { requestedModel, threadModel, threadModelUpdatedAt } =
      billingStatusFetcher.data;
    setRefreshedThreadModel(
      requestedModel && threadModel
        ? {
            requestedModel,
            model: threadModel,
            updatedAt:
              typeof threadModelUpdatedAt === "number" &&
              Number.isFinite(threadModelUpdatedAt)
                ? threadModelUpdatedAt
                : null,
          }
        : null,
    );
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
      if (threadId) params.set("threadId", threadId);
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
    [billingStatusFetcher, selectedThreadModelRef, locationSearchRef, threadId],
  );

  return {
    currentBillingCreditStatus,
    refreshedThreadModel,
    refreshBillingCreditStatusAfterTurn,
  };
}
