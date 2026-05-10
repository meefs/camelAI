import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getEnvMock = vi.fn();

vi.mock('@/lib/cloudflare.server', () => ({
  getEnv: getEnvMock,
}));

vi.mock('@/lib/thread-title-generation.server', () => ({
  generateThreadTitleWithOpenAI: vi.fn(),
}));

const { getWorkspaceModelPickerState } = await import('@/lib/chat-do.server');

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
      provider: 'claude',
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
});
