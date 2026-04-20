import { describe, expect, it } from 'vitest';
import { encryptCredentials } from '../../../src/lib/integration-crypto';
import {
  DEFAULT_CODEX_MODEL,
  buildPublicLlmProviderConfig,
  DEFAULT_LLM_MODEL,
  getDefaultLlmModel,
  getDefaultThreadProvider,
  getAffectedChatHarnessesForLlmProviderChange,
  getAllowedChatHarnessesForNewThread,
  getChatHarnessesForLlmProvider,
  getLlmModelOptions,
  getProviderForModel,
  getVisibleLlmModelOptions,
  isLlmModelAllowedForNewThread,
  parseOrganizationExperimentalSettings,
  normalizeLlmModel,
  parseStoredLlmProviderConfig,
  stringifyStoredLlmProviderConfig,
} from '../../../src/lib/llm-provider-config';

describe('llm provider config helpers', () => {
  it('defaults missing thread model to sonnet', () => {
    expect(normalizeLlmModel(undefined)).toBe(DEFAULT_LLM_MODEL);
    expect(normalizeLlmModel(undefined, 'codex')).toBe(DEFAULT_CODEX_MODEL);
    expect(getDefaultLlmModel('claude')).toBe(DEFAULT_LLM_MODEL);
    expect(getDefaultLlmModel('codex')).toBe(DEFAULT_CODEX_MODEL);
    expect(parseStoredLlmProviderConfig('{}')).toEqual({});
  });

  it('returns provider-specific model options', () => {
    expect(getLlmModelOptions('claude').map((option) => option.value)).toEqual(['sonnet', 'opus']);
    expect(getLlmModelOptions('codex').map((option) => option.value)).toEqual(['gpt-5.4', 'gpt-5.4-mini']);
  });

  it('makes Codex the default for OpenAI BYOK and standard proxy orgs', () => {
    expect(parseOrganizationExperimentalSettings(null)).toEqual({
      claude_proxy_models: false,
    });
    expect(getDefaultThreadProvider('openai', { claude_proxy_models: false })).toBe('codex');
    expect(getDefaultThreadProvider(null, { claude_proxy_models: false })).toBe('codex');
    expect(getDefaultThreadProvider('anthropic', { claude_proxy_models: false })).toBe('claude');
    expect(getDefaultThreadProvider('bedrock', { claude_proxy_models: false })).toBe('claude');
    expect(getVisibleLlmModelOptions('codex', { claude_proxy_models: false }).map((option) => option.value)).toEqual([
      'gpt-5.4',
      'gpt-5.4-mini',
    ]);
  });

  it('shows only policy-allowed model families for new chats', () => {
    expect(
      getVisibleLlmModelOptions(
        'codex',
        { claude_proxy_models: true },
        undefined,
        { allowModelFamilySwitch: true, orgProvider: null },
      ).map((option) => option.value)
    ).toEqual(['gpt-5.4', 'gpt-5.4-mini', 'sonnet', 'opus']);
    expect(
      getVisibleLlmModelOptions(
        'codex',
        { claude_proxy_models: true },
        undefined,
        { allowModelFamilySwitch: true, orgProvider: 'openai' },
      ).map((option) => option.value)
    ).toEqual(['gpt-5.4', 'gpt-5.4-mini']);
    expect(
      getVisibleLlmModelOptions(
        'claude',
        { claude_proxy_models: false },
        undefined,
        { allowModelFamilySwitch: true, orgProvider: 'anthropic' },
      ).map((option) => option.value)
    ).toEqual(['sonnet', 'opus']);
  });

  it('keeps the current model visible for existing locked threads regardless of new-chat policy', () => {
    expect(
      getVisibleLlmModelOptions('codex', { claude_proxy_models: false }, 'gpt-5.4-mini').map((option) => option.value)
    ).toEqual(['gpt-5.4', 'gpt-5.4-mini']);
    expect(
      getVisibleLlmModelOptions('claude', { claude_proxy_models: false }, 'sonnet').map((option) => option.value)
    ).toEqual(['sonnet', 'opus']);
  });

  it('validates new thread models against BYOK and proxy policy', () => {
    expect(getAllowedChatHarnessesForNewThread(null, { claude_proxy_models: false })).toEqual(['codex']);
    expect(getAllowedChatHarnessesForNewThread(null, { claude_proxy_models: true })).toEqual(['codex', 'claude']);
    expect(isLlmModelAllowedForNewThread('gpt-5.4', null, { claude_proxy_models: false })).toBe(true);
    expect(isLlmModelAllowedForNewThread('sonnet', null, { claude_proxy_models: false })).toBe(false);
    expect(isLlmModelAllowedForNewThread('sonnet', 'anthropic', { claude_proxy_models: false })).toBe(true);
    expect(isLlmModelAllowedForNewThread('gpt-5.4', 'anthropic', { claude_proxy_models: false })).toBe(false);
    expect(isLlmModelAllowedForNewThread('gpt-5.4', 'openai', { claude_proxy_models: true })).toBe(true);
    expect(isLlmModelAllowedForNewThread('sonnet', 'openai', { claude_proxy_models: true })).toBe(false);
  });

  it('infers the thread provider from the selected model', () => {
    expect(getProviderForModel('gpt-5.4', 'claude')).toBe('codex');
    expect(getProviderForModel('gpt-5.4-mini', 'claude')).toBe('codex');
    expect(getProviderForModel('sonnet', 'codex')).toBe('claude');
    expect(getProviderForModel(undefined, 'claude')).toBe('claude');
  });

  it('maps org BYOK providers to the affected chat harnesses', () => {
    expect(getChatHarnessesForLlmProvider('anthropic')).toEqual(['claude']);
    expect(getChatHarnessesForLlmProvider('bedrock')).toEqual(['claude']);
    expect(getChatHarnessesForLlmProvider('openai')).toEqual(['codex']);
    expect(getChatHarnessesForLlmProvider(null)).toEqual([]);

    expect(getAffectedChatHarnessesForLlmProviderChange('openai', 'anthropic')).toEqual([
      'codex',
      'claude',
    ]);
    expect(getAffectedChatHarnessesForLlmProviderChange('anthropic', 'bedrock')).toEqual([
      'claude',
    ]);
    expect(getAffectedChatHarnessesForLlmProviderChange('openai', null)).toEqual(['codex']);
  });

  it('round-trips explicit region values', () => {
    const serialized = stringifyStoredLlmProviderConfig({
      aws_region: 'us-west-2',
    });

    expect(parseStoredLlmProviderConfig(serialized)).toEqual({
      aws_region: 'us-west-2',
    });
  });

  it('builds a public config with a redacted key hint', async () => {
    const encrypted = await encryptCredentials({ api_key: 'sk-ant-test-secret-1234' }, 'test-secret-key');

    const config = await buildPublicLlmProviderConfig(
      {
        provider: 'anthropic',
        credentials_encrypted: encrypted,
        config: '{}',
        created_by: 'user_123',
        created_at: 100,
        updated_at: 200,
      },
      'test-secret-key'
    );

    expect(config).toEqual({
      provider: 'anthropic',
      config: {},
      key_hint: 'sk-ant-t...',
      created_by: 'user_123',
      created_at: 100,
      updated_at: 200,
    });
  });
});
