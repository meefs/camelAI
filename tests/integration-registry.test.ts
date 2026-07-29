import { describe, expect, it } from 'vitest';
import {
  INTEGRATION_REGISTRY,
  getAllIntegrations,
  type IntegrationDefinition,
  filterVisibleCredentials,
  isCredentialFieldRequired,
  requiresCredentialEntryOnEdit,
  shouldClearHiddenCredentials,
  shouldShowConfigField,
  shouldShowCredentialField,
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

  it('offers native Discord while keeping the legacy token definition readable', () => {
    expect(INTEGRATION_REGISTRY.discord_channel).toMatchObject({
      displayName: 'Discord',
      authMethod: 'oauth2',
      credentialSchema: [],
    });
    expect(INTEGRATION_REGISTRY.discord).toMatchObject({
      displayName: 'Discord bot token (legacy)',
      deprecated: {
        hiddenFromCreate: true,
        replacementType: 'discord_channel',
      },
    });
    expect(getAllIntegrations().map((definition) => definition.type)).not.toContain('discord_channel');
    expect(getAllIntegrations({ includeFeatureGated: true }).map((definition) => definition.type))
      .toContain('discord_channel');
    expect(getAllIntegrations().map((definition) => definition.type)).not.toContain('discord');
    expect(getIntegrationAuthLabel(INTEGRATION_REGISTRY.discord_channel)).toBe('Discord install');
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

describe('other (custom API) connection field visibility', () => {
  const credentialNames = () =>
    INTEGRATION_REGISTRY.other.credentialSchema.map((field) => field.name);

  const visibleCredentials = (config: Record<string, unknown>) =>
    credentialNames().filter((name) => shouldShowCredentialField('other', name, config));

  it('shows only the API key field for bearer auth', () => {
    expect(visibleCredentials({ auth_type: 'bearer' })).toEqual(['api_key']);
    expect(isCredentialFieldRequired('other', 'api_key', { auth_type: 'bearer' }, false)).toBe(true);
    expect(shouldShowConfigField('other', 'auth_header', { auth_type: 'bearer' })).toBe(false);
  });

  it('defaults to bearer behavior when auth_type is omitted', () => {
    expect(visibleCredentials({})).toEqual(['api_key']);
    expect(isCredentialFieldRequired('other', 'api_key', {}, false)).toBe(true);
    expect(shouldShowConfigField('other', 'auth_header', {})).toBe(false);
  });

  it('hides all credential fields and the header field for none auth', () => {
    expect(visibleCredentials({ auth_type: 'none' })).toEqual([]);
    expect(isCredentialFieldRequired('other', 'api_key', { auth_type: 'none' }, false)).toBe(false);
    expect(shouldShowConfigField('other', 'auth_header', { auth_type: 'none' })).toBe(false);
  });

  it('shows the API key and header name fields for custom header auth', () => {
    expect(visibleCredentials({ auth_type: 'header' })).toEqual(['api_key']);
    expect(isCredentialFieldRequired('other', 'api_key', { auth_type: 'header' }, false)).toBe(true);
    expect(shouldShowConfigField('other', 'auth_header', { auth_type: 'header' })).toBe(true);
  });

  it('shows the client id/secret pair for basic auth and requires both', () => {
    expect(visibleCredentials({ auth_type: 'basic' })).toEqual(['client_id', 'client_secret']);
    expect(isCredentialFieldRequired('other', 'client_id', { auth_type: 'basic' }, false)).toBe(true);
    expect(isCredentialFieldRequired('other', 'client_secret', { auth_type: 'basic' }, false)).toBe(true);
    expect(shouldShowConfigField('other', 'auth_header', { auth_type: 'basic' })).toBe(false);
    // Bearer-only credentials should not show under basic auth.
    expect(shouldShowCredentialField('other', 'api_key', { auth_type: 'basic' })).toBe(false);
  });

  it('normalizes auth_type casing and whitespace', () => {
    expect(visibleCredentials({ auth_type: ' Basic ' })).toEqual(['client_id', 'client_secret']);
    expect(shouldShowConfigField('other', 'auth_header', { auth_type: 'HEADER' })).toBe(true);
  });
});

describe('requiresCredentialEntryOnEdit for other connections', () => {
  const other = INTEGRATION_REGISTRY.other;
  const requires = (
    current: Record<string, unknown>,
    stored: Record<string, unknown>,
    hasStored: boolean
  ) => requiresCredentialEntryOnEdit(other, current, stored, hasStored);

  it('does not require entry when the stored auth mode is unchanged', () => {
    expect(requires({ auth_type: 'bearer' }, { auth_type: 'bearer' }, true)).toBe(false);
  });

  it('requires entry when switching from none to a credentialed mode', () => {
    expect(requires({ auth_type: 'bearer' }, { auth_type: 'none' }, true)).toBe(true);
  });

  it('requires entry when switching basic to bearer (stored secret cannot satisfy api_key)', () => {
    expect(requires({ auth_type: 'bearer' }, { auth_type: 'basic' }, true)).toBe(true);
    expect(requires({ auth_type: 'basic' }, { auth_type: 'bearer' }, true)).toBe(true);
  });

  it('does not require entry switching bearer to header (api_key is reused)', () => {
    expect(requires({ auth_type: 'header' }, { auth_type: 'bearer' }, true)).toBe(false);
  });

  it('requires entry when no credentials are stored yet but the mode needs them', () => {
    expect(requires({ auth_type: 'bearer' }, { auth_type: 'bearer' }, false)).toBe(true);
  });

  it('never requires entry when the new mode needs no credentials', () => {
    expect(requires({ auth_type: 'none' }, { auth_type: 'bearer' }, true)).toBe(false);
    expect(requires({ auth_type: 'none' }, { auth_type: 'basic' }, false)).toBe(false);
  });

  it('treats a missing stored auth_type as the bearer default', () => {
    // Legacy "other" record created before an explicit auth_type was stored.
    expect(requires({ auth_type: 'bearer' }, {}, true)).toBe(false);
    expect(requires({ auth_type: 'basic' }, {}, true)).toBe(true);
  });
});

describe('shouldClearHiddenCredentials', () => {
  const other = INTEGRATION_REGISTRY.other;
  const clears = (
    current: Record<string, unknown>,
    stored: Record<string, unknown>,
    hasStored: boolean
  ) => shouldClearHiddenCredentials(other, current, stored, hasStored);

  it('clears when switching bearer to none (api_key becomes hidden)', () => {
    expect(clears({ auth_type: 'none' }, { auth_type: 'bearer' }, true)).toBe(true);
  });

  it('clears when switching basic to none (client_id/secret become hidden)', () => {
    expect(clears({ auth_type: 'none' }, { auth_type: 'basic' }, true)).toBe(true);
  });

  it('does not clear when switching bearer to header (api_key stays visible)', () => {
    expect(clears({ auth_type: 'header' }, { auth_type: 'bearer' }, true)).toBe(false);
  });

  it('does not clear when switching none to bearer (nothing previously visible is hidden)', () => {
    expect(clears({ auth_type: 'bearer' }, { auth_type: 'none' }, true)).toBe(false);
  });

  it('never clears when no credentials are stored', () => {
    expect(clears({ auth_type: 'none' }, { auth_type: 'bearer' }, false)).toBe(false);
    expect(clears({ auth_type: 'bearer' }, { auth_type: 'basic' }, false)).toBe(false);
  });

  it('does not clear for a display-name-only change with the same auth mode', () => {
    expect(
      clears(
        { auth_type: 'bearer', display_name: 'New Name' },
        { auth_type: 'bearer', display_name: 'Old Name' },
        true
      )
    ).toBe(false);
  });

  it('is a no-op for non-other types without conditional visibility', () => {
    expect(
      shouldClearHiddenCredentials(
        INTEGRATION_REGISTRY.stripe,
        { auth_type: 'none' },
        { auth_type: 'bearer' },
        true
      )
    ).toBe(false);
  });
});

describe('filterVisibleCredentials', () => {
  it('drops api_key for other connections using none auth', () => {
    expect(
      filterVisibleCredentials('other', { auth_type: 'none' }, { api_key: 'secret', api_secret: 'shh' })
    ).toEqual({});
  });

  it('keeps api_key but drops client_id/client_secret for other bearer auth', () => {
    expect(
      filterVisibleCredentials(
        'other',
        { auth_type: 'bearer' },
        { api_key: 'secret', client_id: 'cid', client_secret: 'csecret' }
      )
    ).toEqual({ api_key: 'secret' });
  });

  it('keeps client_id/client_secret but drops api_key for other basic auth', () => {
    expect(
      filterVisibleCredentials(
        'other',
        { auth_type: 'basic' },
        { api_key: 'secret', client_id: 'cid', client_secret: 'csecret' }
      )
    ).toEqual({ client_id: 'cid', client_secret: 'csecret' });
  });

  it('keeps api_key for other custom header auth', () => {
    expect(
      filterVisibleCredentials(
        'other',
        { auth_type: 'header' },
        { api_key: 'secret', client_secret: 'csecret' }
      )
    ).toEqual({ api_key: 'secret' });
  });

  it('is a no-op for non-other types (keeps all provided keys)', () => {
    expect(
      filterVisibleCredentials('stripe', {}, { api_key: 'sk_test_123', extra: 'value' })
    ).toEqual({ api_key: 'sk_test_123', extra: 'value' });
  });
});
