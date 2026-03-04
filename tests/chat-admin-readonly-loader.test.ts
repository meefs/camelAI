import { beforeEach, describe, expect, it, vi } from 'vitest';

const requireSuperuserMock = vi.fn();
const requireAuthContextMock = vi.fn();
const getAuthEnvMock = vi.fn();
const getEnvMock = vi.fn();
const adminGetThreadContextByIdMock = vi.fn();
const getThreadMock = vi.fn();
const getThreadPreviewStateMock = vi.fn();
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
}));

vi.mock('@/lib/auth-do', () => ({
  getOrg: getOrgMock,
  getWorkerScript: getWorkerScriptMock,
}));

const { loader } = await import('@/routes/_app.chat.$id');

describe('chat loader admin readonly mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getEnvMock.mockReturnValue({});
    getAuthEnvMock.mockReturnValue({});
    getThreadPreviewStateMock.mockResolvedValue({
      target: null,
      tabs: [],
      activeTabId: null,
      version: 0,
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
    getEnvMock.mockReturnValue({});
    getAuthEnvMock.mockReturnValue({});
    getThreadPreviewStateMock.mockResolvedValue({
      target: null,
      tabs: [],
      activeTabId: null,
      version: 0,
    });
  });

  it('redirects to /chat when the thread is not in the active workspace', async () => {
    requireAuthContextMock.mockResolvedValue({
      currentWorkspace: { id: 'ws_active' },
      currentOrg: { id: 'org_active', slug: 'acme' },
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
});
