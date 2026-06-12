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
        avatar: { color: 'blue', content: 'W' },
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

  it('drops hidden stored models before checking capacity when adding visible models', async () => {
    orgGetLlmProviderConfigMock.mockResolvedValue({ provider: 'openai' });
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
        models: [
          { id: 'gpt-5.4', added_at: expect.any(Number) },
          { id: 'gpt-5.5', added_at: 98 },
          { id: 'gpt-5.4-mini', added_at: 97 },
        ],
        default_model: 'gpt-5.5',
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
        models: [],
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

  it('allows removing the last visible model and drops hidden models', async () => {
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

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
    });
    expect(workspaceSetModelPickerConfigMock).toHaveBeenCalledWith(
      {
        use_org_defaults: false,
        models: [],
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
        avatar: { color: 'blue', content: 'W' },
      },
    ]);
    orgGetLlmProviderConfigMock.mockResolvedValue({ provider: 'openai' });
    orgGetExperimentalSettingsMock.mockResolvedValue({
      claude_proxy_models: false,
    });
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

  it('counts only visible picker models after switching to OpenAI BYOK', async () => {
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
      'gpt-5.4-mini',
    ]);
    expect(result.config.additional.map((entry) => entry.id)).toEqual([
      'gpt-5.4',
    ]);
    expect(result.config.capacity.used).toBe(2);
  });

  it('shows only Claude-family models for Anthropic BYOK orgs', async () => {
    orgGetLlmProviderConfigMock.mockResolvedValue({ provider: 'anthropic' });
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
    expect(result.config.additional.map((entry) => entry.id)).toEqual([
      'fable-5',
    ]);
    expect(result.config.capacity.used).toBe(3);
  });
});
