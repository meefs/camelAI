import { describe, expect, it } from 'vitest';
import {
  buildCondensedTranscript,
  condensedTranscriptToMarkdown,
} from '@/lib/condensed-transcript';

const baseMessage = {
  thread_id: 'thread-1',
  created_at: 1,
};

describe('condensed transcript', () => {
  it('pairs user turns with final assistant output and omits trace work', () => {
    const transcript = buildCondensedTranscript({
      threadId: 'thread-1',
      title: 'Planning chat',
      messages: [
        {
          ...baseMessage,
          id: 'u1',
          role: 'user',
          content:
            '[Ada (ada@example.com)]: <camelai system message>hidden</camelai system message>Plan @db ⟦ref: postgres "DB" id=conn-1⟧',
          created_at: 1,
        },
        {
          ...baseMessage,
          id: 'a1',
          role: 'assistant',
          content: [
            { type: 'text', text: 'I will inspect the repo first.' },
            { type: 'thinking', thinking: 'need a plan' },
            { type: 'tool_use', id: 'tool-1', name: 'search', input: { q: 'models' } },
            { type: 'tool_result', tool_use_id: 'tool-1', content: 'matches' },
            { type: 'text', text: 'Final **plan**\n\n- Update model IDs.' },
          ],
          created_at: 2,
        },
      ],
    });

    expect(transcript.turns).toEqual([
      {
        user: 'Plan @db',
        assistantFinal: 'Final **plan**\n\n- Update model IDs.',
        omittedCount: 3,
      },
    ]);
  });

  it('skips compact summaries and dangling user turns with no final reply', () => {
    const transcript = buildCondensedTranscript({
      threadId: 'thread-1',
      title: 'Planning chat',
      messages: [
        {
          ...baseMessage,
          id: 'compact',
          role: 'user',
          content: 'previous context',
          isCompactSummary: true,
        },
        {
          ...baseMessage,
          id: 'u1',
          role: 'user',
          content: 'Build the thing',
        },
      ],
    });

    expect(transcript.turns).toEqual([]);
  });

  it('serializes turns to markdown for generated uploads', () => {
    const markdown = condensedTranscriptToMarkdown({
      threadId: 'thread-1',
      title: 'Planning chat',
      turns: [
        {
          user: 'Plan it',
          assistantFinal: 'Done',
          omittedCount: 2,
        },
      ],
    });

    expect(markdown).toContain('# Planning chat transcript');
    expect(markdown).toContain('Source thread: thread-1');
    expect(markdown).toContain('_[2 messages omitted]_');
  });
});
