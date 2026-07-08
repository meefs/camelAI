import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { Message } from "@/types";

/** How recent a turn's completion must be to fire the one-shot highlight. */
const FRESHLY_COMPLETED_TURN_WINDOW_MS = 10_000;

export type CompletedTurnMetadata = {
  durationMs: number;
  completedAtMs: number;
};

export interface UseCompletedTurnsResult {
  /** Turn duration/completion badges keyed by assistant message id. */
  completedTurns: Map<string, CompletedTurnMetadata>;
  /** The turn whose "just completed" highlight should animate once, if any. */
  freshlyCompletedTurnId: string | null;
  /** Clear the freshly-completed turn once its animation has been scheduled. */
  clearFreshlyCompletedTurnId: () => void;
}

/**
 * Derives per-turn completion badges from the assistant messages' turn metadata
 * (turnDurationMs / completedAtMs, surfaced from message-metadata.pi) and fires
 * the one-shot "freshly completed" highlight exactly once per turn. Resets on
 * thread change. Extracted from Chat.tsx as pure code motion — behavior is
 * unchanged (the reset stays a layout effect so it runs before the passive
 * derivation effect, as it did inline).
 */
export function useCompletedTurns(
  displayMessages: Message[],
  threadId: string | null | undefined,
): UseCompletedTurnsResult {
  const [freshlyCompletedTurnId, setFreshlyCompletedTurnId] = useState<
    string | null
  >(null);
  // Turn ids whose freshly-completed highlight was already fired, so the one-shot
  // animation runs once per turn (not again when its metadata re-derives).
  const appliedFreshTurnIdsRef = useRef<Set<string>>(new Set());

  useLayoutEffect(() => {
    appliedFreshTurnIdsRef.current = new Set();
    setFreshlyCompletedTurnId(null);
  }, [threadId]);

  const completedTurns = useMemo(() => {
    const map = new Map<string, CompletedTurnMetadata>();
    for (const message of displayMessages) {
      if (message.role !== "assistant") continue;
      if (typeof message.turnDurationMs !== "number") continue;
      map.set(message.id, {
        durationMs: message.turnDurationMs,
        completedAtMs:
          typeof message.completedAtMs === "number"
            ? message.completedAtMs
            : message.created_at,
      });
    }
    return map;
  }, [displayMessages]);

  // Fire the one-shot "freshly completed" highlight for a turn whose completion is
  // recent, exactly once. Historical turns replayed on load are marked applied
  // without animating (their completedAtMs is outside the window).
  useEffect(() => {
    for (const [id, meta] of completedTurns) {
      if (appliedFreshTurnIdsRef.current.has(id)) continue;
      appliedFreshTurnIdsRef.current.add(id);
      if (meta.completedAtMs > Date.now() - FRESHLY_COMPLETED_TURN_WINDOW_MS) {
        setFreshlyCompletedTurnId(id);
      }
    }
  }, [completedTurns]);

  const clearFreshlyCompletedTurnId = useCallback(() => {
    setFreshlyCompletedTurnId(null);
  }, []);

  return { completedTurns, freshlyCompletedTurnId, clearFreshlyCompletedTurnId };
}
