import { describe, expect, it } from 'vitest';
import {
  shouldStoreIntegrationCredentials,
  validateCredentials,
} from '@/lib/integration-registry';

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
});
