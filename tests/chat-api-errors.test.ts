import { describe, expect, it } from 'vitest';
import {
  getChatApiErrorPresentation,
  parseChatApiError,
} from '@/lib/chat-api-errors';
import { BYOK_PROVIDERS, type OnboardingByokProvider } from '@/lib/byok-providers';

const ANTHROPIC_2B_RATE_LIMIT =
  '429 {"error":{"type":"rate_limit_error","message":"Type 2b rate limited. Please try again later."}}';

describe('chat API error classification', () => {
  it.each([
    ['anthropic', 'Anthropic'],
    ['openrouter', 'OpenRouter'],
    ['openai', 'OpenAI'],
    ['bedrock', 'Bedrock'],
  ] satisfies Array<[OnboardingByokProvider, string]>)(
    'classifies %s BYOK rate limits with provider metadata',
    (provider, label) => {
      const presentation = getChatApiErrorPresentation(ANTHROPIC_2B_RATE_LIMIT, {
        billingSource: 'byok',
        llmProvider: provider,
        threadProvider: provider === 'openai' ? 'codex' : 'claude',
      });

      if (presentation.kind !== 'byok_rate_limit') {
        throw new Error(`Expected BYOK rate limit, got ${presentation.kind}`);
      }
      expect(presentation.title).toBe(`Your ${label} API key is rate limited`);
      expect(presentation.providerLabel).toBe(label);
      expect(presentation.providerUrl).toBe(BYOK_PROVIDERS[provider].getKeyUrl);
      expect(presentation.providerLinkLabel).toBe(
        BYOK_PROVIDERS[provider].settingsLinkLabel,
      );
    },
  );

  it('classifies Anthropic BYOK rate limits without exposing provider internals', () => {
    const presentation = getChatApiErrorPresentation(ANTHROPIC_2B_RATE_LIMIT, {
      billingSource: 'byok',
      llmProvider: 'anthropic',
      threadProvider: 'claude',
    });

    expect(presentation.kind).toBe('byok_rate_limit');
    expect(presentation.title).toBe('Your Anthropic API key is rate limited');
    expect(presentation.message).toContain('controlled by Anthropic, not camelAI');
    expect(presentation.message).toContain('wait 60 seconds and try again');
    expect(presentation.message).not.toContain('Type 2b');
  });

  it('classifies the same raw error as hosted when billingSource is hosted', () => {
    const presentation = getChatApiErrorPresentation(ANTHROPIC_2B_RATE_LIMIT, {
      billingSource: 'hosted',
      llmProvider: 'anthropic',
      threadProvider: 'claude',
    });

    expect(presentation).toEqual({
      kind: 'hosted_rate_limit',
      title: 'The model provider is temporarily rate limiting camelAI',
      message:
        'Wait 60 seconds and try again. If this keeps happening, contact support. Your workspace is saved.',
    });
    expect('providerUrl' in presentation).toBe(false);
  });

  it('falls back to BYOK when the configured provider supports the thread harness', () => {
    const presentation = getChatApiErrorPresentation(ANTHROPIC_2B_RATE_LIMIT, {
      llmProvider: 'anthropic',
      threadProvider: 'claude',
    });

    expect(presentation.kind).toBe('byok_rate_limit');
    expect(presentation.title).toBe('Your Anthropic API key is rate limited');
  });

  it('falls back to hosted when the configured provider does not support the thread harness', () => {
    const presentation = getChatApiErrorPresentation(ANTHROPIC_2B_RATE_LIMIT, {
      llmProvider: 'openai',
      threadProvider: 'claude',
    });

    expect(presentation.kind).toBe('hosted_rate_limit');
  });

  it('preserves non-rate-limit generic errors', () => {
    const presentation = getChatApiErrorPresentation(
      'Error: Failed to send message',
    );

    expect(presentation).toEqual({
      kind: 'generic',
      message: 'Failed to send message',
    });
  });

  it('extracts simple JSON error strings', () => {
    const presentation = getChatApiErrorPresentation(
      '{"error":"Usage limit exceeded. Add credits."}',
    );

    expect(presentation).toEqual({
      kind: 'generic',
      message: 'Usage limit exceeded. Add credits.',
    });
  });

  it('parses status and provider details from embedded JSON', () => {
    const details = parseChatApiError(
      'API Error: 429 {"error":{"type":"rate_limit_error","message":"wait"}}',
    );

    expect(details.status).toBe(429);
    expect(details.providerErrorType).toBe('rate_limit_error');
    expect(details.providerMessage).toBe('wait');
    expect(details.isRateLimit).toBe(true);
  });
});
