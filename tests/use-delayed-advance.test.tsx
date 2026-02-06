import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ONBOARDING_AUTO_ADVANCE_DELAY_MS,
  useDelayedAdvance,
} from '@/components/onboarding/use-delayed-advance';

describe('useDelayedAdvance', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls onAdvance after the configured delay', () => {
    const onAdvance = vi.fn();
    const { result } = renderHook(() => useDelayedAdvance(onAdvance));

    act(() => {
      result.current.scheduleAdvance();
      vi.advanceTimersByTime(ONBOARDING_AUTO_ADVANCE_DELAY_MS - 1);
    });
    expect(onAdvance).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onAdvance).toHaveBeenCalledTimes(1);
  });

  it('uses the latest callback when props change before timeout fires', () => {
    const firstAdvance = vi.fn();
    const secondAdvance = vi.fn();
    const { result, rerender } = renderHook(
      ({ onAdvance }) => useDelayedAdvance(onAdvance),
      { initialProps: { onAdvance: firstAdvance } }
    );

    act(() => {
      result.current.scheduleAdvance();
    });

    rerender({ onAdvance: secondAdvance });

    act(() => {
      vi.advanceTimersByTime(ONBOARDING_AUTO_ADVANCE_DELAY_MS);
    });

    expect(firstAdvance).not.toHaveBeenCalled();
    expect(secondAdvance).toHaveBeenCalledTimes(1);
  });
});
