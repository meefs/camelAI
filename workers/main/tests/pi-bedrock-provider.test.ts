import { describe, expect, it } from 'vitest';
import type { Context, Model } from '@mariozechner/pi-ai';

import { __testing } from '../src/pi-bedrock-provider';

const model = {
  id: 'global.anthropic.claude-sonnet-4-6',
  api: 'bedrock-converse-stream',
  provider: 'anthropic',
  maxTokens: 1024,
  contextWindow: 128_000,
} as Model<'bedrock-converse-stream'>;

function buildMessages(context: Context) {
  return __testing.buildBedrockInvokeBody(model, context, {
    bearerToken: 'test-token',
    maxTokens: 128,
  }).messages;
}

describe('Pi Bedrock provider message conversion', () => {
  it('synthesizes an immediate tool_result user message for missing Pi tool results', () => {
    const messages = buildMessages({
      messages: [
        { role: 'user', content: 'list files', timestamp: 100 },
        {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'tool1', name: 'ls', arguments: {} }],
          responseId: 'resp_tool',
          timestamp: 200,
          api: 'test',
          provider: 'test',
          model: 'test',
          usage: {},
          stopReason: 'toolUse',
        },
        { role: 'user', content: 'continue', timestamp: 300 },
      ],
    });

    expect(messages).toEqual([
      { role: 'user', content: 'list files' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tool1', name: 'ls', input: {} }],
      },
      {
        role: 'user',
        // Last user message — cache_control goes on the last block ('continue' text).
        content: [{
          type: 'tool_result',
          tool_use_id: 'tool1',
          content: 'Tool call interrupted; no result was recorded.',
          is_error: true,
        }, { type: 'text', text: 'continue', cache_control: { type: 'ephemeral' } }],
      },
    ]);
  });

  it('places existing tool results immediately after their assistant tool_use', () => {
    const messages = buildMessages({
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'tool1', name: 'read', arguments: {} }],
          responseId: 'resp_tool',
          timestamp: 100,
          api: 'test',
          provider: 'test',
          model: 'test',
          usage: {},
          stopReason: 'toolUse',
        },
        {
          role: 'toolResult',
          toolCallId: 'tool1',
          toolName: 'read',
          content: [{ type: 'text', text: 'file contents' }],
          isError: false,
          timestamp: 200,
        },
        { role: 'user', content: 'thanks', timestamp: 300 },
      ],
    });

    expect(messages).toEqual([
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tool1', name: 'read', input: {} }],
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tool1',
          content: 'file contents',
          is_error: false,
        }],
      },
      {
        role: 'user',
        // Last user message (string) is converted to an array so cache_control can be attached.
        content: [{ type: 'text', text: 'thanks', cache_control: { type: 'ephemeral' } }],
      },
    ]);
  });

  it('trims assistant blocks that appear after tool_use before replaying to Bedrock', () => {
    const messages = buildMessages({
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'thinking',
              thinking: 'checking',
              thinkingSignature: 'valid-signature',
            },
            { type: 'toolCall', id: 'tool1', name: 'read', arguments: {} },
            {
              type: 'thinking',
              thinking: '[Reasoning redacted]',
              thinkingSignature: 'openrouter.reasoning:abc',
            },
          ],
          responseId: 'resp_tool',
          timestamp: 100,
          // Match the model so isSameModel=true and thinking blocks keep their signatures.
          api: 'bedrock-converse-stream',
          provider: 'anthropic',
          model: 'global.anthropic.claude-sonnet-4-6',
          usage: {},
          stopReason: 'toolUse',
        },
        {
          role: 'toolResult',
          toolCallId: 'tool1',
          toolName: 'read',
          content: [{ type: 'text', text: 'file contents' }],
          isError: false,
          timestamp: 200,
        },
      ],
    });

    expect(messages).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'checking', signature: 'valid-signature' },
          { type: 'tool_use', id: 'tool1', name: 'read', input: {} },
        ],
      },
      {
        role: 'user',
        // Last user message — cache_control goes on the tool_result.
        content: [{
          type: 'tool_result',
          tool_use_id: 'tool1',
          content: 'file contents',
          is_error: false,
          cache_control: { type: 'ephemeral' },
        }],
      },
    ]);
  });

  it('moves leftover user content after the required tool_result message', () => {
    const messages = __testing.normalizeAnthropicToolResultAdjacency([
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tool1', name: 'read', input: {} }],
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'not a tool result' },
          { type: 'tool_result', tool_use_id: 'tool1', content: 'ok' },
        ],
      },
    ]);

    expect(messages).toEqual([
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tool1', name: 'read', input: {} }],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tool1', content: 'ok' },
          { type: 'text', text: 'not a tool result' },
        ],
      },
    ]);
  });
});
