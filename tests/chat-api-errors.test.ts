import { describe, expect, it } from 'vitest';
import {
  CREDIT_SEND_BLOCKED_MESSAGE,
  getChatApiErrorPresentation,
  isChatBillingOrCreditError,
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
    });

    expect(presentation).toEqual({
      kind: 'hosted_rate_limit',
      title: 'The model provider is temporarily rate limiting camelAI',
      message:
        'Wait 60 seconds and try again. If this keeps happening, contact support. Your workspace is saved.',
    });
    expect('providerUrl' in presentation).toBe(false);
  });

  it('falls back to BYOK when a provider is configured', () => {
    const presentation = getChatApiErrorPresentation(ANTHROPIC_2B_RATE_LIMIT, {
      llmProvider: 'anthropic',
      threadModel: 'sonnet',
    });

    expect(presentation.kind).toBe('byok_rate_limit');
    expect(presentation.title).toBe('Your Anthropic API key is rate limited');
  });

  it('falls back to hosted when the configured provider cannot serve the thread model', () => {
    const presentation = getChatApiErrorPresentation(ANTHROPIC_2B_RATE_LIMIT, {
      llmProvider: 'openai',
      threadModel: 'sonnet',
    });

    expect(presentation.kind).toBe('hosted_rate_limit');
  });

  it('falls back to BYOK when the configured provider can serve the thread model', () => {
    const presentation = getChatApiErrorPresentation(ANTHROPIC_2B_RATE_LIMIT, {
      llmProvider: 'openai',
      threadModel: 'gpt-5.6-luna',
    });

    expect(presentation.kind).toBe('byok_rate_limit');
    expect(presentation.title).toBe('Your OpenAI API key is rate limited');
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

  it.each([
    'OpenAI token refresh returned 401.',
    'Your OpenAI connection has expired or was revoked. Reconnect it in Settings → AI Provider.',
  ])('links OpenAI refresh failures to the reconnect settings', (error) => {
    expect(getChatApiErrorPresentation(error)).toEqual({
      kind: 'provider_auth_action',
      title: 'Reconnect your OpenAI account',
      message:
        'OpenAI rejected the saved ChatGPT/Codex login. Reconnect it in AI Provider settings, or ask an organization admin to reconnect it.',
      actionHref:
        '/settings/organization/ai-provider#openai-subscription',
      actionLabel: 'Reconnect OpenAI',
    });
  });

  it('extracts simple JSON error strings', () => {
    const presentation = getChatApiErrorPresentation(
      '{"error":"Usage limit exceeded. Add credits."}',
    );

    expect(presentation).toEqual({
      kind: 'billing_action',
      title: 'Billing needs attention',
      message: 'Usage limit exceeded. Add credits.',
      actionHref: '/settings/organization/usage?action=topup',
      actionLabel: 'Top up credits',
    });
  });

  it('does not show a camelAI top-up action for BYOK provider billing errors', () => {
    const presentation = getChatApiErrorPresentation(
      '{"error":"Usage limit exceeded. Add credits."}',
      {
        billingSource: 'byok',
        llmProvider: 'openai',
      },
    );

    expect(presentation).toEqual({
      kind: 'generic',
      title: 'Provider billing needs attention',
      message: 'Usage limit exceeded. Add credits.',
    });
  });

  it('explains Bedrock Fable 5 data retention requirements', () => {
    const presentation = getChatApiErrorPresentation(
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"data retention mode \'default\' is not available for this model"}}',
      {
        billingSource: 'byok',
        llmProvider: 'bedrock',
        threadModel: 'fable-5',
      },
    );

    expect(presentation).toEqual({
      kind: 'generic',
      title: 'Bedrock data retention must be enabled for Fable 5',
      message: expect.stringContaining('/v1/data_retention'),
      actionHref:
        'https://docs.aws.amazon.com/bedrock/latest/userguide/data-retention.html',
      actionLabel: 'Open AWS data retention docs',
    });
  });

  it('classifies hosted credit exhaustion with a top-up action', () => {
    const raw =
      'Hosted model credits are used up. You have used 0.00 credits of 0.00 credits.';
    const presentation = getChatApiErrorPresentation(raw);

    expect(isChatBillingOrCreditError(raw)).toBe(true);
    expect(presentation).toEqual({
      kind: 'billing_action',
      title: "You're out of hosted credits",
      message: CREDIT_SEND_BLOCKED_MESSAGE,
      actionHref: '/settings/organization/usage?action=topup',
      actionLabel: 'Top up credits',
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
