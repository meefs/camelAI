import { describe, expect, it, vi } from 'vitest';
import { ChatThreadDO } from '../src/durable-objects';

describe('ChatThreadDO Codex external turn completion', () => {
  it('persists and broadcasts todo state from direct runner events', async () => {
    const put = vi.fn();
    const deleteKey = vi.fn();
    const sent: string[] = [];
    const fake = Object.create(ChatThreadDO.prototype) as any;

    fake.currentTodos = [];
    fake.ctx = {
      storage: { kv: { put, delete: deleteKey } },
      getWebSockets: vi.fn(() => [{ send: vi.fn((message: string) => sent.push(message)) }]),
    };
    fake.trace = vi.fn();

    await ChatThreadDO.prototype.setTodoState.call(fake, [
      { content: 'Check state', status: 'in_progress' },
    ]);

    expect(put).toHaveBeenCalledWith('chatTodos', [
      { content: 'Check state', status: 'in_progress' },
    ]);
    expect(sent.map((message) => JSON.parse(message))).toContainEqual({
      type: 'todo_state',
      todos: [{ content: 'Check state', status: 'in_progress' }],
    });

    await ChatThreadDO.prototype.setTodoState.call(fake, []);

    expect(deleteKey).toHaveBeenCalledWith('chatTodos');
  });

  it('waits for the final result event instead of resolving on turn/completed', () => {
    const resolve = vi.fn();
    const fake = Object.create(ChatThreadDO.prototype) as any;

    fake.lastRunnerSeq = 0;
    fake.pendingQuestions = new Map();
    fake.pendingExternalTurn = {
      resolve,
      streamingText: '',
      latestAssistantText: '',
    };
    fake.ctx = {
      storage: { kv: { put: vi.fn() } },
      waitUntil: vi.fn(),
    };
    fake.trace = vi.fn();
    fake.setChatIsStreaming = vi.fn();
    fake.pushChatEvent = vi.fn();
    fake.resolvePendingExternalTurn = ChatThreadDO.prototype['resolvePendingExternalTurn'];

    ChatThreadDO.prototype['handleRunnerEvent'].call(fake, {
      type: 'runtime_event',
      event: { method: 'turn/completed' },
    });

    expect(resolve).not.toHaveBeenCalled();
    expect(fake.pendingExternalTurn).not.toBeNull();

    ChatThreadDO.prototype['handleRunnerEvent'].call(fake, {
      type: 'result',
      result: 'final reply',
    });

    expect(resolve).toHaveBeenCalledWith({
      status: 'result',
      reply: 'final reply',
    });
    expect(fake.pendingExternalTurn).toBeNull();
  });

  it('clears persisted incomplete todos when a turn completes', () => {
    const resolve = vi.fn();
    const deleteKey = vi.fn();
    const sent: string[] = [];
    const fake = Object.create(ChatThreadDO.prototype) as any;

    fake.lastRunnerSeq = 0;
    fake.currentTodos = [{ content: 'Ship fix', status: 'in_progress' }];
    fake.pendingQuestions = new Map();
    fake.pendingExternalTurn = {
      resolve,
      streamingText: '',
      latestAssistantText: '',
    };
    fake.ctx = {
      storage: { kv: { put: vi.fn(), delete: deleteKey } },
      waitUntil: vi.fn(),
      getWebSockets: vi.fn(() => [{ send: vi.fn((message: string) => sent.push(message)) }]),
    };
    fake.trace = vi.fn();
    fake.setChatIsStreaming = vi.fn();
    fake.setActiveTurnUserId = vi.fn();
    fake.pushChatEvent = vi.fn();
    fake.resolvePendingExternalTurn = ChatThreadDO.prototype['resolvePendingExternalTurn'];

    ChatThreadDO.prototype['handleRunnerEvent'].call(fake, {
      type: 'runtime_event',
      event: { method: 'turn/completed' },
    });

    expect(fake.currentTodos).toEqual([]);
    expect(deleteKey).toHaveBeenCalledWith('chatTodos');
    expect(sent.map((message) => JSON.parse(message))).toContainEqual({
      type: 'todo_state',
      todos: [],
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('dedupes replayed runner events by sequence', () => {
    const resolve = vi.fn();
    const fake = Object.create(ChatThreadDO.prototype) as any;

    fake.lastRunnerSeq = 5;
    fake.pendingQuestions = new Map();
    fake.pendingExternalTurn = {
      resolve,
      streamingText: '',
      latestAssistantText: '',
    };
    fake.ctx = {
      storage: { kv: { put: vi.fn() } },
    };
    fake.trace = vi.fn();
    fake.setChatIsStreaming = vi.fn();
    fake.setActiveTurnUserId = vi.fn();
    fake.clearIncompleteTodoStateOnTurnCompletion = vi.fn();
    fake.pushChatEvent = vi.fn();
    fake.resolvePendingExternalTurn = ChatThreadDO.prototype['resolvePendingExternalTurn'];

    ChatThreadDO.prototype['handleRunnerEvent'].call(fake, {
      type: 'result',
      seq: 5,
      result: 'stale reply',
    });

    expect(resolve).not.toHaveBeenCalled();
    expect(fake.pendingExternalTurn).not.toBeNull();

    ChatThreadDO.prototype['handleRunnerEvent'].call(fake, {
      type: 'result',
      seq: 6,
      result: 'fresh reply',
    });

    expect(resolve).toHaveBeenCalledWith({
      status: 'result',
      reply: 'fresh reply',
    });
    expect(fake.lastRunnerSeq).toBe(6);
  });

  it('persists the last seen runner sequence', () => {
    const put = vi.fn();
    const fake = Object.create(ChatThreadDO.prototype) as any;

    fake.lastRunnerSeq = 0;
    fake.pendingQuestions = new Map();
    fake.pendingExternalTurn = null;
    fake.ctx = {
      storage: { kv: { put } },
    };
    fake.trace = vi.fn();
    fake.pushChatEvent = vi.fn();

    ChatThreadDO.prototype['handleRunnerEvent'].call(fake, {
      type: 'todo_state',
      seq: 9,
      todos: [],
    });

    expect(fake.lastRunnerSeq).toBe(9);
    expect(put).toHaveBeenCalledWith('chatRunnerLastSeq', 9);
  });

  it('clears pending questions when the runner disconnects', () => {
    const sent: string[] = [];
    const fake = Object.create(ChatThreadDO.prototype) as any;

    fake.pendingQuestions = new Map([
      ['question1', { questionId: 'question1', questions: [] }],
      ['question2', { questionId: 'question2', questions: [] }],
    ]);
    fake.ctx = {
      storage: { kv: { put: vi.fn() } },
      getWebSockets: vi.fn(() => [{ send: vi.fn((message: string) => sent.push(message)) }]),
    };
    fake.chatContext = { threadId: 'thread1' };
    fake.nextChatEventId = 1;
    fake.chatEventBuffer = [];
    fake.trace = vi.fn();

    ChatThreadDO.prototype['clearPendingQuestions'].call(fake, 'runner_socket_close');

    expect(fake.pendingQuestions.size).toBe(0);
    expect(sent.map((message) => JSON.parse(message))).toEqual([
      expect.objectContaining({
        type: 'question_answered',
        questionId: 'question1',
      }),
      expect.objectContaining({
        type: 'question_answered',
        questionId: 'question2',
      }),
    ]);
  });

  it('applies connection mention context before sending external turns', async () => {
    const workspaceStub = {
      getIntegrations: vi.fn().mockResolvedValue([
        {
          id: 'conn1',
          integration_type: 'postgres',
          name: 'Sales DB',
          created_at: 1,
          config: '{}',
        },
      ]),
    };
    const sentCommands: any[] = [];
    const fake = Object.create(ChatThreadDO.prototype) as any;

    fake.chatContext = null;
    fake.chatIsStreaming = false;
    fake.pendingExternalTurn = null;
    fake.pendingQuestions = new Map();
    fake.ctx = {
      storage: { kv: { put: vi.fn() } },
      waitUntil: vi.fn(),
    };
    fake.env = {
      APP_KV: { get: vi.fn().mockResolvedValue(null) },
      WORKSPACE: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn(() => workspaceStub),
      },
    };
    fake.trace = vi.fn();
    fake.ensureRunnerConnected = vi.fn().mockResolvedValue(undefined);
    fake.sendRunnerCommand = vi.fn((command: any) => {
      sentCommands.push(command);
      return false;
    });
    fake.createPendingExternalTurn = ChatThreadDO.prototype['createPendingExternalTurn'];
    fake.resolvePendingExternalTurn = ChatThreadDO.prototype['resolvePendingExternalTurn'];
    fake.waitForPendingExternalTurn = ChatThreadDO.prototype['waitForPendingExternalTurn'];

    const result = await ChatThreadDO.prototype.externalMessage.call(fake, {
      threadId: 'thread1',
      workspaceId: 'workspace1',
      orgId: 'org1',
      userName: 'Ada',
      message: 'Use @sales_db',
      timeoutMs: 5_000,
    });

    expect(result).toEqual({
      status: 'error',
      error: 'Failed to send message to sandbox',
    });
    expect(workspaceStub.getIntegrations).toHaveBeenCalledTimes(1);
    expect(sentCommands).toHaveLength(1);
    expect(sentCommands[0].content).toContain('<camelai system message>');
    expect(sentCommands[0].content).toContain('Available connections');
    expect(sentCommands[0].content).toContain(
      '@sales_db ⟦ref: postgres "Sales DB" id=conn1⟧',
    );
    expect(sentCommands[0].content).toContain(
      '[Ada]: Use @sales_db ⟦ref: postgres "Sales DB" id=conn1⟧',
    );
  });
});
