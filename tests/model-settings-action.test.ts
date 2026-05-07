import { beforeEach, describe, expect, it, vi } from 'vitest';

const requireAuthContextMock = vi.fn();
const requireOrgAdminMock = vi.fn();
const getAuthEnvMock = vi.fn();
const getEnvMock = vi.fn();
const listOrgWorkspacesMock = vi.fn();
const orgGetModelPickerConfigMock = vi.fn();
const orgGetLlmProviderConfigMock = vi.fn();
const orgGetExperimentalSettingsMock = vi.fn();
const workspaceGetModelPickerConfigMock = vi.fn();
const workspaceSetModelPickerConfigMock = vi.fn();

vi.mock('@/lib/auth.server', () => ({
  requireAuthContext: requireAuthContextMock,
  requireOrgAdmin: requireOrgAdminMock,
  getAuthEnv: getAuthEnvMock,
}));

vi.mock('@/lib/cloudflare.server', () => ({
  getEnv: getEnvMock,
}));

vi.mock('@/lib/auth-do', () => ({
  listOrgWorkspaces: listOrgWorkspacesMock,
}));

const { action } = await import('@/routes/_app.settings.organization.models');

function formRequest(fields: Record<string, string>) {
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    formData.set(key, value);
  }
  return new Request(
    'https://camelai.com/settings/organization/models?scope=ws&workspaceId=ws_123',
    {
      method: 'POST',
      body: formData,
    },
  );
}

describe('organization model settings actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireAuthContextMock.mockResolvedValue({
      currentOrg: { id: 'org_123' },
      user: { id: 'user_123' },
    });
    requireOrgAdminMock.mockResolvedValue(undefined);
    getEnvMock.mockReturnValue({});
    getAuthEnvMock.mockReturnValue({
      ORG: {
        idFromName: (id: string) => id,
        get: () => ({
          getModelPickerConfig: orgGetModelPickerConfigMock,
          getLlmProviderConfig: orgGetLlmProviderConfigMock,
          getExperimentalSettings: orgGetExperimentalSettingsMock,
        }),
      },
      WORKSPACE: {
        idFromName: (id: string) => id,
        get: () => ({
          getModelPickerConfig: workspaceGetModelPickerConfigMock,
          setModelPickerConfig: workspaceSetModelPickerConfigMock,
        }),
      },
    });
    listOrgWorkspacesMock.mockResolvedValue([
      {
        id: 'ws_123',
        name: 'Workspace',
        avatar: { color: 'blue' },
      },
    ]);
    orgGetModelPickerConfigMock.mockResolvedValue({
      models: [
        { id: 'sonnet', added_at: 20 },
        { id: 'gpt-5.4', added_at: 10 },
      ],
      default_model: 'sonnet',
    });
    orgGetLlmProviderConfigMock.mockResolvedValue(null);
    orgGetExperimentalSettingsMock.mockResolvedValue({
      claude_proxy_models: false,
    });
    workspaceGetModelPickerConfigMock.mockResolvedValue({
      use_org_defaults: true,
      models: [],
      default_model: null,
    });
    workspaceSetModelPickerConfigMock.mockImplementation(async (config) => config);
  });

  it('seeds workspace picker overrides from org config when disabling org defaults', async () => {
    const response = await action({
      request: formRequest({
        intent: 'setUseOrgDefaults',
        useOrgDefaults: 'false',
      }),
      context: {},
      params: {},
    } as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
    });
    expect(workspaceSetModelPickerConfigMock).toHaveBeenCalledWith(
      {
        use_org_defaults: false,
        models: [
          { id: 'sonnet', added_at: 20 },
          { id: 'gpt-5.4', added_at: 10 },
        ],
        default_model: 'sonnet',
      },
      {
        actorId: 'user_123',
        details: {
          intent: 'setUseOrgDefaults',
          workspace_id: 'ws_123',
          use_org_defaults: false,
          seeded_from_org_defaults: true,
        },
      },
    );
  });

  it('preserves a null org default when seeding workspace overrides', async () => {
    orgGetModelPickerConfigMock.mockResolvedValue({
      models: [
        { id: 'sonnet', added_at: 20 },
        { id: 'gpt-5.4', added_at: 10 },
      ],
      default_model: null,
    });

    const response = await action({
      request: formRequest({
        intent: 'setUseOrgDefaults',
        useOrgDefaults: 'false',
      }),
      context: {},
      params: {},
    } as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
    });
    expect(workspaceSetModelPickerConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        use_org_defaults: false,
        default_model: null,
      }),
      expect.anything(),
    );
  });

  it('rejects adding a model that is incompatible with the org provider', async () => {
    orgGetLlmProviderConfigMock.mockResolvedValue({ provider: 'openai' });
    workspaceGetModelPickerConfigMock.mockResolvedValue({
      use_org_defaults: false,
      models: [{ id: 'gpt-5.4', added_at: 10 }],
      default_model: 'gpt-5.4',
    });

    const response = await action({
      request: formRequest({
        intent: 'addModel',
        model: 'kimi-k2.6',
      }),
      context: {},
      params: {},
    } as never);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'Kimi K2.6 is not available for this provider',
    });
    expect(workspaceSetModelPickerConfigMock).not.toHaveBeenCalled();
  });

  it('allows removing hidden models even when no visible models remain', async () => {
    orgGetLlmProviderConfigMock.mockResolvedValue({ provider: 'openai' });
    workspaceGetModelPickerConfigMock.mockResolvedValue({
      use_org_defaults: false,
      models: [
        { id: 'sonnet', added_at: 20 },
        { id: 'opus', added_at: 10 },
      ],
      default_model: 'sonnet',
    });

    const response = await action({
      request: formRequest({
        intent: 'removeModel',
        model: 'sonnet',
      }),
      context: {},
      params: {},
    } as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
    });
    expect(workspaceSetModelPickerConfigMock).toHaveBeenCalledWith(
      {
        use_org_defaults: false,
        models: [{ id: 'opus', added_at: 10 }],
        default_model: null,
      },
      {
        actorId: 'user_123',
        details: {
          intent: 'removeModel',
          model: 'sonnet',
        },
      },
    );
  });

  it('rejects removing the last visible model while hidden models remain', async () => {
    orgGetLlmProviderConfigMock.mockResolvedValue({ provider: 'openai' });
    workspaceGetModelPickerConfigMock.mockResolvedValue({
      use_org_defaults: false,
      models: [
        { id: 'sonnet', added_at: 20 },
        { id: 'gpt-5.4', added_at: 10 },
      ],
      default_model: 'gpt-5.4',
    });

    const response = await action({
      request: formRequest({
        intent: 'removeModel',
        model: 'gpt-5.4',
      }),
      context: {},
      params: {},
    } as never);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error:
        'Picker must include at least one model available for this provider, or be empty.',
    });
    expect(workspaceSetModelPickerConfigMock).not.toHaveBeenCalled();
  });
});
