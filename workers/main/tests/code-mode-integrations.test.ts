import { describe, expect, it, vi } from 'vitest';
import { decryptCredentials } from '../../../src/lib/integration-crypto';
import { CodeModeIntegrations } from '../src/code-mode-integrations';

function integrationsHarness(overrides: Partial<ConstructorParameters<typeof CodeModeIntegrations>[0]> = {}) {
  const createIntegration = vi.fn();
  const updateIntegration = vi.fn();
  const getIntegration = vi.fn(async (_workspaceId: string, id: string) =>
    id === 'docs_mcp'
      ? {
          id,
          integration_type: 'remote_mcp',
          name: 'Docs MCP',
          category: 'saas',
          auth_method: 'api_key',
          config: JSON.stringify({ server_url: 'https://old.example.com/mcp', auth_type: 'bearer' }),
          credentials_encrypted: 'encrypted',
          created_by: 'user_1',
          created_at: 1,
          updated_at: 1,
          deleted_at: null,
          token_expires_at: null,
          auth_status: 'needs_reauth',
          auth_error_code: 'AUTH_REAUTH_REQUIRED',
          auth_error_message: null,
          auth_checked_at: null,
          reauth_required_at: 2,
        }
      : null);
  const orgStub = {
    getWorkspaceIntegrations: vi.fn(async () => []),
    getWorkspaceIntegration: getIntegration,
    createWorkspaceIntegration: createIntegration,
    updateWorkspaceIntegration: updateIntegration,
  } as ConstructorParameters<typeof CodeModeIntegrations>[0]['orgStub'];

  const promptConnectionSetup = vi.fn(async () => ({
    requestId: 'req_1',
    cancelled: false,
    integration: {
      type: 'remote_mcp',
      name: 'Docs MCP',
      config: { server_url: 'https://mcp.example.com/mcp', auth_type: 'bearer' },
      credentials: { token: 'secret-token' },
    },
  }));

  const options = {
    env: { INTEGRATION_SECRET_KEY: 'test-secret' },
    orgStub,
    workspaceId: 'workspace_1',
    userId: 'user_1',
    promptConnectionSetup,
    ...overrides,
  };
  const integrations = new CodeModeIntegrations(options);

  return {
    createIntegration,
    getIntegration,
    integrations,
    promptConnectionSetup: options.promptConnectionSetup,
    updateIntegration,
  };
}

describe('CodeModeIntegrations', () => {
  it('surfaces Telegram send guidance from list_integrations without a top-level tool', async () => {
    const orgStub = {
      getWorkspaceIntegrations: vi.fn(async () => [
        {
          id: 'telegram_direct',
          integration_type: 'telegram',
          name: 'Miguel Telegram',
          category: 'communication',
          auth_method: 'api_key',
          config: JSON.stringify({
            status: 'active',
            chat_id: '12345',
            chat_title: 'Miguel',
          }),
          credentials_encrypted: '',
          created_by: 'user_1',
          created_at: 1,
          updated_at: 1,
          deleted_at: null,
          token_expires_at: null,
          auth_status: 'connected',
          auth_error_code: null,
          auth_error_message: null,
          auth_checked_at: null,
          reauth_required_at: null,
        },
      ]),
      getWorkspaceIntegration: vi.fn(),
      createWorkspaceIntegration: vi.fn(),
      updateWorkspaceIntegration: vi.fn(),
    } as unknown as ConstructorParameters<typeof CodeModeIntegrations>[0]['orgStub'];
    const { integrations } = integrationsHarness({ orgStub });

    await expect(integrations.list({ category: 'communication' })).resolves.toMatchObject({
      count: 1,
      integrations: [
        {
          id: 'telegram_direct',
          type: 'telegram',
          recommended_access: {
            tool: 'js_exec',
            call_pattern: 'await tools.send_telegram_message({ integration_id: "telegram_direct", text: "..." })',
            routing: expect.stringContaining('Default Telegram recipient is configured'),
            recommended_actions: [
              {
                name: 'send_telegram_message',
                tool: 'tools.send_telegram_message',
                usage: 'await tools.send_telegram_message({ integration_id: "telegram_direct", text: "..." })',
                routing: expect.stringContaining('Default Telegram recipient is configured'),
              },
            ],
          },
        },
      ],
    });
  });

  it('surfaces only the bounded native Discord send action', async () => {
    const orgStub = {
      getWorkspaceIntegrations: vi.fn(async () => [
        {
          id: 'discord_support',
          integration_type: 'discord_channel',
          name: 'Support Discord',
          category: 'communication',
          auth_method: 'oauth2',
          config: JSON.stringify({
            schema_version: 1,
            status: 'active',
            application_id: 'app-1',
            guild_id: 'guild-1',
            guild_name: 'Camel',
            parent_channel_id: 'channel-1',
            parent_channel_name: 'support',
            binding_version: 1,
            message_content_mode: 'full',
          }),
          credentials_encrypted: 'encrypted-empty-object',
          created_by: 'user_1',
          created_at: 1,
          updated_at: 1,
          deleted_at: null,
          token_expires_at: null,
          auth_status: 'connected',
          auth_error_code: null,
          auth_error_message: null,
          auth_checked_at: null,
          reauth_required_at: null,
        },
      ]),
      getWorkspaceIntegration: vi.fn(),
      createWorkspaceIntegration: vi.fn(),
      updateWorkspaceIntegration: vi.fn(),
    } as unknown as ConstructorParameters<typeof CodeModeIntegrations>[0]['orgStub'];
    const { integrations } = integrationsHarness({ orgStub });

    await expect(integrations.list({ category: 'communication' })).resolves.toMatchObject({
      count: 1,
      integrations: [
        {
          id: 'discord_support',
          type: 'discord_channel',
          recommended_access: {
            tool: 'js_exec',
            call_pattern: 'await tools.send_discord_message({ integration_id: "discord_support", text: "..." })',
            routing: expect.stringContaining('configured Discord channel'),
            recommended_actions: [
              {
                name: 'send_discord_message',
                tool: 'tools.send_discord_message',
              },
            ],
          },
        },
      ],
    });
  });

  it('advertises the universal remote MCP driver and contract', async () => {
    const { integrations } = integrationsHarness();

    const result = await integrations.listTypes({}) as {
      by_category: Record<string, Array<Record<string, unknown>>>;
    };
    const remoteMcp = Object.values(result.by_category)
      .flat()
      .find((type) => type.type === 'remote_mcp');

    expect(remoteMcp).toMatchObject({
      connection_kind: 'remote_mcp',
      supports_native_mcp_connection: true,
      supports_brokered_mcp_tools: true,
      capabilities: ['mcp_tools'],
      verification: { strategy: 'mcp_discovery', live: true },
    });
    expect(remoteMcp?.setup_hint).toContain('native remote MCP servers');
  });

  it('only advertises Discord when the environment can actually start OAuth', async () => {
    const disabled = await integrationsHarness().integrations.listTypes({}) as {
      by_category: Record<string, Array<Record<string, unknown>>>;
    };
    expect(Object.values(disabled.by_category).flat().map((type) => type.type))
      .not.toContain('discord_channel');

    const enabled = integrationsHarness({
      env: {
        INTEGRATION_SECRET_KEY: 'test-secret',
        DISCORD_CHANNEL_ENABLED: 'true',
        DISCORD_CLIENT_ID: '123456789012345678',
        DISCORD_CLIENT_SECRET: 'test-discord-client-secret-value',
        DISCORD_BRIDGE: {
          fetch: vi.fn(async () => Response.json({
            ok: true,
            applicationId: '123456789012345678',
            botUserId: '123456789012345678',
            readiness: { ready: false, reason: 'ingress_disabled' },
            gateway: {
              state: 'ready',
              heartbeatIntervalMs: 45_000,
              lastHeartbeatAckAt: Date.now(),
            },
          })),
        } as never,
      },
    }).integrations.listTypes({}) as Promise<{
      by_category: Record<string, Array<Record<string, unknown>>>;
    }>;
    const enabledCatalog = await enabled;
    expect(Object.values(enabledCatalog.by_category).flat().map((type) => type.type))
      .toContain('discord_channel');
  });

  it('rejects a direct Discord setup prompt while its environment is unavailable', async () => {
    const { integrations, promptConnectionSetup } = integrationsHarness();

    await expect(integrations.promptConnectionSetup({
      integration_type: 'discord_channel',
      suggested_name: 'Support Discord',
    })).resolves.toEqual({
      success: false,
      error: 'Discord channel connections are not available in this environment.',
    });
    expect(promptConnectionSetup).not.toHaveBeenCalled();
  });

  it('passes initial config and credentials into chat connection setup prompts', async () => {
    const { integrations, promptConnectionSetup } = integrationsHarness();

    await integrations.promptConnectionSetup({
      integration_type: 'remote_mcp',
      suggested_name: 'Docs MCP',
      config: { server_url: 'https://mcp.example.com/mcp', auth_type: 'bearer' },
      credentials: { token: 'secret-token' },
    });

    expect(promptConnectionSetup).toHaveBeenCalledWith(expect.objectContaining({
      integrationType: 'remote_mcp',
      initialConfig: { server_url: 'https://mcp.example.com/mcp', auth_type: 'bearer' },
      initialCredentials: { token: 'secret-token' },
    }));
  });

  it('prefills existing connection config and updates it during chat reauth', async () => {
    const { integrations, promptConnectionSetup, updateIntegration } = integrationsHarness({
      promptConnectionSetup: vi.fn(async () => ({
        requestId: 'req_1',
        cancelled: false,
        integration: {
          type: 'remote_mcp',
          name: 'Docs MCP',
          config: { server_url: 'https://mcp.example.com/mcp', auth_type: 'bearer' },
          credentials: { token: 'new-token' },
        },
      })),
    });

    await expect(integrations.promptConnectionSetup({
      integration_id: 'docs_mcp',
      integration_type: 'remote_mcp',
    })).resolves.toMatchObject({
      success: true,
      integration: { id: 'docs_mcp', type: 'remote_mcp' },
    });

    expect(promptConnectionSetup).toHaveBeenCalledWith(expect.objectContaining({
      integrationId: 'docs_mcp',
      initialConfig: { server_url: 'https://old.example.com/mcp', auth_type: 'bearer' },
    }));
    expect(updateIntegration).toHaveBeenCalledWith(
      'workspace_1',
      'docs_mcp',
      expect.objectContaining({
        config: JSON.stringify({ server_url: 'https://mcp.example.com/mcp', auth_type: 'bearer' }),
        credentialsEncrypted: expect.any(String),
      }),
      'user_1',
    );
  });

  it('preserves existing credentials when chat reauth submits no replacement secrets', async () => {
    const { integrations, updateIntegration } = integrationsHarness({
      promptConnectionSetup: vi.fn(async () => ({
        requestId: 'req_1',
        cancelled: false,
        integration: {
          type: 'remote_mcp',
          name: 'Docs MCP',
          config: { server_url: 'https://mcp.example.com/mcp', auth_type: 'bearer' },
          credentials: {},
        },
      })),
    });

    await expect(integrations.promptConnectionSetup({
      integration_id: 'docs_mcp',
      integration_type: 'remote_mcp',
    })).resolves.toMatchObject({
      success: true,
      integration: { id: 'docs_mcp', type: 'remote_mcp' },
    });

    expect(updateIntegration).toHaveBeenCalledWith(
      'workspace_1',
      'docs_mcp',
      expect.not.objectContaining({
        credentialsEncrypted: expect.any(String),
      }),
      'user_1',
    );
  });

  it('keeps existing credentials while returning OAuth URL for existing remote MCP authorization', async () => {
    const { integrations, updateIntegration } = integrationsHarness({
      promptConnectionSetup: vi.fn(async () => ({
        requestId: 'req_1',
        cancelled: false,
        integration: {
          type: 'remote_mcp',
          name: 'Docs MCP',
          config: { server_url: 'https://mcp.example.com/mcp', auth_type: 'oauth' },
          credentials: {},
        },
      })),
    });

    await expect(integrations.promptConnectionSetup({
      integration_id: 'docs_mcp',
      integration_type: 'remote_mcp',
    })).resolves.toMatchObject({
      success: true,
      oauth_url: expect.stringContaining('/api/integrations/remote_mcp/oauth?'),
    });

    expect(updateIntegration).toHaveBeenCalledWith(
      'workspace_1',
      'docs_mcp',
      expect.not.objectContaining({
        credentialsEncrypted: expect.any(String),
      }),
      'user_1',
    );
  });

  it('validates and stores remote MCP token credentials created from chat', async () => {
    const { createIntegration, integrations } = integrationsHarness();

    await expect(integrations.create({
      integration_type: 'remote_mcp',
      name: 'Docs MCP',
      config: { server_url: 'https://mcp.example.com/mcp#ignored', auth_type: 'bearer' },
      credentials: { token: 'secret-token' },
    })).resolves.toMatchObject({ success: true });

    expect(createIntegration).toHaveBeenCalledTimes(1);
    const [, , integrationType, , , , configJson, credentialsEncrypted] = createIntegration.mock.calls[0];
    expect(integrationType).toBe('remote_mcp');
    expect(JSON.parse(configJson)).toMatchObject({
      server_url: 'https://mcp.example.com/mcp',
      auth_type: 'bearer',
    });
    await expect(decryptCredentials(credentialsEncrypted, 'test-secret')).resolves.toEqual({
      token: 'secret-token',
    });
  });

  it('returns an OAuth URL for remote MCP OAuth connections', async () => {
    const { integrations } = integrationsHarness();

    await expect(integrations.create({
      integration_type: 'remote_mcp',
      name: 'OAuth MCP',
      config: { server_url: 'https://mcp.example.com/mcp', auth_type: 'oauth' },
      credentials: {},
    })).resolves.toMatchObject({
      success: true,
      oauth_url: expect.stringContaining('/api/integrations/remote_mcp/oauth?'),
    });
  });
});
