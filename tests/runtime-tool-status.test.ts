import { describe, expect, it } from 'vitest';

import { applyRuntimeEventToMessages } from '@/lib/runtime-message-state';
import type { ContentBlock, Message, ToolResultBlock } from '@/types';

function findToolResult(messages: Message[], id: string): ToolResultBlock | undefined {
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    const block = (message.content as ContentBlock[]).find(
      (entry) => entry.type === 'tool_result' && entry.tool_use_id === id,
    );
    if (block?.type === 'tool_result') return block;
  }
  return undefined;
}

describe('runtime tool status metadata', () => {
  it('marks failed commandExecution completions as failed tool results', () => {
    const streamingIds: Record<string, string | null> = {};

    let messages = applyRuntimeEventToMessages(
      [],
      'thread-1',
      {
        method: 'item/started',
        params: {
          item: {
            id: 'tool-bash',
            type: 'commandExecution',
            command: 'bun run validate',
            status: 'running',
          },
        },
      },
      streamingIds,
    );

    messages = applyRuntimeEventToMessages(
      messages,
      'thread-1',
      {
        method: 'item/completed',
        params: {
          item: {
            id: 'tool-bash',
            type: 'commandExecution',
            command: 'bun run validate',
            status: 'failed',
            aggregatedOutput: 'Error: unsupported extra arguments\n',
          },
        },
      },
      streamingIds,
    );

    expect(findToolResult(messages, 'tool-bash')).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'tool-bash',
      is_error: true,
      status: 'failed',
    });
  });

  it('marks failed dynamicToolCall completions as failed tool results', () => {
    const streamingIds: Record<string, string | null> = {};

    const messages = applyRuntimeEventToMessages(
      [],
      'thread-1',
      {
        method: 'item/completed',
        params: {
          item: {
            id: 'tool-dynamic',
            type: 'dynamicToolCall',
            tool: 'validate_workflow',
            arguments: { name: 'daily-sync' },
            success: false,
            contentItems: [{ type: 'inputText', text: 'Validation failed' }],
          },
        },
      },
      streamingIds,
    );

    expect(findToolResult(messages, 'tool-dynamic')).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'tool-dynamic',
      is_error: true,
      status: 'failed',
    });
  });

  it('marks completed runtime items with failed result details as failed tool results', () => {
    const streamingIds: Record<string, string | null> = {};

    let messages = applyRuntimeEventToMessages(
      [],
      'thread-1',
      {
        method: 'item/completed',
        params: {
          item: {
            id: 'tool-nested-success',
            type: 'dynamicToolCall',
            tool: 'validate_workflow',
            arguments: { name: 'daily-sync' },
            status: 'completed',
            contentItems: [{ type: 'inputText', text: 'Validation failed' }],
            result: { details: { success: false } },
          },
        },
      },
      streamingIds,
    );

    messages = applyRuntimeEventToMessages(
      messages,
      'thread-1',
      {
        method: 'item/completed',
        params: {
          item: {
            id: 'tool-nested-exit-code',
            type: 'commandExecution',
            command: 'bun run validate',
            status: 'completed',
            aggregatedOutput: 'Validation failed\n',
            result: { details: { exitCode: 1 } },
          },
        },
      },
      streamingIds,
    );

    expect(findToolResult(messages, 'tool-nested-success')).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'tool-nested-success',
      is_error: true,
      status: 'failed',
    });
    expect(findToolResult(messages, 'tool-nested-exit-code')).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'tool-nested-exit-code',
      is_error: true,
      status: 'failed',
    });
  });

  it('marks mcpToolCall completions with error payloads as failed tool results', () => {
    const streamingIds: Record<string, string | null> = {};

    const messages = applyRuntimeEventToMessages(
      [],
      'thread-1',
      {
        method: 'item/completed',
        params: {
          item: {
            id: 'tool-mcp',
            type: 'mcpToolCall',
            tool: 'list_resources',
            status: 'completed',
            error: { message: 'MCP server unavailable' },
          },
        },
      },
      streamingIds,
    );

    expect(findToolResult(messages, 'tool-mcp')).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'tool-mcp',
      is_error: true,
      status: 'failed',
    });
  });

});
