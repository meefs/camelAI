import { describe, expect, it } from 'vitest';
import { parseClaudeJsonlMessages } from '@/lib/chat-jsonl-parser';

function toJsonl(events: unknown[]): string {
  return events.map(event => JSON.stringify(event)).join('\n');
}

function toMillis(iso: string): number {
  return new Date(iso).getTime();
}

describe('parseClaudeJsonlMessages', () => {
  it('uses result timestamp as assistant created_at when available', () => {
    const userAt = '2026-02-10T17:12:00.000Z';
    const assistantStartAt = '2026-02-10T17:12:05.000Z';
    const assistantToolAt = '2026-02-10T17:14:10.000Z';
    const toolResultAt = '2026-02-10T17:14:40.000Z';
    const assistantDoneAt = '2026-02-10T17:15:03.000Z';
    const nextUserAt = '2026-02-10T17:16:00.000Z';

    const jsonl = toJsonl([
      {
        type: 'user',
        uuid: 'user-1',
        timestamp: userAt,
        message: { content: [{ type: 'text', text: 'Please run it.' }] },
      },
      {
        type: 'assistant',
        timestamp: assistantStartAt,
        message: {
          id: 'assistant-1',
          content: [{ type: 'text', text: 'Running now...' }],
        },
      },
      {
        type: 'assistant',
        timestamp: assistantToolAt,
        message: {
          id: 'assistant-1',
          content: [{
            type: 'tool_use',
            id: 'tool-1',
            name: 'Bash',
            input: { command: 'echo hi' },
          }],
        },
      },
      {
        type: 'user',
        timestamp: toolResultAt,
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'hi' }],
        },
      },
      {
        type: 'result',
        timestamp: assistantDoneAt,
      },
      {
        type: 'user',
        uuid: 'user-2',
        timestamp: nextUserAt,
        message: { content: [{ type: 'text', text: 'Thanks.' }] },
      },
    ]);

    const messages = parseClaudeJsonlMessages(jsonl, 'thread-1');
    expect(messages).toHaveLength(3);

    expect(messages[0].role).toBe('user');
    expect(messages[0].created_at).toBe(toMillis(userAt));

    expect(messages[1].role).toBe('assistant');
    expect(messages[1].created_at).toBe(toMillis(assistantDoneAt));
    expect(Array.isArray(messages[1].content)).toBe(true);
    const assistantBlocks = messages[1].content as Array<{ type: string }>;
    expect(assistantBlocks.some(block => block.type === 'tool_result')).toBe(true);

    expect(messages[2].role).toBe('user');
    expect(messages[2].created_at).toBe(toMillis(nextUserAt));
  });

  it('uses latest tool_result timestamp when result event is missing', () => {
    const userAt = '2026-02-10T18:00:00.000Z';
    const assistantStartAt = '2026-02-10T18:00:10.000Z';
    const toolResultAt = '2026-02-10T18:01:00.000Z';
    const nextUserAt = '2026-02-10T18:02:00.000Z';

    const jsonl = toJsonl([
      {
        type: 'user',
        timestamp: userAt,
        message: { content: [{ type: 'text', text: 'Do the thing.' }] },
      },
      {
        type: 'assistant',
        timestamp: assistantStartAt,
        message: {
          id: 'assistant-1',
          content: [{ type: 'text', text: 'I am on it.' }],
        },
      },
      {
        type: 'user',
        timestamp: toolResultAt,
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'done' }],
        },
      },
      {
        type: 'user',
        timestamp: nextUserAt,
        message: { content: [{ type: 'text', text: 'Next prompt.' }] },
      },
    ]);

    const messages = parseClaudeJsonlMessages(jsonl, 'thread-1');
    expect(messages).toHaveLength(3);
    expect(messages[1].role).toBe('assistant');
    expect(messages[1].created_at).toBe(toMillis(toolResultAt));
  });

  it('uses latest assistant timestamp across partial assistant updates', () => {
    const userAt = '2026-02-10T19:00:00.000Z';
    const assistantStartAt = '2026-02-10T19:00:05.000Z';
    const assistantFinalAt = '2026-02-10T19:00:30.000Z';
    const nextUserAt = '2026-02-10T19:01:00.000Z';

    const jsonl = toJsonl([
      {
        type: 'user',
        timestamp: userAt,
        message: { content: [{ type: 'text', text: 'Explain this.' }] },
      },
      {
        type: 'assistant',
        timestamp: assistantStartAt,
        message: {
          id: 'assistant-1',
          content: [{ type: 'text', text: 'First draft' }],
        },
      },
      {
        type: 'assistant',
        timestamp: assistantFinalAt,
        message: {
          id: 'assistant-1',
          content: [{ type: 'text', text: 'Final answer' }],
        },
      },
      {
        type: 'user',
        timestamp: nextUserAt,
        message: { content: [{ type: 'text', text: 'Follow-up' }] },
      },
    ]);

    const messages = parseClaudeJsonlMessages(jsonl, 'thread-1');
    expect(messages).toHaveLength(3);
    expect(messages[1].role).toBe('assistant');
    expect(messages[1].created_at).toBe(toMillis(assistantFinalAt));
    expect(messages[1].content).toEqual([{ type: 'text', text: 'Final answer' }]);
  });
});
