import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatThreadDO, CodeModeToolsBinding, prepareCodeModeUserCode } from '../src/chat-thread-do';
import { BrowserPromptCoordinator } from '../src/chat-thread-browser-prompts';
import { CamelAiService } from '../src/camelai-service';
import { encryptCredentials } from '../../../src/lib/integration-crypto';

afterEach(() => {
  vi.unstubAllGlobals();
});

function r2Object(content: string, contentType: string) {
  const bytes = new TextEncoder().encode(content);
  return {
    size: bytes.byteLength,
    httpMetadata: { contentType },
    arrayBuffer: async () => bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ),
  };
}

describe('ChatThreadDO Codex turn handling', () => {
  function createPiEventFake() {
    const events: any[] = [];
    const activityRecords: any[] = [];
    const workspaceStub = {
      recordThreadStreaming: vi.fn(async (...args: any[]) => {
        activityRecords.push(args);
      }),
    };
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.chatContext = {
      threadId: 'thread1',
      workspaceId: 'workspace1',
      orgId: 'org1',
      userId: 'user1',
    };
    fake.env = {
      WORKSPACE: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => workspaceStub),
      },
    };
    fake.ctx = { waitUntil: vi.fn() };
    fake.piActiveItemId = null;
    fake.piActiveItemText = '';
    fake.piReasoningItemId = null;
    fake.piToolArgs = new Map();
    fake.piAssistantText = '';
    fake.touchPiTurnRecovery = vi.fn();
    fake.setChatIsStreaming = vi.fn();
    fake.appendPiCoreMessagesIfMissing = vi.fn();
    fake.upsertPiCoreMessages = vi.fn();
    fake.appendPiInFlightMessages = vi.fn();
    fake.loadPiInFlightMessages = vi.fn(() => []);
    fake.clearPiInFlightMessages = vi.fn();
    fake.setActiveTurnUserId = vi.fn();
    fake.clearPiTurnRecovery = vi.fn();
    fake.completeTodoStateForTurnEnd = vi.fn();
    fake.recordChatThreadObservabilityEvent = vi.fn();
    fake.pushChatEvent = vi.fn((event: any) => events.push(event));
    return { fake, events, activityRecords, workspaceStub };
  }

  async function flushWaitUntil(fake: any) {
    await Promise.all(
      fake.ctx.waitUntil.mock.calls
        .map(([promise]: [Promise<unknown>]) => promise)
        .filter(Boolean),
    );
  }

  it('resolves legacy-prefixed model ids before selecting the Pi model', () => {
    const result = ChatThreadDO.prototype['resolvePiModelReference'].call(
      Object.create(ChatThreadDO.prototype),
      'codex/kimi-k2.6',
    );

    expect(result).toEqual({
      provider: 'openrouter',
      modelId: '~moonshotai/kimi-latest',
      hostedGatewayProvider: 'openrouter',
      hostedModelId: '~moonshotai/kimi-latest:nitro',
    });
  });

  it('keeps hosted Claude on Anthropic Messages while routing through OpenRouter AI Gateway', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.env = {
      CF_ACCOUNT_ID: 'acct_1',
      CF_GATEWAY_NAME: 'gateway_1',
      AI_GATEWAY_AUTH_TOKEN: 'cf-token',
    };
    fake.chatContext = {
      orgId: 'org1',
      workspaceId: 'workspace1',
      threadId: 'thread1',
    };
    fake.resolveCurrentByokCredentials = vi.fn(async () => null);
    fake.checkHostedPiModelAccess = vi.fn(async () => true);

    const model = await ChatThreadDO.prototype['resolvePiModel'].call(
      fake,
      { provider: 'claude', orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
      { CHIRIDION_CLAUDE_MODEL: 'sonnet' },
      vi.fn(() => ({
        id: 'claude-sonnet-4-6',
        provider: 'anthropic',
        api: 'anthropic-messages',
        baseUrl: 'https://api.anthropic.com',
      })),
    );

    expect(model.model).toMatchObject({
      id: 'anthropic/claude-sonnet-4.6:nitro',
      provider: 'cloudflare-ai-gateway',
      api: 'anthropic-messages',
      baseUrl: 'https://gateway.ai.cloudflare.com/v1/acct_1/gateway_1/openrouter',
    });
    expect(model.apiKey).toBe('cf-token');
    expect(model.provider).toBe('anthropic');
    expect(model.billingSource).toBe('hosted');
    expect(fake.piCurrentUsageProvider).toBe('openrouter');
  });

  it('sends initial user messages after connecting the runner', async () => {
    const sentCommands: any[] = [];
    const fake = Object.create(ChatThreadDO.prototype) as any;

    fake.chatContext = null;
    fake.chatIsStreaming = false;
    fake.ctx = {
      storage: { kv: { put: vi.fn(), delete: vi.fn() } },
      waitUntil: vi.fn(),
    };
    fake.env = {
      APP_KV: { get: vi.fn().mockResolvedValue(null) },
      WORKSPACE: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({ recordThreadStreaming: vi.fn(async () => {}) })),
      },
    };
    fake.recordChatThreadObservabilityEvent = vi.fn();
    fake.setActiveTurnUserId = vi.fn();
    fake.setChatIsStreaming = vi.fn((value: boolean) => {
      fake.chatIsStreaming = value;
    });
    fake.broadcastRunnerClients = vi.fn();
    fake.emitChatError = vi.fn();
    fake.ensureRunnerConnected = vi.fn(async () => undefined);
    fake.applyConnectionMentionsForTurn = vi.fn(async (content: string) => content);
    fake.updateThreadMetadataForUserMessage = vi.fn(async () => {});
    fake.warmWorkspaceContainerForTurn = vi.fn(async () => undefined);
    fake.sendRunnerCommand = vi.fn((command: any) => {
      sentCommands.push(command);
      return true;
    });

    const result = await ChatThreadDO.prototype.startInitialUserMessage.call(fake, {
      threadId: 'thread1',
      workspaceId: 'workspace1',
      orgId: 'org1',
      userId: 'user1',
      message: 'hello',
      clientMessageId: 'initial:thread1',
    });

    expect(result).toEqual({ status: 'accepted' });
    expect(fake.ensureRunnerConnected).toHaveBeenCalledTimes(1);
    expect(fake.setChatIsStreaming).toHaveBeenCalledWith(true);
    expect(fake.warmWorkspaceContainerForTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'thread1',
        workspaceId: 'workspace1',
        orgId: 'org1',
      }),
    );
    expect(sentCommands).toHaveLength(1);
    expect(sentCommands[0]).toMatchObject({
      type: 'message',
      threadId: 'thread1',
      userId: 'user1',
      clientMessageId: 'initial:thread1',
    });
    expect(sentCommands[0].content).toContain('hello');
  });

  it('accepts follow-up user messages while the thread is already streaming', async () => {
    const sentCommands: any[] = [];
    const fake = Object.create(ChatThreadDO.prototype) as any;

    fake.chatContext = {
      threadId: 'thread1',
      workspaceId: 'workspace1',
      orgId: 'org1',
      userId: 'user1',
      userName: 'Miguel',
      userEmail: 'miguel@example.com',
    };
    fake.chatIsStreaming = true;
    fake.ctx = {
      storage: { kv: { put: vi.fn(), delete: vi.fn() } },
      waitUntil: vi.fn(),
    };
    fake.env = {
      APP_KV: { get: vi.fn().mockResolvedValue(null) },
      WORKSPACE: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({ recordThreadStreaming: vi.fn(async () => {}) })),
      },
    };
    fake.recordChatThreadObservabilityEvent = vi.fn();
    fake.setActiveTurnUserId = vi.fn();
    fake.setChatIsStreaming = vi.fn((value: boolean) => {
      fake.chatIsStreaming = value;
    });
    fake.publishRunningUserMessageActivity = vi.fn();
    fake.broadcastRunnerClients = vi.fn();
    fake.ensureRunnerConnected = vi.fn(async () => undefined);
    fake.applyConnectionMentionsForTurn = vi.fn(async (content: string) => content);
    fake.updateThreadMetadataForUserMessage = vi.fn(async () => {});
    fake.warmWorkspaceContainerForTurn = vi.fn(async () => undefined);
    fake.sendRunnerCommand = vi.fn((command: any) => {
      sentCommands.push(command);
      return true;
    });

    const result = await ChatThreadDO.prototype['enqueueRunnerUserMessage'].call(fake, {
      type: 'message',
      content: 'please also add tests',
      clientMessageId: 'client_followup_1',
    });

    expect(result).toEqual({ status: 'accepted' });
    expect(fake.ensureRunnerConnected).toHaveBeenCalledTimes(1);
    expect(fake.setChatIsStreaming).toHaveBeenCalledWith(true);
    expect(fake.publishRunningUserMessageActivity).toHaveBeenCalledWith(
      'please also add tests',
    );
    expect(sentCommands).toHaveLength(1);
    expect(sentCommands[0]).toMatchObject({
      type: 'message',
      threadId: 'thread1',
      userId: 'user1',
      clientMessageId: 'client_followup_1',
    });
    expect(sentCommands[0].content).toContain('please also add tests');
  });

  it('records terminal browser message send observability for accepted messages', async () => {
    const ws = { send: vi.fn() };
    const fake = Object.create(ChatThreadDO.prototype) as any;
    let resolveEnqueue: (value: { status: 'accepted' }) => void = () => {};
    const enqueuePromise = new Promise<{ status: 'accepted' }>((resolve) => {
      resolveEnqueue = resolve;
    });
    fake.recordChatThreadObservabilityEvent = vi.fn();
    fake.enqueueRunnerUserMessage = vi.fn(() => enqueuePromise);
    fake.sendDirect = vi.fn((socket: any, message: any) => socket.send(message));

    const handlePromise = ChatThreadDO.prototype['handleRunnerClientUserMessage'].call(fake, ws, {
      type: 'message',
      content: 'hello',
      clientMessageId: 'client-msg-1',
    });

    await Promise.resolve();

    expect(ws.send).toHaveBeenCalledWith({
      type: 'message_accepted',
      clientMessageId: 'client-msg-1',
    });

    resolveEnqueue({ status: 'accepted' });
    await handlePromise;

    expect(fake.enqueueRunnerUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({ clientMessageId: 'client-msg-1' }),
      expect.objectContaining({
        sendAttemptId: 'client-msg-1',
        startedAt: expect.any(Number),
      }),
    );
    expect(fake.recordChatThreadObservabilityEvent).toHaveBeenCalledWith(
      'runner_user_message_send_attempt',
      expect.objectContaining({
        operation: 'received',
        status: 'started',
        sampleKey: 'client-msg-1',
      }),
    );
    expect(fake.recordChatThreadObservabilityEvent).toHaveBeenCalledWith(
      'runner_user_message_send_attempt',
      expect.objectContaining({
        operation: 'enqueue_runner_user_message',
        status: 'accepted',
        sampleKey: 'client-msg-1',
      }),
    );
    expect(ws.send).toHaveBeenCalledTimes(1);
    expect(ws.send).toHaveBeenCalledWith({
      type: 'message_accepted',
      clientMessageId: 'client-msg-1',
    });
  });

  it('records thrown browser message send attempts and notifies the client', async () => {
    const ws = { send: vi.fn() };
    const fake = Object.create(ChatThreadDO.prototype) as any;
    const error = new Error('connection dropped');
    fake.recordChatThreadObservabilityEvent = vi.fn();
    fake.enqueueRunnerUserMessage = vi.fn(async () => {
      throw error;
    });
    fake.setChatIsStreaming = vi.fn();
    fake.setActiveTurnUserId = vi.fn();
    fake.sendDirect = vi.fn((socket: any, message: any) => socket.send(message));

    await ChatThreadDO.prototype['handleRunnerClientUserMessage'].call(fake, ws, {
      type: 'message',
      content: 'hello',
      clientMessageId: 'client-msg-2',
    });

    expect(ws.send).toHaveBeenCalledWith({
      type: 'message_accepted',
      clientMessageId: 'client-msg-2',
    });
    expect(fake.setChatIsStreaming).toHaveBeenCalledWith(false);
    expect(fake.setActiveTurnUserId).toHaveBeenCalledWith(null);
    expect(fake.recordChatThreadObservabilityEvent).toHaveBeenCalledWith(
      'runner_user_message_send_attempt',
      expect.objectContaining({
        operation: 'enqueue_runner_user_message',
        status: 'exception',
        severity: 'error',
        sampleKey: 'client-msg-2',
        error,
      }),
    );
    expect(ws.send).toHaveBeenCalledWith({
      type: 'error',
      error: 'Failed to send message to sandbox',
    });
  });

  it('records enqueue stage exceptions before rethrowing', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    const error = new Error('runner unavailable');
    fake.chatContext = {
      threadId: 'thread1',
      workspaceId: 'workspace1',
      orgId: 'org1',
      userId: 'user1',
      userName: 'User One',
      userEmail: 'user@example.com',
    };
    fake.chatIsStreaming = false;
    fake.env = {
      APP_KV: { get: vi.fn().mockResolvedValue(null) },
    };
    fake.recordChatThreadObservabilityEvent = vi.fn();
    fake.ensureRunnerConnected = vi.fn(async () => {
      throw error;
    });

    await expect(
      ChatThreadDO.prototype['enqueueRunnerUserMessage'].call(
        fake,
        {
          type: 'message',
          content: 'hello',
          clientMessageId: 'client-msg-3',
        },
        { sendAttemptId: 'client-msg-3', startedAt: Date.now() },
      ),
    ).rejects.toThrow('runner unavailable');

    expect(fake.recordChatThreadObservabilityEvent).toHaveBeenCalledWith(
      'runner_user_message_enqueue',
      expect.objectContaining({
        operation: 'ensure_runner_connected',
        status: 'exception',
        severity: 'error',
        sampleKey: 'client-msg-3',
        error,
      }),
    );
  });

  it('keeps hosted OpenAI models on Responses while routing through OpenRouter AI Gateway', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.env = {
      CF_ACCOUNT_ID: 'acct_1',
      CF_GATEWAY_NAME: 'gateway_1',
      AI_GATEWAY_AUTH_TOKEN: 'cf-token',
    };
    fake.chatContext = {
      orgId: 'org1',
      workspaceId: 'workspace1',
      threadId: 'thread1',
    };
    fake.resolveCurrentByokCredentials = vi.fn(async () => null);
    fake.checkHostedPiModelAccess = vi.fn(async () => true);

    const model = await ChatThreadDO.prototype['resolvePiModel'].call(
      fake,
      { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
      { CHIRIDION_CODEX_MODEL: 'gpt-5.5' },
      vi.fn(() => ({
        id: 'gpt-5.5',
        provider: 'openai',
        api: 'openai-responses',
        baseUrl: 'https://api.openai.com/v1',
      })),
    );

    expect(model.model).toMatchObject({
      id: 'gpt-5.5:nitro',
      provider: 'cloudflare-ai-gateway',
      api: 'openai-responses',
      baseUrl: 'https://gateway.ai.cloudflare.com/v1/acct_1/gateway_1/openrouter',
    });
    expect(fake.piCurrentUsageProvider).toBe('openrouter');
  });

  it('uses the Responses API shape for Grok while routing through OpenRouter AI Gateway', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.env = {
      CF_ACCOUNT_ID: 'acct_1',
      CF_GATEWAY_NAME: 'gateway_1',
      AI_GATEWAY_AUTH_TOKEN: 'cf-token',
    };
    fake.chatContext = {
      orgId: 'org1',
      workspaceId: 'workspace1',
      threadId: 'thread1',
    };
    fake.resolveCurrentByokCredentials = vi.fn(async () => null);
    fake.checkHostedPiModelAccess = vi.fn(async () => true);

    const model = await ChatThreadDO.prototype['resolvePiModel'].call(
      fake,
      { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
      { CHIRIDION_CODEX_MODEL: 'grok-4.3' },
      vi.fn(() => ({
        id: 'x-ai/grok-4.3',
        provider: 'openrouter',
        api: 'openai-completions',
        baseUrl: 'https://openrouter.ai/api/v1',
      })),
    );

    expect(model.model).toMatchObject({
      id: 'x-ai/grok-4.3:nitro',
      provider: 'cloudflare-ai-gateway',
      api: 'openai-responses',
      baseUrl: 'https://gateway.ai.cloudflare.com/v1/acct_1/gateway_1/openrouter',
    });
    expect(fake.piCurrentUsageProvider).toBe('openrouter');
  });

  it.each(['gemini-3.5-flash', 'gemini-3.1-pro-preview'])(
    'uses local Pi model metadata for %s when the upstream Pi catalog is missing Gemini 3.5 Flash',
    async (requestedModel) => {
      const fake = Object.create(ChatThreadDO.prototype) as any;
      fake.env = {
        CF_ACCOUNT_ID: 'acct_1',
        CF_GATEWAY_NAME: 'gateway_1',
        AI_GATEWAY_AUTH_TOKEN: 'cf-token',
      };
      fake.chatContext = {
        orgId: 'org1',
        workspaceId: 'workspace1',
        threadId: 'thread1',
      };
      fake.resolveCurrentByokCredentials = vi.fn(async () => null);
      fake.checkHostedPiModelAccess = vi.fn(async () => true);

      const getModel = vi.fn(() => undefined);
      const model = await ChatThreadDO.prototype['resolvePiModel'].call(
        fake,
        { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
        { CHIRIDION_CODEX_MODEL: requestedModel },
        getModel,
      );

      expect(getModel).toHaveBeenCalledWith(
        'openrouter',
        'google/gemini-3.5-flash',
      );
      expect(model.model).toMatchObject({
        id: 'google/gemini-3.5-flash',
        provider: 'cloudflare-ai-gateway',
        api: 'openai-completions',
        baseUrl: 'https://gateway.ai.cloudflare.com/v1/acct_1/gateway_1/openrouter',
        cost: {
          input: 1.5,
          output: 9,
          cacheRead: 0.15,
          cacheWrite: 0.08333333333333334,
        },
        contextWindow: 1048576,
        maxTokens: 65536,
      });
      expect(model.apiKey).toBe('cf-token');
      expect(model.provider).toBe('openrouter');
      expect(model.modelId).toBe('google/gemini-3.5-flash');
      expect(model.billingSource).toBe('hosted');
      expect(model.usageProvider).toBe('openrouter');
      expect(fake.piCurrentUsageProvider).toBe('openrouter');
    },
  );

  it('uses OpenRouter BYOK for Pi models supported through OpenRouter', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.env = {};
    fake.resolveCurrentByokCredentials = vi.fn(async () => ({
      provider: 'openrouter',
      apiKey: 'sk-or-test',
    }));
    fake.checkHostedPiModelAccess = vi.fn(async () => {
      throw new Error('hosted billing should not be checked for BYOK');
    });
    fake.openRouterAttributionHeaders = ChatThreadDO.prototype['openRouterAttributionHeaders'];

    const model = await ChatThreadDO.prototype['resolvePiModel'].call(
      fake,
      { provider: 'claude', orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
      { CHIRIDION_CLAUDE_MODEL: 'sonnet' },
      vi.fn(() => ({
        id: 'claude-sonnet-4-6',
        provider: 'anthropic',
        api: 'anthropic-messages',
        baseUrl: 'https://api.anthropic.com',
      })),
    );

    expect(model.model).toMatchObject({
      id: 'anthropic/claude-sonnet-4.6:nitro',
      provider: 'anthropic',
      api: 'anthropic-messages',
      baseUrl: 'https://openrouter.ai/api',
    });
    expect(model.apiKey).toBe('sk-or-test');
    expect(model.billingSource).toBe('byok');
    expect(model.creditChargeable).toBe(false);
    expect(model.usageProvider).toBe('openrouter');
    expect(fake.checkHostedPiModelAccess).not.toHaveBeenCalled();
  });

  it('uses Anthropic BYOK directly for Claude Pi models', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.env = {};
    fake.resolveCurrentByokCredentials = vi.fn(async () => ({
      provider: 'anthropic',
      apiKey: 'sk-ant-test',
    }));
    fake.checkHostedPiModelAccess = vi.fn(async () => {
      throw new Error('hosted billing should not be checked for BYOK');
    });

    const model = await ChatThreadDO.prototype['resolvePiModel'].call(
      fake,
      { provider: 'claude', orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
      { CHIRIDION_CLAUDE_MODEL: 'sonnet' },
      vi.fn(() => ({
        id: 'claude-sonnet-4-6',
        provider: 'anthropic',
        api: 'anthropic-messages',
        baseUrl: 'https://api.anthropic.com',
      })),
    );

    expect(model.model).toMatchObject({
      id: 'claude-sonnet-4-6',
      provider: 'anthropic',
      api: 'anthropic-messages',
      baseUrl: 'https://api.anthropic.com',
    });
    expect(model.apiKey).toBe('sk-ant-test');
    expect(model.billingSource).toBe('byok');
    expect(model.usageProvider).toBe('anthropic');
    expect(fake.checkHostedPiModelAccess).not.toHaveBeenCalled();
  });

  it('fails loudly when Pi model metadata is missing', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;

    await expect(
      ChatThreadDO.prototype['resolvePiModel'].call(
        fake,
        { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
        { CHIRIDION_CLAUDE_MODEL: 'sonnet' },
        vi.fn(),
      ),
    ).rejects.toThrow('Unsupported Pi model sonnet');
  });

  it('loads the model from the thread record when initializing Pi', async () => {
    const orgStub = {
      getThread: vi.fn(async () => ({
        id: 'thread1',
        model: 'sonnet',
        workspace_id: 'workspace1',
      })),
      getLlmProviderConfig: vi.fn(async () => null),
    };
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.chatContext = {
      threadId: 'thread1',
      workspaceId: 'workspace1',
      orgId: 'org1',
      userId: 'user1',
    };
    fake.env = {
      ORG: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn(() => orgStub),
      },
    };
    fake.ctx = {
      storage: { kv: { put: vi.fn() } },
    };
    fake.runnerConnectPromise = null;
    fake.runnerTransitionChain = Promise.resolve();
    fake.codexSessionId = null;
    fake.lastRunnerSeq = 0;
    fake.trace = vi.fn();
    fake.getLegacyClaudeSessionId = vi.fn(() => null);
    fake.ensurePiSession = vi.fn(async () => undefined);

    await ChatThreadDO.prototype['ensureRunnerConnected'].call(fake);

    expect(fake.ensurePiSession).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'thread1' }),
      expect.objectContaining({
        CHIRIDION_MODEL: 'sonnet',
        CHIRIDION_CLAUDE_MODEL: 'sonnet',
        CHIRIDION_CODEX_MODEL: 'sonnet',
      }),
    );
  });

  it('preserves an existing thread model when org BYOK provider is incompatible', async () => {
    const orgStub = {
      getThread: vi.fn(async () => ({
        id: 'thread1',
        model: 'sonnet',
        workspace_id: 'workspace1',
      })),
      getLlmProviderConfig: vi.fn(async () => ({ provider: 'openai' })),
    };
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.chatContext = {
      threadId: 'thread1',
      workspaceId: 'workspace1',
      orgId: 'org1',
      userId: 'user1',
    };
    fake.env = {
      ORG: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn(() => orgStub),
      },
    };
    fake.ctx = {
      storage: { kv: { put: vi.fn() } },
    };
    fake.runnerConnectPromise = null;
    fake.runnerTransitionChain = Promise.resolve();
    fake.codexSessionId = null;
    fake.lastRunnerSeq = 0;
    fake.trace = vi.fn();
    fake.getLegacyClaudeSessionId = vi.fn(() => null);
    fake.ensurePiSession = vi.fn(async () => undefined);

    await ChatThreadDO.prototype['ensureRunnerConnected'].call(fake);

    expect(fake.ensurePiSession).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'thread1' }),
      expect.objectContaining({
        CHIRIDION_MODEL: 'sonnet',
        CHIRIDION_CLAUDE_MODEL: 'sonnet',
        CHIRIDION_CODEX_MODEL: 'sonnet',
      }),
    );
  });

  it('uses OpenAI BYOK directly for OpenAI Pi models', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.env = {};
    fake.resolveCurrentByokCredentials = vi.fn(async () => ({
      provider: 'openai',
      apiKey: 'sk-openai-test',
    }));
    fake.checkHostedPiModelAccess = vi.fn(async () => {
      throw new Error('hosted billing should not be checked for BYOK');
    });

    const model = await ChatThreadDO.prototype['resolvePiModel'].call(
      fake,
      { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
      { CHIRIDION_CODEX_MODEL: 'gpt-5.5' },
      vi.fn(() => ({
        id: 'gpt-5.5',
        provider: 'openai',
        api: 'openai-responses',
        baseUrl: 'https://api.openai.com/v1',
      })),
    );

    expect(model.model).toMatchObject({
      id: 'gpt-5.5',
      provider: 'openai',
      api: 'openai-responses',
      baseUrl: 'https://api.openai.com/v1',
    });
    expect(model.apiKey).toBe('sk-openai-test');
    expect(model.billingSource).toBe('byok');
    expect(model.usageProvider).toBe('openai');
    expect(fake.checkHostedPiModelAccess).not.toHaveBeenCalled();
  });

  it('uses Bedrock BYOK through Pi amazon-bedrock models for Claude Pi models', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.env = {};
    fake.resolveCurrentByokCredentials = vi.fn(async () => ({
      provider: 'bedrock',
      apiKey: 'bedrock-token',
      awsRegion: 'us-west-2',
    }));
    fake.checkHostedPiModelAccess = vi.fn(async () => {
      throw new Error('hosted billing should not be checked for BYOK');
    });
    const getModel = vi.fn((provider: string, id: string) => ({
      id,
      provider,
      api: provider === 'amazon-bedrock' ? 'bedrock-converse-stream' : 'anthropic-messages',
      baseUrl: provider === 'amazon-bedrock'
        ? 'https://bedrock-runtime.us-east-1.amazonaws.com'
        : 'https://api.anthropic.com',
    }));

    const model = await ChatThreadDO.prototype['resolvePiModel'].call(
      fake,
      { provider: 'claude', orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
      { CHIRIDION_CLAUDE_MODEL: 'sonnet' },
      getModel,
    );

    expect(getModel).toHaveBeenCalledWith('amazon-bedrock', 'global.anthropic.claude-sonnet-4-6');
    expect(model.model).toMatchObject({
      id: 'global.anthropic.claude-sonnet-4-6',
      provider: 'amazon-bedrock',
      api: 'bedrock-converse-stream',
      baseUrl: 'https://bedrock-runtime.us-west-2.amazonaws.com',
    });
    expect(model.apiKey).toBe('bedrock-token');
    expect(model.billingSource).toBe('byok');
    expect(model.usageProvider).toBe('bedrock');
    expect(fake.checkHostedPiModelAccess).not.toHaveBeenCalled();
  });

  it('uses the local Bedrock fallback model for BYOK Opus 4.8 when Pi catalog lags', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.env = {};
    fake.resolveCurrentByokCredentials = vi.fn(async () => ({
      provider: 'bedrock',
      apiKey: 'bedrock-token',
      awsRegion: 'us-west-2',
    }));
    fake.checkHostedPiModelAccess = vi.fn(async () => {
      throw new Error('hosted billing should not be checked for BYOK');
    });
    const getModel = vi.fn(() => undefined);

    const model = await ChatThreadDO.prototype['resolvePiModel'].call(
      fake,
      { provider: 'claude', orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
      { CHIRIDION_CLAUDE_MODEL: 'opus-4.8' },
      getModel,
    );

    expect(getModel).toHaveBeenCalledWith('amazon-bedrock', 'us.anthropic.claude-opus-4-8');
    expect(model.model).toMatchObject({
      id: 'us.anthropic.claude-opus-4-8',
      provider: 'amazon-bedrock',
      api: 'bedrock-converse-stream',
      baseUrl: 'https://bedrock-runtime.us-west-2.amazonaws.com',
      name: 'Claude Opus 4.8 (US)',
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    });
    expect(model.apiKey).toBe('bedrock-token');
    expect(model.billingSource).toBe('byok');
    expect(model.usageProvider).toBe('bedrock');
    expect(fake.checkHostedPiModelAccess).not.toHaveBeenCalled();
  });

  it('passes Bedrock bearer tokens through the Pi stream function', () => {
    const streamSimple = vi.fn(() => ({ [Symbol.asyncIterator]: vi.fn() }));
    const streamBedrock = vi.fn(() => ({ [Symbol.asyncIterator]: vi.fn() }));
    const model = { api: 'bedrock-converse-stream', maxTokens: 1000 };

    ChatThreadDO.prototype['streamPiModel'].call(
      Object.create(ChatThreadDO.prototype),
      model,
      { systemPrompt: '', messages: [] },
      { apiKey: 'bedrock-token' },
      streamSimple,
      streamBedrock,
    );

    expect(streamSimple).not.toHaveBeenCalled();
    expect(streamBedrock).toHaveBeenCalledWith(
      model,
      { systemPrompt: '', messages: [] },
      expect.objectContaining({
        apiKey: 'bedrock-token',
        bearerToken: 'bedrock-token',
        maxTokens: 1000,
      }),
    );
  });

  it('preflights Pi context compaction with enough headroom for 1M Bedrock models', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    const messages = [
      { role: 'user', content: 'old context', timestamp: 1 },
      { role: 'assistant', content: [{ type: 'text', text: 'recent context' }], timestamp: 2 },
    ];
    fake.estimatePiContextTokens = vi.fn(() => 920_000);
    fake.loadPiCoreCompaction = vi.fn(() => null);
    fake.findPiCompactionCutIndex = vi.fn(() => 1);
    fake.summarizePiMessages = vi.fn(async () => 'compact summary');
    fake.persistPiCoreCompaction = vi.fn();
    fake.createPiSummaryMessage = vi.fn((summary: string) => ({
      role: 'user',
      content: `[summary] ${summary}`,
      timestamp: 3,
    }));

    const compacted = await ChatThreadDO.prototype['compactPiContext'].call(
      fake,
      messages,
      { contextWindow: 1_000_000 },
      'bedrock-token',
      vi.fn(),
    );

    expect(fake.summarizePiMessages).toHaveBeenCalled();
    expect(fake.persistPiCoreCompaction).toHaveBeenCalledWith('compact summary', 1);
    expect(compacted).toEqual([
      { role: 'user', content: '[summary] compact summary', timestamp: 3 },
      messages[1],
    ]);
  });

  it('persists repeated Pi compaction cutoffs in original SQL row index space', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    const existing = {
      summary: 'first summary',
      firstKeptIndex: 2,
      updatedAt: 100,
    };
    const messages = [
      ChatThreadDO.prototype['createPiSummaryMessage'].call(fake, existing.summary, 100),
      { role: 'user', content: 'raw row 2', timestamp: 200 },
      { role: 'assistant', content: [{ type: 'text', text: 'raw row 3' }], timestamp: 300 },
      { role: 'user', content: 'raw row 4', timestamp: 400 },
    ];
    fake.estimatePiContextTokens = vi.fn(() => 920_000);
    fake.loadPiCoreCompaction = vi.fn(() => existing);
    fake.findPiCompactionCutIndex = vi.fn(() => 2);
    fake.summarizePiMessages = vi.fn(async () => 'second summary');
    fake.persistPiCoreCompaction = vi.fn();

    const compacted = await ChatThreadDO.prototype['compactPiContext'].call(
      fake,
      messages,
      { contextWindow: 1_000_000 },
      'bedrock-token',
      vi.fn(),
    );

    expect(fake.persistPiCoreCompaction).toHaveBeenCalledWith('second summary', 3);
    expect(compacted).toEqual([
      expect.objectContaining({
        role: 'user',
        content: '[Context Summary]\n\nsecond summary',
      }),
      messages[2],
      messages[3],
    ]);
  });

  it('persists a bounded fallback compaction when summary generation fails', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    const messages = [
      { role: 'user', content: 'old context', timestamp: 1 },
      { role: 'assistant', content: [{ type: 'text', text: 'recent context' }], timestamp: 2 },
    ];
    fake.estimatePiContextTokens = vi.fn(() => 920_000);
    fake.loadPiCoreCompaction = vi.fn(() => null);
    fake.findPiCompactionCutIndex = vi.fn(() => 1);
    fake.summarizePiMessages = vi.fn(async () => {
      throw new Error('Compaction summary was empty');
    });
    fake.persistPiCoreCompaction = vi.fn();
    fake.recordChatThreadObservabilityEvent = vi.fn();

    const compacted = await ChatThreadDO.prototype['compactPiContext'].call(
      fake,
      messages,
      { contextWindow: 1_000_000 },
      'bedrock-token',
      vi.fn(),
    );

    expect(fake.persistPiCoreCompaction).toHaveBeenCalledWith(
      expect.stringContaining('Automatic fallback summary'),
      1,
    );
    expect(compacted).toHaveLength(2);
    expect((compacted[0] as { content: string }).content).toContain('[Context Summary]');
    expect(fake.recordChatThreadObservabilityEvent).toHaveBeenCalledWith(
      'pi_context_compaction_fallback_persisted',
      expect.objectContaining({ status: 'fallback' }),
    );
  });

  it('schedules post-turn Pi compaction from assistant usage like the high-level agent', async () => {
    const compaction = Promise.resolve();
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.ctx = { waitUntil: vi.fn() };
    fake.piSession = {
      state: {
        model: { contextWindow: 1_000_000 },
      },
    };
    fake.compactPiContextAfterTurn = vi.fn(() => compaction);

    const assistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'done' }],
      timestamp: 1,
      usage: {
        input: 910_000,
        output: 1_000,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 911_000,
      },
    };

    ChatThreadDO.prototype['maybeSchedulePiPostTurnCompaction'].call(
      fake,
      [{ role: 'user', content: 'hi', timestamp: 0 }, assistantMessage],
    );

    expect(fake.ctx.waitUntil).toHaveBeenCalledWith(expect.any(Promise));
    expect(fake.compactPiContextAfterTurn).toHaveBeenCalledWith(assistantMessage);
  });

  it('persists post-turn Pi compaction into live session state and resets baseline', async () => {
    const beforeMessages = [
      { role: 'user', content: 'old', timestamp: 0 },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
        timestamp: 1,
        usage: { totalTokens: 911_000 },
      },
    ];
    const compactedMessages = [
      { role: 'user', content: '[summary] old', timestamp: 2 },
      beforeMessages[1],
    ];
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.piModelResolver = vi.fn(async () => ({
      model: { contextWindow: 1_000_000, id: 'global.anthropic.claude-sonnet-4-6' },
      apiKey: 'bedrock-token',
      provider: 'bedrock',
      usageProvider: 'bedrock',
      modelId: 'claude-sonnet-4-6',
    }));
    fake.piSession = {
      state: {
        isStreaming: false,
        model: { contextWindow: 1_000_000 },
        messages: beforeMessages,
      },
    };
    fake.loadPiCompleteSimple = vi.fn(async () => vi.fn());
    fake.compactPiContext = vi.fn(async () => compactedMessages);
    fake.replacePiCoreMessages = vi.fn();
    fake.clearPiCoreCompaction = vi.fn();
    fake.recordChatThreadObservabilityEvent = vi.fn();
    fake.piMainBaselineIndex = beforeMessages.length;

    await ChatThreadDO.prototype['compactPiContextAfterTurn'].call(
      fake,
      beforeMessages[1],
    );

    expect(fake.piSession.state.messages).toBe(compactedMessages);
    expect(fake.replacePiCoreMessages).toHaveBeenCalledWith(compactedMessages);
    expect(fake.clearPiCoreCompaction).toHaveBeenCalled();
    expect(fake.piMainBaselineIndex).toBe(compactedMessages.length);
    expect(fake.recordChatThreadObservabilityEvent).toHaveBeenCalledWith(
      'pi_post_turn_compacted',
      expect.objectContaining({
        count: beforeMessages.length,
        size: compactedMessages.length,
      }),
    );
  });

  it('uses Pi effective output token cap as reserve for post-turn compaction triggers', () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.ctx = { waitUntil: vi.fn() };
    fake.piSession = {
      state: {
        model: { id: 'gpt-test', contextWindow: 128_000, maxTokens: 40_000 },
      },
    };
    fake.compactPiContextAfterTurn = vi.fn(async () => undefined);

    ChatThreadDO.prototype['maybeSchedulePiPostTurnCompaction'].call(fake, [
      { role: 'user', content: 'request', timestamp: 1 },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'answer' }],
        usage: { totalTokens: 98_000 },
        timestamp: 2,
      },
    ]);

    expect(fake.compactPiContextAfterTurn).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'assistant' }),
    );
    expect(fake.ctx.waitUntil).toHaveBeenCalledWith(expect.any(Promise));
  });

  it('treats Pi provider context overflow messages as post-turn compaction triggers', () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.ctx = { waitUntil: vi.fn() };
    fake.piSession = {
      state: {
        model: { id: 'gpt-test', contextWindow: 128_000, maxTokens: 4096 },
      },
    };
    fake.compactPiContextAfterTurn = vi.fn(async () => undefined);

    ChatThreadDO.prototype['maybeSchedulePiPostTurnCompaction'].call(fake, [
      { role: 'user', content: 'request', timestamp: 1 },
      {
        role: 'assistant',
        content: [{ type: 'text', text: '' }],
        stopReason: 'error',
        errorMessage: 'Your input exceeds the context window of this model',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
        timestamp: 2,
      },
    ]);

    expect(fake.compactPiContextAfterTurn).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'assistant' }),
    );
    expect(fake.ctx.waitUntil).toHaveBeenCalledWith(expect.any(Promise));
  });

  it('uses Pi compaction reserve to size summary generation output', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    const completeSimple = vi.fn(async () => ({
      content: [{ type: 'text', text: 'summary' }],
    }));
    const model = {
      id: 'gpt-test',
      api: 'openai-responses',
      provider: 'openai',
      contextWindow: 128_000,
      maxTokens: 40_000,
      reasoning: true,
    };

    const summary = await ChatThreadDO.prototype['summarizePiMessages'].call(
      fake,
      [{ role: 'user', content: 'older context', timestamp: 1 }],
      model,
      'test-key',
      completeSimple,
    );

    expect(summary).toBe('summary');
    expect(completeSimple).toHaveBeenCalledWith(
      model,
      expect.any(Object),
      expect.objectContaining({
        apiKey: 'test-key',
        maxTokens: 25_600,
        reasoning: 'high',
      }),
    );
  });

  it('chunks oversized Pi compaction summary input so already-large context can be summarized', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    let summaryIndex = 0;
    const completeSimple = vi.fn(async () => ({
      content: [{ type: 'text', text: `summary ${++summaryIndex}` }],
    }));
    const model = {
      id: 'gpt-test',
      api: 'openai-responses',
      provider: 'openai',
      contextWindow: 12_000,
      maxTokens: 1000,
      reasoning: false,
    };
    const messages = Array.from({ length: 4 }, (_, index) => ({
      role: 'user',
      content: `message ${index} ${'x'.repeat(16_000)}`,
      timestamp: index,
    }));

    const summary = await ChatThreadDO.prototype['summarizePiMessages'].call(
      fake,
      messages,
      model,
      'test-key',
      completeSimple,
    );

    expect(summary).toBe(`summary ${summaryIndex}`);
    expect(completeSimple.mock.calls.length).toBeGreaterThan(1);
    expect(completeSimple).toHaveBeenLastCalledWith(
      model,
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            content: expect.stringContaining('<previous-summary>'),
          }),
        ],
      }),
      expect.objectContaining({
        maxTokens: 1000,
      }),
    );
  });

  it('repairs an already oversized Pi transcript by chunking compaction before replay', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.loadPiCoreCompaction = vi.fn(() => null);
    fake.persistPiCoreCompaction = vi.fn();
    let summaryIndex = 0;
    const completeSimple = vi.fn(async () => ({
      content: [{ type: 'text', text: `summary ${++summaryIndex}` }],
    }));
    const model = {
      id: 'gpt-test',
      api: 'openai-responses',
      provider: 'openai',
      contextWindow: 30_000,
      maxTokens: 4000,
      reasoning: false,
    };
    const messages = Array.from({ length: 12 }, (_, index) => ({
      role: 'user',
      content: `message ${index} ${'x'.repeat(16_000)}`,
      timestamp: index,
    }));

    const compacted = await ChatThreadDO.prototype['compactPiContext'].call(
      fake,
      messages,
      model,
      'test-key',
      completeSimple,
      undefined,
      true,
    );

    expect(compacted).not.toBe(messages);
    expect(compacted.length).toBeLessThan(messages.length);
    expect((compacted[0] as { content?: string }).content).toContain('[Context Summary]');
    expect(fake.persistPiCoreCompaction).toHaveBeenCalledWith(
      `summary ${summaryIndex}`,
      expect.any(Number),
    );
    expect(completeSimple.mock.calls.length).toBeGreaterThan(1);
  });

  it('does not overwrite Pi state when post-turn compaction finishes after another run starts', async () => {
    const before = [
      { role: 'user', content: 'old request', timestamp: 1 },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'old answer' }],
        usage: { totalTokens: 112_000 },
        timestamp: 2,
      },
    ];
    const compacted = [
      { role: 'user', content: '[Context Summary]\n\nsummary', timestamp: 3 },
    ];
    const model = { id: 'gpt-test', contextWindow: 128_000 };
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.piSession = {
      state: {
        isStreaming: false,
        model,
        messages: before,
      },
    };
    fake.piModelResolver = vi.fn(async () => ({
      model,
      apiKey: 'test-key',
      provider: 'openai',
      modelId: 'gpt-test',
      billingSource: 'hosted',
      creditChargeable: true,
      usageProvider: 'openai',
    }));
    fake.loadPiCompleteSimple = vi.fn(async () => vi.fn());
    fake.compactPiContext = vi.fn(async () => {
      fake.piSession.state.isStreaming = true;
      return compacted;
    });
    fake.replacePiCoreMessages = vi.fn();
    fake.clearPiCoreCompaction = vi.fn();
    fake.recordChatThreadObservabilityEvent = vi.fn();

    await ChatThreadDO.prototype['compactPiContextAfterTurn'].call(fake, before[1]);

    expect(fake.piSession.state.messages).toBe(before);
    expect(fake.replacePiCoreMessages).not.toHaveBeenCalled();
    expect(fake.clearPiCoreCompaction).not.toHaveBeenCalled();
  });

  it('does not overwrite Pi state when messages changed while post-turn compaction was running', async () => {
    const before = [
      { role: 'user', content: 'old request', timestamp: 1 },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'old answer' }],
        usage: { totalTokens: 112_000 },
        timestamp: 2,
      },
    ];
    const currentMessages = [
      ...before,
      { role: 'user', content: 'new request', timestamp: 3 },
    ];
    const compacted = [
      { role: 'user', content: '[Context Summary]\n\nsummary', timestamp: 4 },
    ];
    const model = { id: 'gpt-test', contextWindow: 128_000 };
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.piSession = {
      state: {
        isStreaming: false,
        model,
        messages: before,
      },
    };
    fake.piModelResolver = vi.fn(async () => ({
      model,
      apiKey: 'test-key',
      provider: 'openai',
      modelId: 'gpt-test',
      billingSource: 'hosted',
      creditChargeable: true,
      usageProvider: 'openai',
    }));
    fake.loadPiCompleteSimple = vi.fn(async () => vi.fn());
    fake.compactPiContext = vi.fn(async () => {
      fake.piSession.state.messages = currentMessages;
      return compacted;
    });
    fake.replacePiCoreMessages = vi.fn();
    fake.clearPiCoreCompaction = vi.fn();
    fake.recordChatThreadObservabilityEvent = vi.fn();

    await ChatThreadDO.prototype['compactPiContextAfterTurn'].call(fake, before[1]);

    expect(fake.piSession.state.messages).toBe(currentMessages);
    expect(fake.replacePiCoreMessages).not.toHaveBeenCalled();
    expect(fake.clearPiCoreCompaction).not.toHaveBeenCalled();
  });

  it('quarantines stuck Pi turn recovery instead of retrying forever', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.loadPiTurnRecovery = vi.fn(() => ({
      turn_id: 'turn1',
      status: 'recovering',
      user_content: 'hello',
      user_timestamp: 1,
      active_user_id: null,
      retry_count: 3,
      started_at: 1,
      updated_at: 1,
    }));
    fake.loadPiTurnRecoveryQuarantine = vi.fn(() => null);
    fake.quarantinePiTurnRecovery = vi.fn();
    fake.schedulePiTurnRecoveryAlarm = vi.fn();
    fake.piSession = null;

    await ChatThreadDO.prototype.alarm.call(fake);

    expect(fake.quarantinePiTurnRecovery).toHaveBeenCalledWith(
      expect.stringContaining('reached max'),
      3,
    );
    expect(fake.schedulePiTurnRecoveryAlarm).not.toHaveBeenCalled();
  });

  it.each([
    ['gemini-3.5-flash', 'google/gemini-3.5-flash'],
    ['gemini-3-flash-preview', 'google/gemini-3-flash-preview'],
    ['gemini-3.1-pro-preview', 'google/gemini-3.5-flash'],
  ])('routes %s through OpenRouter chat completions', (model, routeModel) => {
    const result = ChatThreadDO.prototype['resolvePiModelReference'].call(
      Object.create(ChatThreadDO.prototype),
      model,
    );

    expect(result).toEqual({
      provider: 'openrouter',
      modelId: routeModel,
      hostedGatewayProvider: 'openrouter',
      hostedModelId: routeModel,
    });
  });

  it('runs code mode JavaScript through the Worker Loader with scoped tools', async () => {
    const toolsBinding = { listTools: vi.fn(), callTool: vi.fn() };
    const connectionsBinding = {
      list: vi.fn(),
      get: vi.fn(),
      tools: vi.fn(),
      methods: vi.fn(),
      __invoke: vi.fn(),
    };
    const aiBinding = { run: vi.fn() };
    let capturedWorkerCode: any;
    const fake = Object.create(ChatThreadDO.prototype) as any;

    fake.env = {
      CODE_MODE_LOADER: {
        load: vi.fn((workerCode) => {
          capturedWorkerCode = workerCode;
          return {
            getEntrypoint: vi.fn(() => ({
              run: vi.fn(async () => ({ text: 'x'.repeat(1200) })),
            })),
          };
        }),
      },
    };
    fake.ctx = {
      exports: {
        CodeModeToolsBinding: vi.fn(() => toolsBinding),
        ConnectionsService: vi.fn(() => connectionsBinding),
        AIVirtualBinding: vi.fn(() => aiBinding),
        CamelAiService: vi.fn(() => aiBinding),
      },
    };

    const result = await ChatThreadDO.prototype.runCodeModeJavascript.call(fake, {
      code: 'const methods = await env.CONNECTIONS.methods();\nmethods;',
      orgId: 'org_1',
      workspaceId: 'ws_1',
      threadId: 'thread_1',
      userId: 'user_1',
      maxOutputCharacters: 1000,
    });

    expect(fake.ctx.exports.CodeModeToolsBinding).toHaveBeenCalledWith({
      props: {
        orgId: 'org_1',
        workspaceId: 'ws_1',
        threadId: 'thread_1',
        userId: 'user_1',
      },
    });
    expect(fake.ctx.exports.ConnectionsService).toHaveBeenCalledWith({
      props: {
        orgId: 'org_1',
        workspaceId: 'ws_1',
        userId: 'user_1',
      },
    });
    expect(fake.ctx.exports.AIVirtualBinding).toHaveBeenCalledWith({
      props: {
        orgId: 'org_1',
        workspaceId: 'ws_1',
        userId: 'user_1',
      },
    });
    expect(fake.ctx.exports.CamelAiService).toHaveBeenCalledWith({
      props: {
        orgId: 'org_1',
        workspaceId: 'ws_1',
        userId: 'user_1',
      },
    });
    expect(capturedWorkerCode.globalOutbound).toBeUndefined();
    expect(capturedWorkerCode.env.TOOLS).toBe(toolsBinding);
    expect(capturedWorkerCode.env.CONNECTIONS).toBe(connectionsBinding);
    expect(capturedWorkerCode.env.AI).toBe(aiBinding);
    expect(capturedWorkerCode.env.CAMELAI).toBe(aiBinding);
    expect(capturedWorkerCode.modules['index.js'].js).toContain('class CodeModeRunner');
    expect(capturedWorkerCode.modules['index.js'].js).toContain('createConnectionsFacade');
    expect(capturedWorkerCode.modules['index.js'].js).toContain('if (connectionName === "$find") return (query) => binding.find(query)');
    expect(capturedWorkerCode.modules['index.js'].js).toContain('if (connectionName === "$test") return (query) => binding.test(query)');
    expect(capturedWorkerCode.modules['index.js'].js).toContain('createOutputConsole');
    expect(capturedWorkerCode.modules['index.js'].js).toContain('globalThis.console = createOutputConsole(output)');
    expect(capturedWorkerCode.modules['index.js'].js).toContain('const AI = this.env.AI');
    expect(capturedWorkerCode.modules['index.js'].js).toContain('const env = Object.freeze({ CONNECTIONS, AI, CAMELAI })');
    expect(capturedWorkerCode.modules['index.js'].js).toContain('const context = Object.freeze({ cloudflare: Object.freeze({ env, connections }) })');
    expect(capturedWorkerCode.modules['index.js'].js).toContain('parameters: tool.parameters');
    expect(capturedWorkerCode.modules['index.js'].js).toContain('return methods;');
    expect(capturedWorkerCode.modules['index.js'].js).not.toContain('AsyncFunction');
    expect(capturedWorkerCode.modules['index.js'].js).not.toContain('new Function');
    expect(result.text).toBe(`${'x'.repeat(1000)}\n\n[Truncated: 1000 of 1200 characters]`);
  });

  it('makes code mode final expressions behave like a short-lived JavaScript REPL', () => {
    expect(prepareCodeModeUserCode('const methods = await env.CONNECTIONS.methods();\nmethods;'))
      .toBe('const methods = await env.CONNECTIONS.methods();\nreturn methods;');
    expect(prepareCodeModeUserCode('JSON.stringify(catalog, null, 2);'))
      .toBe('return JSON.stringify(catalog, null, 2);');
    expect(prepareCodeModeUserCode('return await connections.clickhouse.query({ query: "SELECT 1" });'))
      .toBe('return await connections.clickhouse.query({ query: "SELECT 1" });');
    expect(prepareCodeModeUserCode('const catalog = await env.CONNECTIONS.methods();'))
      .toBe('const catalog = await env.CONNECTIONS.methods();');
  });

  it('transcribes mounted audio files through the CAMELAI service binding', async () => {
    const aiRun = vi.fn(async () => ({ text: 'audio transcript' }));
    const r2Get = vi.fn(async () => r2Object('audio bytes', 'audio/ogg'));
    const fake = Object.create(CamelAiService.prototype) as any;
    fake.env = {
      AI: { run: aiRun },
      R2_BUCKET: { get: r2Get },
    };
    fake.ctx = {
      props: {
        orgId: 'org-1',
        workspaceId: 'workspace-1',
        userId: 'user-1',
      },
    };

    const result = await CamelAiService.prototype.transcribeAudio.call(fake, {
      path: '/mnt/user-uploads/note.ogg',
    });

    expect(r2Get).toHaveBeenCalledWith('org-1/workspace-1/user-uploads/note.ogg');
    expect(aiRun).toHaveBeenCalledWith('@cf/openai/whisper-large-v3-turbo', {
      audio: 'YXVkaW8gYnl0ZXM=',
    });
    expect(result).toEqual({ text: 'audio transcript' });
  });

  it('advertises restored legacy tools to js_exec through CodeModeToolsBinding', async () => {
    const tools = await CodeModeToolsBinding.prototype.listTools.call({} as any);
    const byName = new Map(tools.map((tool: any) => [tool.name, tool]));

    expect(tools.map((tool: any) => tool.name)).toEqual(expect.arrayContaining([
      'bash',
      'read',
      'write',
      'edit',
      'grep',
      'find',
      'AskUserQuestion',
      'TodoWrite',
      'set_preview',
      'list_apps',
      'list_scheduled_prompts',
      'list_deterministic_automations',
      'list_integrations',
      'get_custom_domain',
      'Agent',
      'Explore',
      'WebSearch',
      'WebFetch',
      'connections_methods',
    ]));
    expect((byName.get('bash') as any).parameters.properties.command).toBeDefined();
    expect((byName.get('read') as any).parameters.properties.path).toBeDefined();
    expect((byName.get('WebSearch') as any).parameters.properties.query).toBeDefined();
    expect((byName.get('WebFetch') as any).parameters.properties.url).toBeDefined();
    expect((byName.get('connections_get') as any).parameters.properties.connection).toBeDefined();
    expect(byName.has('prompt_connection_setup')).toBe(false);
  });

  it('serves bundled skills through the Pi core read and ls tools', async () => {
    const containerTool = vi.fn(async () => {
      throw new Error('workspace tool should not be called for bundled skills');
    });
    const toolsBinding = Object.create(CodeModeToolsBinding.prototype) as any;
    Object.defineProperty(toolsBinding, 'piContainerTools', {
      value: { callTool: containerTool },
    });
    const bindingFactory = vi.fn(() => toolsBinding);
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.ctx = {
      exports: {
        CodeModeToolsBinding: bindingFactory,
      },
    };

    const tools = ChatThreadDO.prototype['createPiToolDefinitions'].call(fake, {
      orgId: 'org1',
      workspaceId: 'workspace1',
      threadId: 'thread1',
    });
    const read = tools.find((tool: any) => tool.name === 'read');
    const ls = tools.find((tool: any) => tool.name === 'ls');

    const listing = await ls.execute('tool1', {
      path: '/opt/chiridion-host-pi/skills',
    });
    expect(listing.content[0].text).toContain('developing-software');

    const skill = await read.execute('tool2', {
      path: '/opt/chiridion-host-pi/skills/developing-software/SKILL.md',
    });
    expect(skill.content[0].text).toContain('name: developing-software');
    expect(skill.details.details.source).toBe('bundled_skill');
    expect(bindingFactory).toHaveBeenCalled();
    expect(containerTool).not.toHaveBeenCalled();
  });

  it('exposes provider-specific channel send tools only inside js_exec', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.ctx = {
      exports: {
        CodeModeToolsBinding: vi.fn(() => ({
          piContainerTools: { callTool: vi.fn() },
        })),
      },
    };
    const context = {
      orgId: 'org1',
      workspaceId: 'workspace1',
      threadId: 'thread1',
      userId: 'user1',
      userName: null,
      userEmail: null,
    };

    const piTools = ChatThreadDO.prototype['createPiToolDefinitions'].call(fake, context);
    expect(piTools.find((tool: any) => tool.name === 'send_email')).toBeUndefined();
    expect(piTools.find((tool: any) => tool.name === 'send_slack_message')).toBeUndefined();
    expect(piTools.find((tool: any) => tool.name === 'send_telegram_message')).toBeUndefined();

    const codeModeTools = await CodeModeToolsBinding.prototype.listTools.call({} as any);
    expect(codeModeTools.find((tool: any) => tool.name === 'send_email')).toBeTruthy();
    expect(codeModeTools.find((tool: any) => tool.name === 'send_slack_message')).toBeTruthy();
    expect(codeModeTools.find((tool: any) => tool.name === 'send_telegram_message')).toBeTruthy();
  });

  it('sends email from any workspace context', async () => {
    const sendEmailMock = vi.fn(async () => ({ messageId: 'email_1' }));
    const kvPutMock = vi.fn(async () => undefined);

    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.env = {
      EMAIL: { send: sendEmailMock },
      EMAIL_FROM_ADDRESS: 'noreply@camelai.test',
      APP_KV: { put: kvPutMock },
      ORG: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({
          getThread: vi.fn(async () => ({
            id: 'thread1',
            source: 'web',
            channel_kind: null,
            channel_connection_id: null,
          })),
        })),
      },
    };
    const result = await ChatThreadDO.prototype['sendChannelEmailTool'].call(
      fake,
      {
        orgId: 'org1',
        workspaceId: 'workspace1',
        threadId: 'thread1',
        userId: 'user1',
        userName: null,
        userEmail: null,
      },
      {
        to: 'alice@example.com',
        subject: 'Done',
        text: 'Finished.',
      },
    );

    expect(sendEmailMock).toHaveBeenCalledWith({
      from: 'noreply@camelai.test',
      to: 'alice@example.com',
      subject: 'Done',
      text: 'Finished.',
    });
    expect(result.content[0].text).toBe('Email sent.');
    expect(result.details).toMatchObject({
      provider: 'cloudflare_email',
      messageId: 'email_1',
    });
    expect(kvPutMock).toHaveBeenCalledWith(
      'email_reply_ref:workspace1:email_1',
      'thread1',
      { expirationTtl: 180 * 24 * 60 * 60 },
    );
  });

  it('serves bundled skills through js_exec tools.read and tools.ls', async () => {
    const containerTool = vi.fn(async () => {
      throw new Error('workspace tool should not be called for bundled skills');
    });
    const fake = Object.create(CodeModeToolsBinding.prototype) as any;
    Object.defineProperty(fake, 'piContainerTools', {
      value: { callTool: containerTool },
    });

    const skill = await CodeModeToolsBinding.prototype.callTool.call(fake, 'read', {
      path: '/opt/chiridion-host-pi/skills/data-analysis/SKILL.md',
    });
    expect((skill as any).text).toContain('name: data-analysis');
    expect((skill as any).details.source).toBe('bundled_skill');

    const listing = await CodeModeToolsBinding.prototype.callTool.call(fake, 'ls', {
      path: '/opt/chiridion-host-pi/skills',
    });
    expect((listing as any).text).toContain('data-analysis');
    expect((listing as any).details.source).toBe('bundled_skill');
    expect(containerTool).not.toHaveBeenCalled();
  });

  it('serves deterministic automation virtual files through js_exec file tools', async () => {
    const source = 'import { WorkflowEntrypoint } from "cloudflare:workers";\nexport class AutomationWorkflow extends WorkflowEntrypoint {}\n';
    const updatedSource = source.replace('WorkflowEntrypoint {}', 'WorkflowEntrypoint { async run() { return { ok: true }; } }');
    const cronStub = {
      listDeterministicAutomations: vi.fn(async () => [{
        id: 'automation-1',
        name: 'Automation',
        description: null,
        source,
        source_version: 1,
        cron_expression: '0 9 * * *',
        enabled: true,
        created_by: 'user1',
        created_at: 1,
        updated_at: 1,
        next_run_at: null,
        last_run_at: null,
        last_run_status: null,
        last_run_error: null,
        last_instance_id: null,
        run_count: 0,
      }]),
      getDeterministicAutomationSource: vi.fn(async () => ({
        automation_id: 'automation-1',
        workspace_id: 'workspace1',
        source_version: 1,
        source,
        created_by: 'user1',
      })),
      updateDeterministicAutomation: vi.fn(async (_input) => ({
        id: 'automation-1',
        name: 'Automation',
        description: null,
        source: updatedSource,
        source_version: 2,
        cron_expression: '0 9 * * *',
        enabled: true,
        created_by: 'user1',
        created_at: 1,
        updated_at: 2,
        next_run_at: null,
        last_run_at: null,
        last_run_status: null,
        last_run_error: null,
        last_instance_id: null,
        run_count: 0,
      })),
    };
    const containerTool = vi.fn(async () => {
      throw new Error('workspace tool should not be called for automation virtual files');
    });
    const fake = Object.create(CodeModeToolsBinding.prototype) as any;
    fake.ctx = { props: { workspaceId: 'workspace1' } };
    Object.defineProperty(fake, 'cronStub', { value: cronStub });
    Object.defineProperty(fake, 'piContainerTools', {
      value: { callTool: containerTool },
    });

    const listing = await CodeModeToolsBinding.prototype.callTool.call(fake, 'ls', {
      path: '/home/claude/.camelai/automations',
    });
    expect((listing as any).text).toContain('automation-1.js');

    const read = await CodeModeToolsBinding.prototype.callTool.call(fake, 'read', {
      path: '/home/claude/.camelai/automations/automation-1.js',
    });
    expect((read as any).text).toContain('AutomationWorkflow');

    const edit = await CodeModeToolsBinding.prototype.callTool.call(fake, 'edit', {
      path: '/home/claude/.camelai/automations/automation-1.js',
      edits: [{ oldText: 'WorkflowEntrypoint {}', newText: 'WorkflowEntrypoint { async run() { return { ok: true }; } }' }],
    });
    expect((edit as any).text).toContain('source version 2');
    expect(cronStub.updateDeterministicAutomation).toHaveBeenCalledWith({
      workspaceId: 'workspace1',
      id: 'automation-1',
      source: updatedSource,
    });
    expect(containerTool).not.toHaveBeenCalled();
  });

  it('runs the Pi js_exec tool through the DO code mode runner', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.ctx = {
      exports: {
        CodeModeToolsBinding: vi.fn(() => ({
          callTool: vi.fn(async () => {
            throw new Error('generic tool binding should not handle js_exec');
          }),
        })),
      },
    };
    fake.runCodeModeJavascript = vi.fn(async () => ({ text: 'done' }));

    const tools = ChatThreadDO.prototype['createPiToolDefinitions'].call(fake, {
      orgId: 'org1',
      workspaceId: 'workspace1',
      threadId: 'thread1',
      userId: 'user1',
    });
    const jsExec = tools.find((tool: any) => tool.name === 'js_exec');

    const result = await jsExec.execute('tool3', {
      description: 'run a short code-mode script',
      code: 'text("hello")',
      timeoutMs: 1234,
      maxOutputCharacters: 4321,
    });

    expect(jsExec.parameters.required).toContain('description');

    expect(fake.runCodeModeJavascript).toHaveBeenCalledWith({
      code: 'text("hello")',
      orgId: 'org1',
      workspaceId: 'workspace1',
      threadId: 'thread1',
      userId: 'user1',
      timeoutMs: 1234,
      maxOutputCharacters: 4321,
    });
    expect(result.content[0].text).toBe('done');
  });

  it('passes user scope into the shared code mode tools binding', async () => {
    const bindingFactory = vi.fn(() => ({
      callTool: vi.fn(async () => ({ ok: true })),
    }));
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.ctx = {
      exports: {
        CodeModeToolsBinding: bindingFactory,
      },
    };

    ChatThreadDO.prototype['createPiToolDefinitions'].call(fake, {
      orgId: 'org1',
      workspaceId: 'workspace1',
      threadId: 'thread1',
      userId: 'user1',
    });

    expect(bindingFactory).toHaveBeenCalledWith({
      props: {
        orgId: 'org1',
        workspaceId: 'workspace1',
        threadId: 'thread1',
        userId: 'user1',
      },
    });
  });

  it('builds Wrangler deploy proxy env through the sandbox host', async () => {
    const fake = Object.create(CodeModeToolsBinding.prototype) as any;
    fake.env = {
      CF_ACCOUNT_ID: 'acct_1',
    };
    fake.ctx = {
      props: {
        orgId: 'org1',
        workspaceId: 'workspace1',
        threadId: 'thread1',
        userId: 'user1',
      },
    };

    const deployEnv = await CodeModeToolsBinding.prototype['createWranglerDeployEnv'].call(fake);

    expect(deployEnv.CLOUDFLARE_API_BASE_URL).toBe('http://host.docker.internal:8081/v1/workspaces/org1/workspace1/client/v4');
    expect(deployEnv.CLOUDFLARE_ACCOUNT_ID).toBe('acct_1');
    expect(deployEnv.CLOUDFLARE_API_TOKEN).toBe('chiridion-sandbox-proxy');
  });

  it('merges base container command env with Wrangler deploy env', async () => {
    const fake = Object.create(CodeModeToolsBinding.prototype) as any;
    Object.defineProperty(fake, 'workspace', {
      value: {
        buildContainerCommandEnv: vi.fn(async () => ({
          WORKSPACE_ID: 'workspace1',
          ORG_ID: 'org1',
          WRANGLER_SEND_METRICS: 'false',
          CI: '1',
          CF_DISPATCH_NAMESPACE: 'staging',
          CHIRIDION_APP_SESSION: 'session_1',
        })),
      },
    });
    fake.createWranglerDeployEnv = vi.fn(async () => ({
      CLOUDFLARE_API_BASE_URL: 'https://staging.camelai.dev/client/v4',
      CLOUDFLARE_API_TOKEN: 'st_token',
      CLOUDFLARE_ACCOUNT_ID: 'acct_1',
    }));

    const tools = fake.piContainerTools as any;
    const commandEnv = await tools.commandEnv();

    expect(commandEnv).toMatchObject({
      WORKSPACE_ID: 'workspace1',
      ORG_ID: 'org1',
      WRANGLER_SEND_METRICS: 'false',
      CI: '1',
      CF_DISPATCH_NAMESPACE: 'staging',
      CHIRIDION_APP_SESSION: 'session_1',
      CLOUDFLARE_API_BASE_URL: 'https://staging.camelai.dev/client/v4',
      CLOUDFLARE_API_TOKEN: 'st_token',
      CLOUDFLARE_ACCOUNT_ID: 'acct_1',
    });
  });

  it('exposes restored legacy Pi tools through the shared code mode binding', async () => {
    const callTool = vi.fn(async (_name: string, args: Record<string, unknown>) => ({
      ok: true,
      args,
    }));
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.ctx = {
      exports: {
        CodeModeToolsBinding: vi.fn(() => ({ callTool })),
      },
    };

    const tools = ChatThreadDO.prototype['createPiToolDefinitions'].call(fake, {
      orgId: 'org1',
      workspaceId: 'workspace1',
      threadId: 'thread1',
      userId: 'user1',
    });
    const toolNames = tools.map((tool: any) => tool.name);

    expect(toolNames).toEqual(expect.arrayContaining([
      'edit',
      'grep',
      'find',
      'AskUserQuestion',
      'TodoWrite',
      'set_preview',
      'list_apps',
      'get_latest_logs',
      'list_scheduled_prompts',
      'list_deterministic_automations',
      'list_integrations',
      'prompt_connection_setup',
      'get_custom_domain',
      'WebSearch',
      'WebFetch',
    ]));

    const ask = tools.find((tool: any) => tool.name === 'AskUserQuestion');
    const result = await ask.execute('ask-tool-id', {
      questions: [{ question: 'Proceed?' }],
    });

    expect(callTool).toHaveBeenCalledWith('AskUserQuestion', {
      questions: [{ question: 'Proceed?' }],
      toolUseId: 'ask-tool-id',
    });
    expect(result.content[0].text).toContain('"ok": true');
  });

  it('defines argument schemas for Pi web tools and routes them through code mode tools', async () => {
    const callTool = vi.fn(async (_name: string, args: Record<string, unknown>) => ({
      ok: true,
      args,
    }));
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.ctx = {
      exports: {
        CodeModeToolsBinding: vi.fn(() => ({ callTool })),
      },
    };

    const tools = ChatThreadDO.prototype['createPiToolDefinitions'].call(fake, {
      orgId: 'org1',
      workspaceId: 'workspace1',
      threadId: 'thread1',
      userId: 'user1',
    });
    const webSearch = tools.find((tool: any) => tool.name === 'WebSearch');
    const webFetch = tools.find((tool: any) => tool.name === 'WebFetch');

    expect(webSearch.parameters.properties.query).toBeDefined();
    expect(webSearch.parameters.properties.numResults).toBeDefined();
    expect(webFetch.parameters.properties.url).toBeDefined();

    const result = await webSearch.execute('search-tool-id', {
      query: 'Cloudflare Workers',
      numResults: 3,
    });

    expect(callTool).toHaveBeenCalledWith('WebSearch', {
      query: 'Cloudflare Workers',
      numResults: 3,
      toolUseId: 'search-tool-id',
    });
    expect(result.content[0].text).toContain('"ok": true');
  });

  it('runs Worker-side WebSearch through provider round-robin with fallback', async () => {
    const kv = {
      get: vi.fn(async () => '0'),
      put: vi.fn(async () => undefined),
    };
    const fake = Object.create(CodeModeToolsBinding.prototype) as any;
    fake.env = {
      APP_KV: kv,
      FIRECRAWL_API_KEY: 'firecrawl-key',
      PARALLEL_API_KEY: 'parallel-key',
      EXA_API_KEY: 'exa-key',
      WEB_PROVIDER_ORDER: 'firecrawl,parallel,exa',
    };
    fake.ctx = {
      props: {
        orgId: 'org1',
        workspaceId: 'workspace1',
        threadId: 'thread1',
        userId: 'user1',
      },
    };

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://api.firecrawl.dev/v2/search') {
        expect(init?.headers).toMatchObject({ authorization: 'Bearer firecrawl-key' });
        return new Response(JSON.stringify({ error: 'firecrawl down' }), { status: 500 });
      }
      if (url === 'https://api.parallel.ai/v1/search') {
        expect(init?.headers).toMatchObject({ 'x-api-key': 'parallel-key' });
        const body = JSON.parse(String(init?.body));
        expect(body).toMatchObject({
          objective: 'Cloudflare Workers',
          search_queries: ['Cloudflare Workers'],
          session_id: 'thread1',
        });
        return new Response(JSON.stringify({
          usage: [{ name: 'sku_search', count: 1 }],
          results: [{
            title: 'Workers docs',
            url: 'https://developers.cloudflare.com/workers/',
            description: 'Build serverless applications on Cloudflare.',
          }],
        }));
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const result = await CodeModeToolsBinding.prototype.callTool.call(fake, 'WebSearch', {
        query: 'Cloudflare Workers',
        numResults: 3,
      }) as any;

      expect(kv.get).toHaveBeenCalledWith('code-mode:web-provider:index');
      expect(kv.put).toHaveBeenCalledWith('code-mode:web-provider:index', '1');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.provider).toBe('parallel');
      expect(result.costUSD).toBe(0.005);
      expect(result.content[0].text).toContain('Workers docs');
      expect(result.results).toEqual([expect.objectContaining({
        title: 'Workers docs',
        url: 'https://developers.cloudflare.com/workers/',
      })]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('runs Worker-side WebFetch through the configured provider API', async () => {
    const fake = Object.create(CodeModeToolsBinding.prototype) as any;
    fake.env = {
      APP_KV: {
        get: vi.fn(async () => '0'),
        put: vi.fn(async () => undefined),
      },
      EXA_API_KEY: 'exa-key',
      WEB_PROVIDER_ORDER: 'exa',
    };
    fake.ctx = {
      props: {
        orgId: 'org1',
        workspaceId: 'workspace1',
        threadId: 'thread1',
        userId: 'user1',
      },
    };

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://api.exa.ai/contents');
      expect(init?.headers).toMatchObject({ 'x-api-key': 'exa-key' });
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        urls: ['https://example.com/article'],
        livecrawl: 'always',
        text: { maxCharacters: 1200 },
      });
      return new Response(JSON.stringify({
        costDollars: { total: 0.002 },
        results: [{
          title: 'Example article',
          url: 'https://example.com/article',
          text: 'Fetched article text.',
        }],
      }));
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const result = await CodeModeToolsBinding.prototype.callTool.call(fake, 'WebFetch', {
        url: 'https://example.com/article',
        fresh: true,
        maxCharacters: 1200,
      }) as any;

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.provider).toBe('exa');
      expect(result.costUSD).toBe(0.002);
      expect(result.content[0].text).toContain('Fetched article text.');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('uses Pi-style schemas for restored file and shell tools', () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.ctx = {
      exports: {
        CodeModeToolsBinding: vi.fn(() => ({
          callTool: vi.fn(async () => ({ text: 'ok' })),
        })),
      },
    };

    const tools = ChatThreadDO.prototype['createPiToolDefinitions'].call(fake, {
      orgId: 'org1',
      workspaceId: 'workspace1',
      threadId: 'thread1',
      userId: 'user1',
    });
    const byName = new Map(tools.map((tool: any) => [tool.name, tool]));

    expect((byName.get('edit') as any).parameters.properties.edits).toBeDefined();
    expect((byName.get('edit') as any).parameters.properties.old_string).toBeUndefined();
    expect((byName.get('bash') as any).parameters.properties.command).toBeDefined();
    expect((byName.get('bash') as any).parameters.properties.timeout).toBeDefined();
    expect((byName.get('bash') as any).parameters.properties.timeoutMs).toBeUndefined();
    expect((byName.get('grep') as any).parameters.properties.literal).toBeDefined();
    expect((byName.get('find') as any).parameters.properties.limit).toBeDefined();
  });

  it('routes restored search tools through sandbox host operations', async () => {
    const execOnSandbox = vi.fn(async () => ({
      success: true,
      stdout: '/home/claude/src/app.ts:1:hello\n',
      stderr: '',
      exitCode: 0,
    }));
    const fake = Object.create(CodeModeToolsBinding.prototype) as any;
    Object.defineProperty(fake, 'workspace', {
      value: { execOnSandbox },
    });

    const result = await CodeModeToolsBinding.prototype.callTool.call(fake, 'grep', {
      pattern: 'hello',
      path: 'src',
      literal: true,
      limit: 2,
    });

    expect(result.text).toBe('app.ts:1: hello');
    expect(execOnSandbox).toHaveBeenCalledTimes(1);
    const [cmd, options] = execOnSandbox.mock.calls[0];
    expect(cmd).toEqual([
      'rg',
      '--line-number',
      '--color=never',
      '--hidden',
      '--fixed-strings',
      '--',
      'hello',
      '/home/claude/src',
    ]);
    expect(options).toEqual({ cwd: '/home/claude' });
  });

  it('normalizes AskUserQuestion string options before broadcasting to the browser', async () => {
    vi.useFakeTimers();
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.broadcastChat = vi.fn();
    fake.browserPrompts = new BrowserPromptCoordinator({
      hasAvailableBrowserUser: () => true,
      broadcast: fake.broadcastChat,
      sendDirect: vi.fn(),
      askUserQuestionUnavailableMessage: 'unavailable',
      questionTimeoutMs: 30 * 60 * 1000,
      connectionSetupTimeoutMs: 30 * 60 * 1000,
    });

    const promise = ChatThreadDO.prototype.askUserQuestion.call(fake, {
      toolUseId: 'tool-ask',
      questions: [{
        question: "What's your favorite programming language?",
        options: ['TypeScript', 'Python', 'Go'],
      }],
    });

    expect(fake.broadcastChat).toHaveBeenCalledWith({
      type: 'ask_user_question',
      questionId: expect.any(String),
      toolUseId: 'tool-ask',
      questions: [{
        question: "What's your favorite programming language?",
        header: '',
        multiSelect: false,
        options: [
          { label: 'TypeScript', description: '' },
          { label: 'Python', description: '' },
          { label: 'Go', description: '' },
        ],
      }],
    });

    const prompt = fake.broadcastChat.mock.calls[0][0];
    fake.browserPrompts.answerQuestion({
      questionId: prompt.questionId,
      answers: { answer: 'TypeScript' },
    });
    await expect(promise).resolves.toEqual({ answer: 'TypeScript' });
    vi.useRealTimers();
  });

  it('does not emit placeholder tool rows for unnamed preliminary Pi toolcall events', async () => {
    const { fake, events } = createPiEventFake();

    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, { type: 'agent_start' });
    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
      type: 'message_update',
      message: { role: 'assistant', content: [] },
      assistantMessageEvent: {
        type: 'toolcall_start',
        toolCall: { id: 'tool1' },
      },
    });

    expect(events.filter((event) => event.type === 'runtime_event')).toEqual([]);

    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
      type: 'tool_execution_start',
      toolCallId: 'tool1',
      toolName: 'AskUserQuestion',
      args: {
        questions: [{ question: 'Proceed?', options: ['Yes', 'No'] }],
      },
    });

    const runtimeEvents = events.filter((event) => event.type === 'runtime_event');
    expect(runtimeEvents).toHaveLength(1);
    expect(runtimeEvents[0].event.method).toBe('item/started');
    expect(runtimeEvents[0].event.params.item).toMatchObject({
      id: 'tool1',
      type: 'dynamicToolCall',
      tool: 'AskUserQuestion',
      status: 'running',
    });
  });

  it('exposes Pi subagent tools and omits recursive subagents for child agents', () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.ctx = {
      exports: {
        CodeModeToolsBinding: vi.fn(() => ({
          callTool: vi.fn(async () => ({ text: 'ok' })),
        })),
      },
    };

    const context = {
      orgId: 'org1',
      workspaceId: 'workspace1',
      threadId: 'thread1',
      userId: 'user1',
    };
    const rootTools = ChatThreadDO.prototype['createPiToolDefinitions'].call(fake, context);
    expect(rootTools.map((tool: any) => tool.name)).toEqual(
      expect.arrayContaining(['Agent', 'agent', 'Explore', 'explore']),
    );
    expect(rootTools.find((tool: any) => tool.name === 'Agent')?.executionMode).toBe('sequential');

    const childTools = ChatThreadDO.prototype['createPiToolDefinitions'].call(fake, context, {
      includeSubagents: false,
    });
    expect(childTools.map((tool: any) => tool.name)).not.toEqual(
      expect.arrayContaining(['Agent', 'agent', 'Explore', 'explore']),
    );
  });

  it('maps Pi reasoning and tool events to the old host runtime event shapes', async () => {
    const { fake, events } = createPiEventFake();

    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, { type: 'agent_start' });
    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
      type: 'message_update',
      message: { role: 'assistant', content: [] },
      assistantMessageEvent: {
        type: 'thinking_delta',
        contentIndex: 0,
        delta: 'thinking',
      },
    });
    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
      type: 'tool_execution_start',
      toolCallId: 'tool1',
      toolName: 'bash',
      args: { command: 'echo hi', cwd: '/home/claude' },
    });
    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
      type: 'tool_execution_update',
      toolCallId: 'tool1',
      toolName: 'bash',
      args: {},
      partialResult: { content: [{ type: 'text', text: 'hi\n' }], details: {} },
    });
    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
      type: 'tool_execution_end',
      toolCallId: 'tool1',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: 'hi\n' }], details: {} },
      isError: false,
    });

    const runtimeEvents = events.filter((event) => event.type === 'runtime_event');
    expect(runtimeEvents.map((event) => event.event.method)).toEqual([
      'item/reasoning/textDelta',
      'item/started',
      'item/commandExecution/outputDelta',
      'item/completed',
    ]);
    expect(runtimeEvents[0].event.params).toMatchObject({
      threadId: 'thread1',
      contentIndex: 0,
      delta: 'thinking',
    });
    expect(runtimeEvents[0].event.params.itemId).toMatch(/^pi_reasoning_/);
    expect(runtimeEvents[1].event.params.item).toMatchObject({
      id: 'tool1',
      type: 'commandExecution',
      command: 'echo hi',
      cwd: '/home/claude',
      status: 'running',
    });
    expect(runtimeEvents[2].event.params).toEqual({
      threadId: 'thread1',
      itemId: 'tool1',
      delta: 'hi\n',
    });
    expect(runtimeEvents[3].event.params.item).toMatchObject({
      id: 'tool1',
      type: 'commandExecution',
      command: 'echo hi',
      cwd: '/home/claude',
      status: 'completed',
      aggregatedOutput: 'hi\n',
    });
  });

  it('publishes live Pi running activity for thinking, text, and tools', async () => {
    const { fake, activityRecords } = createPiEventFake();

    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, { type: 'agent_start' });
    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
      type: 'message_update',
      message: { role: 'assistant', content: [] },
      assistantMessageEvent: {
        type: 'thinking_start',
        contentIndex: 0,
      },
    });
    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
      type: 'message_update',
      message: { role: 'assistant', content: [] },
      assistantMessageEvent: {
        type: 'text_delta',
        delta: 'Streaming assistant update.',
      },
    });
    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
      type: 'tool_execution_start',
      toolCallId: 'tool-read',
      toolName: 'read',
      args: { file_path: '/workspace/src/App.tsx' },
    });
    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
      type: 'tool_execution_end',
      toolCallId: 'tool-read',
      toolName: 'read',
      args: { file_path: '/workspace/src/App.tsx' },
      result: { content: [{ type: 'text', text: 'ok' }] },
      isError: false,
    });

    await flushWaitUntil(fake);

    expect(
      activityRecords.map(([, isStreaming, options]) => ({
        isStreaming,
        activityText: options.activityText,
      })),
    ).toEqual([
      { isStreaming: true, activityText: 'Thinking' },
      { isStreaming: true, activityText: 'Streaming assistant update.' },
      { isStreaming: true, activityText: 'Reading App.tsx' },
      { isStreaming: true, activityText: 'Read App.tsx' },
    ]);
  });

  it('renders persisted Pi tool result messages with their assistant tool calls', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.loadPiInFlightMessages = vi.fn(() => []);
    fake.loadPiCoreMessages = vi.fn(() => [
      { role: 'user', content: 'run it', timestamp: 100 },
      {
        role: 'assistant',
        content: [{
          type: 'toolCall',
          id: 'tool1',
          name: 'bash',
          arguments: { command: 'echo hi' },
        }],
        responseId: 'resp_tool',
        timestamp: 200,
        api: 'test',
        provider: 'test',
        model: 'test',
        usage: {},
        stopReason: 'toolUse',
      },
      {
        role: 'toolResult',
        toolCallId: 'tool1',
        toolName: 'bash',
        content: [{ type: 'text', text: 'hi\n' }],
        isError: false,
        timestamp: 300,
      },
    ]);

    const messages = await ChatThreadDO.prototype.getPiCoreParsedMessages.call(fake, 'thread1');

    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      id: 'resp_tool',
      role: 'assistant',
    });
    expect(messages[1].content).toEqual([
      {
        type: 'tool_use',
        id: 'tool1',
        name: 'bash',
        input: { command: 'echo hi' },
      },
      {
        type: 'tool_result',
        tool_use_id: 'tool1',
        content: 'hi\n',
        itemId: 'tool1',
        itemKind: 'commandExecution',
      },
    ]);
  });

  it('marks persisted Pi stopped-by-user messages for muted UI rendering', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.loadPiInFlightMessages = vi.fn(() => []);
    fake.loadPiCoreMessages = vi.fn(() => [
      { role: 'user', content: 'stop test', timestamp: 100 },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Stopped by user' }],
        responseId: 'pi_user_stop_200',
        timestamp: 200,
        api: 'test',
        provider: 'test',
        model: 'test',
        usage: {},
        stopReason: 'aborted',
        metadata: { reason: 'user_stop' },
      },
    ]);

    const messages = await ChatThreadDO.prototype.getPiCoreParsedMessages.call(fake, 'thread1');

    expect(messages[1]).toMatchObject({
      id: 'pi_user_stop_200',
      role: 'assistant',
      content: [{
        type: 'text',
        text: 'Stopped by user',
        itemKind: 'userStop',
      }],
    });
  });

  it('does not mark literal persisted Pi text as stopped-by-user without metadata', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.loadPiInFlightMessages = vi.fn(() => []);
    fake.loadPiCoreMessages = vi.fn(() => [
      { role: 'user', content: 'echo the phrase', timestamp: 100 },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Stopped by user' }],
        responseId: 'resp_literal_stop_text',
        timestamp: 200,
        api: 'test',
        provider: 'test',
        model: 'test',
        usage: {},
        stopReason: 'stop',
      },
    ]);

    const messages = await ChatThreadDO.prototype.getPiCoreParsedMessages.call(fake, 'thread1');

    expect(messages[1]).toMatchObject({
      id: 'resp_literal_stop_text',
      role: 'assistant',
      content: [{
        type: 'text',
        text: 'Stopped by user',
      }],
    });
    expect(messages[1].content).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ itemKind: 'userStop' })]),
    );
  });

  it('does not broadcast Pi recovery continue prompts as visible SDK user events', async () => {
    const { fake, events } = createPiEventFake();

    fake.suppressNextPiRecoveryPromptEvent = true;
    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
      type: 'user',
      message: {
        content: [{
          type: 'text',
          text: 'continue',
        }],
      },
    });

    expect(events).toEqual([]);

    fake.suppressNextPiRecoveryPromptEvent = true;
    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
      type: 'user',
      message: {
        content: 'continue',
      },
    });

    expect(events).toEqual([]);

    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
      type: 'user',
      message: {
        content: 'continue',
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'sdk_event' });
  });

  it('does not broadcast internal recovery context SDK user events', async () => {
    const { fake, events } = createPiEventFake();

    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
      type: 'user',
      message: {
        role: 'user',
        content: 'recovery context',
        visibility: 'hidden',
        metadata: { purpose: 'pi_turn_recovery_context' },
      },
    });

    expect(events).toEqual([]);
  });

  it('builds a recovery user message from in-flight messages', () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.serializePiMessageForSummary =
      ChatThreadDO.prototype['serializePiMessageForSummary'];
    const messages = [
      { role: 'user', content: 'list files', timestamp: 100 },
      {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'tool1', name: 'ls', arguments: {} },
        ],
        responseId: 'resp_tool',
        timestamp: 200,
        api: 'test',
        provider: 'test',
        model: 'test',
        usage: {},
        stopReason: 'toolUse',
      },
    ];

    const recovery = ChatThreadDO.prototype['buildPiRecoveryUserMessage'].call(
      fake,
      messages,
    );

    expect(recovery.role).toBe('user');
    expect(typeof recovery.content).toBe('string');
    const content = recovery.content as string;
    expect(content).toContain('[The previous turn was interrupted');
    expect(content).toContain('list files');
    expect(content).toContain('tool1');
    expect(recovery).toMatchObject({
      visibility: 'hidden',
      metadata: { purpose: 'pi_turn_recovery_context' },
    });
  });

  it('renders an empty in-flight buffer as a context-only marker', () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.serializePiMessageForSummary =
      ChatThreadDO.prototype['serializePiMessageForSummary'];

    const recovery = ChatThreadDO.prototype['buildPiRecoveryUserMessage'].call(
      fake,
      [],
    );

    expect(recovery.role).toBe('user');
    expect(recovery.content).toContain('(no recorded events before the interruption)');
    expect(recovery).toMatchObject({
      visibility: 'hidden',
      metadata: { purpose: 'pi_turn_recovery_context' },
    });
  });

  it('turn_end snapshots agent.state.messages past the baseline into main', async () => {
    const { fake, events: _events } = createPiEventFake();
    void _events;
    const allMessages = [
      { role: 'user', content: 'previous turn', timestamp: 50 },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'previous reply' }],
        timestamp: 60,
        api: 'test',
        provider: 'test',
        model: 'test',
        usage: {},
        stopReason: 'stop',
      },
      { role: 'user', content: 'current turn', timestamp: 100 },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'current reply' }],
        responseId: 'resp_current',
        timestamp: 200,
        api: 'test',
        provider: 'test',
        model: 'test',
        usage: {},
        stopReason: 'stop',
      },
    ];
    fake.piSession = { state: { messages: allMessages } };
    fake.piMainBaselineIndex = 2;
    fake.appendPiCoreMessagesIfMissing = vi.fn();
    fake.clearPiInFlightMessages = vi.fn();

    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
      type: 'turn_end',
      message: allMessages[3],
      toolResults: [],
    });

    expect(fake.appendPiCoreMessagesIfMissing).toHaveBeenCalledWith([
      allMessages[2],
      allMessages[3],
    ]);
    expect(fake.piMainBaselineIndex).toBe(4);
    expect(fake.clearPiInFlightMessages).toHaveBeenCalledTimes(1);
  });

  it('turn_end is a no-op when no new messages are past the baseline', async () => {
    const { fake, events: _events } = createPiEventFake();
    void _events;
    const allMessages = [
      { role: 'user', content: 'old', timestamp: 50 },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        timestamp: 60,
        api: 'test',
        provider: 'test',
        model: 'test',
        usage: {},
        stopReason: 'stop',
      },
    ];
    fake.piSession = { state: { messages: allMessages } };
    fake.piMainBaselineIndex = 2;
    fake.appendPiCoreMessagesIfMissing = vi.fn();
    fake.clearPiInFlightMessages = vi.fn();

    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
      type: 'turn_end',
      message: allMessages[1],
      toolResults: [],
    });

    expect(fake.appendPiCoreMessagesIfMissing).not.toHaveBeenCalled();
    expect(fake.piMainBaselineIndex).toBe(2);
    expect(fake.clearPiInFlightMessages).toHaveBeenCalledTimes(1);
  });

  it('suppresses aborted turn_end persistence after a user stop request', async () => {
    const { fake, events: _events } = createPiEventFake();
    void _events;
    const allMessages = [
      { role: 'user', content: 'stop while streaming', timestamp: 100 },
      {
        role: 'assistant',
        content: [{ type: 'text', text: '' }],
        stopReason: 'aborted',
        errorMessage: 'Request was aborted',
        responseId: 'resp_aborted',
        timestamp: 200,
      },
    ];
    fake.piSession = { state: { messages: allMessages } };
    fake.piMainBaselineIndex = 0;
    fake.piUserStopRequestedAtMs = 1234;
    fake.appendPiCoreMessagesIfMissing = vi.fn();
    fake.clearPiInFlightMessages = vi.fn();

    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
      type: 'turn_end',
      message: allMessages[1],
      toolResults: [],
    });

    expect(fake.appendPiCoreMessagesIfMissing).not.toHaveBeenCalled();
    expect(fake.piMainBaselineIndex).toBe(0);
    expect(fake.clearPiInFlightMessages).not.toHaveBeenCalled();
    expect(fake.recordChatThreadObservabilityEvent).toHaveBeenCalledWith(
      'pi_user_stop_turn_end_suppressed',
      expect.objectContaining({
        operation: 'handle_pi_session_event',
        status: 'turn_end',
      }),
    );
  });

  it('includes in-flight messages in the parsed chat view', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.chatContext = { threadId: 'thread1' };
    fake.piCoreMessageToParsedChatMessage =
      ChatThreadDO.prototype['piCoreMessageToParsedChatMessage'];
    fake.piUserContentToChatContent =
      ChatThreadDO.prototype['piUserContentToChatContent'];
    fake.piAssistantContentToChatContent =
      ChatThreadDO.prototype['piAssistantContentToChatContent'];
    fake.attachPiToolResultToParsedMessages =
      ChatThreadDO.prototype['attachPiToolResultToParsedMessages'];
    fake.piToolResultContentToChatContent =
      ChatThreadDO.prototype['piToolResultContentToChatContent'];

    const committed = [
      { role: 'user', content: 'first turn', timestamp: 100 },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'first reply' }],
        responseId: 'resp_first',
        timestamp: 110,
        api: 'test',
        provider: 'test',
        model: 'test',
        usage: {},
        stopReason: 'stop',
      },
    ];
    const inFlight = [
      { role: 'user', content: 'second turn', timestamp: 200 },
      {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'tool1', name: 'ls', arguments: {} },
        ],
        responseId: 'resp_second',
        timestamp: 210,
        api: 'test',
        provider: 'test',
        model: 'test',
        usage: {},
        stopReason: 'toolUse',
      },
    ];
    fake.loadPiCoreMessages = vi.fn(() => committed);
    fake.loadPiInFlightMessages = vi.fn(() => inFlight);

    const parsed = await ChatThreadDO.prototype['getPiCoreParsedMessages'].call(
      fake,
      'thread1',
    );

    expect(parsed).toHaveLength(4);
    expect(parsed[0]).toMatchObject({ role: 'user', content: 'first turn' });
    expect(parsed[1]).toMatchObject({ role: 'assistant', id: 'resp_first' });
    expect(parsed[2]).toMatchObject({ role: 'user', content: 'second turn' });
    expect(parsed[3]).toMatchObject({ role: 'assistant', id: 'resp_second' });
    expect(fake.loadPiCoreMessages).toHaveBeenCalledTimes(1);
    expect(fake.loadPiInFlightMessages).toHaveBeenCalledTimes(1);
  });

  it('omits internal recovery context messages from the parsed chat view', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.chatContext = { threadId: 'thread1' };
    fake.loadPiCoreMessages = vi.fn(() => [
      { role: 'user', content: 'first turn', timestamp: 100 },
      {
        role: 'user',
        content: 'recovery context that should not reach the client',
        timestamp: 200,
        visibility: 'hidden',
        metadata: { purpose: 'pi_turn_recovery_context' },
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'recovered reply' }],
        responseId: 'resp_recovered',
        timestamp: 210,
        api: 'test',
        provider: 'test',
        model: 'test',
        usage: {},
        stopReason: 'stop',
      },
    ]);
    fake.loadPiInFlightMessages = vi.fn(() => []);

    const parsed = await ChatThreadDO.prototype['getPiCoreParsedMessages'].call(
      fake,
      'thread1',
    );

    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ role: 'user', content: 'first turn' });
    expect(parsed[1]).toMatchObject({ role: 'assistant', id: 'resp_recovered' });
    expect(
      parsed.some((message) =>
        String(message.content).includes('recovery context'),
      ),
    ).toBe(false);
  });

  it('sanitizes unsupported persisted Pi image tool results when loading history', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.ensurePiCoreTables = vi.fn();
    fake.ctx = {
      storage: {
        sql: {
          exec: vi.fn(() => ({
            toArray: () => [
              {
                payload: JSON.stringify({
                  role: 'toolResult',
                  toolCallId: 'tool1',
                  toolName: 'read',
                  content: [
                    {
                      type: 'image',
                      data: 'AA==',
                      mimeType: 'image/vnd.microsoft.icon',
                    },
                    {
                      type: 'image',
                      data: 'BB==',
                      mimeType: 'image/jpg',
                    },
                  ],
                  isError: false,
                  timestamp: 300,
                }),
              },
            ],
          })),
        },
      },
    };

    const messages = await ChatThreadDO.prototype['loadPiCoreMessages'].call(fake);

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toEqual([
      {
        type: 'text',
        text: '(image omitted: unsupported MIME type image/vnd.microsoft.icon)',
      },
      {
        type: 'image',
        data: 'BB==',
        mimeType: 'image/jpeg',
      },
    ]);
  });

  it('loads compacted Pi history from the compaction tail instead of every row', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.ensurePiCoreTables = vi.fn();
    const exec = vi.fn((sql: string, ...params: unknown[]) => {
      if (sql.includes('pi_core_compaction')) {
        return {
          toArray: () => [
            {
              summary: 'earlier work summary',
              first_kept_index: 2,
              updated_at: 1234,
            },
          ],
        };
      }
      expect(sql).toContain('WHERE idx >= ?');
      expect(params).toEqual([2]);
      return {
        toArray: () => [
          {
            payload: JSON.stringify({
              role: 'user',
              content: 'kept user turn',
              timestamp: 200,
            }),
          },
          {
            payload: JSON.stringify({
              role: 'assistant',
              content: [{ type: 'text', text: 'kept assistant turn' }],
              responseId: 'resp_kept',
              timestamp: 210,
            }),
          },
        ],
      };
    });
    fake.ctx = { storage: { sql: { exec } } };

    const messages = await ChatThreadDO.prototype['loadPiCoreMessages'].call(fake);

    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatchObject({
      role: 'user',
      content: '[Context Summary]\n\nearlier work summary',
      timestamp: 1234,
    });
    expect(messages[1]).toMatchObject({ role: 'user', content: 'kept user turn' });
    expect(messages[2]).toMatchObject({ role: 'assistant', responseId: 'resp_kept' });
    expect(exec).toHaveBeenCalledWith(
      'SELECT payload FROM pi_core_messages WHERE idx >= ? ORDER BY idx ASC',
      2,
    );
    expect(exec).not.toHaveBeenCalledWith(
      'SELECT payload FROM pi_core_messages ORDER BY idx ASC',
    );
  });

  it('stores oversized image data in R2 before persisting Pi messages to SQLite', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.ensurePiCoreTables = vi.fn();
    fake.recordChatThreadObservabilityEvent = vi.fn();
    fake.chatContext = {
      orgId: 'org1',
      workspaceId: 'workspace1',
      threadId: 'thread1',
    };
    const put = vi.fn(async () => undefined);
    fake.env = {
      R2_BUCKET: { put },
    };
    const insertedPayloads: string[] = [];
    fake.ctx = {
      storage: {
        sql: {
          exec: vi.fn((sql: string, ...params: unknown[]) => {
            if (sql.includes('MAX(idx)')) {
              return { toArray: () => [{ next_idx: 0 }] };
            }
            if (sql.includes('INSERT INTO pi_core_messages')) {
              insertedPayloads.push(String(params[1]));
            }
            return { toArray: () => [] };
          }),
        },
      },
    };
    const imageData = 'a'.repeat(600_000);

    await ChatThreadDO.prototype['appendPiCoreMessages'].call(fake, [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'see image' },
          {
            type: 'image',
            mimeType: 'image/png',
            data: imageData,
          },
        ],
        timestamp: 1,
      },
    ]);

    expect(insertedPayloads).toHaveLength(1);
    expect(insertedPayloads[0].length).toBeLessThan(50_000);
    expect(insertedPayloads[0]).toContain('chiridionR2Image');
    expect(insertedPayloads[0]).toContain('"data":""');
    expect(insertedPayloads[0]).not.toContain('a'.repeat(100_000));
    expect(put).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith(
      expect.stringContaining('chat-sessions/thread1/pi-images/'),
      imageData,
      expect.objectContaining({
        customMetadata: expect.objectContaining({
          type: 'pi-message-image-base64',
          mimeType: 'image/png',
          sessionId: 'thread1',
          threadId: 'thread1',
          workspaceId: 'workspace1',
          orgId: 'org1',
        }),
      }),
    );
    expect(fake.recordChatThreadObservabilityEvent).toHaveBeenCalledWith(
      'pi_sql_storage_sanitized',
      expect.objectContaining({
        operation: 'append',
        status: 'externalized',
        sampleKey: expect.stringContaining('externalized:1'),
      }),
    );
  });

  it('hydrates oversized Pi image data from R2 when loading history', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.ensurePiCoreTables = vi.fn();
    fake.recordChatThreadObservabilityEvent = vi.fn();
    const imageData = 'b'.repeat(300_000);
    const get = vi.fn(async () => ({
      text: async () => imageData,
    }));
    fake.env = {
      R2_BUCKET: { get },
    };
    fake.ctx = {
      storage: {
        sql: {
          exec: vi.fn((sql: string) => {
            if (sql.includes('pi_core_compaction')) {
              return { toArray: () => [] };
            }
            return {
              toArray: () => [
                {
                  payload: JSON.stringify({
                    role: 'user',
                    content: [
                      {
                        type: 'image',
                        mimeType: 'image/png',
                        data: '',
                        metadata: {
                          chiridionR2Image: {
                            key: 'org1/workspace1/chat-sessions/thread1/pi-images/abc.base64',
                            mimeType: 'image/png',
                            size: imageData.length,
                            sha256: 'abc',
                            storedAt: 123,
                          },
                        },
                      },
                    ],
                    timestamp: 1,
                  }),
                },
              ],
            };
          }),
        },
      },
    };

    const messages = await ChatThreadDO.prototype['loadPiCoreMessages'].call(fake);

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toEqual([
      expect.objectContaining({
        type: 'image',
        mimeType: 'image/png',
        data: imageData,
      }),
    ]);
    expect(get).toHaveBeenCalledWith('org1/workspace1/chat-sessions/thread1/pi-images/abc.base64');
    expect(fake.recordChatThreadObservabilityEvent).toHaveBeenCalledWith(
      'pi_r2_image_hydrated',
      expect.objectContaining({
        operation: 'load_history',
        status: 'ok',
        size: imageData.length,
      }),
    );
  });

  it('sanitizes unsupported image tool outputs before Pi can persist them', () => {
    const content = ChatThreadDO.prototype['extractToolContent'].call(
      Object.create(ChatThreadDO.prototype),
      {
        content: [
          {
            type: 'image',
            data: 'AA==',
            mimeType: 'image/vnd.microsoft.icon',
          },
          {
            type: 'image',
            data: 'BB==',
            mimeType: 'image/png',
          },
        ],
      },
    );

    expect(content).toEqual([
      {
        type: 'text',
        text: '(image omitted: unsupported MIME type image/vnd.microsoft.icon)',
      },
      {
        type: 'image',
        data: 'BB==',
        mimeType: 'image/png',
      },
    ]);
  });

  it('does not emit an extra completed agent message after streamed Pi text', async () => {
    const { fake, events } = createPiEventFake();

    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, { type: 'agent_start' });
    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
      type: 'message_update',
      message: { role: 'assistant', content: [] },
      assistantMessageEvent: {
        type: 'text_delta',
        delta: 'Hello',
      },
    });
    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
      type: 'agent_end',
      messages: [{
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello' }],
        responseId: 'resp1',
        timestamp: 123,
      }],
    });

    const runtimeEvents = events.filter((event) => event.type === 'runtime_event');
    expect(runtimeEvents.map((event) => event.event.method)).toEqual([
      'item/agentMessage/delta',
      'turn/completed',
    ]);
    expect(runtimeEvents[0].event.params).toMatchObject({
      threadId: 'thread1',
      delta: 'Hello',
    });
    expect(runtimeEvents[1].event.params).toMatchObject({
      threadId: 'thread1',
      forkEntryId: 'resp1',
      completedAtMs: expect.any(Number),
      turnDurationMs: expect.any(Number),
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: 'result',
      threadId: 'thread1',
      result: 'Hello',
      sessionId: 'thread1',
    }));
    expect(fake.upsertPiCoreMessages).not.toHaveBeenCalled();
  });

  it('emits completed agent messages for non-streamed Pi message_end text', async () => {
    const { fake, events } = createPiEventFake();

    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, { type: 'agent_start' });
    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Whole reply' }],
      },
    });
    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
      type: 'agent_end',
      messages: [{
        role: 'assistant',
        content: [{ type: 'text', text: 'Whole reply' }],
        responseId: 'resp2',
        timestamp: 456,
      }],
    });

    const runtimeEvents = events.filter((event) => event.type === 'runtime_event');
    expect(runtimeEvents.map((event) => event.event.method)).toEqual([
      'item/completed',
      'turn/completed',
    ]);
    expect(runtimeEvents[0].event.params).toMatchObject({
      threadId: 'thread1',
      item: {
        type: 'agentMessage',
        text: 'Whole reply',
      },
    });
    expect(runtimeEvents[0].event.params.item.id).toMatch(/^pi_agent_/);
    expect(runtimeEvents[1].event.params).toMatchObject({
      threadId: 'thread1',
      forkEntryId: 'resp2',
      completedAtMs: expect.any(Number),
      turnDurationMs: expect.any(Number),
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: 'result',
      result: 'Whole reply',
    }));
    expect(fake.appendPiInFlightMessages).toHaveBeenCalledWith([
      expect.objectContaining({
        role: 'assistant',
        content: [{ type: 'text', text: 'Whole reply' }],
      }),
    ]);
    expect(fake.upsertPiCoreMessages).not.toHaveBeenCalled();
  });

  it('emits Pi agent_end provider errors', async () => {
    const { fake, events } = createPiEventFake();
    const errorMessage =
      '429 {"error":{"type":"rate_limit_error","message":"Type 2b rate limited. Please try again later."}}';

    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, { type: 'agent_start' });
    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
      type: 'agent_end',
      messages: [{
        role: 'assistant',
        content: [],
        errorMessage,
        responseId: 'resp_error',
        timestamp: 789,
      }],
    });

    expect(events).toContainEqual(expect.objectContaining({
      type: 'error',
      error: errorMessage,
      source: 'chat_thread_do_pi',
      status: 429,
      errorType: 'rate_limit_error',
    }));
  });

  it('does not emit provider errors for user-aborted Pi turns', async () => {
    const { fake, events } = createPiEventFake();

    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, { type: 'agent_start' });
    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
      type: 'agent_end',
      messages: [{
        role: 'assistant',
        content: [],
        stopReason: 'aborted',
        errorMessage: 'Request was aborted',
        responseId: 'resp_aborted',
        timestamp: 789,
      }],
    });

    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'result',
      result: '',
    }));
  });

  it('emits and persists a final stopped-by-user Pi message after a user stop', async () => {
    const { fake, events } = createPiEventFake();
    const inFlight = [
      { role: 'user', content: 'build it', timestamp: 100 },
      {
        role: 'assistant',
        content: [{
          type: 'toolCall',
          id: 'tool1',
          name: 'bash',
          arguments: { command: 'sleep 60' },
        }],
        responseId: 'resp_tool',
        timestamp: 200,
        api: 'test',
        provider: 'test',
        model: 'test',
        usage: {},
        stopReason: 'toolUse',
      },
    ];

    fake.piUserStopRequestedAtMs = 1234;
    fake.piMainBaselineIndex = 3;
    fake.piSession = {
      state: {
        model: { api: 'test', provider: 'test', id: 'test-model' },
        messages: [
          { role: 'user', content: 'previous', timestamp: 50 },
          ...inFlight,
          {
            role: 'assistant',
            content: [{ type: 'text', text: '' }],
            stopReason: 'aborted',
            errorMessage: 'Request was aborted',
            responseId: 'resp_aborted',
            timestamp: 789,
          },
        ],
      },
    };
    fake.loadPiInFlightMessages = vi.fn(() => inFlight);

    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, { type: 'agent_start' });
    fake.piUserStopRequestedAtMs = 1234;
    fake.piMainBaselineIndex = 3;
    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
      type: 'agent_end',
      messages: [
        ...inFlight,
        {
          role: 'assistant',
          content: [{ type: 'text', text: '' }],
          stopReason: 'aborted',
          errorMessage: 'Request was aborted',
          responseId: 'resp_aborted',
          timestamp: 789,
        },
      ],
    });

    expect(fake.appendPiCoreMessagesIfMissing).toHaveBeenCalledWith([
      ...inFlight,
      expect.objectContaining({
        role: 'assistant',
        content: [{ type: 'text', text: 'Stopped by user' }],
        stopReason: 'aborted',
        responseId: 'pi_user_stop_1234',
        timestamp: 1234,
        metadata: { reason: 'user_stop' },
      }),
    ]);
    expect(events).toContainEqual({
      type: 'runtime_event',
      event: {
        method: 'item/agentMessage/delta',
        params: {
          threadId: 'thread1',
          itemId: 'pi_user_stop_1234',
          itemKind: 'userStop',
          delta: 'Stopped by user',
        },
      },
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: 'result',
      result: 'Stopped by user',
    }));
    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(fake.clearPiInFlightMessages).toHaveBeenCalledTimes(1);
    expect(fake.piSession.state.messages).toEqual([
      { role: 'user', content: 'previous', timestamp: 50 },
      ...inFlight,
      expect.objectContaining({
        role: 'assistant',
        content: [{ type: 'text', text: 'Stopped by user' }],
        responseId: 'pi_user_stop_1234',
      }),
    ]);
    expect(fake.piMainBaselineIndex).toBe(4);
    expect(fake.piUserStopRequestedAtMs).toBe(0);
  });

  it('does not echo non-assistant Pi message_end text into the assistant stream', async () => {
    const { fake, events } = createPiEventFake();

    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, { type: 'agent_start' });
    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
      type: 'message_end',
      message: {
        role: 'user',
        content: 'please do the thing',
      },
    });

    expect(events.filter((event) => event.type === 'runtime_event')).toEqual([]);
  });

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
      { content: 'Check state', status: 'in_progress', activeForm: 'Check state' },
    ]);
    expect(sent.map((message) => JSON.parse(message))).toContainEqual({
      type: 'todo_state',
      todos: [{ content: 'Check state', status: 'in_progress', activeForm: 'Check state' }],
    });

    await ChatThreadDO.prototype.setTodoState.call(fake, []);

    expect(deleteKey).toHaveBeenCalledWith('chatTodos');
  });

  it('normalizes todo state aliases before persisting and broadcasting', async () => {
    const put = vi.fn();
    const sent: string[] = [];
    const fake = Object.create(ChatThreadDO.prototype) as any;

    fake.currentTodos = [];
    fake.ctx = {
      storage: { kv: { put, delete: vi.fn() } },
      getWebSockets: vi.fn(() => [{ send: vi.fn((message: string) => sent.push(message)) }]),
    };
    fake.trace = vi.fn();

    await ChatThreadDO.prototype.setTodoState.call(fake, [
      { step: 'Inspect logs', status: 'inProgress' },
      { title: 'Patch proxy env', status: 'running', active_form: 'Patching proxy env' },
      'Retry deploy',
    ]);

    const expected = [
      { content: 'Inspect logs', status: 'in_progress', activeForm: 'Inspect logs' },
      { content: 'Patch proxy env', status: 'in_progress', activeForm: 'Patching proxy env' },
      { content: 'Retry deploy', status: 'pending', activeForm: 'Retry deploy' },
    ];
    expect(put).toHaveBeenCalledWith('chatTodos', expected);
    expect(sent.map((message) => JSON.parse(message))).toContainEqual({
      type: 'todo_state',
      todos: expected,
    });
  });

  it('hydrates persisted todo state when requested', () => {
    const get = vi.fn(() => [
      { content: 'Stored task', status: 'running', active_form: 'Running stored task' },
      { title: 'Stored pending task' },
    ]);
    const fake = Object.create(ChatThreadDO.prototype) as any;

    fake.currentTodos = [];
    fake.ctx = {
      storage: { kv: { get } },
    };

    const todos = ChatThreadDO.prototype.getTodoState.call(fake);

    const expected = [
      { content: 'Stored task', status: 'in_progress', activeForm: 'Running stored task' },
      { content: 'Stored pending task', status: 'pending', activeForm: 'Stored pending task' },
    ];
    expect(get).toHaveBeenCalledWith('chatTodos');
    expect(todos).toEqual(expected);
    expect(fake.currentTodos).toEqual(expected);
  });

  it('marks todos complete and removes persisted todo state when a turn ends', async () => {
    const deleteKey = vi.fn();
    const sent: string[] = [];
    const fake = Object.create(ChatThreadDO.prototype) as any;

    fake.currentTodos = [
      { content: 'Check state', status: 'in_progress', activeForm: 'Checking state' },
      { content: 'Summarize', status: 'pending', activeForm: 'Summarizing' },
    ];
    fake.ctx = {
      storage: { kv: { delete: deleteKey } },
      getWebSockets: vi.fn(() => [{ send: vi.fn((message: string) => sent.push(message)) }]),
    };
    fake.trace = vi.fn();

    await ChatThreadDO.prototype.completeTodoStateForTurnEnd.call(fake);

    expect(fake.currentTodos).toEqual([]);
    expect(deleteKey).toHaveBeenCalledWith('chatTodos');
    expect(sent.map((message) => JSON.parse(message))).toContainEqual({
      type: 'todo_state',
      todos: [
        { content: 'Check state', status: 'completed', activeForm: 'Checking state' },
        { content: 'Summarize', status: 'completed', activeForm: 'Summarizing' },
      ],
    });
  });

  it('clears stale non-streaming todo state when a chat initializes', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    const sent: string[] = [];

    fake.chatContext = {
      threadId: 'thread1',
      workspaceId: 'workspace1',
      orgId: 'org1',
    };
    fake.chatIsStreaming = false;
    fake.currentTodos = [{ content: 'Old task', status: 'in_progress' }];
    fake.previewTarget = null;
    fake.previewTabs = [];
    fake.previewActiveTabId = null;
    fake.previewVersion = 0;
    fake.chatEventBuffer = [];
    fake.transientContextUsedPercent = null;
    fake.contextUsedPercent = null;
    fake.trace = vi.fn();
    fake.browserPrompts = {
      sendPendingPromptsToWebSocket: vi.fn(),
      pendingQuestionPrompts: vi.fn(() => []),
      pendingQuestionCount: 0,
    };
    fake.replayChatEvents = vi.fn();
    fake.completeTodoStateForTurnEnd = vi.fn(async () => {
      fake.currentTodos = [];
    });

    const ws = { send: vi.fn((message: string) => sent.push(message)) };

    await ChatThreadDO.prototype['handleChatInit'].call(fake, ws, {
      type: 'init',
      mode: 'side_channel',
      threadId: 'thread1',
    });

    expect(fake.completeTodoStateForTurnEnd).toHaveBeenCalledTimes(1);
    expect(sent.map((message) => JSON.parse(message))).not.toContainEqual({
      type: 'todo_state',
      todos: [{ content: 'Old task', status: 'in_progress' }],
    });
  });

  it('buffers generated thread titles so later chat init can replay them', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    const sent: string[] = [];

    fake.chatContext = {
      threadId: 'thread1',
      workspaceId: 'workspace1',
      orgId: 'org1',
    };
    fake.chatIsStreaming = false;
    fake.currentTodos = [];
    fake.previewTarget = null;
    fake.previewTabs = [];
    fake.previewActiveTabId = null;
    fake.previewVersion = 0;
    fake.chatEventBuffer = [];
    fake.nextChatEventId = 1;
    fake.transientContextUsedPercent = null;
    fake.contextUsedPercent = null;
    fake.trace = vi.fn();
    fake.browserPrompts = {
      sendPendingPromptsToWebSocket: vi.fn(),
      pendingQuestionPrompts: vi.fn(() => []),
      pendingQuestionCount: 0,
    };
    fake.broadcastChat = vi.fn();
    fake.broadcastRunnerClients = vi.fn();
    fake.ctx = { storage: { kv: { put: vi.fn() } } };
    fake.completeTodoStateForTurnEnd = vi.fn();

    await ChatThreadDO.prototype.setTitle.call(
      fake,
      'Generated title',
      1_710_000_000_000,
    );

    const ws = { send: vi.fn((message: string) => sent.push(message)) };

    await ChatThreadDO.prototype['handleChatInit'].call(fake, ws, {
      type: 'init',
      mode: 'side_channel',
      threadId: 'thread1',
    });

    const messages = sent.map((message) => JSON.parse(message));
    expect(messages).toContainEqual({
      type: 'title_updated',
      title: 'Generated title',
      updatedAt: 1_710_000_000_000,
      eventId: 1,
      sessionId: 'thread1',
    });
    expect(messages.findIndex((message) => message.type === 'title_updated')).toBeGreaterThan(
      messages.findIndex((message) => message.type === 'ready'),
    );
  });

  it('selects raw Durable Object Pi messages for a fork target', async () => {
    const sourceMessages = [
      { role: 'user', content: 'Build it', timestamp: 100 },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Done' }],
        responseId: 'resp1',
        timestamp: 200,
        api: 'test',
        provider: 'test',
        model: 'test',
        usage: {},
        stopReason: 'stop',
      },
      { role: 'user', content: 'Too far', timestamp: 300 },
    ];
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.loadPiCoreMessages = vi.fn(() => sourceMessages);

    const result = await ChatThreadDO.prototype.getPiCoreForkMessages.call(fake, {
      forkEntryId: 'resp1',
    });

    expect(result).toMatchObject({
      success: true,
      messageCount: 2,
      messages: [
        expect.objectContaining({ role: 'user', content: 'Build it' }),
        expect.objectContaining({ role: 'assistant', responseId: 'resp1' }),
      ],
    });
    expect(result.messages).not.toBe(sourceMessages);
    expect(result.messages?.[1]).not.toBe(sourceMessages[1]);
  });

  it('reports a missing Durable Object Pi fork target without falling back', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.loadPiCoreMessages = vi.fn(() => [
      { role: 'user', content: 'Build it', timestamp: 100 },
    ]);

    const result = await ChatThreadDO.prototype.getPiCoreForkMessages.call(fake, {
      forkEntryId: 'missing',
      renderedMessageId: 'rendered-missing',
    });

    expect(result).toEqual({
      success: false,
      code: 'TARGET_NOT_FOUND',
      error: 'Fork target not found in Durable Object Pi messages',
    });
  });

  it('sends channel email attachments from mounted workspace output paths', async () => {
    const send = vi.fn(async () => ({ messageId: 'email-1' }));
    const kvPutMock = vi.fn(async () => undefined);
    const get = vi.fn(async (key: string) =>
      key === 'org1/workspace1/user-outputs/report.pdf'
        ? r2Object('pdf bytes', 'application/pdf')
        : null
    );
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.getOriginatingChannelThread = vi.fn(async () => ({
      source: 'channel',
      channel_kind: 'email',
      channel_connection_id: 'sender@example.com',
    }));
    fake.env = {
      EMAIL: { send },
      EMAIL_FROM_ADDRESS: 'no-reply@mail.camelai.com',
      APP_KV: { put: kvPutMock },
      R2_BUCKET: { get },
    };

    const result = await ChatThreadDO.prototype['sendChannelEmailTool'].call(
      fake,
      { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
      {
        to: 'sender@example.com',
        subject: 'Report',
        text: 'Attached.',
        attachments: [{ path: '/mnt/user-outputs/report.pdf' }],
      },
    );

    expect(result.details).toMatchObject({
      status: 'sent',
      provider: 'cloudflare_email',
      attachmentCount: 1,
    });
    expect(get).toHaveBeenCalledWith('org1/workspace1/user-outputs/report.pdf');
    expect(send).toHaveBeenCalledTimes(1);
    const message = send.mock.calls[0][0];
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments[0]).toMatchObject({
      filename: 'report.pdf',
      type: 'application/pdf',
      disposition: 'attachment',
    });
    expect(message.attachments[0].content).toBeInstanceOf(ArrayBuffer);
    expect(kvPutMock).toHaveBeenCalledWith(
      'email_reply_ref:workspace1:email-1',
      'thread1',
      { expirationTtl: 180 * 24 * 60 * 60 },
    );
  });

  it('rejects oversized channel attachments before buffering R2 object content', async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    const get = vi.fn(async (key: string) =>
      key === 'org1/workspace1/user-outputs/large.bin'
        ? {
            size: 26 * 1024 * 1024,
            httpMetadata: { contentType: 'application/octet-stream' },
            arrayBuffer,
          }
        : null
    );
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.env = { R2_BUCKET: { get } };

    await expect(
      ChatThreadDO.prototype['resolveChannelOutboundAttachments'].call(
        fake,
        { orgId: 'org1', workspaceId: 'workspace1' },
        { attachments: [{ path: '/mnt/user-outputs/large.bin' }] },
      ),
    ).rejects.toThrow('Attachment size must be 25 MB or less');
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('uploads Slack channel attachments through the external file upload flow', async () => {
    const encrypted = await encryptCredentials(
      { access_token: 'xoxb-token', team_id: 'T1' },
      'secret',
    );
    const get = vi.fn(async (key: string) =>
      key === 'org1/workspace1/user-outputs/chart.png'
        ? r2Object('png bytes', 'image/png')
        : null
    );
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/files.getUploadURLExternal')) {
        return Response.json({
          ok: true,
          upload_url: 'https://files.slack.com/upload/v1/abc',
          file_id: 'F123',
        });
      }
      if (url === 'https://files.slack.com/upload/v1/abc') {
        expect(init?.body).toBeInstanceOf(ArrayBuffer);
        return new Response('OK - 9');
      }
      if (url.endsWith('/files.completeUploadExternal')) {
        const payload = JSON.parse(String(init?.body));
        expect(payload).toMatchObject({
          channel_id: 'C1',
          thread_ts: '1700000000.000100',
          initial_comment: 'Attached.',
          files: [{ id: 'F123', title: 'chart.png' }],
        });
        return Response.json({
          ok: true,
          ts: '1700000001.000200',
          files: [{ id: 'F123' }],
        });
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.getOriginatingChannelThread = vi.fn(async () => ({
      source: 'channel',
      channel_kind: 'slack',
      channel_connection_id: 'slack-int',
      channel_conversation_id: 'T1:C1:1700000000.000100',
    }));
    fake.env = {
      INTEGRATION_SECRET_KEY: 'secret',
      R2_BUCKET: { get },
      WORKSPACE: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({
          getIntegrations: vi.fn(async () => [{
            id: 'slack-int',
            integration_type: 'slack',
            config: JSON.stringify({ team_id: 'T1' }),
          }]),
          getIntegration: vi.fn(async () => ({
            integration_type: 'slack',
            credentials_encrypted: encrypted,
          })),
        })),
      },
    };

    const result = await ChatThreadDO.prototype['sendChannelSlackMessageTool'].call(
      fake,
      { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
      {
        text: 'Attached.',
        attachments: [{ path: '/mnt/user-outputs/chart.png' }],
      },
    );

    expect(result.details).toMatchObject({
      status: 'sent',
      channel: 'slack',
      attachmentCount: 1,
      fileIds: ['F123'],
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('sends Telegram channel attachments as documents', async () => {
    const get = vi.fn(async (key: string) =>
      key === 'org1/workspace1/user-outputs/report.csv'
        ? r2Object('a,b\n1,2\n', 'text/csv')
        : null
    );
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/sendMessage')) {
        const payload = JSON.parse(String(init?.body));
        expect(payload).toMatchObject({ chat_id: '12345', text: 'Attached.' });
        return Response.json({ ok: true, result: { message_id: 10 } });
      }
      if (url.endsWith('/sendDocument')) {
        expect(init?.body).toBeInstanceOf(FormData);
        const form = init?.body as FormData;
        expect(form.get('chat_id')).toBe('12345');
        expect(form.get('caption')).toBe('CSV');
        expect(form.get('document')).toBeInstanceOf(File);
        return Response.json({ ok: true, result: { message_id: 11 } });
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.getOriginatingChannelThread = vi.fn(async () => ({
      source: 'channel',
      channel_kind: 'telegram',
      channel_conversation_id: '12345',
    }));
    fake.env = {
      TELEGRAM_BOT_TOKEN: 'bot-token',
      R2_BUCKET: { get },
    };

    const result = await ChatThreadDO.prototype['sendChannelTelegramMessageTool'].call(
      fake,
      { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
      {
        text: 'Attached.',
        attachments: [{ path: '/mnt/user-outputs/report.csv', caption: 'CSV' }],
      },
    );

    expect(result.details).toMatchObject({
      status: 'sent',
      channel: 'telegram',
      attachmentCount: 1,
      messageIds: [10, 11],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('selects Slack connection by decrypted team id when sending outside Slack threads', async () => {
    const wrongEncrypted = await encryptCredentials(
      { access_token: 'xoxb-wrong', team_id: 'T-wrong' },
      'secret',
    );
    const rightEncrypted = await encryptCredentials(
      { access_token: 'xoxb-right', team_id: 'T-right' },
      'secret',
    );
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://slack.com/api/chat.postMessage');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer xoxb-right');
      const payload = JSON.parse(String(init?.body));
      expect(payload).toMatchObject({
        channel: 'C-right',
        thread_ts: '1700000000.000300',
        text: 'Hello',
      });
      return Response.json({ ok: true, ts: '1700000001.000400' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.getOriginatingChannelThread = vi.fn(async () => null);
    fake.env = {
      INTEGRATION_SECRET_KEY: 'secret',
      R2_BUCKET: { get: vi.fn() },
      WORKSPACE: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({
          getIntegrations: vi.fn(async () => [
            { id: 'wrong', integration_type: 'slack', credentials_encrypted: wrongEncrypted },
            { id: 'right', integration_type: 'slack', credentials_encrypted: rightEncrypted },
          ]),
        })),
      },
    };

    const result = await ChatThreadDO.prototype['sendChannelSlackMessageTool'].call(
      fake,
      { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
      {
        text: 'Hello',
        team_id: 'T-right',
        channel_id: 'C-right',
        thread_ts: '1700000000.000300',
      },
    );

    expect(result.details).toMatchObject({
      status: 'sent',
      channel: 'slack',
      teamId: 'T-right',
      channelId: 'C-right',
      ts: '1700000001.000400',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects raw Telegram chat ids outside Telegram threads without a workspace integration', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.getOriginatingChannelThread = vi.fn(async () => null);
    fake.env = {
      TELEGRAM_BOT_TOKEN: 'bot-token',
      R2_BUCKET: { get: vi.fn() },
    };

    await expect(
      ChatThreadDO.prototype['sendChannelTelegramMessageTool'].call(
        fake,
        { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
        {
          chat_id: '12345',
          text: 'Hello',
        },
      ),
    ).rejects.toThrow('Telegram integration_id is required outside Telegram-originated threads');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends Telegram messages through a configured workspace integration outside Telegram threads', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toMatch(/\/sendMessage$/);
      const payload = JSON.parse(String(init?.body));
      expect(payload).toMatchObject({ chat_id: '12345', text: 'Hello' });
      return Response.json({ ok: true, result: { message_id: 19 } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.getOriginatingChannelThread = vi.fn(async () => null);
    fake.env = {
      TELEGRAM_BOT_TOKEN: 'bot-token',
      R2_BUCKET: { get: vi.fn() },
      WORKSPACE: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({
          getIntegration: vi.fn(async () => ({
            integration_type: 'telegram',
            config: JSON.stringify({ chat_id: '12345' }),
          })),
        })),
      },
    };

    const result = await ChatThreadDO.prototype['sendChannelTelegramMessageTool'].call(
      fake,
      { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
      {
        integration_id: 'telegram-int',
        chat_id: '12345',
        text: 'Hello',
      },
    );

    expect(result.details).toMatchObject({
      status: 'sent',
      channel: 'telegram',
      chatId: '12345',
      messageIds: [19],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects mismatched Telegram chat ids for workspace integrations', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.getOriginatingChannelThread = vi.fn(async () => null);
    fake.env = {
      TELEGRAM_BOT_TOKEN: 'bot-token',
      R2_BUCKET: { get: vi.fn() },
      WORKSPACE: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({
          getIntegration: vi.fn(async () => ({
            integration_type: 'telegram',
            config: JSON.stringify({ chat_id: '12345' }),
          })),
        })),
      },
    };

    await expect(
      ChatThreadDO.prototype['sendChannelTelegramMessageTool'].call(
        fake,
        { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
        {
          integration_id: 'telegram-int',
          chat_id: '67890',
          text: 'Hello',
        },
      ),
    ).rejects.toThrow('Telegram chat_id does not match the configured workspace integration');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends Telegram image attachments as photos', async () => {
    const get = vi.fn(async (key: string) =>
      key === 'org1/workspace1/user-outputs/chart.png'
        ? r2Object('png bytes', 'image/png')
        : null
    );
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/sendPhoto')) {
        expect(init?.body).toBeInstanceOf(FormData);
        const form = init?.body as FormData;
        expect(form.get('chat_id')).toBe('12345');
        expect(form.get('caption')).toBe('Chart');
        expect(form.get('photo')).toBeInstanceOf(File);
        expect(form.get('document')).toBeNull();
        return Response.json({ ok: true, result: { message_id: 20 } });
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.getOriginatingChannelThread = vi.fn(async () => ({
      source: 'channel',
      channel_kind: 'telegram',
      channel_conversation_id: '12345',
    }));
    fake.env = {
      TELEGRAM_BOT_TOKEN: 'bot-token',
      R2_BUCKET: { get },
    };

    const result = await ChatThreadDO.prototype['sendChannelTelegramMessageTool'].call(
      fake,
      { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
      {
        attachments: [{ path: '/mnt/user-outputs/chart.png', caption: 'Chart' }],
      },
    );

    expect(result.details).toMatchObject({
      status: 'sent',
      channel: 'telegram',
      attachmentCount: 1,
      messageIds: [20],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to Telegram documents when photo upload is rejected', async () => {
    const get = vi.fn(async (key: string) =>
      key === 'org1/workspace1/user-outputs/large-photo.png'
        ? r2Object('png bytes', 'image/png')
        : null
    );
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/sendPhoto')) {
        expect(init?.body).toBeInstanceOf(FormData);
        return Response.json({ ok: false, description: 'PHOTO_INVALID_DIMENSIONS' }, { status: 400 });
      }
      if (url.endsWith('/sendDocument')) {
        const form = init?.body as FormData;
        expect(form.get('chat_id')).toBe('12345');
        expect(form.get('document')).toBeInstanceOf(File);
        return Response.json({ ok: true, result: { message_id: 21 } });
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.getOriginatingChannelThread = vi.fn(async () => ({
      source: 'channel',
      channel_kind: 'telegram',
      channel_conversation_id: '12345',
    }));
    fake.env = {
      TELEGRAM_BOT_TOKEN: 'bot-token',
      R2_BUCKET: { get },
    };

    try {
      const result = await ChatThreadDO.prototype['sendChannelTelegramMessageTool'].call(
        fake,
        { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
        {
          attachments: [{ path: '/mnt/user-outputs/large-photo.png' }],
        },
      );

      expect(result.details).toMatchObject({
        status: 'sent',
        channel: 'telegram',
        attachmentCount: 1,
        messageIds: [21],
      });
    } finally {
      warnSpy.mockRestore();
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('respects explicit Telegram send_as document for image attachments', async () => {
    const get = vi.fn(async (key: string) =>
      key === 'org1/workspace1/user-outputs/chart.png'
        ? r2Object('png bytes', 'image/png')
        : null
    );
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      expect(url).toMatch(/\/sendDocument$/);
      const form = init?.body as FormData;
      expect(form.get('document')).toBeInstanceOf(File);
      expect(form.get('photo')).toBeNull();
      return Response.json({ ok: true, result: { message_id: 22 } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.getOriginatingChannelThread = vi.fn(async () => ({
      source: 'channel',
      channel_kind: 'telegram',
      channel_conversation_id: '12345',
    }));
    fake.env = {
      TELEGRAM_BOT_TOKEN: 'bot-token',
      R2_BUCKET: { get },
    };

    const result = await ChatThreadDO.prototype['sendChannelTelegramMessageTool'].call(
      fake,
      { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
      {
        attachments: [{ path: '/mnt/user-outputs/chart.png', send_as: 'document' }],
      },
    );

    expect(result.details.messageIds).toEqual([22]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

});
