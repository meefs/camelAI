import { createHash } from 'node:crypto';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  STARTER_PROMPTS,
  pickStarterPrompts,
} from '@/components/welcome-screen/starter-prompt-catalog';
import { useResolvedList } from '@/components/welcome-screen/use-resolved-list';

describe('welcome screen owners', () => {
  it('pins the exact starter-prompt catalog moved out of the view', () => {
    expect(STARTER_PROMPTS).toHaveLength(24);
    expect(
      createHash('sha256')
        .update(JSON.stringify(STARTER_PROMPTS))
        .digest('hex'),
    ).toBe('99e5ad0d96b1878475e9979f580fd4a3c0dc967dec54f3ead15cf82b6e37c25a');
  });

  it('selects prompts without mutating the canonical catalog', () => {
    const before = [...STARTER_PROMPTS];
    const selected = pickStarterPrompts(STARTER_PROMPTS, 4, () => 0.25);

    expect(selected).toHaveLength(4);
    expect(STARTER_PROMPTS).toEqual(before);
  });

  it('resolves deferred lists and accepts a later immediate replacement', async () => {
    let resolve!: (value: string[]) => void;
    const deferred = new Promise<string[]>((next) => {
      resolve = next;
    });
    const empty: string[] = [];
    const { result, rerender } = renderHook<
      string[],
      { value: string[] | Promise<string[]> }
    >(
      ({ value }: { value: string[] | Promise<string[]> }) =>
        useResolvedList(value, empty),
      { initialProps: { value: deferred } },
    );

    expect(result.current).toBe(empty);
    act(() => resolve(['deferred']));
    await waitFor(() => expect(result.current).toEqual(['deferred']));

    rerender({ value: ['immediate'] });
    await waitFor(() => expect(result.current).toEqual(['immediate']));
  });

  it('projects a rejected deferred list to the provided empty value', async () => {
    const empty: string[] = [];
    let reject!: (error: Error) => void;
    const rejected = new Promise<string[]>((_, next) => {
      reject = next;
    });
    const { result, rerender } = renderHook<
      string[],
      { value: string[] | Promise<string[]> }
    >(
      ({ value }) => useResolvedList(value, empty),
      { initialProps: { value: ['existing'] } },
    );

    rerender({ value: rejected });
    expect(result.current).toEqual(['existing']);
    act(() => reject(new Error('unavailable')));

    await waitFor(() => expect(result.current).toBe(empty));
  });
});
