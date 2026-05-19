import { useCallback, useEffect, useRef, useState } from "react";

type StateUpdate<T> = T | ((previous: T) => T);

function resolveStateUpdate<T>(update: StateUpdate<T>, previous: T): T {
  return typeof update === "function"
    ? (update as (previous: T) => T)(previous)
    : update;
}

export function useBufferedState<T>(initialState: T, delayMs: number) {
  const [state, setState] = useState<T>(initialState);
  const stateRef = useRef(state);
  const timeoutRef = useRef<number | null>(null);

  const cancel = useCallback(() => {
    if (timeoutRef.current === null) return;
    window.clearTimeout(timeoutRef.current);
    timeoutRef.current = null;
  }, []);

  const flush = useCallback(() => {
    if (timeoutRef.current === null) return;
    window.clearTimeout(timeoutRef.current);
    timeoutRef.current = null;
    setState(stateRef.current);
  }, []);

  const setImmediate = useCallback(
    (update: StateUpdate<T>) => {
      cancel();
      const next = resolveStateUpdate(update, stateRef.current);
      stateRef.current = next;
      setState(next);
    },
    [cancel],
  );

  const setBuffered = useCallback(
    (update: StateUpdate<T>) => {
      const next = resolveStateUpdate(update, stateRef.current);
      stateRef.current = next;

      if (timeoutRef.current !== null) return;
      timeoutRef.current = window.setTimeout(() => {
        timeoutRef.current = null;
        setState(stateRef.current);
      }, delayMs);
    },
    [delayMs],
  );

  useEffect(() => cancel, [cancel]);

  return {
    state,
    stateRef,
    setImmediate,
    setBuffered,
    flush,
    cancel,
  };
}
