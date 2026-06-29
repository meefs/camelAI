import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatThreadDO, CodeModeToolsBinding, prepareCodeModeUserCode } from '../src/chat-thread-do';
import { ChannelTools } from '../src/chat-channels';
import { piCoreMessageToParsedChatMessage, attachPiToolResultToParsedMessages } from '../src/pi-message-export';
import { PiModelMapping } from '../src/pi-model-resolution';
import { BrowserPromptCoordinator } from '../src/chat-thread-browser-prompts';
import { CamelAiService } from '../src/camelai-service';
import { validateSignedToken } from '../src/signed-tokens';
import { encryptCredentials } from '../../../src/lib/integration-crypto';
import { stripPiUiMetadata } from '../../../src/lib/runtime-artifacts';

afterEach(() => {
  vi.useRealTimers();
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

function createChannelOrgNamespace({
  billingPlan = 'starter',
  billingStatus = 'active',
  thread = {
    id: 'thread1',
    source: 'web',
    channel_kind: null,
    channel_connection_id: null,
  },
  recordThreadChannelUsed = vi.fn(async () => null),
  workspaceInfo = {
    id: 'workspace1',
    name: 'Test Workspace',
    email_handle: 'workspace-agent',
    archived: false,
  },
  integrations = [] as any[],
  integration = null as any,
}: {
  billingPlan?: string;
  billingStatus?: string;
  thread?: any;
  recordThreadChannelUsed?: ReturnType<typeof vi.fn>;
  workspaceInfo?: any;
  integrations?: any[];
  integration?: any;
} = {}) {
  const orgStub = {
    getInfo: vi.fn(async () => ({
      billing_plan: billingPlan,
      billing_status: billingStatus,
    })),
    getThread: vi.fn(async () => thread),
    recordThreadChannelUsed,
    getWorkspaceRecord: vi.fn(async () => workspaceInfo),
    getWorkspaceIntegrations: vi.fn(async () => integrations),
    getWorkspaceIntegration: vi.fn(async (_workspaceId: string, integrationId: string) =>
      integration ?? integrations.find((candidate) => candidate.id === integrationId) ?? null,
    ),
  };
  return {
    idFromName: vi.fn((id: string) => id),
    get: vi.fn(() => orgStub),
    _stub: orgStub,
  };
}

function base64(content: string): string {
  return btoa(unescape(encodeURIComponent(content)));
}

function createProjectToolFake({
  deploy = false,
  projectFileEntries,
  backend = 'do-r2',
}: {
  deploy?: boolean;
  projectFileEntries?: Array<[string, string]>;
  backend?: 'do-r2' | 'vm';
} = {}) {
  const project = {
    id: 'project-1',
    workspaceId: 'workspace1',
    name: 'Demo App',
    description: 'Demo project',
    defaultVmId: 'main',
    backend,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const projectFiles = new Map<string, string>(projectFileEntries ?? [
    ['/package.json', '{"scripts":{"build":"vite build"}}'],
    ['/src/index.ts', 'export default { fetch() { return new Response("ok"); } }'],
  ]);
  const workspaceStub = {
    getProjectByName: vi.fn(async (name: string) => name === 'Demo App' ? project : null),
    listProjectsForMigrationReset: vi.fn(async () => [project]),
    removeProjects: vi.fn(async (ids: string[]) => ({
      deleted: ids.includes(project.id) ? [project] : [],
      retained: ids.includes(project.id) ? [] : [project],
    })),
    createProject: vi.fn(async (input: any) => ({
      ...project,
      name: input.name,
      description: input.description,
      backend: input.backend,
    })),
  };
  const projectStub = {
    projectExists: vi.fn(async (path: string) => ({
      exists: projectFiles.has(path),
      isFile: projectFiles.has(path),
      isDirectory: false,
      size: projectFiles.get(path)?.length ?? 0,
    })),
    projectListFiles: vi.fn(async () => ({
      success: true,
      files: [...projectFiles.entries()].map(([path, content]) => ({
        name: path.split('/').pop(),
        type: 'file',
        size: content.length,
        modifiedAt: '2026-01-01T00:00:00.000Z',
        absolutePath: path,
        relativePath: path.replace(/^\/+/, ''),
      })),
      count: projectFiles.size,
      path: '/',
    })),
    projectReadFile: vi.fn(async (path: string) => ({
      success: true,
      content: projectFiles.get(path) ?? '',
      encoding: 'utf8',
      isBinary: false,
      size: projectFiles.get(path)?.length ?? 0,
    })),
    projectWriteFile: vi.fn(async (path: string, content: string) => {
      projectFiles.set(path, content);
      return { success: true };
    }),
    projectDeleteFile: vi.fn(async (path: string) => {
      projectFiles.delete(path);
      return { success: true };
    }),
    projectCreateSourceSnapshot: vi.fn(async () => ({
      id: 'snapshot-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      fileCount: projectFiles.size,
      totalBytes: [...projectFiles.values()].reduce((sum, content) => sum + content.length, 0),
      entries: [],
    })),
    projectRestoreSourceSnapshot: vi.fn(async (id: string) => ({
      id,
      createdAt: '2026-01-01T00:00:00.000Z',
      fileCount: 2,
      totalBytes: 96,
      entries: [],
    })),
    projectListSourceSnapshots: vi.fn(async () => [{
      id: 'snapshot-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      message: 'Deploy Demo App',
      fileCount: 2,
      totalBytes: 96,
      entries: [],
    }]),
  };
  const sandboxFiles = new Map<string, string>();
  const sandbox = {
    mkdir: vi.fn(async () => undefined),
    writeFile: vi.fn(async (path: string, content: string) => {
      sandboxFiles.set(path, content);
    }),
    exec: vi.fn(async (command: string, options?: { cwd?: string }) => {
      if (command === 'bun install && bun run build' && options?.cwd) {
        sandboxFiles.set(`${options.cwd}/bun.lock`, base64('# lockfile\n'));
        sandboxFiles.set(`${options.cwd}/build/server/wrangler.json`, base64(JSON.stringify({
          main_module: 'index.js',
          compatibility_date: '2026-06-01',
        })));
        sandboxFiles.set(`${options.cwd}/build/server/index.js`, base64('export default { fetch() { return new Response("ok"); } };'));
      }
      if (command === "bun add -d 'zod@^4'" && options?.cwd) {
        sandboxFiles.set(`${options.cwd}/package.json`, base64(JSON.stringify({
          scripts: { build: 'vite build' },
          devDependencies: { zod: '^4' },
        }, null, 2)));
        sandboxFiles.set(`${options.cwd}/bun.lock`, base64('# zod lockfile\n'));
        return { success: true, stdout: 'added zod', stderr: '', exitCode: 0 };
      }
      return { success: true, stdout: 'built', stderr: '', exitCode: 0 };
    }),
    readFile: vi.fn(async (path: string) => ({ content: sandboxFiles.get(path) ?? base64('') })),
    listFiles: vi.fn(async (path: string) => ({
      files: [...sandboxFiles.keys()]
        .filter((file) => file.startsWith(`${path.replace(/\/+$/g, '')}/`))
        .map((file) => ({
          name: file.split('/').pop() ?? '',
          type: 'file' as const,
          absolutePath: file,
          relativePath: file.slice(path.replace(/\/+$/g, '').length + 1),
        })),
    })),
  };
  const script = {
    script_name: 'demo-app',
    workspace_id: 'workspace1',
    is_public: false,
    custom_domain_hostname: null,
    updated_at: 123,
  };
  const orgStub = {
    getInfo: vi.fn(async () => ({ slug: 'test-org', billing_plan: 'starter', billing_status: 'active' })),
    getThread: vi.fn(async () => ({ id: 'thread1', workspace_id: 'workspace1', created_by: 'user1' })),
    registerWorkerScript: vi.fn(async () => script),
    updateWorkerScriptPreview: vi.fn(async () => ({ stale: false })),
    getWorkerScript: vi.fn(async () => script),
  };
  const env = {
    WORKER_BASE_URL: 'https://staging.camelai.dev',
    LOCAL_APP_VANITY_DOMAIN: 'camelai.app',
    WORKSPACE_FS: {
      idFromName: vi.fn((id: string) => id),
      get: vi.fn((id: string) => id === 'workspace1' ? workspaceStub : projectStub),
    },
    ORG: {
      idFromName: vi.fn((id: string) => id),
      get: vi.fn(() => orgStub),
    },
    APP_KV: {
      put: vi.fn(async () => undefined),
    },
    R2_BUCKET: deploy ? {
      put: vi.fn(async () => undefined),
    } : undefined,
    CF_API_TOKEN: deploy ? 'token' : undefined,
    CF_ACCOUNT_ID: deploy ? 'account' : undefined,
    CF_DISPATCH_NAMESPACE: deploy ? 'namespace' : undefined,
    CF_WORKER_NAME: deploy ? 'main-worker' : undefined,
  };
  const fake = Object.create(CodeModeToolsBinding.prototype) as any;
  fake.ctx = { props: { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1', userId: 'user1' } };
  fake.env = env;
  fake.projectBuildSandbox = vi.fn(() => sandbox);
  return { fake, env, sandbox, workspaceStub, projectStub, orgStub };
}

describe('ChatThreadDO Pi turn handling', () => {
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
    fake.ctx = {
      waitUntil: vi.fn(),
      // Pi turn-journal + active-turn marker storage (used by message_end /
      // turn_end / agent_end via recordPiTurnJournalTail / clearPiTurnJournal /
      // clearPiActiveTurnAndJournal). A no-op SQL/KV stub is enough for these
      // unit tests — the durable-resume behavior is covered in pi-turn-journal.test.ts.
      storage: {
        kv: { get: vi.fn(() => undefined), put: vi.fn(), delete: vi.fn() },
        sql: { exec: vi.fn(() => ({ toArray: () => [] })) },
      },
    };
    // The Agents SDK runFiber does real durable bookkeeping (cf_agents_runs
    // INSERT via an iterable SQL cursor); these unit tests only care that the
    // wrapped turn body runs, so invoke the callback directly. Durable-resume
    // semantics are covered separately in pi-turn-journal.test.ts.
    fake.runFiber = vi.fn(async (_name: string, fn: () => unknown) => fn());
    fake.piActiveItemId = null;
    fake.piActiveItemText = '';
    fake.piReasoningItemId = null;
    fake.piToolArgs = new Map();
    fake.piAssistantText = '';
    fake.markTurnStarted = vi.fn();
    fake.finishTurn = vi.fn();
    fake.appendPiCoreMessagesIfMissing = vi.fn();
    fake.upsertPiCoreMessages = vi.fn();
    fake.setActiveTurnUserId = vi.fn();
    fake.completeTodoStateForTurnEnd = vi.fn();
    fake.recordChatThreadObservabilityEvent = vi.fn();
    fake.pushChatEvent = vi.fn((event: any) => events.push(event));
    installAgentStateMocks(fake);
    return { fake, events, activityRecords, workspaceStub };
  }

  async function flushWaitUntil(fake: any) {
    await Promise.all(
      fake.ctx.waitUntil.mock.calls
        .map(([promise]: [Promise<unknown>]) => promise)
        .filter(Boolean),
    );
  }

  function installAgentStateMocks(fake: any) {
    fake.chatIsStreaming ??= false;
    fake.previewTabs ??= [];
    fake.previewActiveTabId ??= null;
    fake.previewVersion ??= 0;
    fake.currentTodos ??= [];
    fake.transientContextUsedPercent ??= null;
    fake.contextUsedPercent ??= null;
    fake.currentTitle ??= null;
    fake.currentTitleUpdatedAt ??= null;
    fake.currentThreadModel ??= null;
    fake.currentThreadModelUpdatedAt ??= null;
    fake.browserPrompts ??= {};
    fake.browserPrompts.getOldestPendingQuestion ??= vi.fn(() => null);
    fake.browserPrompts.pendingConnectionSetupPrompts ??= vi.fn(() => []);
    fake.setState = vi.fn();
    // The live overlay rides the broadcast channel, not setState. Assign
    // unconditionally — broadcastChat exists on the prototype, so ??= is a no-op.
    fake.broadcastChat = vi.fn();
  }

  it('normalizes retired Fable 5 requests to Sonnet', () => {
    const result = new PiModelMapping().resolvePiModelReference('fable-5');

    expect(result).toEqual({
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-6',
      hostedGatewayProvider: 'openrouter',
      hostedModelId: 'anthropic/claude-sonnet-4.6:nitro',
    });
  });

  it('preserves sentDuringStreaming metadata on parsed Pi user messages', () => {
    const result = piCoreMessageToParsedChatMessage(
      {
        role: 'user',
        content: 'also add dark mode',
        timestamp: 123,
        metadata: { sentDuringStreaming: true },
      },
      0,
      'thread1',
    );

    expect(result).toEqual([
      {
        id: 'pi_user_123_0',
        thread_id: 'thread1',
        role: 'user',
        content: 'also add dark mode',
        created_at: 123,
        forkEntryId: 'pi_user_123_0',
        sentDuringStreaming: true,
      },
    ]);
  });

  it('builds the live overlay whole and re-ids in place at turn completion without duplicating', () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.chatContext = { threadId: 'thread1' };
    fake.ctx = {};
    fake.liveStateHydrated = true;
    fake.liveMessages = [];
    fake.liveStreamingMessageId = null;
    fake.lastCompletedTurn = null;
    installAgentStateMocks(fake);

    // A streaming delta creates exactly one streaming assistant message.
    ChatThreadDO.prototype['applyChatEventToLiveState'].call(fake, {
      type: 'runtime_event',
      event: {
        method: 'item/agentMessage/delta',
        params: { itemId: 'item-1', delta: 'Hello' },
      },
    });

    expect(fake.liveMessages).toHaveLength(1);
    expect(fake.liveMessages[0]).toMatchObject({ role: 'assistant', isStreaming: true });
    expect(typeof fake.liveStreamingMessageId).toBe('string');
    const streamingId = fake.liveStreamingMessageId;

    // turn/completed re-ids the streaming message to the fork entry id. Because
    // the overlay is rebuilt in place, the message is replaced — not appended —
    // so there is no duplicate and no leftover streaming bubble.
    ChatThreadDO.prototype['applyChatEventToLiveState'].call(fake, {
      type: 'runtime_event',
      event: {
        method: 'turn/completed',
        params: { forkEntryId: 'fork-1', completedAtMs: 1700, turnDurationMs: 4200 },
      },
    });

    expect(fake.liveMessages).toHaveLength(1);
    expect(fake.liveMessages[0]).toMatchObject({
      id: 'fork-1',
      role: 'assistant',
      isStreaming: false,
    });
    expect(fake.liveMessages[0].id).not.toBe(streamingId);
    expect(fake.liveStreamingMessageId).toBeNull();
    // Completion metadata is captured for the duration/turn badges, keyed by the
    // assistant message id the browser renders.
    expect(fake.lastCompletedTurn).toEqual({
      id: 'fork-1',
      durationMs: 4200,
      completedAtMs: 1700,
    });
  });

  it('captures terminal errors in lastError state instead of broadcasting them', () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.chatContext = { threadId: 'thread1' };
    fake.liveStateHydrated = true;
    fake.liveMessages = [];
    fake.liveStreamingMessageId = null;
    fake.lastError = null;
    fake.agentEvalEventCollector = null;
    fake.ctx = { storage: { sql: {} } };
    fake.recordCurrentThreadError = vi.fn();
    fake.syncAgentState = vi.fn();
    fake.broadcastChat = vi.fn();

    // Errors ride Agent state (with a unique id) and are not broadcast as error
    // events, so a reconnect after a disconnected failure can still recover them.
    ChatThreadDO.prototype['pushChatEvent'].call(fake, {
      type: 'error',
      error: 'Boom',
      billingSource: 'byok',
      provider: 'bedrock',
      status: 429,
    });

    expect(fake.syncAgentState).toHaveBeenCalled();
    expect(typeof fake.lastError.id).toBe('string');
    expect(fake.lastError).toMatchObject({
      error: 'Boom',
      billingSource: 'byok',
      provider: 'bedrock',
      status: 429,
      errorType: null,
    });
    const errorBroadcasts = fake.broadcastChat.mock.calls.filter(
      ([msg]: [{ type?: string }]) => msg?.type === 'error',
    );
    expect(errorBroadcasts).toHaveLength(0);

    // Non-error terminal signals (result) are still broadcast as events.
    fake.broadcastChat.mockClear();
    ChatThreadDO.prototype['pushChatEvent'].call(fake, {
      type: 'result',
      result: 'done',
    });
    const resultBroadcasts = fake.broadcastChat.mock.calls.filter(
      ([msg]: [{ type?: string }]) => msg?.type === 'result',
    );
    expect(resultBroadcasts).toHaveLength(1);
  });

  it('clears the live overlay when a turn ends so reload sees no stale snapshot', () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.chatContext = null;
    fake.chatIsStreaming = true;
    fake.liveMessages = [
      {
        id: 'fork-1',
        thread_id: 'thread1',
        role: 'assistant',
        content: [],
        created_at: 1,
        isStreaming: false,
      },
    ];
    fake.liveStreamingMessageId = 'fork-1';
    fake.assistantCompletionRecordedAt = null;
    fake.assistantCompletionSummaryRequestedAt = null;
    fake.activeAutomationRun = null;
    fake.currentTodos = [];
    fake.resetRunningActivityState = vi.fn();
    fake.syncAgentState = vi.fn();

    ChatThreadDO.prototype['finishTurn'].call(fake);

    expect(fake.liveMessages).toEqual([]);
    expect(fake.liveStreamingMessageId).toBeNull();
    expect(fake.syncAgentState).toHaveBeenCalled();
  });

  it('sends an empty live_overlay to a reconnecting client when idle so a stale streaming tail clears', () => {
    // A turn that finished while the client was disconnected cleared liveMessages,
    // so its turn-end empty-overlay broadcast reached nobody. On reconnect the client
    // still holds its pre-disconnect streaming tail; the empty snapshot is the only
    // signal that folds it to non-streaming. Skipping the send strands the spinner.
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.chatContext = { threadId: 'thread1', workspaceId: 'workspace1', orgId: 'org1' };
    fake.liveMessages = [];
    fake.liveStreamingMessageId = null;
    fake.isThreadStreaming = vi.fn(() => false);
    const connection = { send: vi.fn() } as any;

    ChatThreadDO.prototype['sendLiveOverlayToConnection'].call(fake, connection);

    expect(connection.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(connection.send.mock.calls[0][0])).toEqual({
      type: 'live_overlay',
      threadId: 'thread1',
      messages: [],
      streamingMessageId: null,
    });
  });

  it('does NOT send an empty live_overlay when streaming with no overlay (cold-wake mid-turn)', () => {
    // A cold-woken DO mid-turn has an empty overlay (the non-durable tail is not
    // restored on wake) while isThreadStreaming() is still true from the durable
    // active-turn marker. Folding the client's tail here would finalize a still-
    // running turn and the next delta would start a duplicate overlay message, so
    // we must NOT send the empty clear — the resuming turn's deltas drive the client.
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.chatContext = { threadId: 'thread1', workspaceId: 'workspace1', orgId: 'org1' };
    fake.liveMessages = [];
    fake.liveStreamingMessageId = null;
    fake.isThreadStreaming = vi.fn(() => true);
    const connection = { send: vi.fn() } as any;

    ChatThreadDO.prototype['sendLiveOverlayToConnection'].call(fake, connection);

    expect(connection.send).not.toHaveBeenCalled();
  });

  it('sends the live overlay on a warm reconnect mid-turn regardless of streaming state', () => {
    // A warm reconnect mid-turn has the in-memory overlay; send it so streaming
    // resumes. isThreadStreaming() is true but the non-empty overlay short-circuits
    // the idle gate.
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.chatContext = { threadId: 'thread1', workspaceId: 'workspace1', orgId: 'org1' };
    fake.liveMessages = [
      { id: 'm1', thread_id: 'thread1', role: 'assistant', content: [], created_at: 1, isStreaming: true },
    ];
    fake.liveStreamingMessageId = 'm1';
    fake.isThreadStreaming = vi.fn(() => true);
    const connection = { send: vi.fn() } as any;

    ChatThreadDO.prototype['sendLiveOverlayToConnection'].call(fake, connection);

    expect(connection.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(connection.send.mock.calls[0][0])).toMatchObject({
      type: 'live_overlay',
      threadId: 'thread1',
      streamingMessageId: 'm1',
    });
  });

  it('does NOT restore streaming from persisted state on wake (it is derived)', () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.liveStateHydrated = false;
    fake.chatIsStreaming = false;
    fake.lastCompletedTurn = null;
    fake.lastError = null;
    Object.defineProperty(fake, 'state', {
      configurable: true,
      value: {
        isStreaming: true,
        lastCompletedTurn: { id: 'fork-1', durationMs: 5, completedAtMs: 9 },
      },
    });

    ChatThreadDO.prototype['hydrateLiveStateFromAgentState'].call(fake);

    // Streaming is derived on read (see isThreadStreaming), so hydrate leaves the
    // internal bookkeeping latch untouched — there is no flag to resurrect, which is
    // why a cold wake can't strand the spinner. Coarse fields are still restored.
    expect(fake.chatIsStreaming).toBe(false);
    expect(fake.lastCompletedTurn).toEqual({ id: 'fork-1', durationMs: 5, completedAtMs: 9 });
  });

  const sampleArtifact = {
    id: 'art-1',
    kind: 'outbound_email',
    toolName: 'send_email',
    status: 'sent',
    title: 'Sent invite',
    createdAt: 1,
    updatedAt: 1,
    summary: {},
  };

  it('attaches code-mode artifacts to the live overlay tool result', () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.chatContext = { threadId: 'thread1' };
    fake.liveStateHydrated = true;
    fake.liveMessages = [
      {
        id: 'm1',
        thread_id: 'thread1',
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }],
        created_at: 1,
      },
    ];
    fake.liveStreamingMessageId = null;
    fake.pendingOverlayArtifacts = new Map();
    fake.broadcastChat = vi.fn();

    ChatThreadDO.prototype['attachLiveArtifact'].call(fake, 'tool-1', sampleArtifact);

    const block = fake.liveMessages[0].content[0];
    expect(block.artifacts).toHaveLength(1);
    expect(block.artifacts[0].id).toBe('art-1');
    expect(fake.pendingOverlayArtifacts.size).toBe(0);
    // The updated overlay is published over the broadcast channel.
    expect(fake.broadcastChat).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'live_overlay' }),
    );
  });

  it('holds artifacts until their tool result appears in the overlay', () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.chatContext = { threadId: 'thread1' };
    fake.liveStateHydrated = true;
    fake.liveMessages = [];
    fake.liveStreamingMessageId = null;
    fake.pendingOverlayArtifacts = new Map();
    fake.broadcastChat = vi.fn();

    ChatThreadDO.prototype['attachLiveArtifact'].call(fake, 'tool-9', sampleArtifact);

    expect(fake.liveMessages).toEqual([]);
    expect(fake.pendingOverlayArtifacts.get('tool-9')).toEqual([sampleArtifact]);
    expect(fake.broadcastChat).not.toHaveBeenCalled();
  });

  it('caps oversized streamed tool output in the live overlay, keeping the tail', () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    const huge = 'x'.repeat(200_000) + 'RECENT_TAIL';
    fake.liveMessages = [
      {
        id: 'm1',
        thread_id: 'thread1',
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: huge }],
        created_at: 1,
      },
    ];

    ChatThreadDO.prototype['boundLiveOverlaySize'].call(fake);

    const capped = fake.liveMessages[0].content[0].content as string;
    expect(capped.length).toBeLessThanOrEqual(128_000);
    expect(capped).toContain('full output available on reload');
    // The most recent output is retained for live viewing.
    expect(capped.endsWith('RECENT_TAIL')).toBe(true);
  });

  it('leaves small overlay output untouched (no reallocation)', () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.liveMessages = [
      {
        id: 'm1',
        thread_id: 'thread1',
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'short output' }],
        created_at: 1,
      },
    ];
    const before = fake.liveMessages;

    ChatThreadDO.prototype['boundLiveOverlaySize'].call(fake);

    expect(fake.liveMessages[0].content[0].content).toBe('short output');
    expect(fake.liveMessages).toBe(before);
  });

  it('throttles rapid delta overlay broadcasts but forces structural ones', () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.chatContext = { threadId: 'thread1' };
    fake.liveMessages = [];
    fake.liveStreamingMessageId = null;
    fake.broadcastChat = vi.fn();

    // A throttled broadcast after the window goes through.
    fake.lastLiveSyncAtMs = Date.now() - 10_000;
    ChatThreadDO.prototype['broadcastLiveOverlay'].call(fake, { throttle: true });
    expect(fake.broadcastChat).toHaveBeenCalledTimes(1);

    // An immediate second throttled broadcast is coalesced.
    ChatThreadDO.prototype['broadcastLiveOverlay'].call(fake, { throttle: true });
    expect(fake.broadcastChat).toHaveBeenCalledTimes(1);

    // A forced (structural/terminal) broadcast always flushes.
    ChatThreadDO.prototype['broadcastLiveOverlay'].call(fake, {});
    expect(fake.broadcastChat).toHaveBeenCalledTimes(2);
  });

  it('backfills full first user message metadata while bounding title generation input', async () => {
    const longMessage = `Please keep this entire first prompt ${'x'.repeat(900)}`;
    const attributedMessage = `[Miguel (miguel@example.com)]: ${longMessage}`;
    const orgStub = {
      getThread: vi.fn(async () => ({
        id: 'thread1',
        workspace_id: 'workspace1',
        title: 'New Chat',
        first_user_message: null,
      })),
      recordThreadUserMessage: vi.fn(async () => null),
      setThreadFirstUserMessage: vi.fn(async () => null),
    };
    const userStub = {
      touchGroupForThread: vi.fn(async () => undefined),
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
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => orgStub),
      },
      USER: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => userStub),
      },
    };
    fake.titleGenerationInFlight = false;
    fake.generateThreadTitleFromMessage = vi.fn(async () => undefined);

    await ChatThreadDO.prototype['updateThreadMetadataForUserMessage'].call(
      fake,
      attributedMessage,
      'web',
    );

    expect(orgStub.recordThreadUserMessage).toHaveBeenCalledWith(
      'thread1',
      attributedMessage,
      'web',
    );
    expect(userStub.touchGroupForThread).toHaveBeenCalledWith('thread1');
    expect(orgStub.setThreadFirstUserMessage).toHaveBeenCalledWith(
      'thread1',
      longMessage,
    );
    expect(fake.generateThreadTitleFromMessage).toHaveBeenCalledWith(
      'thread1',
      longMessage.slice(0, 500),
    );
  });

  it('generates a placeholder title even when first user message metadata already exists', async () => {
    const userMessage = 'Build a dashboard for sales metrics';
    const orgStub = {
      getThread: vi.fn(async () => ({
        id: 'thread1',
        workspace_id: 'workspace1',
        title: 'New Chat',
        first_user_message: userMessage,
      })),
      recordThreadUserMessage: vi.fn(async () => null),
      setThreadFirstUserMessage: vi.fn(async () => null),
    };
    const userStub = {
      touchGroupForThread: vi.fn(async () => undefined),
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
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => orgStub),
      },
      USER: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => userStub),
      },
    };
    fake.titleGenerationInFlight = false;
    fake.generateThreadTitleFromMessage = vi.fn(async () => undefined);

    await ChatThreadDO.prototype['updateThreadMetadataForUserMessage'].call(
      fake,
      userMessage,
      'web',
    );

    expect(orgStub.setThreadFirstUserMessage).not.toHaveBeenCalled();
    expect(fake.generateThreadTitleFromMessage).toHaveBeenCalledWith(
      'thread1',
      userMessage,
    );
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

  it('uses Sonnet metadata for hosted requests that still ask for retired Fable 5', async () => {
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
      { provider: 'claude', orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
      { CHIRIDION_CLAUDE_MODEL: 'fable-5' },
      getModel,
    );

    expect(getModel).toHaveBeenCalledWith('anthropic', 'claude-sonnet-4-6');
    expect(model.model).toMatchObject({
      id: 'anthropic/claude-sonnet-4.6:nitro',
      provider: 'cloudflare-ai-gateway',
      api: 'anthropic-messages',
      baseUrl: 'https://gateway.ai.cloudflare.com/v1/acct_1/gateway_1/openrouter',
      name: 'Claude Sonnet 4.6',
      contextWindow: 1_000_000,
      maxTokens: 64_000,
      cost: {
        input: 3,
        output: 15,
        cacheRead: 0.3,
        cacheWrite: 3.75,
      },
    });
    expect(model.apiKey).toBe('cf-token');
    expect(model.provider).toBe('anthropic');
    expect(model.modelId).toBe('claude-sonnet-4-6');
    expect(model.billingSource).toBe('hosted');
    expect(model.usageProvider).toBe('openrouter');
    expect(fake.piCurrentUsageProvider).toBe('openrouter');
  });

  it('sends initial user messages after preparing the Pi session', async () => {
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
    fake.markTurnStarted = vi.fn();
    fake.finishTurn = vi.fn();
    fake.syncAgentState = vi.fn();
    fake.broadcastRunnerClients = vi.fn();
    fake.emitChatError = vi.fn();
    fake.ensurePiSessionReady = vi.fn(async () => undefined);
    fake.applyMentionsForTurn = vi.fn(async (content: string) => content);
    fake.updateThreadMetadataForUserMessage = vi.fn(async () => {});
    fake.warmWorkspaceContainerForTurn = vi.fn(async () => undefined);
    const persisted: any[] = [];
    fake.appendPiCoreMessagesIfMissing = vi.fn(async (messages: any[]) => {
      persisted.push(...messages);
    });
    fake.sendRunnerCommand = vi.fn((command: any) => {
      sentCommands.push(command);
      return true;
    });

    const result = await ChatThreadDO.prototype.startInitialUserMessage.call(fake, {
      threadId: 'thread1',
      workspaceId: 'workspace1',
      orgId: 'org1',
      userId: 'user1',
      userName: 'Miguel',
      userEmail: 'miguel@example.com',
      messageSource: 'email',
      message: 'hello',
      clientMessageId: 'initial:thread1',
    });

    expect(result).toEqual({ status: 'accepted' });
    expect(fake.ensurePiSessionReady).toHaveBeenCalledTimes(1);
    expect(fake.syncAgentState).toHaveBeenCalled();
    expect(fake.warmWorkspaceContainerForTurn).not.toHaveBeenCalled();
    expect(sentCommands).toHaveLength(1);
    expect(sentCommands[0]).toMatchObject({
      type: 'message',
      threadId: 'thread1',
      userId: 'user1',
      clientMessageId: 'initial:thread1',
    });
    expect(sentCommands[0].content).toBe('[email message from Miguel (miguel@example.com)]: hello');
    // The initial send commits the user's message to the transcript up front so a
    // reader that loads the thread the instant this resolves sees it (no optimistic
    // placeholder). It shares its timestamp with the message Pi is prompted with so
    // the turn-end commit dedups it by piCoreMessageKey instead of double-storing.
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      role: 'user',
      content: '[email message from Miguel (miguel@example.com)]: hello',
    });
    expect(persisted[0].timestamp).toBe(sentCommands[0].timestamp);
    expect(typeof persisted[0].timestamp).toBe('number');
  });

  const makeNewTurnEnqueueFake = (order: string[]) => {
    // A fresh new-chat turn: no live piSession, so startsNewTurn is true and the
    // persistUserMessageImmediately path runs.
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.chatContext = {
      threadId: 'thread1',
      workspaceId: 'workspace1',
      orgId: 'org1',
      userId: 'user1',
      userName: 'Miguel',
      userEmail: 'miguel@example.com',
    };
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
    fake.markTurnStarted = vi.fn();
    fake.finishTurn = vi.fn();
    fake.syncAgentState = vi.fn();
    fake.broadcastRunnerClients = vi.fn();
    fake.publishRunningUserMessageActivity = vi.fn();
    fake.updateActiveAutomationRun = vi.fn();
    fake.ensurePiSessionReady = vi.fn(async () => undefined);
    fake.applyMentionsForTurn = vi.fn(async (content: string) => content);
    fake.updateThreadMetadataForUserMessage = vi.fn(async () => {});
    fake.warmWorkspaceContainerForTurn = vi.fn(async () => undefined);
    fake.appendPiCoreMessagesIfMissing = vi.fn(async () => {
      order.push('persist');
    });
    return fake;
  };

  it('persists the initial user message only AFTER the send is accepted', async () => {
    // Ordering guard: the first-message commit must run after sendRunnerCommand
    // succeeds (the fiber row exists), not before — otherwise a failed/interrupted
    // send strands an orphaned user message with no turn behind it. It must still
    // commit before the enqueue resolves, so a reader that awaits the ack and
    // loads the thread sees the message.
    const order: string[] = [];
    const fake = makeNewTurnEnqueueFake(order);
    fake.sendRunnerCommand = vi.fn(() => {
      order.push('send');
      return true;
    });

    const result = await ChatThreadDO.prototype['enqueueRunnerUserMessage'].call(
      fake,
      { type: 'message', content: 'hello', clientMessageId: 'initial:thread1' },
      { persistUserMessageImmediately: true },
    );

    expect(result).toEqual({ status: 'accepted' });
    expect(order).toEqual(['send', 'persist']);
    expect(fake.appendPiCoreMessagesIfMissing).toHaveBeenCalledTimes(1);
  });

  it('does NOT persist the initial user message when the send is rejected (no orphaned first message)', async () => {
    const order: string[] = [];
    const fake = makeNewTurnEnqueueFake(order);
    // The runner refuses the command (e.g. a transient DO reset). Under the old
    // persist-before-send ordering this left an orphaned user message with no
    // turn — the original "user message, no agent response" bug.
    fake.sendRunnerCommand = vi.fn(() => false);

    const result = await ChatThreadDO.prototype['enqueueRunnerUserMessage'].call(
      fake,
      { type: 'message', content: 'hello', clientMessageId: 'initial:thread1' },
      { persistUserMessageImmediately: true },
    );

    expect(result.status).toBe('error');
    expect(order).toEqual([]);
    expect(fake.appendPiCoreMessagesIfMissing).not.toHaveBeenCalled();
    expect(fake.finishTurn).toHaveBeenCalled();
    expect(fake.setActiveTurnUserId).toHaveBeenLastCalledWith(null);
  });

  it('makes a new turn recoverable before the model refresh resolves (deploy-safe start)', async () => {
    const order: string[] = [];
    const fake = Object.create(ChatThreadDO.prototype) as any;

    let resolveRefresh: () => void = () => {};
    const refreshGate = new Promise<void>((resolve) => {
      resolveRefresh = resolve;
    });

    fake.piSession = {
      state: { isStreaming: false },
      prompt: vi.fn(async () => {
        order.push('prompt');
      }),
      steer: vi.fn(),
    };
    fake.ctx = { waitUntil: vi.fn() };
    fake.refreshPiSessionModel = vi.fn(async () => {
      order.push('refresh');
      await refreshGate;
    });
    fake.openPiActiveTurnIfAbsent = vi.fn(() => order.push('marker'));
    fake.recordPiTurnJournalUserMessage = vi.fn(() => order.push('journal'));
    fake.recordPiTurnJournalSteerMessage = vi.fn();
    // The real runFiber's cf_agents_runs INSERT is synchronous (before its first
    // await); the unit fake stands in for that durable bookkeeping and just runs
    // the wrapped turn body.
    fake.runFiber = vi.fn(async (_name: string, fn: () => unknown) => {
      order.push('runFiber');
      return fn();
    });
    fake.withPiTurnInactivityTimeout = vi.fn(async (fn: () => unknown) => fn());
    fake.markTurnStarted = vi.fn();
    fake.finishTurn = vi.fn();
    fake.setActiveTurnUserId = vi.fn();
    fake.syncAgentState = vi.fn();
    fake.updateActiveAutomationRun = vi.fn();
    fake.pushChatEvent = vi.fn();
    fake.piProviderErrorEvent = vi.fn((message: string) => ({ type: 'error', error: message }));
    fake.persistPiAgentLoopErrorForDevelopers = vi.fn();

    const accepted = ChatThreadDO.prototype['sendRunnerCommand'].call(fake, {
      type: 'message',
      content: 'do the thing',
    });
    expect(accepted).toBe(true);

    // Let the waitUntil turn body run up to the (still pending) model refresh.
    await Promise.resolve();
    await Promise.resolve();

    // The active-turn marker, journal, and durable fiber row must all be in place
    // even though the model refresh has NOT resolved — otherwise a deploy eviction
    // in the refresh window would strand the thread "streaming" with nothing for
    // onFiberRecovered to resume. (Before the fix, refreshPiSessionModel was awaited
    // first, so a hung refresh meant the marker/fiber were never created.)
    expect(fake.openPiActiveTurnIfAbsent).toHaveBeenCalledTimes(1);
    expect(fake.recordPiTurnJournalUserMessage).toHaveBeenCalledTimes(1);
    expect(fake.runFiber).toHaveBeenCalledTimes(1);
    expect(order.indexOf('marker')).toBeLessThan(order.indexOf('refresh'));
    expect(order.indexOf('runFiber')).toBeLessThan(order.indexOf('refresh'));
    // The prompt only fires once the model refresh resolves, inside the fiber.
    expect(fake.piSession.prompt).not.toHaveBeenCalled();

    resolveRefresh();
    await flushWaitUntil(fake);
    expect(fake.piSession.prompt).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['marker', 'journal', 'runFiber', 'refresh', 'prompt']);
  });

  describe('isThreadStreaming (derived loading state)', () => {
    const makeFake = (opts: { piStreaming?: boolean | null; marker?: boolean }) => {
      const fake = Object.create(ChatThreadDO.prototype) as any;
      fake.piSession =
        opts.piStreaming === null || opts.piStreaming === undefined
          ? null
          : { state: { isStreaming: opts.piStreaming } };
      fake.readPiActiveTurn = vi.fn(() =>
        opts.marker ? { turnId: 't1', attempt: 0, openedAt: 1 } : null,
      );
      return fake;
    };
    const call = (fake: any): boolean =>
      ChatThreadDO.prototype['isThreadStreaming'].call(fake);

    it('is true while a turn is live in this isolate', () => {
      expect(call(makeFake({ piStreaming: true, marker: false }))).toBe(true);
    });

    it('is true when an active-turn marker exists (cold-wake gap / pending resume, piSession gone)', () => {
      expect(call(makeFake({ piStreaming: null, marker: true }))).toBe(true);
    });

    it('is false when no turn is live and no marker is set', () => {
      expect(call(makeFake({ piStreaming: false, marker: false }))).toBe(false);
    });

    it('reads idle once a terminal path clears the marker', () => {
      // agent_end / resume completion / error cleanup all clear the marker, so a
      // settled turn derives idle with no separate flag to forget.
      expect(call(makeFake({ piStreaming: null, marker: false }))).toBe(false);
    });
  });

  describe('onStart (no heal needed — streaming is derived)', () => {
    it('only hydrates; never clears streaming or schedules a resume', async () => {
      const fake = Object.create(ChatThreadDO.prototype) as any;
      fake.liveStateHydrated = true; // hydrate short-circuits
      fake.markTurnStarted = vi.fn();
      fake.finishTurn = vi.fn();
      fake.setActiveTurnUserId = vi.fn();
      fake.schedule = vi.fn(async () => {});
      fake.pushChatEvent = vi.fn();

      await ChatThreadDO.prototype.onStart.call(fake);

      expect(fake.finishTurn).not.toHaveBeenCalled();
      expect(fake.markTurnStarted).not.toHaveBeenCalled();
      expect(fake.schedule).not.toHaveBeenCalled();
      expect(fake.pushChatEvent).not.toHaveBeenCalled();
    });
  });

  describe('mid-turn config change', () => {
    it('byokChanged invalidates the provider cache and rebuilds the live session with the new config', async () => {
      const calls: string[] = [];
      const fake = Object.create(ChatThreadDO.prototype) as any;
      fake.cachedLlmProviderConfig = { stale: true };
      fake.piSession = { state: { isStreaming: true } }; // live
      fake.disposePiSession = vi.fn(() => {
        calls.push('dispose');
        fake.piSession = null;
      });
      fake.schedule = vi.fn(async () => {
        calls.push('schedule');
      });
      fake.withRunnerTransitionLock = vi.fn(
        async (_label: string, fn: () => Promise<void>) => fn(),
      );

      await ChatThreadDO.prototype.byokChanged.call(fake);

      expect(fake.cachedLlmProviderConfig).toBeNull();
      // A rebuild is required: getApiKey can refresh the key on the live loop, but
      // not the captured model / provider routing / base URL the in-flight turn is
      // already streaming with — only dispose + resume picks those up.
      expect(calls).toEqual(['dispose', 'schedule']);
      expect(fake.schedule).toHaveBeenCalledWith(0, 'resumeInterruptedPiTurn', undefined, {
        idempotent: true,
      });
    });

    it('refreshRunnerConfig disposes a live turn and resumes it so it continues with the new model', async () => {
      const calls: string[] = [];
      const fake = Object.create(ChatThreadDO.prototype) as any;
      fake.piSession = { state: { isStreaming: true } }; // live -> isThreadStreaming short-circuits true
      fake.disposePiSession = vi.fn(() => {
        calls.push('dispose');
        fake.piSession = null;
      });
      fake.schedule = vi.fn(async () => {
        calls.push('schedule');
      });
      fake.withRunnerTransitionLock = vi.fn(
        async (_label: string, fn: () => Promise<void>) => fn(),
      );

      await ChatThreadDO.prototype.refreshRunnerConfig.call(fake);

      // Dispose first (the live turn settles; the spinner is derived so it won't
      // strand), then schedule the resume which rebuilds with the new model.
      expect(calls).toEqual(['dispose', 'schedule']);
      expect(fake.schedule).toHaveBeenCalledWith(0, 'resumeInterruptedPiTurn', undefined, {
        idempotent: true,
      });
    });

    it('refreshRunnerConfig disposes but does not resume an idle thread', async () => {
      const fake = Object.create(ChatThreadDO.prototype) as any;
      fake.piSession = null; // idle
      fake.ctx = {
        storage: {
          sql: { exec: () => ({ toArray: () => [{ c: 0 }] }) },
        },
      };
      fake.disposePiSession = vi.fn();
      fake.schedule = vi.fn(async () => {});
      fake.withRunnerTransitionLock = vi.fn(
        async (_label: string, fn: () => Promise<void>) => fn(),
      );

      await ChatThreadDO.prototype.refreshRunnerConfig.call(fake);

      expect(fake.disposePiSession).toHaveBeenCalled();
      expect(fake.schedule).not.toHaveBeenCalled();
    });
  });

  it('publishes initial user message startup failures to chat clients', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    const events: any[] = [];
    const error = new Error('Self-host chat requires an AI provider.');

    fake.chatContext = null;
    fake.ctx = {
      storage: { kv: { put: vi.fn(), delete: vi.fn() } },
      waitUntil: vi.fn(),
    };
    fake.recordChatThreadObservabilityEvent = vi.fn();
    fake.setActiveAutomationRun = vi.fn();
    fake.pushChatEvent = vi.fn((event: any) => events.push(event));
    fake.enqueueRunnerUserMessage = vi.fn(async () => {
      throw error;
    });

    const result = await ChatThreadDO.prototype.startInitialUserMessage.call(fake, {
      threadId: 'thread1',
      workspaceId: 'workspace1',
      orgId: 'org1',
      userId: 'user1',
      message: 'hello',
      clientMessageId: 'initial:thread1',
    });

    expect(result).toEqual({
      status: 'error',
      error: 'Self-host chat requires an AI provider.',
    });
    expect(fake.pushChatEvent).toHaveBeenCalledTimes(1);
    expect(events[0]).toMatchObject({
      type: 'error',
      error: 'Self-host chat requires an AI provider.',
      status: 500,
    });
  });

  it('rejects automation starts while another automation run is active', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    const activeAutomationRun = {
      workspaceId: 'workspace1',
      automationId: 'prompt1',
      runId: 'run1',
    };

    fake.chatContext = null;
    fake.activeAutomationRun = activeAutomationRun;
    fake.isThreadStreaming = vi.fn(() => true); // a turn is active in this isolate
    fake.browserPrompts = { pendingQuestionCount: 0 };
    fake.ctx = {
      storage: { kv: { put: vi.fn(), delete: vi.fn() } },
      waitUntil: vi.fn(),
    };
    fake.recordChatThreadObservabilityEvent = vi.fn();
    fake.setActiveAutomationRun = vi.fn();
    fake.enqueueRunnerUserMessage = vi.fn(async () => ({ status: 'accepted' }));

    const result = await ChatThreadDO.prototype.startInitialUserMessage.call(fake, {
      threadId: 'thread1',
      workspaceId: 'workspace1',
      orgId: 'org1',
      userId: 'user1',
      message: 'run scheduled task',
      automationRun: {
        workspaceId: 'workspace1',
        automationId: 'prompt1',
        runId: 'run2',
      },
    });

    expect(result).toEqual({
      status: 'busy',
      error: 'Thread is busy with another run',
    });
    expect(fake.setActiveAutomationRun).not.toHaveBeenCalled();
    expect(fake.enqueueRunnerUserMessage).not.toHaveBeenCalled();
    expect(fake.activeAutomationRun).toBe(activeAutomationRun);
  });

  it('reconciles inactive automation locks before accepting a new automation start', async () => {
    const waitUntilPromises: Promise<unknown>[] = [];
    const recordScheduledPromptRunResult = vi.fn(async () => true);
    const fake = Object.create(ChatThreadDO.prototype) as any;
    const staleAutomationRun = {
      workspaceId: 'workspace1',
      automationId: 'prompt1',
      runId: 'run1',
    };
    const nextAutomationRun = {
      workspaceId: 'workspace1',
      automationId: 'prompt1',
      runId: 'run2',
    };

    fake.chatContext = null;
    fake.chatIsStreaming = false;
    fake.activeAutomationRun = staleAutomationRun;
    fake.browserPrompts = { pendingQuestionCount: 0 };
    fake.ctx = {
      storage: { kv: { put: vi.fn(), delete: vi.fn() } },
      waitUntil: vi.fn((promise: Promise<unknown>) => {
        waitUntilPromises.push(promise);
      }),
    };
    fake.env = {
      WORKSPACE_CRON: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({ recordScheduledPromptRunResult })),
      },
    };
    fake.recordChatThreadObservabilityEvent = vi.fn();
    fake.enqueueRunnerUserMessage = vi.fn(async () => ({ status: 'accepted' }));

    const result = await ChatThreadDO.prototype.startInitialUserMessage.call(fake, {
      threadId: 'thread1',
      workspaceId: 'workspace1',
      orgId: 'org1',
      userId: 'user1',
      message: 'run scheduled task',
      automationRun: nextAutomationRun,
    });
    await Promise.all(waitUntilPromises);

    expect(result).toEqual({ status: 'accepted' });
    expect(recordScheduledPromptRunResult).toHaveBeenCalledWith({
      workspaceId: staleAutomationRun.workspaceId,
      promptId: staleAutomationRun.automationId,
      runId: staleAutomationRun.runId,
      status: 'error',
      message: 'Automation run did not finish before the thread restarted',
      completedAt: expect.any(Number),
    });
    expect(fake.activeAutomationRun).toEqual(nextAutomationRun);
    expect(fake.enqueueRunnerUserMessage).toHaveBeenCalledTimes(1);
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
    fake.markTurnStarted = vi.fn();
    fake.finishTurn = vi.fn();
    fake.syncAgentState = vi.fn();
    fake.publishRunningUserMessageActivity = vi.fn();
    fake.broadcastRunnerClients = vi.fn();
    fake.ensurePiSessionReady = vi.fn(async () => undefined);
    fake.applyMentionsForTurn = vi.fn(async (content: string) => content);
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
    expect(fake.ensurePiSessionReady).toHaveBeenCalledTimes(1);
    expect(fake.syncAgentState).toHaveBeenCalled();
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
    expect(sentCommands[0].content).toBe('[web message from Miguel (miguel@example.com)]: please also add tests');
  });

  it('returns acceptance from the sendMessage RPC after enqueue accepts', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    let resolveEnqueue: (value: { status: 'accepted' }) => void = () => {};
    const enqueuePromise = new Promise<{ status: 'accepted' }>((resolve) => {
      resolveEnqueue = resolve;
    });
    fake.ctx = { storage: { kv: { get: vi.fn(), put: vi.fn() } } };
    fake.enqueueRunnerUserMessage = vi.fn(() => enqueuePromise);

    const handlePromise = ChatThreadDO.prototype['handleClientUserMessage'].call(fake, {
      content: 'hello',
      clientMessageId: 'client-msg-1',
    });

    await Promise.resolve();
    expect(fake.enqueueRunnerUserMessage).toHaveBeenCalledTimes(1);

    resolveEnqueue({ status: 'accepted' });
    await expect(handlePromise).resolves.toEqual({ status: 'accepted' });

    expect(fake.enqueueRunnerUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({ clientMessageId: 'client-msg-1' }),
      expect.objectContaining({
        sendAttemptId: 'client-msg-1',
        startedAt: expect.any(Number),
      }),
    );
    expect(fake.ctx.storage.kv.put).toHaveBeenCalled();
  });

  it('returns thrown browser message send failures to the RPC caller', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    const error = new Error('connection dropped');
    fake.ctx = { storage: { kv: { get: vi.fn(), put: vi.fn() } } };
    fake.enqueueRunnerUserMessage = vi.fn(async () => {
      throw error;
    });
    fake.markTurnStarted = vi.fn();
    fake.finishTurn = vi.fn();
    fake.setActiveTurnUserId = vi.fn();
    fake.updateActiveAutomationRun = vi.fn();

    await expect(ChatThreadDO.prototype['handleClientUserMessage'].call(fake, {
      content: 'hello',
      clientMessageId: 'client-msg-2',
    })).resolves.toEqual({
      status: 'error',
      error: 'connection dropped',
    });

    expect(fake.updateActiveAutomationRun).toHaveBeenCalledWith({
      status: 'error',
      message: 'connection dropped',
      clear: true,
    });
    expect(fake.finishTurn).toHaveBeenCalled();
    expect(fake.setActiveTurnUserId).toHaveBeenCalledWith(null);
  });

  it('returns rejected browser message sends to the RPC caller', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.ctx = { storage: { kv: { get: vi.fn(), put: vi.fn() } } };
    fake.enqueueRunnerUserMessage = vi.fn(async () => ({
      status: 'busy',
      error: new Error('Thread is busy with another run'),
    }));

    await expect(ChatThreadDO.prototype['handleClientUserMessage'].call(fake, {
      content: 'hello',
      clientMessageId: 'client-msg-rejected',
    })).resolves.toEqual({
      status: 'busy',
      error: new Error('Thread is busy with another run'),
    });
  });

  it('keeps explicit direct-send error sources when provider metadata exists', async () => {
    const waitUntilPromises: Promise<unknown>[] = [];
    const recordThreadError = vi.fn(async () => null);
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.chatContext = {
      threadId: 'thread1',
      workspaceId: 'workspace1',
      orgId: 'org1',
      userId: 'user1',
      userName: 'User One',
      userEmail: 'user@example.com',
    };
    fake.piCurrentUsageProvider = 'openai';
    fake.piSession = null;
    fake.recordedChatErrors = new Map();
    fake.ctx = {
      waitUntil: vi.fn((promise: Promise<unknown>) => {
        waitUntilPromises.push(promise);
      }),
    };
    fake.env = {
      ORG: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({ recordThreadError })),
      },
    };
    fake.retryChatDurableObjectRpc = vi.fn((_name: string, fn: () => Promise<unknown>) => fn());

    ChatThreadDO.prototype['recordCurrentThreadError'].call(fake, {
      message: 'Hosted model credit limit reached',
      source: 'runner_send',
      provider: 'openai',
      status: 402,
    });
    await Promise.all(waitUntilPromises);

    expect(recordThreadError).toHaveBeenCalledWith(
      'thread1',
      expect.objectContaining({
        message: 'Hosted model credit limit reached',
        source: 'runner_send',
        provider: 'openai',
        status: 402,
        userId: 'user1',
      }),
    );
  });

  it('re-accepts duplicates of accepted messages without enqueueing again', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.ctx = {
      storage: {
        kv: { get: vi.fn(() => ['client-msg-dup']), put: vi.fn() },
      },
    };
    fake.enqueueRunnerUserMessage = vi.fn();

    await expect(ChatThreadDO.prototype['handleClientUserMessage'].call(fake, {
      content: 'hello again',
      clientMessageId: 'client-msg-dup',
    })).resolves.toEqual({ status: 'accepted' });

    expect(fake.enqueueRunnerUserMessage).not.toHaveBeenCalled();
  });

  it('relays an in-flight enqueue failure to a retransmitted duplicate instead of accepting it', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    const error = new Error('runner exploded');
    let rejectEnqueue: (error: Error) => void = () => {};
    const enqueuePromise = new Promise((_resolve, reject) => {
      rejectEnqueue = reject;
    });
    fake.ctx = { storage: { kv: { get: vi.fn(), put: vi.fn() } } };
    fake.enqueueRunnerUserMessage = vi.fn(() => enqueuePromise);
    fake.markTurnStarted = vi.fn();
    fake.finishTurn = vi.fn();
    fake.setActiveTurnUserId = vi.fn();
    fake.updateActiveAutomationRun = vi.fn();

    const first = ChatThreadDO.prototype['handleClientUserMessage'].call(fake, {
      content: 'hello',
      clientMessageId: 'client-msg-3',
    });
    await Promise.resolve();

    const second = ChatThreadDO.prototype['handleClientUserMessage'].call(fake, {
      content: 'hello',
      clientMessageId: 'client-msg-3',
    });
    await Promise.resolve();

    expect(fake.enqueueRunnerUserMessage).toHaveBeenCalledTimes(1);

    rejectEnqueue(error);
    await expect(first).resolves.toEqual({
      status: 'error',
      error: 'runner exploded',
    });
    await expect(second).resolves.toEqual({
      status: 'error',
      error: 'runner exploded',
    });

    expect(fake.ctx.storage.kv.put).not.toHaveBeenCalled();
  });

  it('accepts a retransmitted duplicate once the in-flight enqueue accepts', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    let resolveEnqueue: (value: { status: 'accepted' }) => void = () => {};
    const enqueuePromise = new Promise<{ status: 'accepted' }>((resolve) => {
      resolveEnqueue = resolve;
    });
    fake.ctx = { storage: { kv: { get: vi.fn(), put: vi.fn() } } };
    fake.enqueueRunnerUserMessage = vi.fn(() => enqueuePromise);

    const first = ChatThreadDO.prototype['handleClientUserMessage'].call(fake, {
      content: 'hello',
      clientMessageId: 'client-msg-4',
    });
    await Promise.resolve();
    const second = ChatThreadDO.prototype['handleClientUserMessage'].call(fake, {
      content: 'hello',
      clientMessageId: 'client-msg-4',
    });
    await Promise.resolve();

    resolveEnqueue({ status: 'accepted' });
    await expect(first).resolves.toEqual({ status: 'accepted' });
    await expect(second).resolves.toEqual({ status: 'accepted' });

    expect(fake.enqueueRunnerUserMessage).toHaveBeenCalledTimes(1);
    expect(fake.ctx.storage.kv.put).toHaveBeenCalled();
  });

  it('bounds degraded-auth grants to the recent full-auth window', () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    let store: unknown;
    fake.ctx = {
      storage: {
        kv: {
          get: vi.fn(() => store),
          put: vi.fn((_key: string, value: unknown) => {
            store = value;
          }),
        },
      },
    };

    // Never authorized: no grant.
    expect(
      ChatThreadDO.prototype['isPreviouslyAuthorizedChatUser'].call(fake, 'user-1'),
    ).toBe(false);

    // Fresh full auth grants degraded access.
    ChatThreadDO.prototype['recordAuthorizedChatUser'].call(fake, 'user-1');
    expect(
      ChatThreadDO.prototype['isPreviouslyAuthorizedChatUser'].call(fake, 'user-1'),
    ).toBe(true);

    // Grants expire after the TTL window.
    store = { 'user-1': Date.now() - 25 * 60 * 60 * 1000 };
    expect(
      ChatThreadDO.prototype['isPreviouslyAuthorizedChatUser'].call(fake, 'user-1'),
    ).toBe(false);

    // Legacy bare-id list format grants nothing.
    store = ['user-1'];
    expect(
      ChatThreadDO.prototype['isPreviouslyAuthorizedChatUser'].call(fake, 'user-1'),
    ).toBe(false);

    // Recording prunes expired grants from the stored map.
    store = { 'user-stale': Date.now() - 25 * 60 * 60 * 1000 };
    ChatThreadDO.prototype['recordAuthorizedChatUser'].call(fake, 'user-2');
    expect(store).not.toHaveProperty('user-stale');
    expect(
      ChatThreadDO.prototype['isPreviouslyAuthorizedChatUser'].call(fake, 'user-2'),
    ).toBe(true);
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
    fake.ensurePiSessionReady = vi.fn(async () => {
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
      id: 'openai/gpt-5.5:nitro',
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

  it('uses OpenRouter BYOK with Sonnet when a request still asks for retired Fable 5', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.env = {};
    fake.resolveCurrentByokCredentials = vi.fn(async () => ({
      provider: 'openrouter',
      apiKey: 'sk-or-test',
    }));
    fake.checkHostedPiModelAccess = vi.fn(async () => {
      throw new Error('hosted billing should not be checked for BYOK');
    });

    const model = await ChatThreadDO.prototype['resolvePiModel'].call(
      fake,
      { provider: 'claude', orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
      { CHIRIDION_CLAUDE_MODEL: 'fable-5' },
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

  it('uses self-host OpenRouter env credentials before org BYOK or hosted gateway', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.env = {
      CF_ACCOUNT_ID: 'selfhost',
      SELFHOST_AI_PROVIDER: 'openrouter',
      SELFHOST_AI_API_KEY: 'sk-or-selfhost',
    };
    fake.resolveCurrentByokCredentials = vi.fn(async () => ({
      provider: 'anthropic',
      apiKey: 'sk-ant-org',
    }));
    fake.checkHostedPiModelAccess = vi.fn(async () => {
      throw new Error('hosted billing should not be checked for self-host env provider');
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
      id: 'anthropic/claude-sonnet-4.6:nitro',
      provider: 'anthropic',
      api: 'anthropic-messages',
      baseUrl: 'https://openrouter.ai/api',
    });
    expect(model.apiKey).toBe('sk-or-selfhost');
    expect(model.billingSource).toBe('byok');
    expect(model.creditChargeable).toBe(false);
    expect(model.usageProvider).toBe('openrouter');
    expect(fake.resolveCurrentByokCredentials).not.toHaveBeenCalled();
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
        { CHIRIDION_CLAUDE_MODEL: 'unknown/provider-model' },
        vi.fn(),
      ),
    ).rejects.toThrow('Unsupported Pi model unknown/provider-model');
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
    fake.runnerTransitionChain = Promise.resolve();
    fake.lastRunnerSeq = 0;
    fake.trace = vi.fn();
    fake.ensurePiSession = vi.fn(async () => undefined);

    await ChatThreadDO.prototype['ensurePiSessionReady'].call(fake);

    expect(fake.ensurePiSession).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'thread1' }),
      expect.objectContaining({
        CHIRIDION_MODEL: 'sonnet',
        CHIRIDION_CLAUDE_MODEL: 'sonnet',
        CHIRIDION_CODEX_MODEL: 'sonnet',
      }),
    );
  });

  it('preserves a stored custom thread model when initializing Pi', async () => {
    const orgStub = {
      getThread: vi.fn(async () => ({
        id: 'thread1',
        model: 'custom',
        workspace_id: 'workspace1',
      })),
      getLlmProviderConfig: vi.fn(async () => ({
        provider: 'custom',
        config: {
          api: 'anthropic-messages',
          custom_model_id: 'claude-custom',
        },
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
    fake.runnerTransitionChain = Promise.resolve();
    fake.lastRunnerSeq = 0;
    fake.trace = vi.fn();
    fake.ensurePiSession = vi.fn(async () => undefined);

    await ChatThreadDO.prototype['ensurePiSessionReady'].call(fake);

    expect(fake.ensurePiSession).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'thread1' }),
      expect.objectContaining({
        CHIRIDION_MODEL: 'custom',
        CHIRIDION_CLAUDE_MODEL: 'custom',
        CHIRIDION_CODEX_MODEL: 'custom',
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
    fake.runnerTransitionChain = Promise.resolve();
    fake.lastRunnerSeq = 0;
    fake.trace = vi.fn();
    fake.ensurePiSession = vi.fn(async () => undefined);

    await ChatThreadDO.prototype['ensurePiSessionReady'].call(fake);

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

  it('prefixes hosted OpenAI aliases when routing through OpenRouter BYOK', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.env = {};
    fake.resolveCurrentByokCredentials = vi.fn(async () => ({
      provider: 'openrouter',
      apiKey: 'sk-or-test',
    }));
    fake.checkHostedPiModelAccess = vi.fn(async () => {
      throw new Error('hosted billing should not be checked for BYOK');
    });

    const model = await ChatThreadDO.prototype['resolvePiModel'].call(
      fake,
      { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
      { CHIRIDION_CODEX_MODEL: 'gpt-5.5' },
      vi.fn((provider, modelId) => ({
        id: modelId,
        provider,
        api: 'openai-responses',
        baseUrl: 'https://api.openai.com/v1',
      })),
    );

    expect(model.model).toMatchObject({
      id: 'openai/gpt-5.5:nitro',
      provider: 'openai',
      api: 'openai-responses',
      baseUrl: 'https://openrouter.ai/api/v1',
    });
    expect(model.apiKey).toBe('sk-or-test');
    expect(model.billingSource).toBe('byok');
    expect(model.usageProvider).toBe('openrouter');
    expect(fake.checkHostedPiModelAccess).not.toHaveBeenCalled();
  });

  it('suppresses OpenAI SDK bearer auth for custom OpenAI-compatible x-api-key providers', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.env = {};
    fake.resolveCurrentByokCredentials = vi.fn(async () => ({
      provider: 'custom',
      apiKey: 'custom-key',
      baseUrl: 'https://custom.example/v1',
      authType: 'x-api-key',
      api: 'openai-completions',
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
      provider: 'custom',
      api: 'openai-completions',
      baseUrl: 'https://custom.example/v1',
    });
    expect((model.model as any).headers).toEqual({
      Authorization: null,
      'x-api-key': 'custom-key',
    });
    expect(model.apiKey).toBe('custom-key');
    expect(model.billingSource).toBe('byok');
    expect(model.usageProvider).toBe('custom');
    expect(fake.checkHostedPiModelAccess).not.toHaveBeenCalled();
  });

  it('suppresses Anthropic SDK x-api-key auth for custom Anthropic-compatible bearer providers', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.env = {};
    fake.resolveCurrentByokCredentials = vi.fn(async () => ({
      provider: 'custom',
      apiKey: 'custom-key',
      baseUrl: 'https://custom.example',
      authType: 'bearer',
      api: 'anthropic-messages',
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
      provider: 'custom',
      api: 'anthropic-messages',
      baseUrl: 'https://custom.example',
    });
    expect((model.model as any).headers).toEqual({
      'x-api-key': null,
      Authorization: 'Bearer custom-key',
    });
    expect(model.apiKey).toBe('custom-key');
    expect(model.billingSource).toBe('byok');
    expect(model.usageProvider).toBe('custom');
    expect(fake.checkHostedPiModelAccess).not.toHaveBeenCalled();
  });

  it('uses an OpenAI-compatible default when custom OpenAI API mode receives a Claude thread model', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.env = {};
    fake.resolveCurrentByokCredentials = vi.fn(async () => ({
      provider: 'custom',
      apiKey: 'custom-key',
      baseUrl: 'https://custom.example/v1',
      authType: 'bearer',
      api: 'openai-responses',
    }));
    fake.checkHostedPiModelAccess = vi.fn(async () => {
      throw new Error('hosted billing should not be checked for BYOK');
    });
    const getModel = vi.fn((provider: string, id: string) => ({
      id,
      provider,
      api: provider === 'openai' ? 'openai-responses' : 'anthropic-messages',
      baseUrl: provider === 'openai'
        ? 'https://api.openai.com/v1'
        : 'https://api.anthropic.com',
    }));

    const model = await ChatThreadDO.prototype['resolvePiModel'].call(
      fake,
      { provider: 'claude', orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
      { CHIRIDION_CLAUDE_MODEL: 'sonnet' },
      getModel,
    );

    expect(getModel).toHaveBeenCalledWith('openai', 'gpt-5.4');
    expect(model.model).toMatchObject({
      id: 'gpt-5.4',
      provider: 'custom',
      api: 'openai-responses',
      baseUrl: 'https://custom.example/v1',
    });
    expect(model.usageProvider).toBe('custom');
  });

  it('sends the configured custom model id for custom provider model selections', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.env = {};
    fake.resolveCurrentByokCredentials = vi.fn(async () => ({
      provider: 'custom',
      apiKey: 'custom-key',
      baseUrl: 'https://custom.example/v1',
      authType: 'bearer',
      api: 'openai-responses',
      modelId: 'pi-custom-model',
    }));
    fake.checkHostedPiModelAccess = vi.fn(async () => {
      throw new Error('hosted billing should not be checked for BYOK');
    });
    const getModel = vi.fn((provider: string, id: string) => ({
      id,
      provider,
      api: provider === 'openai' ? 'openai-responses' : 'anthropic-messages',
      baseUrl: provider === 'openai'
        ? 'https://api.openai.com/v1'
        : 'https://api.anthropic.com',
    }));

    const model = await ChatThreadDO.prototype['resolvePiModel'].call(
      fake,
      { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
      { CHIRIDION_CODEX_MODEL: 'custom' },
      getModel,
    );

    expect(getModel).toHaveBeenCalledWith('openai', 'gpt-5.4');
    expect(model.model).toMatchObject({
      id: 'pi-custom-model',
      provider: 'custom',
      api: 'openai-responses',
      baseUrl: 'https://custom.example/v1',
    });
    expect(model.usageProvider).toBe('custom');
  });

  it('uses an Anthropic-compatible default when custom Anthropic API mode receives an OpenAI thread model', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.env = {};
    fake.resolveCurrentByokCredentials = vi.fn(async () => ({
      provider: 'custom',
      apiKey: 'custom-key',
      baseUrl: 'https://custom.example',
      authType: 'x-api-key',
      api: 'anthropic-messages',
    }));
    fake.checkHostedPiModelAccess = vi.fn(async () => {
      throw new Error('hosted billing should not be checked for BYOK');
    });
    const getModel = vi.fn((provider: string, id: string) => ({
      id,
      provider,
      api: provider === 'anthropic' ? 'anthropic-messages' : 'openai-responses',
      baseUrl: provider === 'anthropic'
        ? 'https://api.anthropic.com'
        : 'https://api.openai.com/v1',
    }));

    const model = await ChatThreadDO.prototype['resolvePiModel'].call(
      fake,
      { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
      { CHIRIDION_CODEX_MODEL: 'gpt-5.4' },
      getModel,
    );

    expect(getModel).toHaveBeenCalledWith('anthropic', 'claude-sonnet-4-6');
    expect(model.model).toMatchObject({
      id: 'claude-sonnet-4-6',
      provider: 'custom',
      api: 'anthropic-messages',
      baseUrl: 'https://custom.example',
    });
    expect(model.usageProvider).toBe('custom');
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

  it('uses Bedrock Mantle Responses API for supported OpenAI Pi models', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.env = {};
    fake.resolveCurrentByokCredentials = vi.fn(async () => ({
      provider: 'bedrock',
      apiKey: 'bedrock-token',
      awsRegion: 'us-east-2',
    }));
    fake.checkHostedPiModelAccess = vi.fn(async () => {
      throw new Error('hosted billing should not be checked for BYOK');
    });
    const getModel = vi.fn((provider: string, id: string) => ({
      id,
      provider,
      api: provider === 'openai' ? 'openai-responses' : 'anthropic-messages',
      baseUrl: provider === 'openai'
        ? 'https://api.openai.com/v1'
        : 'https://api.anthropic.com',
    }));

    const model = await ChatThreadDO.prototype['resolvePiModel'].call(
      fake,
      { provider: 'pi', orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
      { CHIRIDION_CODEX_MODEL: 'gpt-5.5' },
      getModel,
    );

    expect(getModel).toHaveBeenCalledWith('openai', 'gpt-5.5');
    expect(model.model).toMatchObject({
      id: 'openai.gpt-5.5',
      provider: 'custom',
      api: 'openai-responses',
      baseUrl: 'https://bedrock-mantle.us-east-2.api.aws/openai/v1',
    });
    expect(model.apiKey).toBe('bedrock-token');
    expect(model.billingSource).toBe('byok');
    expect(model.usageProvider).toBe('bedrock');
    expect(fake.checkHostedPiModelAccess).not.toHaveBeenCalled();
  });

  it('lets unsupported Bedrock OpenAI models fall through to hosted routing', async () => {
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
    fake.resolveCurrentByokCredentials = vi.fn(async () => ({
      provider: 'bedrock',
      apiKey: 'bedrock-token',
      awsRegion: 'us-east-2',
    }));
    fake.checkHostedPiModelAccess = vi.fn(async () => true);
    const getModel = vi.fn((provider: string, id: string) => ({
      id,
      provider,
      api: 'openai-responses',
      baseUrl: 'https://api.openai.com/v1',
    }));

    const model = await ChatThreadDO.prototype['resolvePiModel'].call(
      fake,
      { provider: 'pi', orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
      { CHIRIDION_CODEX_MODEL: 'gpt-5.4-mini' },
      getModel,
    );

    expect(model.model).toMatchObject({
      id: 'openai/gpt-5.4-mini:nitro',
      provider: 'cloudflare-ai-gateway',
      api: 'openai-responses',
      baseUrl: 'https://gateway.ai.cloudflare.com/v1/acct_1/gateway_1/openrouter',
    });
    expect(model.apiKey).toBe('cf-token');
    expect(model.billingSource).toBe('hosted');
    expect(model.usageProvider).toBe('openrouter');
  });

  it('rejects Bedrock OpenAI models in unsupported regions before falling back to hosted', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.env = {};
    fake.resolveCurrentByokCredentials = vi.fn(async () => ({
      provider: 'bedrock',
      apiKey: 'bedrock-token',
      awsRegion: 'eu-west-1',
    }));
    fake.checkHostedPiModelAccess = vi.fn(async () => {
      throw new Error('hosted billing should not be checked for BYOK');
    });

    await expect(ChatThreadDO.prototype['resolvePiModel'].call(
      fake,
      { provider: 'pi', orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
      { CHIRIDION_CODEX_MODEL: 'gpt-5.5' },
      vi.fn((provider: string, id: string) => ({ id, provider, api: 'openai-responses' })),
    )).rejects.toThrow('OpenAI gpt-5.5 on Amazon Bedrock is not available in eu-west-1');
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

    expect(getModel).toHaveBeenCalledWith('amazon-bedrock', 'global.anthropic.claude-opus-4-8');
    expect(model.model).toMatchObject({
      id: 'global.anthropic.claude-opus-4-8',
      provider: 'amazon-bedrock',
      api: 'bedrock-converse-stream',
      baseUrl: 'https://bedrock-runtime.us-west-2.amazonaws.com',
      name: 'Claude Opus 4.8 (Global)',
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    });
    expect(model.apiKey).toBe('bedrock-token');
    expect(model.billingSource).toBe('byok');
    expect(model.usageProvider).toBe('bedrock');
    expect(fake.checkHostedPiModelAccess).not.toHaveBeenCalled();
  });

  it('uses the global Bedrock Sonnet fallback for BYOK requests that still ask for retired Fable 5', async () => {
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
      { CHIRIDION_CLAUDE_MODEL: 'fable-5' },
      getModel,
    );

    expect(getModel).toHaveBeenCalledWith('amazon-bedrock', 'global.anthropic.claude-sonnet-4-6');
    expect(model.model).toMatchObject({
      id: 'global.anthropic.claude-sonnet-4-6',
      provider: 'amazon-bedrock',
      api: 'bedrock-converse-stream',
      baseUrl: 'https://bedrock-runtime.us-west-2.amazonaws.com',
      name: 'Claude Sonnet 4.6 (Global)',
      contextWindow: 1_000_000,
      maxTokens: 64_000,
    });
    expect(model.model.id).not.toMatch(/-v1:0$/);
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

  it('aborts Pi turns after an inactivity timeout', async () => {
    vi.useFakeTimers();
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.recordChatThreadObservabilityEvent = vi.fn();
    fake.disposePiSession = vi.fn();
    const promise = ChatThreadDO.prototype['withPiTurnInactivityTimeout'].call(
      fake,
      () => new Promise<void>(() => undefined),
    );
    const assertion = expect(promise).rejects.toThrow(/inactivity timeout/i);

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await assertion;

    expect(fake.disposePiSession).toHaveBeenCalledTimes(1);
  });

  it('resets streaming state and surfaces an error when a prompt hits the inactivity timeout', async () => {
    vi.useFakeTimers();
    const { fake, events } = createPiEventFake();
    fake.persistPiAgentLoopErrorForDevelopers = vi.fn();
    fake.updateActiveAutomationRun = vi.fn();
    fake.refreshPiSessionModel = vi.fn(async () => undefined);
    // The session is not streaming, so the prompt path runs through
    // withPiTurnInactivityTimeout. The prompt never resolves, so only the
    // inactivity timeout can end the turn — exactly the provider/tool hang the
    // bug is about. disposePiSession (the real one runs during the timeout)
    // unsubscribes handlers, so no agent_end runs to clean up.
    fake.piTurnLastProgressAtMs = 0;
    fake.disposePiSession = vi.fn(() => {
      fake.piSession = null;
    });
    fake.piSession = {
      state: { isStreaming: false, model: { api: 'test', provider: 'test', id: 'test-model' } },
      prompt: vi.fn(() => new Promise<void>(() => undefined)),
      steer: vi.fn(),
      abort: vi.fn(),
    };

    const accepted = ChatThreadDO.prototype['sendRunnerCommand'].call(fake, {
      type: 'message',
      content: 'do the thing',
    });
    expect(accepted).toBe(true);

    // Drive the inactivity timeout and let the queued waitUntil work settle.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await flushWaitUntil(fake);

    // The thread is not left streaming: cleanup that agent_end would normally
    // do is performed in the catch instead.
    expect(fake.finishTurn).toHaveBeenCalled();
    expect(fake.setActiveTurnUserId).toHaveBeenCalledWith(null);
    expect(fake.updateActiveAutomationRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error', clear: true }),
    );
    // The stall is surfaced to the user as a provider error, not swallowed.
    expect(events.some((event) => event.type === 'error')).toBe(true);
  });

  it.each([
    ['gemini-3.5-flash', 'google/gemini-3.5-flash'],
    ['gemini-3-flash-preview', 'google/gemini-3-flash-preview'],
    ['gemini-3.1-pro-preview', 'google/gemini-3.5-flash'],
  ])('routes %s through OpenRouter chat completions', (model, routeModel) => {
    const result = new PiModelMapping().resolvePiModelReference(model);

    expect(result).toEqual({
      provider: 'openrouter',
      modelId: routeModel,
      hostedGatewayProvider: 'openrouter',
      hostedModelId: routeModel,
    });
  });

  it('runs code mode JavaScript through the Worker Loader with scoped tools', async () => {
    const toolsBinding = { listTools: vi.fn(), callTool: vi.fn() };
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
        AIVirtualBinding: vi.fn(() => aiBinding),
        CamelAiService: vi.fn(() => aiBinding),
        SecureFetchBinding: vi.fn(() => ({ fetch: vi.fn() })),
        AppScreenshotBinding: vi.fn(() => ({ capture: vi.fn() })),
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
        parentToolUseId: undefined,
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
    expect(fake.ctx.exports.SecureFetchBinding).toHaveBeenCalledWith({
      props: {
        orgId: 'org_1',
        workspaceId: 'ws_1',
      },
    });
    expect(fake.ctx.exports.AppScreenshotBinding).toHaveBeenCalledWith({
      props: {
        orgId: 'org_1',
        workspaceId: 'ws_1',
      },
    });
    expect(capturedWorkerCode.globalOutbound).toBeUndefined();
    expect(capturedWorkerCode.env.TOOLS).toBe(toolsBinding);
    expect(capturedWorkerCode.env.CONNECTIONS).toBeUndefined();
    expect(capturedWorkerCode.env.AI).toBe(aiBinding);
    expect(capturedWorkerCode.env.CAMELAI).toBe(aiBinding);
    expect(capturedWorkerCode.env.SECURE_FETCH).toEqual({ fetch: expect.any(Function) });
    expect(capturedWorkerCode.env.SCREENSHOT).toEqual({ capture: expect.any(Function) });
    expect(capturedWorkerCode.modules['index.js'].js).toContain('class CodeModeRunner');
    expect(capturedWorkerCode.modules['index.js'].js).toContain('createConnectionsFacade');
    expect(capturedWorkerCode.modules['index.js'].js).toContain('if (connectionName === "$find") return (query) => binding.find(query)');
    expect(capturedWorkerCode.modules['index.js'].js).toContain('if (connectionName === "$test") return (query) => binding.test(query)');
    expect(capturedWorkerCode.modules['index.js'].js).toContain('createToolBackedConnectionsBinding');
    expect(capturedWorkerCode.modules['index.js'].js).toContain('const CONNECTIONS_BINDING = createToolBackedConnectionsBinding(callTool)');
    expect(capturedWorkerCode.modules['index.js'].js).toContain('const CONNECTIONS = connections');
    expect(capturedWorkerCode.modules['index.js'].js).toContain('return binding.invoke(request)');
    expect(capturedWorkerCode.modules['index.js'].js).not.toContain('invoke.call(binding');
    expect(capturedWorkerCode.modules['index.js'].js).toContain('createOutputConsole');
    expect(capturedWorkerCode.modules['index.js'].js).toContain('globalThis.console = createOutputConsole(output)');
    expect(capturedWorkerCode.modules['index.js'].js).toContain('const AI = this.env.AI');
    expect(capturedWorkerCode.modules['index.js'].js).toContain('createToolHelp');
    expect(capturedWorkerCode.modules['index.js'].js).toContain('createCamelAiFacade');
    expect(capturedWorkerCode.modules['index.js'].js).toContain('createWorkspaceFacade');
    expect(capturedWorkerCode.modules['index.js'].js).toContain('const WORKSPACE = createWorkspaceFacade(callTool)');
    expect(capturedWorkerCode.modules['index.js'].js).toContain('createVmFacade');
    expect(capturedWorkerCode.modules['index.js'].js).toContain('createProjectsFacade');
    expect(capturedWorkerCode.modules['index.js'].js).toContain('const env = Object.freeze({ CONNECTIONS, AI, CAMELAI, SCREENSHOT, WORKSPACE, VM, PROJECTS })');
    expect(capturedWorkerCode.modules['index.js'].js).toContain('const context = Object.freeze({ cloudflare: Object.freeze({ env, connections, vm, projects: env.PROJECTS }) })');
    expect(capturedWorkerCode.modules['index.js'].js).not.toContain('const projects = PROJECTS');
    expect(capturedWorkerCode.modules['index.js'].js).not.toContain('PROJECTS, projects, env');
    expect(capturedWorkerCode.modules['index.js'].js).toContain('parameters: tool.parameters');
    expect(capturedWorkerCode.modules['index.js'].js).toContain('await tools.help(\\"communication\\")');
    expect(capturedWorkerCode.modules['index.js'].js).toContain('await env.CAMELAI.help()');
    expect(capturedWorkerCode.modules['index.js'].js).toContain('return methods;');
    expect(capturedWorkerCode.modules['index.js'].js).not.toContain('AsyncFunction');
    expect(capturedWorkerCode.modules['index.js'].js).not.toContain('new Function');
    expect(result.text).toBe(`${'x'.repeat(1000)}\n\n[Truncated: 1000 of 1200 characters]`);
  });

  it('allows js_exec callers to request a longer wall-clock timeout and explains how to raise it', async () => {
    vi.useFakeTimers();

    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.env = {
      CODE_MODE_LOADER: {
        load: vi.fn(() => ({
          getEntrypoint: vi.fn(() => ({
            run: vi.fn(() => new Promise(() => {})),
          })),
        })),
      },
    };
    fake.ctx = {
      exports: {
        CodeModeToolsBinding: vi.fn(() => ({})),
        ConnectionsService: vi.fn(() => ({})),
        AIVirtualBinding: vi.fn(() => ({})),
        CamelAiService: vi.fn(() => ({})),
        SecureFetchBinding: vi.fn(() => ({ fetch: vi.fn() })),
        AppScreenshotBinding: vi.fn(() => ({ capture: vi.fn() })),
      },
    };

    const runPromise = ChatThreadDO.prototype.runCodeModeJavascript.call(fake, {
      code: 'await new Promise(() => {})',
      orgId: 'org_1',
      workspaceId: 'ws_1',
      timeoutMs: 150_000,
    });

    const rejection = expect(runPromise).rejects.toThrow(
      'JavaScript execution timed out after 150000ms. If this script needs more wall-clock time, call js_exec again with a larger timeoutMs value (maximum 600000ms).',
    );

    await vi.advanceTimersByTimeAsync(150_000);
    await rejection;
  });

  it('clamps js_exec wall-clock timeouts to the platform maximum', async () => {
    vi.useFakeTimers();

    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.env = {
      CODE_MODE_LOADER: {
        load: vi.fn(() => ({
          getEntrypoint: vi.fn(() => ({
            run: vi.fn(() => new Promise(() => {})),
          })),
        })),
      },
    };
    fake.ctx = {
      exports: {
        CodeModeToolsBinding: vi.fn(() => ({})),
        ConnectionsService: vi.fn(() => ({})),
        AIVirtualBinding: vi.fn(() => ({})),
        CamelAiService: vi.fn(() => ({})),
        SecureFetchBinding: vi.fn(() => ({ fetch: vi.fn() })),
        AppScreenshotBinding: vi.fn(() => ({ capture: vi.fn() })),
      },
    };

    const runPromise = ChatThreadDO.prototype.runCodeModeJavascript.call(fake, {
      code: 'await new Promise(() => {})',
      orgId: 'org_1',
      workspaceId: 'ws_1',
      timeoutMs: 999_999,
    });

    const rejection = expect(runPromise).rejects.toThrow(
      'JavaScript execution timed out after 600000ms. If this script needs more wall-clock time, call js_exec again with a larger timeoutMs value (maximum 600000ms).',
    );

    await vi.advanceTimersByTimeAsync(600_000);
    await rejection;
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
      path: 'uploads/note.ogg',
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
      'delete',
      'move',
      'grep',
      'find',
      'AskUserQuestion',
      'TodoWrite',
      'set_preview',
      'list_apps',
      'rollback_deploy',
      'list_deploy_versions',
      'list_scheduled_prompts',
      'list_workflows',
      'list_integrations',
      'create_project',
      'scaffold_project',
      'set_project_description',
      'add_dependency',
      'revert_project',
      'list_commits',
      'get_custom_domain',
      'Agent',
      'Explore',
      'WebSearch',
      'WebFetch',
      'connections_methods',
    ]));
    expect((byName.get('bash') as any).parameters.properties.command).toBeDefined();
    expect((byName.get('bash') as any).parameters.properties.project).toBeDefined();
    expect((byName.get('bash') as any).parameters.properties.projectId).toBeUndefined();
    expect((byName.get('read') as any).parameters.properties.path).toBeDefined();
    expect((byName.get('read') as any).parameters.properties.project).toBeDefined();
    expect((byName.get('create_project') as any).parameters.properties.description).toBeDefined();
    expect((byName.get('create_project') as any).parameters.properties.name).toBeDefined();
    expect((byName.get('create_project') as any).parameters.properties.template).toBeDefined();
    expect((byName.get('create_project') as any).parameters.required).toContain('description');
    expect((byName.get('create_project') as any).parameters.required).toContain('name');
    expect((byName.get('scaffold_project') as any).parameters.properties.project).toBeDefined();
    expect((byName.get('scaffold_project') as any).parameters.properties.force).toBeDefined();
    expect((byName.get('set_project_description') as any).parameters.properties.project).toBeDefined();
    expect((byName.get('set_project_description') as any).parameters.properties.projectId).toBeUndefined();
    expect((byName.get('set_project_description') as any).parameters.properties.description).toBeDefined();
    expect((byName.get('add_dependency') as any).parameters.properties.project).toBeDefined();
    expect((byName.get('add_dependency') as any).parameters.properties.dependency).toBeDefined();
    expect((byName.get('revert_project') as any).parameters.properties.snapshot_id).toBeDefined();
    expect((byName.get('list_commits') as any).parameters.properties.project).toBeDefined();
    expect((byName.get('set_preview') as any).parameters.properties.location).toBeDefined();
    expect(JSON.stringify((byName.get('set_preview') as any).parameters.properties.location)).toContain('workspace');
    expect(JSON.stringify((byName.get('set_preview') as any).parameters.properties.location)).toContain('project');
    expect(JSON.stringify((byName.get('set_preview') as any).parameters.properties.location)).toContain('vm');
    expect(JSON.stringify((byName.get('set_preview') as any).parameters.properties.location)).toContain('r2');
    expect((byName.get('set_preview') as any).parameters.properties.project).toBeDefined();
    expect((byName.get('set_preview') as any).parameters.properties.clear).toBeUndefined();
    expect((byName.get('rollback_deploy') as any).parameters.properties.script_name).toBeDefined();
    expect((byName.get('rollback_deploy') as any).parameters.properties.artifact_cache_key).toBeDefined();
    expect((byName.get('list_deploy_versions') as any).parameters.properties.script_name).toBeDefined();
    expect((byName.get('WebSearch') as any).parameters.properties.query).toBeDefined();
    expect((byName.get('WebFetch') as any).parameters.properties.url).toBeDefined();
    expect((byName.get('read') as any).parameters.properties.key).toBeUndefined();
    expect((byName.get('read') as any).parameters.properties.location).toBeDefined();
    expect((byName.get('read') as any).parameters.required).toEqual(expect.arrayContaining(['location', 'path']));
    expect((byName.get('write') as any).parameters.properties.content_type).toBeDefined();
    expect((byName.get('ls') as any).parameters.properties.cursor).toBeDefined();
    expect((byName.get('delete') as any).parameters.properties.location).toBeDefined();
    expect((byName.get('move') as any).parameters.properties.source).toBeDefined();
    expect((byName.get('move') as any).parameters.properties.destination).toBeDefined();
    expect(byName.has('vm_push')).toBe(false);
    expect(byName.has('vm_pull')).toBe(false);
    expect(byName.has('r2_read')).toBe(false);
    expect(byName.has('r2_write')).toBe(false);
    expect(byName.has('r2_list')).toBe(false);
    expect(byName.has('r2_delete')).toBe(false);
    expect(byName.has('workspace_info')).toBe(false);
    expect((byName.get('connections_get') as any).parameters.properties.connection).toBeDefined();
    expect(byName.get('send_email')).toMatchObject({
      category: 'communication',
      sideEffect: true,
      externalDelivery: true,
      examples: expect.arrayContaining([expect.stringContaining('tools.send_email')]),
    });
    expect(byName.get('send_slack_message')).toMatchObject({
      category: 'communication',
      sideEffect: true,
      externalDelivery: true,
      examples: expect.arrayContaining([expect.stringContaining('tools.send_slack_message')]),
    });
    expect(byName.get('send_telegram_message')).toMatchObject({
      category: 'communication',
      sideEffect: true,
      externalDelivery: true,
      examples: expect.arrayContaining([expect.stringContaining('tools.send_telegram_message')]),
    });
    expect(byName.get('connections_methods')).toMatchObject({
      category: 'connections',
      examples: expect.arrayContaining([expect.stringContaining('env.CONNECTIONS.methods')]),
    });
    expect(byName.has('list_deterministic_automations')).toBe(false);
    expect(byName.has('prompt_connection_setup')).toBe(false);
  });

  it('requires set_preview to receive an explicit target', async () => {
    const setPreviewTarget = vi.fn();
    const fake = Object.create(CodeModeToolsBinding.prototype) as any;
    Object.defineProperty(fake, 'chatThreadStub', {
      value: { setPreviewTarget },
    });

    await expect((CodeModeToolsBinding.prototype as any).setPreview.call(fake, {
      location: 'vm',
      project: 'menu-app',
    })).rejects.toThrow('path is required when previewing a VM file');
    await expect((CodeModeToolsBinding.prototype as any).setPreview.call(fake, {}))
      .rejects.toThrow('set_preview requires app_name/script_name or path');
    expect(setPreviewTarget).not.toHaveBeenCalled();
  });

  it('validates workspace file previews before changing preview state', async () => {
    const setPreviewTarget = vi.fn();
    const exists = vi.fn(async () => ({ exists: false }));
    const fake = Object.create(CodeModeToolsBinding.prototype) as any;
    fake.ctx = { props: { workspaceId: 'workspace1' } };
    Object.defineProperty(fake, 'chatThreadStub', {
      value: { setPreviewTarget },
    });
    Object.defineProperty(fake, 'workspaceFs', {
      value: { exists },
    });

    await expect((CodeModeToolsBinding.prototype as any).setPreview.call(fake, {
      location: 'workspace',
      path: '/missing.html',
    })).rejects.toThrow('Preview file not found: /missing.html');
    expect(exists).toHaveBeenCalledWith('/missing.html');
    expect(setPreviewTarget).not.toHaveBeenCalled();
  });

  it('sets explicit workspace file previews', async () => {
    const setPreviewTarget = vi.fn();
    const exists = vi.fn(async () => ({ exists: true, isDirectory: false }));
    const fake = Object.create(CodeModeToolsBinding.prototype) as any;
    fake.ctx = { props: { workspaceId: 'workspace1' } };
    Object.defineProperty(fake, 'chatThreadStub', {
      value: { setPreviewTarget },
    });
    Object.defineProperty(fake, 'workspaceFs', {
      value: { exists },
    });

    const result = await (CodeModeToolsBinding.prototype as any).setPreview.call(fake, {
      location: 'workspace',
      path: 'outputs/report.html',
    });

    expect(exists).toHaveBeenCalledWith('/outputs/report.html');
    expect(result).toMatchObject({
      success: true,
      target: {
        kind: 'file',
        source: 'workspace',
        workspaceId: 'workspace1',
        path: '/outputs/report.html',
        filename: 'report.html',
      },
    });
    expect(setPreviewTarget).toHaveBeenCalledWith((result as any).target);
  });

  it('sets explicit R2 file previews', async () => {
    const setPreviewTarget = vi.fn();
    const head = vi.fn(async () => ({ size: 42 }));
    const fake = Object.create(CodeModeToolsBinding.prototype) as any;
    fake.ctx = { props: { orgId: 'org1', workspaceId: 'workspace1' } };
    fake.env = { R2_BUCKET: { head } };
    Object.defineProperty(fake, 'chatThreadStub', {
      value: { setPreviewTarget },
    });

    const result = await (CodeModeToolsBinding.prototype as any).setPreview.call(fake, {
      location: 'r2',
      path: 'outputs/report.html',
    });

    expect(head).toHaveBeenCalledWith('org1/workspace1/user-outputs/report.html');
    expect(result).toMatchObject({
      success: true,
      target: {
        kind: 'file',
        source: 'output',
        workspaceId: 'workspace1',
        path: 'report.html',
        filename: 'report.html',
      },
    });
    expect(setPreviewTarget).toHaveBeenCalledWith((result as any).target);
  });

  it('sets explicit DO-backed project file previews', async () => {
    const setPreviewTarget = vi.fn();
    const exists = vi.fn(async () => ({ exists: true, isDirectory: false }));
    const fake = Object.create(CodeModeToolsBinding.prototype) as any;
    fake.ctx = { props: { workspaceId: 'workspace1' } };
    Object.defineProperty(fake, 'chatThreadStub', {
      value: { setPreviewTarget },
    });
    fake.projectFileStore = vi.fn(async () => ({ exists }));

    const result = await (CodeModeToolsBinding.prototype as any).setPreview.call(fake, {
      location: 'project',
      project: 'menu-app',
      path: 'index.html',
    });

    expect(fake.projectFileStore).toHaveBeenCalledWith({ project: 'menu-app' });
    expect(exists).toHaveBeenCalledWith('/index.html');
    expect(result).toMatchObject({
      success: true,
      target: {
        kind: 'file',
        source: 'project',
        workspaceId: 'workspace1',
        path: '/index.html',
        project: 'menu-app',
        filename: 'index.html',
      },
    });
    expect(setPreviewTarget).toHaveBeenCalledWith((result as any).target);
  });

  it('validates VM file previews before changing preview state', async () => {
    const setPreviewTarget = vi.fn();
    const assertFileReadable = vi.fn(async () => ({ path: '/workspace/index.html' }));
    const fake = Object.create(CodeModeToolsBinding.prototype) as any;
    fake.ctx = { props: { workspaceId: 'workspace1' } };
    Object.defineProperty(fake, 'chatThreadStub', {
      value: { setPreviewTarget },
    });
    Object.defineProperty(fake, 'workspaceFs', {
      value: { getProjectByName: vi.fn(async () => ({ name: 'menu-app', backend: 'vm' })) },
    });
    Object.defineProperty(fake, 'projectVm', {
      value: { assertFileReadable },
    });

    const result = await (CodeModeToolsBinding.prototype as any).setPreview.call(fake, {
      location: 'vm',
      project: 'menu-app',
      path: 'index.html',
    });

    expect(assertFileReadable).toHaveBeenCalledWith({
      location: 'vm',
      project: 'menu-app',
      path: '/index.html',
    });
    expect(result).toMatchObject({
      success: true,
      target: {
        kind: 'file',
        source: 'vm',
        workspaceId: 'workspace1',
        path: '/index.html',
        project: 'menu-app',
        filename: 'index.html',
      },
    });
    expect(setPreviewTarget).toHaveBeenCalledWith((result as any).target);
  });

  it('exposes current workspace email metadata to js_exec', async () => {
    const fake = Object.create(CodeModeToolsBinding.prototype) as any;
    fake.ctx = {
      props: {
        orgId: 'org1',
        workspaceId: 'workspace1',
        userId: 'user1',
      },
    };
    fake.env = {
      WORKSPACE_EMAIL_DOMAIN: 'camelai.dev',
      EMAIL: { send: vi.fn() },
      WORKSPACE: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({
          getInfo: vi.fn(async () => ({
            id: 'workspace1',
            name: 'Demo Workspace',
            email_handle: 'demo-workspace',
          })),
        })),
      },
    };

    await expect(
      CodeModeToolsBinding.prototype.callTool.call(fake, 'workspace_info', {}),
    ).resolves.toMatchObject({
      id: 'workspace1',
      name: 'Demo Workspace',
      email_address: 'demo-workspace@camelai.dev',
    });
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
      location: 'workspace',
      path: '/opt/chiridion-host-pi/skills',
    });
    expect(listing.content[0].text).toContain('developing-software');

    const skill = await read.execute('tool2', {
      location: 'workspace',
      path: '/opt/chiridion-host-pi/skills/developing-software/SKILL.md',
    });
    expect(skill.content[0].text).toContain('name: developing-software');
    expect(skill.details.details.source).toBe('bundled_skill');
    expect(bindingFactory).toHaveBeenCalled();
    expect(containerTool).not.toHaveBeenCalled();
  });

  it('leaves bounded Pi tool results unchanged', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.recordChatThreadObservabilityEvent = vi.fn();

    const result = await ChatThreadDO.prototype['afterPiToolCall'].call(fake, {
      toolCall: { id: 'call_1', name: 'WebFetch' },
      result: {
        content: [{ type: 'text', text: 'small result' }],
        details: { source: 'test' },
      },
    });

    expect(result).toBeUndefined();
    expect(fake.recordChatThreadObservabilityEvent).not.toHaveBeenCalled();
  });

  it('truncates oversized Pi tool results and stores full text in R2', async () => {
    const puts: Array<{ key: string; value: string; options: unknown }> = [];
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.chatContext = {
      orgId: 'org1',
      workspaceId: 'workspace1',
      threadId: 'thread1',
    };
    fake.env = {
      R2_BUCKET: {
        put: vi.fn(async (key: string, value: string, options: unknown) => {
          puts.push({ key, value, options });
        }),
      },
    };
    fake.recordChatThreadObservabilityEvent = vi.fn();

    const big = `${'a'.repeat(60 * 1024)}\nfinal-line`;
    const result = await ChatThreadDO.prototype['afterPiToolCall'].call(fake, {
      toolCall: { id: 'call_1', name: 'WebFetch' },
      result: {
        content: [{ type: 'text', text: big }],
        details: { source: 'test' },
      },
    });

    expect(result?.content?.[0]).toMatchObject({ type: 'text' });
    const text = (result?.content?.[0] as any).text as string;
    expect(text.length).toBeLessThan(big.length);
    expect(text).toMatch(/^a+/);
    expect(text).toContain('[Output truncated: showing first');
    expect(text).toContain('Full output stored in R2 at tmp/');
    expect(text).toContain('read({ location: "r2", path: "tmp/');
    expect(text).not.toContain('final-line');
    expect(result?.details).toMatchObject({
      source: 'test',
      originalTextBlockCount: 1,
      truncation: {
        truncated: true,
        direction: 'head',
      },
    });
    expect(puts).toHaveLength(1);
    expect(puts[0].key).toContain('chat-sessions/thread1/pi-tool-results/tmp/');
    expect(puts[0].value).toBe(big);
    const storedPath = (result?.details as any).chiridionR2ToolResult.path;
    expect(storedPath).toMatch(/^tmp\/.+\.txt$/);
    expect(puts[0].key.endsWith(storedPath.replace(/^tmp\//, ''))).toBe(true);
    expect((result?.details as any).chiridionR2ToolResult.key).toBeUndefined();
    expect((result?.details as any).truncation.fullOutput.path).toBe(storedPath);
  });

  it('keeps the tail for oversized bash tool results', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.chatContext = {
      orgId: 'org1',
      workspaceId: 'workspace1',
      threadId: 'thread1',
    };
    fake.env = {
      R2_BUCKET: {
        put: vi.fn(async () => undefined),
      },
    };
    fake.recordChatThreadObservabilityEvent = vi.fn();

    const big = Array.from({ length: 2600 }, (_, index) => `line-${index}`).join('\n');
    const result = await ChatThreadDO.prototype['afterPiToolCall'].call(fake, {
      toolCall: { id: 'call_1', name: 'bash' },
      result: {
        content: [{ type: 'text', text: big }],
        details: {},
      },
    });

    const text = (result?.content?.[0] as any).text as string;
    expect(text).toContain('line-2599');
    expect(text).not.toContain('line-0');
    expect((result?.details as any).truncation).toMatchObject({
      truncated: true,
      direction: 'tail',
      truncatedBy: 'lines',
    });
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
    expect(piTools.find((tool: any) => tool.name === 'list_projects')).toBeTruthy();
    expect(piTools.find((tool: any) => tool.name === 'create_project')).toBeTruthy();
    expect(piTools.find((tool: any) => tool.name === 'scaffold_project')).toBeTruthy();
    expect(piTools.find((tool: any) => tool.name === 'set_project_description')).toBeTruthy();
    expect(piTools.find((tool: any) => tool.name === 'clone_project')).toBeTruthy();
    expect(piTools.find((tool: any) => tool.name === 'send_email')).toBeUndefined();
    expect(piTools.find((tool: any) => tool.name === 'send_slack_message')).toBeUndefined();
    expect(piTools.find((tool: any) => tool.name === 'send_telegram_message')).toBeUndefined();

    const codeModeTools = await CodeModeToolsBinding.prototype.listTools.call({} as any);
    expect(codeModeTools.find((tool: any) => tool.name === 'send_email')).toBeTruthy();
    expect(codeModeTools.find((tool: any) => tool.name === 'send_slack_message')).toBeTruthy();
    expect(codeModeTools.find((tool: any) => tool.name === 'send_telegram_message')).toBeTruthy();
  });

  it('moves files between explicit locations without vm_push/vm_pull', async () => {
    const get = vi.fn(async () => r2Object('hello from r2', 'text/plain'));
    const head = vi.fn(async () => ({
      size: 13,
      etag: 'etag',
      uploaded: new Date('2026-01-01T00:00:00.000Z'),
      httpMetadata: { contentType: 'text/plain' },
      customMetadata: {},
    }));
    const writeFileBytesForTransfer = vi.fn(async ({ path }: any, bytes: Uint8Array) => ({
      path,
      bytes: bytes.byteLength,
    }));
    const fake = Object.create(CodeModeToolsBinding.prototype) as any;
    fake.env = { R2_BUCKET: { head, get } };
    fake.ctx = { props: { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' } };
    Object.defineProperty(fake, 'workspaceFs', {
      value: { getProjectByName: vi.fn(async () => ({ name: 'web-app', backend: 'vm' })) },
    });
    Object.defineProperty(fake, 'projectVm', {
      value: { writeFileBytesForTransfer },
    });

    const result = await (CodeModeToolsBinding.prototype as any).moveFile.call(fake, {
      source: { location: 'r2', path: 'outputs/report.txt' },
      destination: { location: 'vm', project: 'web-app', path: '/workspace/report.txt' },
    });

    expect(head).toHaveBeenCalledWith('org1/workspace1/user-outputs/report.txt');
    expect(get).toHaveBeenCalledWith('org1/workspace1/user-outputs/report.txt');
    expect(writeFileBytesForTransfer).toHaveBeenCalledWith(
      { location: 'vm', path: '/workspace/report.txt', project: 'web-app', contentType: undefined },
      new TextEncoder().encode('hello from r2'),
    );
    expect(result.text).toBe('Copied 1 file (13 bytes)');
    expect(result.details.files).toEqual([
      { from: 'outputs/report.txt', to: '/workspace/report.txt', bytes: 13 },
    ]);
  });

  it('rejects destructive moves with equal or descendant destinations', async () => {
    const fake = Object.create(CodeModeToolsBinding.prototype) as any;
    fake.ctx = { props: { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' } };
    const writeBinaryFile = vi.fn();
    Object.defineProperty(fake, 'workspaceFs', {
      value: {
        exists: vi.fn(async (path: string) => path === '/dir'
          ? { exists: true, isFile: false, isDirectory: true }
          : { exists: true, isFile: true, isDirectory: false, size: 4, mimeType: 'text/plain' }),
        listFiles: vi.fn(async () => ({
          success: true,
          files: [{ type: 'file', absolutePath: '/dir/file.txt', relativePath: 'file.txt', size: 4, mimeType: 'text/plain' }],
        })),
        writeBinaryFile,
      },
    });

    await expect((CodeModeToolsBinding.prototype as any).moveFile.call(fake, {
      source: { location: 'workspace', path: '/same.txt' },
      destination: { location: 'workspace', path: '/same.txt' },
      deleteSource: true,
    })).rejects.toThrow('equal or descendant destination');

    await expect((CodeModeToolsBinding.prototype as any).moveFile.call(fake, {
      source: { location: 'workspace', path: '/dir' },
      destination: { location: 'workspace', path: '/dir/nested' },
      deleteSource: true,
    })).rejects.toThrow('equal or descendant destination');

    const r2Delete = vi.fn();
    const r2Get = vi.fn();
    fake.env = {
      R2_BUCKET: {
        head: vi.fn(async () => ({ size: 4, httpMetadata: { contentType: 'text/plain' } })),
        get: r2Get,
        delete: r2Delete,
      },
    };
    await expect((CodeModeToolsBinding.prototype as any).moveFile.call(fake, {
      source: { location: 'r2', path: 'outputs/same.txt' },
      destination: { location: 'r2', path: 'outputs/same.txt' },
      deleteSource: true,
    })).rejects.toThrow('equal or descendant destination');

    expect(writeBinaryFile).not.toHaveBeenCalled();
    expect(r2Get).not.toHaveBeenCalled();
    expect(r2Delete).not.toHaveBeenCalled();
  });

  it('requires explicit file locations and rejects legacy R2 paths', async () => {
    const fake = Object.create(CodeModeToolsBinding.prototype) as any;
    fake.recordCodeModeArtifactBestEffort = vi.fn();
    fake.ctx = { props: { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' } };

    await expect(CodeModeToolsBinding.prototype.callTool.call(fake, 'read', {
      path: 'outputs/report.txt',
    })).rejects.toThrow('read requires an explicit location');
    expect(() => CodeModeToolsBinding.prototype['resolveCodeModeR2Path'].call(fake, {
      location: 'r2',
      path: '/mnt/user-outputs/report.txt',
    })).toThrow('R2 paths must be relative');
    expect(() => CodeModeToolsBinding.prototype['resolveCodeModeR2Path'].call(fake, {
      location: 'r2',
      key: 'org1/workspace1/user-outputs/report.txt',
    })).toThrow('R2 path is required');
  });

  it('reads stored R2 tool result paths with Pi-style line offsets', async () => {
    const raw = Array.from({ length: 3000 }, (_, index) => `line-${index + 1}`).join('\n');
    const bytes = new TextEncoder().encode(raw);
    const key = 'org1/workspace1/chat-sessions/thread1/pi-tool-results/tmp/result.txt';
    const head = {
      key,
      size: bytes.byteLength,
      etag: 'etag1',
      uploaded: new Date('2026-01-01T00:00:00Z'),
      httpMetadata: { contentType: 'text/plain' },
      customMetadata: { type: 'pi-tool-result-text' },
    };
    const get = vi.fn(async () => ({
      ...head,
      async text() {
        return raw;
      },
    }));
    const fake = Object.create(CodeModeToolsBinding.prototype) as any;
    fake.ctx = {
      props: {
        orgId: 'org1',
        workspaceId: 'workspace1',
        threadId: 'thread1',
      },
    };
    fake.env = {
      IMAGES: { input: vi.fn() },
      R2_BUCKET: {
        head: vi.fn(async () => head),
        get,
      },
    };
    fake.recordCodeModeArtifactBestEffort = vi.fn();

    const result = await CodeModeToolsBinding.prototype.callTool.call(fake, 'read', {
      location: 'r2',
      path: 'tmp/result.txt',
      offset: 2,
      limit: 3,
    });

    expect(get).toHaveBeenCalledWith(key);
    expect((result as any).text).toContain('line-2\nline-3\nline-4');
    expect((result as any).text).toContain('Use offset=5 to continue');
    expect((result as any).details).toMatchObject({
      location: 'r2',
      path: 'tmp/result.txt',
      offset: 2,
      nextOffset: 5,
      totalLines: 3000,
      truncation: {
        truncated: false,
        outputLines: 3,
      },
    });
  });

  it('returns R2 image objects as Pi image tool content', async () => {
    const key = 'org1/workspace1/user-outputs/chart.png';
    const pngBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01,
      0x00, 0x00, 0x00, 0x01,
    ]);
    const head = {
      key,
      size: pngBytes.byteLength,
      etag: 'etag1',
      uploaded: new Date('2026-01-01T00:00:00Z'),
      httpMetadata: { contentType: 'application/octet-stream' },
      customMetadata: { type: 'code-mode-r2-file' },
    };
    const fake = Object.create(CodeModeToolsBinding.prototype) as any;
    fake.ctx = {
      props: {
        orgId: 'org1',
        workspaceId: 'workspace1',
        threadId: 'thread1',
      },
    };
    const arrayBuffer = vi.fn(async () => {
      throw new Error('arrayBuffer should not be used for streamed image reads');
    });
    const output = vi.fn(async () => ({
      contentType: () => 'image/png',
      image: () => new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('transformed-base64'));
          controller.close();
        },
      }),
    }));
    const transform = vi.fn(() => ({ output }));
    const images = {
      info: vi.fn(),
      input: vi.fn(() => ({ transform, output })),
    };
    fake.env = {
      IMAGES: images,
      R2_BUCKET: {
        head: vi.fn(async () => head),
        get: vi.fn(async () => ({
          ...head,
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(pngBytes);
              controller.close();
            },
          }),
          arrayBuffer,
        })),
      },
    };

    fake.recordCodeModeArtifactBestEffort = vi.fn();

    const result = await CodeModeToolsBinding.prototype.callTool.call(fake, 'read', { location: 'r2', path: 'outputs/chart.png' });

    expect((result as any).text).toContain('Read R2 image object [image/png]');
    expect((result as any).content).toEqual([
      { type: 'text', text: 'Read R2 image object [image/png]\n[Image optimized for inline model context and may be scaled/compressed from the source.]' },
      {
        type: 'image',
        data: 'transformed-base64',
        mimeType: 'image/png',
      },
    ]);
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(images.input).toHaveBeenCalled();
    expect(transform).toHaveBeenCalledWith({ width: 2000, height: 2000, fit: 'scale-down' });
    expect((result as any).details).toMatchObject({
      location: 'r2',
      path: 'outputs/chart.png',
      image: true,
      mimeType: 'image/png',
      inlineImage: true,
      optimizedForInlineView: true,
      maxInlineDimension: 2000,
      usedImagesBinding: true,
      offset: null,
      nextOffset: null,
      totalLines: null,
      truncation: null,
    });
  });

  it('rejects large non-image R2 objects after sniffing without draining the body', async () => {
    const key = 'org1/workspace1/user-outputs/large.bin';
    const head = {
      key,
      size: 11 * 1024 * 1024,
      etag: 'etag1',
      uploaded: new Date('2026-01-01T00:00:00Z'),
      httpMetadata: { contentType: 'application/octet-stream' },
      customMetadata: { type: 'code-mode-r2-file' },
    };
    const fake = Object.create(CodeModeToolsBinding.prototype) as any;
    fake.ctx = { props: { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' } };
    let pulls = 0;
    let cancelled = false;
    fake.env = {
      IMAGES: { input: vi.fn() },
      R2_BUCKET: {
        head: vi.fn(async () => head),
        get: vi.fn(async () => ({
          ...head,
          body: new ReadableStream({
            pull(controller) {
              pulls += 1;
              if (pulls === 1) {
                controller.enqueue(new Uint8Array(4100));
                return;
              }
              throw new Error('body should not be drained after non-image sniff');
            },
            cancel() {
              cancelled = true;
            },
          }),
          arrayBuffer: vi.fn(async () => {
            throw new Error('arrayBuffer should not be used for streamed R2 reads');
          }),
        })),
      },
    };
    fake.recordCodeModeArtifactBestEffort = vi.fn();

    await expect(CodeModeToolsBinding.prototype.callTool.call(fake, 'read', {
      location: 'r2',
      path: 'outputs/large.bin',
    })).rejects.toThrow('R2 object is too large for text read');

    expect(pulls).toBe(1);
    expect(cancelled).toBe(true);
  });

  it('sniffs large generic R2 images and optimizes streamed image content', async () => {
    const key = 'org1/workspace1/user-outputs/large-chart.png';
    const pngBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x0b, 0xb8,
      0x00, 0x00, 0x03, 0xe8,
    ]);
    const head = {
      key,
      size: 11 * 1024 * 1024,
      etag: 'etag1',
      uploaded: new Date('2026-01-01T00:00:00Z'),
      httpMetadata: { contentType: 'application/octet-stream' },
      customMetadata: { type: 'code-mode-r2-file' },
    };
    const fake = Object.create(CodeModeToolsBinding.prototype) as any;
    fake.ctx = { props: { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' } };
    const arrayBuffer = vi.fn(async () => {
      throw new Error('arrayBuffer should not be used for streamed image reads');
    });
    const output = vi.fn(async () => ({
      contentType: () => 'image/png',
      image: () => new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('large-transformed-base64'));
          controller.close();
        },
      }),
    }));
    const transform = vi.fn(() => ({ output }));
    fake.env = {
      IMAGES: {
        input: vi.fn(() => ({ transform, output })),
      },
      R2_BUCKET: {
        head: vi.fn(async () => head),
        get: vi.fn(async () => ({
          ...head,
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(pngBytes);
              controller.close();
            },
          }),
          arrayBuffer,
        })),
      },
    };
    fake.recordCodeModeArtifactBestEffort = vi.fn();

    const result = await CodeModeToolsBinding.prototype.callTool.call(fake, 'read', { location: 'r2', path: 'outputs/large-chart.png' });

    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(transform).toHaveBeenCalledWith({ width: 2000, height: 2000, fit: 'scale-down' });
    expect((result as any).text).toContain('Read R2 image object [image/png]');
    expect((result as any).text).toContain('optimized for inline model context');
    expect((result as any).text).not.toContain('displayed at');
    expect((result as any).details).toMatchObject({
      image: true,
      inlineImage: true,
      optimizedForInlineView: true,
      maxInlineDimension: 2000,
      usedImagesBinding: true,
    });
  });

  it('does not trust R2 image metadata after sniffing an unsupported image variant', async () => {
    const key = 'org1/workspace1/user-outputs/animated.png';
    const apngBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01,
      0x00, 0x00, 0x00, 0x01,
      0x08, 0x06, 0x00, 0x00, 0x00,
      0x1f, 0x15, 0xc4, 0x89,
      0x00, 0x00, 0x00, 0x08,
      0x61, 0x63, 0x54, 0x4c,
      0x00, 0x00, 0x00, 0x01,
      0x00, 0x00, 0x00, 0x00,
    ]);
    const head = {
      key,
      size: apngBytes.byteLength,
      etag: 'etag1',
      uploaded: new Date('2026-01-01T00:00:00Z'),
      httpMetadata: { contentType: 'image/png' },
      customMetadata: { type: 'code-mode-r2-file' },
    };
    const fake = Object.create(CodeModeToolsBinding.prototype) as any;
    fake.ctx = { props: { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' } };
    const images = { input: vi.fn() };
    fake.env = {
      IMAGES: images,
      R2_BUCKET: {
        head: vi.fn(async () => head),
        get: vi.fn(async () => ({
          ...head,
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(apngBytes);
              controller.close();
            },
          }),
        })),
      },
    };
    fake.recordCodeModeArtifactBestEffort = vi.fn();

    const result = await CodeModeToolsBinding.prototype.callTool.call(fake, 'read', { location: 'r2', path: 'outputs/animated.png' });

    expect(images.input).not.toHaveBeenCalled();
    expect((result as any).text).not.toContain('Read R2 image object');
    expect((result as any).details?.image).toBeUndefined();
  });

  it('truncates R2 reads by line count with an offset continuation', async () => {
    const raw = Array.from({ length: 2600 }, (_, index) => `line-${index + 1}`).join('\n');
    const key = 'org1/workspace1/chat-sessions/thread1/pi-tool-results/tmp/many-lines.txt';
    const bytes = new TextEncoder().encode(raw);
    const head = {
      key,
      size: bytes.byteLength,
      etag: 'etag1',
      uploaded: new Date('2026-01-01T00:00:00Z'),
      httpMetadata: { contentType: 'text/plain' },
      customMetadata: { type: 'pi-tool-result-text' },
    };
    const fake = Object.create(CodeModeToolsBinding.prototype) as any;
    fake.ctx = {
      props: {
        orgId: 'org1',
        workspaceId: 'workspace1',
        threadId: 'thread1',
      },
    };
    fake.env = {
      IMAGES: { input: vi.fn() },
      R2_BUCKET: {
        head: vi.fn(async () => head),
        get: vi.fn(async () => ({
          ...head,
          async text() {
            return raw;
          },
        })),
      },
    };
    fake.recordCodeModeArtifactBestEffort = vi.fn();

    const result = await CodeModeToolsBinding.prototype.callTool.call(fake, 'read', { location: 'r2', path: 'tmp/many-lines.txt' });

    expect((result as any).text).toContain('line-1');
    expect((result as any).text).toContain('line-2000');
    expect((result as any).text).not.toContain('line-2001');
    expect((result as any).text).toContain('Use offset=2001 to continue');
    expect(new TextEncoder().encode((result as any).text).byteLength).toBeLessThanOrEqual(50 * 1024);
    expect((result as any).details).toMatchObject({
      offset: 1,
      nextOffset: 2001,
      totalLines: 2600,
      truncation: {
        truncated: true,
        truncatedBy: 'lines',
        outputLines: 2000,
      },
    });
  });

  it('returns a diagnostic when the first R2 line exceeds the read byte limit', async () => {
    const raw = `${'x'.repeat(60 * 1024)}\nsecond-line`;
    const key = 'org1/workspace1/chat-sessions/thread1/pi-tool-results/tmp/one-long-line.txt';
    const bytes = new TextEncoder().encode(raw);
    const head = {
      key,
      size: bytes.byteLength,
      etag: 'etag1',
      uploaded: new Date('2026-01-01T00:00:00Z'),
      httpMetadata: { contentType: 'text/plain' },
      customMetadata: { type: 'pi-tool-result-text' },
    };
    const fake = Object.create(CodeModeToolsBinding.prototype) as any;
    fake.ctx = {
      props: {
        orgId: 'org1',
        workspaceId: 'workspace1',
        threadId: 'thread1',
      },
    };
    fake.env = {
      IMAGES: { input: vi.fn() },
      R2_BUCKET: {
        head: vi.fn(async () => head),
        get: vi.fn(async () => ({
          ...head,
          async text() {
            return raw;
          },
        })),
      },
    };
    fake.recordCodeModeArtifactBestEffort = vi.fn();

    const result = await CodeModeToolsBinding.prototype.callTool.call(fake, 'read', { location: 'r2', path: 'tmp/one-long-line.txt' });

    expect((result as any).text).toContain('exceeds 50176 byte read budget');
    expect((result as any).text).toContain('tmp/one-long-line.txt');
    expect((result as any).text).not.toContain('second-line');
    expect((result as any).details.truncation).toMatchObject({
      truncated: true,
      truncatedBy: 'bytes',
      firstLineExceedsLimit: true,
    });
  });

  it('validates R2 edits against the original content before writing', async () => {
    const key = 'org1/workspace1/user-outputs/edit.txt';
    const head = {
      key,
      size: 5,
      etag: 'etag1',
      uploaded: new Date('2026-01-01T00:00:00Z'),
      httpMetadata: { contentType: 'text/plain' },
      customMetadata: { type: 'code-mode-r2-file' },
    };
    const put = vi.fn();
    const fake = Object.create(CodeModeToolsBinding.prototype) as any;
    fake.ctx = { props: { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' } };
    fake.env = {
      R2_BUCKET: {
        head: vi.fn(async () => head),
        get: vi.fn(async () => ({
          ...head,
          text: async () => 'abcde',
        })),
        put,
      },
    };
    fake.recordCodeModeArtifactBestEffort = vi.fn();

    await expect(CodeModeToolsBinding.prototype.callTool.call(fake, 'edit', {
      location: 'r2',
      path: 'outputs/edit.txt',
      edits: [
        { oldText: 'a', newText: 'x' },
        { oldText: 'x', newText: 'y' },
      ],
    })).rejects.toThrow('edits[1].oldText not found in outputs/edit.txt');

    expect(put).not.toHaveBeenCalled();
  });

  it('writes and deletes R2 output files but keeps uploads read-only', async () => {
    const put = vi.fn(async (key: string, value: string, options: any) => ({
      key,
      size: new TextEncoder().encode(value).byteLength,
      etag: 'etag1',
      uploaded: new Date('2026-01-01T00:00:00Z'),
      httpMetadata: options.httpMetadata,
      customMetadata: options.customMetadata,
    }));
    const del = vi.fn(async () => undefined);
    const fake = Object.create(CodeModeToolsBinding.prototype) as any;
    fake.ctx = {
      props: {
        orgId: 'org1',
        workspaceId: 'workspace1',
        threadId: 'thread1',
      },
    };
    fake.env = {
      R2_BUCKET: {
        put,
        delete: del,
      },
    };
    fake.recordCodeModeArtifactBestEffort = vi.fn();

    const write = await CodeModeToolsBinding.prototype.callTool.call(fake, 'write', {
      location: 'r2',
      path: 'outputs/reports/result.txt',
      content: 'hello',
    });

    expect(put).toHaveBeenCalledWith(
      'org1/workspace1/user-outputs/reports/result.txt',
      'hello',
      expect.objectContaining({
        httpMetadata: { contentType: 'text/plain; charset=utf-8' },
      }),
    );
    expect((write as any).details).toMatchObject({
      location: 'r2',
      path: 'outputs/reports/result.txt',
      namespace: 'outputs',
      publicUrl: '/api/workspaces/workspace1/outputs/reports/result.txt',
      bytesWritten: 5,
    });

    await CodeModeToolsBinding.prototype.callTool.call(fake, 'delete', {
      location: 'r2',
      path: 'outputs/reports/result.txt',
    });
    expect(del).toHaveBeenCalledWith('org1/workspace1/user-outputs/reports/result.txt');
  });

  it('records outbound js_exec artifacts on the parent tool call without exposing metadata to model sanitization', async () => {
    const artifacts: unknown[] = [];
    const chatThreadStub = {
      recordCodeModeArtifact: vi.fn(async (_parentToolUseId: string, artifact: unknown) => {
        artifacts.push(artifact);
      }),
    };
    const fake = Object.create(CodeModeToolsBinding.prototype) as any;
    fake.ctx = {
      props: {
        orgId: 'org1',
        workspaceId: 'workspace1',
        threadId: 'thread1',
        userId: 'user1',
        parentToolUseId: 'tool_js_exec_1',
      },
    };
    Object.defineProperty(fake, 'chatThreadStub', { value: chatThreadStub });
    fake.sendEmail = vi.fn(async () => ({
      content: [{ type: 'text', text: 'Email sent.' }],
      details: {
        status: 'sent',
        channel: 'email',
        provider: 'cloudflare_email',
        messageId: 'email_1',
        attachmentCount: 0,
      },
    }));

    await CodeModeToolsBinding.prototype.callTool.call(fake, 'send_email', {
      to: 'alice@example.com',
      subject: 'Done',
      text: 'Finished.',
    });

    expect(chatThreadStub.recordCodeModeArtifact).toHaveBeenCalledWith(
      'tool_js_exec_1',
      expect.objectContaining({
        kind: 'outbound_email',
        toolName: 'send_email',
        status: 'sent',
        title: 'Email sent',
        summary: expect.objectContaining({
          to: 'alice@example.com',
          toDomain: 'example.com',
          subject: 'Done',
          hasText: true,
        }),
        result: expect.objectContaining({ messageId: 'email_1' }),
      }),
    );

    const messageWithUiMetadata = {
      role: 'toolResult',
      toolCallId: 'tool_js_exec_1',
      toolName: 'js_exec',
      content: 'ok',
      uiMetadata: { codeModeArtifacts: artifacts },
    } as any;
    expect(stripPiUiMetadata(messageWithUiMetadata)).not.toHaveProperty('uiMetadata');
  });

  it('does not fail a completed outbound tool when artifact recording fails', async () => {
    const recordError = new Error('temporary KV failure');
    const chatThreadStub = {
      recordCodeModeArtifact: vi.fn(async () => {
        throw recordError;
      }),
    };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fake = Object.create(CodeModeToolsBinding.prototype) as any;
    fake.ctx = {
      props: {
        orgId: 'org1',
        workspaceId: 'workspace1',
        threadId: 'thread1',
        userId: 'user1',
        parentToolUseId: 'tool_js_exec_1',
      },
    };
    Object.defineProperty(fake, 'chatThreadStub', { value: chatThreadStub });
    fake.sendEmail = vi.fn(async () => ({
      content: [{ type: 'text', text: 'Email sent.' }],
      details: {
        status: 'sent',
        channel: 'email',
        messageId: 'email_1',
      },
    }));

    try {
      const result = await CodeModeToolsBinding.prototype.callTool.call(fake, 'send_email', {
        to: 'alice@example.com',
        subject: 'Done',
        text: 'Finished.',
      });

      expect(result).toMatchObject({
        details: {
          status: 'sent',
          messageId: 'email_1',
        },
      });
      expect(fake.sendEmail).toHaveBeenCalledTimes(1);
      expect(chatThreadStub.recordCodeModeArtifact).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalledWith(
        'Failed to record code mode artifact',
        expect.objectContaining({
          toolName: 'send_email',
          threadId: 'thread1',
          parentToolUseId: 'tool_js_exec_1',
          error: 'temporary KV failure',
        }),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it('projects persisted js_exec UI artifacts into parsed tool result blocks', () => {
    const artifact = {
      id: 'artifact_1',
      kind: 'outbound_slack_message',
      toolName: 'send_slack_message',
      status: 'sent',
      title: 'Slack message sent',
      createdAt: 1,
      updatedAt: 2,
      summary: { channelId: 'C123' },
    };
    const messages: any[] = [{
      id: 'assistant_1',
      thread_id: 'thread1',
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tool_js_exec_1', name: 'js_exec', input: {} }],
      created_at: 1,
      forkEntryId: 'assistant_1',
    }];
    attachPiToolResultToParsedMessages(messages, {
      role: 'toolResult',
      toolCallId: 'tool_js_exec_1',
      toolName: 'js_exec',
      content: 'ok',
      isError: true,
      uiMetadata: { codeModeArtifacts: [artifact] },
    });

    expect(messages[0].content[1]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'tool_js_exec_1',
      is_error: true,
      status: 'failed',
      artifacts: [artifact],
    });
  });

  it('does not advertise outbound channel sends in ordinary chat prompts', () => {
    const context = {
      orgId: 'org1',
      workspaceId: 'workspace1',
      threadId: 'thread1',
      userId: 'user1',
      userName: null,
      userEmail: null,
    };
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.ctx = {
      exports: {
        CodeModeToolsBinding: vi.fn(() => ({
          callTool: vi.fn(),
        })),
      },
    };

    const prompt = ChatThreadDO.prototype['createPiSystemPrompt'].call(fake, context);
    expect(prompt).toContain('answer in chat only');
    expect(prompt).toContain('set_preview({ location: "workspace", path: "/notes.md" })');
    expect(prompt).toContain('set_preview({ location: "r2", path: "outputs/report.html" })');
    expect(prompt).not.toContain('tools.send_email');
    expect(prompt).not.toContain('tools.send_slack_message');
    expect(prompt).not.toContain('tools.send_telegram_message');

    const piTools = ChatThreadDO.prototype['createPiToolDefinitions'].call(fake, context);
    const jsExec = piTools.find((tool: any) => tool.name === 'js_exec');
    expect(jsExec?.description).toContain('explicitly asks for external delivery');
    expect(jsExec?.description).not.toContain('tools.send_email');
    expect(jsExec?.description).not.toContain('tools.send_slack_message');
    expect(jsExec?.description).not.toContain('tools.send_telegram_message');
  });

  it('sends email from any workspace context', async () => {
    const sendEmailMock = vi.fn(async () => ({ messageId: 'email_1' }));
    const kvPutMock = vi.fn(async () => undefined);
    const recordThreadChannelUsed = vi.fn(async () => null);

    const fake = Object.create(ChannelTools.prototype) as any;
    fake.env = {
      EMAIL: { send: sendEmailMock },
      WORKSPACE_EMAIL_DOMAIN: 'camelai.dev',
      APP_KV: { get: vi.fn(async () => null), put: kvPutMock },
      ORG: createChannelOrgNamespace({ recordThreadChannelUsed }),
      WORKSPACE: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({
          getInfo: vi.fn(async () => ({
            id: 'workspace1',
            name: 'Test Workspace',
            email_handle: 'workspace-agent',
          })),
        })),
      },
    };
    const result = await ChannelTools.prototype['sendChannelEmailTool'].call(
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
      from: 'Camel <workspace-agent@camelai.dev>',
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
    expect(kvPutMock).toHaveBeenCalledWith(
      'email_thread_refs:workspace1:thread1',
      JSON.stringify(['email_1']),
      { expirationTtl: 180 * 24 * 60 * 60 },
    );
    expect(recordThreadChannelUsed).toHaveBeenCalledWith('thread1', 'email');
  });

  it('sends channel email replies with RFC thread headers and extends reference chain', async () => {
    const sendEmailMock = vi.fn(async () => ({ messageId: 'camel-reply@example.com' }));
    const kvGetMock = vi.fn(async (key: string) =>
      key === 'email_thread_refs:workspace1:thread1'
        ? JSON.stringify(['first-user@example.com', 'latest-user@example.com'])
        : null
    );
    const kvPutMock = vi.fn(async () => undefined);
    const recordThreadChannelUsed = vi.fn(async () => null);
    const thread = {
      id: 'thread1',
      workspace_id: 'workspace1',
      source: 'channel',
      channel_kind: 'email',
      channel_connection_id: 'workspace-agent@camelai.dev',
      channel_conversation_id: 'message:first-user@example.com',
      channel_message_id: 'first-user@example.com',
    };

    const fake = Object.create(ChannelTools.prototype) as any;
    fake.env = {
      EMAIL: { send: sendEmailMock },
      WORKSPACE_EMAIL_DOMAIN: 'camelai.dev',
      APP_KV: { get: kvGetMock, put: kvPutMock },
      ORG: createChannelOrgNamespace({ thread, recordThreadChannelUsed }),
      WORKSPACE: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({
          getInfo: vi.fn(async () => ({
            id: 'workspace1',
            name: 'Test Workspace',
            email_handle: 'workspace-agent',
          })),
        })),
      },
    };

    await ChannelTools.prototype['sendChannelEmailTool'].call(
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
        to: 'sender@example.com',
        subject: 'Re: Need help',
        text: 'Here is the answer.',
      },
    );

    expect(sendEmailMock).toHaveBeenCalledWith({
      from: 'Camel <workspace-agent@camelai.dev>',
      to: 'sender@example.com',
      subject: 'Re: Need help',
      text: 'Here is the answer.',
      replyTo: 'workspace-agent@camelai.dev',
      headers: {
        'In-Reply-To': '<latest-user@example.com>',
        References: '<first-user@example.com> <latest-user@example.com>',
      },
    });
    expect(kvPutMock).toHaveBeenCalledWith(
      'email_reply_ref:workspace1:camel-reply@example.com',
      'thread1',
      { expirationTtl: 180 * 24 * 60 * 60 },
    );
    expect(kvPutMock).toHaveBeenCalledWith(
      'email_thread_refs:workspace1:thread1',
      JSON.stringify([
        'first-user@example.com',
        'latest-user@example.com',
        'camel-reply@example.com',
      ]),
      { expirationTtl: 180 * 24 * 60 * 60 },
    );
  });

  it('sends RFC thread headers for outbound-originated email conversations with stored refs', async () => {
    const sendEmailMock = vi.fn(async () => ({ messageId: 'second-camel-reply@example.com' }));
    const kvGetMock = vi.fn(async (key: string) =>
      key === 'email_thread_refs:workspace1:thread1'
        ? JSON.stringify(['first-camel-email@example.com', 'recipient-reply@example.com'])
        : null
    );
    const kvPutMock = vi.fn(async () => undefined);
    const recordThreadChannelUsed = vi.fn(async () => null);
    const thread = {
      id: 'thread1',
      workspace_id: 'workspace1',
      source: 'web',
      channel_kind: null,
      channel_connection_id: null,
      channel_conversation_id: null,
      channel_message_id: null,
    };

    const fake = Object.create(ChannelTools.prototype) as any;
    fake.env = {
      EMAIL: { send: sendEmailMock },
      WORKSPACE_EMAIL_DOMAIN: 'camelai.dev',
      APP_KV: { get: kvGetMock, put: kvPutMock },
      ORG: createChannelOrgNamespace({ thread, recordThreadChannelUsed }),
      WORKSPACE: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({
          getInfo: vi.fn(async () => ({
            id: 'workspace1',
            name: 'Test Workspace',
            email_handle: 'workspace-agent',
          })),
        })),
      },
    };

    await ChannelTools.prototype['sendChannelEmailTool'].call(
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
        to: 'sender@example.com',
        subject: 'Re: Need help',
        text: 'Here is the follow-up.',
      },
    );

    expect(sendEmailMock).toHaveBeenCalledWith({
      from: 'Camel <workspace-agent@camelai.dev>',
      to: 'sender@example.com',
      subject: 'Re: Need help',
      text: 'Here is the follow-up.',
      headers: {
        'In-Reply-To': '<recipient-reply@example.com>',
        References: '<first-camel-email@example.com> <recipient-reply@example.com>',
      },
    });
    expect(kvPutMock).toHaveBeenCalledWith(
      'email_thread_refs:workspace1:thread1',
      JSON.stringify([
        'first-camel-email@example.com',
        'recipient-reply@example.com',
        'second-camel-reply@example.com',
      ]),
      { expirationTtl: 180 * 24 * 60 * 60 },
    );
  });

  it('reports email sent when post-send metadata persistence fails', async () => {
    const sendEmailMock = vi.fn(async () => ({ messageId: 'sent-before-kv-failed@example.com' }));
    const kvPutMock = vi.fn(async () => {
      throw new Error('KV unavailable');
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const recordThreadChannelUsed = vi.fn(async () => null);
    const thread = {
      id: 'thread1',
      workspace_id: 'workspace1',
      source: 'web',
      channel_kind: null,
      channel_connection_id: null,
      channel_conversation_id: null,
      channel_message_id: null,
    };

    const fake = Object.create(ChannelTools.prototype) as any;
    fake.env = {
      EMAIL: { send: sendEmailMock },
      WORKSPACE_EMAIL_DOMAIN: 'camelai.dev',
      APP_KV: { get: vi.fn(async () => null), put: kvPutMock },
      ORG: createChannelOrgNamespace({ thread, recordThreadChannelUsed }),
      WORKSPACE: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({
          getInfo: vi.fn(async () => ({
            id: 'workspace1',
            name: 'Test Workspace',
            email_handle: 'workspace-agent',
          })),
        })),
      },
    };

    try {
      const result = await ChannelTools.prototype['sendChannelEmailTool'].call(
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
          to: 'sender@example.com',
          subject: 'Status',
          text: 'Here is the update.',
        },
      );

      expect(result.details).toMatchObject({
        status: 'sent',
        messageId: 'sent-before-kv-failed@example.com',
      });
      expect(sendEmailMock).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalledWith(
        '[send_email] failed to persist email thread metadata',
        expect.objectContaining({
          workspaceId: 'workspace1',
          threadId: 'thread1',
          messageId: 'sent-before-kv-failed@example.com',
          error: 'KV unavailable',
        }),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it('sends email without RFC thread headers when pre-send metadata read fails', async () => {
    const sendEmailMock = vi.fn(async () => ({ messageId: 'sent-without-refs@example.com' }));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const recordThreadChannelUsed = vi.fn(async () => null);
    const thread = {
      id: 'thread1',
      workspace_id: 'workspace1',
      source: 'web',
      channel_kind: null,
      channel_connection_id: null,
      channel_conversation_id: null,
      channel_message_id: null,
    };

    const fake = Object.create(ChannelTools.prototype) as any;
    fake.env = {
      EMAIL: { send: sendEmailMock },
      WORKSPACE_EMAIL_DOMAIN: 'camelai.dev',
      APP_KV: {
        get: vi.fn(async () => {
          throw new Error('KV read unavailable');
        }),
        put: vi.fn(async () => undefined),
      },
      ORG: createChannelOrgNamespace({ thread, recordThreadChannelUsed }),
      WORKSPACE: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({
          getInfo: vi.fn(async () => ({
            id: 'workspace1',
            name: 'Test Workspace',
            email_handle: 'workspace-agent',
          })),
        })),
      },
    };

    try {
      const result = await ChannelTools.prototype['sendChannelEmailTool'].call(
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
          to: 'sender@example.com',
          subject: 'Status',
          text: 'Here is the update.',
        },
      );

      expect(result.details).toMatchObject({
        status: 'sent',
        messageId: 'sent-without-refs@example.com',
      });
      expect(sendEmailMock.mock.calls[0]?.[0]).not.toHaveProperty('headers');
      expect(consoleError).toHaveBeenCalledWith(
        '[send_email] failed to read email thread metadata',
        expect.objectContaining({
          workspaceId: 'workspace1',
          threadId: 'thread1',
          error: 'KV read unavailable',
        }),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it('does not use non-email channel message ids as email reply headers', async () => {
    const sendEmailMock = vi.fn(async () => ({ messageId: 'camel-email@example.com' }));
    const kvPutMock = vi.fn(async () => undefined);
    const recordThreadChannelUsed = vi.fn(async () => null);
    const thread = {
      id: 'thread1',
      workspace_id: 'workspace1',
      source: 'channel',
      channel_kind: 'slack',
      channel_connection_id: 'slack-install-1',
      channel_conversation_id: 'T1:C1:1700000000.000100',
      channel_message_id: '1700000000.000100',
    };

    const fake = Object.create(ChannelTools.prototype) as any;
    fake.env = {
      EMAIL: { send: sendEmailMock },
      WORKSPACE_EMAIL_DOMAIN: 'camelai.dev',
      APP_KV: { get: vi.fn(async () => null), put: kvPutMock },
      ORG: createChannelOrgNamespace({ thread, recordThreadChannelUsed }),
      WORKSPACE: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({
          getInfo: vi.fn(async () => ({
            id: 'workspace1',
            name: 'Test Workspace',
            email_handle: 'workspace-agent',
          })),
        })),
      },
    };

    await ChannelTools.prototype['sendChannelEmailTool'].call(
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
        to: 'sender@example.com',
        subject: 'Status',
        text: 'Here is the update.',
      },
    );

    expect(sendEmailMock.mock.calls[0]?.[0]).not.toHaveProperty('headers');
    expect(kvPutMock).toHaveBeenCalledWith(
      'email_thread_refs:workspace1:thread1',
      JSON.stringify(['camel-email@example.com']),
      { expirationTtl: 180 * 24 * 60 * 60 },
    );
  });

  it('does not send RFC reply headers when an email thread lacks a real message id', async () => {
    const sendEmailMock = vi.fn(async () => ({ messageId: 'camel-reply@example.com' }));
    const kvPutMock = vi.fn(async () => undefined);
    const recordThreadChannelUsed = vi.fn(async () => null);
    const thread = {
      id: 'thread1',
      workspace_id: 'workspace1',
      source: 'channel',
      channel_kind: 'email',
      channel_connection_id: 'workspace-agent@camelai.dev',
      channel_conversation_id: 'message:8ad1518c-43e7-4b52-a4f2-80ee74d5b9f8',
      channel_message_id: null,
    };

    const fake = Object.create(ChannelTools.prototype) as any;
    fake.env = {
      EMAIL: { send: sendEmailMock },
      WORKSPACE_EMAIL_DOMAIN: 'camelai.dev',
      APP_KV: { get: vi.fn(async () => null), put: kvPutMock },
      ORG: createChannelOrgNamespace({ thread, recordThreadChannelUsed }),
      WORKSPACE: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({
          getInfo: vi.fn(async () => ({
            id: 'workspace1',
            name: 'Test Workspace',
            email_handle: 'workspace-agent',
          })),
        })),
      },
    };

    await ChannelTools.prototype['sendChannelEmailTool'].call(
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
        to: 'sender@example.com',
        subject: 'Re: Need help',
        text: 'Here is the answer.',
      },
    );

    expect(sendEmailMock.mock.calls[0]?.[0]).not.toHaveProperty('headers');
    expect(kvPutMock).toHaveBeenCalledWith(
      'email_thread_refs:workspace1:thread1',
      JSON.stringify(['camel-reply@example.com']),
      { expirationTtl: 180 * 24 * 60 * 60 },
    );
  });

  it('rejects channel email sends for Pay as you go orgs', async () => {
    const sendEmailMock = vi.fn(async () => ({ messageId: 'email_1' }));
    const fake = Object.create(ChannelTools.prototype) as any;
    fake.env = {
      EMAIL: { send: sendEmailMock },
      ORG: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({
          getInfo: vi.fn(async () => ({
            billing_plan: 'payg',
            billing_status: 'active',
          })),
        })),
      },
    };

    await expect(
      ChannelTools.prototype['sendChannelEmailTool'].call(
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
      ),
    ).rejects.toThrow(
      'Workspace email inbox requires a Starter, Pro, Team, or Enterprise plan.',
    );
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('sends Telegram from a workspace-scoped code mode tool binding without thread scope', async () => {
    const appendChannelHistoryEvent = vi.fn(async () => ({ status: 'appended' }));
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toMatch(/\/sendMessage$/);
      const payload = JSON.parse(String(init?.body));
      expect(payload).toMatchObject({ chat_id: '12345', text: 'Hello from workflow' });
      return Response.json({ ok: true, result: { message_id: 29 } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const fake = Object.create(CodeModeToolsBinding.prototype) as any;
    fake.ctx = {
      props: {
        orgId: 'org1',
        workspaceId: 'workspace1',
        userId: 'user1',
      },
    };
    fake.env = {
      TELEGRAM_BOT_TOKEN: 'bot-token',
      R2_BUCKET: { get: vi.fn() },
      WORKSPACE: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({
          getIntegration: vi.fn(async () => ({
            id: 'telegram-int',
            integration_type: 'telegram',
            name: 'Product Telegram',
            config: JSON.stringify({
              chat_id: '12345',
              chat_title: 'Product team',
            }),
          })),
        })),
      },
      APP_KV: {
        get: vi.fn(async (key: string) =>
          key === 'channel_thread:telegram:workspace1:telegram-int:12345'
            ? 'telegram-thread'
            : null
        ),
        put: vi.fn(async () => undefined),
        delete: vi.fn(async () => undefined),
      },
      ORG: createChannelOrgNamespace({
        thread: { id: 'telegram-thread', title: 'Product team' },
        integration: {
          id: 'telegram-int',
          integration_type: 'telegram',
          name: 'Product Telegram',
          config: JSON.stringify({
            chat_id: '12345',
            chat_title: 'Product team',
          }),
        },
      }),
      CHAT_THREAD: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({ appendChannelHistoryEvent })),
      },
    };

    const result = await CodeModeToolsBinding.prototype.callTool.call(
      fake,
      'send_telegram_message',
      {
        integration_id: 'telegram-int',
        text: 'Hello from workflow',
      },
    );

    expect(result.details).toMatchObject({
      status: 'sent',
      channel: 'telegram',
      chatId: '12345',
      integrationId: 'telegram-int',
      messageIds: [29],
      channelHistoryStatus: 'recorded',
    });
    expect(appendChannelHistoryEvent).toHaveBeenCalledWith(expect.objectContaining({
      sourceThreadId: '',
      threadId: 'telegram-thread',
    }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
      location: 'workspace',
      path: '/opt/chiridion-host-pi/skills/data-analysis/SKILL.md',
    });
    expect((skill as any).text).toContain('name: data-analysis');
    expect((skill as any).details.source).toBe('bundled_skill');

    const listing = await CodeModeToolsBinding.prototype.callTool.call(fake, 'ls', {
      location: 'workspace',
      path: '/opt/chiridion-host-pi/skills',
    });
    expect((listing as any).text).toContain('data-analysis');
    expect((listing as any).details.source).toBe('bundled_skill');
    expect(containerTool).not.toHaveBeenCalled();
  });

  it('builds a DO-backed project through the project build action', async () => {
    const { fake, sandbox, workspaceStub, projectStub } = createProjectToolFake();

    const result = await CodeModeToolsBinding.prototype.callTool.call(fake, 'build_project', {
      project: 'Demo App',
      timeoutMs: 5000,
    });

    expect(result).toMatchObject({
      success: true,
      project: 'Demo App',
      backend: 'do-r2',
      projectId: 'project-1',
      fileCount: 2,
      stdout: 'built',
    });
    expect(workspaceStub.getProjectByName).toHaveBeenCalledWith('Demo App');
    expect(projectStub.projectListFiles).toHaveBeenCalledWith('/', { recursive: true, includeHidden: true, limit: 50000 });
    expect(sandbox.exec).toHaveBeenCalledWith('bun install && bun run build', expect.objectContaining({
      cwd: '/workspace/project-1',
      env: expect.objectContaining({ CAMELAI_PROJECT_ID: 'project-1', CAMELAI_BUILD_TIMEOUT_MS: '5000' }),
    }));
  });

  it('rejects DO-only project actions for legacy VM-backed projects', async () => {
    const { fake, sandbox, projectStub } = createProjectToolFake({ backend: 'vm' });

    await expect(CodeModeToolsBinding.prototype.callTool.call(fake, 'build_project', {
      project: 'Demo App',
    })).rejects.toThrow('build_project only supports DO-backed projects');
    await expect(CodeModeToolsBinding.prototype.callTool.call(fake, 'deploy_project', {
      project: 'Demo App',
    })).rejects.toThrow('deploy_project only supports DO-backed projects');
    await expect(CodeModeToolsBinding.prototype.callTool.call(fake, 'add_dependency', {
      project: 'Demo App',
      dependency: 'zod',
    })).rejects.toThrow('add_dependency only supports DO-backed projects');
    await expect(CodeModeToolsBinding.prototype.callTool.call(fake, 'list_commits', {
      project: 'Demo App',
    })).rejects.toThrow('list_commits only supports DO-backed projects');
    await expect(CodeModeToolsBinding.prototype.callTool.call(fake, 'revert_project', {
      project: 'Demo App',
      snapshot_id: 'a'.repeat(64),
    })).rejects.toThrow('revert_project only supports DO-backed projects');

    expect(sandbox.exec).not.toHaveBeenCalled();
    expect(projectStub.projectListFiles).not.toHaveBeenCalled();
    expect(projectStub.projectWriteFile).not.toHaveBeenCalled();
    expect(projectStub.projectRestoreSourceSnapshot).not.toHaveBeenCalled();
  });

  it('creates new code-mode projects as DO-backed projects', async () => {
    const { fake, workspaceStub, projectStub } = createProjectToolFake({ projectFileEntries: [] });

    const result = await CodeModeToolsBinding.prototype.callTool.call(fake, 'create_project', {
      name: 'New App',
      description: 'A new app',
    });

    expect(workspaceStub.createProject).toHaveBeenCalledWith({
      name: 'New App',
      description: 'A new app',
      backend: 'do-r2',
      workspaceId: 'workspace1',
    });
    expect(result).toMatchObject({
      name: 'New App',
      description: 'A new app',
      backend: 'do-r2',
      scaffold: {
        template: 'worker',
        filesSkipped: [],
      },
    });
    expect((result as any).scaffold.filesWritten).toEqual(expect.arrayContaining([
      '/package.json',
      '/wrangler.jsonc',
      '/tsconfig.json',
      '/src/index.ts',
      '/scripts/write-build-manifest.mjs',
    ]));
    const packageWrite = projectStub.projectWriteFile.mock.calls.find(([path]) => path === '/package.json');
    expect(packageWrite).toBeTruthy();
    const packageJson = JSON.parse(packageWrite?.[1] ?? '{}');
    expect(packageJson.scripts.build).toContain('tsc --noEmit');
    expect(packageJson.scripts.build).toContain('build/server/index.js');
    expect(packageJson.devDependencies).toMatchObject({
      typescript: expect.any(String),
      wrangler: expect.any(String),
      '@cloudflare/workers-types': expect.any(String),
    });
  });

  it('scaffolds existing DO-backed projects without overwriting unless forced', async () => {
    const { fake, projectStub } = createProjectToolFake();

    const result = await CodeModeToolsBinding.prototype.callTool.call(fake, 'scaffold_project', {
      project: 'Demo App',
    });

    expect(result).toMatchObject({
      success: true,
      project: 'Demo App',
      backend: 'do-r2',
      template: 'worker',
      filesSkipped: expect.arrayContaining(['/package.json', '/src/index.ts']),
    });
    expect(projectStub.projectWriteFile).toHaveBeenCalledWith('/wrangler.jsonc', expect.stringContaining('"main": "src/index.ts"'));

    await CodeModeToolsBinding.prototype.callTool.call(fake, 'scaffold_project', {
      project: 'Demo App',
      force: true,
    });
    expect(projectStub.projectWriteFile).toHaveBeenCalledWith('/package.json', expect.stringContaining('"build"'));
  });

  it('adds a dependency to a DO-backed project through the dependency action', async () => {
    const { fake, sandbox, projectStub } = createProjectToolFake();

    const result = await CodeModeToolsBinding.prototype.callTool.call(fake, 'add_dependency', {
      project: 'Demo App',
      dependency: 'zod@^4',
      dev: true,
    });

    expect(result).toMatchObject({
      success: true,
      project: 'Demo App',
      backend: 'do-r2',
      projectId: 'project-1',
      dependency: 'zod@^4',
      dev: true,
      stdout: 'added zod',
      packageJsonPersisted: true,
      lockfilePersisted: true,
    });
    expect(sandbox.exec).toHaveBeenCalledWith("bun add -d 'zod@^4'", expect.objectContaining({
      cwd: '/workspace/project-1',
      env: expect.objectContaining({ CAMELAI_PROJECT_ID: 'project-1' }),
    }));
    expect(projectStub.projectWriteFile).toHaveBeenCalledWith('/package.json', expect.stringContaining('devDependencies'));
    expect(projectStub.projectWriteFile).toHaveBeenCalledWith('/bun.lock', '# zod lockfile\n');
  });

  it('rejects legacy VM shell and file tools for DO-backed projects', async () => {
    const { fake, workspaceStub } = createProjectToolFake();
    const projectVm = {
      exec: vi.fn(),
      read: vi.fn(),
    };
    Object.defineProperty(fake, 'projectVm', { value: projectVm });

    await expect(CodeModeToolsBinding.prototype.callTool.call(fake, 'bash', {
      project: 'Demo App',
      command: 'bun install',
    })).rejects.toThrow('DO-backed and cannot use legacy VM shell command');
    await expect(CodeModeToolsBinding.prototype.callTool.call(fake, 'read', {
      location: 'vm',
      project: 'Demo App',
      path: '/workspace/package.json',
    })).rejects.toThrow('Use location: "project" file tools');

    expect(workspaceStub.getProjectByName).toHaveBeenCalledWith('Demo App');
    expect(projectVm.exec).not.toHaveBeenCalled();
    expect(projectVm.read).not.toHaveBeenCalled();
  });

  it('rejects legacy VM preview, move, and clone for DO-backed projects', async () => {
    const { fake } = createProjectToolFake();
    const projectVm = {
      assertFileReadable: vi.fn(),
      writeFileBytesForTransfer: vi.fn(),
      cloneProject: vi.fn(),
    };
    Object.defineProperty(fake, 'projectVm', { value: projectVm });
    Object.defineProperty(fake, 'chatThreadStub', { value: { setPreviewTarget: vi.fn() } });
    fake.env = { ...fake.env, R2_BUCKET: { get: vi.fn(async () => r2Object('hello', 'text/plain')), head: vi.fn(async () => ({ size: 5 })) } };

    await expect((CodeModeToolsBinding.prototype as any).setPreview.call(fake, {
      location: 'vm',
      project: 'Demo App',
      path: 'index.html',
    })).rejects.toThrow('DO-backed and cannot use legacy VM file preview');
    await expect((CodeModeToolsBinding.prototype as any).moveFile.call(fake, {
      source: { location: 'r2', path: 'outputs/report.txt' },
      destination: { location: 'vm', project: 'Demo App', path: '/workspace/report.txt' },
    })).rejects.toThrow('DO-backed and cannot use legacy VM file transfer');
    await expect(CodeModeToolsBinding.prototype.callTool.call(fake, 'clone_project', {
      sourceProject: 'Demo App',
      name: 'Copy',
    })).rejects.toThrow('DO-backed and cannot use legacy VM clone');

    expect(projectVm.assertFileReadable).not.toHaveBeenCalled();
    expect(projectVm.writeFileBytesForTransfer).not.toHaveBeenCalled();
    expect(projectVm.cloneProject).not.toHaveBeenCalled();
  });

  it('restores a DO-backed project from a source snapshot', async () => {
    const { fake, projectStub } = createProjectToolFake();

    const result = await CodeModeToolsBinding.prototype.callTool.call(fake, 'revert_project', {
      project: 'Demo App',
      snapshot_id: 'a'.repeat(64),
    });

    expect(projectStub.projectRestoreSourceSnapshot).toHaveBeenCalledWith('a'.repeat(64));
    expect(result).toMatchObject({
      success: true,
      project: 'Demo App',
      backend: 'do-r2',
      restored: {
        id: 'a'.repeat(64),
        fileCount: 2,
        totalBytes: 96,
      },
    });
  });

  it('lists project source snapshots through the list_commits action', async () => {
    const { fake, projectStub } = createProjectToolFake();

    const result = await CodeModeToolsBinding.prototype.callTool.call(fake, 'list_commits', {
      project: 'Demo App',
      limit: 5,
    });

    expect(projectStub.projectListSourceSnapshots).toHaveBeenCalledWith(5);
    expect(result).toMatchObject({
      project: 'Demo App',
      backend: 'do-r2',
      count: 1,
      commits: [{
        sha: 'snapshot-1',
        message: 'Deploy Demo App',
        file_count: 2,
        total_bytes: 96,
      }],
    });
  });

  it('deletes DO-backed projects without invoking VM cleanup', async () => {
    const { fake, workspaceStub, projectStub } = createProjectToolFake();
    const projectVm = {
      deleteProject: vi.fn(),
    };
    const askUserQuestion = vi.fn(async ({ questions }: any) => ({
      [questions[0].question]: 'Delete',
    }));
    Object.defineProperty(fake, 'projectVm', { value: projectVm });
    fake.askUserQuestion = askUserQuestion;

    const result = await CodeModeToolsBinding.prototype.callTool.call(fake, 'delete_project', {
      project: 'Demo App',
    });

    expect(result).toMatchObject({
      success: true,
      deleted: ['Demo App'],
      deleted_file_entries: 2,
      message: 'Deleted project "Demo App"',
    });
    expect(askUserQuestion).toHaveBeenCalledWith({
      questions: [expect.objectContaining({
        question: expect.stringContaining('project files and metadata'),
        header: 'Delete project?',
      })],
    });
    expect(projectStub.projectDeleteFile).toHaveBeenCalledWith('/package.json', { recursive: true, force: true });
    expect(projectStub.projectDeleteFile).toHaveBeenCalledWith('/src/index.ts', { recursive: true, force: true });
    expect(workspaceStub.removeProjects).toHaveBeenCalledWith(['project-1']);
    expect(projectVm.deleteProject).not.toHaveBeenCalled();
  });

  it('includes deploy artifact metadata in list_apps results', async () => {
    const fake = Object.create(CodeModeToolsBinding.prototype) as any;
    fake.ctx = { props: { workspaceId: 'workspace1' } };
    fake.env = { WORKER_BASE_URL: 'https://staging.camelai.dev', LOCAL_APP_VANITY_DOMAIN: 'camelai.app' };
    Object.defineProperty(fake, 'orgStub', {
      value: {
        getInfo: vi.fn(async () => ({ slug: 'test-org' })),
        listWorkerScriptsByWorkspace: vi.fn(async () => [{
          script_name: 'demo-app',
          workspace_id: 'workspace1',
          created_by: 'user1',
          created_at: 10,
          updated_at: 20,
          is_public: false,
          preview_status: 'ready',
          project_id: 'project-1',
          commit_sha: 'abc123',
          artifact_cache_key: 'deploy-artifacts/key.json',
          custom_domain_hostname: null,
        }]),
      },
    });

    await expect(CodeModeToolsBinding.prototype.callTool.call(fake, 'list_apps', {})).resolves.toMatchObject({
      count: 1,
      apps: [{
        name: 'demo-app',
        project_id: 'project-1',
        commit_sha: 'abc123',
        artifact_cache_key: 'deploy-artifacts/key.json',
      }],
    });
  });

  it('lists cached deploy versions for rollback discovery', async () => {
    const fake = Object.create(CodeModeToolsBinding.prototype) as any;
    fake.ctx = { props: { workspaceId: 'workspace1' } };
    Object.defineProperty(fake, 'orgStub', {
      value: {
        getWorkerScript: vi.fn(async () => ({ script_name: 'demo-app', workspace_id: 'workspace1' })),
        listWorkerScriptDeployVersions: vi.fn(async (_scriptName: string, limit: number) => [{
          id: 'deploy-1',
          script_name: 'demo-app',
          workspace_id: 'workspace1',
          created_at: 20,
          created_by: 'user1',
          config_path: 'wrangler.jsonc',
          project_id: 'project-1',
          commit_sha: 'abc123',
          artifact_cache_key: 'deploy-artifacts/key.json',
          limit,
        }]),
      },
    });

    await expect(CodeModeToolsBinding.prototype.callTool.call(fake, 'list_deploy_versions', {
      script_name: 'demo-app',
      limit: 5,
    })).resolves.toMatchObject({
      app: 'demo-app',
      count: 1,
      versions: [{
        id: 'deploy-1',
        project_id: 'project-1',
        commit_sha: 'abc123',
        artifact_cache_key: 'deploy-artifacts/key.json',
        config_path: 'wrangler.jsonc',
      }],
    });
  });

  it('builds and directly deploys a DO-backed project through the deploy action', async () => {
    const { fake, env, orgStub } = createProjectToolFake({ deploy: true });
    const fetchMock = vi.fn(async () => Response.json({ success: true }, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await CodeModeToolsBinding.prototype.callTool.call(fake, 'deploy_project', {
      project: 'Demo App',
      script_name: 'Demo App',
    });

    expect(result).toMatchObject({
      success: true,
      project: 'Demo App',
      sourceSnapshot: { id: 'snapshot-1' },
      deploy: {
        scriptName: 'demo-app',
        dispatchScriptName: 'demo-app--test-org',
        status: 200,
      },
    });
    expect((result as any).appUrl).toContain('demo-app--test-org');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.cloudflare.com/client/v4/accounts/account/workers/dispatch/namespaces/namespace/scripts/demo-app--test-org',
      expect.objectContaining({ method: 'PUT', headers: { Authorization: 'Bearer token' } }),
    );
    expect(orgStub.registerWorkerScript).toHaveBeenCalledWith('demo-app', 'workspace1', 'user1', undefined, 'project-1', 'snapshot-1', expect.stringMatching(/^deploy-artifacts\//));
    expect(env.APP_KV.put).toHaveBeenCalledWith('script:demo-app--test-org', JSON.stringify({ org_id: 'org1', org_slug: 'test-org', is_public: false }));
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
      location: 'workspace',
      path: '/workspace/.camelai/automations',
    });
    expect((listing as any).text).toContain('automation-1.js');

    const read = await CodeModeToolsBinding.prototype.callTool.call(fake, 'read', {
      location: 'workspace',
      path: '/workspace/.camelai/automations/automation-1.js',
    });
    expect((read as any).text).toContain('AutomationWorkflow');

    const edit = await CodeModeToolsBinding.prototype.callTool.call(fake, 'edit', {
      location: 'workspace',
      path: '/workspace/.camelai/automations/automation-1.js',
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
      toolUseId: 'tool3',
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

  it('builds Wrangler deploy proxy env through the sandbox VM outbound proxy', async () => {
    const fake = Object.create(CodeModeToolsBinding.prototype) as any;
    fake.env = {
      CF_ACCOUNT_ID: 'acct_1',
      SANDBOX_PROXY_SECRET: 'sandbox-secret',
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

    const prefix = 'http://host.docker.internal:8081/v1/workspaces/org1/workspace1/thread-tokens/';
    const suffix = '/client/v4';
    expect(deployEnv.CLOUDFLARE_API_BASE_URL.startsWith(prefix)).toBe(true);
    expect(deployEnv.CLOUDFLARE_API_BASE_URL.endsWith(suffix)).toBe(true);
    const threadToken = decodeURIComponent(
      deployEnv.CLOUDFLARE_API_BASE_URL.slice(prefix.length, -suffix.length),
    );
    await expect(validateSignedToken('sandbox-secret', threadToken)).resolves.toMatchObject({
      org_id: 'org1',
      workspace_id: 'workspace1',
      thread_id: 'thread1',
      scopes: ['sandbox_thread'],
      name: 'sandbox-proxy-thread',
    });
    expect(deployEnv.CLOUDFLARE_ACCOUNT_ID).toBe('acct_1');
    expect(deployEnv.CLOUDFLARE_API_TOKEN).toBe('sandbox-outbound-proxy');
  });

  it('merges base container command env with Wrangler deploy env', async () => {
    const fake = Object.create(CodeModeToolsBinding.prototype) as any;
    fake.createWorkspaceCommandEnv = vi.fn(async () => ({
      WORKSPACE_ID: 'workspace1',
      ORG_ID: 'org1',
      WRANGLER_SEND_METRICS: 'false',
      CI: '1',
      CF_DISPATCH_NAMESPACE: 'staging',
    }));
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
      'AskUserQuestion',
      'TodoWrite',
      'set_preview',
      'list_apps',
      'get_latest_logs',
      'list_scheduled_prompts',
      'list_workflows',
      'list_integrations',
      'prompt_connection_setup',
      'get_custom_domain',
      'WebSearch',
      'WebFetch',
    ]));
    expect(toolNames).not.toContain('grep');
    expect(toolNames).not.toContain('find');
    expect(toolNames).not.toContain('list_deterministic_automations');

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
    expect((byName.get('bash') as any).parameters.properties.timeoutSeconds).toBeDefined();
    expect((byName.get('bash') as any).parameters.properties.timeout).toBeUndefined();
    expect(byName.get('grep')).toBeUndefined();
    expect(byName.get('find')).toBeUndefined();
  });

  it('routes restored search tools through workspace file operations', async () => {
    const callTool = vi.fn(async () => ({
      text: 'app.ts:1: hello',
    }));
    const fake = Object.create(CodeModeToolsBinding.prototype) as any;
    Object.defineProperty(fake, 'piContainerTools', {
      value: { callTool },
    });

    const result = await CodeModeToolsBinding.prototype.callTool.call(fake, 'grep', {
      location: 'workspace',
      pattern: 'hello',
      path: 'src',
      literal: true,
      limit: 2,
    });

    expect(result.text).toBe('app.ts:1: hello');
    expect(callTool).toHaveBeenCalledWith('grep', {
      location: 'workspace',
      pattern: 'hello',
      path: 'src',
      literal: true,
      limit: 2,
    });
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
        allowOther: true,
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

  it('normalizes AskUserQuestion multi_select type before broadcasting to the browser', async () => {
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
        id: 'multiselect-test',
        type: 'multi_select',
        question: 'Multi-select rendering test: please select all fruits you like.',
        options: [
          { label: 'Apple', value: 'apple' },
          { label: 'Banana', value: 'banana' },
          { label: 'Mango', value: 'mango' },
          { label: 'Strawberry', value: 'strawberry' },
        ],
        required: false,
      }],
    });

    expect(fake.broadcastChat).toHaveBeenCalledWith({
      type: 'ask_user_question',
      questionId: expect.any(String),
      toolUseId: 'tool-ask',
      questions: [{
        question: 'Multi-select rendering test: please select all fruits you like.',
        header: '',
        multiSelect: true,
        allowOther: true,
        options: [
          { label: 'Apple', description: '' },
          { label: 'Banana', description: '' },
          { label: 'Mango', description: '' },
          { label: 'Strawberry', description: '' },
        ],
      }],
    });

    const prompt = fake.broadcastChat.mock.calls[0][0];
    fake.browserPrompts.answerQuestion({
      questionId: prompt.questionId,
      answers: {
        'Multi-select rendering test: please select all fruits you like.':
          'Apple, Mango',
      },
    });
    await expect(promise).resolves.toEqual({
      'Multi-select rendering test: please select all fruits you like.':
        'Apple, Mango',
    });
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
      expect.arrayContaining(['Agent', 'Explore']),
    );
    expect(rootTools.map((tool: any) => tool.name)).not.toEqual(
      expect.arrayContaining(['agent', 'explore']),
    );
    expect(rootTools.find((tool: any) => tool.name === 'Agent')?.executionMode).toBe('sequential');

    const childTools = ChatThreadDO.prototype['createPiToolDefinitions'].call(fake, context, {
      includeSubagents: false,
    });
    expect(childTools.map((tool: any) => tool.name)).not.toEqual(
      expect.arrayContaining(['Agent', 'Explore']),
    );
  });

  it('runs the Pi subagent tool with child-agent context', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.ctx = {
      exports: {
        CodeModeToolsBinding: vi.fn(() => ({
          callTool: vi.fn(async () => ({ text: 'ok' })),
        })),
      },
    };
    fake.runPiSubagentTool = vi.fn(async () => ({
      content: [{ type: 'text', text: 'child done' }],
      details: { status: 'completed' },
    }));

    const context = {
      orgId: 'org1',
      workspaceId: 'workspace1',
      threadId: 'thread1',
      userId: 'user1',
    };
    const tools = ChatThreadDO.prototype['createPiToolDefinitions'].call(fake, context);
    const agent = tools.find((tool: any) => tool.name === 'Agent');
    const abortController = new AbortController();
    const onUpdate = vi.fn();

    const result = await agent.execute(
      'tool-agent-1',
      { prompt: 'inspect the workspace' },
      abortController.signal,
      onUpdate,
    );

    expect(fake.runPiSubagentTool).toHaveBeenCalledWith(
      context,
      'Agent',
      { prompt: 'inspect the workspace' },
      abortController.signal,
      onUpdate,
    );
    expect(result.content[0].text).toBe('child done');
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
      args: { command: 'echo hi', cwd: '/workspace' },
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
      cwd: '/workspace',
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
      cwd: '/workspace',
      status: 'completed',
      isError: false,
      aggregatedOutput: 'hi\n',
    });
  });

  it('marks failed Pi runtime tool completion items with isError', async () => {
    const { fake, events } = createPiEventFake();

    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
      type: 'tool_execution_start',
      toolCallId: 'tool1',
      toolName: 'bash',
      args: { command: 'bun run validate', cwd: '/workspace' },
    });
    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
      type: 'tool_execution_end',
      toolCallId: 'tool1',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: 'validation failed\n' }], details: {} },
      isError: true,
    });

    const runtimeEvents = events.filter((event) => event.type === 'runtime_event');
    const completedEvent = runtimeEvents.find(
      (event) => event.event.method === 'item/completed',
    );
    expect(completedEvent?.event.params.item).toMatchObject({
      id: 'tool1',
      type: 'commandExecution',
      command: 'bun run validate',
      status: 'failed',
      isError: true,
      aggregatedOutput: 'validation failed\n',
    });
  });

  it('marks failed Pi runtime dynamic tool completion items with isError', async () => {
    const { fake, events } = createPiEventFake();

    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
      type: 'tool_execution_end',
      toolCallId: 'tool-validate',
      toolName: 'validate_workflow',
      args: { name: 'daily-sync' },
      result: { content: [{ type: 'text', text: 'invalid workflow' }], details: {} },
      isError: true,
    });

    const completedEvent = events.find(
      (event) =>
        event.type === 'runtime_event' &&
        event.event.method === 'item/completed',
    );
    expect(completedEvent?.event.params.item).toMatchObject({
      id: 'tool-validate',
      type: 'dynamicToolCall',
      tool: 'validate_workflow',
      arguments: { name: 'daily-sync' },
      status: 'failed',
      isError: true,
      result: { content: [{ type: 'text', text: 'invalid workflow' }] },
    });
  });

  it('publishes live Pi running activity for thinking, text, and tools', async () => {
    // Running-activity RPCs are trailing-debounced (one flush per window with
    // the latest text), so advance past the window after each event to assert
    // every event's activity text individually.
    vi.useFakeTimers();
    try {
      const { fake, activityRecords } = createPiEventFake();

      const piEvents = [
        { type: 'agent_start' },
        {
          type: 'message_update',
          message: { role: 'assistant', content: [] },
          assistantMessageEvent: {
            type: 'thinking_start',
            contentIndex: 0,
          },
        },
        {
          type: 'message_update',
          message: { role: 'assistant', content: [] },
          assistantMessageEvent: {
            type: 'text_delta',
            delta: 'Streaming assistant update.',
          },
        },
        {
          type: 'tool_execution_start',
          toolCallId: 'tool-read',
          toolName: 'read',
          args: { file_path: '/workspace/src/App.tsx' },
        },
        {
          type: 'tool_execution_end',
          toolCallId: 'tool-read',
          toolName: 'read',
          args: { file_path: '/workspace/src/App.tsx' },
          result: { content: [{ type: 'text', text: 'ok' }] },
          isError: false,
        },
      ];
      for (const piEvent of piEvents) {
        await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, piEvent);
        await vi.advanceTimersByTimeAsync(5_001);
        await flushWaitUntil(fake);
      }

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
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders persisted Pi tool result messages with their assistant tool calls', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
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
        is_error: false,
        status: 'succeeded',
        itemId: 'tool1',
        itemKind: 'commandExecution',
      },
    ]);
  });

  it('inserts a tool result after its tool call so trailing answer text stays last', async () => {
    // Pi can persist a turn's final answer in the same assistant record as its
    // tool calls. The tool result must land right after its tool_use, not at the
    // end of the message — otherwise the trailing answer text would render
    // before the tool result and the turn view would fold it into the collapsed
    // tool trace instead of showing it as the turn's final output.
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.loadPiCoreMessages = vi.fn(() => [
      { role: 'user', content: 'run it', timestamp: 100 },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me check.' },
          {
            type: 'toolCall',
            id: 'tool1',
            name: 'bash',
            arguments: { command: 'echo hi' },
          },
          { type: 'text', text: 'All done — the output was hi.' },
        ],
        responseId: 'resp_tool',
        timestamp: 200,
        api: 'test',
        provider: 'test',
        model: 'test',
        usage: {},
        stopReason: 'stop',
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
    expect(messages[1].content).toEqual([
      { type: 'text', text: 'Let me check.' },
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
        is_error: false,
        status: 'succeeded',
        itemId: 'tool1',
        itemKind: 'commandExecution',
      },
      { type: 'text', text: 'All done — the output was hi.' },
    ]);
  });

  it('marks persisted Pi stopped-by-user messages for muted UI rendering', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
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

    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
      type: 'turn_end',
      message: allMessages[1],
      toolResults: [],
    });

    expect(fake.appendPiCoreMessagesIfMissing).not.toHaveBeenCalled();
    expect(fake.piMainBaselineIndex).toBe(2);
  });

  // --- Durable resume: resumeInterruptedPiTurn ---

  function createResumeFake(overrides: Record<string, any> = {}) {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.readPiActiveTurn = vi.fn(() => ({ turnId: 't1', attempt: 0, openedAt: 1 }));
    fake.writePiActiveTurn = vi.fn();
    fake.clearPiActiveTurnAndJournal = vi.fn(async () => {});
    fake.markTurnStarted = vi.fn();
    fake.finishTurn = vi.fn();
    fake.setActiveTurnUserId = vi.fn();
    fake.syncAgentState = vi.fn();
    fake.isThreadStreaming = vi.fn(() => false);
    fake.persistPiAgentLoopErrorForDevelopers = vi.fn();
    fake.updateActiveAutomationRun = vi.fn();
    fake.pushChatEvent = vi.fn();
    fake.piProviderErrorEvent = vi.fn((message: string) => ({ type: 'error', message }));
    fake.appendPiCoreMessagesIfMissing = vi.fn();
    fake.attachCodeModeArtifactsToToolResult = vi.fn(async (message: any) => message);
    fake.extractLatestPiAssistantText = vi.fn(() => 'final reply');
    fake.completeTodoStateForTurnEnd = vi.fn(async () => {});
    fake.chatContext = { threadId: 'thread1' };
    fake.ensurePiSessionReady = vi.fn(async () => {});
    fake.runFiber = vi.fn(async (_name: string, fn: () => unknown) => fn());
    fake.withPiTurnInactivityTimeout = vi.fn(async (fn: () => unknown) => fn());
    Object.assign(fake, overrides);
    return fake;
  }

  it('attaches Code Mode artifacts when committing a recovered tail that owes no model output', async () => {
    // Evicted after the final assistant message_end but before turn_end snapshotted
    // it: nothing owed, so the tail is committed directly — but it must still fold
    // js_exec/Code Mode artifacts onto tool results the way turn_end does.
    const toolResult = {
      role: 'toolResult',
      toolCallId: 'call_1',
      toolName: 'js_exec',
      content: [{ type: 'text', text: 'output' }],
    };
    const assistantFinal = {
      role: 'assistant',
      content: [{ type: 'text', text: 'done' }],
      stopReason: 'endTurn',
    };
    const messages = [{ role: 'user', content: 'run it' }, toolResult, assistantFinal];
    const withArtifacts = { ...toolResult, _artifactsAttached: true };
    const fake = createResumeFake({
      piSession: { state: { isStreaming: false, messages } },
      piMainBaselineIndex: 1,
      attachCodeModeArtifactsToToolResult: vi.fn(async (message: any) =>
        message === toolResult ? withArtifacts : message,
      ),
    });

    await ChatThreadDO.prototype['resumeInterruptedPiTurn'].call(fake);

    expect(fake.attachCodeModeArtifactsToToolResult).toHaveBeenCalledWith(toolResult, {
      consume: true,
    });
    expect(fake.appendPiCoreMessagesIfMissing).toHaveBeenCalledWith([
      withArtifacts,
      assistantFinal,
    ]);
    expect(fake.clearPiActiveTurnAndJournal).toHaveBeenCalled();
    // Finalizes like the normal agent_end path: markUnread drives completion
    // recording / automation success / summary, not a bare streaming reset.
    expect(fake.finishTurn).toHaveBeenCalledWith(
      expect.objectContaining({ markUnread: true, completedAt: expect.any(Number) }),
    );
    expect(fake.setActiveTurnUserId).toHaveBeenCalledWith(null);
    expect(fake.completeTodoStateForTurnEnd).toHaveBeenCalled();
  });

  it('releases the thread when rebuilding the Pi session fails during resume', async () => {
    // ensurePiSessionReady can throw (e.g. OrgDO/model-provider config retries
    // exhaust). That happens before the continuation, with the fiber row already
    // consumed, so it must run the same release cleanup or the thread stays busy.
    const rebuildError = new Error('model provider config unavailable');
    const fake = createResumeFake({
      ensurePiSessionReady: vi.fn(() => Promise.reject(rebuildError)),
    });

    await ChatThreadDO.prototype['resumeInterruptedPiTurn'].call(fake);

    expect(fake.persistPiAgentLoopErrorForDevelopers).toHaveBeenCalledWith(
      rebuildError,
      { source: 'pi_resume' },
    );
    expect(fake.pushChatEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error' }),
    );
    expect(fake.finishTurn).toHaveBeenCalled();
    expect(fake.setActiveTurnUserId).toHaveBeenCalledWith(null);
    expect(fake.clearPiActiveTurnAndJournal).toHaveBeenCalled();
  });

  it('releases the thread when a recovered continuation fails for a non-eviction reason', async () => {
    // The model still owes output, so we drive continue() in a fiber. A provider
    // error (not an eviction) must clear the marker/journal and reset streaming —
    // otherwise the thread stays busy with no run row left to retry recovery.
    const messages = [
      { role: 'user', content: 'hi' },
      { role: 'toolResult', toolCallId: 'c1', toolName: 'read', content: [{ type: 'text', text: 'r' }] },
    ];
    const providerError = new Error('Provider exploded');
    const fake = createResumeFake({
      piSession: {
        state: { isStreaming: false, messages },
        continue: vi.fn(() => Promise.reject(providerError)),
      },
      piMainBaselineIndex: 0,
    });

    await ChatThreadDO.prototype['resumeInterruptedPiTurn'].call(fake);

    expect(fake.piSession.continue).toHaveBeenCalled();
    expect(fake.pushChatEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', message: 'Provider exploded' }),
    );
    expect(fake.updateActiveAutomationRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error', clear: true }),
    );
    expect(fake.finishTurn).toHaveBeenCalled();
    expect(fake.setActiveTurnUserId).toHaveBeenCalledWith(null);
    expect(fake.clearPiActiveTurnAndJournal).toHaveBeenCalled();
  });

  it('leaves recovery cleanup to agent_end when a recovered continuation is user-aborted', async () => {
    // A user stop keeps Pi handlers subscribed, so agent_end runs and cleans up;
    // the resume catch must treat the AbortError as benign and NOT wipe state.
    const messages = [
      { role: 'user', content: 'hi' },
      { role: 'toolResult', toolCallId: 'c1', toolName: 'read', content: [{ type: 'text', text: 'r' }] },
    ];
    const abortError = new Error('The turn was aborted');
    abortError.name = 'AbortError';
    const fake = createResumeFake({
      piSession: {
        state: { isStreaming: false, messages },
        continue: vi.fn(() => Promise.reject(abortError)),
      },
      piMainBaselineIndex: 0,
    });

    await ChatThreadDO.prototype['resumeInterruptedPiTurn'].call(fake);

    expect(fake.piSession.continue).toHaveBeenCalled();
    expect(fake.clearPiActiveTurnAndJournal).not.toHaveBeenCalled();
    expect(fake.finishTurn).not.toHaveBeenCalled();
    expect(fake.pushChatEvent).not.toHaveBeenCalled();
  });

  it('clears active turn ownership when the resume attempt budget is exhausted', async () => {
    // failPiResume must release the active-turn user like the other terminal
    // paths, or later sandbox MCP calls stay attributed to the abandoned author.
    const fake = createResumeFake({
      readPiActiveTurn: vi.fn(() => ({ turnId: 't1', attempt: 3, openedAt: 1 })),
      recordChatThreadObservabilityEvent: vi.fn(),
    });

    await ChatThreadDO.prototype['resumeInterruptedPiTurn'].call(fake);

    expect(fake.clearPiActiveTurnAndJournal).toHaveBeenCalled();
    expect(fake.finishTurn).toHaveBeenCalled();
    expect(fake.setActiveTurnUserId).toHaveBeenCalledWith(null);
    // It bailed at the attempt budget — never tried to rebuild/continue.
    expect(fake.ensurePiSessionReady).not.toHaveBeenCalled();
  });

  describe('steer-message journaling', () => {
    it('round-trips steer messages through sync KV and clears them', async () => {
      const store = new Map<string, unknown>();
      const fake = Object.create(ChatThreadDO.prototype) as any;
      fake.ctx = {
        storage: {
          kv: {
            get: (key: string) => store.get(key),
            put: (key: string, value: unknown) => void store.set(key, value),
            delete: (key: string) => void store.delete(key),
          },
        },
      };
      fake.hydratePiStoredImages = vi.fn(async (message: any) => message);

      ChatThreadDO.prototype['recordPiTurnJournalSteerMessage'].call(fake, {
        role: 'user',
        content: 'steer one',
        timestamp: 1,
      });
      ChatThreadDO.prototype['recordPiTurnJournalSteerMessage'].call(fake, {
        role: 'user',
        content: 'steer two',
        timestamp: 2,
      });

      const loaded = await ChatThreadDO.prototype['loadPiTurnSteerJournal'].call(fake);
      expect(loaded).toHaveLength(2);
      expect(JSON.stringify(loaded)).toContain('steer one');
      expect(JSON.stringify(loaded)).toContain('steer two');

      ChatThreadDO.prototype['clearPiTurnSteerJournal'].call(fake);
      const afterClear = await ChatThreadDO.prototype['loadPiTurnSteerJournal'].call(fake);
      expect(afterClear).toEqual([]);
    });

    it('journals an accepted steering message before handing it to the steer queue', async () => {
      const { fake } = createPiEventFake();
      fake.refreshPiSessionModel = vi.fn(async () => undefined);
      fake.recordPiTurnJournalSteerMessage = vi.fn();
      const steer = vi.fn();
      fake.piSession = {
        state: {
          isStreaming: true,
          model: { api: 'test', provider: 'test', id: 'test-model' },
        },
        prompt: vi.fn(),
        steer,
        abort: vi.fn(),
      };

      const accepted = ChatThreadDO.prototype['sendRunnerCommand'].call(fake, {
        type: 'message',
        content: 'steer me',
      });
      expect(accepted).toBe(true);
      await flushWaitUntil(fake);

      expect(fake.recordPiTurnJournalSteerMessage).toHaveBeenCalledTimes(1);
      expect(steer).toHaveBeenCalledTimes(1);
      // Same message object, journaled strictly before it reaches the queue.
      expect(fake.recordPiTurnJournalSteerMessage.mock.calls[0][0]).toBe(
        steer.mock.calls[0][0],
      );
      expect(
        fake.recordPiTurnJournalSteerMessage.mock.invocationCallOrder[0],
      ).toBeLessThan(steer.mock.invocationCallOrder[0]);
    });
  });

  it('suppresses failed turn_end persistence and discards unpersisted session messages', async () => {
    const { fake, events: _events } = createPiEventFake();
    void _events;
    const previousMessage = { role: 'user', content: 'previous turn', timestamp: 50 };
    const allMessages = [
      previousMessage,
      { role: 'user', content: 'current turn', timestamp: 100 },
      {
        role: 'assistant',
        content: [{
          type: 'toolCall',
          id: 'call_1|fc_tmp_1',
          name: 'js_exec',
          arguments: {},
        }],
        stopReason: 'error',
        errorMessage: 'Provider returned error',
        responseId: 'resp_error',
        timestamp: 200,
      },
    ];
    fake.piSession = { state: { messages: allMessages } };
    fake.piMainBaselineIndex = 1;
    fake.appendPiCoreMessagesIfMissing = vi.fn();

    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
      type: 'turn_end',
      message: allMessages[2],
      toolResults: [],
    });

    expect(fake.appendPiCoreMessagesIfMissing).not.toHaveBeenCalled();
    expect(fake.piSession.state.messages).toEqual([previousMessage]);
    expect(fake.piMainBaselineIndex).toBe(1);
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

    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
      type: 'turn_end',
      message: allMessages[1],
      toolResults: [],
    });

    expect(fake.appendPiCoreMessagesIfMissing).not.toHaveBeenCalled();
    expect(fake.piMainBaselineIndex).toBe(0);
  });

  it('omits hidden internal messages from the parsed chat view', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.chatContext = { threadId: 'thread1' };
    fake.loadPiCoreMessages = vi.fn(() => [
      { role: 'user', content: 'first turn', timestamp: 100 },
      {
        role: 'user',
        content: 'hidden context that should not reach the client',
        timestamp: 200,
        visibility: 'hidden',
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'reply' }],
        responseId: 'resp_reply',
        timestamp: 210,
        api: 'test',
        provider: 'test',
        model: 'test',
        usage: {},
        stopReason: 'stop',
      },
    ]);

    const parsed = await ChatThreadDO.prototype['getPiCoreParsedMessages'].call(
      fake,
      'thread1',
    );

    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ role: 'user', content: 'first turn' });
    expect(parsed[1]).toMatchObject({ role: 'assistant', id: 'resp_reply' });
    expect(
      parsed.some((message) =>
        String(message.content).includes('hidden context'),
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

  it('records Bedrock 524 assistant errors with structured provider metadata', async () => {
    const { fake, events } = createPiEventFake();
    fake.piCurrentUsageProvider = 'bedrock';
    fake.piCurrentBillingSource = 'byok';
    fake.piSession = {
      state: {
        model: { id: 'us.anthropic.claude-opus-4-8' },
      },
    };
    const errorMessage = 'Bedrock request failed with HTTP 524: error code: 524';

    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, { type: 'agent_start' });
    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
      type: 'agent_end',
      messages: [{
        role: 'assistant',
        content: [],
        errorMessage,
        responseId: 'resp_bedrock_524',
        timestamp: 789,
      }],
    });

    expect(events).toContainEqual(expect.objectContaining({
      type: 'error',
      error: errorMessage,
      source: 'chat_thread_do_pi',
      billingSource: 'byok',
      provider: 'bedrock',
      status: 524,
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
    fake.updateActiveAutomationRun = vi.fn();
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
    expect(fake.updateActiveAutomationRun).toHaveBeenCalledWith({
      status: 'error',
      message: 'Stopped by user',
      completedAt: expect.any(Number),
      clear: true,
    });
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

  it('preserves js_exec artifact metadata when persisting a stopped Pi turn', async () => {
    const { fake } = createPiEventFake();
    fake.updateActiveAutomationRun = vi.fn();
    const artifact = {
      id: 'artifact_1',
      kind: 'outbound_email',
      toolName: 'send_email',
      status: 'sent',
      title: 'Email sent',
      createdAt: 1,
      updatedAt: 2,
      summary: { to: 'alice@example.com' },
    };
    // The stop path consumes buffered artifacts from the live session tail, so
    // the unpersisted tool result carries no UI metadata until it is attached.
    const toolResult = {
      role: 'toolResult',
      toolCallId: 'tool_js_exec_1',
      toolName: 'js_exec',
      content: 'ok',
      timestamp: 200,
    };
    fake.consumeCodeModeArtifacts = vi.fn(async () => [artifact]);

    fake.piUserStopRequestedAtMs = 1234;
    fake.piMainBaselineIndex = 1;
    fake.piSession = {
      state: {
        model: { api: 'test', provider: 'test', id: 'test-model' },
        messages: [
          { role: 'user', content: 'previous', timestamp: 50 },
          toolResult,
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

    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, { type: 'agent_start' });
    fake.piUserStopRequestedAtMs = 1234;
    fake.piMainBaselineIndex = 1;
    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
      type: 'agent_end',
      messages: [
        toolResult,
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

    expect(fake.consumeCodeModeArtifacts).toHaveBeenCalledWith('tool_js_exec_1', {
      deleteAfterRead: true,
    });
    expect(fake.appendPiCoreMessagesIfMissing).toHaveBeenCalledWith([
      expect.objectContaining({
        role: 'toolResult',
        toolCallId: 'tool_js_exec_1',
        toolName: 'js_exec',
        uiMetadata: { codeModeArtifacts: [artifact] },
      }),
      expect.objectContaining({
        role: 'assistant',
        content: [{ type: 'text', text: 'Stopped by user' }],
        metadata: { reason: 'user_stop' },
      }),
    ]);
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

  it('prunes unpersisted Pi session messages when agent_end arrives without a successful turn_end', async () => {
    const { fake } = createPiEventFake();
    const previousMessage = { role: 'user', content: 'previous turn', timestamp: 50 };
    const failedTurnMessages = [
      { role: 'user', content: 'current turn', timestamp: 100 },
      {
        role: 'assistant',
        content: [{
          type: 'toolCall',
          id: 'call_1|fc_tmp_1',
          name: 'js_exec',
          arguments: {},
        }],
        stopReason: 'error',
        errorMessage: 'Provider returned error',
        responseId: 'resp_error',
        timestamp: 200,
      },
    ];
    fake.piSession = {
      state: {
        model: { api: 'test', provider: 'test', id: 'test-model' },
        messages: [previousMessage, ...failedTurnMessages],
      },
    };
    fake.piMainBaselineIndex = 1;

    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
      type: 'agent_end',
      messages: failedTurnMessages,
    });

    expect(fake.appendPiCoreMessagesIfMissing).not.toHaveBeenCalled();
    expect(fake.piSession.state.messages).toEqual([previousMessage]);
    expect(fake.piMainBaselineIndex).toBe(1);
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
    installAgentStateMocks(fake);

    await ChatThreadDO.prototype.setTodoState.call(fake, [
      { content: 'Check state', status: 'in_progress' },
    ]);

    expect(put).toHaveBeenCalledWith('chatTodos', [
      { content: 'Check state', status: 'in_progress', activeForm: 'Check state' },
    ]);
    expect(fake.setState).toHaveBeenCalledWith(expect.objectContaining({
      currentTodos: [{ content: 'Check state', status: 'in_progress', activeForm: 'Check state' }],
    }));

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
    installAgentStateMocks(fake);

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
    expect(fake.setState).toHaveBeenCalledWith(expect.objectContaining({
      currentTodos: expected,
    }));
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
    installAgentStateMocks(fake);

    await ChatThreadDO.prototype.completeTodoStateForTurnEnd.call(fake);

    expect(fake.currentTodos).toEqual([]);
    expect(deleteKey).toHaveBeenCalledWith('chatTodos');
    expect(fake.setState).toHaveBeenCalledWith(expect.objectContaining({
      currentTodos: [
        { content: 'Check state', status: 'completed', activeForm: 'Checking state' },
        { content: 'Summarize', status: 'completed', activeForm: 'Summarizing' },
      ],
    }));
  });

  it('clears stale non-streaming todo state when a chat connects', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;

    fake.chatContext = {
      threadId: 'thread1',
      workspaceId: 'workspace1',
      orgId: 'org1',
    };
    fake.ctx = {
      storage: { kv: { put: vi.fn() } },
    };
    fake.chatIsStreaming = false;
    fake.currentTodos = [{ content: 'Old task', status: 'in_progress' }];
    fake.syncAgentState = vi.fn();
    // Mirror the real method: it clears the todos and syncs an override marking
    // them completed.
    fake.completeTodoStateForTurnEnd = vi.fn(async () => {
      fake.currentTodos = [];
      fake.syncAgentState({
        currentTodos: [{ content: 'Old task', status: 'completed' }],
      });
    });

    const connection = { close: vi.fn(), serializeAttachment: vi.fn() };
    const ctx = {
      request: new Request('https://example.com/ws?threadId=thread1&workspaceId=workspace1&orgId=org1'),
    };

    await ChatThreadDO.prototype.onConnect.call(fake, connection, ctx);

    expect(fake.completeTodoStateForTurnEnd).toHaveBeenCalledTimes(1);
    // The completed-todo override must be the final sync — onConnect must not
    // sync again afterward with the cleared list and erase the checklist.
    expect(fake.syncAgentState).toHaveBeenCalledTimes(1);
    expect(fake.syncAgentState).toHaveBeenCalledWith(
      expect.objectContaining({
        currentTodos: [{ content: 'Old task', status: 'completed' }],
      }),
    );
    expect(connection.close).not.toHaveBeenCalled();
  });

  it('syncs generated thread titles through Agent state', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;

    fake.currentTodos = [];
    fake.trace = vi.fn();
    fake.browserPrompts = {
      sendPendingPromptsToWebSocket: vi.fn(),
      pendingQuestionPrompts: vi.fn(() => []),
      pendingQuestionCount: 0,
    };
    installAgentStateMocks(fake);

    await ChatThreadDO.prototype.setTitle.call(
      fake,
      'Generated title',
      1_710_000_000_000,
    );

    expect(fake.setState).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Generated title',
      titleUpdatedAt: 1_710_000_000_000,
    }));
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
    const recordThreadChannelUsed = vi.fn(async () => null);
    const get = vi.fn(async (key: string) =>
      key === 'org1/workspace1/user-outputs/report.pdf'
        ? r2Object('pdf bytes', 'application/pdf')
        : null
    );
    const thread = {
      id: 'thread1',
      workspace_id: 'workspace1',
      source: 'channel',
      channel_kind: 'email',
      channel_connection_id: 'workspace@camelai.dev',
      channel_conversation_id: 'message:email-0',
      channel_message_id: 'email-0',
    };
    const fake = Object.create(ChannelTools.prototype) as any;
    fake.env = {
      EMAIL: { send },
      APP_KV: { get: vi.fn(async () => null), put: kvPutMock },
      R2_BUCKET: { get },
      ORG: createChannelOrgNamespace({ thread, recordThreadChannelUsed }),
      WORKSPACE_EMAIL_DOMAIN: 'camelai.dev',
      WORKSPACE: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({
          getInfo: vi.fn(async () => ({
            id: 'workspace1',
            name: 'Test Workspace',
            email_handle: 'workspace-agent',
          })),
        })),
      },
    };

    const result = await ChannelTools.prototype['sendChannelEmailTool'].call(
      fake,
      { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
      {
        to: 'sender@example.com',
        subject: 'Report',
        text: 'Attached.',
        attachments: [{ path: 'outputs/report.pdf' }],
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
    expect(message.from).toBe('Camel <workspace-agent@camelai.dev>');
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
    expect(recordThreadChannelUsed).toHaveBeenCalledWith('thread1', 'email');
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
    const fake = Object.create(ChannelTools.prototype) as any;
    fake.env = { R2_BUCKET: { get } };

    await expect(
      ChannelTools.prototype['resolveChannelOutboundAttachments'].call(
        fake,
        { orgId: 'org1', workspaceId: 'workspace1' },
        { attachments: [{ path: 'outputs/large.bin' }] },
      ),
    ).rejects.toThrow('Attachment size must be 25 MB or less');
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('uploads Slack channel attachments through the external file upload flow', async () => {
    const encrypted = await encryptCredentials(
      { access_token: 'xoxb-token', team_id: 'T1' },
      'secret',
    );
    const recordThreadChannelUsed = vi.fn(async () => null);
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

    const fake = Object.create(ChannelTools.prototype) as any;
    fake.getOriginatingChannelThread = vi.fn(async () => ({
      source: 'channel',
      channel_kind: 'slack',
      channel_connection_id: 'slack-int',
      channel_conversation_id: 'T1:C1:1700000000.000100',
    }));
    fake.env = {
      INTEGRATION_SECRET_KEY: 'secret',
      ORG: createChannelOrgNamespace({
        recordThreadChannelUsed,
        integration: {
          id: 'slack-int',
          integration_type: 'slack',
          config: JSON.stringify({ team_id: 'T1' }),
          credentials_encrypted: encrypted,
        },
      }),
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

    const result = await ChannelTools.prototype['sendChannelSlackMessageTool'].call(
      fake,
      { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
      {
        text: 'Attached.',
        attachments: [{ path: 'outputs/chart.png' }],
      },
    );

    expect(result.details).toMatchObject({
      status: 'sent',
      channel: 'slack',
      attachmentCount: 1,
      fileIds: ['F123'],
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(recordThreadChannelUsed).toHaveBeenCalledWith('thread1', 'slack');
  });

  it('sends Telegram channel attachments as documents', async () => {
    const recordThreadChannelUsed = vi.fn(async () => null);
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

    const fake = Object.create(ChannelTools.prototype) as any;
    fake.getOriginatingChannelThread = vi.fn(async () => ({
      source: 'channel',
      channel_kind: 'telegram',
      channel_conversation_id: '12345',
    }));
    fake.env = {
      TELEGRAM_BOT_TOKEN: 'bot-token',
      ORG: createChannelOrgNamespace({
        recordThreadChannelUsed,
        integration: {
          id: 'telegram-int',
          integration_type: 'telegram',
          config: JSON.stringify({ chat_id: '12345' }),
        },
      }),
      R2_BUCKET: { get },
    };

    const result = await ChannelTools.prototype['sendChannelTelegramMessageTool'].call(
      fake,
      { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
      {
        text: 'Attached.',
        attachments: [{ path: 'outputs/report.csv', caption: 'CSV' }],
      },
    );

    expect(result.details).toMatchObject({
      status: 'sent',
      channel: 'telegram',
      attachmentCount: 1,
      messageIds: [10, 11],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(recordThreadChannelUsed).toHaveBeenCalledWith('thread1', 'telegram');
  });

  it('selects Slack connection by decrypted team id when sending outside Slack threads', async () => {
    const recordThreadChannelUsed = vi.fn(async () => null);
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

    const fake = Object.create(ChannelTools.prototype) as any;
    fake.getOriginatingChannelThread = vi.fn(async () => null);
    fake.env = {
      INTEGRATION_SECRET_KEY: 'secret',
      ORG: createChannelOrgNamespace({
        recordThreadChannelUsed,
        integrations: [
          { id: 'wrong', integration_type: 'slack', credentials_encrypted: wrongEncrypted },
          { id: 'right', integration_type: 'slack', credentials_encrypted: rightEncrypted },
        ],
      }),
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

    const result = await ChannelTools.prototype['sendChannelSlackMessageTool'].call(
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
    expect(recordThreadChannelUsed).toHaveBeenCalledWith('thread1', 'slack');
  });

  it('rejects raw Telegram chat ids outside Telegram threads without a workspace integration', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const fake = Object.create(ChannelTools.prototype) as any;
    fake.getOriginatingChannelThread = vi.fn(async () => null);
    fake.env = {
      TELEGRAM_BOT_TOKEN: 'bot-token',
      ORG: createChannelOrgNamespace({ integrations: [] }),
      R2_BUCKET: { get: vi.fn() },
      WORKSPACE: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({
          getIntegrations: vi.fn(async () => []),
        })),
      },
    };

    await expect(
      ChannelTools.prototype['sendChannelTelegramMessageTool'].call(
        fake,
        { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
        {
          chat_id: '12345',
          text: 'Hello',
        },
      ),
    ).rejects.toThrow('No connected Telegram integrations are available');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('times out stalled Telegram sends', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        })
      );
      vi.stubGlobal('fetch', fetchMock);

      const fake = Object.create(ChannelTools.prototype) as any;
      fake.getOriginatingChannelThread = vi.fn(async () => null);
      fake.env = {
        TELEGRAM_BOT_TOKEN: 'bot-token',
        ORG: createChannelOrgNamespace({
          integration: {
            id: 'telegram-int',
            integration_type: 'telegram',
            config: JSON.stringify({ chat_id: '12345' }),
          },
        }),
        R2_BUCKET: { get: vi.fn() },
        WORKSPACE: {
          idFromName: vi.fn((id: string) => id),
          get: vi.fn(() => ({
            getIntegration: vi.fn(async () => ({
              id: 'telegram-int',
              integration_type: 'telegram',
              config: JSON.stringify({ chat_id: '12345' }),
            })),
          })),
        },
      };

      const promise = ChannelTools.prototype['sendChannelTelegramMessageTool'].call(
        fake,
        { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
        {
          integration_id: 'telegram-int',
          text: 'Hello',
        },
      );

      const assertion = expect(promise).rejects.toThrow(
        'Telegram sendMessage request timed out after 15000ms',
      );
      await vi.advanceTimersByTimeAsync(15_000);
      await assertion;
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('auto-selects the only connected Telegram integration outside Telegram threads', async () => {
    const appendChannelHistoryEvent = vi.fn(async () => ({ status: 'appended' }));
    const recordThreadChannelUsed = vi.fn(async () => null);
    const getIntegration = vi.fn(async () => ({
      id: 'telegram-int',
      integration_type: 'telegram',
      name: 'Product Telegram',
      config: JSON.stringify({
        chat_id: '12345',
        chat_title: 'Product team',
      }),
    }));
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toMatch(/\/sendMessage$/);
      const payload = JSON.parse(String(init?.body));
      expect(payload).toMatchObject({ chat_id: '12345', text: 'Hello' });
      return Response.json({ ok: true, result: { message_id: 20 } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const fake = Object.create(ChannelTools.prototype) as any;
    fake.getOriginatingChannelThread = vi.fn(async () => null);
    fake.env = {
      TELEGRAM_BOT_TOKEN: 'bot-token',
      ORG: createChannelOrgNamespace({
        thread: { id: 'telegram-thread', title: 'Product team' },
        recordThreadChannelUsed,
        integration: {
          id: 'telegram-int',
          integration_type: 'telegram',
          name: 'Product Telegram',
          config: JSON.stringify({
            chat_id: '12345',
            chat_title: 'Product team',
          }),
        },
        integrations: [{
          id: 'telegram-int',
          integration_type: 'telegram',
          config: JSON.stringify({ chat_id: '12345' }),
        }],
      }),
      R2_BUCKET: { get: vi.fn() },
      WORKSPACE: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({
          getIntegrations: vi.fn(async () => [{
            id: 'telegram-int',
            integration_type: 'telegram',
            config: JSON.stringify({ chat_id: '12345' }),
          }]),
          getIntegration,
        })),
      },
      APP_KV: {
        get: vi.fn(async (key: string) =>
          key === 'channel_thread:telegram:workspace1:telegram-int:12345'
            ? 'telegram-thread'
            : null
        ),
        put: vi.fn(async () => undefined),
        delete: vi.fn(async () => undefined),
      },
      CHAT_THREAD: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({ appendChannelHistoryEvent })),
      },
    };

    const result = await ChannelTools.prototype['sendChannelTelegramMessageTool'].call(
      fake,
      { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
      { text: 'Hello' },
    );

    expect(getIntegration).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      status: 'sent',
      channel: 'telegram',
      chatId: '12345',
      integrationId: 'telegram-int',
      messageIds: [20],
      channelHistoryStatus: 'recorded',
    });
    expect(appendChannelHistoryEvent).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(recordThreadChannelUsed).toHaveBeenCalledWith('thread1', 'telegram');
  });

  it('sends Telegram messages through a configured workspace integration outside Telegram threads', async () => {
    const appendChannelHistoryEvent = vi.fn(async () => ({ status: 'appended' }));
    const recordThreadChannelUsed = vi.fn(async () => null);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toMatch(/\/sendMessage$/);
      const payload = JSON.parse(String(init?.body));
      expect(payload).toMatchObject({
        chat_id: '12345',
        text: '<b>Hello</b> &amp; <i>there</i>',
        parse_mode: 'HTML',
      });
      return Response.json({ ok: true, result: { message_id: 19 } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const fake = Object.create(ChannelTools.prototype) as any;
    fake.getOriginatingChannelThread = vi.fn(async () => null);
    fake.env = {
      TELEGRAM_BOT_TOKEN: 'bot-token',
      ORG: createChannelOrgNamespace({
        thread: { id: 'telegram-thread', title: 'Product team' },
        recordThreadChannelUsed,
        integration: {
          id: 'telegram-int',
          integration_type: 'telegram',
          name: 'Product Telegram',
          config: JSON.stringify({
            chat_id: '12345',
            chat_title: 'Product team',
          }),
        },
      }),
      R2_BUCKET: { get: vi.fn() },
      WORKSPACE: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({
          getIntegration: vi.fn(async () => ({
            id: 'telegram-int',
            integration_type: 'telegram',
            name: 'Product Telegram',
            config: JSON.stringify({
              chat_id: '12345',
              chat_title: 'Product team',
            }),
          })),
        })),
      },
      APP_KV: {
        get: vi.fn(async (key: string) =>
          key === 'channel_thread:telegram:workspace1:telegram-int:12345'
            ? 'telegram-thread'
            : null
        ),
        put: vi.fn(async () => undefined),
        delete: vi.fn(async () => undefined),
      },
      CHAT_THREAD: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({ appendChannelHistoryEvent })),
      },
    };

    const result = await ChannelTools.prototype['sendChannelTelegramMessageTool'].call(
      fake,
      { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
      {
        integration_id: 'telegram-int',
        chat_id: '12345',
        text: '**Hello** & _there_',
      },
    );

    expect(result.details).toMatchObject({
      status: 'sent',
      channel: 'telegram',
      chatId: '12345',
      integrationId: 'telegram-int',
      messageIds: [19],
      channelHistoryStatus: 'recorded',
    });
    expect(appendChannelHistoryEvent).toHaveBeenCalledWith(expect.objectContaining({
      threadId: 'telegram-thread',
      workspaceId: 'workspace1',
      orgId: 'org1',
      channelKind: 'telegram',
      connectionId: 'telegram-int',
      remoteConversationId: '12345',
      sourceThreadId: 'thread1',
      direction: 'outbound',
      text: '**Hello** & _there_',
      providerMessageIds: [19],
      attachmentCount: 0,
    }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(recordThreadChannelUsed).toHaveBeenCalledWith('thread1', 'telegram');
  });

  it('appends outbound channel history as persisted Pi context', async () => {
    const recordThreadChannelUsed = vi.fn(async () => null);
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.chatContext = { threadId: 'telegram-thread' };
    fake.env = {
      ORG: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({ recordThreadChannelUsed })),
      },
    };
    fake.appendPiCoreMessagesIfMissing = vi.fn(async () => undefined);
    fake.recordChatThreadObservabilityEvent = vi.fn();
    fake.piMainBaselineIndex = 0;
    fake.piSession = { state: { messages: [], isStreaming: false } };

    const result = await ChatThreadDO.prototype.appendChannelHistoryEvent.call(fake, {
      threadId: 'telegram-thread',
      orgId: 'org1',
      channelKind: 'telegram',
      connectionId: 'telegram-int',
      remoteConversationId: '12345',
      sourceThreadId: 'scheduler-thread',
      direction: 'outbound',
      text: 'Weekly update.',
      providerMessageIds: [42],
      sentAt: Date.UTC(2026, 4, 29, 16, 0, 0),
    });

    expect(result).toEqual({ status: 'appended' });
    expect(fake.appendPiCoreMessagesIfMissing).toHaveBeenCalledTimes(1);
    const message = fake.appendPiCoreMessagesIfMissing.mock.calls[0][0][0];
    expect(message).toMatchObject({
      role: 'user',
      timestamp: Date.UTC(2026, 4, 29, 16, 0, 0),
    });
    expect(message.content).toContain('already-delivered channel history');
    expect(message.content).toContain('Weekly update.');
    expect(fake.piSession.state.messages).toHaveLength(1);
    expect(fake.piMainBaselineIndex).toBe(1);
    expect(recordThreadChannelUsed).toHaveBeenCalledWith(
      'telegram-thread',
      'telegram',
    );
  });

  it('rejects mismatched Telegram chat ids for workspace integrations', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const fake = Object.create(ChannelTools.prototype) as any;
    fake.getOriginatingChannelThread = vi.fn(async () => null);
      fake.env = {
        TELEGRAM_BOT_TOKEN: 'bot-token',
        ORG: createChannelOrgNamespace({
          integration: {
            integration_type: 'telegram',
            config: JSON.stringify({ chat_id: '12345' }),
          },
        }),
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
      ChannelTools.prototype['sendChannelTelegramMessageTool'].call(
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
    const recordThreadChannelUsed = vi.fn(async () => null);
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

    const fake = Object.create(ChannelTools.prototype) as any;
    fake.getOriginatingChannelThread = vi.fn(async () => ({
      source: 'channel',
      channel_kind: 'telegram',
      channel_conversation_id: '12345',
    }));
    fake.env = {
      TELEGRAM_BOT_TOKEN: 'bot-token',
      ORG: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({ recordThreadChannelUsed })),
      },
      R2_BUCKET: { get },
    };

    const result = await ChannelTools.prototype['sendChannelTelegramMessageTool'].call(
      fake,
      { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
      {
        attachments: [{ path: 'outputs/chart.png', caption: 'Chart' }],
      },
    );

    expect(result.details).toMatchObject({
      status: 'sent',
      channel: 'telegram',
      attachmentCount: 1,
      messageIds: [20],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(recordThreadChannelUsed).toHaveBeenCalledWith('thread1', 'telegram');
  });

  it('falls back to Telegram documents when photo upload is rejected', async () => {
    const recordThreadChannelUsed = vi.fn(async () => null);
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

    const fake = Object.create(ChannelTools.prototype) as any;
    fake.getOriginatingChannelThread = vi.fn(async () => ({
      source: 'channel',
      channel_kind: 'telegram',
      channel_conversation_id: '12345',
    }));
    fake.env = {
      TELEGRAM_BOT_TOKEN: 'bot-token',
      ORG: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({ recordThreadChannelUsed })),
      },
      R2_BUCKET: { get },
    };

    try {
      const result = await ChannelTools.prototype['sendChannelTelegramMessageTool'].call(
        fake,
        { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
        {
          attachments: [{ path: 'outputs/large-photo.png' }],
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
    expect(recordThreadChannelUsed).toHaveBeenCalledWith('thread1', 'telegram');
  });

  it('respects explicit Telegram send_as document for image attachments', async () => {
    const recordThreadChannelUsed = vi.fn(async () => null);
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

    const fake = Object.create(ChannelTools.prototype) as any;
    fake.getOriginatingChannelThread = vi.fn(async () => ({
      source: 'channel',
      channel_kind: 'telegram',
      channel_conversation_id: '12345',
    }));
    fake.env = {
      TELEGRAM_BOT_TOKEN: 'bot-token',
      ORG: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({ recordThreadChannelUsed })),
      },
      R2_BUCKET: { get },
    };

    const result = await ChannelTools.prototype['sendChannelTelegramMessageTool'].call(
      fake,
      { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
      {
        attachments: [{ path: 'outputs/chart.png', send_as: 'document' }],
      },
    );

    expect(result.details.messageIds).toEqual([22]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(recordThreadChannelUsed).toHaveBeenCalledWith('thread1', 'telegram');
  });

  describe('agent loop failure & recovery guards', () => {
    // --- sendRunnerCommand: the recoverableTurnStarted guard (deploy recovery) ---

    it('does NOT clear the active-turn marker/journal when a steer-path refresh throws (protects the in-flight turn)', async () => {
      const fake = Object.create(ChatThreadDO.prototype) as any;
      // A message arrives while a turn is already streaming -> steer branch.
      fake.piSession = { state: { isStreaming: true }, steer: vi.fn() };
      fake.ctx = { waitUntil: vi.fn() };
      fake.recordPiTurnJournalSteerMessage = vi.fn();
      // The model refresh fails mid-steer (e.g. the BYOK config vanished).
      fake.refreshPiSessionModel = vi.fn(() =>
        Promise.reject(new Error('config gone')),
      );
      fake.clearPiActiveTurnAndJournal = vi.fn();
      fake.persistPiAgentLoopErrorForDevelopers = vi.fn();
      fake.piProviderErrorEvent = vi.fn((m: string) => ({ type: 'error', error: m }));
      fake.pushChatEvent = vi.fn();
      fake.updateActiveAutomationRun = vi.fn();
      fake.finishTurn = vi.fn();
      fake.setActiveTurnUserId = vi.fn();
      fake.syncAgentState = vi.fn();

      const accepted = ChatThreadDO.prototype['sendRunnerCommand'].call(fake, {
        type: 'message',
        content: 'also rename the table',
      });
      expect(accepted).toBe(true);
      await flushWaitUntil(fake);

      // The original, still-streaming turn already made ITSELF recoverable. A
      // steer-side failure must NOT erase that turn's marker/journal, or a later
      // eviction (e.g. a deploy) would strand it un-resumable — the exact
      // "stuck loading after deploy" failure class this guard exists for.
      expect(fake.recordPiTurnJournalSteerMessage).toHaveBeenCalledTimes(1);
      expect(fake.clearPiActiveTurnAndJournal).not.toHaveBeenCalled();
      // It still surfaces the error and tears down the failed send.
      expect(fake.finishTurn).toHaveBeenCalledTimes(1);
    });

    it('DOES clear the active-turn marker/journal when a new turn it started fails inside the fiber', async () => {
      const fake = Object.create(ChatThreadDO.prototype) as any;
      // No turn in flight -> this call starts a new (recoverable) turn.
      fake.piSession = { state: { isStreaming: false }, prompt: vi.fn() };
      fake.ctx = { waitUntil: vi.fn() };
      fake.openPiActiveTurnIfAbsent = vi.fn();
      fake.recordPiTurnJournalUserMessage = vi.fn();
      fake.runFiber = vi.fn(async (_n: string, fn: () => unknown) => fn());
      fake.withPiTurnInactivityTimeout = vi.fn(async (fn: () => unknown) => fn());
      // The new turn's own prompt setup fails.
      fake.refreshPiSessionModel = vi.fn(() =>
        Promise.reject(new Error('model gone')),
      );
      fake.clearPiActiveTurnAndJournal = vi.fn();
      fake.persistPiAgentLoopErrorForDevelopers = vi.fn();
      fake.piProviderErrorEvent = vi.fn((m: string) => ({ type: 'error', error: m }));
      fake.pushChatEvent = vi.fn();
      fake.updateActiveAutomationRun = vi.fn();
      fake.finishTurn = vi.fn();
      fake.setActiveTurnUserId = vi.fn();
      fake.syncAgentState = vi.fn();

      const accepted = ChatThreadDO.prototype['sendRunnerCommand'].call(fake, {
        type: 'message',
        content: 'build the dashboard',
      });
      expect(accepted).toBe(true);
      await flushWaitUntil(fake);

      // This call started the only turn and made it recoverable, so its OWN
      // failure must clear the now-stale marker/journal — otherwise the next
      // session build mistakes the dead tail for an interrupted turn and reuses
      // its attempt budget.
      expect(fake.openPiActiveTurnIfAbsent).toHaveBeenCalledTimes(1);
      expect(fake.clearPiActiveTurnAndJournal).toHaveBeenCalledTimes(1);
      expect(fake.finishTurn).toHaveBeenCalledTimes(1);
    });

    // --- appendPiCoreMessagesIfMissing: piCoreMessageKey dedup ---

    it('does not double-store the up-front-persisted first user message (dedup by shared key)', async () => {
      const fake = Object.create(ChatThreadDO.prototype) as any;
      const existingUser = { role: 'user', content: 'hello', timestamp: 1234 };
      const appended: any[] = [];
      fake.loadPiCoreMessages = vi.fn(async () => [existingUser]);
      fake.appendPiCoreMessages = vi.fn(async (msgs: any[]) => {
        appended.push(...msgs);
      });

      // The new-chat flow persists the user message up front, then Pi's turn-end
      // commit replays it (same role/content/timestamp -> same piCoreMessageKey)
      // alongside the fresh assistant turn.
      const duplicateUser = { role: 'user', content: 'hello', timestamp: 1234 };
      const newAssistant = {
        role: 'assistant',
        content: 'hi',
        responseId: 'resp_1',
        timestamp: 1235,
      };
      await ChatThreadDO.prototype['appendPiCoreMessagesIfMissing'].call(fake, [
        duplicateUser,
        newAssistant,
      ]);

      // Only the assistant turn is appended; the first user message is not
      // duplicated in the transcript.
      expect(appended).toHaveLength(1);
      expect(appended[0]).toMatchObject({ role: 'assistant', responseId: 'resp_1' });
    });

    it('dedups an assistant message by responseId even when its content/timestamp changed', async () => {
      const fake = Object.create(ChatThreadDO.prototype) as any;
      const existingAssistant = {
        role: 'assistant',
        content: 'partial',
        responseId: 'resp_9',
        timestamp: 1,
      };
      const appended: any[] = [];
      fake.loadPiCoreMessages = vi.fn(async () => [existingAssistant]);
      fake.appendPiCoreMessages = vi.fn(async (msgs: any[]) => {
        appended.push(...msgs);
      });

      // Same responseId, finalized content + later timestamp — must still dedup.
      const finalizedAssistant = {
        role: 'assistant',
        content: 'partial then more',
        responseId: 'resp_9',
        timestamp: 2,
      };
      await ChatThreadDO.prototype['appendPiCoreMessagesIfMissing'].call(fake, [
        finalizedAssistant,
      ]);

      expect(appended).toHaveLength(0);
      expect(fake.appendPiCoreMessages).toHaveBeenCalledWith([]);
    });

    // --- isThreadStreaming: never throws (called on every state sync) ---

    it('isThreadStreaming returns false (never throws) when the active-turn read fails', () => {
      const fake = Object.create(ChatThreadDO.prototype) as any;
      fake.piSession = null;
      fake.readPiActiveTurn = vi.fn(() => {
        throw new Error('kv unavailable');
      });
      // A throw here would crash syncAgentState / onConnect / todo handling for
      // the whole thread, so the derive must swallow it.
      expect(ChatThreadDO.prototype['isThreadStreaming'].call(fake)).toBe(false);
    });

    // --- applyChatEventToLiveState: error finalizes the streaming bubble ---

    it('error event finalizes the streaming overlay bubble (no perpetually-spinning message)', () => {
      const fake = Object.create(ChatThreadDO.prototype) as any;
      fake.chatContext = { threadId: 'thread1' };
      fake.hydrateLiveStateFromAgentState = vi.fn();
      fake.liveMessages = [
        { id: 's1', role: 'assistant', isStreaming: true, content: [] },
      ];
      fake.liveStreamingMessageId = 's1';
      fake.broadcastLiveOverlay = vi.fn();

      ChatThreadDO.prototype['applyChatEventToLiveState'].call(fake, {
        type: 'error',
        error: 'boom',
      });

      // The mid-stream assistant bubble is flipped off and the streaming id
      // cleared, then re-broadcast — otherwise it spins forever until reload.
      expect(fake.liveMessages[0].isStreaming).toBe(false);
      expect(fake.liveStreamingMessageId).toBeNull();
      expect(fake.broadcastLiveOverlay).toHaveBeenCalledTimes(1);
    });
  });

});
