import { describe, expect, it } from 'vitest';
import type { UIMessage } from 'ai';

import {
  collapseReplayDuplicateParts,
  dedupeUiMessagesById,
} from '@/lib/use-pi-chat-stream';

// Pure normalization for the tab-switch resume-replay duplication: a remount
// mid-turn seeds useAgentChat from the snapshot cache and `resume: true`
// replays the whole buffered turn. When the seeded streaming assistant is not
// the tail message the AI SDK pushes a second same-id message; when it is the
// tail, the replay re-appends every part after the already-hydrated ones.

function message(
  id: string,
  role: UIMessage['role'],
  parts: UIMessage['parts'],
): UIMessage {
  return { id, role, parts } as UIMessage;
}

const text = (t: string) => ({ type: 'text' as const, text: t });
const reasoning = (t: string) => ({ type: 'reasoning' as const, text: t });
const tool = (toolCallId: string, state = 'output-available') =>
  ({ type: 'tool-bash', toolCallId, state }) as never;
const dataPart = (id: string, value: string) =>
  ({ type: 'data-pi-error', id, data: { id, message: value } }) as never;

describe('dedupeUiMessagesById', () => {
  it('returns the input array identity when no id repeats', () => {
    const messages = [
      message('u1', 'user', [text('hi')]),
      message('a1', 'assistant', [text('hello')]),
    ];
    expect(dedupeUiMessagesById(messages)).toBe(messages);
  });

  it('keeps the last occurrence content at the first occurrence position', () => {
    // Steering scenario: seeded assistant T above the steering user skeleton,
    // replayed rebuild of T pushed to the tail.
    const seeded = message('turn-1', 'assistant', [text('partial')]);
    const steering = message('u2', 'user', [text('also do X')]);
    const rebuilt = message('turn-1', 'assistant', [text('partial plus more')]);
    const result = dedupeUiMessagesById([seeded, steering, rebuilt]);
    expect(result.map((m) => m.id)).toEqual(['turn-1', 'u2']);
    expect(result[0]).toBe(rebuilt);
  });

  it('keeps the seeded copy while the replayed rebuild is still emptier', () => {
    // At the instant of the replayed `start`, the pushed rebuild has no parts
    // yet; the richer seeded copy must keep rendering (no blank flash).
    const seeded = message('turn-1', 'assistant', [
      reasoning('plan'),
      text('partial'),
    ]);
    const rebuild = message('turn-1', 'assistant', []);
    const result = dedupeUiMessagesById([
      seeded,
      message('u2', 'user', [text('steer')]),
      rebuild,
    ]);
    expect(result.map((m) => m.id)).toEqual(['turn-1', 'u2']);
    expect(result[0]).toBe(seeded);
  });

  it('collapses more than two copies to the newest one', () => {
    const first = message('turn-1', 'assistant', [text('a')]);
    const second = message('turn-1', 'assistant', [text('ab')]);
    const third = message('turn-1', 'assistant', [text('abc')]);
    const result = dedupeUiMessagesById([
      first,
      message('u1', 'user', [text('q')]),
      second,
      third,
    ]);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(third);
  });
});

describe('collapseReplayDuplicateParts', () => {
  it('returns the message identity when nothing duplicates', () => {
    const msg = message('a1', 'assistant', [
      reasoning('thinking'),
      text('answer'),
      tool('t1'),
    ]);
    expect(collapseReplayDuplicateParts(msg)).toBe(msg);
  });

  it('drops a hydrated text part rebuilt in full by the replay', () => {
    const msg = message('a1', 'assistant', [
      text('The answer is'),
      text('The answer is 42.'),
    ]);
    const result = collapseReplayDuplicateParts(msg);
    expect(result.parts).toEqual([text('The answer is 42.')]);
  });

  it('drops a hydrated reasoning part rebuilt by the replay', () => {
    const msg = message('a1', 'assistant', [
      reasoning('Let me think'),
      text('done'),
      reasoning('Let me think about this properly.'),
    ]);
    const result = collapseReplayDuplicateParts(msg);
    expect(result.parts).toEqual([
      text('done'),
      reasoning('Let me think about this properly.'),
    ]);
  });

  it('drops the hydrated text part while the replayed rebuild is still shorter', () => {
    // Mid-replay: the live copy has not caught up to the hydrated remnant yet.
    // Keeping both would render the exact duplication being fixed.
    const msg = message('a1', 'assistant', [
      text('The answer is 42.'),
      text('The an'),
    ]);
    const result = collapseReplayDuplicateParts(msg);
    expect(result.parts).toEqual([text('The an')]);
  });

  it('dedupes tool parts by toolCallId, keeping the later (replayed) one', () => {
    const hydrated = tool('t1', 'input-available');
    const replayed = tool('t1', 'output-available');
    const msg = message('a1', 'assistant', [hydrated, text('x'), replayed]);
    const result = collapseReplayDuplicateParts(msg);
    expect(result.parts).toEqual([text('x'), replayed]);
  });

  it('dedupes data parts by id', () => {
    const msg = message('a1', 'assistant', [
      dataPart('e1', 'boom'),
      dataPart('e1', 'boom again'),
    ]);
    const result = collapseReplayDuplicateParts(msg);
    expect(result.parts).toEqual([dataPart('e1', 'boom again')]);
  });

  it('collapses the full hydrated+replayed interleave of a mixed message', () => {
    // Tail-seeded case: replay re-appends every part after the hydrated ones.
    const msg = message('a1', 'assistant', [
      reasoning('plan'),
      text('Step one'),
      tool('t1', 'output-available'),
      reasoning('plan'),
      text('Step one, then two.'),
      tool('t1', 'output-available'),
    ]);
    const result = collapseReplayDuplicateParts(msg);
    expect(result.parts).toEqual([
      reasoning('plan'),
      text('Step one, then two.'),
      tool('t1', 'output-available'),
    ]);
  });

  it('keeps identical sibling texts that are NOT a replay artifact shape', () => {
    // Two different texts where neither is a prefix of the other stay intact.
    const msg = message('a1', 'assistant', [
      text('First paragraph.'),
      text('Second paragraph.'),
    ]);
    expect(collapseReplayDuplicateParts(msg)).toBe(msg);
  });

  it('ignores empty hydrated text parts (no zero-length prefix matches)', () => {
    const msg = message('a1', 'assistant', [text(''), text('content')]);
    expect(collapseReplayDuplicateParts(msg)).toBe(msg);
  });
});
