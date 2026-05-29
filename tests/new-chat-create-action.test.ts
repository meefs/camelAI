import { beforeEach, describe, expect, it, vi } from 'vitest';

const waitUntilMock = vi.fn();
const requireSessionWorkspaceAccessMock = vi.fn();
const getEnvMock = vi.fn();
const getAuthEnvMock = vi.fn();
const createThreadMock = vi.fn();
const createThreadWithValidatedAccessMock = vi.fn();
const deleteThreadMock = vi.fn();
const generateThreadTitleMock = vi.fn();
const createGroupForNewThreadMock = vi.fn();
const createGroupForNewThreadLightweightMock = vi.fn();
const addThreadToExistingGroupMock = vi.fn();
const addThreadToExistingGroupLightweightMock = vi.fn();
const startInitialUserMessageMock = vi.fn();
const CLIENT_BUILD_ID = 'development';

vi.mock('@/lib/wait-until', () => ({
  waitUntil: waitUntilMock,
}));

vi.mock('@/lib/auth.server', () => ({
  requireAuthContext: vi.fn(),
  requireSessionWorkspaceAccess: requireSessionWorkspaceAccessMock,
}));

vi.mock('@/lib/cloudflare.server', () => ({
  getEnv: getEnvMock,
}));

vi.mock('@/lib/billing.server', () => ({
  getOrgBillingOverview: vi.fn(),
}));

vi.mock('@/lib/auth-helpers', () => ({
  getAuthEnv: getAuthEnvMock,
  integrationRecordToIntegration: (record: unknown) => record,
}));

vi.mock('@/lib/auth-do', () => ({
  getWorkerScript: vi.fn(),
}));

vi.mock('@/lib/chat-do.server', () => ({
  createThread: createThreadMock,
  createThreadWithValidatedAccess: createThreadWithValidatedAccessMock,
  deleteThread: deleteThreadMock,
  generateThreadTitle: generateThreadTitleMock,
  getRecentThreads: vi.fn(),
  getWorkspaceModelPickerState: vi.fn(),
}));

vi.mock('@/lib/chat-groups.server', () => ({
  addThreadToExistingGroup: addThreadToExistingGroupMock,
  addThreadToExistingGroupLightweight: addThreadToExistingGroupLightweightMock,
  createGroupForNewThread: createGroupForNewThreadMock,
  createGroupForNewThreadLightweight: createGroupForNewThreadLightweightMock,
  getGroupForWorkspace: vi.fn(),
  listGroupsForMove: vi.fn(),
}));

const { action, shouldRevalidate } = await import('@/routes/_app.chat._index');

function makeCreateThreadFormData() {
  const formData = new FormData();
  formData.set('intent', 'createThread');
  formData.set('clientBuildId', CLIENT_BUILD_ID);
  return formData;
}

describe('new chat create action', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireSessionWorkspaceAccessMock.mockResolvedValue({
      orgId: 'org_123',
      workspaceId: 'ws_123',
      userId: 'user_123',
      session: {
        user_id: 'user_123',
        user_name: 'Ada Lovelace',
        user_email: 'ada@example.com',
      },
    });
    getEnvMock.mockReturnValue({
      CHAT_THREAD: {
        idFromName: (name: string) => name,
        get: vi.fn(() => ({
          startInitialUserMessage: startInitialUserMessageMock,
        })),
      },
    });
    getAuthEnvMock.mockReturnValue({});
    createThreadMock.mockResolvedValue({
      id: 'thread_123',
      title: 'New Chat',
      workspace_id: 'ws_123',
      model: 'sonnet',
    });
    createThreadWithValidatedAccessMock.mockResolvedValue({
      id: 'thread_123',
      title: 'New Chat',
      workspace_id: 'ws_123',
      model: 'sonnet',
    });
    deleteThreadMock.mockResolvedValue(true);
    generateThreadTitleMock.mockResolvedValue(undefined);
    createGroupForNewThreadMock.mockResolvedValue({
      id: 'group_123',
    });
    createGroupForNewThreadLightweightMock.mockResolvedValue({
      id: 'group_123',
    });
    addThreadToExistingGroupMock.mockResolvedValue({
      id: 'group_existing',
    });
    addThreadToExistingGroupLightweightMock.mockResolvedValue({
      id: 'group_existing',
    });
    startInitialUserMessageMock.mockResolvedValue({ status: 'accepted' });
  });

  it('does not use the first user message as the initial chat group name', async () => {
    const formData = makeCreateThreadFormData();
    formData.set('firstMessage', 'Build an analytics dashboard');
    formData.set('model', 'sonnet');

    const response = await action({
      request: new Request('https://camelai.dev/chat', {
        method: 'POST',
        body: formData,
      }),
      context: {},
    } as never);

    expect(response.status).toBe(200);
    expect(createThreadMock).toHaveBeenCalledWith(
      {},
      'ws_123',
      undefined,
      'user_123',
      'Build an analytics dashboard',
      'sonnet',
    );
    expect(createGroupForNewThreadMock).toHaveBeenCalledWith(
      {},
      {
        userId: 'user_123',
        orgId: 'org_123',
        workspaceId: 'ws_123',
        threadId: 'thread_123',
        initialThreadTitle: null,
      },
    );
  });

  it('does not revalidate the new-chat loader after createThread', () => {
    const formData = new FormData();
    formData.set('intent', 'createThread');
    formData.set('clientBuildId', CLIENT_BUILD_ID);

    expect(
      shouldRevalidate({
        formData,
        defaultShouldRevalidate: true,
      }),
    ).toBe(false);

    formData.set('intent', 'createThreadAndStart');
    expect(
      shouldRevalidate({
        formData,
        defaultShouldRevalidate: true,
      }),
    ).toBe(false);
  });

  it('redirects immediately and starts the first message in the background', async () => {
    const formData = makeCreateThreadFormData();
    formData.set('intent', 'createThreadAndStart');
    formData.set('firstMessage', 'Build an analytics dashboard');
    formData.set('model', 'sonnet');

    const response = await action({
      request: new Request('https://camelai.dev/chat', {
        method: 'POST',
        body: formData,
      }),
      context: {},
    } as never);

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe(
      '/chat/thread_123?newThread=1&group=group_123',
    );
    expect(createThreadWithValidatedAccessMock).toHaveBeenCalledWith(
      {},
      'org_123',
      'ws_123',
      undefined,
      'user_123',
      'Build an analytics dashboard',
      'sonnet',
    );
    expect(createThreadMock).not.toHaveBeenCalled();
    expect(startInitialUserMessageMock).toHaveBeenCalledWith({
      threadId: 'thread_123',
      workspaceId: 'ws_123',
      orgId: 'org_123',
      userId: 'user_123',
      userName: 'Ada Lovelace',
      userEmail: 'ada@example.com',
      message: 'Build an analytics dashboard',
      clientMessageId: 'initial:thread_123',
    });
    expect(waitUntilMock).toHaveBeenCalledTimes(2);
    expect(createGroupForNewThreadLightweightMock).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        threadId: 'thread_123',
        initialThreadTitle: null,
      }),
    );
    expect(createGroupForNewThreadMock).not.toHaveBeenCalled();
  });

  it('accepts stale client build ids for compatible create-and-start submissions', async () => {
    const formData = makeCreateThreadFormData();
    formData.set('clientBuildId', 'stale-build');
    formData.set('intent', 'createThreadAndStart');
    formData.set('firstMessage', 'Build from an old tab');
    formData.set('model', 'sonnet');

    const response = await action({
      request: new Request('https://camelai.dev/chat', {
        method: 'POST',
        body: formData,
      }),
      context: {},
    } as never);

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe(
      '/chat/thread_123?newThread=1&group=group_123',
    );
    expect(createThreadWithValidatedAccessMock).toHaveBeenCalledWith(
      {},
      'org_123',
      'ws_123',
      undefined,
      'user_123',
      'Build from an old tab',
      'sonnet',
    );
    expect(createThreadMock).not.toHaveBeenCalled();
    expect(startInitialUserMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'thread_123',
        message: 'Build from an old tab',
        clientMessageId: 'initial:thread_123',
      }),
    );
    expect(createGroupForNewThreadLightweightMock).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        threadId: 'thread_123',
        initialThreadTitle: null,
      }),
    );
  });

  it('retries transient ChatThreadDO resets when starting the first message', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    startInitialUserMessageMock
      .mockRejectedValueOnce(
        new Error('Durable Object reset because its code was updated.'),
      )
      .mockResolvedValueOnce({ status: 'accepted' });
    const formData = makeCreateThreadFormData();
    formData.set('intent', 'createThreadAndStart');
    formData.set('firstMessage', 'Survive a deploy reset');
    formData.set('model', 'sonnet');

    const response = await action({
      request: new Request('https://camelai.dev/chat', {
        method: 'POST',
        body: formData,
      }),
      context: {},
    } as never);

    expect(response.status).toBe(302);
    const startPromise = waitUntilMock.mock.calls[1]?.[0] as Promise<unknown>;
    await expect(startPromise).resolves.toBeUndefined();
    expect(startInitialUserMessageMock).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledWith(
      '[do-rpc] transient rpc failed; retrying',
      expect.objectContaining({
        operation: 'ChatThreadDO.startInitialUserMessage',
        attempt: 1,
        attempts: 4,
      }),
    );
    warnSpy.mockRestore();
  });

  it('returns the new thread and group while title generation runs in the background', async () => {
    const formData = makeCreateThreadFormData();
    formData.set('firstMessage', 'Persist this first message');
    formData.set('model', 'sonnet');

    const response = await action({
      request: new Request('https://camelai.dev/chat', {
        method: 'POST',
        body: formData,
      }),
      context: {},
    } as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      thread: { id: 'thread_123' },
      groupId: 'group_123',
    });
    expect(waitUntilMock).toHaveBeenCalledTimes(1);
    expect(generateThreadTitleMock).toHaveBeenCalledWith(
      {},
      'thread_123',
      'ws_123',
      'Persist this first message',
      'user_123',
    );
  });

  it('passes a real initial thread title through for the new group', async () => {
    const formData = makeCreateThreadFormData();
    formData.set('initialTitle', 'Review production logs');
    formData.set('model', 'sonnet');

    const response = await action({
      request: new Request('https://camelai.dev/chat', {
        method: 'POST',
        body: formData,
      }),
      context: {},
    } as never);

    expect(response.status).toBe(200);
    expect(createGroupForNewThreadMock).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        initialThreadTitle: 'Review production logs',
      }),
    );
  });

  it('returns 404 when creating a thread into a stale group', async () => {
    addThreadToExistingGroupMock.mockRejectedValueOnce(
      new Error('Chat group not found'),
    );
    const formData = makeCreateThreadFormData();
    formData.set('groupId', 'group_stale');
    formData.set('model', 'sonnet');

    const response = await action({
      request: new Request('https://camelai.dev/chat', {
        method: 'POST',
        body: formData,
      }),
      context: {},
    } as never);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: 'Chat group not found',
    });
    expect(deleteThreadMock).toHaveBeenCalledWith({}, 'thread_123', 'ws_123');
  });
});
