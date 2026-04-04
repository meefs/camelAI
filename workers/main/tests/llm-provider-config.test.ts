import { describe, expect, it } from 'vitest';
import { encryptCredentials } from '../../../src/lib/integration-crypto';
import {
  buildPublicLlmProviderConfig,
  DEFAULT_LLM_MODEL,
  normalizeLlmModel,
  parseStoredLlmProviderConfig,
  stringifyStoredLlmProviderConfig,
} from '../../../src/lib/llm-provider-config';

describe('llm provider config helpers', () => {
  it('defaults missing thread model to sonnet', () => {
    expect(normalizeLlmModel(undefined)).toBe(DEFAULT_LLM_MODEL);
    expect(parseStoredLlmProviderConfig('{}')).toEqual({});
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
