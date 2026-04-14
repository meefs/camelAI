import { describe, expect, it } from 'vitest';

import { applyRuntimeEventToMessages } from '@/lib/runtime-message-state';
import type { Message } from '@/types';

describe('Codex todo state integration', () => {
  it('maps turn/plan/updated to a TodoWrite tool block', () => {
    const streamingIds: Record<string, string | null> = {};

    const messages = applyRuntimeEventToMessages(
      [],
      'thread-1',
      'codex',
      {
        method: 'turn/plan/updated',
        params: {
          explanation: 'Working through the deployment checklist.',
          plan: [
            { step: 'Inspect logs', status: 'completed' },
            { step: 'Patch proxy env', status: 'inProgress' },
            { step: 'Retry deploy', status: 'pending' },
          ],
        },
      },
      streamingIds,
    );

    expect(messages).toHaveLength(1);
    const [message] = messages;
    expect(message.isStreaming).toBe(true);
    expect(Array.isArray(message.content)).toBe(true);

    const toolUse = (message.content as Message['content'] & Array<unknown>).find(
      (block) => block && typeof block === 'object' && (block as { type?: unknown }).type === 'tool_use',
    ) as {
      type: 'tool_use';
      id: string;
      name: string;
      input: {
        explanation?: string;
        todos?: Array<{ content: string; status: string; activeForm: string }>;
      };
    } | undefined;

    expect(toolUse?.name).toBe('TodoWrite');
    expect(toolUse?.id).toBe('turn:plan:todo');
    expect(toolUse?.input.explanation).toBe('Working through the deployment checklist.');
    expect(toolUse?.input.todos).toEqual([
      { content: 'Inspect logs', status: 'completed', activeForm: 'Inspect logs' },
      { content: 'Patch proxy env', status: 'in_progress', activeForm: 'Patch proxy env' },
      { content: 'Retry deploy', status: 'pending', activeForm: 'Retry deploy' },
    ]);
  });
});
