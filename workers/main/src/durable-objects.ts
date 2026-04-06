import { DurableObject } from "cloudflare:workers";
import type { OrgDO } from "./auth";
import type { WorkspaceDO } from "./workspace";
import {
  WorkspaceContainer,
  type WorkspaceContainerEnv,
} from "./workspace-container";
import {
  formatAttributedUserMessage,
  type ChatAuthorIdentity,
} from './chat-author-attribution';
import { injectFileSafetyMessage } from './file-safety';
import {
  getThreadTitleSourceMessage,
  isPlaceholderThreadTitle,
  sanitizeGeneratedThreadTitle,
  THREAD_TITLE_GENERATION_SYSTEM_PROMPT,
} from '../../../src/lib/thread-title';
import type { Message as UiMessage, LlmModel } from '../../../src/types';
import { applyRuntimeEventToMessages } from '../../../desktop/shared/message-state';
import { isOrgBanned } from "./ban-list";

export type PreviewTarget =
  | {
      kind: "app";
      scriptName: string;
      isPublic: boolean;
    }
  | {
      kind: "file";
      source: "workspace" | "upload" | "output";
      workspaceId: string;
      path: string;
      filename?: string;
      contentType?: string;
    };

// Dynamic field for custom integrations (matches src/lib/integration-registry.ts)
export interface DynamicField {
  name: string;
  label: string;
  type: "password" | "text" | "url" | "number";
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
  model: 'sonnet' | 'opus';
  created_by: string;
  created_at: number;
  updated_at: number;
}

export interface Message {
  id: string;
  thread_id: string;
  role: "user" | "assistant";
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
  CLAUDE_AUTOCOMPACT_PCT_OVERRIDE?: string;
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
  provider?: 'claude' | 'codex';
  userId: string | null;
  userName: string | null;
  userEmail: string | null;
}

interface PendingQuestionInfo {
  questionId: string;
  toolUseId?: string;
  questions: unknown[];
}

interface ChatClientInitMessage {
  type: "init";
  threadId?: string;
  lastEventId?: number;
}

interface ChatClientMessage {
  type: "message";
  content?: string;
}

interface ChatClientQuestionResponse {
  type: "question_response";
  questionId?: string;
  answers?: Record<string, unknown>;
}

interface ChatClientSetPreviewTarget {
  type: "set_preview_target";
  target?: PreviewTarget | null;
}

interface ChatClientSetPreviewTabsState {
  type: "set_preview_tabs_state";
  tabs?: PreviewTarget[];
  activeTabId?: string | null;
}

export interface ExternalMessageRequest {
  threadId?: string;
  workspaceId?: string;
  orgId?: string;
  userName?: string | null;
  userEmail?: string | null;
  message?: string;
  timeoutMs?: number | null;
}

export interface ExternalTurnResult {
  status: "result" | "busy" | "error";
  reply?: string;
  error?: string;
}

interface PendingExternalTurn {
  resolve: (result: ExternalTurnResult) => void;
  streamingText: string;
  latestAssistantText: string;
}

const CHAT_SOCKET_TAG = "chat";

const CHAT_CONTEXT_KEY = "chatContext";
const CHAT_TODOS_KEY = "chatTodos";
const CHAT_CONTEXT_USED_PERCENT_KEY = "chatContextUsedPercent";
const CHAT_CONTEXT_WINDOW_BY_MODEL_KEY = "chatContextWindowByModel";
const CHAT_NEXT_EVENT_ID_KEY = "chatNextEventId";
const CHAT_RUNNER_LAST_SEQ_KEY = "chatRunnerLastSeq";
const CHAT_RUNNER_IDLE_DISCONNECT_KEY = "chatRunnerIdleDisconnect";

const MAX_CHAT_EVENT_BUFFER = 500;
const RUNNER_PING_INTERVAL_MS = 10_000;
const RUNNER_RECONNECT_BACKOFF_MS = [250, 500, 1_000, 2_000, 5_000] as const;
const RUNNER_RECONNECT_GRACE_MS = 30_000;
const RUNNER_CLOSE_CODE_BYOK_CHANGED = 4001;
const DEFAULT_EXTERNAL_ASK_USER_QUESTION_UNAVAILABLE_MESSAGE = 'User is not at computer; AskUserQuestion is unavailable in this channel. Continue without asking and use best effort.';

/**
 * Last per-API-call prompt usage captured from stream_event.message_start.
 */
export interface LastMessageStartUsage {
  inputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  model: string | null;
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Extract contextWindow for the captured message_start model.
 * Falls back to the maximum contextWindow across modelUsage entries.
 */
function extractContextWindowForModel(
  sdkEvent: { modelUsage?: unknown },
  model: string | null,
): number {
  if (!sdkEvent.modelUsage || typeof sdkEvent.modelUsage !== "object") return 0;

  const entries = sdkEvent.modelUsage as Record<string, unknown>;

  if (model && entries[model] && typeof entries[model] === "object") {
    const contextWindow = toFiniteNumber(
      (entries[model] as Record<string, unknown>).contextWindow,
    );
    if (contextWindow !== null && contextWindow > 0) {
      return contextWindow;
    }
  }

  let maxContextWindow = 0;
  for (const usage of Object.values(entries)) {
    if (!usage || typeof usage !== "object") continue;
    const contextWindow = toFiniteNumber(
      (usage as Record<string, unknown>).contextWindow,
    );
    if (contextWindow !== null && contextWindow > maxContextWindow) {
      maxContextWindow = contextWindow;
    }
  }
  return maxContextWindow;
}

export function extractContextWindowByModel(sdkEvent: {
  modelUsage?: unknown;
}): Record<string, number> {
  const byModel: Record<string, number> = {};
  if (!sdkEvent.modelUsage || typeof sdkEvent.modelUsage !== "object") {
    return byModel;
  }

  for (const [model, usage] of Object.entries(
    sdkEvent.modelUsage as Record<string, unknown>,
  )) {
    if (!usage || typeof usage !== "object") continue;
    const contextWindow = toFiniteNumber(
      (usage as Record<string, unknown>).contextWindow,
    );
    if (contextWindow !== null && contextWindow > 0) {
      byModel[model] = contextWindow;
    }
  }

  return byModel;
}

export function shallowEqualNumberMaps(
  a: Record<string, number>,
  b: Record<string, number>,
): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;

  for (const key of aKeys) {
    if (a[key] !== b[key]) return false;
  }

  return true;
}

function calculateContextUsedPercent(
  usage: LastMessageStartUsage,
  contextWindow: number,
): number {
  const totalInput =
    usage.inputTokens +
    usage.cacheReadInputTokens +
    usage.cacheCreationInputTokens;
  return Math.max(
    0,
    Math.min(100, Math.round((totalInput / contextWindow) * 100)),
  );
}

export interface ContextUsageTrackingState {
  contextUsedPercent: number | null;
  transientContextUsedPercent: number | null;
  lastMessageStartUsage: LastMessageStartUsage | null;
  usageIsPostCompaction: boolean;
  cachedContextWindowByModel: Record<string, number>;
}

export interface ContextUsageSdkEvent {
  type?: string;
  subtype?: string;
  modelUsage?: unknown;
  event?: {
    type?: string;
    message?: {
      usage?: unknown;
      model?: unknown;
    };
  };
}

export interface ContextUsageTrackingUpdate {
  nextState: ContextUsageTrackingState;
  // `undefined` means "no realtime update to broadcast"; `null` means "clear indicator".
  liveUsedPercent: number | null | undefined;
  finalUsedPercent: number | null;
  contextWindowCacheChanged: boolean;
}

export function applyContextUsageSdkEvent(
  currentState: ContextUsageTrackingState,
  sdkEvent: ContextUsageSdkEvent | undefined,
): ContextUsageTrackingUpdate {
  const nextState: ContextUsageTrackingState = {
    contextUsedPercent: currentState.contextUsedPercent,
    transientContextUsedPercent: currentState.transientContextUsedPercent,
    lastMessageStartUsage: currentState.lastMessageStartUsage,
    usageIsPostCompaction: currentState.usageIsPostCompaction,
    cachedContextWindowByModel: currentState.cachedContextWindowByModel,
  };

  let liveUsedPercent: number | null | undefined = undefined;
  let finalUsedPercent: number | null = null;
  let contextWindowCacheChanged = false;

  if (sdkEvent?.type === "stream_event") {
    const streamEvent = sdkEvent.event;
    if (streamEvent?.type === "message_start" && streamEvent.message?.usage) {
      const usage = streamEvent.message.usage as Record<string, unknown>;
      nextState.lastMessageStartUsage = {
        inputTokens:
          toFiniteNumber(usage.input_tokens) ??
          toFiniteNumber(usage.inputTokens) ??
          0,
        cacheReadInputTokens:
          toFiniteNumber(usage.cache_read_input_tokens) ??
          toFiniteNumber(usage.cacheReadInputTokens) ??
          0,
        cacheCreationInputTokens:
          toFiniteNumber(usage.cache_creation_input_tokens) ??
          toFiniteNumber(usage.cacheCreationInputTokens) ??
          0,
        model:
          typeof streamEvent.message.model === "string"
            ? streamEvent.message.model
            : null,
      };
      nextState.usageIsPostCompaction = true;

      const model = nextState.lastMessageStartUsage.model;
      const contextWindow = model
        ? nextState.cachedContextWindowByModel[model]
        : undefined;
      if (
        contextWindow &&
        contextWindow > 0 &&
        nextState.usageIsPostCompaction
      ) {
        const livePct = calculateContextUsedPercent(
          nextState.lastMessageStartUsage,
          contextWindow,
        );
        nextState.transientContextUsedPercent = livePct;
        liveUsedPercent = livePct;
      } else if (nextState.transientContextUsedPercent !== null) {
        // New call usage arrived for an uncached model; clear stale in-turn value.
        nextState.transientContextUsedPercent = null;
        liveUsedPercent = nextState.contextUsedPercent;
      }
    }
  }

  if (sdkEvent?.type === "system" && sdkEvent.subtype === "compact_boundary") {
    nextState.usageIsPostCompaction = false;
    const hadTransientUsage = nextState.transientContextUsedPercent !== null;
    nextState.transientContextUsedPercent = null;
    if (hadTransientUsage) {
      // Compact boundary invalidates in-turn usage; revert realtime state to canonical (or clear).
      liveUsedPercent = nextState.contextUsedPercent;
    }
  }

  if (sdkEvent?.type === "result") {
    const contextWindowByModel = extractContextWindowByModel(sdkEvent);
    if (Object.keys(contextWindowByModel).length > 0) {
      const mergedContextWindowByModel = {
        ...nextState.cachedContextWindowByModel,
        ...contextWindowByModel,
      };
      if (
        !shallowEqualNumberMaps(
          mergedContextWindowByModel,
          nextState.cachedContextWindowByModel,
        )
      ) {
        nextState.cachedContextWindowByModel = mergedContextWindowByModel;
        contextWindowCacheChanged = true;
      }
    }

    if (nextState.lastMessageStartUsage && nextState.usageIsPostCompaction) {
      let contextWindow = extractContextWindowForModel(
        sdkEvent,
        nextState.lastMessageStartUsage.model,
      );
      if (contextWindow <= 0 && nextState.lastMessageStartUsage.model) {
        const cachedContextWindow =
          nextState.cachedContextWindowByModel[
            nextState.lastMessageStartUsage.model
          ];
        if (
          typeof cachedContextWindow === "number" &&
          cachedContextWindow > 0
        ) {
          contextWindow = cachedContextWindow;
        }
      }

      if (contextWindow > 0) {
        const contextUsedPercent = calculateContextUsedPercent(
          nextState.lastMessageStartUsage,
          contextWindow,
        );
        nextState.contextUsedPercent = contextUsedPercent;
        finalUsedPercent = contextUsedPercent;
      }
    }

    nextState.transientContextUsedPercent = null;
    nextState.lastMessageStartUsage = null;
    nextState.usageIsPostCompaction = true;
  }

  return {
    nextState,
    liveUsedPercent,
    finalUsedPercent,
    contextWindowCacheChanged,
  };
}

export function resolveContextUsageForInit(
  transientContextUsedPercent: number | null,
  contextUsedPercent: number | null,
  chatIsStreaming: boolean,
): number | null {
  if (!chatIsStreaming) {
    return contextUsedPercent;
  }
  return transientContextUsedPercent ?? contextUsedPercent;
}

const HEADER_USER_NAME = "X-Chiridion-User-Name";
const HEADER_USER_EMAIL = "X-Chiridion-User-Email";
const HEADER_USER_ID = "X-Chiridion-User-Id";

const TRACE_CHAT_THREAD_DO = false;
const CHAT_CODEX_SESSION_ID_KEY = 'chatCodexSessionId';
const CHAT_PERSISTED_MESSAGES_KEY = 'chatPersistedMessages';

/**
 * ChatThreadDO - One per thread, holds preview state + chat websocket bridge.
 * Chat path: client WS <-> ChatThreadDO <-> sandbox control plane (/chat WS)
 */
export class ChatThreadDO extends DurableObject<ChatEnv> {
  private static readonly CONNECTION_SETUP_TIMEOUT_MS = 30 * 60 * 1000;
  private static readonly BUG_REPORT_TIMEOUT_MS = 5 * 60 * 1000;

  private previewTarget: PreviewTarget | null = null;
  private previewTabs: PreviewTarget[] = [];
  private previewActiveTabId: string | null = null;
  private previewVersion: number = 0;

  // Pending connection setup requests (requestId -> MCP DO callback info)
  // This is also persisted to storage to survive hibernation
  private pendingConnectionSetups: Map<string, PendingConnectionSetupInfo> =
    new Map();

  // Pending bug report captures (requestId -> MCP DO callback info)
  private pendingBugReports: Map<string, PendingBugReportInfo> = new Map();

  // Chat bridge state
  private chatContext: ChatContextState | null = null;
  private chatEventBuffer: Array<Record<string, unknown>> = [];
  private nextChatEventId: number = 1;
  private currentTodos: unknown[] = [];
  // Canonical persisted/replayed value (set on result events only).
  private contextUsedPercent: number | null = null;
  // Ephemeral in-turn value (never persisted).
  private transientContextUsedPercent: number | null = null;
  private lastMessageStartUsage: LastMessageStartUsage | null = null;
  private usageIsPostCompaction: boolean = true;
  private cachedContextWindowByModel: Record<string, number> = {};
  private chatIsStreaming: boolean = false;
  private pendingQuestions: Map<string, PendingQuestionInfo> = new Map();
  private pendingExternalTurn: PendingExternalTurn | null = null;
  private titleGenerationInFlight: boolean = false;
  private codexSessionId: string | null = null;
  private persistedMessages: UiMessage[] = [];
  private persistedStreamingMessageIds: Record<string, string | null> = {};

  private runnerSocket: WebSocket | null = null;
  private runnerConnectPromise: Promise<void> | null = null;
  private runnerPingTimer: number | null = null;
  private runnerReconnectTimer: number | null = null;
  private runnerDisconnectGraceTimer: number | null = null;
  private runnerReconnectAttempt: number = 0;
  private runnerReconnectArmed: boolean = false;
  private lastRunnerSeq: number = 0;
  private lastPersistedRunnerSeq: number = 0;
  private runnerTransitionChain: Promise<void> = Promise.resolve();
  private runnerActivityGeneration: number = 0;
  private runnerIntentionalIdleDisconnect: boolean = false;

  private trace(event: string, details: Record<string, unknown> = {}): void {
    if (!TRACE_CHAT_THREAD_DO) return;
    const context = this.chatContext;
    const payload = {
      event,
      threadId: context?.threadId || "",
      workspaceId: context?.workspaceId || "",
      orgId: context?.orgId || "",
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

  private async withRunnerTransitionLock<T>(
    source: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const previous = this.runnerTransitionChain;
    let release!: () => void;
    this.runnerTransitionChain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => {});
    this.trace("runner_transition_lock_acquired", { source });
    try {
      return await fn();
    } finally {
      release();
      this.trace("runner_transition_lock_released", { source });
    }
  }

  private markRunnerActivity(source: string): void {
    this.runnerActivityGeneration += 1;
    const hadIntentionalIdleDisconnect = this.runnerIntentionalIdleDisconnect;
    this.runnerIntentionalIdleDisconnect = false;
    if (hadIntentionalIdleDisconnect) {
      this.ctx.storage.kv.put(CHAT_RUNNER_IDLE_DISCONNECT_KEY, false);
    }
    this.trace("runner_activity", {
      source,
      generation: this.runnerActivityGeneration,
      hadIntentionalIdleDisconnect,
    });
  }

  constructor(ctx: DurableObjectState, env: ChatEnv) {
    super(ctx, env);

    // Set up auto-response for ping messages - responds without waking the DO
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(
        JSON.stringify({ type: "ping" }),
        JSON.stringify({ type: "pong" }),
      ),
    );

    // Restore state from storage
    ctx.blockConcurrencyWhile(async () => {
      const storedTabs = ctx.storage.kv.get<PreviewTarget[]>("previewTabs");
      const storedActiveTabId = ctx.storage.kv.get<string | null>(
        "previewActiveTabId",
      );
      const storedTarget = ctx.storage.kv.get<PreviewTarget>("previewTarget");
      if (Array.isArray(storedTabs)) {
        const normalizedState = this.normalizePreviewTabsState(
          storedTabs,
          storedActiveTabId,
        ) ?? {
          tabs: [],
          activeTabId: null,
          target: null,
        };
        this.previewTabs = normalizedState.tabs;
        this.previewActiveTabId = normalizedState.activeTabId;
        this.previewTarget = normalizedState.target;
      } else {
        const normalizedTarget = this.normalizePreviewTarget(
          storedTarget ?? null,
        );
        if (normalizedTarget) {
          this.previewTabs = [normalizedTarget];
          this.previewActiveTabId = this.getPreviewTabId(normalizedTarget);
          this.previewTarget = normalizedTarget;
        }
      }

      const version = ctx.storage.kv.get<number>("previewVersion");
      if (typeof version === "number") {
        this.previewVersion = version;
      }

      // Persist normalized preview session state. This also migrates legacy
      // single-target threads into multi-tab state on first hydrate.
      this.ctx.storage.kv.put("previewTabs", this.previewTabs);
      this.ctx.storage.kv.put("previewActiveTabId", this.previewActiveTabId);
      this.ctx.storage.kv.put("previewTarget", this.previewTarget);

      // Restore pending connection setups from storage (sync KV)
      const pendingEntries = ctx.storage.kv.list({
        prefix: "pending_connection:",
      });
      for (const [key, value] of pendingEntries) {
        const info = value as Partial<PendingConnectionSetupInfo>;
        const requestId = key.replace("pending_connection:", "");
        if (
          typeof info?.createdAt === "number" &&
          typeof info?.mcpDoId === "string" &&
          typeof info?.integrationType === "string"
        ) {
          // Only restore if not expired (30 minutes)
          if (
            Date.now() - info.createdAt <
            ChatThreadDO.CONNECTION_SETUP_TIMEOUT_MS
          ) {
            this.pendingConnectionSetups.set(
              requestId,
              info as PendingConnectionSetupInfo,
            );
          } else {
            ctx.storage.kv.delete(key);
          }
        } else {
          ctx.storage.kv.delete(key);
        }
      }

      // Restore pending bug reports from storage (sync KV)
      const bugReportEntries = ctx.storage.kv.list({
        prefix: "pending_bug_report:",
      });
      for (const [key, value] of bugReportEntries) {
        const info = value as Partial<PendingBugReportInfo>;
        const requestId = key.replace("pending_bug_report:", "");
        if (
          typeof info?.createdAt === "number" &&
          typeof info?.mcpDoId === "string"
        ) {
          if (
            Date.now() - info.createdAt <
            ChatThreadDO.BUG_REPORT_TIMEOUT_MS
          ) {
            this.pendingBugReports.set(requestId, info as PendingBugReportInfo);
          } else {
            ctx.storage.kv.delete(key);
          }
        } else {
          ctx.storage.kv.delete(key);
        }
      }

      const storedContext =
        ctx.storage.kv.get<ChatContextState>(CHAT_CONTEXT_KEY);
      if (
        storedContext &&
        storedContext.threadId &&
        storedContext.workspaceId &&
        storedContext.orgId
      ) {
        this.chatContext = {
          ...storedContext,
          userId: storedContext.userId ?? null,
          userName: storedContext.userName ?? null,
          userEmail: storedContext.userEmail ?? null,
        };
      }

      const storedTodos = ctx.storage.kv.get<unknown[]>(CHAT_TODOS_KEY);
      if (Array.isArray(storedTodos)) {
        this.currentTodos = storedTodos;
      }

      const storedPersistedMessages = ctx.storage.kv.get<UiMessage[]>(CHAT_PERSISTED_MESSAGES_KEY);
      if (Array.isArray(storedPersistedMessages)) {
        this.persistedMessages = storedPersistedMessages.filter((message) => (
          Boolean(message) &&
          typeof message.id === 'string' &&
          typeof message.thread_id === 'string' &&
          (message.role === 'user' || message.role === 'assistant') &&
          typeof message.created_at === 'number'
        ));
      }

      const storedContextUsedPercent = ctx.storage.kv.get<number>(CHAT_CONTEXT_USED_PERCENT_KEY);
      if (typeof storedContextUsedPercent === 'number' && Number.isFinite(storedContextUsedPercent)) {
        this.contextUsedPercent = Math.max(0, Math.min(100, Math.round(storedContextUsedPercent)));
      }

      const storedContextWindowByModel = ctx.storage.kv.get<
        Record<string, unknown>
      >(CHAT_CONTEXT_WINDOW_BY_MODEL_KEY);
      if (
        storedContextWindowByModel &&
        typeof storedContextWindowByModel === "object"
      ) {
        for (const [model, contextWindow] of Object.entries(
          storedContextWindowByModel,
        )) {
          if (
            typeof contextWindow === "number" &&
            Number.isFinite(contextWindow) &&
            contextWindow > 0
          ) {
            this.cachedContextWindowByModel[model] = contextWindow;
          }
        }
      }

      const storedNextEventId = ctx.storage.kv.get<number>(
        CHAT_NEXT_EVENT_ID_KEY,
      );
      if (typeof storedNextEventId === "number" && storedNextEventId > 0) {
        this.nextChatEventId = storedNextEventId;
      }

      const storedRunnerLastSeq = ctx.storage.kv.get<number>(
        CHAT_RUNNER_LAST_SEQ_KEY,
      );
      if (typeof storedRunnerLastSeq === "number" && storedRunnerLastSeq > 0) {
        this.lastRunnerSeq = storedRunnerLastSeq;
        this.lastPersistedRunnerSeq = storedRunnerLastSeq;
      }

      const storedIdleDisconnect = ctx.storage.kv.get<boolean>(
        CHAT_RUNNER_IDLE_DISCONNECT_KEY,
      );
      if (storedIdleDisconnect === true) {
        this.runnerIntentionalIdleDisconnect = true;
      }

      const storedCodexSessionId = ctx.storage.kv.get<string>(CHAT_CODEX_SESSION_ID_KEY);
      if (typeof storedCodexSessionId === 'string' && storedCodexSessionId.trim()) {
        this.codexSessionId = storedCodexSessionId.trim();
      }

      // chatIsStreaming is intentionally in-memory only (not persisted).
      // If the DO restarts, there is no active stream by definition.
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    this.trace("fetch", {
      method: request.method,
      path: url.pathname,
      search: url.search,
      isWebSocketUpgrade: request.headers.get("Upgrade") === "websocket",
    });

    // WebSocket upgrade
    if (request.headers.get("Upgrade") === "websocket") {
      if (url.pathname !== "/chat") {
        this.trace("ws_upgrade_rejected_path", { path: url.pathname });
        return new Response("Not found", { status: 404 });
      }

      // Ownership check: if this thread already has a stored orgId, reject
      // connections from a different org. Prevents cross-org access via leaked thread UUIDs.
      const incomingOrgId = url.searchParams.get("orgId")?.trim() || "";
      if (
        this.chatContext?.orgId &&
        incomingOrgId &&
        this.chatContext.orgId !== incomingOrgId
      ) {
        this.trace("ws_upgrade_rejected_org_mismatch", {
          storedOrgId: this.chatContext.orgId,
          incomingOrgId,
        });
        return new Response("Forbidden", { status: 403 });
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server, [CHAT_SOCKET_TAG]);
      this.captureChatContextFromRequest(url, request, server);
      this.trace("ws_upgrade_accepted", {
        path: url.pathname,
        queryThreadId: url.searchParams.get("threadId") || "",
        queryWorkspaceId: url.searchParams.get("workspaceId") || "",
        queryOrgId: url.searchParams.get("orgId") || "",
      });
      return new Response(null, { status: 101, webSocket: client });
    }

    // HTTP API for setting preview state
    if (url.pathname === "/preview" && request.method === "POST") {
      const body = (await request.json()) as {
        target?: PreviewTarget | null;
        tabs?: PreviewTarget[];
        activeTabId?: string | null;
      };
      if (Array.isArray(body.tabs) || body.activeTabId !== undefined) {
        await this.setPreviewTabsState(
          body.tabs ?? [],
          body.activeTabId ?? null,
        );
      } else {
        await this.setPreviewTarget(body.target ?? null);
      }
      return new Response(
        JSON.stringify({
          target: this.previewTarget,
          tabs: this.previewTabs,
          activeTabId: this.previewActiveTabId,
          version: this.previewVersion,
        }),
        {
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    if (url.pathname === "/preview" && request.method === "GET") {
      return new Response(
        JSON.stringify({
          target: this.previewTarget,
          tabs: this.previewTabs,
          activeTabId: this.previewActiveTabId,
          version: this.previewVersion,
        }),
        {
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // HTTP API for connection setup prompts (called by MCP server)
    if (
      url.pathname === "/connection-setup/prompt" &&
      request.method === "POST"
    ) {
      const body = (await request.json()) as ConnectionSetupRequest & {
        mcpDoId?: string;
        dynamicSchema?: DynamicIntegrationSchema;
      };
      const requestId = body.requestId || crypto.randomUUID();
      const mcpDoId = body.mcpDoId;

      if (!mcpDoId) {
        return new Response(
          JSON.stringify({ error: "Missing MCP DO ID for callback" }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      if (!body.integrationType) {
        return new Response(
          JSON.stringify({
            error:
              "Missing integrationType - connection type must be specified",
          }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          },
        );
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
        type: "connection_setup_prompt",
        requestId,
        integrationType: body.integrationType,
        suggestedName: body.suggestedName,
        message: body.message,
        dynamicSchema: body.dynamicSchema,
        mcpDoId,
      });

      return new Response(JSON.stringify({ requestId }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // HTTP API for bug report capture prompts (called by MCP server)
    if (url.pathname === "/bug-report/prompt" && request.method === "POST") {
      const body = (await request.json()) as BugReportCaptureRequest & {
        mcpDoId?: string;
      };
      const requestId = body.requestId || crypto.randomUUID();
      const mcpDoId = body.mcpDoId;

      if (!mcpDoId) {
        return new Response(
          JSON.stringify({ error: "Missing MCP DO ID for callback" }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      const pendingInfo: PendingBugReportInfo = {
        mcpDoId,
        createdAt: Date.now(),
        message: body.message,
      };
      this.pendingBugReports.set(requestId, pendingInfo);
      this.ctx.storage.kv.put(`pending_bug_report:${requestId}`, pendingInfo);

      this.broadcastRealtime({
        type: "bug_report_prompt",
        requestId,
        message: body.message,
      });

      return new Response(JSON.stringify({ requestId }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("Not found", { status: 404 });
  }

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    if (typeof message !== "string") return;
    this.trace("chat_ws_message_raw", {
      bytes: message.length,
    });

    let data: { type: string; [key: string]: unknown };
    try {
      data = JSON.parse(message) as { type: string; [key: string]: unknown };
    } catch {
      this.trace("chat_ws_message_invalid_json", {
        bytes: message.length,
      });
      return;
    }
    this.trace("chat_ws_message_parsed", {
      type: data.type,
      bytes: message.length,
    });

    try {
      if (data.type === "connection_setup_response") {
        await this.handleConnectionSetupResponse(
          data as unknown as ConnectionSetupResponse,
        );
        return;
      }

      if (data.type === "bug_report_response") {
        await this.handleBugReportResponse(
          data as unknown as BugReportCaptureResponse,
        );
        return;
      }

      // Chat transport messages
      if (data.type === "init") {
        await this.handleChatInit(ws, data as unknown as ChatClientInitMessage);
        return;
      }

      if (data.type === "message") {
        await this.handleChatMessage(ws, data as unknown as ChatClientMessage);
        return;
      }

      if (data.type === "stop") {
        await this.handleChatStop();
        return;
      }

      if (data.type === "question_response") {
        await this.handleQuestionResponse(
          data as unknown as ChatClientQuestionResponse,
        );
        return;
      }

      if (data.type === "set_preview_target") {
        await this.handleSetPreviewTarget(
          data as unknown as ChatClientSetPreviewTarget,
        );
        return;
      }

      if (data.type === "set_preview_tabs_state") {
        await this.handleSetPreviewTabsState(
          data as unknown as ChatClientSetPreviewTabsState,
        );
        return;
      }
    } catch (err) {
      console.error(
        `[ChatThreadDO] webSocketMessage error (type=${data.type}):`,
        err,
      );
      this.emitChatError(
        `Internal error handling ${data.type}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  webSocketClose(
    _ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ): void {
    this.trace("chat_ws_close", {
      code,
      reason,
      wasClean,
      remainingChatSockets: this.getChatSockets().length,
    });
    if (this.getChatSockets().length === 0) {
      this.stopRunnerReconnectLoop("no_chat_sockets");
      this.cancelRunnerDisconnectGrace("no_chat_sockets");
      if (this.pendingQuestions.size > 0) {
        this.markRunnerActivity("chat_socket_closed_question_unavailable");
        this.ctx.waitUntil(
          this.autoAnswerAllPendingQuestionsAsUnavailable(
            DEFAULT_EXTERNAL_ASK_USER_QUESTION_UNAVAILABLE_MESSAGE,
          ),
        );
      }
    }
    // Intentional no-op on chat socket close. Runner lifecycle is handled
    // by runner-side control events and explicit reconnect-on-demand.
  }

  webSocketError(_ws: WebSocket, error: unknown): void {
    this.trace("chat_ws_error", {
      error: String(error),
    });
  }

  getPreviewTarget(): PreviewTarget | null {
    return this.previewTarget;
  }

  getPreviewState(): {
    target: PreviewTarget | null;
    tabs: PreviewTarget[];
    activeTabId: string | null;
    version: number;
  } {
    return {
      target: this.previewTarget,
      tabs: this.previewTabs,
      activeTabId: this.previewActiveTabId,
      version: this.previewVersion,
    };
  }

  async setPreviewTarget(target: PreviewTarget | null): Promise<void> {
    const previousActiveTabId = this.previewActiveTabId;
    const normalizedTarget = this.normalizePreviewTarget(target);
    if (!normalizedTarget) {
      this.previewTabs = [];
      this.previewActiveTabId = null;
      this.previewTarget = null;
      this.previewVersion++;
      this.persistPreviewState();
      this.broadcastPreviewState();
      return;
    }

    const id = this.getPreviewTabId(normalizedTarget);
    const existingIndex = this.previewTabs.findIndex(
      (tabTarget) => this.getPreviewTabId(tabTarget) === id,
    );
    if (existingIndex >= 0) {
      this.previewTabs = this.previewTabs.map((tabTarget, index) =>
        index === existingIndex ? normalizedTarget : tabTarget,
      );
    } else {
      this.previewTabs = [...this.previewTabs, normalizedTarget];
    }
    this.previewActiveTabId = id;
    this.previewTarget = normalizedTarget;
    this.previewVersion++;
    this.persistPreviewState();
    this.broadcastPreviewState({
      refreshTabId: previousActiveTabId === id ? id : undefined,
    });
  }

  async setPreviewTabsState(
    tabs: PreviewTarget[],
    activeTabId: string | null,
  ): Promise<void> {
    await this.setPreviewTabsStateInternal(tabs, activeTabId);
  }

  private async setPreviewTabsStateInternal(
    tabs: PreviewTarget[],
    activeTabId: string | null,
    expectedWorkspaceId?: string,
  ): Promise<boolean> {
    const normalizedState = this.normalizePreviewTabsState(
      tabs,
      activeTabId,
      expectedWorkspaceId,
    );
    if (!normalizedState) {
      return false;
    }

    this.previewTabs = normalizedState.tabs;
    this.previewActiveTabId = normalizedState.activeTabId;
    this.previewTarget = normalizedState.target;
    this.previewVersion++;
    this.persistPreviewState();
    this.broadcastPreviewState();
    return true;
  }

  async clearPreviewTarget(): Promise<void> {
    await this.setPreviewTarget(null);
  }

  async setPreviewAppVisibility(
    scriptName: string,
    isPublic: boolean,
  ): Promise<void> {
    let tabsChanged = false;
    const nextTabs = this.previewTabs.map((tabTarget) => {
      if (tabTarget.kind !== "app" || tabTarget.scriptName !== scriptName) {
        return tabTarget;
      }
      if (tabTarget.isPublic === isPublic) {
        return tabTarget;
      }
      tabsChanged = true;
      return { ...tabTarget, isPublic };
    });

    let targetChanged = false;
    let nextTarget = this.previewTarget;
    if (
      nextTarget?.kind === "app" &&
      nextTarget.scriptName === scriptName &&
      nextTarget.isPublic !== isPublic
    ) {
      targetChanged = true;
      nextTarget = {
        ...nextTarget,
        isPublic,
      };
    }

    if (!tabsChanged && !targetChanged) {
      return;
    }

    this.previewTabs = nextTabs;
    this.previewTarget = nextTarget;

    this.persistPreviewState(false);
    this.broadcastPreviewState();
  }

  // Set thread title and broadcast to connected chat clients
  async setTitle(title: string): Promise<void> {
    this.broadcastRealtime({ type: "title_updated", title });
  }

  async setModel(model: LlmModel): Promise<void> {
    this.broadcastRealtime({ type: 'thread_model_updated', model });
  }

  async refreshRunnerConfig(): Promise<void> {
    await this.withRunnerTransitionLock('refresh_runner_config', async () => {
      this.stopRunnerReconnectLoop('refresh_runner_config');
      this.cancelRunnerDisconnectGrace('refresh_runner_config');
      if (!this.runnerSocket) {
        return;
      }
      this.runnerIntentionalIdleDisconnect = true;
      this.ctx.storage.kv.put(CHAT_RUNNER_IDLE_DISCONNECT_KEY, true);
      try {
        this.runnerSocket.close(1000, 'runner_config_changed');
      } catch {
        this.trace('refresh_runner_config_close_failed');
      }
    });
  }

  async byokChanged(): Promise<void> {
    await this.withRunnerTransitionLock('byok_changed', async () => {
      this.stopRunnerReconnectLoop('byok_changed');
      this.cancelRunnerDisconnectGrace('byok_changed');
      if (!this.runnerSocket) {
        return;
      }
      try {
        this.runnerSocket.close(RUNNER_CLOSE_CODE_BYOK_CHANGED, 'byok_credentials_changed');
      } catch {
        this.trace('byok_changed_close_failed');
      }
    });
  }

  private async handleConnectionSetupResponse(response: ConnectionSetupResponse): Promise<void> {
    const pendingInfo = this.pendingConnectionSetups.get(response.requestId);

    if (response.requestId && pendingInfo) {
      this.pendingConnectionSetups.delete(response.requestId);
      this.ctx.storage.kv.delete(`pending_connection:${response.requestId}`);

      try {
        const mcpDoId = this.env.MCP_OBJECT.idFromString(pendingInfo.mcpDoId);
        const mcpStub = this.env.MCP_OBJECT.get(
          mcpDoId,
        ) as unknown as ChiridionMcpRpc;
        await mcpStub.receiveConnectionSetupResponse(response);
      } catch (err) {
        console.error("[ChatThreadDO] Failed to call MCP DO callback:", err);
      }
    }
  }

  private async handleBugReportResponse(
    response: BugReportCaptureResponse,
  ): Promise<void> {
    const pendingInfo = this.pendingBugReports.get(response.requestId);

    if (response.requestId && pendingInfo) {
      this.pendingBugReports.delete(response.requestId);
      this.ctx.storage.kv.delete(`pending_bug_report:${response.requestId}`);

      try {
        const mcpDoId = this.env.MCP_OBJECT.idFromString(pendingInfo.mcpDoId);
        const mcpStub = this.env.MCP_OBJECT.get(
          mcpDoId,
        ) as unknown as ChiridionMcpRpc;
        await mcpStub.receiveBugReportCaptureResponse(response);
      } catch (err) {
        console.error(
          "[ChatThreadDO] Failed to call MCP DO callback for bug report:",
          err,
        );
      }
    }
  }

  private captureChatContextFromRequest(
    url: URL,
    request: Request,
    ws?: WebSocket,
  ): void {
    const queryThreadId = url.searchParams.get("threadId")?.trim() || "";
    const queryWorkspaceId = url.searchParams.get("workspaceId")?.trim() || "";
    const queryOrgId = url.searchParams.get("orgId")?.trim() || "";

    const userId = request.headers.get(HEADER_USER_ID)?.trim() || null;
    const userName = request.headers.get(HEADER_USER_NAME)?.trim() || null;
    const userEmail = request.headers.get(HEADER_USER_EMAIL)?.trim() || null;

    const prev = this.chatContext;
    const threadId = queryThreadId || prev?.threadId || "";
    const workspaceId = queryWorkspaceId || prev?.workspaceId || "";
    const orgId = queryOrgId || prev?.orgId || "";

    if (!threadId || !workspaceId || !orgId) {
      this.trace("capture_chat_context_skipped", {
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
      userId,
      userName,
      userEmail,
    };

    ws?.serializeAttachment(this.chatContext);
    this.ctx.storage.kv.put(CHAT_CONTEXT_KEY, this.chatContext);
    this.trace("capture_chat_context_set", {
      threadId,
      workspaceId,
      orgId,
      userIdPresent: Boolean(this.chatContext.userId),
      userNamePresent: Boolean(this.chatContext.userName),
      userEmailPresent: Boolean(this.chatContext.userEmail),
    });
  }

  private async handleChatInit(
    ws: WebSocket,
    data: ChatClientInitMessage,
  ): Promise<void> {
    this.trace("handle_chat_init_start", {
      incomingThreadId: typeof data.threadId === "string" ? data.threadId : "",
      lastEventId:
        typeof data.lastEventId === "number" ? data.lastEventId : null,
    });
    const incomingThreadId =
      typeof data.threadId === "string" ? data.threadId.trim() : "";
    if (!incomingThreadId) {
      this.sendDirect(ws, {
        type: "error",
        error: "Missing threadId - init requires a valid threadId",
      });
      try {
        ws.close(1008, "missing threadId");
      } catch {
        // ignore close failures
      }
      return;
    }

    if (!this.chatContext) {
      this.sendDirect(ws, {
        type: "error",
        error: "Missing chat context for thread",
      });
      return;
    }

    if (this.chatContext.threadId !== incomingThreadId) {
      this.sendDirect(ws, {
        type: "error",
        error: "Thread mismatch for this chat connection",
      });
      return;
    }

    const lastEventId =
      typeof data.lastEventId === "number" && Number.isFinite(data.lastEventId)
        ? Math.max(0, Math.floor(data.lastEventId))
        : 0;

    this.sendDirect(ws, {
      type: "session",
      sessionId: this.chatContext.threadId,
    });
    // streaming_state MUST arrive before ready: the client sends queued messages
    // on ready and optimistically sets loading=true.  If streaming_state (false)
    // arrives *after* ready it overwrites the optimistic loading state, causing a
    // visible flicker on the first message of a new chat in production.
    this.sendDirect(ws, {
      type: "streaming_state",
      isStreaming: this.chatIsStreaming,
    });
    this.sendDirect(ws, { type: "ready" });
    this.sendDirect(ws, {
      type: "preview_state",
      target: this.previewTarget,
      tabs: this.previewTabs,
      activeTabId: this.previewActiveTabId,
      version: this.previewVersion,
      refreshTabId: null,
    });
    this.sendPendingPromptsToWebSocket(ws);

    for (const pending of this.pendingQuestions.values()) {
      this.sendDirect(ws, {
        type: "ask_user_question",
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
      this.sendDirect(ws, { type: "todo_state", todos: this.currentTodos });
    }
    const initUsedPercent = resolveContextUsageForInit(
      this.transientContextUsedPercent,
      this.contextUsedPercent,
      this.chatIsStreaming,
    );
    this.sendDirect(ws, {
      type: "context_usage_state",
      usedPercent: initUsedPercent,
    });
    this.trace("handle_chat_init_complete", {
      incomingThreadId,
      replayFromEventId: lastEventId,
      bufferedEvents: this.chatEventBuffer.length,
      pendingQuestions: this.pendingQuestions.size,
      currentTodos: this.currentTodos.length,
      chatIsStreaming: this.chatIsStreaming,
    });

    if (
      this.runnerIntentionalIdleDisconnect &&
      !this.chatIsStreaming &&
      this.pendingQuestions.size === 0
    ) {
      this.trace("handle_chat_init_skip_runner_connect_idle_disconnected");
      return;
    }

    // Ensure we are connected to the sandbox control plane so in-flight output can resume.
    this.ctx.waitUntil(
      this.ensureRunnerConnected().catch((err) => {
        this.trace("ensure_runner_connected_init_failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        this.runnerReconnectArmed = true;
        this.armRunnerDisconnectGrace("chat_init_connect_failed");
        this.scheduleRunnerReconnect("chat_init_connect_failed");
      }),
    );
  }

  private async handleChatMessage(
    ws: WebSocket,
    data: ChatClientMessage,
  ): Promise<void> {
    if (!this.chatContext) {
      this.emitChatError("No session - send init first");
      return;
    }

    const rawContent = typeof data.content === 'string' ? data.content : '';
    const safeRawContent = injectFileSafetyMessage(rawContent);
    const attributedContent = formatAttributedUserMessage(
      safeRawContent,
      this.getSocketAuthorIdentity(ws)
    );
    if (!attributedContent) return;
    this.trace("handle_chat_message", {
      rawLength: rawContent.length,
      attributedLength: attributedContent.length,
    });

    this.markRunnerActivity("chat_message");
    await this.ensureRunnerConnected();
    if (
      !(await this.sendRunnerCommandWithReconnect({
        type: "message",
        content: attributedContent,
      }))
    ) {
      this.emitChatError("Failed to send message to sandbox");
      return;
    }
    this.appendPersistedUserMessage(attributedContent);
    this.setChatIsStreaming(true);

    this.ctx.waitUntil(
      this.updateThreadMetadataForUserMessage(attributedContent).catch((err) => {
        console.error('[ChatThreadDO] failed to update thread metadata after user message', err);
      })
    );
  }

  private async handleChatStop(): Promise<void> {
    this.trace("handle_chat_stop");
    this.markRunnerActivity("chat_stop");
    await this.sendRunnerCommandWithReconnect({ type: "stop" });
  }

  private async handleQuestionResponse(
    data: ChatClientQuestionResponse,
  ): Promise<void> {
    this.trace("handle_question_response", {
      questionId: data.questionId || "",
      hasAnswers: Boolean(data.answers && typeof data.answers === "object"),
    });
    if (!data.questionId || !data.answers || typeof data.answers !== "object") {
      this.emitChatError("Missing questionId or answers");
      return;
    }

    this.markRunnerActivity("question_response");
    if (
      !(await this.sendRunnerCommandWithReconnect({
        type: "question_response",
        questionId: data.questionId,
        answers: data.answers,
      }))
    ) {
      this.emitChatError("Sandbox is not connected");
    }
  }

  private async handleSetPreviewTarget(
    data: ChatClientSetPreviewTarget,
  ): Promise<void> {
    if (!this.chatContext) {
      this.emitChatError("No session - send init first");
      return;
    }

    const normalized = this.normalizePreviewTarget(data.target ?? null);

    if (normalized?.kind === "file") {
      if (normalized.workspaceId !== this.chatContext.workspaceId) {
        this.emitChatError("Invalid preview target workspace");
        return;
      }
    }

    await this.setPreviewTarget(normalized);
  }

  private async handleSetPreviewTabsState(
    data: ChatClientSetPreviewTabsState,
  ): Promise<void> {
    if (!this.chatContext) {
      this.emitChatError("No session - send init first");
      return;
    }

    const tabs = Array.isArray(data.tabs) ? data.tabs : [];
    const activeTabId =
      typeof data.activeTabId === "string" ? data.activeTabId : null;

    const ok = await this.setPreviewTabsStateInternal(
      tabs,
      activeTabId,
      this.chatContext.workspaceId,
    );
    if (!ok) {
      this.emitChatError("Invalid preview target workspace");
    }
  }

  private getPreviewTabId(target: PreviewTarget): string {
    if (target.kind === "app") {
      return `app:${target.scriptName}`;
    }
    return `file:${target.workspaceId}:${target.source}:${target.path}`;
  }

  private normalizePreviewTarget(
    target: PreviewTarget | null | undefined,
  ): PreviewTarget | null {
    if (!target || typeof target !== "object") {
      return null;
    }

    if (target.kind === "app") {
      const scriptName = target.scriptName
        .replace(/[^a-zA-Z0-9_-]/g, "_")
        .slice(0, 63);
      if (!scriptName) return null;
      return {
        kind: "app",
        scriptName,
        isPublic: Boolean(target.isPublic),
      };
    }

    if (target.kind === "file") {
      const source = target.source;
      if (
        source !== "workspace" &&
        source !== "upload" &&
        source !== "output"
      ) {
        return null;
      }

      const workspaceId =
        typeof target.workspaceId === "string" ? target.workspaceId.trim() : "";
      const path = typeof target.path === "string" ? target.path.trim() : "";

      if (!workspaceId || !path || path.includes("..")) {
        return null;
      }

      return {
        kind: "file",
        source,
        workspaceId,
        path,
        filename:
          typeof target.filename === "string"
            ? target.filename.trim()
            : undefined,
        contentType:
          typeof target.contentType === "string"
            ? target.contentType
            : undefined,
      };
    }

    return null;
  }

  private normalizePreviewTabsState(
    tabs: PreviewTarget[] | null | undefined,
    activeTabId: string | null | undefined,
    expectedWorkspaceId?: string,
  ): {
    tabs: PreviewTarget[];
    activeTabId: string | null;
    target: PreviewTarget | null;
  } | null {
    const deduped: Array<{ id: string; target: PreviewTarget }> = [];
    const dedupedById = new Map<string, number>();

    if (Array.isArray(tabs)) {
      for (const tabTarget of tabs) {
        const normalized = this.normalizePreviewTarget(tabTarget);
        if (!normalized) continue;
        if (
          expectedWorkspaceId &&
          normalized.kind === "file" &&
          normalized.workspaceId !== expectedWorkspaceId
        ) {
          return null;
        }

        const tabId = this.getPreviewTabId(normalized);
        const existingIndex = dedupedById.get(tabId);
        if (existingIndex === undefined) {
          dedupedById.set(tabId, deduped.length);
          deduped.push({ id: tabId, target: normalized });
          continue;
        }
        deduped[existingIndex] = { id: tabId, target: normalized };
      }
    }

    const nextActiveTabId =
      typeof activeTabId === "string" && dedupedById.has(activeTabId)
        ? activeTabId
        : (deduped[0]?.id ?? null);

    const nextTarget = nextActiveTabId
      ? (deduped.find((tab) => tab.id === nextActiveTabId)?.target ?? null)
      : null;

    return {
      tabs: deduped.map((tab) => tab.target),
      activeTabId: nextActiveTabId,
      target: nextTarget,
    };
  }

  private persistPreviewState(includeVersion = true): void {
    this.ctx.storage.kv.put("previewTabs", this.previewTabs);
    this.ctx.storage.kv.put("previewActiveTabId", this.previewActiveTabId);
    this.ctx.storage.kv.put("previewTarget", this.previewTarget);
    if (includeVersion) {
      this.ctx.storage.kv.put("previewVersion", this.previewVersion);
    }
  }

  private broadcastPreviewState(options?: {
    refreshTabId?: string | null;
  }): void {
    const refreshTabId =
      typeof options?.refreshTabId === "string" && options.refreshTabId
        ? options.refreshTabId
        : null;
    this.broadcastRealtime({
      type: "preview_state",
      target: this.previewTarget,
      tabs: this.previewTabs,
      activeTabId: this.previewActiveTabId,
      version: this.previewVersion,
      refreshTabId,
    });
  }

  private setChatIsStreaming(value: boolean): void {
    if (this.chatIsStreaming === value) return;
    this.trace("set_chat_is_streaming", {
      from: this.chatIsStreaming,
      to: value,
    });
    this.chatIsStreaming = value;
    // Clear persisted todos when a new turn starts so they don't go stale
    // across reconnects. The next TodoWrite will re-persist fresh state.
    if (value && this.currentTodos.length > 0) {
      this.currentTodos = [];
      this.ctx.storage.kv.delete(CHAT_TODOS_KEY);
    }
    this.broadcastRealtime({ type: "streaming_state", isStreaming: value });
  }

  private getSocketChatContext(ws: WebSocket): ChatContextState | null {
    const attachment = ws.deserializeAttachment();
    if (!attachment || typeof attachment !== "object") {
      return null;
    }

    const candidate = attachment as Partial<ChatContextState>;
    const threadId =
      typeof candidate.threadId === "string" ? candidate.threadId.trim() : "";
    const workspaceId =
      typeof candidate.workspaceId === "string"
        ? candidate.workspaceId.trim()
        : "";
    const orgId =
      typeof candidate.orgId === "string" ? candidate.orgId.trim() : "";
    if (!threadId || !workspaceId || !orgId) {
      return null;
    }

    return {
      threadId,
      workspaceId,
      orgId,
      userId:
        typeof candidate.userId === "string" && candidate.userId.trim()
          ? candidate.userId.trim()
          : null,
      userName:
        typeof candidate.userName === "string" && candidate.userName.trim()
          ? candidate.userName.trim()
          : null,
      userEmail:
        typeof candidate.userEmail === "string" && candidate.userEmail.trim()
          ? candidate.userEmail.trim()
          : null,
    };
  }

  private getSocketAuthorIdentity(ws: WebSocket): ChatAuthorIdentity {
    const socketContext = this.getSocketChatContext(ws);
    if (socketContext) {
      return {
        userName: socketContext.userName,
        userEmail: socketContext.userEmail,
      };
    }

    return {
      userName: this.chatContext?.userName ?? null,
      userEmail: this.chatContext?.userEmail ?? null,
    };
  }

  async externalMessage(
    body: ExternalMessageRequest,
  ): Promise<ExternalTurnResult> {
    const contextError = this.updateExternalChatContext(body);
    if (contextError) {
      return { status: "error", error: contextError };
    }

    const rawMessage =
      typeof body.message === "string" ? body.message.trim() : "";
    if (!rawMessage) {
      return { status: "error", error: "Missing message" };
    }

    if (this.pendingExternalTurn) {
      return { status: "busy" };
    }

    const existingPendingQuestion = this.getOldestPendingQuestion();
    if (existingPendingQuestion) {
      if (this.hasAvailableBrowserUser()) {
        return { status: "busy" };
      }

      this.markRunnerActivity("external_question_unavailable_existing");
      const answered = await this.autoAnswerPendingQuestionAsUnavailable(
        existingPendingQuestion.questionId,
        DEFAULT_EXTERNAL_ASK_USER_QUESTION_UNAVAILABLE_MESSAGE,
      );
      if (!answered) {
        return {
          status: "error",
          error:
            "AskUserQuestion is unavailable in this channel and could not be auto-answered.",
        };
      }
      return { status: "busy" };
    }

    if (this.chatIsStreaming) {
      return { status: "busy" };
    }

    const orgBan = await isOrgBanned(this.env.APP_KV, {
      orgId: this.chatContext?.orgId ?? body.orgId ?? null,
    });
    if (orgBan) {
      return { status: "error", error: "Organization is blocked" };
    }

    this.markRunnerActivity("external_message");
    await this.ensureRunnerConnected();

    const safeRawMessage = injectFileSafetyMessage(rawMessage);
    const attributedContent = formatAttributedUserMessage(safeRawMessage, {
      userName: typeof body.userName === 'string' && body.userName.trim()
        ? body.userName.trim()
        : null,
      userEmail: typeof body.userEmail === 'string' && body.userEmail.trim()
        ? body.userEmail.trim()
        : null,
    });
    if (!attributedContent) {
      return { status: "error", error: "Empty message" };
    }

    const pendingResult = this.createPendingExternalTurn();
    if (
      !(await this.sendRunnerCommandWithReconnect({
        type: "message",
        content: attributedContent,
      }))
    ) {
      this.resolvePendingExternalTurn({
        status: "error",
        error: "Failed to send message to sandbox",
      });
    } else {
      this.appendPersistedUserMessage(attributedContent);
      this.setChatIsStreaming(true);
      this.ctx.waitUntil(
        this.updateThreadMetadataForUserMessage(attributedContent).catch((err) => {
          console.error('[ChatThreadDO] failed to update thread metadata after external user message', err);
        })
      );
    }

    const timeoutMs = this.getExternalTurnTimeout(body.timeoutMs);
    return await this.waitForPendingExternalTurn(pendingResult, timeoutMs);
  }

  private hasAvailableBrowserUser(): boolean {
    return this.getChatSockets().length > 0;
  }

  private getOldestPendingQuestion(): PendingQuestionInfo | null {
    const iterator = this.pendingQuestions.values().next();
    return iterator.done ? null : iterator.value;
  }

  private updateExternalChatContext(payload: {
    threadId?: string;
    workspaceId?: string;
    orgId?: string;
    userName?: string | null;
    userEmail?: string | null;
  }): string | null {
    const threadId =
      typeof payload.threadId === "string" ? payload.threadId.trim() : "";
    const workspaceId =
      typeof payload.workspaceId === "string" ? payload.workspaceId.trim() : "";
    const orgId = typeof payload.orgId === "string" ? payload.orgId.trim() : "";
    if (!threadId || !workspaceId || !orgId) {
      return "Missing thread/workspace/org context";
    }

    if (this.chatContext?.threadId && this.chatContext.threadId !== threadId) {
      return "Thread context mismatch";
    }

    this.chatContext = {
      threadId,
      workspaceId,
      orgId,
      provider: this.chatContext?.provider ?? 'claude',
      userId: this.chatContext?.userId ?? null,
      userName: this.chatContext?.userName ?? null,
      userEmail: this.chatContext?.userEmail ?? null,
    };
    this.ctx.storage.kv.put(CHAT_CONTEXT_KEY, this.chatContext);
    return null;
  }

  private getExternalTurnTimeout(timeoutMs: unknown): number {
    // When no timeout is specified (Slack/email ingress), use a generous
    // fallback so turns aren't capped at 2 min but still can't hang forever
    // if the runner socket drops without resolving pendingExternalTurn.
    const FALLBACK_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
    if (timeoutMs == null) {
      return FALLBACK_TIMEOUT_MS;
    }
    if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs)) {
      return FALLBACK_TIMEOUT_MS;
    }
    const rounded = Math.floor(timeoutMs);
    if (rounded <= 0) {
      return FALLBACK_TIMEOUT_MS;
    }
    // setTimeout max delay on JS runtimes is 2^31-1 ms.
    return Math.min(2_147_483_647, Math.max(5_000, rounded));
  }

  private async autoAnswerPendingQuestionAsUnavailable(
    questionId: string,
    unavailableMessage: string,
  ): Promise<boolean> {
    const sent = await this.sendRunnerCommandWithReconnect({
      type: "question_response",
      questionId,
      answers: {
        unavailable_reason: unavailableMessage,
      },
    });
    if (sent) {
      this.pendingQuestions.delete(questionId);
    }
    return sent;
  }

  private async autoAnswerAllPendingQuestionsAsUnavailable(
    unavailableMessage: string,
  ): Promise<void> {
    const questionIds = [...this.pendingQuestions.keys()];
    for (const questionId of questionIds) {
      try {
        await this.autoAnswerPendingQuestionAsUnavailable(
          questionId,
          unavailableMessage,
        );
      } catch (err) {
        console.error(
          "[ChatThreadDO] failed to auto-answer pending AskUserQuestion",
          {
            questionId,
            error: err instanceof Error ? err.message : String(err),
          },
        );
      }
    }
  }

  private createPendingExternalTurn(): Promise<ExternalTurnResult> {
    return new Promise<ExternalTurnResult>((resolve) => {
      this.pendingExternalTurn = {
        resolve,
        streamingText: "",
        latestAssistantText: "",
      };
    });
  }

  private resolvePendingExternalTurn(result: ExternalTurnResult): void {
    const pending = this.pendingExternalTurn;
    if (!pending) return;

    this.pendingExternalTurn = null;

    if (result.status === "result") {
      const fallback = pending.latestAssistantText || pending.streamingText;
      pending.resolve({
        status: "result",
        reply: (result.reply || fallback || "").trim(),
      });
      return;
    }

    pending.resolve(result);
  }

  private async waitForPendingExternalTurn(
    pendingResult: Promise<ExternalTurnResult>,
    timeoutMs: number,
  ): Promise<ExternalTurnResult> {
    let timeoutHandle: number | null = null;
    const timeoutPromise = new Promise<ExternalTurnResult>((resolve) => {
      timeoutHandle = setTimeout(() => {
        resolve({
          status: "error",
          error: "Timed out waiting for Claude response",
        });
      }, timeoutMs) as unknown as number;
    });

    const result = await Promise.race([pendingResult, timeoutPromise]);
    if (timeoutHandle !== null) {
      clearTimeout(timeoutHandle);
    }

    if (
      result.status === "error" &&
      result.error === "Timed out waiting for Claude response"
    ) {
      this.pendingExternalTurn = null;
    }

    return result;
  }

  private extractAssistantTextFromContent(content: unknown): string {
    if (typeof content === "string") {
      return content.trim();
    }
    if (!Array.isArray(content)) {
      return "";
    }

    const textBlocks: string[] = [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const typed = block as { type?: unknown; text?: unknown };
      if (typed.type === "text" && typeof typed.text === "string") {
        textBlocks.push(typed.text);
      }
    }

    return textBlocks.join("\n").trim();
  }

  private persistMessagesSnapshot(): void {
    this.ctx.storage.kv.put(CHAT_PERSISTED_MESSAGES_KEY, this.persistedMessages);
  }

  private appendPersistedUserMessage(content: string): void {
    const context = this.chatContext;
    if (!context?.threadId) return;

    this.persistedMessages = [
      ...this.persistedMessages,
      {
        id: `user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        thread_id: context.threadId,
        role: 'user',
        content,
        created_at: Date.now(),
      },
    ];
    this.persistMessagesSnapshot();
  }

  private applyPersistedRunnerEvent(
    provider: 'claude' | 'codex',
    event: unknown,
  ): void {
    const context = this.chatContext;
    if (!context?.threadId) return;

    this.persistedMessages = applyRuntimeEventToMessages(
      this.persistedMessages,
      context.threadId,
      provider,
      event,
      this.persistedStreamingMessageIds,
    );
    this.persistMessagesSnapshot();
  }

  getPersistedMessages(): UiMessage[] | null {
    return this.persistedMessages.length > 0 ? this.persistedMessages : null;
  }

  private async updateThreadMetadataForUserMessage(messageContent: string): Promise<void> {
    const context = this.chatContext;
    if (!context?.orgId || !context?.threadId || !context.workspaceId) return;

    const orgStub = this.env.ORG.get(this.env.ORG.idFromName(context.orgId));
    const thread = await orgStub.getThread(context.threadId);
    if (!thread) return;

    await orgStub.touchThread(context.threadId);

    const titleSourceMessage = getThreadTitleSourceMessage(messageContent);
    if (!titleSourceMessage) {
      return;
    }

    const hasFirstUserMessage = typeof thread.first_user_message === 'string'
      && thread.first_user_message.trim().length > 0;
    if (hasFirstUserMessage) {
      return;
    }

    await orgStub.setThreadFirstUserMessage(context.threadId, titleSourceMessage);

    if (!isPlaceholderThreadTitle(thread.title) || this.titleGenerationInFlight) {
      return;
    }

    this.titleGenerationInFlight = true;
    await this.generateThreadTitleFromMessage(context.threadId, titleSourceMessage);
  }

  private async generateThreadTitleFromMessage(threadId: string, message: string): Promise<void> {
    try {
      const response = await this.env.AI.run('@cf/google/gemma-3-12b-it', {
        messages: [
          { role: 'system', content: THREAD_TITLE_GENERATION_SYSTEM_PROMPT },
          { role: 'user', content: message },
        ],
        temperature: 1,
        max_tokens: 50,
      }) as { response?: string };

      const title = sanitizeGeneratedThreadTitle(response?.response);
      if (!title) {
        return;
      }

      const context = this.chatContext;
      if (!context?.orgId) {
        return;
      }

      const orgStub = this.env.ORG.get(this.env.ORG.idFromName(context.orgId));
      await orgStub.updateThread(threadId, title);
      await this.setTitle(title);
    } catch (err) {
      console.error('[ChatThreadDO] failed to generate thread title', err);
    } finally {
      this.titleGenerationInFlight = false;
    }
  }

  private async ensureRunnerConnected(): Promise<void> {
    await this.withRunnerTransitionLock("ensure_runner_connected", async () => {
      await this.ensureRunnerConnectedUnlocked();
    });
  }

  private async ensureRunnerConnectedUnlocked(): Promise<void> {
    if (this.runnerSocket) {
      console.log(`[ChatThreadDO] ensureRunnerConnected: already connected`);
      this.trace("ensure_runner_connected_already_connected");
      return;
    }
    if (this.runnerConnectPromise) {
      console.log(
        `[ChatThreadDO] ensureRunnerConnected: waiting on existing connect`,
      );
      this.trace("ensure_runner_connected_wait_existing");
      await this.runnerConnectPromise;
      return;
    }

    this.runnerConnectPromise = (async () => {
      const context = this.chatContext;
      if (!context) {
        throw new Error("Missing chat context");
      }

      console.log(
        `[ChatThreadDO] ensureRunnerConnected: connecting for thread=${context.threadId}`,
      );
      this.trace("ensure_runner_connected_start", {
        contextThreadId: context.threadId,
        contextWorkspaceId: context.workspaceId,
        contextOrgId: context.orgId,
      });

      const container = new WorkspaceContainer(this.env, context.workspaceId, context.orgId);
      const orgStub = this.env.ORG.get(this.env.ORG.idFromName(context.orgId));
      const thread = await orgStub.getThread(context.threadId);
      const provider = thread?.provider === 'codex' ? 'codex' : 'claude';
      if (context.provider !== provider) {
        this.chatContext = { ...context, provider };
        this.ctx.storage.kv.put(CHAT_CONTEXT_KEY, this.chatContext);
      }
      // Build thread-specific env (integration creds + thread ID).
      const { envVars, byokProxy } = await container.buildChatRunnerEnv({
        threadId: context.threadId,
        provider,
      });
      if (provider === 'codex' && this.codexSessionId) {
        envVars.CHIRIDION_CODEX_SESSION_ID = this.codexSessionId;
      }
      // Forward auto-compaction override so dev/staging can trigger compaction early.
      if (this.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE) {
        envVars.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE =
          this.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE;
      }
      this.trace("ensure_runner_env_built", {
        envVarCount: Object.keys(envVars).length,
      });

      // Open WebSocket to the control plane's /chat endpoint.
      // BYOK credentials pass via headers so sandbox-host can call the provider directly.
      const chatWs = await container.connectChatWebSocket({
        threadId: context.threadId,
        userId: context.userId ?? undefined,
        byokProxy,
      });
      this.attachRunnerSocket(chatWs);
      this.trace("ensure_runner_ws_connected");

      // Send init message with thread ID and env vars.
      if (
        !this.sendRunnerCommand({
          type: "init",
          threadId: context.threadId,
          env: envVars,
          lastSeq: this.lastRunnerSeq,
        })
      ) {
        throw new Error("Failed to send init command - connection broken");
      }

      console.log(
        `[ChatThreadDO] ensureRunnerConnected: connected for thread=${context.threadId}`,
      );
      this.runnerReconnectArmed = false;
      this.runnerReconnectAttempt = 0;
      this.cancelRunnerDisconnectGrace("runner_connected");
      this.stopRunnerReconnectLoop("runner_connected");
      this.trace("ensure_runner_connected_complete", {
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
    this.trace("runner_socket_attached");

    ws.addEventListener("message", (event: MessageEvent) => {
      if (typeof event.data !== "string") return;
      try {
        const parsed = JSON.parse(event.data) as Record<string, unknown>;
        this.trace("runner_socket_message", {
          type: typeof parsed.type === "string" ? parsed.type : "unknown",
          bytes: event.data.length,
        });
        this.handleRunnerEvent(parsed);
      } catch {
        // Non-JSON messages from the control plane; ignore.
        this.trace("runner_socket_message_non_json", {
          bytes: event.data.length,
        });
      }
    });

    ws.addEventListener("close", (event) => {
      this.ctx.waitUntil(
        this.withRunnerTransitionLock("runner_socket_close", async () => {
          const wasActiveSocket = this.runnerSocket === ws;
          if (!wasActiveSocket) {
            this.trace("runner_socket_closed_stale", {
              code: event.code,
              reason: event.reason || "",
            });
            return;
          }

          this.stopRunnerPingLoop("runner_socket_close");
          this.runnerSocket = null;

          const intentionalIdleDisconnect =
            this.runnerIntentionalIdleDisconnect;
          console.log(
            `[ChatThreadDO] runner websocket closed (code=${event.code})`,
          );
          this.trace("runner_socket_closed", {
            code: event.code,
            reason: event.reason || "",
            intentionalIdleDisconnect,
          });

          if (intentionalIdleDisconnect) {
            this.stopRunnerReconnectLoop("intentional_idle_disconnect");
            this.cancelRunnerDisconnectGrace("intentional_idle_disconnect");
            return;
          }

          if (event.code === RUNNER_CLOSE_CODE_BYOK_CHANGED) {
            const shouldReconnectImmediately =
              this.getChatSockets().length > 0 ||
              this.pendingExternalTurn !== null ||
              this.chatIsStreaming;
            this.stopRunnerReconnectLoop('byok_changed_close');
            this.cancelRunnerDisconnectGrace('byok_changed_close');
            this.persistRunnerSeqIfNeeded('disconnect');

            if (!shouldReconnectImmediately) {
              this.finalizeRunnerDisconnect('runner_restarted');
              return;
            }

            this.runnerReconnectArmed = true;
            this.armRunnerDisconnectGrace('byok_changed_close');
            this.ctx.waitUntil(
              this.tryRunnerReconnect('byok_changed_close').catch((err) => {
                console.error('[ChatThreadDO] BYOK reconnect failed', err);
              })
            );
            return;
          }

          if (this.getChatSockets().length > 0) {
            this.runnerReconnectArmed = true;
            this.armRunnerDisconnectGrace("runner_socket_close");
            this.scheduleRunnerReconnect("runner_socket_close");
          }
        }).catch((err) => {
          console.error(
            "[ChatThreadDO] runner socket close transition failed",
            err,
          );
        }),
      );
    });

    ws.addEventListener("error", (err) => {
      if (this.runnerSocket === ws) {
        this.stopRunnerPingLoop("runner_socket_error");
      }
      console.error("[ChatThreadDO] runner websocket error", err);
      this.trace("runner_socket_error", {
        error: String(err),
      });
    });

    // Accept after handlers are attached so no early messages are lost.
    ws.accept();
    this.startRunnerPingLoop();
  }

  private handleRunnerEvent(event: Record<string, unknown>): void {
    const eventType = typeof event.type === "string" ? event.type : "";
    const seq =
      typeof event.seq === "number" && Number.isFinite(event.seq)
        ? Math.max(0, Math.floor(event.seq))
        : null;

    if (seq !== null) {
      if (seq <= this.lastRunnerSeq) {
        this.trace("runner_event_deduped", {
          seq,
          lastRunnerSeq: this.lastRunnerSeq,
          eventType: eventType || "unknown",
        });
        return;
      }
      if (seq > this.lastRunnerSeq + 1) {
        this.trace("runner_event_seq_gap", {
          seq,
          lastRunnerSeq: this.lastRunnerSeq,
          eventType: eventType || "unknown",
        });
      }
      this.lastRunnerSeq = seq;
      this.persistRunnerSeqIfNeeded("event");
    }

    this.trace("handle_runner_event", {
      eventType: eventType || "unknown",
      seq,
    });

    if (eventType === "pong") {
      this.trace("runner_pong_received", {
        ts: typeof event.ts === "number" ? event.ts : null,
      });
      return;
    }

    if (eventType === "replay_gap") {
      this.trace("runner_replay_gap", {
        oldestSeq: typeof event.oldestSeq === "number" ? event.oldestSeq : null,
        newestSeq: typeof event.newestSeq === "number" ? event.newestSeq : null,
        requestedAfterSeq:
          typeof event.requestedAfterSeq === "number"
            ? event.requestedAfterSeq
            : null,
      });
      return;
    }

    if (eventType === "control") {
      const action = typeof event.action === "string" ? event.action : "";
      if (action === "runner_idle_disconnect") {
        const generationAtSignal = this.runnerActivityGeneration;
        this.trace("runner_idle_disconnect_control_received", {
          generationAtSignal,
          reason: typeof event.reason === "string" ? event.reason : "",
          idleMs: typeof event.idleMs === "number" ? event.idleMs : null,
        });
        this.ctx.waitUntil(
          this.handleRunnerIdleDisconnectControl(
            generationAtSignal,
            event,
          ).catch((err) => {
            console.error(
              "[ChatThreadDO] runner idle disconnect handling failed",
              err,
            );
          }),
        );
      }
      return;
    }

    if (eventType === "error") {
      console.error(
        `[ChatThreadDO] runner error: ${JSON.stringify({ error: event.error, source: event.source }).slice(0, 500)}`,
      );
      this.setChatIsStreaming(false);
      this.resolvePendingExternalTurn({
        status: "error",
        error: typeof event.error === "string" ? event.error : "Runner error",
      });
    }

    if (eventType === "streaming_resumed") {
      // Control plane signals that a new turn started from team polling —
      // re-set streaming state so external ingress correctly returns busy.
      this.setChatIsStreaming(true);
    }

    if (eventType === 'assistant_delta') {
      return;
    }

    if (eventType === 'todo_state') {
      const todos = event.todos;
      if (Array.isArray(todos)) {
        this.currentTodos = todos;
        this.ctx.storage.kv.put(CHAT_TODOS_KEY, todos);
      }
    }

    if (eventType === "ask_user_question") {
      const questionId =
        typeof event.questionId === "string" ? event.questionId : "";
      const questions = Array.isArray(event.questions) ? event.questions : [];
      if (questionId && questions.length > 0) {
        if (this.pendingQuestions.has(questionId)) {
          this.trace("runner_question_duplicate", { questionId, seq });
          return;
        }

        this.pendingQuestions.set(questionId, {
          questionId,
          toolUseId:
            typeof event.toolUseId === "string" ? event.toolUseId : undefined,
          questions,
        });

        if (!this.hasAvailableBrowserUser()) {
          this.markRunnerActivity("question_unavailable_no_browser");
          this.ctx.waitUntil(
            this.autoAnswerPendingQuestionAsUnavailable(
              questionId,
              DEFAULT_EXTERNAL_ASK_USER_QUESTION_UNAVAILABLE_MESSAGE,
            ).catch((err) => {
              console.error(
                "[ChatThreadDO] failed to auto-answer unavailable AskUserQuestion",
                err,
              );
            }),
          );
          return;
        }

        if (this.pendingExternalTurn) {
          this.markRunnerActivity("external_question_waiting_browser");
          this.resolvePendingExternalTurn({
            status: "busy",
          });
        }
      }
    }

    if (eventType === "question_answered") {
      const questionId =
        typeof event.questionId === "string" ? event.questionId : "";
      if (questionId) {
        this.pendingQuestions.delete(questionId);
      }
    }

    if (eventType === 'session_id') {
      const sessionId = typeof event.sessionId === 'string' ? event.sessionId.trim() : '';
      if (sessionId) {
        this.codexSessionId = sessionId;
        this.ctx.storage.kv.put(CHAT_CODEX_SESSION_ID_KEY, sessionId);
      }
      return;
    }

    if (eventType === 'sdk_event') {
      const sdkEvent = event.event as {
        type?: string;
        subtype?: string;
        modelUsage?: unknown;
        message?: { content?: unknown };
        event?: {
          type?: string;
          message?: {
            usage?: unknown;
            model?: unknown;
          };
          delta?: {
            type?: string;
            text?: string;
          };
        };
      } | undefined;

      const contextUsageUpdate = applyContextUsageSdkEvent(
        {
          contextUsedPercent: this.contextUsedPercent,
          transientContextUsedPercent: this.transientContextUsedPercent,
          lastMessageStartUsage: this.lastMessageStartUsage,
          usageIsPostCompaction: this.usageIsPostCompaction,
          cachedContextWindowByModel: this.cachedContextWindowByModel,
        },
        sdkEvent,
      );
      this.contextUsedPercent = contextUsageUpdate.nextState.contextUsedPercent;
      this.transientContextUsedPercent =
        contextUsageUpdate.nextState.transientContextUsedPercent;
      this.lastMessageStartUsage =
        contextUsageUpdate.nextState.lastMessageStartUsage;
      this.usageIsPostCompaction =
        contextUsageUpdate.nextState.usageIsPostCompaction;
      this.cachedContextWindowByModel =
        contextUsageUpdate.nextState.cachedContextWindowByModel;

      if (contextUsageUpdate.contextWindowCacheChanged) {
        this.ctx.storage.kv.put(
          CHAT_CONTEXT_WINDOW_BY_MODEL_KEY,
          this.cachedContextWindowByModel,
        );
      }

      if (contextUsageUpdate.liveUsedPercent !== undefined) {
        this.broadcastRealtime({
          type: "context_usage_state",
          usedPercent: contextUsageUpdate.liveUsedPercent,
        });
      }

      if (contextUsageUpdate.finalUsedPercent !== null) {
        this.ctx.storage.kv.put(
          CHAT_CONTEXT_USED_PERCENT_KEY,
          contextUsageUpdate.finalUsedPercent,
        );
        this.broadcastRealtime({
          type: "context_usage_state",
          usedPercent: contextUsageUpdate.finalUsedPercent,
        });
      }

      if (sdkEvent?.type === "stream_event" && this.pendingExternalTurn) {
        const streamEvent = sdkEvent.event;
        if (streamEvent?.type === "message_start") {
          this.pendingExternalTurn.streamingText = "";
        }
        if (
          streamEvent?.type === "content_block_delta" &&
          streamEvent.delta?.type === "text_delta"
        ) {
          this.pendingExternalTurn.streamingText +=
            streamEvent.delta.text || "";
        }
      }

      if (sdkEvent?.type === "assistant" && this.pendingExternalTurn) {
        const assistantText = this.extractAssistantTextFromContent(
          sdkEvent.message?.content,
        );
        if (assistantText) {
          this.pendingExternalTurn.latestAssistantText = assistantText;
        }
      }

      if (sdkEvent?.type === "result") {
        // Don't clear todos here — the client handles clearing via its own
        // auto-timeout (1.5-2s after all todos are completed) and on next
        // streaming start. Clearing server-side on result races the client
        // and destroys persistence before reconnecting clients can replay.
        this.setChatIsStreaming(false);
        this.persistRunnerSeqIfNeeded("result");
        this.resolvePendingExternalTurn({ status: "result" });
      }

      this.applyPersistedRunnerEvent('claude', sdkEvent);
    }

    if (eventType === 'runtime_event') {
      const runtimeEvent = event.event;
      this.applyPersistedRunnerEvent('codex', runtimeEvent);

      const method =
        runtimeEvent && typeof runtimeEvent === 'object' && 'method' in (runtimeEvent as Record<string, unknown>)
          ? (runtimeEvent as { method?: unknown }).method
          : null;

      if (method === 'turn/completed') {
        this.setChatIsStreaming(false);
        this.persistRunnerSeqIfNeeded('result');
      }
    }

    if (eventType === 'result') {
      this.setChatIsStreaming(false);
      const sessionId = typeof event.sessionId === 'string' ? event.sessionId.trim() : '';
      if (sessionId) {
        this.codexSessionId = sessionId;
        this.ctx.storage.kv.put(CHAT_CODEX_SESSION_ID_KEY, sessionId);
      }
      this.resolvePendingExternalTurn({
        status: 'result',
        reply: typeof event.result === 'string' ? event.result : undefined,
      });
      return;
    }

    if (eventType === "session" || eventType === "ready") {
      if (
        eventType === "ready" &&
        this.pendingQuestions.size > 0 &&
        !this.hasAvailableBrowserUser()
      ) {
        this.ctx.waitUntil(
          this.autoAnswerAllPendingQuestionsAsUnavailable(
            DEFAULT_EXTERNAL_ASK_USER_QUESTION_UNAVAILABLE_MESSAGE,
          ).catch((err) => {
            console.error(
              "[ChatThreadDO] failed to retry unavailable AskUserQuestion auto-answers",
              err,
            );
          }),
        );
      }
      // These are synthesized by ChatThreadDO on init.
      return;
    }

    this.pushChatEvent(event);
  }

  private async handleRunnerIdleDisconnectControl(
    generationAtSignal: number,
    event: Record<string, unknown>,
  ): Promise<void> {
    await this.withRunnerTransitionLock(
      "runner_idle_disconnect_control",
      async () => {
        if (generationAtSignal !== this.runnerActivityGeneration) {
          this.trace("runner_idle_disconnect_control_skipped_generation", {
            generationAtSignal,
            currentGeneration: this.runnerActivityGeneration,
          });
          return;
        }
        if (!this.runnerSocket) {
          this.trace("runner_idle_disconnect_control_skipped_no_socket", {
            generationAtSignal,
          });
          return;
        }

        this.runnerIntentionalIdleDisconnect = true;
        this.ctx.storage.kv.put(CHAT_RUNNER_IDLE_DISCONNECT_KEY, true);
        this.stopRunnerReconnectLoop("idle_disconnect_control");
        this.cancelRunnerDisconnectGrace("idle_disconnect_control");
        this.trace("runner_idle_disconnect_control_closing", {
          generationAtSignal,
          reason: typeof event.reason === "string" ? event.reason : "",
        });
        try {
          this.runnerSocket.close(1000, "idle_post_result");
        } catch {
          this.trace("runner_idle_disconnect_control_close_failed");
        }
      },
    );
  }

  private persistRunnerSeqIfNeeded(
    reason: "event" | "result" | "disconnect",
  ): void {
    if (this.lastRunnerSeq <= this.lastPersistedRunnerSeq) return;
    const delta = this.lastRunnerSeq - this.lastPersistedRunnerSeq;
    if (reason === "event" && delta < 25) return;
    this.lastPersistedRunnerSeq = this.lastRunnerSeq;
    this.ctx.storage.kv.put(CHAT_RUNNER_LAST_SEQ_KEY, this.lastRunnerSeq);
    this.trace("runner_seq_persisted", {
      reason,
      lastRunnerSeq: this.lastRunnerSeq,
    });
  }

  private finalizeRunnerDisconnect(subtype: string): void {
    this.setChatIsStreaming(false);
    const hadTransientUsage = this.transientContextUsedPercent !== null;
    this.transientContextUsedPercent = null;
    this.lastMessageStartUsage = null;
    this.usageIsPostCompaction = true;
    if (hadTransientUsage) {
      this.broadcastRealtime({ type: 'context_usage_state', usedPercent: this.contextUsedPercent });
    }
    this.pushChatEvent({
      type: 'sdk_event',
      event: { type: 'result', subtype },
    });
  }

  private armRunnerDisconnectGrace(source: string): void {
    this.cancelRunnerDisconnectGrace("rearm");
    this.runnerDisconnectGraceTimer = setTimeout(() => {
      this.runnerDisconnectGraceTimer = null;
      this.runnerReconnectArmed = false;
      this.stopRunnerReconnectLoop("disconnect_grace_expired");
      this.persistRunnerSeqIfNeeded("disconnect");
      if (this.runnerSocket || this.getChatSockets().length === 0) return;
      this.trace("runner_disconnect_grace_expired", {
        source,
        lastRunnerSeq: this.lastRunnerSeq,
      });
      this.finalizeRunnerDisconnect('runner_disconnected');
    }, RUNNER_RECONNECT_GRACE_MS) as unknown as number;
    this.trace("runner_disconnect_grace_armed", {
      source,
      timeoutMs: RUNNER_RECONNECT_GRACE_MS,
    });
  }

  private cancelRunnerDisconnectGrace(reason: string): void {
    if (this.runnerDisconnectGraceTimer === null) return;
    clearTimeout(this.runnerDisconnectGraceTimer);
    this.runnerDisconnectGraceTimer = null;
    this.trace("runner_disconnect_grace_cleared", { reason });
  }

  private scheduleRunnerReconnect(reason: string): void {
    if (!this.runnerReconnectArmed) return;
    if (
      this.runnerSocket ||
      this.runnerConnectPromise ||
      this.runnerReconnectTimer !== null
    )
      return;
    const attemptIndex = Math.min(
      this.runnerReconnectAttempt,
      RUNNER_RECONNECT_BACKOFF_MS.length - 1,
    );
    const delayMs = RUNNER_RECONNECT_BACKOFF_MS[attemptIndex];
    this.runnerReconnectAttempt += 1;
    this.runnerReconnectTimer = setTimeout(() => {
      this.runnerReconnectTimer = null;
      this.ctx.waitUntil(
        this.tryRunnerReconnect("timer").catch((err) => {
          console.error("[ChatThreadDO] runner reconnect timer failed", err);
        }),
      );
    }, delayMs) as unknown as number;
    this.trace("runner_reconnect_scheduled", {
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
      this.trace("runner_reconnect_succeeded", {
        source,
        attempt: this.runnerReconnectAttempt,
      });
    } catch (err) {
      this.trace("runner_reconnect_failed", {
        source,
        attempt: this.runnerReconnectAttempt,
        error: err instanceof Error ? err.message : String(err),
      });
      this.scheduleRunnerReconnect("connect_failed");
    }
  }

  private stopRunnerReconnectLoop(reason: string): void {
    if (this.runnerReconnectTimer !== null) {
      clearTimeout(this.runnerReconnectTimer);
      this.runnerReconnectTimer = null;
    }
    this.runnerReconnectAttempt = 0;
    this.runnerReconnectArmed = false;
    this.trace("runner_reconnect_stopped", { reason });
  }

  private sendRunnerCommand(message: Record<string, unknown>): boolean {
    if (!this.runnerSocket) return false;
    try {
      this.runnerSocket.send(JSON.stringify(message));
      this.trace("send_runner_command", {
        type: typeof message.type === "string" ? message.type : "unknown",
      });
      return true;
    } catch {
      this.runnerSocket = null;
      this.trace("send_runner_command_failed", {
        type: typeof message.type === "string" ? message.type : "unknown",
      });
      return false;
    }
  }

  private async sendRunnerCommandWithReconnect(
    message: Record<string, unknown>,
  ): Promise<boolean> {
    if (this.sendRunnerCommand(message)) return true;
    this.runnerReconnectArmed = true;
    this.armRunnerDisconnectGrace("send_retry");
    try {
      await this.ensureRunnerConnected();
    } catch {
      this.scheduleRunnerReconnect("send_retry_connect_failed");
      return false;
    }
    return this.sendRunnerCommand(message);
  }

  private startRunnerPingLoop(): void {
    this.stopRunnerPingLoop("restart");
    this.runnerPingTimer = setInterval(() => {
      const sent = this.sendRunnerCommand({ type: "ping", ts: Date.now() });
      this.trace(sent ? "runner_ping_sent" : "runner_ping_send_failed");
      if (!sent && this.getChatSockets().length > 0) {
        this.runnerReconnectArmed = true;
        this.armRunnerDisconnectGrace("runner_ping_send_failed");
        this.scheduleRunnerReconnect("runner_ping_send_failed");
      }
    }, RUNNER_PING_INTERVAL_MS) as unknown as number;
    this.trace("runner_ping_started", { intervalMs: RUNNER_PING_INTERVAL_MS });
  }

  private stopRunnerPingLoop(reason: string): void {
    if (this.runnerPingTimer === null) return;
    clearInterval(this.runnerPingTimer);
    this.runnerPingTimer = null;
    this.trace("runner_ping_stopped", { reason });
  }

  private emitChatError(message: string): void {
    this.pushChatEvent({ type: "error", error: message });
  }

  private pushChatEvent(payload: Record<string, unknown>): void {
    const sessionId = this.chatContext?.threadId || "";
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
    this.trace("push_chat_event", {
      payloadType: typeof payload.type === "string" ? payload.type : "unknown",
      eventId,
      bufferSize: this.chatEventBuffer.length,
    });

    this.broadcastChat(envelope);
  }

  private replayChatEvents(ws: WebSocket, lastEventId: number): void {
    for (const envelope of this.chatEventBuffer) {
      const eventId =
        typeof envelope.eventId === "number" ? envelope.eventId : 0;
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
    this.trace("broadcast_chat", {
      payloadType: typeof typed.type === "string" ? typed.type : "unknown",
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
      this.trace("send_direct", {
        payloadType: typeof typed.type === "string" ? typed.type : "unknown",
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

    const pendingConnectionPrompts = Array.from(
      this.pendingConnectionSetups.entries(),
    ).sort(([, a], [, b]) => a.createdAt - b.createdAt);
    for (const [requestId, info] of pendingConnectionPrompts) {
      this.sendDirect(ws, {
        type: "connection_setup_prompt",
        requestId,
        integrationType: info.integrationType,
        suggestedName: info.suggestedName,
        message: info.message,
        dynamicSchema: info.dynamicSchema,
        mcpDoId: info.mcpDoId,
      });
    }

    const pendingBugReportPrompts = Array.from(
      this.pendingBugReports.entries(),
    ).sort(([, a], [, b]) => a.createdAt - b.createdAt);
    for (const [requestId, info] of pendingBugReportPrompts) {
      this.sendDirect(ws, {
        type: "bug_report_prompt",
        requestId,
        message: info.message,
      });
    }
  }
}
