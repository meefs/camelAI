import { beforeEach, describe, expect, it, vi } from 'vitest';

const requireSessionWorkspaceAccessMock = vi.fn();
const getEnvMock = vi.fn();
const getAuthEnvMock = vi.fn();
const createThreadMock = vi.fn();
const deleteThreadMock = vi.fn();
const orgGetThreadMock = vi.fn();
const userGetChatGroupSummaryMock = vi.fn();
const userGetChatGroupForThreadMock = vi.fn();
const addThreadToExistingGroupMock = vi.fn();
const workspaceContainerConstructorMock = vi.fn();
const forkThreadSessionMock = vi.fn();
const getForkStateSnapshotMock = vi.fn();
const applyForkStateSnapshotMock = vi.fn();

vi.mock('@/lib/auth.server', () => ({
  requireSessionWorkspaceAccess: requireSessionWorkspaceAccessMock,
}));

vi.mock('@/lib/cloudflare.server', () => ({
  getEnv: getEnvMock,
}));

vi.mock('@/lib/auth-helpers', () => ({
  getAuthEnv: getAuthEnvMock,
}));

vi.mock('@/lib/chat-do.server', () => ({
  createThread: createThreadMock,
  deleteThread: deleteThreadMock,
}));

vi.mock('@/lib/chat-groups.server', () => ({
  addThreadToExistingGroup: addThreadToExistingGroupMock,
}));

vi.mock('../workers/main/src/workspace-container', () => ({
  WorkspaceContainer: class WorkspaceContainer {
    constructor(...args: unknown[]) {
      workspaceContainerConstructorMock(...args);
    }

    forkThreadSession(...args: unknown[]) {
      return forkThreadSessionMock(...args);
    }
  },
}));

const { action } = await import('@/routes/api/workspaces.$id.chat.$threadId.fork');

describe('chat fork route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireSessionWorkspaceAccessMock.mockResolvedValue({
      session: { workspace_id: 'ws_123' },
      orgId: 'org_123',
      workspaceId: 'ws_123',
      userId: 'user_123',
    });
    getEnvMock.mockReturnValue({
      CHAT_THREAD: {
        idFromName: (id: string) => id,
        get: (id: string) =>
          id === 'thread_source'
            ? { getForkStateSnapshot: getForkStateSnapshotMock }
            : { applyForkStateSnapshot: applyForkStateSnapshotMock },
      },
    });
    getAuthEnvMock.mockReturnValue({
      ORG: {
        idFromName: (id: string) => id,
        get: () => ({
          getThread: orgGetThreadMock,
        }),
      },
      USER: {
        idFromName: (id: string) => id,
        get: () => ({
          getChatGroupSummary: userGetChatGroupSummaryMock,
          getChatGroupForThread: userGetChatGroupForThreadMock,
        }),
      },
    });
    orgGetThreadMock.mockResolvedValue({
      id: 'thread_source',
      workspace_id: 'ws_123',
      title: 'Legacy Opus thread',
      first_user_message: 'Build the prototype',
      model: 'opus',
      provider: 'claude',
    });
    createThreadMock.mockResolvedValue({
      id: 'thread_fork',
      workspace_id: 'ws_123',
      title: 'Fork: Legacy Opus thread',
      first_user_message: 'Build the prototype',
      model: 'opus',
      provider: 'claude',
    });
    forkThreadSessionMock.mockResolvedValue({ success: true });
    getForkStateSnapshotMock.mockResolvedValue({ preview: null });
    applyForkStateSnapshotMock.mockResolvedValue(undefined);
    addThreadToExistingGroupMock.mockResolvedValue({ id: 'group_123' });
    userGetChatGroupSummaryMock.mockResolvedValue({
      id: 'group_123',
      org_id: 'org_123',
      workspace_id: 'ws_123',
      name: 'Build',
      last_active_thread_id: 'thread_source',
      created_at: 1,
      updated_at: 1,
      open_thread_ids: ['thread_source'],
      closed_thread_ids: [],
    });
    userGetChatGroupForThreadMock.mockResolvedValue({
      id: 'group_123',
      org_id: 'org_123',
      workspace_id: 'ws_123',
      name: 'Build',
      last_active_thread_id: 'thread_source',
      created_at: 1,
      updated_at: 1,
      open_thread_ids: ['thread_source'],
      closed_thread_ids: [],
    });
  });

  it('falls back to the current default model when the source model is hidden', async () => {
    createThreadMock
      .mockRejectedValueOnce(new Error('Invalid thread model'))
      .mockResolvedValueOnce({
        id: 'thread_fork',
        workspace_id: 'ws_123',
        title: 'Fork: Legacy Opus thread',
        first_user_message: 'Build the prototype',
        model: 'sonnet',
        provider: 'claude',
      });

    const response = await action({
      request: new Request(
        'https://camelai.com/api/workspaces/ws_123/chat/thread_source/fork',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messageId: 'msg_123' }),
        },
      ),
      context: {},
      params: { id: 'ws_123', threadId: 'thread_source' },
    } as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      thread: { id: 'thread_fork', model: 'sonnet' },
      groupId: 'group_123',
    });
    expect(createThreadMock).toHaveBeenCalledWith(
      {},
      'ws_123',
      'Fork: Legacy Opus thread',
      'user_123',
      'Build the prototype',
      'opus',
    );
    expect(createThreadMock).toHaveBeenLastCalledWith(
      {},
      'ws_123',
      'Fork: Legacy Opus thread',
      'user_123',
      'Build the prototype',
    );
    expect(addThreadToExistingGroupMock).toHaveBeenCalledWith(
      {},
      {
        userId: 'user_123',
        orgId: 'org_123',
        workspaceId: 'ws_123',
        groupId: 'group_123',
        threadId: 'thread_fork',
      },
    );
    expect(deleteThreadMock).not.toHaveBeenCalled();
  });

  it('adds forks to the requested source group and returns the group id', async () => {
    const response = await action({
      request: new Request(
        'https://camelai.com/api/workspaces/ws_123/chat/thread_source/fork',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messageId: 'msg_123', groupId: 'group_123' }),
        },
      ),
      context: {},
      params: { id: 'ws_123', threadId: 'thread_source' },
    } as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      thread: { id: 'thread_fork' },
      groupId: 'group_123',
    });
    expect(userGetChatGroupSummaryMock).toHaveBeenCalledWith('group_123');
    expect(addThreadToExistingGroupMock).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        groupId: 'group_123',
        threadId: 'thread_fork',
      }),
    );
  });

  it('derives the source group when the client omits groupId', async () => {
    const response = await action({
      request: new Request(
        'https://camelai.com/api/workspaces/ws_123/chat/thread_source/fork',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messageId: 'msg_123' }),
        },
      ),
      context: {},
      params: { id: 'ws_123', threadId: 'thread_source' },
    } as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      groupId: 'group_123',
    });
    expect(userGetChatGroupForThreadMock).toHaveBeenCalledWith('thread_source');
  });

  it('rejects requested groups that do not contain the source thread', async () => {
    userGetChatGroupSummaryMock.mockResolvedValue({
      id: 'group_123',
      org_id: 'org_123',
      workspace_id: 'ws_123',
      name: 'Build',
      last_active_thread_id: null,
      created_at: 1,
      updated_at: 1,
      open_thread_ids: ['other_thread'],
      closed_thread_ids: [],
    });

    const response = await action({
      request: new Request(
        'https://camelai.com/api/workspaces/ws_123/chat/thread_source/fork',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messageId: 'msg_123', groupId: 'group_123' }),
        },
      ),
      context: {},
      params: { id: 'ws_123', threadId: 'thread_source' },
    } as never);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'Source thread is not in the requested group',
    });
    expect(createThreadMock).not.toHaveBeenCalled();
  });
});
