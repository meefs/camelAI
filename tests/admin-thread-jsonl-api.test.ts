import { beforeEach, describe, expect, it, vi } from 'vitest';

const requireSuperuserMock = vi.fn();
const getAuthEnvMock = vi.fn();
const getEnvMock = vi.fn();
const getLegacyClaudeSessionIdMock = vi.fn();
const getCodexSessionIdMock = vi.fn();
const getPiCoreMessagesMock = vi.fn();
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

vi.mock('@/lib/chat-do.server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/chat-do.server')>();
  return {
    ...actual,
    getLegacyClaudeSessionId: getLegacyClaudeSessionIdMock,
    getCodexSessionId: getCodexSessionIdMock,
    getPiCoreMessages: getPiCoreMessagesMock,
  };
});

const { WorkspaceContainer } = await import('../workers/main/src/workspace-container');
const { loader } = await import('@/routes/api/admin.threads.$id.jsonl');

describe('GET /api/admin/threads/:id/jsonl', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();

    getEnvMock.mockReturnValue({});
    orgGetMock.mockReturnValue({ getThread: orgGetThreadMock });
    getAuthEnvMock.mockReturnValue({
      ORG: {
        idFromName: orgIdFromNameMock,
        get: orgGetMock,
      },
    });
    requireSuperuserMock.mockResolvedValue({
      user: { is_superuser: true },
    });
    orgGetThreadMock.mockResolvedValue({
      id: 'thread_123',
      workspace_id: 'ws_123',
    });
    getLegacyClaudeSessionIdMock.mockResolvedValue(null);
    getCodexSessionIdMock.mockResolvedValue(null);
    getPiCoreMessagesMock.mockResolvedValue([]);
  });

  it('streams the raw Claude JSONL transcript when it exists', async () => {
    const rawJsonl = '{"type":"user","message":{"content":"hello"}}\n';
    const readFileStream = vi
      .spyOn(WorkspaceContainer.prototype, 'readFileStream')
      .mockResolvedValue(
        new Response(rawJsonl, {
          headers: { 'Content-Length': String(rawJsonl.length) },
        })
      );
    const readThreadMessagesStream = vi
      .spyOn(WorkspaceContainer.prototype, 'readThreadMessagesStream')
      .mockResolvedValue({
        success: true,
        response: new Response(JSON.stringify({ success: true, messages: [] })),
      });

    const response = await loader({
      request: new Request(
        'https://camelai.com/api/admin/threads/thread_123/jsonl?orgId=org_123&workspaceId=ws_123'
      ),
      context: {},
      params: { id: 'thread_123' },
    } as never);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Disposition')).toBe(
      'attachment; filename="thread_123.jsonl"'
    );
    expect(response.headers.get('Content-Length')).toBe(String(rawJsonl.length));
    expect(await response.text()).toBe(rawJsonl);
    expect(readFileStream).toHaveBeenCalledWith(
      '/home/claude/.claude/projects/-home-claude/thread_123.jsonl',
      { skipBanCheck: true }
    );
    expect(readThreadMessagesStream).not.toHaveBeenCalled();
  });

  it('falls back to parsed thread messages when no raw JSONL file exists', async () => {
    vi.spyOn(WorkspaceContainer.prototype, 'readFileStream').mockResolvedValue(null);
    const readThreadMessagesStream = vi
      .spyOn(WorkspaceContainer.prototype, 'readThreadMessagesStream')
      .mockResolvedValue({
        success: true,
        response: new Response(
          JSON.stringify({
            success: true,
            messages: [
              {
                id: 'msg_1',
                thread_id: 'thread_123',
                role: 'user',
                content: 'hello',
                created_at: 1,
              },
              {
                id: 'msg_2',
                thread_id: 'thread_123',
                role: 'assistant',
                content: [{ type: 'text', text: 'hi' }],
                created_at: 2,
              },
            ],
          })
        ),
      });
    getLegacyClaudeSessionIdMock.mockResolvedValue('claude_session_123');
    getCodexSessionIdMock.mockResolvedValue('codex_session_123');

    const response = await loader({
      request: new Request(
        'https://camelai.com/api/admin/threads/thread_123/jsonl?orgId=org_123&workspaceId=ws_123'
      ),
      context: {},
      params: { id: 'thread_123' },
    } as never);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/x-ndjson; charset=utf-8');
    expect(response.headers.get('Content-Disposition')).toBe(
      'attachment; filename="thread_123.jsonl"'
    );
    expect(await response.text()).toBe(
      [
        JSON.stringify({
          id: 'msg_1',
          thread_id: 'thread_123',
          role: 'user',
          content: 'hello',
          created_at: 1,
        }),
        JSON.stringify({
          id: 'msg_2',
          thread_id: 'thread_123',
          role: 'assistant',
          content: [{ type: 'text', text: 'hi' }],
          created_at: 2,
        }),
        '',
      ].join('\n')
    );
    expect(readThreadMessagesStream).toHaveBeenCalledWith('thread_123', {
      claudeSessionId: 'claude_session_123',
      codexSessionId: 'codex_session_123',
      skipBanCheck: true,
    });
  });

  it('exports Durable Object Pi messages before checking sandbox JSONL', async () => {
    getPiCoreMessagesMock.mockResolvedValue([
      {
        id: 'pi_msg_1',
        thread_id: 'thread_123',
        role: 'assistant',
        content: [{ type: 'text', text: 'from do' }],
        created_at: 1,
        forkEntryId: 'pi_msg_1',
      },
    ]);
    const readFileStream = vi.spyOn(WorkspaceContainer.prototype, 'readFileStream');
    const readThreadMessagesStream = vi.spyOn(
      WorkspaceContainer.prototype,
      'readThreadMessagesStream',
    );

    const response = await loader({
      request: new Request(
        'https://camelai.com/api/admin/threads/thread_123/jsonl?orgId=org_123&workspaceId=ws_123'
      ),
      context: {},
      params: { id: 'thread_123' },
    } as never);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(
      `${JSON.stringify({
        id: 'pi_msg_1',
        thread_id: 'thread_123',
        role: 'assistant',
        content: [{ type: 'text', text: 'from do' }],
        created_at: 1,
        forkEntryId: 'pi_msg_1',
      })}\n`,
    );
    expect(readFileStream).not.toHaveBeenCalled();
    expect(readThreadMessagesStream).not.toHaveBeenCalled();
  });
});
