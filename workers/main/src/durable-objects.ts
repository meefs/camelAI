import { DurableObject } from 'cloudflare:workers';
import type { OrgDO } from './auth';
import type { WorkspaceDO } from './workspace';
import {
  getWorkspaceContainer,
  type WorkspaceContainer,
  type WorkspaceContainerEnv,
} from './workspace-container';

// Preview state for a thread
export interface PreviewState {
  workers: string[]; // Worker script names to preview
  isPublic?: boolean;
}

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
  R2_BUCKET_NAME?: string;
  R2_ACCOUNT_ID?: string;
  R2_MOUNT_DIR?: string;
  R2_MOUNT_READONLY?: string;
  R2_API_TOKEN?: string;
  R2_PARENT_ACCESS_KEY_ID?: string;
  PLATFORM_SCRIPT_TOKENS?: KVNamespace;
  DEBUG_CLAUDE_AGENT_SDK?: string;
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
  threadDeployToken: string | null;
  mcpToken: string | null;
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

const CHAT_SOCKET_TAG = 'chat';

const RUNNER_SESSION_ID_KEY = 'chatRunnerSessionId';
const CHAT_CONTEXT_KEY = 'chatContext';
const CHAT_TODOS_KEY = 'chatTodos';
const CHAT_NEXT_EVENT_ID_KEY = 'chatNextEventId';

const MAX_CHAT_EVENT_BUFFER = 500;

const HEADER_THREAD_DEPLOY_TOKEN = 'X-Chiridion-Thread-Deploy-Token';
const HEADER_MCP_TOKEN = 'X-Chiridion-MCP-Token';
const HEADER_USER_NAME = 'X-Chiridion-User-Name';
const HEADER_USER_EMAIL = 'X-Chiridion-User-Email';

const STREAM_ID_STDIN = 0;
const STREAM_ID_STDOUT = 1;
const STREAM_ID_STDERR = 2;
const STREAM_ID_EXIT = 3;

const CHIRIDION_SYSTEM_MESSAGE_REGEX =
  /<chiridion system message>([\s\S]*?)<\/chiridion system message>/gi;

/**
 * ChatThreadDO - One per thread, holds preview state + chat websocket bridge.
 * Chat path: client WS <-> ChatThreadDO <-> Sprites exec (Claude runner process)
 */
export class ChatThreadDO extends DurableObject<ChatEnv> {
  private static readonly CONNECTION_SETUP_TIMEOUT_MS = 30 * 60 * 1000;
  private static readonly BUG_REPORT_TIMEOUT_MS = 5 * 60 * 1000;

  private previewWorkers: string[] = [];
  private previewVersion: number = 0;
  private previewIsPublic: boolean = false;

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

  private runtime: WorkspaceContainer | null = null;
  private runnerSocket: WebSocket | null = null;
  private runnerConnectPromise: Promise<void> | null = null;
  private runnerDetachedByUs: boolean = false;
  private runnerSessionId: number | null = null;
  private runnerStdoutBuffer = '';

  private readonly textEncoder = new TextEncoder();
  private readonly textDecoder = new TextDecoder();

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
      const stored = ctx.storage.kv.get<string[]>('previewWorkers');
      if (stored) {
        this.previewWorkers = stored;
      }
      const version = ctx.storage.kv.get<number>('previewVersion');
      if (typeof version === 'number') {
        this.previewVersion = version;
      }
      const storedIsPublic = ctx.storage.kv.get<boolean>('previewIsPublic');
      if (typeof storedIsPublic === 'boolean') {
        this.previewIsPublic = storedIsPublic;
      } else if (this.previewWorkers[0]) {
        try {
          const scriptStored = await this.env.APP_KV.get(`script_org:${this.previewWorkers[0]}`);
          if (scriptStored) {
            try {
              const parsed = JSON.parse(scriptStored) as { is_public?: boolean };
              if (typeof parsed.is_public === 'boolean') {
                this.previewIsPublic = parsed.is_public;
              } else {
                this.previewIsPublic = true;
              }
              ctx.storage.kv.put('previewIsPublic', this.previewIsPublic);
            } catch {
              this.previewIsPublic = true;
              ctx.storage.kv.put('previewIsPublic', this.previewIsPublic);
            }
          }
        } catch (err) {
          console.error('[ChatThreadDO] Failed to backfill preview visibility', err);
        }
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

      const storedRunnerSessionId = ctx.storage.kv.get<number>(RUNNER_SESSION_ID_KEY);
      if (typeof storedRunnerSessionId === 'number' && Number.isFinite(storedRunnerSessionId)) {
        this.runnerSessionId = storedRunnerSessionId;
      }

      const storedTodos = ctx.storage.kv.get<unknown[]>(CHAT_TODOS_KEY);
      if (Array.isArray(storedTodos)) {
        this.currentTodos = storedTodos;
      }

      const storedNextEventId = ctx.storage.kv.get<number>(CHAT_NEXT_EVENT_ID_KEY);
      if (typeof storedNextEventId === 'number' && storedNextEventId > 0) {
        this.nextChatEventId = storedNextEventId;
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket upgrade
    if (request.headers.get('Upgrade') === 'websocket') {
      if (url.pathname !== '/chat') {
        return new Response('Not found', { status: 404 });
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.captureChatContextFromRequest(url, request);
      this.ctx.acceptWebSocket(server, [CHAT_SOCKET_TAG]);
      return new Response(null, { status: 101, webSocket: client });
    }

    // HTTP API for setting preview state
    if (url.pathname === '/preview' && request.method === 'POST') {
      const body = await request.json() as { workers?: string[]; isPublic?: boolean };
      if (body.workers) {
        await this.setPreviewWorkers(body.workers, body.isPublic);
      }
      return new Response(JSON.stringify({
        workers: this.previewWorkers,
        isPublic: this.previewIsPublic,
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/preview' && request.method === 'GET') {
      return new Response(JSON.stringify({
        workers: this.previewWorkers,
        isPublic: this.previewIsPublic,
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

    let data: { type: string; [key: string]: unknown };
    try {
      data = JSON.parse(message) as { type: string; [key: string]: unknown };
    } catch {
      return;
    }

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
  }

  webSocketClose(): void {
    // Detach runner transport when no chat clients are connected. The sprite session
    // continues running and can be reattached via runnerSessionId.
    if (this.getChatSockets().length === 0) {
      this.detachRunnerSocket();
    }
  }

  // Get preview workers
  getPreviewWorkers(): string[] {
    return this.previewWorkers;
  }

  // Set preview workers and broadcast to connected chat clients
  async setPreviewWorkers(workers: string[], isPublic?: boolean): Promise<void> {
    this.previewWorkers = workers;
    if (workers.length === 0) {
      this.previewIsPublic = false;
    } else if (typeof isPublic === 'boolean') {
      this.previewIsPublic = isPublic;
    }
    this.previewVersion++;
    this.ctx.storage.kv.put('previewWorkers', workers);
    this.ctx.storage.kv.put('previewVersion', this.previewVersion);
    this.ctx.storage.kv.put('previewIsPublic', this.previewIsPublic);
    this.broadcastRealtime({
      type: 'preview_state',
      workers: this.previewWorkers,
      version: this.previewVersion,
      isPublic: this.previewIsPublic,
    });
  }

  // Update preview visibility without bumping version (avoid iframe reloads)
  async setPreviewVisibility(isPublic: boolean): Promise<void> {
    this.previewIsPublic = isPublic;
    this.ctx.storage.kv.put('previewIsPublic', this.previewIsPublic);
    this.broadcastRealtime({
      type: 'preview_state',
      workers: this.previewWorkers,
      version: this.previewVersion,
      isPublic: this.previewIsPublic,
    });
  }

  // Add a worker to preview list
  async addPreviewWorker(worker: string): Promise<void> {
    if (!this.previewWorkers.includes(worker)) {
      this.previewWorkers.push(worker);
      this.ctx.storage.kv.put('previewWorkers', this.previewWorkers);
      this.broadcastRealtime({
        type: 'preview_state',
        workers: this.previewWorkers,
        isPublic: this.previewIsPublic,
      });
    }
  }

  // Remove a worker from preview list
  async removePreviewWorker(worker: string): Promise<void> {
    const index = this.previewWorkers.indexOf(worker);
    if (index !== -1) {
      this.previewWorkers.splice(index, 1);
      if (this.previewWorkers.length === 0) {
        this.previewIsPublic = false;
        this.ctx.storage.kv.put('previewIsPublic', this.previewIsPublic);
      }
      this.ctx.storage.kv.put('previewWorkers', this.previewWorkers);
      this.broadcastRealtime({
        type: 'preview_state',
        workers: this.previewWorkers,
        isPublic: this.previewIsPublic,
      });
    }
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
    const threadDeployToken = request.headers.get(HEADER_THREAD_DEPLOY_TOKEN);
    const mcpToken = request.headers.get(HEADER_MCP_TOKEN);

    const prev = this.chatContext;
    const threadId = queryThreadId || prev?.threadId || '';
    const workspaceId = queryWorkspaceId || prev?.workspaceId || '';
    const orgId = queryOrgId || prev?.orgId || '';

    if (!threadId || !workspaceId || !orgId) {
      return;
    }

    this.chatContext = {
      threadId,
      workspaceId,
      orgId,
      userName: userName || prev?.userName || null,
      userEmail: userEmail || prev?.userEmail || null,
      threadDeployToken: threadDeployToken || prev?.threadDeployToken || null,
      mcpToken: mcpToken || prev?.mcpToken || null,
    };

    this.ctx.storage.kv.put(CHAT_CONTEXT_KEY, this.chatContext);
  }

  private async handleChatInit(ws: WebSocket, data: ChatClientInitMessage): Promise<void> {
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
      workers: this.previewWorkers,
      version: this.previewVersion,
      isPublic: this.previewIsPublic,
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

    // Ensure we are attached to the sprite exec stream so in-flight output can resume.
    void this.ensureRunnerConnected().catch((err) => {
      this.emitChatError(`Failed to connect to sprite runner: ${String(err)}`);
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

    await this.ensureRunnerConnected();
    this.sendRunnerCommand({
      type: 'message',
      content: attributedContent,
    });
  }

  private async handleChatStop(): Promise<void> {
    if (!this.runnerSocket) return;
    this.sendRunnerCommand({ type: 'stop' });
  }

  private async handleQuestionResponse(data: ChatClientQuestionResponse): Promise<void> {
    if (!this.runnerSocket) {
      this.emitChatError('No session');
      return;
    }

    if (!data.questionId || !data.answers || typeof data.answers !== 'object') {
      this.emitChatError('Missing questionId or answers');
      return;
    }

    this.sendRunnerCommand({
      type: 'question_response',
      questionId: data.questionId,
      answers: data.answers,
    });
  }

  private static readonly SLASH_COMMANDS = new Set([
    '/compact',
    '/context',
    '/debug',
    '/insights',
    '/security-review',
  ]);

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

  private async ensureRunnerConnected(): Promise<void> {
    if (this.runnerSocket) return;
    if (this.runnerConnectPromise) {
      await this.runnerConnectPromise;
      return;
    }

    this.runnerConnectPromise = (async () => {
      const context = this.chatContext;
      if (!context) {
        throw new Error('Missing chat context');
      }

      if (!this.runtime) {
        this.runtime = getWorkspaceContainer(this.env, context.workspaceId);
      }

      await this.runtime.startForWorkspace(context.workspaceId, context.orgId);

      // First try attaching to an existing long-running runner session.
      if (typeof this.runnerSessionId === 'number') {
        try {
          const attached = await this.runtime.connectExecWebSocket({
            sessionId: `${this.runnerSessionId}`,
          });
          this.attachRunnerSocket(attached);
          return;
        } catch {
          this.runnerSessionId = null;
          this.ctx.storage.kv.delete(RUNNER_SESSION_ID_KEY);
        }
      }

      // Start a new runner process.
      const envVars = await this.runtime.buildClaudeRunnerEnv({
        threadId: context.threadId,
        threadDeployToken: context.threadDeployToken,
        mcpToken: context.mcpToken,
      });

      const cmd = this.runtime.runnerExecCommand;

      const runnerWs = await this.runtime.connectExecWebSocket({
        cmd,
        env: envVars,
        stdin: true,
        tty: false,
        maxRunAfterDisconnect: '30m',
      });

      this.attachRunnerSocket(runnerWs);
    })();

    try {
      await this.runnerConnectPromise;
    } finally {
      this.runnerConnectPromise = null;
    }
  }

  private attachRunnerSocket(ws: WebSocket): void {
    this.runnerSocket = ws;
    this.runnerStdoutBuffer = '';

    ws.addEventListener('message', (event: MessageEvent) => {
      try {
        this.handleRunnerSocketMessage(event.data);
      } catch (err) {
        console.error('[ChatThreadDO] runner message handling failed', err);
      }
    });

    ws.addEventListener('close', () => {
      const detached = this.runnerDetachedByUs;
      this.runnerDetachedByUs = false;
      this.runnerSocket = null;
      this.runnerStdoutBuffer = '';

      if (!detached && this.getChatSockets().length > 0) {
        this.emitChatError('Sprite runner disconnected');
      }
    });

    ws.addEventListener('error', (err) => {
      console.error('[ChatThreadDO] runner websocket error', err);
    });
  }

  private detachRunnerSocket(): void {
    if (!this.runnerSocket) return;
    this.runnerDetachedByUs = true;
    try {
      this.runnerSocket.close(1000, 'detach');
    } catch {
      // ignore close failures
    }
    this.runnerSocket = null;
  }

  private handleRunnerSocketMessage(data: unknown): void {
    if (typeof data === 'string') {
      this.handleRunnerTextMessage(data);
      return;
    }

    if (data instanceof ArrayBuffer) {
      this.handleRunnerBinaryMessage(new Uint8Array(data));
      return;
    }

    if (data instanceof Uint8Array) {
      this.handleRunnerBinaryMessage(data);
      return;
    }

    // Some runtimes may provide Blob for binary payloads.
    if (typeof Blob !== 'undefined' && data instanceof Blob) {
      void data.arrayBuffer().then((buffer) => {
        this.handleRunnerBinaryMessage(new Uint8Array(buffer));
      }).catch((err) => {
        console.error('[ChatThreadDO] failed to read runner blob payload', err);
      });
    }
  }

  private handleRunnerTextMessage(text: string): void {
    try {
      const parsed = JSON.parse(text) as { type?: string; session_id?: number };
      if (parsed.type === 'session_info' && typeof parsed.session_id === 'number') {
        this.runnerSessionId = parsed.session_id;
        this.ctx.storage.kv.put(RUNNER_SESSION_ID_KEY, this.runnerSessionId);
      }
    } catch {
      // Non-JSON control text; ignore.
    }
  }

  private handleRunnerBinaryMessage(payload: Uint8Array): void {
    if (payload.length === 0) return;

    const streamId = payload[0];
    const data = payload.subarray(1);

    if (streamId === STREAM_ID_STDOUT) {
      const chunk = this.textDecoder.decode(data, { stream: true });
      this.processRunnerStdout(chunk);
      return;
    }

    if (streamId === STREAM_ID_STDERR) {
      const stderrText = this.textDecoder.decode(data, { stream: true }).trim();
      if (stderrText) {
        console.error('[ChatThreadDO] runner stderr:', stderrText.slice(0, 4000));
      }
      return;
    }

    if (streamId === STREAM_ID_EXIT) {
      const exitCode = data.length > 0 ? data[0] : 0;
      this.handleRunnerExit(exitCode);
      return;
    }

    if (streamId === STREAM_ID_STDIN) {
      // Unexpected server->client stdin frame; ignore.
    }
  }

  private processRunnerStdout(chunk: string): void {
    this.runnerStdoutBuffer += chunk;

    while (true) {
      const newlineIdx = this.runnerStdoutBuffer.indexOf('\n');
      if (newlineIdx < 0) break;

      const line = this.runnerStdoutBuffer.slice(0, newlineIdx).trim();
      this.runnerStdoutBuffer = this.runnerStdoutBuffer.slice(newlineIdx + 1);

      if (!line) continue;

      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        this.handleRunnerEvent(parsed);
      } catch {
        // Runner may print non-JSON logs to stdout; ignore them for protocol handling.
      }
    }
  }

  private handleRunnerEvent(event: Record<string, unknown>): void {
    const eventType = typeof event.type === 'string' ? event.type : '';

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
      }
    }

    if (eventType === 'session' || eventType === 'ready') {
      // These are synthesized by ChatThreadDO on init.
      return;
    }

    this.pushChatEvent(event);
  }

  private handleRunnerExit(exitCode: number): void {
    this.runnerSocket = null;
    this.runnerStdoutBuffer = '';

    this.runnerSessionId = null;
    this.ctx.storage.kv.delete(RUNNER_SESSION_ID_KEY);

    if (exitCode !== 0) {
      this.emitChatError(`Sprite runner exited with code ${exitCode}`);
    } else {
      this.emitChatError('Sprite runner exited');
    }
  }

  private sendRunnerCommand(message: Record<string, unknown>): void {
    if (!this.runnerSocket) {
      throw new Error('Runner websocket is not connected');
    }

    const line = `${JSON.stringify(message)}\n`;
    const encoded = this.textEncoder.encode(line);
    const framed = new Uint8Array(encoded.length + 1);
    framed[0] = STREAM_ID_STDIN;
    framed.set(encoded, 1);
    this.runnerSocket.send(framed);
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
      ws.send(JSON.stringify(message));
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
