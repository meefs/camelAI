import { beforeEach, describe, expect, it, vi } from 'vitest';

const requireSuperuserMock = vi.fn();
const getAuthEnvMock = vi.fn();
const getEnvMock = vi.fn();
const adminGetThreadContextByIdMock = vi.fn();
const getLegacyClaudeSessionIdMock = vi.fn();
const getCodexSessionIdMock = vi.fn();
const orgGetMock = vi.fn();
const orgIdFromNameMock = vi.fn((id: string) => id);
const orgGetThreadMock = vi.fn();

vi.mock('@/lib/auth.server', () => ({
  requireSuperuser: requireSuperuserMock,
  getAuthEnv: getAuthEnvMock,
}));

vi.mock('@/lib/cloudflare.server', () => ({
  getEnv: getEnvMock,
}));

vi.mock('@/lib/auth-do.server', () => ({
  adminGetThreadContextById: adminGetThreadContextByIdMock,
}));

vi.mock('@/lib/chat-do.server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/chat-do.server')>();
  return {
    ...actual,
    getLegacyClaudeSessionId: getLegacyClaudeSessionIdMock,
    getCodexSessionId: getCodexSessionIdMock,
  };
});

let loader: typeof import('@/routes/api/admin.threads.$id.messages').loader;
let WorkspaceContainer: typeof import('../workers/main/src/workspace-container').WorkspaceContainer;

describe('GET /api/admin/threads/:id/messages', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    getEnvMock.mockReturnValue({});
    orgGetMock.mockReturnValue({ getThread: orgGetThreadMock });
    getAuthEnvMock.mockReturnValue({
      ORG: {
        idFromName: orgIdFromNameMock,
        get: orgGetMock,
      },
    });
    getLegacyClaudeSessionIdMock.mockResolvedValue(null);
    getCodexSessionIdMock.mockResolvedValue(null);

    ({ WorkspaceContainer } = await import('../workers/main/src/workspace-container'));
    ({ loader } = await import('@/routes/api/admin.threads.$id.messages'));
  });

  it('returns auth response when superuser check fails', async () => {
    requireSuperuserMock.mockRejectedValue(
      new Response(null, { status: 302, headers: { Location: '/' } })
    );

    const response = await loader({
      request: new Request('https://camelai.com/api/admin/threads/thread_123/messages'),
      context: {},
      params: { id: 'thread_123' },
    } as never);

    expect(response.status).toBe(302);
    expect(adminGetThreadContextByIdMock).not.toHaveBeenCalled();
  });

  it('returns 404 when thread context is missing', async () => {
    requireSuperuserMock.mockResolvedValue({
      user: { is_superuser: true },
    });
    adminGetThreadContextByIdMock.mockResolvedValue(null);

    const response = await loader({
      request: new Request('https://camelai.com/api/admin/threads/thread_123/messages'),
      context: {},
      params: { id: 'thread_123' },
    } as never);

    expect(response.status).toBe(404);
  });

  it('streams parsed messages for valid superuser requests', async () => {
    requireSuperuserMock.mockResolvedValue({
      user: { is_superuser: true },
    });
    adminGetThreadContextByIdMock.mockResolvedValue({
      org_id: 'org_123',
      workspace_id: 'ws_123',
    });
    orgGetThreadMock.mockResolvedValue({
      id: 'thread_123',
      workspace_id: 'ws_123',
    });
    vi
      .spyOn(WorkspaceContainer.prototype, 'readThreadMessagesStream')
      .mockResolvedValue({
        success: true,
        response: new Response(
          JSON.stringify({
            success: true,
            messages: [{ id: 'm1', role: 'user', content: 'hello', created_at: 1 }],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        ),
      });

    const response = await loader({
      request: new Request('https://camelai.com/api/admin/threads/thread_123/messages'),
      context: {},
      params: { id: 'thread_123' },
    } as never);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      messages: [{ id: 'm1', role: 'user', content: 'hello', created_at: 1 }],
    });
    expect(WorkspaceContainer.prototype.readThreadMessagesStream).toHaveBeenCalledWith(
      'thread_123',
      { claudeSessionId: null, codexSessionId: null, skipBanCheck: true }
    );
  });
});
