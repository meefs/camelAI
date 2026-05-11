import { beforeEach, describe, expect, it, vi } from 'vitest';

const buildChatRunnerEnvMock = vi.hoisted(() => vi.fn());
const connectChatWebSocketMock = vi.hoisted(() => vi.fn());
const recordWorkspaceThreadStreamingMock = vi.hoisted(() => vi.fn());
const touchThreadActivityMock = vi.hoisted(() => vi.fn());
const setBrowserTurnStreamingMock = vi.hoisted(() => vi.fn());

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
        setBrowserTurnStreaming: setBrowserTurnStreamingMock,
        completeTodoStateForTurnEnd: vi.fn().mockResolvedValue(undefined),
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('chat runner websocket workspace status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recordWorkspaceThreadStreamingMock.mockResolvedValue(undefined);
    touchThreadActivityMock.mockResolvedValue(true);
    setBrowserTurnStreamingMock.mockResolvedValue(undefined);
  });

  it('does not record idle on bridge init or browser client disconnect', async () => {
    const { server, runner } = await startBridge();

    expect(recordWorkspaceThreadStreamingMock).not.toHaveBeenCalled();

    server.emitClose({ code: 1000, reason: 'tab switched' });
    runner.emitClose({ code: 1000, reason: 'client closed' });

    expect(recordWorkspaceThreadStreamingMock).not.toHaveBeenCalled();
  });

  it('keeps the runner connected after browser disconnect during an active turn', async () => {
    const { server, runner } = await startBridge();

    server.emitMessage({ type: 'message', content: 'Build it' });
    await vi.waitFor(() => {
      expect(recordWorkspaceThreadStreamingMock).toHaveBeenCalledWith(
        expect.anything(),
        'ws_1',
        'thread_1',
        true,
      );
    });

    server.emitClose({ code: 1000, reason: 'tab switched' });
    expect(runner.readyState).toBe(WebSocket.OPEN);

    const completedAt = Date.now();
    runner.emitMessage({ type: 'streaming_state', isStreaming: false, completedAt });

    await vi.waitFor(() => {
      expect(recordWorkspaceThreadStreamingMock).toHaveBeenLastCalledWith(
        expect.anything(),
        'ws_1',
        'thread_1',
        false,
        { completedAt: expect.any(Number) },
      );
    });
    expect(runner.readyState).toBe(WebSocket.CLOSED);
  });

  it('syncs browser turn streaming state to ChatThreadDO', async () => {
    const { server, runner } = await startBridge();

    server.emitMessage({ type: 'message', content: 'Build it' });

    await vi.waitFor(() => {
      expect(setBrowserTurnStreamingMock).toHaveBeenCalledWith(true);
    });

    runner.emitMessage({ type: 'streaming_state', isStreaming: false });

    await vi.waitFor(() => {
      expect(setBrowserTurnStreamingMock).toHaveBeenLastCalledWith(false);
    });
  });

  it('syncs browser turn streaming false on runner error', async () => {
    const { server, runner } = await startBridge();

    server.emitMessage({ type: 'message', content: 'Build it' });

    await vi.waitFor(() => {
      expect(setBrowserTurnStreamingMock).toHaveBeenCalledWith(true);
    });

    runner.emitMessage({ type: 'error', error: 'failed' });

    await vi.waitFor(() => {
      expect(setBrowserTurnStreamingMock).toHaveBeenLastCalledWith(false);
    });
  });

  it('records active runner streaming_state completion without a completedAt timestamp as unread', async () => {
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
    await vi.waitFor(() => {
      expect(recordWorkspaceThreadStreamingMock).toHaveBeenNthCalledWith(
        2,
        expect.anything(),
        'ws_1',
        'thread_1',
        false,
        { completedAt: expect.any(Number) },
      );
    });
    await vi.waitFor(() => {
      expect(touchThreadActivityMock).toHaveBeenCalledWith(
        'thread_1',
        expect.any(Number),
      );
    });
  });

  it('records idle streaming_state false without a pending user turn as idle', async () => {
    const { runner } = await startBridge();

    runner.emitMessage({ type: 'streaming_state', isStreaming: false });

    expect(touchThreadActivityMock).not.toHaveBeenCalled();
    expect(recordWorkspaceThreadStreamingMock).toHaveBeenLastCalledWith(
      expect.anything(),
      'ws_1',
      'thread_1',
      false,
    );
  });

  it('passes the browser resume event id to the runner as lastSeq', async () => {
    const server = new FakeSocket();
    const runner = new FakeSocket();
    const runnerConnection = deferred<FakeSocket>();
    buildChatRunnerEnvMock.mockResolvedValue({ envVars: {}, byokProxy: null });
    connectChatWebSocketMock.mockReturnValue(runnerConnection.promise);

    const bridgePromise = bridgeChatSocket({
      server: server as unknown as WebSocket,
      env: createEnv() as never,
      orgId: 'org_1',
      workspaceId: 'ws_1',
      threadId: 'thread_1',
      userId: 'user_1',
      userName: 'Ada',
      userEmail: 'ada@example.com',
    });

    await vi.waitFor(() => {
      expect(connectChatWebSocketMock).toHaveBeenCalled();
    });
    server.emitMessage({ type: 'init', lastEventId: 42 });
    runnerConnection.resolve(runner);
    await bridgePromise;

    expect(JSON.parse(runner.sent[0])).toMatchObject({
      type: 'init',
      threadId: 'thread_1',
      lastSeq: 42,
    });
  });

  it('does not initialize a runner that connects after the browser closes', async () => {
    const server = new FakeSocket();
    const runner = new FakeSocket();
    const runnerConnection = deferred<FakeSocket>();
    buildChatRunnerEnvMock.mockResolvedValue({ envVars: {}, byokProxy: null });
    connectChatWebSocketMock.mockReturnValue(runnerConnection.promise);

    const bridgePromise = bridgeChatSocket({
      server: server as unknown as WebSocket,
      env: createEnv() as never,
      orgId: 'org_1',
      workspaceId: 'ws_1',
      threadId: 'thread_1',
      userId: 'user_1',
      userName: 'Ada',
      userEmail: 'ada@example.com',
    });

    await vi.waitFor(() => {
      expect(connectChatWebSocketMock).toHaveBeenCalled();
    });
    server.emitClose({ code: 1000, reason: 'tab switched' });
    runnerConnection.resolve(runner);
    await bridgePromise;

    expect(runner.sent).toEqual([]);
    expect(runner.readyState).toBe(WebSocket.CLOSED);
  });

  it('flushes a queued user message after browser disconnect and records completion', async () => {
    const server = new FakeSocket();
    const runner = new FakeSocket();
    const runnerConnection = deferred<FakeSocket>();
    buildChatRunnerEnvMock.mockResolvedValue({ envVars: {}, byokProxy: null });
    connectChatWebSocketMock.mockReturnValue(runnerConnection.promise);

    const bridgePromise = bridgeChatSocket({
      server: server as unknown as WebSocket,
      env: createEnv() as never,
      orgId: 'org_1',
      workspaceId: 'ws_1',
      threadId: 'thread_1',
      userId: 'user_1',
      userName: 'Ada',
      userEmail: 'ada@example.com',
    });

    await vi.waitFor(() => {
      expect(connectChatWebSocketMock).toHaveBeenCalled();
    });
    server.emitMessage({ type: 'message', content: 'Build it' });
    server.emitClose({ code: 1000, reason: 'tab switched' });
    runnerConnection.resolve(runner);
    await bridgePromise;

    expect(runner.readyState).toBe(WebSocket.OPEN);
    expect(runner.sent.map((message) => JSON.parse(message).type)).toEqual(['init', 'message']);
    await vi.waitFor(() => {
      expect(recordWorkspaceThreadStreamingMock).toHaveBeenCalledWith(
        expect.anything(),
        'ws_1',
        'thread_1',
        true,
      );
    });

    const completedAt = Date.now();
    runner.emitMessage({ type: 'streaming_state', isStreaming: false, completedAt });

    await vi.waitFor(() => {
      expect(recordWorkspaceThreadStreamingMock).toHaveBeenLastCalledWith(
        expect.anything(),
        'ws_1',
        'thread_1',
        false,
        { completedAt: expect.any(Number) },
      );
    });
  });

  it('forwards runner seq as browser eventId for the next reconnect', async () => {
    const { server, runner } = await startBridge();

    runner.emitMessage({
      type: 'runtime_event',
      seq: 43,
      event: { method: 'turn/completed', params: {} },
    });

    expect(JSON.parse(server.sent.at(-1) ?? '{}')).toMatchObject({
      type: 'runtime_event',
      seq: 43,
      eventId: 43,
    });
  });

  it('records assistant completion activity and unread status with a completedAt timestamp', async () => {
    const { runner } = await startBridge();
    const completedAt = Date.now();

    runner.emitMessage({ type: 'streaming_state', isStreaming: true });
    runner.emitMessage({ type: 'streaming_state', isStreaming: false, completedAt });

    await vi.waitFor(() => {
      expect(touchThreadActivityMock).toHaveBeenCalledWith(
        'thread_1',
        expect.any(Number),
      );
    });
    expect(recordWorkspaceThreadStreamingMock).toHaveBeenLastCalledWith(
      expect.anything(),
      'ws_1',
      'thread_1',
      false,
      { completedAt: expect.any(Number) },
    );
  });

  it('emits unread completion even when activity timestamp does not advance', async () => {
    touchThreadActivityMock.mockResolvedValue(false);
    const { runner } = await startBridge();
    const completedAt = Date.now();

    runner.emitMessage({ type: 'streaming_state', isStreaming: true });
    runner.emitMessage({ type: 'streaming_state', isStreaming: false, completedAt });

    await vi.waitFor(() => {
      expect(touchThreadActivityMock).toHaveBeenCalledWith(
        'thread_1',
        expect.any(Number),
      );
    });
    expect(recordWorkspaceThreadStreamingMock).toHaveBeenLastCalledWith(
      expect.anything(),
      'ws_1',
      'thread_1',
      false,
      { completedAt: expect.any(Number) },
    );
  });

  it('does not record stale completedAt frames as unread without an active turn', async () => {
    const { runner } = await startBridge();

    runner.emitMessage({
      type: 'streaming_state',
      isStreaming: false,
      completedAt: Date.now() - 10_000,
    });

    expect(touchThreadActivityMock).not.toHaveBeenCalled();
    expect(recordWorkspaceThreadStreamingMock).toHaveBeenLastCalledWith(
      expect.anything(),
      'ws_1',
      'thread_1',
      false,
    );
  });

  it('clears running status if a detached runner closes before sending completion', async () => {
    const { server, runner } = await startBridge();

    server.emitMessage({ type: 'message', content: 'Build it' });
    await vi.waitFor(() => {
      expect(recordWorkspaceThreadStreamingMock).toHaveBeenCalledWith(
        expect.anything(),
        'ws_1',
        'thread_1',
        true,
      );
    });
    server.emitClose({ code: 1000, reason: 'tab switched' });
    runner.emitClose({ code: 1000, reason: 'runner closed' });

    expect(recordWorkspaceThreadStreamingMock).toHaveBeenLastCalledWith(
      expect.anything(),
      'ws_1',
      'thread_1',
      false,
    );
  });
});
