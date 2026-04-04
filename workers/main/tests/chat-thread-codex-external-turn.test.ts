import { describe, expect, it, vi } from 'vitest';
import { ChatThreadDO } from '../src/durable-objects';

describe('ChatThreadDO Codex external turn completion', () => {
  it('waits for the final result event instead of resolving on turn/completed', () => {
    const resolve = vi.fn();
    const fake = Object.create(ChatThreadDO.prototype) as any;

    fake.lastRunnerSeq = 0;
    fake.runnerActivityGeneration = 0;
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
    fake.persistRunnerSeqIfNeeded = vi.fn();
    fake.setChatIsStreaming = vi.fn();
    fake.applyPersistedRunnerEvent = vi.fn();
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
});
