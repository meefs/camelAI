import { describe, expect, it } from 'vitest';
import type { Message } from '../../../src/types';
import { mergeThreadMessages } from '../../../src/lib/thread-messages.server';

function textMessage(
  id: string,
  role: Message['role'],
  text: string,
  createdAt: number,
): Message {
  return {
    id,
    thread_id: 'thread-1',
    role,
    content: [{ type: 'text', text }],
    created_at: createdAt,
  };
}

describe('mergeThreadMessages', () => {
  it('merges persisted messages with legacy history without dropping earlier messages', () => {
    const legacy = [
      textMessage('u1', 'user', 'hello', 1_000),
      textMessage('a1', 'assistant', 'hi', 2_000),
      textMessage('u2', 'user', 'build a page', 3_000),
      textMessage('a2', 'assistant', 'done', 4_000),
    ];

    const persisted = [
      textMessage('persisted-u2', 'user', 'build a page', 3_002),
      textMessage('persisted-a2', 'assistant', 'done', 4_004),
    ];

    expect(mergeThreadMessages(legacy, persisted)).toEqual([
      textMessage('u1', 'user', 'hello', 1_000),
      textMessage('a1', 'assistant', 'hi', 2_000),
      textMessage('u2', 'user', 'build a page', 3_000),
      textMessage('a2', 'assistant', 'done', 4_000),
    ]);
  });

  it('does not collapse repeated identical messages that are far apart in time', () => {
    const legacy = [
      textMessage('u1', 'user', 'ok', 1_000),
      textMessage('a1', 'assistant', 'ok', 2_000),
    ];

    const persisted = [
      textMessage('u2', 'user', 'ok', 40_000),
      textMessage('a2', 'assistant', 'ok', 41_000),
    ];

    expect(mergeThreadMessages(legacy, persisted).map((message) => message.id)).toEqual([
      'u1',
      'a1',
      'u2',
      'a2',
    ]);
  });
});
