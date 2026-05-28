import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getEnvMock = vi.fn();

vi.mock('@/lib/cloudflare.server', () => ({
  getEnv: getEnvMock,
}));

vi.mock('@/lib/thread-title-generation.server', () => ({
  generateThreadTitleWithOpenAI: vi.fn(),
}));

const { createThread, getThread, getWorkspaceModelPickerState } = await import(
  '@/lib/chat-do.server'
);

describe('getWorkspaceModelPickerState rollout compatibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('falls back to default picker configs when new DO RPCs are unavailable', async () => {
    const workspaceStub = {
      getInfo: vi.fn().mockResolvedValue({ org_id: 'org_123' }),
      getModelPickerConfig: vi.fn().mockRejectedValue(
        new Error('No such RPC method getModelPickerConfig'),
      ),
    };
    const orgStub = {
      getLlmProviderConfig: vi.fn().mockResolvedValue(null),
      getExperimentalSettings: vi
        .fn()
        .mockResolvedValue({ claude_proxy_models: false }),
      getModelPickerConfig: vi.fn().mockRejectedValue(
        new Error('No such RPC method getModelPickerConfig'),
      ),
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
});
