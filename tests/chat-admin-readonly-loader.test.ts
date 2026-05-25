import { beforeEach, describe, expect, it, vi } from 'vitest';

const requireSuperuserMock = vi.fn();
const requireAuthContextMock = vi.fn();
const requireSessionWorkspaceAccessMock = vi.fn();
const getAuthEnvMock = vi.fn();
const getEnvMock = vi.fn();
const adminGetThreadContextByIdMock = vi.fn();
const getThreadMock = vi.fn();
const getThreadPreviewStateMock = vi.fn();
const getTodoStateMock = vi.fn();
const getWorkspaceModelPickerStateMock = vi.fn();
const getOrgMock = vi.fn();
const getWorkerScriptMock = vi.fn();
const readThreadMessagesMock = vi.fn();
const ensureGroupForThreadMock = vi.fn();
const getGroupForWorkspaceMock = vi.fn();
const listGroupsForMoveMock = vi.fn();

vi.mock('@/lib/auth.server', () => ({
  requireSuperuser: requireSuperuserMock,
  requireAuthContext: requireAuthContextMock,
  requireSessionWorkspaceAccess: requireSessionWorkspaceAccessMock,
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
  getTodoState: getTodoStateMock,
  getWorkspaceModelPickerState: getWorkspaceModelPickerStateMock,
}));

vi.mock('@/lib/auth-do', () => ({
  getOrg: getOrgMock,
  getWorkerScript: getWorkerScriptMock,
}));

vi.mock('@/lib/chat-history.server', () => ({
  readThreadMessages: readThreadMessagesMock,
}));

vi.mock('@/lib/chat-groups.server', () => ({
  ensureGroupForThread: ensureGroupForThreadMock,
  getGroupForWorkspace: getGroupForWorkspaceMock,
  listGroupsForMove: listGroupsForMoveMock,
}));

const { loader, shouldRevalidate } = await import('@/routes/_app.chat.$id');

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
    getAuthEnvMock.mockReturnValue({
      ORG: {
        idFromName: (id: string) => id,
        get: () => ({
          getThread: async () => null,
          getInfo: async () => ({ id: 'org_active', slug: 'acme' }),
        }),
      },
    });
    getThreadPreviewStateMock.mockResolvedValue({
      target: null,
      tabs: [],
      activeTabId: null,
      version: 0,
    });
    getTodoStateMock.mockResolvedValue([]);
    getWorkspaceModelPickerStateMock.mockResolvedValue({
      llmProvider: null,
      experimentalSettings: { claude_proxy_models: false },
      allowedThreadModels: ['sonnet'],
      effectivePickerDefaultModel: 'sonnet',
      hasEffectivePickerDefault: true,
      defaultModel: 'sonnet',
    });
    getWorkerScriptMock.mockResolvedValue(null);
    readThreadMessagesMock.mockResolvedValue([]);
    ensureGroupForThreadMock.mockResolvedValue(null);
    getGroupForWorkspaceMock.mockResolvedValue(null);
    listGroupsForMoveMock.mockResolvedValue([]);
  });

  it('route shouldRevalidate preserves explicit same-thread same-URL revalidation', () => {
    const shouldRunLoader = shouldRevalidate({
      currentUrl: new URL('https://camelai.com/chat/thread_123?group=group_1'),
      nextUrl: new URL('https://camelai.com/chat/thread_123?group=group_1'),
      currentParams: { id: 'thread_123' },
      nextParams: { id: 'thread_123' },
      defaultShouldRevalidate: true,
    });

    expect(shouldRunLoader).toBe(true);
    expect(readThreadMessagesMock).not.toHaveBeenCalled();
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

    expect(result.chatData).toEqual({
      messages: [],
      messagesError: null,
      todos: [],
      previewTabs: [],
      activeTabId: null,
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
    getTodoStateMock.mockResolvedValue([]);
    requireSessionWorkspaceAccessMock.mockResolvedValue({
      orgId: 'org_active',
      workspaceId: 'ws_active',
      userId: 'user_123',
      access: 'full',
    });
    getWorkspaceModelPickerStateMock.mockResolvedValue({
      llmProvider: null,
      experimentalSettings: { claude_proxy_models: false },
      allowedThreadModels: ['sonnet'],
      effectivePickerDefaultModel: 'sonnet',
      hasEffectivePickerDefault: true,
      defaultModel: 'sonnet',
    });
    requireSessionWorkspaceAccessMock.mockResolvedValue({
      orgId: 'org_active',
      workspaceId: 'ws_active',
      userId: 'user_123',
      access: 'full',
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
    expect(result.chatData).toEqual({
      messages: [],
      messagesError: null,
      todos: [],
      previewTabs: [],
      activeTabId: null,
    });
  });

  it('loads messages for explicit same-thread revalidation and thread navigation', async () => {
    const context = {};
    requireAuthContextMock.mockResolvedValue({
      currentWorkspace: { id: 'ws_active' },
      currentOrg: { id: 'org_active', slug: 'acme' },
      orgs: [{ org_id: 'org_active', role: 'admin' }],
    });
    getThreadMock.mockImplementation(async (_context, threadId: string) => ({
      id: threadId,
      workspace_id: 'ws_active',
      title: `Thread ${threadId}`,
    }));

    await loader({
      request: new Request('https://camelai.com/chat/thread_123'),
      context,
      params: { id: 'thread_123' },
    } as never);
    expect(readThreadMessagesMock).toHaveBeenCalledTimes(1);

    readThreadMessagesMock.mockClear();
    const sameThreadShouldRevalidate = shouldRevalidate({
      currentUrl: new URL('https://camelai.com/chat/thread_123'),
      nextUrl: new URL('https://camelai.com/chat/thread_123'),
      currentParams: { id: 'thread_123' },
      nextParams: { id: 'thread_123' },
      defaultShouldRevalidate: true,
    });
    if (sameThreadShouldRevalidate) {
      await loader({
        request: new Request('https://camelai.com/chat/thread_123'),
        context,
        params: { id: 'thread_123' },
      } as never);
    }
    expect(readThreadMessagesMock).toHaveBeenCalledTimes(1);
    expect(readThreadMessagesMock).toHaveBeenCalledWith(context, {
      workspaceId: 'ws_active',
      orgId: 'org_active',
      threadId: 'thread_123',
      skipBanCheck: undefined,
    });
    readThreadMessagesMock.mockClear();

    const threadChangeShouldRevalidate = shouldRevalidate({
      currentUrl: new URL('https://camelai.com/chat/thread_123'),
      nextUrl: new URL('https://camelai.com/chat/thread_456'),
      currentParams: { id: 'thread_123' },
      nextParams: { id: 'thread_456' },
      defaultShouldRevalidate: false,
    });
    expect(threadChangeShouldRevalidate).toBe(true);

    await loader({
      request: new Request('https://camelai.com/chat/thread_456'),
      context,
      params: { id: 'thread_456' },
    } as never);

    expect(readThreadMessagesMock).toHaveBeenCalledWith(context, {
      workspaceId: 'ws_active',
      orgId: 'org_active',
      threadId: 'thread_456',
      skipBanCheck: undefined,
    });
  });

  it('loads todo state into chat data for existing threads', async () => {
    const context = {};
    const todos = [
      {
        content: 'Review results',
        status: 'in_progress',
        activeForm: 'Reviewing results',
      },
    ];
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
    getTodoStateMock.mockResolvedValue(todos);

    const result = await loader({
      request: new Request('https://camelai.com/chat/thread_123'),
      context,
      params: { id: 'thread_123' },
    } as never);

    expect(getTodoStateMock).toHaveBeenCalledWith(context, 'thread_123');
    expect(result.chatData.todos).toEqual(todos);
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
    getAuthEnvMock.mockReturnValue({
      ORG: {
        idFromName: (id: string) => id,
        get: () => ({
          getThread: async () => ({
            id: 'thread_123',
            workspace_id: 'ws_active',
            title: 'Workspace Thread',
            model: 'opus',
            user_message_count: 0,
          }),
          getInfo: async () => ({ id: 'org_active', slug: 'acme' }),
        }),
      },
    });

    const result = await loader({
      request: new Request('https://camelai.com/chat/thread_123?newThread=1'),
      context: {},
      params: { id: 'thread_123' },
    } as never);

    expect(result.readOnly).toBe(false);
    expect(result.isNewThread).toBe(true);
    expect(result.threadModel).toBe('opus');
    expect(result.allowedThreadModels).toEqual(['opus']);
    expect(result.isOrgAdmin).toBe(false);
    expect(result.recentModelScope).toEqual({
      orgId: 'org_active',
      workspaceId: 'ws_active',
    });
    expect(requireSessionWorkspaceAccessMock).toHaveBeenCalledTimes(1);
    expect(requireAuthContextMock).not.toHaveBeenCalled();
    expect(getThreadMock).not.toHaveBeenCalled();
    expect(ensureGroupForThreadMock).toHaveBeenCalledWith(
      {},
      {
        userId: 'user_123',
        orgId: 'org_active',
        workspaceId: 'ws_active',
        threadId: 'thread_123',
        fallbackName: 'Workspace Thread',
      },
    );
  });

  it('loads in-flight Pi messages for new-thread navigations', async () => {
    const inFlightUserMessage = {
      id: 'pi_user_1_0',
      thread_id: 'thread_123',
      role: 'user' as const,
      content: 'Build the thing',
      created_at: 1,
    };
    readThreadMessagesMock.mockResolvedValueOnce([inFlightUserMessage]);
    getAuthEnvMock.mockReturnValue({
      ORG: {
        idFromName: (id: string) => id,
        get: () => ({
          getThread: async () => ({
            id: 'thread_123',
            workspace_id: 'ws_active',
            title: 'Workspace Thread',
            model: 'opus',
            user_message_count: 0,
          }),
          getInfo: async () => ({ id: 'org_active', slug: 'acme' }),
        }),
      },
    });

    const result = await loader({
      request: new Request('https://camelai.com/chat/thread_123?newThread=1'),
      context: {},
      params: { id: 'thread_123' },
    } as never);

    expect(result.isNewThread).toBe(true);
    expect(result.chatData.messages).toEqual([inFlightUserMessage]);
    expect(readThreadMessagesMock).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        orgId: 'org_active',
        workspaceId: 'ws_active',
        threadId: 'thread_123',
      }),
    );
  });

  it('returns minimal model state for OpenAI-only new-thread navigations', async () => {
    getAuthEnvMock.mockReturnValue({
      ORG: {
        idFromName: (id: string) => id,
        get: () => ({
          getThread: async () => ({
            id: 'thread_123',
            workspace_id: 'ws_active',
            title: 'Workspace Thread',
            model: 'gpt-5.4-mini',
            user_message_count: 0,
          }),
          getInfo: async () => ({ id: 'org_active', slug: 'acme' }),
        }),
      },
    });

    const result = await loader({
      request: new Request('https://camelai.com/chat/thread_123?newThread=1'),
      context: {},
      params: { id: 'thread_123' },
    } as never);

    expect(result.isNewThread).toBe(true);
    expect(result.threadModel).toBe('gpt-5.4-mini');
    expect(result.llmProvider).toBe(null);
    expect(result.allowedThreadModels).toEqual(['gpt-5.4-mini']);
    expect(result.allowedThreadModels).not.toContain('sonnet');
    expect(result.allowedThreadModels).not.toContain('opus');
    expect(result.effectivePickerDefaultModel).toBe(null);
    expect(result.hasEffectivePickerDefault).toBe(false);
    expect(result.isOrgAdmin).toBe(false);
    expect(getWorkspaceModelPickerStateMock).not.toHaveBeenCalled();
    expect(result.recentModelScope).toEqual({
      orgId: 'org_active',
      workspaceId: 'ws_active',
    });
    expect(result.chatData).toEqual({
      messages: [],
      messagesError: null,
      todos: [],
      previewTabs: [],
      activeTabId: null,
    });
  });
});
