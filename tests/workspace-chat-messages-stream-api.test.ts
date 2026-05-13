import { beforeEach, describe, expect, it, vi } from 'vitest';

const requireWorkspaceAuthMock = vi.fn();
const getThreadMock = vi.fn();
const getPiCoreMessagesMock = vi.fn();
const getLegacyClaudeSessionIdMock = vi.fn();
const getCodexSessionIdMock = vi.fn();
const readThreadMessagesStreamMock = vi.fn();

vi.mock('@/routes/api/workspaces.utils', () => ({
  requireWorkspaceAuth: requireWorkspaceAuthMock,
}));

vi.mock('@/lib/chat-do.server', () => ({
  getThread: getThreadMock,
  getPiCoreMessages: getPiCoreMessagesMock,
  getLegacyClaudeSessionId: getLegacyClaudeSessionIdMock,
  getCodexSessionId: getCodexSessionIdMock,
}));

const { loader } = await import('@/routes/api/workspaces.$id.chat.$threadId.messages.stream');

describe('workspace chat messages stream API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireWorkspaceAuthMock.mockResolvedValue({
      container: {
        readThreadMessagesStream: readThreadMessagesStreamMock,
      },
    });
    getThreadMock.mockResolvedValue({
      id: 'thread_1',
      workspace_id: 'ws_1',
    });
    getPiCoreMessagesMock.mockResolvedValue([]);
    getLegacyClaudeSessionIdMock.mockResolvedValue(null);
    getCodexSessionIdMock.mockResolvedValue(null);
    readThreadMessagesStreamMock.mockResolvedValue({
      success: true,
      response: new Response(JSON.stringify({ success: true, messages: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    });
  });

  it('returns 404 without reading Pi messages when the thread is outside the workspace', async () => {
    getThreadMock.mockResolvedValue(null);

    const response = await loader({
      request: new Request(
        'https://camelai.test/api/workspaces/ws_1/chat/thread_other/messages/stream',
      ),
      context: {},
      params: { id: 'ws_1', threadId: 'thread_other' },
    } as never);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Thread not found' });
    expect(getThreadMock).toHaveBeenCalledWith({}, 'thread_other', 'ws_1');
    expect(getPiCoreMessagesMock).not.toHaveBeenCalled();
    expect(readThreadMessagesStreamMock).not.toHaveBeenCalled();
  });

  it('serves Durable Object Pi messages after verifying thread ownership', async () => {
    getPiCoreMessagesMock.mockResolvedValue([
      { id: 'pi_1', role: 'assistant', content: 'hello' },
    ]);

    const response = await loader({
      request: new Request(
        'https://camelai.test/api/workspaces/ws_1/chat/thread_1/messages/stream',
      ),
      context: {},
      params: { id: 'ws_1', threadId: 'thread_1' },
    } as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      messages: [{ id: 'pi_1', role: 'assistant', content: 'hello' }],
    });
    expect(getThreadMock).toHaveBeenCalledWith({}, 'thread_1', 'ws_1');
    expect(getPiCoreMessagesMock).toHaveBeenCalledWith({}, 'thread_1');
    expect(readThreadMessagesStreamMock).not.toHaveBeenCalled();
  });
});
