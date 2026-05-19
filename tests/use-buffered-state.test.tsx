import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useBufferedState } from '@/hooks/use-buffered-state';

afterEach(() => {
  vi.useRealTimers();
});

describe('useBufferedState', () => {
  it('coalesces buffered updates into one visible state change', () => {
    vi.useFakeTimers();
    const renderedStates: number[] = [];
    const { result } = renderHook(() => {
      const buffered = useBufferedState(0, 50);
      renderedStates.push(buffered.state);
      return buffered;
    });

    act(() => {
      result.current.setBuffered((previous) => previous + 1);
      result.current.setBuffered((previous) => previous + 1);
      result.current.setBuffered((previous) => previous + 1);
    });

    expect(result.current.state).toBe(0);
    expect(result.current.stateRef.current).toBe(3);
    expect(renderedStates).toEqual([0]);

    act(() => {
      vi.advanceTimersByTime(50);
    });

    expect(result.current.state).toBe(3);
    expect(renderedStates).toEqual([0, 3]);
  });

  it('flushes pending buffered state before immediate updates', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useBufferedState('start', 50));

    act(() => {
      result.current.setBuffered((previous) => `${previous} buffered`);
      result.current.setImmediate((previous) => `${previous} immediate`);
    });

    expect(result.current.state).toBe('start buffered immediate');

    act(() => {
      vi.advanceTimersByTime(50);
    });

    expect(result.current.state).toBe('start buffered immediate');
  });

  it('can flush pending buffered state synchronously', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useBufferedState(['a'], 50));

    act(() => {
      result.current.setBuffered((previous) => [...previous, 'b']);
      result.current.flush();
    });

    expect(result.current.state).toEqual(['a', 'b']);

    act(() => {
      vi.advanceTimersByTime(50);
    });

    expect(result.current.state).toEqual(['a', 'b']);
  });
});
