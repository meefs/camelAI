import { beforeEach, describe, expect, it, vi } from 'vitest';

const waitUntilMock = vi.fn();
const requireSessionWorkspaceAccessMock = vi.fn();
const getEnvMock = vi.fn();
const getAuthEnvMock = vi.fn();
const createThreadMock = vi.fn();
const generateThreadTitleMock = vi.fn();
const createGroupForNewThreadMock = vi.fn();
const addThreadToExistingGroupMock = vi.fn();

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
  generateThreadTitle: generateThreadTitleMock,
  getRecentThreads: vi.fn(),
  getWorkspaceModelPickerState: vi.fn(),
}));

vi.mock('@/lib/chat-groups.server', () => ({
  addThreadToExistingGroup: addThreadToExistingGroupMock,
  createGroupForNewThread: createGroupForNewThreadMock,
  getGroupForWorkspace: vi.fn(),
  listGroupsForMove: vi.fn(),
}));

const { action } = await import('@/routes/_app.chat._index');

describe('new chat create action', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireSessionWorkspaceAccessMock.mockResolvedValue({
      orgId: 'org_123',
      workspaceId: 'ws_123',
      userId: 'user_123',
    });
    getEnvMock.mockReturnValue({});
    getAuthEnvMock.mockReturnValue({});
    createThreadMock.mockResolvedValue({
      id: 'thread_123',
      title: 'New Chat',
      workspace_id: 'ws_123',
    });
    generateThreadTitleMock.mockResolvedValue(undefined);
    createGroupForNewThreadMock.mockResolvedValue({
      id: 'group_123',
    });
    addThreadToExistingGroupMock.mockResolvedValue({
      id: 'group_existing',
    });
  });

  it('does not use the first user message as the initial chat group name', async () => {
    const formData = new FormData();
    formData.set('intent', 'createThread');
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

  it('creates the thread without sending the first message server-side', async () => {
    const formData = new FormData();
    formData.set('intent', 'createThread');
    formData.set('firstMessage', 'Build an analytics dashboard');
    formData.set('initialMessageContent', 'Build an analytics dashboard');
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
  });

  it('passes a real initial thread title through for the new group', async () => {
    const formData = new FormData();
    formData.set('intent', 'createThread');
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
});
