import { describe, expect, it } from 'vitest';

import {
  attachArtifactsToToolResultMessages,
  attachToolResultsToMessages,
  mergeToolResultArtifacts,
  normalizeToolResultMessages,
} from '@/lib/streaming';
import type { ContentBlock, Message, ToolResultBlock } from '@/types';
import type { RuntimeCallArtifact } from '@/lib/runtime-artifacts';

function createAssistantMessage(content: ContentBlock[]): Message {
  return {
    id: 'assistant-1',
    thread_id: 'thread-1',
    role: 'assistant',
    content,
    created_at: Date.now(),
  };
}

describe('tool result attachment', () => {
  it('preserves sparse assistant content without materializing undefined blocks', () => {
    const sparseContent = [] as ContentBlock[];
    sparseContent[1] = {
      type: 'tool_use',
      id: 'tool-1',
      name: 'Read',
      input: { file_path: '/tmp/a.txt' },
    };

    const toolResult: ToolResultBlock = {
      type: 'tool_result',
      tool_use_id: 'tool-1',
      content: 'ok',
    };

    const next = attachToolResultsToMessages(
      [createAssistantMessage(sparseContent)],
      [toolResult],
      { threadId: 'thread-1' }
    );

    const assistantContent = next[0].content as unknown[];
    expect(0 in assistantContent).toBe(false);
    expect(assistantContent.at(-1)).toEqual(toolResult);
  });

  it('sanitizes invalid assistant blocks during render normalization', () => {
    const messages: Message[] = [
      {
        id: 'assistant-1',
        thread_id: 'thread-1',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tool-1',
            name: 'Read',
            input: { file_path: '/tmp/a.txt' },
          },
          undefined as unknown as ContentBlock,
        ],
        created_at: Date.now(),
      },
    ];

    expect(() => normalizeToolResultMessages(messages)).not.toThrow();
    const normalized = normalizeToolResultMessages(messages);
    expect(normalized[0].content).toEqual([
      {
        type: 'tool_use',
        id: 'tool-1',
        name: 'Read',
        input: { file_path: '/tmp/a.txt' },
      },
    ]);
  });

  it('merges runtime artifacts into existing tool result blocks', () => {
    const artifact: RuntimeCallArtifact = {
      id: 'artifact-1',
      kind: 'outbound_email',
      toolName: 'send_email',
      status: 'sent',
      title: 'Email sent',
      createdAt: 1,
      updatedAt: 1,
      summary: { to: 'alice@example.com' },
    };
    const messages = [
      createAssistantMessage([
        {
          type: 'tool_use',
          id: 'tool-js-exec',
          name: 'js_exec',
          input: {},
        },
        {
          type: 'tool_result',
          tool_use_id: 'tool-js-exec',
          content: 'ok',
        },
      ]),
    ];

    const result = attachArtifactsToToolResultMessages(messages, 'tool-js-exec', [artifact]);

    expect(result.attached).toBe(true);
    expect((result.messages[0].content as ContentBlock[])[1]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'tool-js-exec',
      artifacts: [artifact],
    });
  });

  it('deduplicates runtime artifacts by id', () => {
    const artifact: RuntimeCallArtifact = {
      id: 'artifact-1',
      kind: 'outbound_slack_message',
      toolName: 'send_slack_message',
      status: 'sent',
      title: 'Slack message sent',
      createdAt: 1,
      updatedAt: 2,
      summary: { channelId: 'C123' },
    };
    const updatedArtifact = {
      ...artifact,
      updatedAt: 3,
      result: { messageTs: '123.456' },
    };

    const result = mergeToolResultArtifacts(
      {
        type: 'tool_result',
        tool_use_id: 'tool-js-exec',
        content: 'ok',
        artifacts: [artifact],
      },
      [updatedArtifact],
    );

    expect(result.artifacts).toEqual([updatedArtifact]);
  });
});
