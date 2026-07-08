import { describe, expect, it } from 'vitest';

import {
  createTranscriptNormalizationCaches,
  mergeTaskNotifications,
  mergeTeammateMessages,
  normalizeToolResultMessages,
} from '@/lib/streaming';
import type { Message } from '@/types';

// The render-time normalize chain accepts optional per-message identity caches
// (Chat.tsx passes them so streaming ticks skip re-parsing unchanged messages).
// Cached and uncached runs must produce identical output.

function chain(messages: Message[], caches?: ReturnType<typeof createTranscriptNormalizationCaches>) {
  return mergeTaskNotifications(
    mergeTeammateMessages(normalizeToolResultMessages(messages, caches), caches),
    caches,
  );
}

function transcript(): Message[] {
  return [
    {
      id: 'u1',
      thread_id: 't',
      role: 'user',
      content: 'kick off',
      created_at: 1,
    },
    {
      id: 'a1',
      thread_id: 't',
      role: 'assistant',
      content: [
        { type: 'text', text: 'running a tool' },
        { type: 'tool_use', id: 'call-1', name: 'Bash', input: { command: 'ls' } },
      ],
      created_at: 2,
    },
    // Tool-result-only user message: lifted onto the assistant above.
    {
      id: 'u2',
      thread_id: 't',
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call-1', content: 'file1', status: 'succeeded' },
      ],
      created_at: 3,
    },
    // Teammate message: merged into the preceding assistant.
    {
      id: 'u3',
      thread_id: 't',
      role: 'user',
      content: '<teammate-message teammate_id="mate">hello from mate</teammate-message>',
      created_at: 4,
    },
    // Task notification: attached to the assistant owning the tool use.
    {
      id: 'u4',
      thread_id: 't',
      role: 'user',
      content:
        '<task-notification><task-id>task-9</task-id><output-file>/tmp/out</output-file><status>completed</status><summary>done</summary></task-notification>',
      created_at: 5,
      sourceToolUseID: 'call-1',
    },
  ] as Message[];
}

describe('transcript normalization caches', () => {
  it('produces identical output with and without caches', () => {
    const caches = createTranscriptNormalizationCaches();
    expect(chain(transcript(), caches)).toEqual(chain(transcript()));
  });

  it('stays stable across repeated cached runs over the same message identities', () => {
    const caches = createTranscriptNormalizationCaches();
    const messages = transcript();
    const first = chain(messages, caches);
    const second = chain(messages, caches);
    expect(second).toEqual(first);
    expect(second).toEqual(chain(transcript()));
  });

  it('reflects a replaced (new identity) message on the next cached run', () => {
    const caches = createTranscriptNormalizationCaches();
    const messages = transcript();
    chain(messages, caches);
    const updated = [...messages];
    updated[1] = {
      ...messages[1],
      content: [{ type: 'text', text: 'rewritten' }],
    } as Message;
    const result = chain(updated, caches);
    const assistant = result.find((message) => message.id === 'a1');
    expect(assistant?.content).toContainEqual({ type: 'text', text: 'rewritten' });
  });
});
