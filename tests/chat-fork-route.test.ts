import { beforeEach, describe, expect, it, vi } from 'vitest';

const requireSessionWorkspaceAccessMock = vi.fn();
const getEnvMock = vi.fn();
const getAuthEnvMock = vi.fn();
const createThreadMock = vi.fn();
const deleteThreadMock = vi.fn();
const getLegacyClaudeSessionIdMock = vi.fn();
const getCodexSessionIdMock = vi.fn();
const orgGetThreadMock = vi.fn();
const userGetChatGroupSummaryMock = vi.fn();
const userGetChatGroupForThreadMock = vi.fn();
const addThreadToExistingGroupMock = vi.fn();
const workspaceContainerConstructorMock = vi.fn();
const forkThreadSessionMock = vi.fn();
const readThreadMessagesStreamMock = vi.fn();
const mkdirMock = vi.fn();
const writeFileMock = vi.fn();
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
  getLegacyClaudeSessionId: getLegacyClaudeSessionIdMock,
  getCodexSessionId: getCodexSessionIdMock,
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

    readThreadMessagesStream(...args: unknown[]) {
      return readThreadMessagesStreamMock(...args);
    }

    mkdir(...args: unknown[]) {
      return mkdirMock(...args);
    }

    writeFile(...args: unknown[]) {
      return writeFileMock(...args);
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
    getLegacyClaudeSessionIdMock.mockResolvedValue(null);
    getCodexSessionIdMock.mockResolvedValue(null);
    readThreadMessagesStreamMock.mockResolvedValue({
      success: true,
      response: Response.json({ success: true, messages: [] }),
    });
    mkdirMock.mockResolvedValue({ success: true });
    writeFileMock.mockResolvedValue({ success: true });
    deleteThreadMock.mockResolvedValue(undefined);
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
    expect(forkThreadSessionMock).toHaveBeenCalledWith({
      sourceThreadId: 'thread_source',
      targetThreadId: 'thread_fork',
      entryId: 'msg_123',
    });
    expect(readThreadMessagesStreamMock).not.toHaveBeenCalled();
    expect(mkdirMock).not.toHaveBeenCalled();
    expect(writeFileMock).not.toHaveBeenCalled();
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

  it('falls back to renderable history when the sandbox fork endpoint is unavailable', async () => {
    forkThreadSessionMock.mockResolvedValue({
      success: false,
      error: 'Not found',
      code: 'HTTP_404',
      status: 404,
    });
    readThreadMessagesStreamMock.mockResolvedValue({
      success: true,
      response: Response.json({
        success: true,
        messages: [
          {
            id: 'user_1',
            thread_id: 'thread_source',
            role: 'user',
            content: 'Build it',
            created_at: 1,
          },
          {
            id: 'rendered-assistant',
            forkEntryId: 'pi-entry-leaf',
            thread_id: 'thread_source',
            role: 'assistant',
            content: [{ type: 'text', text: 'Done' }],
            created_at: 2,
          },
          {
            id: 'later_user',
            thread_id: 'thread_source',
            role: 'user',
            content: 'Too far',
            created_at: 3,
          },
        ],
      }),
    });

    const response = await action({
      request: new Request(
        'https://camelai.com/api/workspaces/ws_123/chat/thread_source/fork',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messageId: 'pi-entry-leaf',
            renderedMessageId: 'rendered-assistant',
            groupId: 'group_123',
          }),
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
    expect(forkThreadSessionMock).toHaveBeenCalledWith({
      sourceThreadId: 'thread_source',
      targetThreadId: 'thread_fork',
      entryId: 'pi-entry-leaf',
    });
    expect(readThreadMessagesStreamMock).toHaveBeenCalledWith('thread_source', {
      claudeSessionId: undefined,
      codexSessionId: undefined,
      skipBanCheck: true,
    });
    expect(mkdirMock).toHaveBeenCalledWith('/home/claude/.claude/projects/-home-claude');
    expect(writeFileMock).toHaveBeenCalledWith(
      '/home/claude/.claude/projects/-home-claude/thread_fork.jsonl',
      expect.stringContaining('"uuid":"rendered-assistant"'),
    );
    expect(String(writeFileMock.mock.calls[0]?.[1])).not.toContain('later_user');
    expect(deleteThreadMock).not.toHaveBeenCalled();
    expect(addThreadToExistingGroupMock).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        groupId: 'group_123',
        threadId: 'thread_fork',
      }),
    );
  });

  it('rolls back fallback forks when the requested target is missing from renderable history', async () => {
    forkThreadSessionMock.mockResolvedValue({
      success: false,
      error: 'Not found',
      code: 'HTTP_404',
      status: 404,
    });
    readThreadMessagesStreamMock.mockResolvedValue({
      success: true,
      response: Response.json({
        success: true,
        messages: [
          {
            id: 'user_1',
            thread_id: 'thread_source',
            role: 'user',
            content: 'Build it',
            created_at: 1,
          },
          {
            id: 'assistant_1',
            forkEntryId: 'pi-entry-other',
            thread_id: 'thread_source',
            role: 'assistant',
            content: [{ type: 'text', text: 'Done' }],
            created_at: 2,
          },
        ],
      }),
    });

    const response = await action({
      request: new Request(
        'https://camelai.com/api/workspaces/ws_123/chat/thread_source/fork',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messageId: 'pi-entry-missing',
            renderedMessageId: 'rendered-missing',
            groupId: 'group_123',
          }),
        },
      ),
      context: {},
      params: { id: 'ws_123', threadId: 'thread_source' },
    } as never);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error:
        'Sandbox fork endpoint returned 404 Not Found. Restart or deploy sandbox-host with chat fork support, and for local dev make sure SANDBOX_HOST_URL points at the control listener (:4400), not the proxy listener (:4401).; fallback history fork failed: Fork target not found in renderable history',
    });
    expect(writeFileMock).not.toHaveBeenCalled();
    expect(deleteThreadMock).toHaveBeenCalledWith({}, 'thread_fork', 'ws_123');
    expect(addThreadToExistingGroupMock).not.toHaveBeenCalled();
  });

  it('preserves hidden and compact-summary metadata in fallback fork history', async () => {
    forkThreadSessionMock.mockResolvedValue({
      success: false,
      error: 'Not found',
      code: 'HTTP_404',
      status: 404,
    });
    readThreadMessagesStreamMock.mockResolvedValue({
      success: true,
      response: Response.json({
        success: true,
        messages: [
          {
            id: 'user_1',
            thread_id: 'thread_source',
            role: 'user',
            content: 'Build it',
            created_at: 1,
          },
          {
            id: 'meta_1',
            thread_id: 'thread_source',
            role: 'user',
            content: 'Hidden tool output',
            created_at: 2,
            isMeta: true,
            sourceToolUseID: 'tool_123',
          },
          {
            id: 'compact_1',
            thread_id: 'thread_source',
            role: 'user',
            content: 'Compacted context',
            created_at: 3,
            isCompactSummary: true,
          },
          {
            id: 'rendered-assistant',
            forkEntryId: 'pi-entry-leaf',
            thread_id: 'thread_source',
            role: 'assistant',
            content: [{ type: 'text', text: 'Done' }],
            created_at: 4,
          },
        ],
      }),
    });

    const response = await action({
      request: new Request(
        'https://camelai.com/api/workspaces/ws_123/chat/thread_source/fork',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messageId: 'pi-entry-leaf',
            renderedMessageId: 'rendered-assistant',
            groupId: 'group_123',
          }),
        },
      ),
      context: {},
      params: { id: 'ws_123', threadId: 'thread_source' },
    } as never);

    expect(response.status).toBe(200);
    const written = String(writeFileMock.mock.calls[0]?.[1] ?? '');
    const events = written
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'user',
          uuid: 'meta_1',
          isMeta: true,
          sourceToolUseID: 'tool_123',
        }),
        expect.objectContaining({
          type: 'user',
          uuid: 'compact_1',
          isCompactSummary: true,
        }),
      ]),
    );
    expect(deleteThreadMock).not.toHaveBeenCalled();
  });

  it('returns a specific sandbox fork failure and rolls back the created thread', async () => {
    forkThreadSessionMock.mockResolvedValue({
      success: false,
      error: 'target Pi session already exists',
      code: 'HTTP_400',
      status: 400,
    });

    const response = await action({
      request: new Request(
        'https://camelai.com/api/workspaces/ws_123/chat/thread_source/fork',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messageId: 'pi-entry-leaf', groupId: 'group_123' }),
        },
      ),
      context: {},
      params: { id: 'ws_123', threadId: 'thread_source' },
    } as never);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: 'Sandbox fork failed: target Pi session already exists',
    });
    expect(deleteThreadMock).toHaveBeenCalledWith({}, 'thread_fork', 'ws_123');
    expect(addThreadToExistingGroupMock).not.toHaveBeenCalled();
  });
});
