import { useCallback, useEffect, useRef, useState } from 'react';

export const ONBOARDING_AUTO_ADVANCE_DELAY_MS = 500;

export function useDelayedAdvance(
  onAdvance: () => void,
  delayMs = ONBOARDING_AUTO_ADVANCE_DELAY_MS
) {
  const [isAdvancing, setIsAdvancing] = useState(false);
  const timeoutRef = useRef<number | null>(null);

  const scheduleAdvance = useCallback(() => {
    if (isAdvancing || timeoutRef.current !== null) return;
    setIsAdvancing(true);
    timeoutRef.current = window.setTimeout(() => {
      timeoutRef.current = null;
      setIsAdvancing(false);
      onAdvance();
    }, delayMs);
  }, [delayMs, isAdvancing, onAdvance]);

  useEffect(() => {
    return () => {
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  return { isAdvancing, scheduleAdvance };
}
