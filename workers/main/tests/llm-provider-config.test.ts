import { describe, expect, it } from 'vitest';
import { encryptCredentials } from '../../../src/lib/integration-crypto';
import {
  DEFAULT_CODEX_MODEL,
  buildPublicLlmProviderConfig,
  DEFAULT_LLM_MODEL,
  getDefaultLlmModel,
  getDefaultThreadProvider,
  getLlmModelOptions,
  getProviderForModel,
  getVisibleLlmModelOptions,
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

  it('guards Codex GPT models behind the org experimental setting for new chats', () => {
    expect(parseOrganizationExperimentalSettings(null)).toEqual({ codex_gpt_models: false });
    expect(getDefaultThreadProvider('openai', { codex_gpt_models: false })).toBe('claude');
    expect(getDefaultThreadProvider('openai', { codex_gpt_models: true })).toBe('codex');
    expect(getVisibleLlmModelOptions('codex', { codex_gpt_models: false })).toEqual([]);
    expect(getVisibleLlmModelOptions('codex', { codex_gpt_models: true }).map((option) => option.value)).toEqual([
      'gpt-5.4',
      'gpt-5.4-mini',
    ]);
  });

  it('shows both Claude and GPT options for new chats when the experimental flag is on', () => {
    expect(
      getVisibleLlmModelOptions(
        'claude',
        { codex_gpt_models: true },
        undefined,
        { allowModelFamilySwitch: true },
      ).map((option) => option.value)
    ).toEqual(['sonnet', 'opus', 'gpt-5.4', 'gpt-5.4-mini']);
  });

  it('keeps the current GPT model visible for existing locked threads when the flag is off', () => {
    expect(
      getVisibleLlmModelOptions('codex', { codex_gpt_models: false }, 'gpt-5.4-mini').map((option) => option.value)
    ).toEqual(['gpt-5.4-mini']);
  });

  it('infers the thread provider from the selected model', () => {
    expect(getProviderForModel('gpt-5.4', 'claude')).toBe('codex');
    expect(getProviderForModel('gpt-5.4-mini', 'claude')).toBe('codex');
    expect(getProviderForModel('sonnet', 'codex')).toBe('claude');
    expect(getProviderForModel(undefined, 'claude')).toBe('claude');
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
