import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { getModel, streamSimple, type AssistantMessageEvent, type Context } from '@earendil-works/pi-ai';

import { ChatThreadDO } from '../src/chat-thread-do';

type BedrockTestEnv = {
  AWS_BEARER_TOKEN_BEDROCK?: string;
  AWS_DEFAULT_REGION?: string;
  AWS_REGION?: string;
  BEDROCK_API_KEY?: string;
  BEDROCK_AWS_REGION?: string;
  BEDROCK_PI_TEST_MODEL?: string;
  BEDROCK_TEST_MODEL?: string;
  BEDROCK_TEST_REGION?: string;
};

const bedrockEnv = env as unknown as BedrockTestEnv;
const bedrockApiKey =
  bedrockEnv.BEDROCK_API_KEY?.trim() ||
  bedrockEnv.AWS_BEARER_TOKEN_BEDROCK?.trim();
const bedrockRegion =
  bedrockEnv.BEDROCK_TEST_REGION?.trim() ||
  bedrockEnv.BEDROCK_AWS_REGION?.trim() ||
  bedrockEnv.AWS_REGION?.trim() ||
  bedrockEnv.AWS_DEFAULT_REGION?.trim() ||
  'us-east-1';
const bedrockModelId =
  bedrockEnv.BEDROCK_PI_TEST_MODEL?.trim() ||
  bedrockEnv.BEDROCK_TEST_MODEL?.trim() ||
  'global.anthropic.claude-sonnet-4-6';
const maybeIt = bedrockApiKey ? it : it.skip;

function textFromDoneEvent(event: AssistantMessageEvent): string {
  if (event.type !== 'done') return '';
  return event.message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

describe('Pi Bedrock provider in the Worker runtime', () => {
  maybeIt(
    'streams a real Bedrock response through Pi',
    async () => {
      const catalogModel = getModel('amazon-bedrock', bedrockModelId as never);
      expect(catalogModel, `Missing Pi Bedrock test model ${bedrockModelId}`).toBeDefined();

      const model = {
        ...catalogModel!,
        baseUrl: `https://bedrock-runtime.${bedrockRegion}.amazonaws.com`,
      };
      const context: Context = {
        systemPrompt: 'You are a smoke test. Reply with a short plain-text answer.',
        messages: [
          {
            role: 'user',
            content: 'Reply with exactly: bedrock worker ok',
            timestamp: Date.now(),
          },
        ],
      };
      const abort = new AbortController();
      const timeout = setTimeout(() => abort.abort(), 45_000);
      const events: AssistantMessageEvent[] = [];

      try {
        const stream = ChatThreadDO.prototype['streamPiModel'].call(
          Object.create(ChatThreadDO.prototype),
          model,
          context,
          {
            apiKey: bedrockApiKey,
            maxTokens: 24,
            region: bedrockRegion,
            signal: abort.signal,
            temperature: 0,
          },
          streamSimple,
        );

        for await (const event of stream) {
          events.push(event);
        }
      } finally {
        clearTimeout(timeout);
      }

      const error = events.find((event) => event.type === 'error');
      expect(error, error?.type === 'error' ? error.error.errorMessage : undefined).toBeUndefined();

      const done = events.find((event) => event.type === 'done');
      expect(done, 'Bedrock stream did not emit a done event').toBeDefined();
      expect(textFromDoneEvent(done!)).toContain('bedrock worker ok');
    },
    60_000,
  );
});
