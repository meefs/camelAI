import { beforeEach, describe, expect, it, vi } from 'vitest';

const buildChatRunnerEnvMock = vi.hoisted(() => vi.fn());
const connectChatWebSocketMock = vi.hoisted(() => vi.fn());
const recordWorkspaceThreadStreamingMock = vi.hoisted(() => vi.fn());
const touchThreadActivityMock = vi.hoisted(() => vi.fn());

vi.mock('../src/workspace-container.js', () => ({
  WorkspaceContainer: class WorkspaceContainer {
    buildChatRunnerEnv(...args: unknown[]) {
      return buildChatRunnerEnvMock(...args);
    }

    connectChatWebSocket(...args: unknown[]) {
      return connectChatWebSocketMock(...args);
    }
  },
}));

vi.mock('../src/thread-status.js', () => ({
  recordWorkspaceThreadStreaming: recordWorkspaceThreadStreamingMock,
}));

const { bridgeChatSocket } = await import('../src/routes/websocket');

class FakeSocket {
  readyState = WebSocket.OPEN;
  sent: string[] = [];
  private listeners = new Map<string, Array<(event: any) => void>>();

  accept() {}

  addEventListener(type: string, listener: (event: any) => void) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(message: string) {
    this.sent.push(message);
  }

  close() {
    this.readyState = WebSocket.CLOSED;
  }

  emitMessage(payload: unknown) {
    this.emit('message', {
      data: typeof payload === 'string' ? payload : JSON.stringify(payload),
    });
  }

  emitClose(event: { code?: number; reason?: string } = {}) {
    this.emit('close', event);
  }

  private emit(type: string, event: any) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

function createEnv() {
  return {
    ORG: {
      idFromName: (id: string) => id,
      get: () => ({
        getThread: vi.fn().mockResolvedValue({
          provider: 'claude',
          first_user_message: 'Existing prompt',
        }),
        touchThread: vi.fn().mockResolvedValue(undefined),
        touchThreadActivity: touchThreadActivityMock,
      }),
    },
    CHAT_THREAD: {
      idFromName: (id: string) => id,
      get: () => ({
        setTodoState: vi.fn().mockResolvedValue(undefined),
      }),
    },
    USER: {
      idFromName: (id: string) => id,
      get: () => ({
        touchGroupForThread: vi.fn().mockResolvedValue(undefined),
      }),
    },
  };
}

async function startBridge() {
  const server = new FakeSocket();
  const runner = new FakeSocket();
  buildChatRunnerEnvMock.mockResolvedValue({ envVars: {}, byokProxy: null });
  connectChatWebSocketMock.mockResolvedValue(runner);

  await bridgeChatSocket({
    server: server as unknown as WebSocket,
    env: createEnv() as never,
    orgId: 'org_1',
    workspaceId: 'ws_1',
    threadId: 'thread_1',
    userId: 'user_1',
    userName: 'Ada',
    userEmail: 'ada@example.com',
  });

  return { server, runner };
}

describe('chat runner websocket workspace status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recordWorkspaceThreadStreamingMock.mockResolvedValue(undefined);
    touchThreadActivityMock.mockResolvedValue(true);
  });

  it('does not record idle on bridge init or browser client disconnect', async () => {
    const { server, runner } = await startBridge();

    expect(recordWorkspaceThreadStreamingMock).not.toHaveBeenCalled();

    server.emitClose({ code: 1000, reason: 'tab switched' });
    runner.emitClose({ code: 1000, reason: 'client closed' });

    expect(recordWorkspaceThreadStreamingMock).not.toHaveBeenCalled();
  });

  it('records authoritative runner streaming_state events', async () => {
    const { runner } = await startBridge();

    runner.emitMessage({ type: 'streaming_state', isStreaming: true });
    runner.emitMessage({ type: 'streaming_state', isStreaming: false });

    expect(recordWorkspaceThreadStreamingMock).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      'ws_1',
      'thread_1',
      true,
    );
    expect(recordWorkspaceThreadStreamingMock).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      'ws_1',
      'thread_1',
      false,
    );
  });

  it('records assistant completion activity and unread status with a completedAt timestamp', async () => {
    const { runner } = await startBridge();
    const completedAt = Date.now();

    runner.emitMessage({ type: 'streaming_state', isStreaming: false, completedAt });

    await vi.waitFor(() => {
      expect(touchThreadActivityMock).toHaveBeenCalledWith('thread_1', completedAt);
    });
    expect(recordWorkspaceThreadStreamingMock).toHaveBeenLastCalledWith(
      expect.anything(),
      'ws_1',
      'thread_1',
      false,
      { completedAt },
    );
  });

  it('clears running status when reconnect receives host inactive state after detached completion', async () => {
    const first = await startBridge();

    first.server.emitMessage({ type: 'message', content: 'Build it' });
    await vi.waitFor(() => {
      expect(recordWorkspaceThreadStreamingMock).toHaveBeenCalledWith(
        expect.anything(),
        'ws_1',
        'thread_1',
        true,
      );
    });
    first.server.emitClose({ code: 1000, reason: 'tab switched' });
    first.runner.emitClose({ code: 1000, reason: 'client closed' });

    expect(recordWorkspaceThreadStreamingMock).not.toHaveBeenCalledWith(
      expect.anything(),
      'ws_1',
      'thread_1',
      false,
    );

    const second = await startBridge();
    const completedAt = Date.now();
    second.runner.emitMessage({ type: 'streaming_state', isStreaming: false, completedAt });

    await vi.waitFor(() => {
      expect(recordWorkspaceThreadStreamingMock).toHaveBeenLastCalledWith(
        expect.anything(),
        'ws_1',
        'thread_1',
        false,
        { completedAt },
      );
    });
  });
});
