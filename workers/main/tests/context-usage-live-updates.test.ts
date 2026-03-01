import { describe, expect, it } from 'vitest';
import {
  applyContextUsageSdkEvent,
  resolveContextUsageForInit,
  type ContextUsageTrackingState,
} from '../src/durable-objects.js';

function initialState(
  overrides: Partial<ContextUsageTrackingState> = {}
): ContextUsageTrackingState {
  return {
    contextUsedPercent: null,
    transientContextUsedPercent: null,
    lastMessageStartUsage: null,
    usageIsPostCompaction: true,
    cachedContextWindowByModel: {},
    ...overrides,
  };
}

describe('context usage live updates', () => {
  it('emits live updates on message_start when model context window is cached', () => {
    let state = initialState({
      cachedContextWindowByModel: { 'claude-sonnet-4': 200_000 },
    });

    const firstCall = applyContextUsageSdkEvent(state, {
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: {
          model: 'claude-sonnet-4',
          usage: { input_tokens: 20_000 },
        },
      },
    });
    state = firstCall.nextState;

    expect(firstCall.liveUsedPercent).toBe(10);
    expect(firstCall.finalUsedPercent).toBeNull();
    expect(state.transientContextUsedPercent).toBe(10);

    const secondCall = applyContextUsageSdkEvent(state, {
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: {
          model: 'claude-sonnet-4',
          usage: { input_tokens: 24_000 },
        },
      },
    });
    state = secondCall.nextState;

    expect(secondCall.liveUsedPercent).toBe(12);
    expect(state.transientContextUsedPercent).toBe(12);

    const result = applyContextUsageSdkEvent(state, {
      type: 'result',
      modelUsage: {
        'claude-sonnet-4': { contextWindow: 200_000 },
      },
    });
    state = result.nextState;

    expect(result.finalUsedPercent).toBe(12);
    expect(state.contextUsedPercent).toBe(12);
    expect(state.transientContextUsedPercent).toBeNull();
    expect(state.lastMessageStartUsage).toBeNull();
  });

  it('skips live updates without cached context window and caches on result', () => {
    let state = initialState();

    const messageStart = applyContextUsageSdkEvent(state, {
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: {
          model: 'claude-sonnet-4',
          usage: { input_tokens: 30_000 },
        },
      },
    });
    state = messageStart.nextState;

    expect(messageStart.liveUsedPercent).toBeUndefined();
    expect(state.transientContextUsedPercent).toBeNull();

    const result = applyContextUsageSdkEvent(state, {
      type: 'result',
      modelUsage: {
        'claude-sonnet-4': { contextWindow: 200_000 },
      },
    });
    state = result.nextState;

    expect(result.contextWindowCacheChanged).toBe(true);
    expect(state.cachedContextWindowByModel['claude-sonnet-4']).toBe(200_000);
    expect(result.finalUsedPercent).toBe(15);
    expect(state.contextUsedPercent).toBe(15);
  });

  it('does not persist stale pre-compaction usage when compact boundary precedes result', () => {
    let state = initialState({
      contextUsedPercent: 25,
      cachedContextWindowByModel: { 'claude-sonnet-4': 200_000 },
    });

    const preCompactMessage = applyContextUsageSdkEvent(state, {
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: {
          model: 'claude-sonnet-4',
          usage: { input_tokens: 60_000 },
        },
      },
    });
    state = preCompactMessage.nextState;
    expect(preCompactMessage.liveUsedPercent).toBe(30);

    const compactBoundary = applyContextUsageSdkEvent(state, {
      type: 'system',
      subtype: 'compact_boundary',
    });
    state = compactBoundary.nextState;

    expect(compactBoundary.liveUsedPercent).toBe(25);
    expect(state.usageIsPostCompaction).toBe(false);
    expect(state.transientContextUsedPercent).toBeNull();

    const result = applyContextUsageSdkEvent(state, {
      type: 'result',
      modelUsage: {
        'claude-sonnet-4': { contextWindow: 200_000 },
      },
    });
    state = result.nextState;

    expect(result.finalUsedPercent).toBeNull();
    expect(state.contextUsedPercent).toBe(25);
    expect(state.lastMessageStartUsage).toBeNull();
    expect(state.usageIsPostCompaction).toBe(true);
  });

  it('uses post-compaction message_start for final result computation', () => {
    let state = initialState({
      contextUsedPercent: 25,
      cachedContextWindowByModel: { 'claude-sonnet-4': 200_000 },
    });

    state = applyContextUsageSdkEvent(state, {
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: {
          model: 'claude-sonnet-4',
          usage: { input_tokens: 80_000 },
        },
      },
    }).nextState;

    state = applyContextUsageSdkEvent(state, {
      type: 'system',
      subtype: 'compact_boundary',
    }).nextState;

    const postCompactMessage = applyContextUsageSdkEvent(state, {
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: {
          model: 'claude-sonnet-4',
          usage: { input_tokens: 20_000 },
        },
      },
    });
    state = postCompactMessage.nextState;
    expect(postCompactMessage.liveUsedPercent).toBe(10);

    const result = applyContextUsageSdkEvent(state, {
      type: 'result',
      modelUsage: {
        'claude-sonnet-4': { contextWindow: 200_000 },
      },
    });
    state = result.nextState;

    expect(result.finalUsedPercent).toBe(10);
    expect(state.contextUsedPercent).toBe(10);
  });

  it('caches context windows per model and enables live updates after model switch', () => {
    let state = initialState({
      cachedContextWindowByModel: { 'claude-sonnet-4': 200_000 },
    });

    const sonnetLive = applyContextUsageSdkEvent(state, {
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: {
          model: 'claude-sonnet-4',
          usage: { input_tokens: 20_000 },
        },
      },
    });
    state = sonnetLive.nextState;
    expect(sonnetLive.liveUsedPercent).toBe(10);

    const haikuLiveBeforeCache = applyContextUsageSdkEvent(state, {
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: {
          model: 'claude-haiku-3',
          usage: { input_tokens: 5_000 },
        },
      },
    });
    state = haikuLiveBeforeCache.nextState;
    expect(haikuLiveBeforeCache.liveUsedPercent).toBeNull();
    expect(state.transientContextUsedPercent).toBeNull();

    const firstHaikuResult = applyContextUsageSdkEvent(state, {
      type: 'result',
      modelUsage: {
        'claude-haiku-3': { contextWindow: 100_000 },
      },
    });
    state = firstHaikuResult.nextState;

    expect(firstHaikuResult.contextWindowCacheChanged).toBe(true);
    expect(state.cachedContextWindowByModel['claude-sonnet-4']).toBe(200_000);
    expect(state.cachedContextWindowByModel['claude-haiku-3']).toBe(100_000);
    expect(firstHaikuResult.finalUsedPercent).toBe(5);

    const haikuLiveAfterCache = applyContextUsageSdkEvent(state, {
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: {
          model: 'claude-haiku-3',
          usage: { input_tokens: 10_000 },
        },
      },
    });

    expect(haikuLiveAfterCache.liveUsedPercent).toBe(10);
  });

  it('reverts to canonical usage when uncached message_start follows cached live update', () => {
    let state = initialState({
      contextUsedPercent: 22,
      cachedContextWindowByModel: { 'claude-sonnet-4': 200_000 },
    });

    const cachedModelLive = applyContextUsageSdkEvent(state, {
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: {
          model: 'claude-sonnet-4',
          usage: { input_tokens: 20_000 },
        },
      },
    });
    state = cachedModelLive.nextState;
    expect(cachedModelLive.liveUsedPercent).toBe(10);
    expect(state.transientContextUsedPercent).toBe(10);

    const uncachedModelMessageStart = applyContextUsageSdkEvent(state, {
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: {
          model: 'claude-haiku-3',
          usage: { input_tokens: 5_000 },
        },
      },
    });
    state = uncachedModelMessageStart.nextState;

    expect(uncachedModelMessageStart.liveUsedPercent).toBe(22);
    expect(state.transientContextUsedPercent).toBeNull();
  });

  it('emits clear update when compact boundary invalidates transient usage without canonical value', () => {
    let state = initialState({
      cachedContextWindowByModel: { 'claude-sonnet-4': 200_000 },
    });

    const preCompactMessage = applyContextUsageSdkEvent(state, {
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: {
          model: 'claude-sonnet-4',
          usage: { input_tokens: 40_000 },
        },
      },
    });
    state = preCompactMessage.nextState;
    expect(preCompactMessage.liveUsedPercent).toBe(20);
    expect(state.transientContextUsedPercent).toBe(20);

    const compactBoundary = applyContextUsageSdkEvent(state, {
      type: 'system',
      subtype: 'compact_boundary',
    });
    state = compactBoundary.nextState;

    expect(compactBoundary.liveUsedPercent).toBeNull();
    expect(state.transientContextUsedPercent).toBeNull();
    expect(state.usageIsPostCompaction).toBe(false);
  });

  it('replays transient context usage when available on chat init', () => {
    expect(resolveContextUsageForInit(18, 22, true)).toBe(18);
    expect(resolveContextUsageForInit(null, 22, true)).toBe(22);
    expect(resolveContextUsageForInit(null, null, true)).toBeNull();
    expect(resolveContextUsageForInit(18, 22, false)).toBe(22);
    expect(resolveContextUsageForInit(18, null, false)).toBeNull();
  });
});
