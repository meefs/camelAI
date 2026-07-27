import { beforeEach, describe, expect, it, vi } from 'vitest';

const requireAuthContextMock = vi.fn();
const requireOrgAdminMock = vi.fn();
const getAuthEnvMock = vi.fn();
const getEnvMock = vi.fn();
const listOrgWorkspacesMock = vi.fn();
const orgGetModelPickerConfigMock = vi.fn();
const orgSetModelPickerConfigMock = vi.fn();
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

function formRequest(
  fields: Record<string, string>,
  search = '?scope=ws&workspaceId=ws_123',
) {
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    formData.set(key, value);
  }
  return new Request(
    `https://camelai.com/settings/organization/models${search}`,
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
          setModelPickerConfig: orgSetModelPickerConfigMock,
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
    orgSetModelPickerConfigMock.mockImplementation(async (config) => config);
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

  it('seeds frozen workspace picker overrides from platform defaults when disabling org defaults', async () => {
    mockAuthContext({
      currentOrgLlmProviderConfig: providerRecord('openai'),
    });
    orgGetModelPickerConfigMock.mockResolvedValue({
      use_platform_defaults: true,
      models: [],
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
      {
        use_org_defaults: false,
        use_platform_defaults: false,
        models: [
          { id: 'deepseek-v4-auto', added_at: expect.any(Number) },
          { id: 'gpt-5.6-sol', added_at: expect.any(Number) },
          { id: 'gpt-5.6-terra', added_at: expect.any(Number) },
          { id: 'gpt-5.6-luna', added_at: expect.any(Number) },
        ],
        default_model: null,
      },
      {
        actorId: 'user_123',
        details: {
          intent: 'setUseOrgDefaults',
          workspace_id: 'ws_123',
          use_org_defaults: false,
          restored_retained_list: false,
          seeded_from_org_defaults: true,
        },
      },
    );
  });

  it('does not seed retained platform-default org defaults into workspace custom snapshots', async () => {
    mockAuthContext({
      currentOrgLlmProviderConfig: providerRecord('openai'),
    });
    orgGetModelPickerConfigMock.mockResolvedValue({
      use_platform_defaults: true,
      models: [
        { id: 'gpt-5.4', added_at: 20 },
      ],
      default_model: 'gpt-5.4',
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
          { id: 'deepseek-v4-auto', added_at: expect.any(Number) },
          { id: 'gpt-5.6-sol', added_at: expect.any(Number) },
          { id: 'gpt-5.6-terra', added_at: expect.any(Number) },
          { id: 'gpt-5.6-luna', added_at: expect.any(Number) },
        ],
        default_model: null,
      },
      {
        actorId: 'user_123',
        details: {
          intent: 'setUseOrgDefaults',
          workspace_id: 'ws_123',
          use_org_defaults: false,
          restored_retained_list: false,
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
        { id: 'gpt-5.5', added_at: 10 },
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

  it('retains org custom lists when switching to platform defaults', async () => {
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
        intent: 'setUsePlatformDefaults',
        usePlatformDefaults: 'true',
      }, ''),
      context: {},
      params: {},
    } as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
    });
    expect(orgSetModelPickerConfigMock).toHaveBeenCalledWith(
      {
        use_platform_defaults: true,
        models: [
          { id: 'sonnet', added_at: 20 },
          { id: 'gpt-5.4', added_at: 10 },
        ],
        default_model: 'sonnet',
      },
      {
        actorId: 'user_123',
        details: {
          intent: 'setUsePlatformDefaults',
          use_platform_defaults: true,
        },
      },
    );
  });

  it('retains provider-hidden custom rows when switching to platform defaults', async () => {
    orgGetLlmProviderConfigMock.mockResolvedValue({ provider: 'openai' });
    orgGetModelPickerConfigMock.mockResolvedValue({
      use_platform_defaults: false,
      models: [
        { id: 'sonnet', added_at: 20 },
        { id: 'gpt-5.5', added_at: 10 },
      ],
      default_model: 'sonnet',
    });

    const response = await action({
      request: formRequest({
        intent: 'setUsePlatformDefaults',
        usePlatformDefaults: 'true',
      }, ''),
      context: {},
      params: {},
    } as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
    });
    expect(orgSetModelPickerConfigMock).toHaveBeenCalledWith(
      {
        use_platform_defaults: true,
        models: [
          { id: 'sonnet', added_at: 20 },
          { id: 'gpt-5.5', added_at: 10 },
        ],
        default_model: 'sonnet',
      },
      expect.anything(),
    );
  });

  it('restores retained org custom lists when switching off platform defaults', async () => {
    orgGetModelPickerConfigMock.mockResolvedValue({
      use_platform_defaults: true,
      models: [
        { id: 'sonnet', added_at: 20 },
        { id: 'gpt-5.4', added_at: 10 },
      ],
      default_model: 'sonnet',
    });

    const response = await action({
      request: formRequest({
        intent: 'setUsePlatformDefaults',
        usePlatformDefaults: 'false',
      }, ''),
      context: {},
      params: {},
    } as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
    });
    expect(orgSetModelPickerConfigMock).toHaveBeenCalledWith(
      {
        use_platform_defaults: false,
        models: [
          { id: 'sonnet', added_at: 20 },
        ],
        default_model: 'sonnet',
      },
      {
        actorId: 'user_123',
        details: {
          intent: 'setUsePlatformDefaults',
          use_platform_defaults: false,
        },
      },
    );
  });

  it('restores retained workspace custom lists when disabling org defaults', async () => {
    workspaceGetModelPickerConfigMock.mockResolvedValue({
      use_org_defaults: true,
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
        ],
        default_model: 'sonnet',
      },
      {
        actorId: 'user_123',
        details: {
          intent: 'setUseOrgDefaults',
          workspace_id: 'ws_123',
          use_org_defaults: false,
          restored_retained_list: true,
          seeded_from_org_defaults: false,
        },
      },
    );
  });

  it('falls back to a fresh workspace snapshot when retained models are no longer visible', async () => {
    mockAuthContext({
      currentOrgLlmProviderConfig: providerRecord('openai'),
    });
    workspaceGetModelPickerConfigMock.mockResolvedValue({
      use_org_defaults: true,
      use_platform_defaults: false,
      models: [
        { id: 'sonnet', added_at: 20 },
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
          { id: 'deepseek-v4-auto', added_at: expect.any(Number) },
          { id: 'gpt-5.6-sol', added_at: expect.any(Number) },
          { id: 'gpt-5.6-terra', added_at: expect.any(Number) },
          { id: 'gpt-5.6-luna', added_at: expect.any(Number) },
        ],
        default_model: null,
      },
      {
        actorId: 'user_123',
        details: {
          intent: 'setUseOrgDefaults',
          workspace_id: 'ws_123',
          use_org_defaults: false,
          restored_retained_list: false,
          seeded_from_org_defaults: true,
        },
      },
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
        { id: 'grok-4.5', added_at: 91 },
      ],
      default_model: 'sonnet',
    });

    const response = await action({
      request: formRequest({
        intent: 'addModel',
        model: 'gpt-5.6-sol',
      }),
      context: {},
      params: {},
    } as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      message: 'Added GPT-5.6 Sol to picker',
    });
    expect(workspaceSetModelPickerConfigMock).toHaveBeenCalledWith(
      {
        use_org_defaults: false,
        use_platform_defaults: false,
        models: [
          { id: 'deepseek-v4-auto', added_at: expect.any(Number) },
          { id: 'gpt-5.6-sol', added_at: expect.any(Number) },
          { id: 'gpt-5.6-terra', added_at: expect.any(Number) },
          { id: 'gpt-5.6-luna', added_at: expect.any(Number) },
        ],
        default_model: null,
      },
      {
        actorId: 'user_123',
        details: {
          intent: 'addModel',
          model: 'gpt-5.6-sol',
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
        model: 'gpt-5.6-sol',
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
          { id: 'deepseek-v4-auto', added_at: expect.any(Number) },
          { id: 'gpt-5.6-terra', added_at: expect.any(Number) },
          { id: 'gpt-5.6-luna', added_at: expect.any(Number) },
        ],
        default_model: null,
      },
      {
        actorId: 'user_123',
        details: {
          intent: 'removeModel',
          model: 'gpt-5.6-sol',
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
        { id: 'gpt-5.6-luna', added_at: 20 },
        { id: 'gpt-5.6-terra', added_at: 10 },
      ],
      default_model: 'gpt-5.6-terra',
    });

    const response = await action({
      request: formRequest({
        intent: 'removeModel',
        model: 'gpt-5.6-terra',
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
          { id: 'gpt-5.6-luna', added_at: 20 },
        ],
        default_model: null,
      },
      {
        actorId: 'user_123',
        details: {
          intent: 'removeModel',
          model: 'gpt-5.6-terra',
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
        { id: 'gpt-5.6-sol', added_at: 40 },
        { id: 'gpt-5.6-terra', added_at: 35 },
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
      'deepseek-v4-auto',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
    ]);
    expect(result.config.additional).toEqual([]);
    expect(result.config.capacity.used).toBe(4);
  });

  it('does not mark retained defaults as active in platform-default settings', async () => {
    orgGetModelPickerConfigMock.mockResolvedValue({
      use_platform_defaults: true,
      models: [
        { id: 'gpt-5.5', added_at: 20 },
      ],
      default_model: 'gpt-5.5',
    });

    const result = await loader({
      request: loaderRequest(),
      context: {},
      params: {},
    } as never);

    expect(result.config.usePlatformDefaults).toBe(true);
    expect(result.config.inPicker.some((row) => row.entry.id === 'gpt-5.6-terra')).toBe(true);
    expect(result.config.inPicker.every((row) => row.isDefault === false)).toBe(true);
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
        { id: 'gpt-5.6-sol', added_at: 45 },
        { id: 'gpt-5.6-terra', added_at: 42 },
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
      'deepseek-v4-auto',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
    ]);
    expect(result.config.additional).toEqual([]);
    expect(result.config.capacity.used).toBe(4);
  });

  it('shows all provider-compatible Claude-family models for Anthropic BYOK orgs', async () => {
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
      'deepseek-v4-auto',
      'opus-4.8',
      'fable-5',
      'sonnet',
      'haiku',
    ]);
    expect(result.config.additional).toEqual([]);
    expect(result.config.capacity.used).toBe(5);
  });
});
