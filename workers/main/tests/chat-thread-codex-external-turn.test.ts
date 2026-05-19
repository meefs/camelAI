import { describe, expect, it, vi } from 'vitest';
import { ChatThreadDO, CodeModeToolsBinding, prepareCodeModeUserCode } from '../src/durable-objects';
import { validateSignedToken } from '../src/signed-tokens';
import { WorkspaceContainer } from '../src/workspace-container';

describe('ChatThreadDO Codex external turn completion', () => {
  function createPiEventFake() {
    const events: any[] = [];
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.chatContext = {
      threadId: 'thread1',
      workspaceId: 'workspace1',
      orgId: 'org1',
      userId: 'user1',
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
    fake.resolvePendingExternalTurn = vi.fn();
    fake.pushChatEvent = vi.fn((event: any) => events.push(event));
    return { fake, events };
  }

  it('resolves harness-prefixed Codex model ids before selecting the Pi model', () => {
    const result = ChatThreadDO.prototype['resolvePiModelReference'].call(
      Object.create(ChatThreadDO.prototype),
      'codex',
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
      { provider: 'codex', orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
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
      { provider: 'codex', orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
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

  it('fails loudly when Pi context provider is missing', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;

    await expect(
      ChatThreadDO.prototype['resolvePiModel'].call(
        fake,
        { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
        { CHIRIDION_CLAUDE_MODEL: 'sonnet' },
        vi.fn(),
      ),
    ).rejects.toThrow('Missing Pi provider for thread context thread1');
  });

  it('uses the provider loaded from the thread record when initializing Pi', async () => {
    const orgStub = {
      getThread: vi.fn(async () => ({
        id: 'thread1',
        provider: 'claude',
        model: 'sonnet',
      })),
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
    fake.hydratePiCoreMessagesFromLegacy = vi.fn(async () => undefined);
    fake.ensurePiSession = vi.fn(async () => undefined);

    const buildEnvSpy = vi
      .spyOn(WorkspaceContainer.prototype, 'buildChatRunnerEnv')
      .mockResolvedValue({
        envVars: {
          CHIRIDION_CLAUDE_MODEL: 'sonnet',
          CHIRIDION_CODEX_MODEL: 'gpt-5.4',
        },
      });

    try {
      await ChatThreadDO.prototype['ensureRunnerConnected'].call(fake);
    } finally {
      buildEnvSpy.mockRestore();
    }

    expect(fake.chatContext.provider).toBe('claude');
    expect(fake.hydratePiCoreMessagesFromLegacy).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'claude' }),
      expect.any(WorkspaceContainer),
      expect.any(Object),
    );
    expect(fake.ensurePiSession).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'claude' }),
      expect.any(Object),
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
      { provider: 'codex', orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
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
        model: { contextWindow: 1_000_000 },
        messages: beforeMessages,
      },
    };
    fake.compactPiContext = vi.fn(async () => compactedMessages);
    fake.recordChatThreadObservabilityEvent = vi.fn();
    fake.piMainBaselineIndex = beforeMessages.length;

    await ChatThreadDO.prototype['compactPiContextAfterTurn'].call(
      fake,
      beforeMessages[1],
    );

    expect(fake.piSession.state.messages).toBe(compactedMessages);
    expect(fake.piMainBaselineIndex).toBe(compactedMessages.length);
    expect(fake.recordChatThreadObservabilityEvent).toHaveBeenCalledWith(
      'pi_post_turn_compacted',
      expect.objectContaining({
        count: beforeMessages.length,
        size: compactedMessages.length,
      }),
    );
  });

  it('routes Gemini aliases through OpenRouter chat completions rather than Google API shape', () => {
    const result = ChatThreadDO.prototype['resolvePiModelReference'].call(
      Object.create(ChatThreadDO.prototype),
      'codex',
      'gemini-3-flash-preview',
    );

    expect(result).toEqual({
      provider: 'openrouter',
      modelId: 'google/gemini-3-flash-preview',
      hostedGatewayProvider: 'openrouter',
      hostedModelId: 'google/gemini-3-flash-preview',
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
    expect(capturedWorkerCode.globalOutbound).toBeNull();
    expect(capturedWorkerCode.env.TOOLS).toBe(toolsBinding);
    expect(capturedWorkerCode.env.CONNECTIONS).toBe(connectionsBinding);
    expect(capturedWorkerCode.modules['index.js'].js).toContain('class CodeModeRunner');
    expect(capturedWorkerCode.modules['index.js'].js).toContain('createConnectionsFacade');
    expect(capturedWorkerCode.modules['index.js'].js).toContain('if (connectionName === "$find") return (query) => binding.find(query)');
    expect(capturedWorkerCode.modules['index.js'].js).toContain('if (connectionName === "$test") return (query) => binding.test(query)');
    expect(capturedWorkerCode.modules['index.js'].js).toContain('createOutputConsole');
    expect(capturedWorkerCode.modules['index.js'].js).toContain('globalThis.console = createOutputConsole(output)');
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
      code: 'text("hello")',
      timeoutMs: 1234,
      maxOutputCharacters: 4321,
    });

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

  it('builds Wrangler deploy proxy env from DO scope', async () => {
    const fake = Object.create(CodeModeToolsBinding.prototype) as any;
    fake.env = {
      WORKER_BASE_URL: 'https://staging.camelai.dev/',
      TOKEN_SIGNING_SECRET: 'secret-1',
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
    fake.getOrgSlug = vi.fn(async () => 'acme');

    const deployEnv = await CodeModeToolsBinding.prototype['createWranglerDeployEnv'].call(fake);

    expect(deployEnv.CLOUDFLARE_API_BASE_URL).toBe('https://staging.camelai.dev/client/v4');
    expect(deployEnv.CLOUDFLARE_ACCOUNT_ID).toBe('acct_1');
    const payload = await validateSignedToken('secret-1', deployEnv.CLOUDFLARE_API_TOKEN);
    expect(payload).toMatchObject({
      org_id: 'org1',
      org_slug: 'acme',
      user_id: 'user1',
      workspace_id: 'workspace1',
      thread_id: 'thread1',
      scopes: ['deploy'],
    });
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

    const commandEnv = await CodeModeToolsBinding.prototype['createContainerCommandEnv'].call(fake);

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
    fake.pendingQuestions = new Map();
    fake.pendingQuestionWaiters = new Map();
    fake.hasAvailableBrowserUser = vi.fn(() => true);
    fake.broadcastRealtime = vi.fn();

    const promise = ChatThreadDO.prototype.askUserQuestion.call(fake, {
      toolUseId: 'tool-ask',
      questions: [{
        question: "What's your favorite programming language?",
        options: ['TypeScript', 'Python', 'Go'],
      }],
    });

    expect(fake.broadcastRealtime).toHaveBeenCalledWith({
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

    const waiter = Array.from(fake.pendingQuestionWaiters.values())[0] as any;
    clearTimeout(waiter.timeoutId);
    waiter.resolve({ answer: 'TypeScript' });
    await expect(promise).resolves.toEqual({ answer: 'TypeScript' });
    vi.useRealTimers();
  });

  it('does not emit placeholder tool rows for unnamed preliminary Pi toolcall events', () => {
    const { fake, events } = createPiEventFake();

    ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, { type: 'agent_start' });
    ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
      type: 'message_update',
      message: { role: 'assistant', content: [] },
      assistantMessageEvent: {
        type: 'toolcall_start',
        toolCall: { id: 'tool1' },
      },
    });

    expect(events.filter((event) => event.type === 'runtime_event')).toEqual([]);

    ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
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

  it('maps Pi reasoning and tool events to the old host runtime event shapes', () => {
    const { fake, events } = createPiEventFake();

    ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, { type: 'agent_start' });
    ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
      type: 'message_update',
      message: { role: 'assistant', content: [] },
      assistantMessageEvent: {
        type: 'thinking_delta',
        contentIndex: 0,
        delta: 'thinking',
      },
    });
    ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
      type: 'tool_execution_start',
      toolCallId: 'tool1',
      toolName: 'bash',
      args: { command: 'echo hi', cwd: '/home/claude' },
    });
    ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
      type: 'tool_execution_update',
      toolCallId: 'tool1',
      toolName: 'bash',
      args: {},
      partialResult: { content: [{ type: 'text', text: 'hi\n' }], details: {} },
    });
    ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
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

  it('renders persisted Pi tool result messages with their assistant tool calls', () => {
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

    const messages = ChatThreadDO.prototype.getPiCoreParsedMessages.call(fake, 'thread1');

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
  });

  it('turn_end snapshots agent.state.messages past the baseline into main', () => {
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

    ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
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

  it('turn_end is a no-op when no new messages are past the baseline', () => {
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

    ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
      type: 'turn_end',
      message: allMessages[1],
      toolResults: [],
    });

    expect(fake.appendPiCoreMessagesIfMissing).not.toHaveBeenCalled();
    expect(fake.piMainBaselineIndex).toBe(2);
    expect(fake.clearPiInFlightMessages).toHaveBeenCalledTimes(1);
  });

  it('includes in-flight messages in the parsed chat view', () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.chatContext = { threadId: 'thread1' };
    fake.piCoreMessageToParsedChatMessage =
      ChatThreadDO.prototype['piCoreMessageToParsedChatMessage'];
    fake.piUserContentToChatContent =
      ChatThreadDO.prototype['piUserContentToChatContent'];
    fake.piAssistantContentToChatContent =
      ChatThreadDO.prototype['piAssistantContentToChatContent'];
    fake.isInvisibleSystemOnlyUserContent =
      ChatThreadDO.prototype['isInvisibleSystemOnlyUserContent'];
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

    const parsed = ChatThreadDO.prototype['getPiCoreParsedMessages'].call(
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
  it('sanitizes unsupported persisted Pi image tool results when loading history', () => {
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

    const messages = ChatThreadDO.prototype['loadPiCoreMessages'].call(fake);

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

  it('does not emit an extra completed agent message after streamed Pi text', () => {
    const { fake, events } = createPiEventFake();

    ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, { type: 'agent_start' });
    ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
      type: 'message_update',
      message: { role: 'assistant', content: [] },
      assistantMessageEvent: {
        type: 'text_delta',
        delta: 'Hello',
      },
    });
    ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
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
    expect(runtimeEvents[1].event.params).toEqual({
      threadId: 'thread1',
      forkEntryId: 'resp1',
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: 'result',
      threadId: 'thread1',
      result: 'Hello',
      sessionId: 'thread1',
    }));
    expect(fake.resolvePendingExternalTurn).toHaveBeenCalledWith({
      status: 'result',
      reply: 'Hello',
    });
    expect(fake.upsertPiCoreMessages).not.toHaveBeenCalled();
  });

  it('emits completed agent messages for non-streamed Pi message_end text', () => {
    const { fake, events } = createPiEventFake();

    ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, { type: 'agent_start' });
    ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Whole reply' }],
      },
    });
    ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
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
    expect(runtimeEvents[1].event.params).toEqual({
      threadId: 'thread1',
      forkEntryId: 'resp2',
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

  it('does not echo non-assistant Pi message_end text into the assistant stream', () => {
    const { fake, events } = createPiEventFake();

    ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, { type: 'agent_start' });
    ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
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
    fake.pendingQuestions = new Map();
    fake.previewTarget = null;
    fake.previewTabs = [];
    fake.previewActiveTabId = null;
    fake.previewVersion = 0;
    fake.chatEventBuffer = [];
    fake.transientContextUsedPercent = null;
    fake.contextUsedPercent = null;
    fake.trace = vi.fn();
    fake.sendPendingPromptsToWebSocket = vi.fn();
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
    fake.completeTodoStateForTurnEnd = vi.fn();
    fake.resolvePendingExternalTurn = ChatThreadDO.prototype['resolvePendingExternalTurn'];

    ChatThreadDO.prototype['handleRunnerEvent'].call(fake, {
      type: 'runtime_event',
      event: { method: 'turn/completed' },
    });

    expect(resolve).not.toHaveBeenCalled();
    expect(fake.pendingExternalTurn).not.toBeNull();
    expect(fake.completeTodoStateForTurnEnd).toHaveBeenCalledTimes(1);

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
      todos: [{ content: 'Ship fix', status: 'completed' }],
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
    fake.completeTodoStateForTurnEnd = vi.fn();
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

  it('selects raw Durable Object Pi messages for a fork target', () => {
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

    const result = ChatThreadDO.prototype.getPiCoreForkMessages.call(fake, {
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

  it('reports a missing Durable Object Pi fork target without falling back', () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.loadPiCoreMessages = vi.fn(() => [
      { role: 'user', content: 'Build it', timestamp: 100 },
    ]);

    const result = ChatThreadDO.prototype.getPiCoreForkMessages.call(fake, {
      forkEntryId: 'missing',
      renderedMessageId: 'rendered-missing',
    });

    expect(result).toEqual({
      success: false,
      code: 'TARGET_NOT_FOUND',
      error: 'Fork target not found in Durable Object Pi messages',
    });
  });

});
