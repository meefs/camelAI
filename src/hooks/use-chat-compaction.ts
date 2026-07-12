import { useCallback, useRef, useState } from "react";

/** Coordinates manual and automatic compaction UI without coupling Chat to
 * the bookkeeping refs used by reconnect and replay paths. */
export function useChatCompaction() {
  const [isCompacting, setIsCompacting] = useState(false);
  const hasCapturedCompactionSummaryRef = useRef(false);
  const queuedManualCompactionsRef = useRef(0);
  const activeManualCompactionTurnRef = useRef(false);
  const isAutoCompactingRef = useRef(false);
  const compactingPriorMessageIdRef = useRef<string | null>(null);
  const [compactingPriorMessageId, setCompactingPriorMessageId] = useState<
    string | null
  >(null);

  const syncCompactionIndicator = useCallback(() => {
    setIsCompacting(
      activeManualCompactionTurnRef.current ||
        queuedManualCompactionsRef.current > 0 ||
        isAutoCompactingRef.current,
    );
  }, []);

  const queueManualCompaction = useCallback(() => {
    queuedManualCompactionsRef.current += 1;
    syncCompactionIndicator();
  }, [syncCompactionIndicator]);

  const completeActiveManualCompaction = useCallback(() => {
    if (activeManualCompactionTurnRef.current) {
      activeManualCompactionTurnRef.current = false;
    } else if (queuedManualCompactionsRef.current > 0) {
      // Reconnect/replay can complete a compact turn without replaying init.
      queuedManualCompactionsRef.current -= 1;
    }
    syncCompactionIndicator();
  }, [syncCompactionIndicator]);

  const clearManualCompactionQueue = useCallback(() => {
    activeManualCompactionTurnRef.current = false;
    queuedManualCompactionsRef.current = 0;
    syncCompactionIndicator();
  }, [syncCompactionIndicator]);

  return {
    activeManualCompactionTurnRef,
    clearManualCompactionQueue,
    compactingPriorMessageId,
    compactingPriorMessageIdRef,
    completeActiveManualCompaction,
    hasCapturedCompactionSummaryRef,
    isAutoCompactingRef,
    isCompacting,
    queueManualCompaction,
    setCompactingPriorMessageId,
    syncCompactionIndicator,
  };
}
