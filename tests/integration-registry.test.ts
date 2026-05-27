import { describe, expect, it } from 'vitest';
import {
  INTEGRATION_REGISTRY,
  type IntegrationDefinition,
  shouldStoreIntegrationCredentials,
  validateCredentials,
} from '@/lib/integration-registry';
import { getIntegrationAuthLabel } from '@/lib/integration-auth-label';

describe('integration registry credential storage', () => {
  it('does not store fake credentials for credentialless direct MCP integrations', () => {
    expect(validateCredentials('notion', {})).toEqual([]);
    expect(shouldStoreIntegrationCredentials('notion', {})).toBe(false);
  });

  it('stores credentials for integrations with credential schema fields', () => {
    expect(shouldStoreIntegrationCredentials('stripe', {})).toBe(true);
    expect(shouldStoreIntegrationCredentials('stripe', { api_key: 'sk_test_123' })).toBe(true);
  });

  it('stores unexpected non-empty credentials for forward compatibility', () => {
    expect(shouldStoreIntegrationCredentials('notion', { access_token: 'token' })).toBe(true);
  });

  it('labels Telegram as bot setup instead of API key setup', () => {
    expect(getIntegrationAuthLabel(INTEGRATION_REGISTRY.telegram)).toBe('Bot setup');
  });

  it('keeps credential-backed integrations labeled as API key', () => {
    expect(getIntegrationAuthLabel(INTEGRATION_REGISTRY.openai)).toBe('API Key');
  });

  it('labels credentialless API-key definitions as setup', () => {
    const definition: IntegrationDefinition = {
      ...INTEGRATION_REGISTRY.openai,
      type: 'credentialless_test',
      credentialSchema: [],
    };

    expect(getIntegrationAuthLabel(definition)).toBe('Setup');
  });
});
