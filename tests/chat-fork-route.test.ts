import { beforeEach, describe, expect, it, vi } from 'vitest';

const requireSessionWorkspaceAccessMock = vi.fn();
const getEnvMock = vi.fn();
const getAuthEnvMock = vi.fn();
const createThreadMock = vi.fn();
const deleteThreadMock = vi.fn();
const orgGetThreadMock = vi.fn();
const orgCreateThreadMock = vi.fn();
const workspaceContainerConstructorMock = vi.fn();
const forkThreadSessionMock = vi.fn();

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
        get: vi.fn(),
      },
    });
    getAuthEnvMock.mockReturnValue({
      ORG: {
        idFromName: (id: string) => id,
        get: () => ({
          getThread: orgGetThreadMock,
          createThread: orgCreateThreadMock,
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
  });

  it('rejects forks when the source thread model is hidden by picker policy', async () => {
    createThreadMock.mockRejectedValue(new Error('Invalid thread model'));

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

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'Invalid thread model',
    });
    expect(createThreadMock).toHaveBeenCalledWith(
      {},
      'ws_123',
      'Fork: Legacy Opus thread',
      'user_123',
      'Build the prototype',
      'opus',
    );
    expect(orgCreateThreadMock).not.toHaveBeenCalled();
    expect(workspaceContainerConstructorMock).not.toHaveBeenCalled();
    expect(forkThreadSessionMock).not.toHaveBeenCalled();
    expect(deleteThreadMock).not.toHaveBeenCalled();
  });
});
