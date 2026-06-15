import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getEnvMock = vi.fn();

vi.mock('@/lib/cloudflare.server', () => ({
  getEnv: getEnvMock,
}));

vi.mock('@/lib/thread-title-generation.server', () => ({
  generateThreadTitleWithOpenAI: vi.fn(),
}));

const {
  createThread,
  createThreadWithValidatedAccess,
  deleteThread,
  getThread,
  getWorkspaceModelPickerState,
  updateThread,
  updateThreadModel,
} = await import('@/lib/chat-do.server');

describe('getWorkspaceModelPickerState rollout compatibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fails when model picker config RPCs are missing', async () => {
    const error = new Error('No such RPC method getModelPickerConfig');
    const workspaceStub = {
      getInfo: vi.fn().mockResolvedValue({ org_id: 'org_123' }),
      getModelPickerConfig: vi.fn().mockRejectedValue(error),
    };
    const orgStub = {
      getLlmProviderConfig: vi.fn().mockResolvedValue(null),
      getExperimentalSettings: vi
        .fn()
        .mockResolvedValue({ claude_proxy_models: false }),
      getModelPickerConfig: vi.fn().mockResolvedValue({
        use_platform_defaults: true,
        models: [],
        default_model: null,
      }),
    };

    getEnvMock.mockReturnValue({
      WORKSPACE: {
        idFromName: (id: string) => id,
        get: () => workspaceStub,
      },
      ORG: {
        idFromName: (id: string) => id,
        get: () => orgStub,
      },
    });

    await expect(getWorkspaceModelPickerState({}, 'ws_123')).rejects.toBe(
      error,
    );
  });

  it('retries transient model picker config RPC failures', async () => {
    const workspaceStub = {
      getInfo: vi.fn().mockResolvedValue({ org_id: 'org_123' }),
      getModelPickerConfig: vi
        .fn()
        .mockRejectedValueOnce(
          new Error('Durable Object reset because its code was updated.'),
        )
        .mockResolvedValueOnce({
          use_org_defaults: true,
          models: [],
          default_model: null,
        }),
    };
    const orgStub = {
      getLlmProviderConfig: vi.fn().mockResolvedValue(null),
      getExperimentalSettings: vi
        .fn()
        .mockResolvedValue({ claude_proxy_models: false }),
      getModelPickerConfig: vi
        .fn()
        .mockRejectedValueOnce(
          new Error('Durable Object reset because its code was updated.'),
        )
        .mockResolvedValueOnce({
          use_platform_defaults: true,
          models: [],
          default_model: null,
        }),
    };

    getEnvMock.mockReturnValue({
      WORKSPACE: {
        idFromName: (id: string) => id,
        get: () => workspaceStub,
      },
      ORG: {
        idFromName: (id: string) => id,
        get: () => orgStub,
      },
    });

    const state = await getWorkspaceModelPickerState({}, 'ws_123');
    expect(state).toMatchObject({
      orgId: 'org_123',
      llmProvider: null,
      effectivePickerDefaultModel: null,
      hasEffectivePickerDefault: false,
      defaultModel: 'sonnet',
    });
    expect(state?.allowedThreadModels).toContain('sonnet');
    expect(state?.allowedThreadModels).toContain('gpt-5.5');
    expect(state?.allowedThreadModels).toContain('gpt-5.4-mini');
    expect(orgStub.getModelPickerConfig).toHaveBeenCalledTimes(2);
    expect(workspaceStub.getModelPickerConfig).toHaveBeenCalledTimes(2);
  });

  it('rethrows picker config errors other than missing RPC rollout errors', async () => {
    const storageError = new Error('storage temporarily unavailable');
    const workspaceStub = {
      getInfo: vi.fn().mockResolvedValue({ org_id: 'org_123' }),
      getModelPickerConfig: vi.fn().mockResolvedValue({
        use_org_defaults: true,
        models: [],
        default_model: null,
      }),
    };
    const orgStub = {
      getLlmProviderConfig: vi.fn().mockResolvedValue(null),
      getExperimentalSettings: vi
        .fn()
        .mockResolvedValue({ claude_proxy_models: false }),
      getModelPickerConfig: vi.fn().mockRejectedValue(storageError),
    };

    getEnvMock.mockReturnValue({
      WORKSPACE: {
        idFromName: (id: string) => id,
        get: () => workspaceStub,
      },
      ORG: {
        idFromName: (id: string) => id,
        get: () => orgStub,
      },
    });

    await expect(getWorkspaceModelPickerState({}, 'ws_123')).rejects.toThrow(
      storageError,
    );
  });

  it('treats a null requested model as the picker default when creating a thread', async () => {
    const workspaceStub = {
      getInfo: vi.fn().mockResolvedValue({ org_id: 'org_123' }),
      getModelPickerConfig: vi.fn().mockResolvedValue({
        use_org_defaults: true,
        models: [],
        default_model: null,
      }),
    };
    const orgStub = {
      getLlmProviderConfig: vi.fn().mockResolvedValue(null),
      getExperimentalSettings: vi
        .fn()
        .mockResolvedValue({ claude_proxy_models: false }),
      getModelPickerConfig: vi.fn().mockResolvedValue({
        use_platform_defaults: false,
        models: [{ id: 'sonnet', added_at: 1 }],
        default_model: 'sonnet',
      }),
      createThread: vi.fn().mockResolvedValue({
        id: 'thread_123',
        workspace_id: 'ws_123',
        title: 'New Chat',
        created_by: 'user_123',
        model: 'sonnet',
        created_at: 1,
        updated_at: 2,
        user_message_count: 0,
        first_user_message: null,
      }),
    };

    getEnvMock.mockReturnValue({
      WORKSPACE: {
        idFromName: (id: string) => id,
        get: () => workspaceStub,
      },
      ORG: {
        idFromName: (id: string) => id,
        get: () => orgStub,
      },
    });

    await expect(
      createThread({}, 'ws_123', 'New Chat', 'user_123', undefined, null),
    ).resolves.toMatchObject({ id: 'thread_123', model: 'sonnet' });
    expect(orgStub.createThread).toHaveBeenCalledWith(
      'ws_123',
      'New Chat',
      'user_123',
      undefined,
      'sonnet',
    );
  });

  it('ignores retained picker defaults while platform defaults are active', async () => {
    const workspaceStub = {
      getInfo: vi.fn().mockResolvedValue({ org_id: 'org_123' }),
      getModelPickerConfig: vi.fn().mockResolvedValue({
        use_org_defaults: true,
        use_platform_defaults: true,
        models: [],
        default_model: null,
      }),
    };
    const orgStub = {
      getLlmProviderConfig: vi.fn().mockResolvedValue(null),
      getExperimentalSettings: vi
        .fn()
        .mockResolvedValue({ claude_proxy_models: false }),
      getModelPickerConfig: vi.fn().mockResolvedValue({
        use_platform_defaults: true,
        models: [
          { id: 'gpt-5.4', added_at: 1 },
        ],
        default_model: 'gpt-5.4',
      }),
    };

    getEnvMock.mockReturnValue({
      WORKSPACE: {
        idFromName: (id: string) => id,
        get: () => workspaceStub,
      },
      ORG: {
        idFromName: (id: string) => id,
        get: () => orgStub,
      },
    });

    const state = await getWorkspaceModelPickerState({}, 'ws_123');

    expect(state).toMatchObject({
      effectivePickerDefaultModel: null,
      hasEffectivePickerDefault: false,
      defaultModel: 'sonnet',
    });
  });

  it('applies model picker validation on the validated-access create fast path', async () => {
    const workspaceStub = {
      getModelPickerConfig: vi.fn().mockResolvedValue({
        use_org_defaults: true,
        models: [],
        default_model: null,
      }),
    };
    const orgStub = {
      getLlmProviderConfig: vi.fn().mockResolvedValue(null),
      getExperimentalSettings: vi
        .fn()
        .mockResolvedValue({ claude_proxy_models: false }),
      getModelPickerConfig: vi.fn().mockResolvedValue({
        use_platform_defaults: false,
        models: [{ id: 'sonnet', added_at: 1 }],
        default_model: 'sonnet',
      }),
      createThread: vi.fn(),
    };

    getEnvMock.mockReturnValue({
      WORKSPACE: {
        idFromName: (id: string) => id,
        get: () => workspaceStub,
      },
      ORG: {
        idFromName: (id: string) => id,
        get: () => orgStub,
      },
    });

    await expect(
      createThreadWithValidatedAccess(
        {},
        'org_123',
        'ws_123',
        'New Chat',
        'user_123',
        'hello',
        'gpt-5.4-mini',
      ),
    ).rejects.toThrow('Invalid thread model');
    expect(orgStub.createThread).not.toHaveBeenCalled();
  });

  it('normalizes Fable to Sonnet for new threads after retirement', async () => {
    const workspaceStub = {
      getInfo: vi.fn().mockResolvedValue({ org_id: 'org_123' }),
      getModelPickerConfig: vi.fn().mockResolvedValue({
        use_org_defaults: true,
        models: [],
        default_model: null,
      }),
    };
    const orgStub = {
      getLlmProviderConfig: vi.fn().mockResolvedValue(null),
      getExperimentalSettings: vi
        .fn()
        .mockResolvedValue({ claude_proxy_models: false }),
      getModelPickerConfig: vi.fn().mockResolvedValue({
        models: [
          { id: 'opus-4.8', added_at: 10 },
          { id: 'sonnet', added_at: 9 },
          { id: 'gpt-5.5', added_at: 8 },
          { id: 'gpt-5.4-mini', added_at: 7 },
          { id: 'gemini-3.5-flash', added_at: 6 },
          { id: 'gemini-3-flash-preview', added_at: 5 },
          { id: 'deepseek-v4-pro', added_at: 4 },
          { id: 'deepseek-v4-flash', added_at: 3 },
          { id: 'kimi-k2.6', added_at: 2 },
          { id: 'grok-4.3', added_at: 1 },
        ],
        default_model: null,
      }),
      createThread: vi.fn().mockResolvedValue({
        id: 'thread_123',
        workspace_id: 'ws_123',
        title: 'New Chat',
        created_by: 'user_123',
        model: 'sonnet',
        created_at: 1,
        updated_at: 2,
        user_message_count: 0,
        first_user_message: null,
      }),
    };

    getEnvMock.mockReturnValue({
      WORKSPACE: {
        idFromName: (id: string) => id,
        get: () => workspaceStub,
      },
      ORG: {
        idFromName: (id: string) => id,
        get: () => orgStub,
      },
    });

    const state = await getWorkspaceModelPickerState({}, 'ws_123');
    expect(state?.allowedThreadModels).not.toContain('fable-5');
    expect(state?.allowedThreadModels[0]).toBe('opus-4.8');
    expect(state?.allowedThreadModels).toContain('opus-4.8');

    await expect(
      createThread({}, 'ws_123', 'New Chat', 'user_123', undefined, 'fable-5'),
    ).resolves.toMatchObject({ id: 'thread_123', model: 'sonnet' });
    expect(orgStub.createThread).toHaveBeenCalledWith(
      'ws_123',
      'New Chat',
      'user_123',
      undefined,
      'sonnet',
    );
  });

  it('rejects switching an existing thread to Fable after retirement', async () => {
    const workspaceStub = {
      getInfo: vi.fn().mockResolvedValue({ org_id: 'org_123' }),
      getModelPickerConfig: vi.fn().mockResolvedValue({
        use_org_defaults: true,
        models: [],
        default_model: null,
      }),
    };
    const orgStub = {
      getLlmProviderConfig: vi.fn().mockResolvedValue(null),
      getExperimentalSettings: vi
        .fn()
        .mockResolvedValue({ claude_proxy_models: false }),
      getModelPickerConfig: vi.fn().mockResolvedValue({
        models: [
          { id: 'opus-4.8', added_at: 10 },
          { id: 'sonnet', added_at: 9 },
          { id: 'gpt-5.5', added_at: 8 },
          { id: 'gpt-5.4-mini', added_at: 7 },
          { id: 'gemini-3.5-flash', added_at: 6 },
          { id: 'gemini-3-flash-preview', added_at: 5 },
          { id: 'deepseek-v4-pro', added_at: 4 },
          { id: 'deepseek-v4-flash', added_at: 3 },
          { id: 'kimi-k2.6', added_at: 2 },
          { id: 'grok-4.3', added_at: 1 },
        ],
        default_model: null,
      }),
      getThread: vi.fn().mockResolvedValue({
        id: 'thread_123',
        workspace_id: 'ws_123',
        title: 'Existing Chat',
        created_by: 'user_123',
        model: 'sonnet',
        created_at: 1,
        updated_at: 2,
        user_message_count: 0,
        first_user_message: null,
      }),
      updateThreadModel: vi.fn().mockResolvedValue({
        id: 'thread_123',
        workspace_id: 'ws_123',
        title: 'Existing Chat',
        created_by: 'user_123',
        model: 'sonnet',
        created_at: 1,
        updated_at: 3,
        user_message_count: 0,
        first_user_message: null,
      }),
    };

    getEnvMock.mockReturnValue({
      WORKSPACE: {
        idFromName: (id: string) => id,
        get: () => workspaceStub,
      },
      ORG: {
        idFromName: (id: string) => id,
        get: () => orgStub,
      },
    });

    await expect(
      updateThreadModel({}, 'thread_123', 'fable-5' as never, 'ws_123'),
    ).rejects.toThrow('Invalid thread model');
    expect(orgStub.updateThreadModel).not.toHaveBeenCalled();
  });

  it('normalizes legacy stored thread models and ignores legacy providers before returning them to React', async () => {
    const workspaceStub = {
      getInfo: vi.fn().mockResolvedValue({ org_id: 'org_123' }),
    };
    const orgStub = {
      getThread: vi.fn().mockResolvedValue({
        id: 'thread_123',
        workspace_id: 'ws_123',
        title: 'Legacy Gemini thread',
        created_by: 'user_123',
        provider: 'claude',
        model: 'gemini-3.1-pro-preview',
        created_at: 1,
        updated_at: 2,
        user_message_count: 0,
        first_user_message: null,
      }),
    };

    getEnvMock.mockReturnValue({
      WORKSPACE: {
        idFromName: (id: string) => id,
        get: () => workspaceStub,
      },
      ORG: {
        idFromName: (id: string) => id,
        get: () => orgStub,
      },
    });

    const thread = await getThread({}, 'thread_123', 'ws_123');

    expect(thread?.model).toBe('gemini-3.5-flash');
  });

  it('uses preloaded org model context without rereading workspace info or org provider settings', async () => {
    const workspaceStub = {
      getInfo: vi.fn(async () => {
        throw new Error('unexpected workspace info read');
      }),
      getModelPickerConfig: vi.fn().mockResolvedValue({
        use_org_defaults: true,
        models: [],
        default_model: null,
      }),
    };
    const orgStub = {
      getLlmProviderConfig: vi.fn(async () => {
        throw new Error('unexpected provider config read');
      }),
      getExperimentalSettings: vi.fn(async () => {
        throw new Error('unexpected experimental settings read');
      }),
      getModelPickerConfig: vi.fn().mockResolvedValue({
        use_platform_defaults: true,
        models: [],
        default_model: null,
      }),
    };

    getEnvMock.mockReturnValue({
      WORKSPACE: {
        idFromName: (id: string) => id,
        get: () => workspaceStub,
      },
      ORG: {
        idFromName: (id: string) => id,
        get: () => orgStub,
      },
    });

    const state = await getWorkspaceModelPickerState({}, 'ws_123', {
      orgId: 'org_123',
      llmProviderConfig: {
        provider: 'openai',
        credentials_encrypted: 'encrypted',
        config: '{}',
        created_by: 'user_123',
        created_at: 1,
        updated_at: 1,
      },
      experimentalSettings: { claude_proxy_models: false },
    });

    expect(workspaceStub.getInfo).not.toHaveBeenCalled();
    expect(orgStub.getLlmProviderConfig).not.toHaveBeenCalled();
    expect(orgStub.getExperimentalSettings).not.toHaveBeenCalled();
    expect(state?.orgId).toBe('org_123');
    expect(state?.llmProvider).toBe('openai');
    expect(state?.allowedThreadModels).toContain('gpt-5.4');
  });

  it('uses preloaded org model context for thread model updates', async () => {
    const workspaceStub = {
      getInfo: vi.fn(async () => {
        throw new Error('unexpected workspace info read');
      }),
      getModelPickerConfig: vi.fn().mockResolvedValue({
        use_org_defaults: true,
        models: [],
        default_model: null,
      }),
    };
    const orgStub = {
      getThread: vi.fn().mockResolvedValue({
        id: 'thread_123',
        workspace_id: 'ws_123',
        title: 'Existing Chat',
        created_by: 'user_123',
        model: 'sonnet',
        created_at: 1,
        updated_at: 2,
        user_message_count: 0,
        first_user_message: null,
      }),
      getLlmProviderConfig: vi.fn(async () => {
        throw new Error('unexpected provider config read');
      }),
      getExperimentalSettings: vi.fn(async () => {
        throw new Error('unexpected experimental settings read');
      }),
      getModelPickerConfig: vi.fn().mockResolvedValue({
        use_platform_defaults: false,
        models: [{ id: 'gpt-5.4', added_at: 1 }],
        default_model: 'gpt-5.4',
      }),
      updateThreadModel: vi.fn().mockResolvedValue({
        id: 'thread_123',
        workspace_id: 'ws_123',
        title: 'Existing Chat',
        created_by: 'user_123',
        model: 'gpt-5.4',
        created_at: 1,
        updated_at: 3,
        user_message_count: 0,
        first_user_message: null,
      }),
    };

    getEnvMock.mockReturnValue({
      WORKSPACE: {
        idFromName: (id: string) => id,
        get: () => workspaceStub,
      },
      ORG: {
        idFromName: (id: string) => id,
        get: () => orgStub,
      },
    });

    const updated = await updateThreadModel(
      {},
      'thread_123',
      'gpt-5.4',
      'ws_123',
      {
        orgId: 'org_123',
        llmProviderConfig: {
          provider: 'openai',
          credentials_encrypted: 'encrypted',
          config: '{}',
          created_by: 'user_123',
          created_at: 1,
          updated_at: 1,
        },
        experimentalSettings: { claude_proxy_models: false },
      },
    );

    expect(workspaceStub.getInfo).not.toHaveBeenCalled();
    expect(orgStub.getLlmProviderConfig).not.toHaveBeenCalled();
    expect(orgStub.getExperimentalSettings).not.toHaveBeenCalled();
    expect(orgStub.updateThreadModel).toHaveBeenCalledWith(
      'thread_123',
      'gpt-5.4',
    );
    expect(updated?.model).toBe('gpt-5.4');
  });

  it('uses a known org id for thread reads without loading workspace info', async () => {
    const workspaceStub = {
      getInfo: vi.fn(async () => {
        throw new Error('unexpected workspace info read');
      }),
    };
    const orgStub = {
      getThread: vi.fn().mockResolvedValue({
        id: 'thread_123',
        workspace_id: 'ws_123',
        title: 'Thread',
        created_by: 'user_123',
        model: 'sonnet',
        created_at: 1,
        updated_at: 2,
        user_message_count: 0,
        first_user_message: null,
      }),
    };

    getEnvMock.mockReturnValue({
      WORKSPACE: {
        idFromName: (id: string) => id,
        get: () => workspaceStub,
      },
      ORG: {
        idFromName: (id: string) => id,
        get: () => orgStub,
      },
    });

    const thread = await getThread({}, 'thread_123', 'ws_123', {
      orgId: 'org_123',
    });

    expect(workspaceStub.getInfo).not.toHaveBeenCalled();
    expect(orgStub.getThread).toHaveBeenCalledWith('thread_123');
    expect(thread?.id).toBe('thread_123');
  });

  it('still rejects known-org thread reads for the wrong workspace', async () => {
    const workspaceStub = {
      getInfo: vi.fn(async () => {
        throw new Error('unexpected workspace info read');
      }),
    };
    const orgStub = {
      getThread: vi.fn().mockResolvedValue({
        id: 'thread_123',
        workspace_id: 'ws_other',
        title: 'Thread',
        created_by: 'user_123',
        model: 'sonnet',
        created_at: 1,
        updated_at: 2,
        user_message_count: 0,
        first_user_message: null,
      }),
      updateThread: vi.fn(),
      deleteThread: vi.fn(),
    };

    getEnvMock.mockReturnValue({
      WORKSPACE: {
        idFromName: (id: string) => id,
        get: () => workspaceStub,
      },
      ORG: {
        idFromName: (id: string) => id,
        get: () => orgStub,
      },
    });

    await expect(
      getThread({}, 'thread_123', 'ws_123', { orgId: 'org_123' }),
    ).resolves.toBeNull();
    await expect(
      updateThread({}, 'thread_123', 'Title', 'ws_123', { orgId: 'org_123' }),
    ).resolves.toBeNull();
    await expect(
      deleteThread({}, 'thread_123', 'ws_123', { orgId: 'org_123' }),
    ).resolves.toBe(false);

    expect(workspaceStub.getInfo).not.toHaveBeenCalled();
    expect(orgStub.updateThread).not.toHaveBeenCalled();
    expect(orgStub.deleteThread).not.toHaveBeenCalled();
  });
});
