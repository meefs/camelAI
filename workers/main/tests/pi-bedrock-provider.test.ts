import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Context, Model } from '@earendil-works/pi-ai';

import { __testing, bedrockProviderModule } from '../src/pi-bedrock-provider';
import bedrockProviderWorker from '../../bedrock-provider/src/index';

const model = {
  id: 'global.anthropic.claude-sonnet-4-6',
  api: 'bedrock-converse-stream',
  provider: 'anthropic',
  maxTokens: 1024,
  contextWindow: 128_000,
} as Model<'bedrock-converse-stream'>;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function buildMessages(context: Context) {
  return __testing.buildBedrockInvokeBody(model, context, {
    bearerToken: 'test-token',
    maxTokens: 128,
  }).messages;
}

function fableBedrockModel(): Model<'bedrock-converse-stream'> {
  return {
    id: 'global.anthropic.claude-fable-5',
    api: 'bedrock-converse-stream',
    provider: 'amazon-bedrock',
    name: 'Claude Fable 5 (Global)',
    reasoning: true,
    thinkingLevelMap: { xhigh: 'xhigh' },
    input: ['text', 'image'],
    cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  } as Model<'bedrock-converse-stream'>;
}

describe('Pi Bedrock provider message conversion', () => {
  it('ports upstream Bedrock Claude limits onto sparse custom-routed model objects', () => {
    const sparse = {
      id: 'global.anthropic.claude-sonnet-4-6',
      api: 'bedrock-converse-stream',
      provider: 'amazon-bedrock',
      baseUrl: 'https://bedrock-runtime.us-west-2.amazonaws.com',
      name: 'custom route',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 4_096,
    } as Model<'bedrock-converse-stream'>;

    expect(__testing.withBedrockModelMetadata(sparse)).toMatchObject({
      name: 'Claude Sonnet 4.6 (Global)',
      reasoning: true,
      input: ['text', 'image'],
      contextWindow: 1_000_000,
      maxTokens: 64_000,
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    });
  });

  it('uses upstream Opus 4.8 limits for Bedrock aliases before compaction decisions', () => {
    const sparse = {
      id: 'claude-opus-4-8',
      api: 'bedrock-converse-stream',
      provider: 'amazon-bedrock',
      baseUrl: 'https://bedrock-runtime.us-west-2.amazonaws.com',
      name: 'custom route',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 4_096,
    } as Model<'bedrock-converse-stream'>;

    expect(__testing.withBedrockModelMetadata(sparse)).toMatchObject({
      name: 'Claude Opus 4.8 (Global)',
      reasoning: true,
      thinkingLevelMap: { xhigh: 'xhigh' },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    });
    expect(__testing.resolveBedrockModelFallback('anthropic/claude-opus-4.8')).toMatchObject({
      id: 'global.anthropic.claude-opus-4-8',
      name: 'Claude Opus 4.8 (Global)',
      api: 'bedrock-converse-stream',
      provider: 'amazon-bedrock',
    });
  });

  it('uses upstream Fable 5 limits and the global Bedrock inference profile', () => {
    const sparse = {
      id: 'claude-fable-5',
      api: 'bedrock-converse-stream',
      provider: 'amazon-bedrock',
      baseUrl: 'https://bedrock-runtime.us-west-2.amazonaws.com',
      name: 'custom route',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 4_096,
    } as Model<'bedrock-converse-stream'>;

    expect(__testing.withBedrockModelMetadata(sparse)).toMatchObject({
      id: 'claude-fable-5',
      name: 'Claude Fable 5 (Global)',
      reasoning: true,
      thinkingLevelMap: { xhigh: 'xhigh' },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
    });
    expect(__testing.resolveBedrockModelFallback('anthropic/claude-fable-5')).toMatchObject({
      id: 'global.anthropic.claude-fable-5',
      name: 'Claude Fable 5 (Global)',
      api: 'bedrock-converse-stream',
      provider: 'amazon-bedrock',
    });
    expect(__testing.resolveBedrockModelFallback('anthropic/claude-fable-5')?.id)
      .not.toMatch(/-v1:0$/);
  });

  it('enables prompt caching and adaptive thinking for Fable 5 Bedrock payloads', () => {
    const payload = __testing.buildBedrockInvokeBody(
      fableBedrockModel(),
      {
        systemPrompt: 'You are concise.',
        messages: [{ role: 'user', content: 'hello', timestamp: 1 }],
      },
      {
        bearerToken: 'test-token',
        maxTokens: 128,
        reasoning: 'xhigh',
      },
    );

    expect(payload.system).toEqual([
      {
        type: 'text',
        text: 'You are concise.',
        cache_control: { type: 'ephemeral' },
      },
    ]);
    expect(payload.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } },
        ],
      },
    ]);
    expect(payload.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(payload.output_config).toEqual({ effort: 'xhigh' });
  });

  it('keeps Fable 5 Bedrock payloads on adaptive thinking without explicit reasoning', () => {
    const payload = __testing.buildBedrockInvokeBody(
      fableBedrockModel(),
      {
        messages: [{ role: 'user', content: 'hello', timestamp: 1 }],
      },
      {
        bearerToken: 'test-token',
        maxTokens: 128,
      },
    );

    expect(payload.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(payload.output_config).toEqual({ effort: 'medium' });
  });

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

describe('Pi Bedrock provider retries', () => {
  it('retries transient 524 responses before surfacing a Bedrock error', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(() => Promise.resolve(
      new Response(JSON.stringify({ message: 'error code: 524' }), {
        status: 524,
        headers: { 'content-type': 'application/json' },
      }),
    ));
    vi.stubGlobal('fetch', fetchMock);

    const stream = bedrockProviderModule.streamBedrock(
      model,
      { messages: [{ role: 'user', content: 'hello', timestamp: 1 }] },
      { bearerToken: 'test-token', maxTokens: 1 },
    );
    const eventsPromise = (async () => {
      const events = [];
      for await (const event of stream) {
        events.push(event);
      }
      return events;
    })();

    await vi.advanceTimersByTimeAsync(750);
    const events = await eventsPromise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'error',
      reason: 'error',
      error: expect.objectContaining({
        errorMessage: 'Bedrock request failed with HTTP 524: error code: 524',
      }),
    }));
  });
});

describe('Standalone Bedrock provider model metadata', () => {
  it('exposes Pi-compatible token and compaction limits from /v1/models', async () => {
    const response = await bedrockProviderWorker.fetch(
      new Request('https://bedrock-provider.test/v1/models'),
      {},
    );

    expect(response.status).toBe(200);
    const payload = await response.json() as { data: Array<Record<string, unknown>> };
    expect(payload.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'claude-fable-5',
          bedrockModelId: 'global.anthropic.claude-fable-5',
          contextWindow: 1_000_000,
          maxTokens: 128_000,
          thinkingLevelMap: { xhigh: 'xhigh' },
        }),
        expect.objectContaining({
          id: 'claude-sonnet-4-6',
          contextWindow: 1_000_000,
          context_window: 1_000_000,
          maxTokens: 64_000,
          max_tokens: 64_000,
        }),
        expect.objectContaining({
          id: 'claude-opus-4-8',
          bedrockModelId: 'global.anthropic.claude-opus-4-8',
          contextWindow: 1_000_000,
          maxTokens: 128_000,
          thinkingLevelMap: { xhigh: 'xhigh' },
        }),
      ]),
    );
  });

  it('aliases stale Opus 4.6 and 4.7 requests to Opus 4.8', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    try {
      for (const model of [
        'claude-opus-4-6',
        'claude-opus-4-7',
        'anthropic.claude-opus-4-8',
        'anthropic/claude-opus-4.8',
      ]) {
        const response = await bedrockProviderWorker.fetch(
          new Request('https://bedrock-provider.test/v1/messages', {
            method: 'POST',
            headers: {
              authorization: 'Bearer test-token',
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              model,
              max_tokens: 1,
              messages: [{ role: 'user', content: 'hello' }],
            }),
          }),
          {},
        );

        expect(response.status).toBe(200);
      }
      expect(fetchMock).toHaveBeenCalledTimes(4);
      for (const call of fetchMock.mock.calls) {
        const upstreamUrl = String(call[0]);
        expect(upstreamUrl).toContain('https://bedrock-runtime.us-east-1.amazonaws.com/');
        expect(decodeURIComponent(upstreamUrl)).toContain(
          '/model/global.anthropic.claude-opus-4-8/invoke',
        );
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('routes Fable 5 worker requests through the global Bedrock inference profile', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    try {
      for (const model of [
        'claude-fable-5',
        'anthropic/claude-fable-5',
        'anthropic.claude-fable-5',
      ]) {
        const response = await bedrockProviderWorker.fetch(
          new Request('https://bedrock-provider.test/v1/messages', {
            method: 'POST',
            headers: {
              authorization: 'Bearer test-token',
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              model,
              max_tokens: 1,
              messages: [{ role: 'user', content: 'hello' }],
            }),
          }),
          {},
        );

        expect(response.status).toBe(200);
      }
      expect(fetchMock).toHaveBeenCalledTimes(3);
      for (const call of fetchMock.mock.calls) {
        const upstreamUrl = decodeURIComponent(String(call[0]));
        expect(upstreamUrl).toContain(
          '/model/global.anthropic.claude-fable-5/invoke',
        );
        expect(upstreamUrl).not.toContain('us.anthropic.claude-fable-5');
        expect(upstreamUrl).not.toContain('claude-fable-5-v1:0');
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
