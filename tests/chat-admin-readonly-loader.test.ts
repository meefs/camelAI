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
const getUiMessagesMock = vi.fn();
const getWorkspaceModelPickerStateMock = vi.fn();
const getOrgMock = vi.fn();
const getWorkerScriptMock = vi.fn();
const listWorkspaceIntegrationRecordsMock = vi.fn();
const readThreadMessagesMock = vi.fn();
const ensureGroupForThreadMock = vi.fn();
const getGroupForWorkspaceMock = vi.fn();
const listGroupsForMoveMock = vi.fn();
const loadWorkspaceMentionSourcesMock = vi.fn();

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
  getUiMessages: getUiMessagesMock,
  getWorkspaceModelPickerState: getWorkspaceModelPickerStateMock,
}));

vi.mock('@/lib/auth-do', () => ({
  getOrg: getOrgMock,
  getWorkerScript: getWorkerScriptMock,
  listWorkspaceIntegrationRecords: listWorkspaceIntegrationRecordsMock,
}));

vi.mock('@/lib/chat-history.server', () => ({
  readThreadMessages: readThreadMessagesMock,
}));

vi.mock('@/lib/chat-groups.server', () => ({
  ensureGroupForThread: ensureGroupForThreadMock,
  getGroupForWorkspace: getGroupForWorkspaceMock,
  listGroupsForMove: listGroupsForMoveMock,
}));

vi.mock('@/lib/mention-sources.server', () => ({
  loadWorkspaceMentionSources: loadWorkspaceMentionSourcesMock,
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
    getUiMessagesMock.mockResolvedValue([]);
    getWorkspaceModelPickerStateMock.mockResolvedValue({
      llmProvider: null,
      experimentalSettings: { claude_proxy_models: false },
      allowedThreadModels: ['sonnet'],
      effectivePickerDefaultModel: 'sonnet',
      hasEffectivePickerDefault: true,
      defaultModel: 'sonnet',
    });
    getWorkerScriptMock.mockResolvedValue(null);
    listWorkspaceIntegrationRecordsMock.mockResolvedValue([]);
    readThreadMessagesMock.mockResolvedValue([]);
    ensureGroupForThreadMock.mockResolvedValue(null);
    getGroupForWorkspaceMock.mockResolvedValue(null);
    listGroupsForMoveMock.mockResolvedValue([]);
    loadWorkspaceMentionSourcesMock.mockResolvedValue({
      connections: [],
      projects: [],
    });
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

    expect(await result.chatData).toEqual({
      messages: [],
      messagesError: null,
      initialUiMessages: [],
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
    getUiMessagesMock.mockResolvedValue([]);
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

    expect(getThreadMock).toHaveBeenCalledWith({}, 'thread_123', 'ws_active', {
      orgId: 'org_active',
    });
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
    expect(await result.chatData).toEqual({
      messages: [],
      messagesError: null,
      initialUiMessages: [],
      todos: [],
      previewTabs: [],
      activeTabId: null,
    });
  });

  it('renders the first message from the thread record without reading the transcript for a pending first turn', async () => {
    requireAuthContextMock.mockResolvedValue({
      currentWorkspace: { id: 'ws_active' },
      currentOrg: { id: 'org_active', slug: 'acme' },
      orgs: [{ org_id: 'org_active', role: 'admin' }],
    });
    getThreadMock.mockResolvedValue({
      id: 'thread_123',
      workspace_id: 'ws_active',
      title: 'New Chat',
      model: 'sonnet',
      user_message_count: 0,
      first_user_message: 'Build an analytics dashboard',
    });

    const result = await loader({
      request: new Request('https://camelai.com/chat/thread_123?newThread=1'),
      context: {},
      params: { id: 'thread_123' },
    } as never);

    // The first message is rendered straight from the thread record...
    expect(await result.chatData).toEqual({
      messages: [
        expect.objectContaining({
          id: 'pending-first:thread_123',
          role: 'user',
          content: 'Build an analytics dashboard',
        }),
      ],
      messagesError: null,
      initialUiMessages: [],
      todos: [],
      previewTabs: [],
      activeTabId: null,
    });
    // ...so the cold ChatThreadDO is never read on this load.
    expect(readThreadMessagesMock).not.toHaveBeenCalled();
  });

  it('surfaces pendingFirstTurn from the warm thread record alone, so the agent working indicator shows without any cold ChatThreadDO read', async () => {
    // The agent "working" indicator is driven by the loader's pendingFirstTurn
    // flag (Chat.tsx feeds it into deriveIsAwaitingAssistant -> the global
    // assistant indicator). For a freshly-started new chat that flag must come
    // from the warm thread record only — every ChatThreadDO-backed read
    // (transcript, preview tabs, todos) boots the cold DO (~2s), and none of
    // them may run, or the indicator would be gated on that cold boot. This is
    // a deterministic stand-in for "the DO is still cold": we assert those
    // reads are simply never invoked on this path.
    requireAuthContextMock.mockResolvedValue({
      currentWorkspace: { id: 'ws_active' },
      currentOrg: { id: 'org_active', slug: 'acme' },
      orgs: [{ org_id: 'org_active', role: 'admin' }],
    });
    getThreadMock.mockResolvedValue({
      id: 'thread_123',
      workspace_id: 'ws_active',
      title: 'New Chat',
      model: 'sonnet',
      user_message_count: 0,
      first_user_message: 'Build an analytics dashboard',
    });

    const result = await loader({
      request: new Request('https://camelai.com/chat/thread_123?newThread=1'),
      context: {},
      params: { id: 'thread_123' },
    } as never);

    // The signal that lights up the working indicator is available immediately...
    expect(result.pendingFirstTurn).toBe(true);
    // ...with zero reads against the cold ChatThreadDO.
    expect(readThreadMessagesMock).not.toHaveBeenCalled();
    expect(getUiMessagesMock).not.toHaveBeenCalled();
    expect(getThreadPreviewStateMock).not.toHaveBeenCalled();
    expect(getTodoStateMock).not.toHaveBeenCalled();

    // And the optimistic first user message is present, giving the indicator a
    // trailing non-assistant message to await (deriveIsAwaitingAssistant).
    const chatData = await result.chatData;
    expect(chatData.messages).toEqual([
      expect.objectContaining({
        id: 'pending-first:thread_123',
        role: 'user',
        content: 'Build an analytics dashboard',
      }),
    ]);
  });

  it('does NOT take the pending-first-turn fast path without ?newThread=1 (e.g. an API-created thread)', async () => {
    // A thread created with a stored first_user_message + count 0 but no started
    // run (the workspaces chat-threads API does exactly this) must load normally:
    // read the render history, and not synthesize a pending-first message.
    requireAuthContextMock.mockResolvedValue({
      currentWorkspace: { id: 'ws_active' },
      currentOrg: { id: 'org_active', slug: 'acme' },
      orgs: [{ org_id: 'org_active', role: 'admin' }],
    });
    getThreadMock.mockResolvedValue({
      id: 'thread_123',
      workspace_id: 'ws_active',
      title: 'New Chat',
      model: 'sonnet',
      user_message_count: 0,
      first_user_message: 'Build an analytics dashboard',
    });
    readThreadMessagesMock.mockResolvedValue([]);

    const result = await loader({
      // No ?newThread=1 — not a freshly-started new chat.
      request: new Request('https://camelai.com/chat/thread_123'),
      context: {},
      params: { id: 'thread_123' },
    } as never);

    const chatData = await result.chatData;
    expect(chatData.messages).toEqual([]);
    expect(
      chatData.messages.some((m) => m.id === 'pending-first:thread_123'),
    ).toBe(false);
    expect(getUiMessagesMock).toHaveBeenCalled();
    // The legacy pi_core transcript read is admin-readonly only; a live load
    // makes exactly one transcript RPC (the ai-chat render history).
    expect(readThreadMessagesMock).not.toHaveBeenCalled();
  });

  it('does not block existing-thread navigation on chat data resolution', async () => {
    let resolveMessages: ((messages: []) => void) | undefined;
    const pendingMessages = new Promise<[]>((resolve) => {
      resolveMessages = resolve;
    });
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
    getUiMessagesMock.mockReturnValue(pendingMessages);

    const result = await loader({
      request: new Request('https://camelai.com/chat/thread_123'),
      context: {},
      params: { id: 'thread_123' },
    } as never);

    expect(result.threadId).toBe('thread_123');
    expect(typeof (result.chatData as Promise<unknown>).then).toBe('function');

    let chatDataResolved = false;
    void Promise.resolve(result.chatData).then(() => {
      chatDataResolved = true;
    });
    await Promise.resolve();
    expect(chatDataResolved).toBe(false);

    resolveMessages?.([]);
    expect(await result.chatData).toEqual({
      messages: [],
      messagesError: null,
      initialUiMessages: [],
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
    expect(getUiMessagesMock).toHaveBeenCalledTimes(1);

    getUiMessagesMock.mockClear();
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
    expect(getUiMessagesMock).toHaveBeenCalledTimes(1);
    expect(getUiMessagesMock).toHaveBeenCalledWith(context, 'thread_123');
    getUiMessagesMock.mockClear();

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

    expect(getUiMessagesMock).toHaveBeenCalledWith(context, 'thread_456');
    // Live loads never touch the legacy pi_core transcript RPC.
    expect(readThreadMessagesMock).not.toHaveBeenCalled();
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
    expect(await result.chatData).toEqual(
      expect.objectContaining({ todos }),
    );
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
      model: 'opus-4.8',
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

    expect(result.threadModel).toBe('opus-4.8');
    if (!Array.isArray(result.allowedThreadModels)) {
      throw new Error('Expected fallback allowedThreadModels to be an array');
    }
    expect(result.allowedThreadModels).toContain('opus-4.8');
    expect(result.allowedThreadModels).toContain('sonnet');
    expect(result.allowedThreadModels.length).toBeGreaterThan(0);
    consoleErrorSpy.mockRestore();
  });
});
