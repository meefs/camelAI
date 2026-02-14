import { DurableObject } from 'cloudflare:workers';
import type { OrgDO } from './auth';
import type { WorkspaceDO } from './workspace';
import {
  WorkspaceContainer,
  type WorkspaceContainerEnv,
} from './workspace-container';
import { SUPPORTED_SLASH_COMMANDS } from '../../../src/lib/slash-commands';

export type PreviewTarget =
  | {
      kind: 'app';
      scriptName: string;
      isPublic: boolean;
    }
  | {
      kind: 'file';
      source: 'workspace' | 'upload' | 'output';
      workspaceId: string;
      path: string;
      filename?: string;
      contentType?: string;
    };

// Dynamic field for custom integrations (matches src/lib/integration-registry.ts)
export interface DynamicField {
  name: string;
  label: string;
  type: 'password' | 'text' | 'url' | 'number';
  required: boolean;
  placeholder?: string;
  description?: string;
}

// Dynamic schema for custom "other" integrations
export interface DynamicIntegrationSchema {
  displayName: string;
  description?: string;
  instructions?: string;
  fields: DynamicField[];
}

// Connection setup prompt request
export interface ConnectionSetupRequest {
  requestId: string;
  integrationType: string; // Required: the integration type to set up
  suggestedName?: string; // Optional: suggested name for the connection
  message?: string; // Optional: message to show user
  createdAt: number;
  dynamicSchema?: DynamicIntegrationSchema; // Optional: custom fields for "other" type
}

// Connection setup response from user
export interface ConnectionSetupResponse {
  requestId: string;
  cancelled: boolean;
  integration?: {
    type: string;
    name: string;
    config: Record<string, unknown>;
    credentials: Record<string, unknown>;
  };
}

// Bug report capture request
export interface BugReportCaptureRequest {
  requestId: string;
  message?: string; // Optional message to show user explaining why capture is needed
  createdAt: number;
}

// Bug report capture response from user
export interface BugReportCaptureResponse {
  requestId: string;
  cancelled: boolean;
  bugReport?: {
    reportPath: string; // R2 path to the bug report JSON
    screenshotPath?: string; // R2 path to the screenshot
    sessionRecordingPath?: string; // R2 path to the session recording
    appName: string;
    appUrl: string;
    userDescription?: string;
  };
}

export interface Thread {
  id: string;
  title: string;
  created_by: string;
  created_at: number;
  updated_at: number;
}

export interface Message {
  id: string;
  thread_id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: number;
}

// Forward declaration for MCP DO RPC methods - used for callback from ChatThreadDO
interface ChiridionMcpRpc {
  receiveConnectionSetupResponse(response: ConnectionSetupResponse): void;
  receiveBugReportCaptureResponse(response: BugReportCaptureResponse): void;
}

export interface ChatEnv extends WorkspaceContainerEnv {
  CHAT_THREAD: DurableObjectNamespace<ChatThreadDO>;
  ORG: DurableObjectNamespace<OrgDO>;
  WORKSPACE: DurableObjectNamespace<WorkspaceDO>;
  MCP_OBJECT: DurableObjectNamespace;
  APP_KV: KVNamespace;
  R2_BUCKET: R2Bucket;
  AI: Ai;
  ANTHROPIC_API_KEY: string;
  CF_ACCOUNT_ID?: string;
  CF_DISPATCH_NAMESPACE?: string;
  EMAIL_TO_USER: KVNamespace;
  R2_MOUNT_DIR?: string;
  PLATFORM_SCRIPT_TOKENS?: KVNamespace;
  DEBUG_CLAUDE_AGENT_SDK?: string;
  SANDBOX_PROXY_SECRET?: string;
}

// Pending connection setup with MCP callback info
interface PendingConnectionSetupInfo {
  mcpDoId: string;
  createdAt: number;
  integrationType: string;
  suggestedName?: string;
  message?: string;
  dynamicSchema?: DynamicIntegrationSchema;
}

// Pending bug report capture with MCP callback info
interface PendingBugReportInfo {
  mcpDoId: string;
  createdAt: number;
  message?: string;
}

interface ChatContextState {
  threadId: string;
  workspaceId: string;
  orgId: string;
  userName: string | null;
  userEmail: string | null;
}

interface PendingQuestionInfo {
  questionId: string;
  toolUseId?: string;
  questions: unknown[];
}

interface ChatClientInitMessage {
  type: 'init';
  threadId?: string;
  lastEventId?: number;
}

interface ChatClientMessage {
  type: 'message';
  content?: string;
}

interface ChatClientQuestionResponse {
  type: 'question_response';
  questionId?: string;
  answers?: Record<string, unknown>;
}

interface ChatClientSetPreviewTarget {
  type: 'set_preview_target';
  target?: PreviewTarget | null;
}

const CHAT_SOCKET_TAG = 'chat';

const CHAT_CONTEXT_KEY = 'chatContext';
const CHAT_TODOS_KEY = 'chatTodos';
const CHAT_NEXT_EVENT_ID_KEY = 'chatNextEventId';
const CHAT_RUNNER_LAST_SEQ_KEY = 'chatRunnerLastSeq';

const MAX_CHAT_EVENT_BUFFER = 500;
const RUNNER_PING_INTERVAL_MS = 10_000;
const RUNNER_RECONNECT_BACKOFF_MS = [250, 500, 1_000, 2_000, 5_000] as const;
const RUNNER_RECONNECT_GRACE_MS = 30_000;

const HEADER_USER_NAME = 'X-Chiridion-User-Name';
const HEADER_USER_EMAIL = 'X-Chiridion-User-Email';

const CHIRIDION_SYSTEM_MESSAGE_REGEX =
  /<chiridion system message>([\s\S]*?)<\/chiridion system message>/gi;
const TRACE_CHAT_THREAD_DO = true;

/**
 * ChatThreadDO - One per thread, holds preview state + chat websocket bridge.
 * Chat path: client WS <-> ChatThreadDO <-> sandbox control plane (/chat WS)
 */
export class ChatThreadDO extends DurableObject<ChatEnv> {
  private static readonly CONNECTION_SETUP_TIMEOUT_MS = 30 * 60 * 1000;
  private static readonly BUG_REPORT_TIMEOUT_MS = 5 * 60 * 1000;

  private previewTarget: PreviewTarget | null = null;
  private previewVersion: number = 0;

  // Pending connection setup requests (requestId -> MCP DO callback info)
  // This is also persisted to storage to survive hibernation
  private pendingConnectionSetups: Map<string, PendingConnectionSetupInfo> = new Map();

  // Pending bug report captures (requestId -> MCP DO callback info)
  private pendingBugReports: Map<string, PendingBugReportInfo> = new Map();

  // Chat bridge state
  private chatContext: ChatContextState | null = null;
  private chatEventBuffer: Array<Record<string, unknown>> = [];
  private nextChatEventId: number = 1;
  private currentTodos: unknown[] = [];
  private pendingQuestions: Map<string, PendingQuestionInfo> = new Map();

  private runnerSocket: WebSocket | null = null;
  private runnerConnectPromise: Promise<void> | null = null;
  private runnerPingTimer: number | null = null;
  private runnerReconnectTimer: number | null = null;
  private runnerDisconnectGraceTimer: number | null = null;
  private runnerReconnectAttempt: number = 0;
  private runnerReconnectArmed: boolean = false;
  private lastRunnerSeq: number = 0;
  private lastPersistedRunnerSeq: number = 0;

  private trace(event: string, details: Record<string, unknown> = {}): void {
    if (!TRACE_CHAT_THREAD_DO) return;
    const context = this.chatContext;
    const payload = {
      event,
      threadId: context?.threadId || '',
      workspaceId: context?.workspaceId || '',
      orgId: context?.orgId || '',
      chatSockets: this.getChatSockets().length,
      hasRunnerSocket: Boolean(this.runnerSocket),
      hasRunnerConnectPromise: Boolean(this.runnerConnectPromise),
      ...details,
    };
    try {
      console.log(`[ChatThreadDO][trace] ${JSON.stringify(payload)}`);
    } catch {
      console.log(`[ChatThreadDO][trace] ${event}`);
    }
  }

  constructor(ctx: DurableObjectState, env: ChatEnv) {
    super(ctx, env);

    // Set up auto-response for ping messages - responds without waking the DO
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(
        JSON.stringify({ type: 'ping' }),
        JSON.stringify({ type: 'pong' })
      )
    );

    // Restore state from storage
    ctx.blockConcurrencyWhile(async () => {
      const storedTarget = ctx.storage.kv.get<PreviewTarget>('previewTarget');
      if (storedTarget) {
        this.previewTarget = storedTarget;
      }
      const version = ctx.storage.kv.get<number>('previewVersion');
      if (typeof version === 'number') {
        this.previewVersion = version;
      }

      // Restore pending connection setups from storage (sync KV)
      const pendingEntries = ctx.storage.kv.list({ prefix: 'pending_connection:' });
      for (const [key, value] of pendingEntries) {
        const info = value as Partial<PendingConnectionSetupInfo>;
        const requestId = key.replace('pending_connection:', '');
        if (
          typeof info?.createdAt === 'number' &&
          typeof info?.mcpDoId === 'string' &&
          typeof info?.integrationType === 'string'
        ) {
          // Only restore if not expired (30 minutes)
          if (Date.now() - info.createdAt < ChatThreadDO.CONNECTION_SETUP_TIMEOUT_MS) {
            this.pendingConnectionSetups.set(requestId, info as PendingConnectionSetupInfo);
          } else {
            ctx.storage.kv.delete(key);
          }
        } else {
          ctx.storage.kv.delete(key);
        }
      }

      // Restore pending bug reports from storage (sync KV)
      const bugReportEntries = ctx.storage.kv.list({ prefix: 'pending_bug_report:' });
      for (const [key, value] of bugReportEntries) {
        const info = value as Partial<PendingBugReportInfo>;
        const requestId = key.replace('pending_bug_report:', '');
        if (typeof info?.createdAt === 'number' && typeof info?.mcpDoId === 'string') {
          if (Date.now() - info.createdAt < ChatThreadDO.BUG_REPORT_TIMEOUT_MS) {
            this.pendingBugReports.set(requestId, info as PendingBugReportInfo);
          } else {
            ctx.storage.kv.delete(key);
          }
        } else {
          ctx.storage.kv.delete(key);
        }
      }

      const storedContext = ctx.storage.kv.get<ChatContextState>(CHAT_CONTEXT_KEY);
      if (storedContext && storedContext.threadId && storedContext.workspaceId && storedContext.orgId) {
        this.chatContext = storedContext;
      }

      const storedTodos = ctx.storage.kv.get<unknown[]>(CHAT_TODOS_KEY);
      if (Array.isArray(storedTodos)) {
        this.currentTodos = storedTodos;
      }

      const storedNextEventId = ctx.storage.kv.get<number>(CHAT_NEXT_EVENT_ID_KEY);
      if (typeof storedNextEventId === 'number' && storedNextEventId > 0) {
        this.nextChatEventId = storedNextEventId;
      }

      const storedRunnerLastSeq = ctx.storage.kv.get<number>(CHAT_RUNNER_LAST_SEQ_KEY);
      if (typeof storedRunnerLastSeq === 'number' && storedRunnerLastSeq > 0) {
        this.lastRunnerSeq = storedRunnerLastSeq;
        this.lastPersistedRunnerSeq = storedRunnerLastSeq;
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    this.trace('fetch', {
      method: request.method,
      path: url.pathname,
      search: url.search,
      isWebSocketUpgrade: request.headers.get('Upgrade') === 'websocket',
    });

    // WebSocket upgrade
    if (request.headers.get('Upgrade') === 'websocket') {
      if (url.pathname !== '/chat') {
        this.trace('ws_upgrade_rejected_path', { path: url.pathname });
        return new Response('Not found', { status: 404 });
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.captureChatContextFromRequest(url, request);
      this.ctx.acceptWebSocket(server, [CHAT_SOCKET_TAG]);
      this.trace('ws_upgrade_accepted', {
        path: url.pathname,
        queryThreadId: url.searchParams.get('threadId') || '',
        queryWorkspaceId: url.searchParams.get('workspaceId') || '',
        queryOrgId: url.searchParams.get('orgId') || '',
      });
      return new Response(null, { status: 101, webSocket: client });
    }

    // HTTP API for setting preview state
    if (url.pathname === '/preview' && request.method === 'POST') {
      const body = await request.json() as { target?: PreviewTarget | null };
      await this.setPreviewTarget(body.target ?? null);
      return new Response(JSON.stringify({
        target: this.previewTarget,
        version: this.previewVersion,
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/preview' && request.method === 'GET') {
      return new Response(JSON.stringify({
        target: this.previewTarget,
        version: this.previewVersion,
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // HTTP API for connection setup prompts (called by MCP server)
    if (url.pathname === '/connection-setup/prompt' && request.method === 'POST') {
      const body = await request.json() as ConnectionSetupRequest & { mcpDoId?: string; dynamicSchema?: DynamicIntegrationSchema };
      const requestId = body.requestId || crypto.randomUUID();
      const mcpDoId = body.mcpDoId;

      if (!mcpDoId) {
        return new Response(JSON.stringify({ error: 'Missing MCP DO ID for callback' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (!body.integrationType) {
        return new Response(JSON.stringify({ error: 'Missing integrationType - connection type must be specified' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const pendingInfo: PendingConnectionSetupInfo = {
        mcpDoId,
        createdAt: Date.now(),
        integrationType: body.integrationType,
        suggestedName: body.suggestedName,
        message: body.message,
        dynamicSchema: body.dynamicSchema,
      };
      this.pendingConnectionSetups.set(requestId, pendingInfo);
      this.ctx.storage.kv.put(`pending_connection:${requestId}`, pendingInfo);

      this.broadcastRealtime({
        type: 'connection_setup_prompt',
        requestId,
        integrationType: body.integrationType,
        suggestedName: body.suggestedName,
        message: body.message,
        dynamicSchema: body.dynamicSchema,
        mcpDoId,
      });

      return new Response(JSON.stringify({ requestId }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // HTTP API for bug report capture prompts (called by MCP server)
    if (url.pathname === '/bug-report/prompt' && request.method === 'POST') {
      const body = await request.json() as BugReportCaptureRequest & { mcpDoId?: string };
      const requestId = body.requestId || crypto.randomUUID();
      const mcpDoId = body.mcpDoId;

      if (!mcpDoId) {
        return new Response(JSON.stringify({ error: 'Missing MCP DO ID for callback' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const pendingInfo: PendingBugReportInfo = {
        mcpDoId,
        createdAt: Date.now(),
        message: body.message,
      };
      this.pendingBugReports.set(requestId, pendingInfo);
      this.ctx.storage.kv.put(`pending_bug_report:${requestId}`, pendingInfo);

      this.broadcastRealtime({
        type: 'bug_report_prompt',
        requestId,
        message: body.message,
      });

      return new Response(JSON.stringify({ requestId }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not found', { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;
    this.trace('chat_ws_message_raw', {
      bytes: message.length,
    });

    let data: { type: string; [key: string]: unknown };
    try {
      data = JSON.parse(message) as { type: string; [key: string]: unknown };
    } catch {
      this.trace('chat_ws_message_invalid_json', {
        bytes: message.length,
      });
      return;
    }
    this.trace('chat_ws_message_parsed', {
      type: data.type,
      bytes: message.length,
    });

    try {
      if (data.type === 'connection_setup_response') {
        await this.handleConnectionSetupResponse(data as unknown as ConnectionSetupResponse);
        return;
      }

      if (data.type === 'bug_report_response') {
        await this.handleBugReportResponse(data as unknown as BugReportCaptureResponse);
        return;
      }

      // Chat transport messages
      if (data.type === 'init') {
        await this.handleChatInit(ws, data as unknown as ChatClientInitMessage);
        return;
      }

      if (data.type === 'message') {
        await this.handleChatMessage(data as unknown as ChatClientMessage);
        return;
      }

      if (data.type === 'stop') {
        await this.handleChatStop();
        return;
      }

      if (data.type === 'question_response') {
        await this.handleQuestionResponse(data as unknown as ChatClientQuestionResponse);
        return;
      }

      if (data.type === 'set_preview_target') {
        await this.handleSetPreviewTarget(data as unknown as ChatClientSetPreviewTarget);
        return;
      }
    } catch (err) {
      console.error(`[ChatThreadDO] webSocketMessage error (type=${data.type}):`, err);
      this.emitChatError(`Internal error handling ${data.type}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  webSocketClose(_ws: WebSocket, code: number, reason: string, wasClean: boolean): void {
    this.trace('chat_ws_close', {
      code,
      reason,
      wasClean,
      remainingChatSockets: this.getChatSockets().length,
    });
    if (this.getChatSockets().length === 0) {
      this.stopRunnerReconnectLoop('no_chat_sockets');
      this.cancelRunnerDisconnectGrace('no_chat_sockets');
    }
    // Intentional no-op: we never detach the runner from the DO side.
    // The sandbox control-plane owns the disconnect lifecycle and will
    // close the WebSocket after 1 minute of idle following a result event.
    // Keeping the runner alive means reconnecting chat clients can
    // immediately resume without re-provisioning the sandbox connection.
  }

  webSocketError(_ws: WebSocket, error: unknown): void {
    this.trace('chat_ws_error', {
      error: String(error),
    });
  }

  getPreviewTarget(): PreviewTarget | null {
    return this.previewTarget;
  }

  async setPreviewTarget(target: PreviewTarget | null): Promise<void> {
    this.previewTarget = this.normalizePreviewTarget(target);
    this.previewVersion++;
    this.ctx.storage.kv.put('previewTarget', this.previewTarget);
    this.ctx.storage.kv.put('previewVersion', this.previewVersion);
    this.broadcastPreviewState();
  }

  async clearPreviewTarget(): Promise<void> {
    await this.setPreviewTarget(null);
  }

  async setPreviewAppVisibility(scriptName: string, isPublic: boolean): Promise<void> {
    if (
      this.previewTarget?.kind !== 'app' ||
      this.previewTarget.scriptName !== scriptName
    ) {
      return;
    }

    this.previewTarget = {
      ...this.previewTarget,
      isPublic,
    };
    this.ctx.storage.kv.put('previewTarget', this.previewTarget);
    this.broadcastPreviewState();
  }

  // Set thread title and broadcast to connected chat clients
  async setTitle(title: string): Promise<void> {
    this.broadcastRealtime({ type: 'title_updated', title });
  }

  private async handleConnectionSetupResponse(response: ConnectionSetupResponse): Promise<void> {
    const pendingInfo = this.pendingConnectionSetups.get(response.requestId);

    if (response.requestId && pendingInfo) {
      this.pendingConnectionSetups.delete(response.requestId);
      this.ctx.storage.kv.delete(`pending_connection:${response.requestId}`);

      try {
        const mcpDoId = this.env.MCP_OBJECT.idFromString(pendingInfo.mcpDoId);
        const mcpStub = this.env.MCP_OBJECT.get(mcpDoId) as unknown as ChiridionMcpRpc;
        await mcpStub.receiveConnectionSetupResponse(response);
      } catch (err) {
        console.error('[ChatThreadDO] Failed to call MCP DO callback:', err);
      }
    }
  }

  private async handleBugReportResponse(response: BugReportCaptureResponse): Promise<void> {
    const pendingInfo = this.pendingBugReports.get(response.requestId);

    if (response.requestId && pendingInfo) {
      this.pendingBugReports.delete(response.requestId);
      this.ctx.storage.kv.delete(`pending_bug_report:${response.requestId}`);

      try {
        const mcpDoId = this.env.MCP_OBJECT.idFromString(pendingInfo.mcpDoId);
        const mcpStub = this.env.MCP_OBJECT.get(mcpDoId) as unknown as ChiridionMcpRpc;
        await mcpStub.receiveBugReportCaptureResponse(response);
      } catch (err) {
        console.error('[ChatThreadDO] Failed to call MCP DO callback for bug report:', err);
      }
    }
  }

  private captureChatContextFromRequest(url: URL, request: Request): void {
    const queryThreadId = url.searchParams.get('threadId')?.trim() || '';
    const queryWorkspaceId = url.searchParams.get('workspaceId')?.trim() || '';
    const queryOrgId = url.searchParams.get('orgId')?.trim() || '';

    const userName = request.headers.get(HEADER_USER_NAME);
    const userEmail = request.headers.get(HEADER_USER_EMAIL);

    const prev = this.chatContext;
    const threadId = queryThreadId || prev?.threadId || '';
    const workspaceId = queryWorkspaceId || prev?.workspaceId || '';
    const orgId = queryOrgId || prev?.orgId || '';

    if (!threadId || !workspaceId || !orgId) {
      this.trace('capture_chat_context_skipped', {
        queryThreadId,
        queryWorkspaceId,
        queryOrgId,
        hadPreviousContext: Boolean(prev),
      });
      return;
    }

    this.chatContext = {
      threadId,
      workspaceId,
      orgId,
      userName: userName || prev?.userName || null,
      userEmail: userEmail || prev?.userEmail || null,
    };

    this.ctx.storage.kv.put(CHAT_CONTEXT_KEY, this.chatContext);
    this.trace('capture_chat_context_set', {
      threadId,
      workspaceId,
      orgId,
      userNamePresent: Boolean(this.chatContext.userName),
      userEmailPresent: Boolean(this.chatContext.userEmail),
    });
  }

  private async handleChatInit(ws: WebSocket, data: ChatClientInitMessage): Promise<void> {
    this.trace('handle_chat_init_start', {
      incomingThreadId: typeof data.threadId === 'string' ? data.threadId : '',
      lastEventId: typeof data.lastEventId === 'number' ? data.lastEventId : null,
    });
    const incomingThreadId = typeof data.threadId === 'string' ? data.threadId.trim() : '';
    if (!incomingThreadId) {
      this.sendDirect(ws, { type: 'error', error: 'Missing threadId - init requires a valid threadId' });
      try {
        ws.close(1008, 'missing threadId');
      } catch {
        // ignore close failures
      }
      return;
    }

    if (!this.chatContext) {
      this.sendDirect(ws, { type: 'error', error: 'Missing chat context for thread' });
      return;
    }

    if (this.chatContext.threadId !== incomingThreadId) {
      this.sendDirect(ws, { type: 'error', error: 'Thread mismatch for this chat connection' });
      return;
    }

    const lastEventId = typeof data.lastEventId === 'number' && Number.isFinite(data.lastEventId)
      ? Math.max(0, Math.floor(data.lastEventId))
      : 0;

    this.sendDirect(ws, { type: 'session', sessionId: this.chatContext.threadId });
    this.sendDirect(ws, { type: 'ready' });
    this.sendDirect(ws, {
      type: 'preview_state',
      target: this.previewTarget,
      version: this.previewVersion,
    });
    this.sendPendingPromptsToWebSocket(ws);

    for (const pending of this.pendingQuestions.values()) {
      this.sendDirect(ws, {
        type: 'ask_user_question',
        questionId: pending.questionId,
        toolUseId: pending.toolUseId,
        questions: pending.questions,
      });
    }

    this.replayChatEvents(ws, lastEventId);

    // Send todo_state AFTER event replay so it arrives after any sdk_event that
    // triggers streaming state. The client clears todos when streaming starts,
    // so sending this last ensures the current todos aren't immediately cleared.
    if (this.currentTodos.length > 0) {
      this.sendDirect(ws, { type: 'todo_state', todos: this.currentTodos });
    }
    this.trace('handle_chat_init_complete', {
      incomingThreadId,
      replayFromEventId: lastEventId,
      bufferedEvents: this.chatEventBuffer.length,
      pendingQuestions: this.pendingQuestions.size,
      currentTodos: this.currentTodos.length,
    });

    // Ensure we are connected to the sandbox control plane so in-flight output can resume.
    void this.ensureRunnerConnected().catch((err) => {
      this.trace('ensure_runner_connected_init_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      this.runnerReconnectArmed = true;
      this.armRunnerDisconnectGrace('chat_init_connect_failed');
      this.scheduleRunnerReconnect('chat_init_connect_failed');
    });
  }

  private async handleChatMessage(data: ChatClientMessage): Promise<void> {
    if (!this.chatContext) {
      this.emitChatError('No session - send init first');
      return;
    }

    const rawContent = typeof data.content === 'string' ? data.content : '';
    const attributedContent = this.formatAttributedUserMessage(rawContent);
    if (!attributedContent) return;
    this.trace('handle_chat_message', {
      rawLength: rawContent.length,
      attributedLength: attributedContent.length,
    });

    await this.ensureRunnerConnected();
    if (!(await this.sendRunnerCommandWithReconnect({ type: 'message', content: attributedContent }))) {
      this.emitChatError('Failed to send message to sandbox');
      return;
    }

    this.ctx.waitUntil(
      this.touchThreadForUserMessage().catch((err) => {
        console.error('[ChatThreadDO] failed to touch thread after user message', err);
      })
    );
  }

  private async handleChatStop(): Promise<void> {
    this.trace('handle_chat_stop');
    await this.sendRunnerCommandWithReconnect({ type: 'stop' });
  }

  private async handleQuestionResponse(data: ChatClientQuestionResponse): Promise<void> {
    this.trace('handle_question_response', {
      questionId: data.questionId || '',
      hasAnswers: Boolean(data.answers && typeof data.answers === 'object'),
    });
    if (!data.questionId || !data.answers || typeof data.answers !== 'object') {
      this.emitChatError('Missing questionId or answers');
      return;
    }

    if (!(await this.sendRunnerCommandWithReconnect({
      type: 'question_response',
      questionId: data.questionId,
      answers: data.answers,
    }))) {
      this.emitChatError('Sandbox is not connected');
    }
  }

  private static readonly SLASH_COMMANDS = new Set<string>(SUPPORTED_SLASH_COMMANDS);
  private async handleSetPreviewTarget(data: ChatClientSetPreviewTarget): Promise<void> {
    if (!this.chatContext) {
      this.emitChatError('No session - send init first');
      return;
    }

    const normalized = this.normalizePreviewTarget(data.target ?? null);

    if (normalized?.kind === 'file') {
      if (normalized.workspaceId !== this.chatContext.workspaceId) {
        this.emitChatError('Invalid preview target workspace');
        return;
      }
    }

    await this.setPreviewTarget(normalized);
  }

  private normalizePreviewTarget(target: PreviewTarget | null | undefined): PreviewTarget | null {
    if (!target || typeof target !== 'object') {
      return null;
    }

    if (target.kind === 'app') {
      const scriptName = target.scriptName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 63);
      if (!scriptName) return null;
      return {
        kind: 'app',
        scriptName,
        isPublic: Boolean(target.isPublic),
      };
    }

    if (target.kind === 'file') {
      const source = target.source;
      if (source !== 'workspace' && source !== 'upload' && source !== 'output') {
        return null;
      }

      const workspaceId = typeof target.workspaceId === 'string' ? target.workspaceId.trim() : '';
      const path = typeof target.path === 'string' ? target.path.trim() : '';

      if (!workspaceId || !path || path.includes('..')) {
        return null;
      }

      return {
        kind: 'file',
        source,
        workspaceId,
        path,
        filename: typeof target.filename === 'string' ? target.filename.trim() : undefined,
        contentType: typeof target.contentType === 'string' ? target.contentType : undefined,
      };
    }

    return null;
  }

  private broadcastPreviewState(): void {
    this.broadcastRealtime({
      type: 'preview_state',
      target: this.previewTarget,
      version: this.previewVersion,
    });
  }

  private formatAttributedUserMessage(content: string): string {
    if (!content) return '';

    const contextMessages: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = CHIRIDION_SYSTEM_MESSAGE_REGEX.exec(content)) !== null) {
      const value = typeof match[1] === 'string' ? match[1].trim() : '';
      if (value) {
        contextMessages.push(value);
      }
    }
    CHIRIDION_SYSTEM_MESSAGE_REGEX.lastIndex = 0;

    const userMessage = content
      .replace(CHIRIDION_SYSTEM_MESSAGE_REGEX, '')
      .trim();
    CHIRIDION_SYSTEM_MESSAGE_REGEX.lastIndex = 0;

    // Pass slash commands through without author attribution so the
    // Claude SDK recognises them as bare `/command` inputs.
    const isSlashCommand = ChatThreadDO.SLASH_COMMANDS.has(userMessage);

    const userName = this.chatContext?.userName;
    const userEmail = this.chatContext?.userEmail;
    const authorPrefix = isSlashCommand ? '' : this.formatAuthorPrefix(userName, userEmail);
    const attributedUserMessage = userMessage ? `${authorPrefix}${userMessage}` : '';

    const contextualPrefix = contextMessages.length > 0
      ? contextMessages
          .map((messageText) => `<chiridion system message>${messageText}</chiridion system message>`)
          .join('\n\n')
      : '';

    return [contextualPrefix, attributedUserMessage]
      .filter(Boolean)
      .join('\n\n')
      .trim();
  }

  private formatAuthorPrefix(userName: string | null | undefined, userEmail: string | null | undefined): string {
    if (userName && userEmail) return `[${userName} (${userEmail})]: `;
    if (userName) return `[${userName}]: `;
    if (userEmail) return `[${userEmail}]: `;
    return '';
  }

  private async touchThreadForUserMessage(): Promise<void> {
    const context = this.chatContext;
    if (!context?.orgId || !context?.threadId) return;

    const orgStub = this.env.ORG.get(this.env.ORG.idFromName(context.orgId));
    await orgStub.touchThread(context.threadId);
  }

  private async ensureRunnerConnected(): Promise<void> {
    if (this.runnerSocket) {
      console.log(`[ChatThreadDO] ensureRunnerConnected: already connected`);
      this.trace('ensure_runner_connected_already_connected');
      return;
    }
    if (this.runnerConnectPromise) {
      console.log(`[ChatThreadDO] ensureRunnerConnected: waiting on existing connect`);
      this.trace('ensure_runner_connected_wait_existing');
      await this.runnerConnectPromise;
      return;
    }

    this.runnerConnectPromise = (async () => {
      const context = this.chatContext;
      if (!context) {
        throw new Error('Missing chat context');
      }

      console.log(`[ChatThreadDO] ensureRunnerConnected: connecting for thread=${context.threadId}`);
      this.trace('ensure_runner_connected_start', {
        contextThreadId: context.threadId,
        contextWorkspaceId: context.workspaceId,
        contextOrgId: context.orgId,
      });

      const container = new WorkspaceContainer(this.env, context.workspaceId, context.orgId);
      const proxySessionId = crypto.randomUUID();

      // Build thread-specific env (integration creds + thread ID).
      const envVars = await container.buildClaudeRunnerEnv({
        threadId: context.threadId,
        proxySessionId,
      });
      this.trace('ensure_runner_env_built', {
        envVarCount: Object.keys(envVars).length,
        proxySessionId,
      });

      // Open WebSocket to the control plane's /chat endpoint.
      const chatWs = await container.connectChatWebSocket({
        threadId: context.threadId,
        proxySessionId,
      });
      this.attachRunnerSocket(chatWs);
      this.trace('ensure_runner_ws_connected', {
        proxySessionId,
      });

      // Send init message with thread ID and env vars.
      if (!this.sendRunnerCommand({
        type: 'init',
        threadId: context.threadId,
        env: envVars,
        lastSeq: this.lastRunnerSeq,
      })) {
        throw new Error('Failed to send init command - connection broken');
      }

      console.log(`[ChatThreadDO] ensureRunnerConnected: connected for thread=${context.threadId}`);
      this.runnerReconnectArmed = false;
      this.runnerReconnectAttempt = 0;
      this.cancelRunnerDisconnectGrace('runner_connected');
      this.stopRunnerReconnectLoop('runner_connected');
      this.trace('ensure_runner_connected_complete', {
        proxySessionId,
        lastSeq: this.lastRunnerSeq,
      });
    })();

    try {
      await this.runnerConnectPromise;
    } finally {
      this.runnerConnectPromise = null;
    }
  }

  private attachRunnerSocket(ws: WebSocket): void {
    this.runnerSocket = ws;
    this.trace('runner_socket_attached');

    ws.addEventListener('message', (event: MessageEvent) => {
      if (typeof event.data !== 'string') return;
      try {
        const parsed = JSON.parse(event.data) as Record<string, unknown>;
        this.trace('runner_socket_message', {
          type: typeof parsed.type === 'string' ? parsed.type : 'unknown',
          bytes: event.data.length,
        });
        this.handleRunnerEvent(parsed);
      } catch {
        // Non-JSON messages from the control plane; ignore.
        this.trace('runner_socket_message_non_json', {
          bytes: event.data.length,
        });
      }
    });

    ws.addEventListener('close', (event) => {
      this.stopRunnerPingLoop('runner_socket_close');
      this.runnerSocket = null;
      console.log(`[ChatThreadDO] runner websocket closed (code=${event.code})`);
      this.trace('runner_socket_closed', {
        code: event.code,
        reason: event.reason || '',
      });
      if (this.getChatSockets().length > 0) {
        this.runnerReconnectArmed = true;
        this.armRunnerDisconnectGrace('runner_socket_close');
        this.scheduleRunnerReconnect('runner_socket_close');
      }
    });

    ws.addEventListener('error', (err) => {
      this.stopRunnerPingLoop('runner_socket_error');
      console.error('[ChatThreadDO] runner websocket error', err);
      this.trace('runner_socket_error', {
        error: String(err),
      });
    });

    // Accept after handlers are attached so no early messages are lost.
    ws.accept();
    this.startRunnerPingLoop();
  }

  private handleRunnerEvent(event: Record<string, unknown>): void {
    const eventType = typeof event.type === 'string' ? event.type : '';
    const seq = typeof event.seq === 'number' && Number.isFinite(event.seq)
      ? Math.max(0, Math.floor(event.seq))
      : null;

    if (seq !== null) {
      if (seq <= this.lastRunnerSeq) {
        this.trace('runner_event_deduped', {
          seq,
          lastRunnerSeq: this.lastRunnerSeq,
          eventType: eventType || 'unknown',
        });
        return;
      }
      if (seq > this.lastRunnerSeq + 1) {
        this.trace('runner_event_seq_gap', {
          seq,
          lastRunnerSeq: this.lastRunnerSeq,
          eventType: eventType || 'unknown',
        });
      }
      this.lastRunnerSeq = seq;
      this.persistRunnerSeqIfNeeded('event');
    }

    this.trace('handle_runner_event', {
      eventType: eventType || 'unknown',
      seq,
    });

    if (eventType === 'pong') {
      this.trace('runner_pong_received', {
        ts: typeof event.ts === 'number' ? event.ts : null,
      });
      return;
    }

    if (eventType === 'replay_gap') {
      this.trace('runner_replay_gap', {
        oldestSeq: typeof event.oldestSeq === 'number' ? event.oldestSeq : null,
        newestSeq: typeof event.newestSeq === 'number' ? event.newestSeq : null,
        requestedAfterSeq: typeof event.requestedAfterSeq === 'number' ? event.requestedAfterSeq : null,
      });
      return;
    }

    if (eventType === 'error') {
      console.error(`[ChatThreadDO] runner error: ${JSON.stringify({ error: event.error, source: event.source }).slice(0, 500)}`);
    }

    if (eventType === 'todo_state') {
      const todos = event.todos;
      if (Array.isArray(todos)) {
        this.currentTodos = todos;
        this.ctx.storage.kv.put(CHAT_TODOS_KEY, todos);
      }
    }

    if (eventType === 'ask_user_question') {
      const questionId = typeof event.questionId === 'string' ? event.questionId : '';
      const questions = Array.isArray(event.questions) ? event.questions : [];
      if (questionId && questions.length > 0) {
        if (this.pendingQuestions.has(questionId)) {
          this.trace('runner_question_duplicate', { questionId, seq });
          return;
        }
        this.pendingQuestions.set(questionId, {
          questionId,
          toolUseId: typeof event.toolUseId === 'string' ? event.toolUseId : undefined,
          questions,
        });
      }
    }

    if (eventType === 'question_answered') {
      const questionId = typeof event.questionId === 'string' ? event.questionId : '';
      if (questionId) {
        this.pendingQuestions.delete(questionId);
      }
    }

    if (eventType === 'sdk_event') {
      const sdkEvent = event.event as { type?: string } | undefined;
      if (sdkEvent?.type === 'result') {
        this.currentTodos = [];
        this.ctx.storage.kv.delete(CHAT_TODOS_KEY);
        this.persistRunnerSeqIfNeeded('result');
      }
    }

    if (eventType === 'session' || eventType === 'ready') {
      // These are synthesized by ChatThreadDO on init.
      return;
    }

    this.pushChatEvent(event);
  }

  private persistRunnerSeqIfNeeded(reason: 'event' | 'result' | 'disconnect'): void {
    if (this.lastRunnerSeq <= this.lastPersistedRunnerSeq) return;
    const delta = this.lastRunnerSeq - this.lastPersistedRunnerSeq;
    if (reason === 'event' && delta < 25) return;
    this.lastPersistedRunnerSeq = this.lastRunnerSeq;
    this.ctx.storage.kv.put(CHAT_RUNNER_LAST_SEQ_KEY, this.lastRunnerSeq);
    this.trace('runner_seq_persisted', {
      reason,
      lastRunnerSeq: this.lastRunnerSeq,
    });
  }

  private armRunnerDisconnectGrace(source: string): void {
    this.cancelRunnerDisconnectGrace('rearm');
    this.runnerDisconnectGraceTimer = setTimeout(() => {
      this.runnerDisconnectGraceTimer = null;
      this.runnerReconnectArmed = false;
      this.stopRunnerReconnectLoop('disconnect_grace_expired');
      this.persistRunnerSeqIfNeeded('disconnect');
      if (this.runnerSocket || this.getChatSockets().length === 0) return;
      this.trace('runner_disconnect_grace_expired', {
        source,
        lastRunnerSeq: this.lastRunnerSeq,
      });
      this.pushChatEvent({
        type: 'sdk_event',
        event: { type: 'result', subtype: 'runner_disconnected' },
      });
    }, RUNNER_RECONNECT_GRACE_MS) as unknown as number;
    this.trace('runner_disconnect_grace_armed', {
      source,
      timeoutMs: RUNNER_RECONNECT_GRACE_MS,
    });
  }

  private cancelRunnerDisconnectGrace(reason: string): void {
    if (this.runnerDisconnectGraceTimer === null) return;
    clearTimeout(this.runnerDisconnectGraceTimer);
    this.runnerDisconnectGraceTimer = null;
    this.trace('runner_disconnect_grace_cleared', { reason });
  }

  private scheduleRunnerReconnect(reason: string): void {
    if (!this.runnerReconnectArmed) return;
    if (this.runnerSocket || this.runnerConnectPromise || this.runnerReconnectTimer !== null) return;
    const attemptIndex = Math.min(this.runnerReconnectAttempt, RUNNER_RECONNECT_BACKOFF_MS.length - 1);
    const delayMs = RUNNER_RECONNECT_BACKOFF_MS[attemptIndex];
    this.runnerReconnectAttempt += 1;
    this.runnerReconnectTimer = setTimeout(() => {
      this.runnerReconnectTimer = null;
      void this.tryRunnerReconnect('timer');
    }, delayMs) as unknown as number;
    this.trace('runner_reconnect_scheduled', {
      reason,
      attempt: this.runnerReconnectAttempt,
      delayMs,
    });
  }

  private async tryRunnerReconnect(source: string): Promise<void> {
    if (!this.runnerReconnectArmed) return;
    if (this.runnerSocket || this.runnerConnectPromise) return;
    if (!this.chatContext) return;

    try {
      await this.ensureRunnerConnected();
      this.trace('runner_reconnect_succeeded', {
        source,
        attempt: this.runnerReconnectAttempt,
      });
    } catch (err) {
      this.trace('runner_reconnect_failed', {
        source,
        attempt: this.runnerReconnectAttempt,
        error: err instanceof Error ? err.message : String(err),
      });
      this.scheduleRunnerReconnect('connect_failed');
    }
  }

  private stopRunnerReconnectLoop(reason: string): void {
    if (this.runnerReconnectTimer !== null) {
      clearTimeout(this.runnerReconnectTimer);
      this.runnerReconnectTimer = null;
    }
    this.runnerReconnectAttempt = 0;
    this.runnerReconnectArmed = false;
    this.trace('runner_reconnect_stopped', { reason });
  }

  private sendRunnerCommand(message: Record<string, unknown>): boolean {
    if (!this.runnerSocket) return false;
    try {
      this.runnerSocket.send(JSON.stringify(message));
      this.trace('send_runner_command', {
        type: typeof message.type === 'string' ? message.type : 'unknown',
      });
      return true;
    } catch {
      this.runnerSocket = null;
      this.trace('send_runner_command_failed', {
        type: typeof message.type === 'string' ? message.type : 'unknown',
      });
      return false;
    }
  }

  private async sendRunnerCommandWithReconnect(message: Record<string, unknown>): Promise<boolean> {
    if (this.sendRunnerCommand(message)) return true;
    this.runnerReconnectArmed = true;
    this.armRunnerDisconnectGrace('send_retry');
    try {
      await this.ensureRunnerConnected();
    } catch {
      this.scheduleRunnerReconnect('send_retry_connect_failed');
      return false;
    }
    return this.sendRunnerCommand(message);
  }

  private startRunnerPingLoop(): void {
    this.stopRunnerPingLoop('restart');
    this.runnerPingTimer = setInterval(() => {
      const sent = this.sendRunnerCommand({ type: 'ping', ts: Date.now() });
      this.trace(sent ? 'runner_ping_sent' : 'runner_ping_send_failed');
      if (!sent && this.getChatSockets().length > 0) {
        this.runnerReconnectArmed = true;
        this.armRunnerDisconnectGrace('runner_ping_send_failed');
        this.scheduleRunnerReconnect('runner_ping_send_failed');
      }
    }, RUNNER_PING_INTERVAL_MS) as unknown as number;
    this.trace('runner_ping_started', { intervalMs: RUNNER_PING_INTERVAL_MS });
  }

  private stopRunnerPingLoop(reason: string): void {
    if (this.runnerPingTimer === null) return;
    clearInterval(this.runnerPingTimer);
    this.runnerPingTimer = null;
    this.trace('runner_ping_stopped', { reason });
  }

  private emitChatError(message: string): void {
    this.pushChatEvent({ type: 'error', error: message });
  }

  private pushChatEvent(payload: Record<string, unknown>): void {
    const sessionId = this.chatContext?.threadId || '';
    const eventId = this.nextChatEventId++;
    this.ctx.storage.kv.put(CHAT_NEXT_EVENT_ID_KEY, this.nextChatEventId);

    const envelope: Record<string, unknown> = {
      ...payload,
      eventId,
      sessionId,
    };

    this.chatEventBuffer.push(envelope);
    if (this.chatEventBuffer.length > MAX_CHAT_EVENT_BUFFER) {
      this.chatEventBuffer.shift();
    }
    this.trace('push_chat_event', {
      payloadType: typeof payload.type === 'string' ? payload.type : 'unknown',
      eventId,
      bufferSize: this.chatEventBuffer.length,
    });

    this.broadcastChat(envelope);
  }

  private replayChatEvents(ws: WebSocket, lastEventId: number): void {
    for (const envelope of this.chatEventBuffer) {
      const eventId = typeof envelope.eventId === 'number' ? envelope.eventId : 0;
      if (eventId > lastEventId) {
        this.sendDirect(ws, envelope);
      }
    }
  }

  private getChatSockets(): WebSocket[] {
    return this.ctx.getWebSockets(CHAT_SOCKET_TAG);
  }

  private broadcastChat(message: object): void {
    const json = JSON.stringify(message);
    const typed = message as { type?: unknown };
    this.trace('broadcast_chat', {
      payloadType: typeof typed.type === 'string' ? typed.type : 'unknown',
      bytes: json.length,
      recipients: this.getChatSockets().length,
    });
    for (const ws of this.getChatSockets()) {
      try {
        ws.send(json);
      } catch {
        // ignore closed sockets
      }
    }
  }

  private broadcastRealtime(message: object): void {
    this.broadcastChat(message);
  }

  private sendDirect(ws: WebSocket, message: object): void {
    try {
      const json = JSON.stringify(message);
      const typed = message as { type?: unknown };
      this.trace('send_direct', {
        payloadType: typeof typed.type === 'string' ? typed.type : 'unknown',
        bytes: json.length,
      });
      ws.send(json);
    } catch {
      // ignore socket failures
    }
  }

  private pruneExpiredPendingPrompts(): void {
    const now = Date.now();

    for (const [requestId, info] of this.pendingConnectionSetups.entries()) {
      if (now - info.createdAt >= ChatThreadDO.CONNECTION_SETUP_TIMEOUT_MS) {
        this.pendingConnectionSetups.delete(requestId);
        this.ctx.storage.kv.delete(`pending_connection:${requestId}`);
      }
    }

    for (const [requestId, info] of this.pendingBugReports.entries()) {
      if (now - info.createdAt >= ChatThreadDO.BUG_REPORT_TIMEOUT_MS) {
        this.pendingBugReports.delete(requestId);
        this.ctx.storage.kv.delete(`pending_bug_report:${requestId}`);
      }
    }
  }

  private sendPendingPromptsToWebSocket(ws: WebSocket): void {
    this.pruneExpiredPendingPrompts();

    const pendingConnectionPrompts = Array.from(this.pendingConnectionSetups.entries())
      .sort(([, a], [, b]) => a.createdAt - b.createdAt);
    for (const [requestId, info] of pendingConnectionPrompts) {
      this.sendDirect(ws, {
        type: 'connection_setup_prompt',
        requestId,
        integrationType: info.integrationType,
        suggestedName: info.suggestedName,
        message: info.message,
        dynamicSchema: info.dynamicSchema,
        mcpDoId: info.mcpDoId,
      });
    }

    const pendingBugReportPrompts = Array.from(this.pendingBugReports.entries())
      .sort(([, a], [, b]) => a.createdAt - b.createdAt);
    for (const [requestId, info] of pendingBugReportPrompts) {
      this.sendDirect(ws, {
        type: 'bug_report_prompt',
        requestId,
        message: info.message,
      });
    }
  }
}
