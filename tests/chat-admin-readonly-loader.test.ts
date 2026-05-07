import { beforeEach, describe, expect, it, vi } from 'vitest';

const requireSuperuserMock = vi.fn();
const requireAuthContextMock = vi.fn();
const getAuthEnvMock = vi.fn();
const getEnvMock = vi.fn();
const adminGetThreadContextByIdMock = vi.fn();
const getThreadMock = vi.fn();
const getThreadPreviewStateMock = vi.fn();
const getWorkspaceModelPickerStateMock = vi.fn();
const getOrgMock = vi.fn();
const getWorkerScriptMock = vi.fn();

vi.mock('@/lib/auth.server', () => ({
  requireSuperuser: requireSuperuserMock,
  requireAuthContext: requireAuthContextMock,
  getAuthEnv: getAuthEnvMock,
}));

vi.mock('@/lib/cloudflare.server', () => ({
  getEnv: getEnvMock,
}));

vi.mock('@/lib/auth-do.server', () => ({
  adminGetThreadContextById: adminGetThreadContextByIdMock,
}));

vi.mock('@/lib/chat-do.server', () => ({
  getThread: getThreadMock,
  getThreadPreviewState: getThreadPreviewStateMock,
  getWorkspaceModelPickerState: getWorkspaceModelPickerStateMock,
}));

vi.mock('@/lib/auth-do', () => ({
  getOrg: getOrgMock,
  getWorkerScript: getWorkerScriptMock,
}));

const { loader } = await import('@/routes/_app.chat.$id');

describe('chat loader admin readonly mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getEnvMock.mockReturnValue({
      WORKSPACE: {
        idFromName: (id: string) => id,
        get: () => ({
          getIntegrations: async () => [],
        }),
      },
    });
    getAuthEnvMock.mockReturnValue({});
    getThreadPreviewStateMock.mockResolvedValue({
      target: null,
      tabs: [],
      activeTabId: null,
      version: 0,
    });
    getWorkspaceModelPickerStateMock.mockResolvedValue({
      provider: 'claude',
      llmProvider: null,
      experimentalSettings: { claude_proxy_models: false },
      allowedThreadModels: ['sonnet'],
      effectivePickerDefaultModel: 'sonnet',
      hasEffectivePickerDefault: true,
      defaultModel: 'sonnet',
    });
    getWorkerScriptMock.mockResolvedValue(null);
  });

  it('requires superuser for adminReadonly mode', async () => {
    requireSuperuserMock.mockRejectedValue(
      new Response(null, { status: 302, headers: { Location: '/' } })
    );

    await expect(
      loader({
        request: new Request('https://camelai.com/chat/thread_123?adminReadonly=1'),
        context: {},
        params: { id: 'thread_123' },
      } as never)
    ).rejects.toBeInstanceOf(Response);

    expect(requireSuperuserMock).toHaveBeenCalledTimes(1);
    expect(requireAuthContextMock).not.toHaveBeenCalled();
  });

  it('returns read-only loader payload for superusers', async () => {
    requireSuperuserMock.mockResolvedValue({
      user: { is_superuser: true },
    });
    adminGetThreadContextByIdMock.mockResolvedValue({
      org_id: 'org_123',
      workspace_id: 'ws_123',
      title: 'Indexed Title',
    });
    getThreadMock.mockResolvedValue({
      title: 'Thread Title',
    });
    getOrgMock.mockResolvedValue({
      id: 'org_123',
      slug: 'acme',
    });

    const result = await loader({
      request: new Request('https://camelai.com/chat/thread_123?adminReadonly=1'),
      context: {},
      params: { id: 'thread_123' },
    } as never);

    expect(result.readOnly).toBe(true);
    expect(result.workspaceId).toBe('ws_123');
    expect(result.threadTitle).toBe('Thread Title');
    expect(result.orgSlug).toBe('acme');
    expect(requireAuthContextMock).not.toHaveBeenCalled();

    await expect(result.chatDataPromise).resolves.toEqual({
      messages: [],
      previewTabs: [],
      activeTabId: null,
      previewTarget: null,
    });
  });
});

describe('chat loader workspace mismatch handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getEnvMock.mockReturnValue({
      WORKSPACE: {
        idFromName: (id: string) => id,
        get: () => ({
          getIntegrations: async () => [],
        }),
      },
    });
    getAuthEnvMock.mockReturnValue({});
    getThreadPreviewStateMock.mockResolvedValue({
      target: null,
      tabs: [],
      activeTabId: null,
      version: 0,
    });
    getWorkspaceModelPickerStateMock.mockResolvedValue({
      provider: 'claude',
      llmProvider: null,
      experimentalSettings: { claude_proxy_models: false },
      allowedThreadModels: ['sonnet'],
      effectivePickerDefaultModel: 'sonnet',
      hasEffectivePickerDefault: true,
      defaultModel: 'sonnet',
    });
  });

  it('redirects to /chat when the thread is not in the active workspace', async () => {
    requireAuthContextMock.mockResolvedValue({
      currentWorkspace: { id: 'ws_active' },
      currentOrg: { id: 'org_active', slug: 'acme' },
      orgs: [{ org_id: 'org_active', role: 'admin' }],
    });
    getThreadMock.mockResolvedValue(null);

    await expect(
      loader({
        request: new Request('https://camelai.com/chat/thread_123'),
        context: {},
        params: { id: 'thread_123' },
      } as never)
    ).rejects.toSatisfy((response: unknown) => {
      return response instanceof Response
        && response.status === 302
        && response.headers.get('Location') === '/chat';
    });

    expect(getThreadMock).toHaveBeenCalledWith({}, 'thread_123', 'ws_active');
  });

  it('returns chat payload when the thread belongs to the active workspace', async () => {
    requireAuthContextMock.mockResolvedValue({
      currentWorkspace: { id: 'ws_active' },
      currentOrg: { id: 'org_active', slug: 'acme' },
      orgs: [{ org_id: 'org_active', role: 'admin' }],
    });
    getThreadMock.mockResolvedValue({
      id: 'thread_123',
      workspace_id: 'ws_active',
      title: 'Workspace Thread',
    });

    const result = await loader({
      request: new Request('https://camelai.com/chat/thread_123'),
      context: {},
      params: { id: 'thread_123' },
    } as never);

    expect(result.readOnly).toBe(false);
    expect(result.workspaceId).toBe('ws_active');
    expect(result.threadTitle).toBe('Workspace Thread');
    await expect(result.chatDataPromise).resolves.toEqual({
      messages: [],
      previewTabs: [],
      activeTabId: null,
      previewTarget: null,
    });
  });

  it('falls back to legacy visible models when picker state fails to load', async () => {
    requireAuthContextMock.mockResolvedValue({
      currentWorkspace: { id: 'ws_active' },
      currentOrg: { id: 'org_active', slug: 'acme' },
      orgs: [{ org_id: 'org_active', role: 'admin' }],
    });
    getThreadMock.mockResolvedValue({
      id: 'thread_123',
      workspace_id: 'ws_active',
      title: 'Workspace Thread',
      provider: 'claude',
      model: 'opus',
    });
    getWorkspaceModelPickerStateMock.mockRejectedValue(
      new Error('transient picker failure'),
    );
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    const result = await loader({
      request: new Request('https://camelai.com/chat/thread_123'),
      context: {},
      params: { id: 'thread_123' },
    } as never);

    expect(result.threadModel).toBe('opus');
    if (!Array.isArray(result.allowedThreadModels)) {
      throw new Error('Expected fallback allowedThreadModels to be an array');
    }
    expect(result.allowedThreadModels).toContain('opus');
    expect(result.allowedThreadModels).toContain('sonnet');
    expect(result.allowedThreadModels.length).toBeGreaterThan(0);
    consoleErrorSpy.mockRestore();
  });

  it('keeps the saved thread model for new-thread navigations', async () => {
    requireAuthContextMock.mockResolvedValue({
      currentWorkspace: { id: 'ws_active' },
      currentOrg: { id: 'org_active', slug: 'acme' },
      orgs: [{ org_id: 'org_active', role: 'admin' }],
    });
    getThreadMock.mockResolvedValue({
      id: 'thread_123',
      workspace_id: 'ws_active',
      title: 'Workspace Thread',
      model: 'opus',
    });

    const result = await loader({
      request: new Request('https://camelai.com/chat/thread_123?newThread=1'),
      context: {},
      params: { id: 'thread_123' },
    } as never);

    expect(result.readOnly).toBe(false);
    expect(result.isNewThread).toBe(true);
    expect(result.threadModel).toBe('opus');
    expect(result.allowedThreadModels).toEqual(['sonnet']);
    expect(result.isOrgAdmin).toBe(true);
    expect(result.recentModelScope).toEqual({
      orgId: 'org_active',
      workspaceId: 'ws_active',
    });
    expect(getThreadMock).toHaveBeenCalledWith({}, 'thread_123', 'ws_active');
  });

  it('returns picker policy state for OpenAI-only new-thread navigations', async () => {
    requireAuthContextMock.mockResolvedValue({
      currentWorkspace: { id: 'ws_active' },
      currentOrg: { id: 'org_active', slug: 'acme' },
      orgs: [{ org_id: 'org_active', role: 'owner' }],
    });
    getThreadMock.mockResolvedValue({
      id: 'thread_123',
      workspace_id: 'ws_active',
      title: 'Workspace Thread',
      provider: 'codex',
      model: 'gpt-5.4-mini',
    });
    getWorkspaceModelPickerStateMock.mockResolvedValue({
      provider: 'codex',
      llmProvider: 'openai',
      experimentalSettings: { claude_proxy_models: false },
      allowedThreadModels: ['gpt-5.4', 'gpt-5.4-mini'],
      effectivePickerDefaultModel: 'gpt-5.4',
      hasEffectivePickerDefault: true,
      defaultModel: 'gpt-5.4',
    });

    const result = await loader({
      request: new Request('https://camelai.com/chat/thread_123?newThread=1'),
      context: {},
      params: { id: 'thread_123' },
    } as never);

    expect(result.isNewThread).toBe(true);
    expect(result.threadProvider).toBe('codex');
    expect(result.threadModel).toBe('gpt-5.4-mini');
    expect(result.llmProvider).toBe('openai');
    expect(result.allowedThreadModels).toEqual(['gpt-5.4', 'gpt-5.4-mini']);
    expect(result.allowedThreadModels).not.toContain('sonnet');
    expect(result.allowedThreadModels).not.toContain('opus');
    expect(result.effectivePickerDefaultModel).toBe('gpt-5.4');
    expect(result.hasEffectivePickerDefault).toBe(true);
    expect(result.isOrgAdmin).toBe(true);
    expect(result.recentModelScope).toEqual({
      orgId: 'org_active',
      workspaceId: 'ws_active',
    });
    await expect(result.chatDataPromise).resolves.toEqual({
      messages: [],
      previewTabs: [],
      activeTabId: null,
      previewTarget: null,
    });
  });
});
