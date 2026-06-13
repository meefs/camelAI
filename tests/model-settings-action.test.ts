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

const { action, loader } = await import('@/routes/_app.settings.organization.models');

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

function loaderRequest(search = '') {
  return new Request(`https://camelai.com/settings/organization/models${search}`);
}

function providerRecord(provider: string, config = '{}') {
  return {
    provider,
    credentials_encrypted: 'encrypted',
    config,
    created_by: 'user_123',
    created_at: 1,
    updated_at: 1,
  };
}

function mockAuthContext(
  overrides: Record<string, unknown> = {},
) {
  requireAuthContextMock.mockResolvedValue({
    currentOrg: { id: 'org_123' },
    currentOrgLlmProviderConfig: null,
    currentOrgExperimentalSettings: {
      claude_proxy_models: false,
    },
    user: { id: 'user_123' },
    ...overrides,
  });
}

describe('organization model settings actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext();
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
        avatar: { color: 'blue', content: 'W' },
      },
    ]);
    orgGetModelPickerConfigMock.mockResolvedValue({
      use_platform_defaults: true,
      models: [],
      default_model: null,
    });
    orgGetLlmProviderConfigMock.mockRejectedValue(
      new Error('unexpected provider config read'),
    );
    orgGetExperimentalSettingsMock.mockRejectedValue(
      new Error('unexpected experimental settings read'),
    );
    workspaceGetModelPickerConfigMock.mockResolvedValue({
      use_org_defaults: true,
      use_platform_defaults: true,
      models: [],
      default_model: null,
    });
    workspaceSetModelPickerConfigMock.mockImplementation(async (config) => config);
  });

  it('seeds workspace picker overrides from org config when disabling org defaults', async () => {
    orgGetModelPickerConfigMock.mockResolvedValue({
      use_platform_defaults: false,
      models: [
        { id: 'sonnet', added_at: 20 },
        { id: 'gpt-5.4', added_at: 10 },
      ],
      default_model: 'sonnet',
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
      {
        use_org_defaults: false,
        use_platform_defaults: false,
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
      use_platform_defaults: false,
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
    mockAuthContext({
      currentOrgLlmProviderConfig: providerRecord('openai'),
    });
    workspaceGetModelPickerConfigMock.mockResolvedValue({
      use_org_defaults: false,
      use_platform_defaults: false,
      models: [{ id: 'gpt-5.4', added_at: 10 }],
      default_model: 'gpt-5.4',
    });

    const response = await action({
      request: formRequest({
        intent: 'addModel',
        model: 'deepseek-v4-pro',
      }),
      context: {},
      params: {},
    } as never);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'DeepSeek V4 Pro is not available for this provider',
    });
    expect(workspaceSetModelPickerConfigMock).not.toHaveBeenCalled();
  });

  it('rejects adding retired Gemini 3.1 Pro Preview as a new picker model', async () => {
    workspaceGetModelPickerConfigMock.mockResolvedValue({
      use_org_defaults: false,
      use_platform_defaults: false,
      models: [{ id: 'gpt-5.4', added_at: 10 }],
      default_model: 'gpt-5.4',
    });

    const response = await action({
      request: formRequest({
        intent: 'addModel',
        model: 'gemini-3.1-pro-preview',
      }),
      context: {},
      params: {},
    } as never);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'A valid model is required',
    });
    expect(workspaceSetModelPickerConfigMock).not.toHaveBeenCalled();
  });

  it('materializes platform defaults when adding a model to an old stored list', async () => {
    mockAuthContext({
      currentOrgLlmProviderConfig: providerRecord('openai'),
    });
    workspaceGetModelPickerConfigMock.mockResolvedValue({
      use_org_defaults: false,
      models: [
        { id: 'opus-4.8', added_at: 100 },
        { id: 'sonnet', added_at: 99 },
        { id: 'gpt-5.5', added_at: 98 },
        { id: 'gpt-5.4-mini', added_at: 97 },
        { id: 'gemini-3.5-flash', added_at: 96 },
        { id: 'gemini-3-flash-preview', added_at: 95 },
        { id: 'deepseek-v4-pro', added_at: 94 },
        { id: 'deepseek-v4-flash', added_at: 93 },
        { id: 'kimi-k2.6', added_at: 92 },
        { id: 'grok-4.3', added_at: 91 },
      ],
      default_model: 'sonnet',
    });

    const response = await action({
      request: formRequest({
        intent: 'addModel',
        model: 'gpt-5.4',
      }),
      context: {},
      params: {},
    } as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      message: 'Added GPT-5.4 to picker',
    });
    expect(workspaceSetModelPickerConfigMock).toHaveBeenCalledWith(
      {
        use_org_defaults: false,
        use_platform_defaults: false,
        models: [
          { id: 'gpt-5.5', added_at: expect.any(Number) },
          { id: 'gpt-5.4', added_at: expect.any(Number) },
          { id: 'gpt-5.4-mini', added_at: expect.any(Number) },
        ],
        default_model: null,
      },
      {
        actorId: 'user_123',
        details: {
          intent: 'addModel',
          model: 'gpt-5.4',
        },
      },
    );
  });

  it('removing a model from platform defaults creates a custom override list', async () => {
    mockAuthContext({
      currentOrgLlmProviderConfig: providerRecord('openai'),
    });
    workspaceGetModelPickerConfigMock.mockResolvedValue({
      use_org_defaults: false,
      use_platform_defaults: true,
      models: [],
      default_model: null,
    });

    const response = await action({
      request: formRequest({
        intent: 'removeModel',
        model: 'gpt-5.4',
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
        use_platform_defaults: false,
        models: [
          { id: 'gpt-5.5', added_at: expect.any(Number) },
          { id: 'gpt-5.4-mini', added_at: expect.any(Number) },
        ],
        default_model: null,
      },
      {
        actorId: 'user_123',
        details: {
          intent: 'removeModel',
          model: 'gpt-5.4',
        },
      },
    );
  });

  it('removes models from an explicit custom override list', async () => {
    mockAuthContext({
      currentOrgLlmProviderConfig: providerRecord('openai'),
    });
    workspaceGetModelPickerConfigMock.mockResolvedValue({
      use_org_defaults: false,
      use_platform_defaults: false,
      models: [
        { id: 'gpt-5.5', added_at: 20 },
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

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
    });
    expect(workspaceSetModelPickerConfigMock).toHaveBeenCalledWith(
      {
        use_org_defaults: false,
        use_platform_defaults: false,
        models: [
          { id: 'gpt-5.5', added_at: 20 },
        ],
        default_model: null,
      },
      {
        actorId: 'user_123',
        details: {
          intent: 'removeModel',
          model: 'gpt-5.4',
        },
      },
    );
  });
});

describe('organization model settings loader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext({
      currentOrgLlmProviderConfig: providerRecord('openai'),
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
        avatar: { color: 'blue', content: 'W' },
      },
    ]);
    orgGetLlmProviderConfigMock.mockRejectedValue(
      new Error('unexpected provider config read'),
    );
    orgGetExperimentalSettingsMock.mockRejectedValue(
      new Error('unexpected experimental settings read'),
    );
    workspaceGetModelPickerConfigMock.mockResolvedValue({
      use_org_defaults: true,
      models: [],
      default_model: null,
    });
  });

  it('hides provider-incompatible additional models for OpenAI BYOK orgs', async () => {
    orgGetModelPickerConfigMock.mockResolvedValue({
      models: [
        { id: 'gpt-5.5', added_at: 30 },
        { id: 'gpt-5.4', added_at: 20 },
        { id: 'gpt-5.4-mini', added_at: 10 },
      ],
      default_model: 'gpt-5.4',
    });

    const result = await loader({
      request: loaderRequest(),
      context: {},
      params: {},
    } as never);

    expect(result.config.inPicker.map((row) => row.entry.id)).toEqual([
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini',
    ]);
    expect(result.config.additional).toEqual([]);
    expect(result.config.capacity.used).toBe(3);
  });

  it('shows the synthetic custom model for custom providers with a model id', async () => {
    mockAuthContext({
      currentOrgLlmProviderConfig: providerRecord(
        'custom',
        JSON.stringify({ custom_model_id: 'pi-custom-model' }),
      ),
    });
    orgGetModelPickerConfigMock.mockResolvedValue({
      models: [{ id: 'custom', added_at: 30 }],
      default_model: 'custom',
    });

    const result = await loader({
      request: loaderRequest(),
      context: {},
      params: {},
    } as never);

    expect(result.config.inPicker.map((row) => row.entry.id)).toEqual([
      'custom',
    ]);
    expect(result.config.additional).toEqual([]);
    expect(result.config.capacity).toEqual({ used: 1, max: 1 });
  });

  it('appends new visible picker models after switching to OpenAI BYOK', async () => {
    orgGetModelPickerConfigMock.mockResolvedValue({
      models: [
        { id: 'sonnet', added_at: 50 },
        { id: 'gpt-5.5', added_at: 40 },
        { id: 'deepseek-v4-pro', added_at: 30 },
        { id: 'gpt-5.4-mini', added_at: 20 },
      ],
      default_model: 'sonnet',
    });

    const result = await loader({
      request: loaderRequest(),
      context: {},
      params: {},
    } as never);

    expect(result.config.inPicker.map((row) => row.entry.id)).toEqual([
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini',
    ]);
    expect(result.config.additional).toEqual([]);
    expect(result.config.capacity.used).toBe(3);
  });

  it('shows only Claude-family models for Anthropic BYOK orgs', async () => {
    mockAuthContext({
      currentOrgLlmProviderConfig: providerRecord('anthropic'),
    });
    orgGetModelPickerConfigMock.mockResolvedValue({
      models: [
        { id: 'gpt-5.5', added_at: 60 },
        { id: 'haiku', added_at: 50 },
        { id: 'sonnet', added_at: 40 },
        { id: 'opus-4.8', added_at: 30 },
        { id: 'deepseek-v4-flash', added_at: 10 },
      ],
      default_model: 'gpt-5.5',
    });

    const result = await loader({
      request: loaderRequest(),
      context: {},
      params: {},
    } as never);

    expect(result.config.inPicker.map((row) => row.entry.id)).toEqual([
      'opus-4.8',
      'sonnet',
      'haiku',
    ]);
    expect(result.config.additional).toEqual([]);
    expect(result.config.capacity.used).toBe(3);
  });
});
