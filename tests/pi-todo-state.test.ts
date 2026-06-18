import { describe, expect, it } from 'vitest';

import { applyRuntimeEventToMessages } from '@/lib/runtime-message-state';
import type { ContentBlock, Message } from '@/types';

function findToolUse(messages: Message[], id: string) {
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    const block = (message.content as ContentBlock[]).find(
      (entry) => entry.type === 'tool_use' && entry.id === id,
    );
    if (block?.type === 'tool_use') return block;
  }
  return undefined;
}

describe('Pi todo state integration', () => {
  it('keeps late reasoning deltas in chronological order after assistant text', () => {
    const streamingIds: Record<string, string | null> = {};

    let messages = applyRuntimeEventToMessages(
      [],
      'thread-1',
      {
        method: 'item/agentMessage/delta',
        params: {
          itemId: 'answer-1',
          delta: 'Final answer',
        },
      },
      streamingIds,
    );

    messages = applyRuntimeEventToMessages(
      messages,
      'thread-1',
      {
        method: 'item/reasoning/textDelta',
        params: {
          itemId: 'reasoning-1',
          contentIndex: 0,
          delta: 'I should explain this first.',
        },
      },
      streamingIds,
    );

    const content = messages[0]?.content;
    expect(Array.isArray(content)).toBe(true);
    const blocks = content as ContentBlock[];
    expect(blocks.map((block) => block.type)).toEqual(['text', 'thinking']);
    expect(blocks[0]).toMatchObject({
      type: 'text',
      text: 'Final answer',
    });
    expect(blocks[1]).toMatchObject({
      type: 'thinking',
      thinking: 'I should explain this first.',
    });
  });

  it('does not group reasoning blocks across intervening assistant text', () => {
    const streamingIds: Record<string, string | null> = {};

    let messages = applyRuntimeEventToMessages(
      [],
      'thread-1',
      {
        method: 'item/reasoning/textDelta',
        params: {
          itemId: 'reasoning-1',
          contentIndex: 0,
          delta: 'First thought.',
        },
      },
      streamingIds,
    );

    messages = applyRuntimeEventToMessages(
      messages,
      'thread-1',
      {
        method: 'item/agentMessage/delta',
        params: {
          itemId: 'answer-1',
          delta: 'Interim answer',
        },
      },
      streamingIds,
    );

    messages = applyRuntimeEventToMessages(
      messages,
      'thread-1',
      {
        method: 'item/reasoning/textDelta',
        params: {
          itemId: 'reasoning-2',
          contentIndex: 0,
          delta: 'Second thought.',
        },
      },
      streamingIds,
    );

    const content = messages[0]?.content;
    expect(Array.isArray(content)).toBe(true);
    const blocks = content as ContentBlock[];
    expect(blocks.map((block) => block.type)).toEqual(['thinking', 'text', 'thinking']);
    expect(blocks[0]).toMatchObject({ type: 'thinking', thinking: 'First thought.' });
    expect(blocks[1]).toMatchObject({ type: 'text', text: 'Interim answer' });
    expect(blocks[2]).toMatchObject({ type: 'thinking', thinking: 'Second thought.' });
  });

  it('maps turn/plan/updated to a TodoWrite tool block', () => {
    const streamingIds: Record<string, string | null> = {};

    const messages = applyRuntimeEventToMessages(
      [],
      'thread-1',
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

    const toolUse = findToolUse(messages, 'turn:plan:todo');

    expect(toolUse?.name).toBe('TodoWrite');
    expect(toolUse?.id).toBe('turn:plan:todo');
    expect(toolUse?.input.explanation).toBe('Working through the deployment checklist.');
    expect(toolUse?.input.todos).toEqual([
      { content: 'Inspect logs', status: 'completed', activeForm: 'Inspect logs' },
      { content: 'Patch proxy env', status: 'in_progress', activeForm: 'Patch proxy env' },
      { content: 'Retry deploy', status: 'pending', activeForm: 'Retry deploy' },
    ]);
  });

  it('canonicalizes Pi dynamic tool aliases for live tool cards', () => {
    const streamingIds: Record<string, string | null> = {};

    let messages = applyRuntimeEventToMessages(
      [],
      'thread-1',
      {
        method: 'item/started',
        params: {
          item: {
            id: 'tool-web-search',
            type: 'dynamicToolCall',
            tool: 'web_search',
            arguments: { query: 'Pi coding agent docs' },
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
        method: 'item/started',
        params: {
          item: {
            id: 'tool-list-integrations',
            type: 'dynamicToolCall',
            tool: 'list_integrations',
            arguments: {},
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
        method: 'item/started',
        params: {
          item: {
            id: 'tool-js-exec',
            type: 'dynamicToolCall',
            tool: 'js_exec',
            arguments: {
              description: 'evaluate a quick expression',
              code: 'return 1;',
            },
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
        method: 'item/started',
        params: {
          item: {
            id: 'tool-ls',
            type: 'dynamicToolCall',
            tool: 'ls',
            arguments: { path: '/workspace/src' },
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
        method: 'item/started',
        params: {
          item: {
            id: 'tool-find',
            type: 'dynamicToolCall',
            tool: 'find',
            arguments: { pattern: '*.tsx', path: '/workspace/src' },
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
            id: 'tool-todo',
            type: 'dynamicToolCall',
            tool: 'todo_write',
            arguments: {
              todos: [{ content: 'Check aliases', status: 'completed', activeForm: 'Checking aliases' }],
            },
            status: 'completed',
          },
        },
      },
      streamingIds,
    );

    const webSearch = findToolUse(messages, 'tool-web-search');
    expect(webSearch?.name).toBe('WebSearch');
    expect(webSearch?.input.query).toBe('Pi coding agent docs');
    expect(webSearch?.input.rawToolName).toBe('web_search');

    const todo = findToolUse(messages, 'tool-todo');
    expect(todo?.name).toBe('TodoWrite');
    expect(todo?.input.todos).toEqual([
      { content: 'Check aliases', status: 'completed', activeForm: 'Checking aliases' },
    ]);
    expect(todo?.input.rawToolName).toBe('todo_write');

    const ls = findToolUse(messages, 'tool-ls');
    expect(ls?.name).toBe('LS');
    expect(ls?.input.path).toBe('/workspace/src');

    const find = findToolUse(messages, 'tool-find');
    expect(find?.name).toBe('Find');
    expect(find?.input.pattern).toBe('*.tsx');

    const jsExec = findToolUse(messages, 'tool-js-exec');
    expect(jsExec?.name).toBe('JavaScript');
    expect(jsExec?.input.description).toBe('evaluate a quick expression');
    expect(jsExec?.input.code).toBe('return 1;');
    expect(jsExec?.input.rawToolName).toBe('js_exec');

    const listIntegrations = findToolUse(messages, 'tool-list-integrations');
    expect(listIntegrations?.name).toBe('ListConnections');
    expect(listIntegrations?.input.rawToolName).toBe('list_integrations');
  });

  it('preserves Pi dynamic tool input when completion omits arguments', () => {
    const streamingIds: Record<string, string | null> = {};

    let messages = applyRuntimeEventToMessages(
      [],
      'thread-1',
      {
        method: 'item/started',
        params: {
          item: {
            id: 'tool-web-fetch',
            type: 'dynamicToolCall',
            tool: 'web_fetch',
            arguments: { url: 'https://example.com' },
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
            id: 'tool-web-fetch',
            type: 'dynamicToolCall',
            tool: 'web_fetch',
            status: 'completed',
            result: 'ok',
          },
        },
      },
      streamingIds,
    );

    const webFetch = findToolUse(messages, 'tool-web-fetch');
    expect(webFetch?.name).toBe('WebFetch');
    expect(webFetch?.input.url).toBe('https://example.com');
    expect(webFetch?.input.status).toBe('completed');
    expect(webFetch?.input.rawToolName).toBe('web_fetch');
  });

  it('preserves command descriptions when completion omits optional fields', () => {
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
            command: 'pwd',
            description: 'Check workspace directory',
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
            command: 'pwd',
            status: 'completed',
            aggregatedOutput: '/workspace\n',
          },
        },
      },
      streamingIds,
    );

    const bash = findToolUse(messages, 'tool-bash');
    expect(bash?.name).toBe('Bash');
    expect(bash?.input.command).toBe('pwd');
    expect(bash?.input.description).toBe('Check workspace directory');
    expect(bash?.input.status).toBe('completed');
  });
});
