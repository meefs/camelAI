import { describe, expect, it } from 'vitest';

import { applyToolStreamData } from '@/lib/use-pi-chat-stream';
import { MAX_LIVE_OVERLAY_BLOCK_CHARS } from '@/lib/pi-chunk-encoder';

// applyToolStreamData is the pure core of usePiChatStream's onData handler:
// per-tool accumulation with seq-cursor dedupe (useAgentChat can deliver the
// same broadcast chunk twice, and a reconnect replays the buffered stream) and
// a bounded tail.

function run(
  chunks: Array<{ toolCallId: string; text: string; seq?: number }>,
): { stream: Map<string, string>; cursors: Map<string, number> } {
  let stream = new Map<string, string>();
  const cursors = new Map<string, number>();
  for (const chunk of chunks) {
    stream = applyToolStreamData(stream, cursors, chunk) ?? stream;
  }
  return { stream, cursors };
}

describe('applyToolStreamData', () => {
  it('applies two distinct deltas in one batch exactly once each', () => {
    const { stream } = run([
      { toolCallId: 't1', text: 'one', seq: 0 },
      { toolCallId: 't1', text: ' two', seq: 1 },
    ]);
    expect(stream.get('t1')).toBe('one two');
  });

  it('applies a delta delivered twice exactly once', () => {
    // Both delivery paths hand onData the same chunk; interleaved duplicates
    // must not double the output.
    const { stream } = run([
      { toolCallId: 't1', text: 'one', seq: 0 },
      { toolCallId: 't1', text: 'one', seq: 0 },
      { toolCallId: 't1', text: ' two', seq: 1 },
      { toolCallId: 't1', text: ' two', seq: 1 },
    ]);
    expect(stream.get('t1')).toBe('one two');
  });

  it('skips a full replay of already-applied deltas after reconnect', () => {
    const { stream } = run([
      { toolCallId: 't1', text: 'a', seq: 0 },
      { toolCallId: 't1', text: 'b', seq: 1 },
      // reconnect replays the buffered stream from the start
      { toolCallId: 't1', text: 'a', seq: 0 },
      { toolCallId: 't1', text: 'b', seq: 1 },
      { toolCallId: 't1', text: 'c', seq: 2 },
    ]);
    expect(stream.get('t1')).toBe('abc');
  });

  it('tracks cursors per tool independently', () => {
    const { stream } = run([
      { toolCallId: 't1', text: 'x', seq: 0 },
      { toolCallId: 't2', text: 'y', seq: 0 },
      { toolCallId: 't1', text: 'x', seq: 0 },
    ]);
    expect(stream.get('t1')).toBe('x');
    expect(stream.get('t2')).toBe('y');
  });

  it('still applies chunks without a seq (legacy stream mid-deploy)', () => {
    const { stream } = run([
      { toolCallId: 't1', text: 'a' },
      { toolCallId: 't1', text: 'b' },
    ]);
    expect(stream.get('t1')).toBe('ab');
  });

  it('returns null for malformed data and duplicates', () => {
    const cursors = new Map<string, number>();
    const empty = new Map<string, string>();
    expect(applyToolStreamData(empty, cursors, undefined)).toBeNull();
    expect(applyToolStreamData(empty, cursors, { text: 'x' })).toBeNull();
    const once = applyToolStreamData(empty, cursors, { toolCallId: 't', text: 'x', seq: 3 });
    expect(once?.get('t')).toBe('x');
    expect(applyToolStreamData(once!, cursors, { toolCallId: 't', text: 'x', seq: 3 })).toBeNull();
  });

  it('bounds the accumulated output to the live-overlay tail', () => {
    const half = 'x'.repeat(90_000);
    const { stream } = run([
      { toolCallId: 't1', text: half, seq: 0 },
      { toolCallId: 't1', text: half, seq: 1 },
    ]);
    const accumulated = stream.get('t1') ?? '';
    expect(accumulated.length).toBeLessThanOrEqual(MAX_LIVE_OVERLAY_BLOCK_CHARS);
    expect(accumulated.startsWith('…[earlier output truncated')).toBe(true);
    expect(accumulated.endsWith('x')).toBe(true);
  });
});
