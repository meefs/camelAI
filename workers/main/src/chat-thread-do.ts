
import {
  Agent,
  callable,
  type Connection,
  type ConnectionContext,
  type WSMessage,
} from "agents";
import { Type } from "typebox";
import type {
  Agent as PiCoreAgent,
  AfterToolCallContext,
  AfterToolCallResult,
  AgentEvent,
  AgentMessage,
  AgentTool,
  AgentToolResult,
} from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  isContextOverflow,
} from "@earendil-works/pi-ai";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Model,
} from "@earendil-works/pi-ai";
import type { OrgDO, UserDO } from "./auth";
import type { WorkspaceDO } from "./workspace";
import type { WorkspaceCronDO } from "./workspace-cron";
import type { WorkerLogsDO } from "./worker-logs-do";
import { WorkspaceFilesystemClient, type WorkspaceFilesystemEnv } from "./workspace-filesystem-do";
import { prewarmWorkspaceBuildSandboxes } from "./project-build-service";
import { type ProjectRuntimeServiceVmEnv } from "./project-runtime-service-vm";
import { formatAttributedUserMessage } from './chat-author-attribution';
import { injectFileSafetyMessage } from './file-safety';
import { applyMentionContext } from './mention-context';
import {
  getThreadUserMessageSources,
  isPlaceholderThreadTitle,
} from '../../../src/lib/thread-title';
import { AUXILIARY_AI_MODEL } from '../../../src/lib/auxiliary-ai.server';
import { generateChatGroupEmojiWithOpenAI } from '../../../src/lib/chat-group-avatar-generation.server';
import { generateThreadTitleWithOpenAI } from '../../../src/lib/thread-title-generation.server';
import {
  extractThreadCompletionSummarySource,
  generateThreadCompletionSummaryWithOpenAI,
} from '../../../src/lib/thread-completion-summary-generation.server';
import { normalizeThreadPreviewUserMessage } from '../../../src/lib/thread-preview';
import { getToolSummary } from '../../../src/lib/tool-activity-summary';
import { applyRuntimeEventToMessages } from '../../../src/lib/runtime-message-state';
import { attachArtifactsToToolResultMessages } from '../../../src/lib/streaming';
import { normalizePiUiMetadata, normalizeRuntimeCallArtifacts, stripPiUiMetadata, type PiUiMetadata, type RuntimeCallArtifact } from '../../../src/lib/runtime-artifacts';
import type {
  ChatGroupAvatar,
  LlmModel,
  Message,
  ThreadCompletionSummaryStatus,
  ToolResultBlock,
  ToolUseBlock,
} from '../../../src/types';
import { decryptCredentials } from "../../../src/lib/integration-crypto";
import {
  CUSTOM_LLM_MODEL,
  DEFAULT_LLM_MODEL,
  getStoredCustomLlmProviderApi,
  getStoredCustomLlmProviderModelId,
  normalizeLlmModel,
  parseStoredLlmProviderConfig,
} from "../../../src/lib/llm-provider-config";
import {
  getEffectiveLlmProviderConfig,
  getSelfhostAiProviderCredentials,
  isSelfhostRuntime,
} from "../../../src/lib/selfhost-ai-provider";
import { isOrgBanned } from "./ban-list";
import type { WorkspaceThreadStreamingOptions } from "./thread-status";
import { getPreferredAppUrl } from "../../../src/lib/app-url";
import { buildCloudflareGatewayUrl } from "../../../src/lib/cloudflare-ai-gateway";

import {
  PI_SKILL_DESCRIPTIONS,
  PI_SKILL_NAMES,
} from "./pi-skills-bundle";
import {
  createPiSubagentSystemPrompt,
  createPiSystemPrompt,
} from "./pi-system-prompt";

import { PI_CONTAINER_TOOL_DEFINITIONS } from "./pi-container-tools";
import { repairPiMessageHistoryForReplay } from "./pi-message-history";
import { planPiTurnResume } from "./pi-turn-journal";

import { recordErrorEvent, recordObservabilityEvent } from "./observability";
import {
  buildChatErrorEventPayload,
  createChatErrorFingerprint,
  normalizeChatErrorKind,
  normalizeChatErrorMessage,
  normalizeChatErrorSource,
  normalizeChatErrorStatus,
  normalizeModelHistoryValue,
} from "./chat-error-metadata";
import {
  BrowserPromptCoordinator,
  type ConnectionSetupResponse,
  type PendingConnectionSetupPromptData,
  type PendingQuestionInfo,
} from "./chat-thread-browser-prompts";
import {
  applyContextUsageSdkEvent,
  resolveContextUsageForInit,
  type LastMessageStartUsage,
} from "./chat-context-usage";

import { buildWorkspaceScopedR2Key } from "../../../src/lib/workspace-r2-paths";

import { retryTransientDurableObjectRpc } from "../../../src/lib/do-rpc-retry.server";

import { normalizeChannelIndicatorKind } from "../../../src/lib/channel-kinds";

import { codeModeWorkerModule } from "./code-mode-runner";

import type {
  DynamicIntegrationSchema,
} from "../../../src/lib/integration-registry";

export type { ConnectionSetupResponse } from "./chat-thread-browser-prompts";
export {
  applyContextUsageSdkEvent,
  extractContextWindowByModel,
  resolveContextUsageForInit,
  shallowEqualNumberMaps,
} from "./chat-context-usage";
export type {
  ContextUsageSdkEvent,
  ContextUsageTrackingState,
  ContextUsageTrackingUpdate,
  LastMessageStartUsage,
} from "./chat-context-usage";
export { prepareCodeModeUserCode } from "./code-mode-runner";

// Code-mode tool layer lives in ./code-mode-tools (extracted from this file).
// Imported here for internal use and re-exported so existing import paths
// (`from "./chat-thread-do"`) keep working for external callers.
import {
  CodeModeToolsBinding,
  BASH_TOOL,
  CODE_MODE_COMPATIBILITY_DATE,
  CODE_MODE_DEFAULT_MAX_OUTPUT_CHARACTERS,
  CODE_MODE_DEFAULT_TIMEOUT_MS,
  CODE_MODE_MAX_OUTPUT_CHARACTERS,
  CODE_MODE_MAX_TIMEOUT_MS,
  CODE_MODE_PI_PASSTHROUGH_TOOL_DEFINITIONS,
  CODE_MODE_TOOL_DEFINITIONS,
  clampCodeModeInteger,
  normalizeTodoItems,
  truncateCodeModeText,
} from "./code-mode-tools";
import type {
  CodeModeToolsProps,
  AIVirtualBindingProps,
} from "./code-mode-tools";
export { CodeModeToolsBinding, CODE_MODE_PI_PASSTHROUGH_TOOL_DEFINITIONS };
export type { CodeModeToolsProps, AIVirtualBindingProps };

// Outbound channel tooling lives in ./chat-channels (extracted from this file).
import { ChannelTools } from "./chat-channels";

// Parsed-chat-message conversion (agent-eval / admin explorer) lives in
// ./pi-message-export (extracted from this file).
import {
  PI_USER_STOP_METADATA_REASON,
  isPiUserStopMessage,
  isInternalPiClientMessage,
  isCompactSummaryPiMessage,
  piCoreForkMessageIds,
  piCoreMessageToParsedChatMessage,
  attachPiToolResultToParsedMessages,
} from "./pi-message-export";

// Pure Pi model/provider mapping helpers live in ./pi-model-resolution.
import { PiModelMapping } from "./pi-model-resolution";

// Pure Pi message/tool-result storage helpers live in ./pi-message-storage.
import {
  PI_PROVIDER_SUPPORTED_IMAGE_MIME_TYPES,
  PI_SQLITE_STORAGE_SOFT_LIMIT_CHARS,
  PI_MAX_PERSISTED_IMAGE_DATA_CHARS,
  PI_R2_IMAGE_REF_METADATA_KEY,
  PI_TOOL_RESULT_MAX_LINES,
  PI_TOOL_RESULT_MAX_BYTES,
  PI_TOOL_RESULT_R2_REF_METADATA_KEY,
  PI_TAIL_TRUNCATED_TOOL_NAMES,
  emptyPiSqlStorageStats,
  normalizePiImageMimeType,
  piUnsupportedImageText,
  sanitizePiProviderMessage,
  sanitizePiModelMessage,
  shrinkPiValueForSqlStorage,
  preparePiMessageForSqlStorage,
  serializePiMessageForSqlStorageDetailed,
} from "./pi-message-storage";
import type {
  PiR2ImageReference,
  PiR2ToolResultReference,
  PiToolResultTruncation,
  PiSqlStorageStats,
  PiSqlStorageSerialization,
} from "./pi-message-storage";

export type PreviewTarget =
  | {
      kind: "app";
      scriptName: string;
      isPublic: boolean;
    }
  | {
      kind: "file";
      source: "workspace" | "project" | "upload" | "output" | "vm";
      workspaceId: string;
      path: string;
      project?: string;
      filename?: string;
      contentType?: string;
    }
  | {
      kind: "runtime_artifact";
      artifact: RuntimeCallArtifact;
    };

type PiBillingSource = "hosted" | "byok";
export type PiHeaderValue = string | null;

const PI_USER_STOP_TEXT = "Stopped by user";
const PI_PROVIDER_TRANSIENT_RETRY_ATTEMPTS = 2;
const PI_PROVIDER_TRANSIENT_RETRY_DELAY_MS = 300;
const PI_PROVIDER_TRANSIENT_ERROR_PATTERNS = [
  "network connection lost",
  "connection lost",
  "transient issue on remote node",
];
const CHAT_ACTIVE_AUTOMATION_RUN_KEY = "activeAutomationRun";

// Trailing-debounce window for coalescing the high-frequency "thread is still
// streaming" activity updates that ChatThreadDO fan-in RPCs to the single
// WorkspaceDO instance. A burst of running-activity updates for the same thread
// collapses into one RPC carrying the LATEST activity state. Terminal streaming
// transitions (streaming start/stop) bypass this debounce entirely so a
// workspace UI is never stuck showing "streaming".
const WORKSPACE_STREAMING_ACTIVITY_DEBOUNCE_MS = 5_000;

// Prewarm the org-scoped DO-backed build container when a turn starts so its
// 10s+ cold boot overlaps the model's thinking instead of the deploy. Debounced
// so steering messages and rapid turns don't repeatedly re-warm.
const BUILD_SANDBOX_PREWARM_DEBOUNCE_MS = 4 * 60_000;

type LlmProviderConfigRecord = ReturnType<
  import("./identity/org-do").OrgDO["getLlmProviderConfig"]
>;

interface CachedLlmProviderConfig {
  orgId: string;
  value: LlmProviderConfigRecord;
}

export interface PiResolvedModelReference {
  provider: string;
  modelId: string;
  api?: string;
  hostedGatewayProvider: string;
  hostedModelId?: string;
  /** False for hosted-only camelAI routes that must not be served by BYOK keys. */
  byokAllowed?: boolean;
  // Reasoning effort to force on the hosted (AI Gateway) model. The gateway
  // provider reports supportsReasoningEffort=false in pi-ai, so without this
  // reasoning_effort is never sent and the route uses its upstream default.
  hostedReasoningEffort?: string;
}

interface PiRequestConfig {
  apiKey: string;
  api?: string;
  baseUrl?: string;
  headers?: Record<string, PiHeaderValue>;
  requestProvider?: string;
  requestModelId?: string;
  modelLookupProvider?: string;
  modelLookupModelId?: string;
  billingSource: PiBillingSource;
  creditChargeable: boolean;
  usageProvider?: string;
}

interface PiResolvedModelConfig {
  model: Model<any>;
  apiKey: string;
  headers?: Record<string, PiHeaderValue>;
  provider: string;
  modelId: string;
  billingSource: PiBillingSource;
  creditChargeable: boolean;
  usageProvider: string;
}

type AssistantCompletionPersistenceResult =
  | { status: "stored"; completedAt: number }
  | { status: "stale" }
  | { status: "failed" };

const PI_MODEL_CATALOG_FALLBACKS: Record<string, Model<any>> = {
  "anthropic/claude-sonnet-5": {
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 2,
      output: 10,
      cacheRead: 0.2,
      cacheWrite: 2.5,
    },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  } satisfies Model<"anthropic-messages">,
  "anthropic/claude-fable-5": {
    id: "claude-fable-5",
    name: "Claude Fable 5",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    compat: { forceAdaptiveThinking: true },
    reasoning: true,
    thinkingLevelMap: { off: null, xhigh: "xhigh" },
    input: ["text", "image"],
    cost: {
      input: 10,
      output: 50,
      cacheRead: 1,
      cacheWrite: 12.5,
    },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  } satisfies Model<"anthropic-messages">,
  "anthropic/claude-opus-4-8": {
    id: "claude-opus-4-8",
    name: "Claude Opus 4.8",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    thinkingLevelMap: { xhigh: "xhigh" },
    input: ["text", "image"],
    cost: {
      input: 5,
      output: 25,
      cacheRead: 0.5,
      cacheWrite: 6.25,
    },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  } satisfies Model<"anthropic-messages">,
  "openrouter/google/gemini-3.5-flash": {
    id: "google/gemini-3.5-flash",
    name: "Google: Gemini 3.5 Flash",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 1.5,
      output: 9,
      cacheRead: 0.15,
      cacheWrite: 0.08333333333333334,
    },
    contextWindow: 1048576,
    maxTokens: 65536,
  } satisfies Model<"openai-completions">,
  "openrouter/moonshotai/kimi-k2.7-code": {
    id: "moonshotai/kimi-k2.7-code",
    name: "MoonshotAI: Kimi K2.7 Code",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.74,
      output: 3.5,
      cacheRead: 0.15,
      cacheWrite: 0,
    },
    contextWindow: 262144,
    maxTokens: 16384,
  } satisfies Model<"openai-completions">,
  "openrouter/z-ai/glm-5.2": {
    id: "z-ai/glm-5.2",
    name: "Z.ai: GLM 5.2",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    // GLM 5.2 only accepts reasoning efforts "high" and "xhigh"; the Pi agent
    // defaults to "medium", so clamp the lower levels up to "high" to avoid
    // OpenRouter rejecting unsupported efforts.
    thinkingLevelMap: {
      minimal: "high",
      low: "high",
      medium: "high",
      high: "high",
      xhigh: "xhigh",
    },
    input: ["text"],
    cost: {
      input: 1.2,
      output: 4.1,
      cacheRead: 0.2,
      cacheWrite: 0,
    },
    contextWindow: 1048576,
    maxTokens: 131072,
  } satisfies Model<"openai-completions">,
};

function resolvePiModelCatalogFallback(
  resolved: PiResolvedModelReference,
): Model<any> | null {
  return PI_MODEL_CATALOG_FALLBACKS[`${resolved.provider}/${resolved.modelId}`] ?? null;
}

interface PiToolDefinitionOptions {
  includeSubagents?: boolean;
}

export interface CloudflareEmailSender {
  send(message: {
    to: string | string[];
    from: string | { email: string; name: string };
    subject: string;
    html?: string;
    text?: string;
    cc?: string | string[];
    bcc?: string | string[];
    replyTo?: string | { email: string; name: string };
    headers?: Record<string, string>;
    attachments?: Array<{
      content: string | ArrayBuffer;
      filename: string;
      type: string;
      disposition: "attachment" | "inline";
      contentId?: string;
    }>;
  }): Promise<{ messageId?: string }>;
}

export interface ChatEnv extends WorkspaceFilesystemEnv, ProjectRuntimeServiceVmEnv {
  // Main app static assets. Notebook deploys read the pre-built renderer SPA
  // from /notebook-renderer/ to synthesize published-notebook workers.
  ASSETS?: Fetcher;
  CHAT_THREAD: DurableObjectNamespace<ChatThreadDO>;
  ORG: DurableObjectNamespace<OrgDO>;
  USER: DurableObjectNamespace<UserDO>;
  WORKSPACE: DurableObjectNamespace<WorkspaceDO>;
  WORKSPACE_CRON?: DurableObjectNamespace<WorkspaceCronDO>;
  DETERMINISTIC_AUTOMATION_WORKFLOWS?: Workflow;
  WORKER_LOGS?: DurableObjectNamespace<WorkerLogsDO>;
  PROJECT_BUILD_SANDBOX?: DurableObjectNamespace<import("./project-build-sandbox.js").ProjectBuildSandbox>;
  MCP_OBJECT: DurableObjectNamespace;
  APP_KV: KVNamespace;
  R2_BUCKET: R2Bucket;
  IMAGES?: ImagesBinding;
  AI: Ai;
  ANTHROPIC_API_KEY: string;
  CF_ACCOUNT_ID?: string;
  CF_GATEWAY_NAME?: string;
  CF_GATEWAY_BASE_URL?: string;
  CF_GATEWAY_TOKEN?: string;
  INTEGRATION_SECRET_KEY: string;
  TOKEN_SIGNING_SECRET: string;
  AI_GATEWAY_AUTH_TOKEN?: string;
  // E2E determinism: when set, hosted/provider LLM calls are routed to the local
  // record/replay stub (scripts/llm-replay-stub.mjs). Unset in production.
  TEST_LLM_REPLAY_URL?: string;
  SELFHOST_AI_PROVIDER?: string;
  SELFHOST_AI_API_KEY?: string;
  SELFHOST_AI_BASE_URL?: string;
  SELFHOST_AI_MODEL?: string;
  SELFHOST_AI_NAME?: string;
  SELFHOST_AI_AUTH_TYPE?: string;
  SELFHOST_AI_API?: string;
  SELFHOST_AI_AWS_REGION?: string;
  LOCAL_APP_VANITY_DOMAIN?: string;
  LOCAL_APP_IFRAME_DOMAIN?: string;
  WORKER_BASE_URL?: string;
  CF_DISPATCH_NAMESPACE?: string;
  EMAIL_TO_USER: KVNamespace;
  SESSIONS?: KVNamespace;
  R2_MOUNT_DIR?: string;
  PLATFORM_SCRIPT_TOKENS?: KVNamespace;
  SANDBOX_PROXY_SECRET?: string;
  SANDBOX_DOCKER_PROXY_BASE_URL?: string;
  CODE_MODE_LOADER?: WorkerLoader;
  OBSERVABILITY_EVENTS?: AnalyticsEngineDataset;
  ERROR_ANALYTICS?: AnalyticsEngineDataset;
  CF_ZONE_ID?: string;
  CF_API_TOKEN?: string;
  CF_CUSTOM_HOSTNAME_FALLBACK?: string;
  CF_CUSTOM_HOSTNAME_CNAME_TARGET?: string;
  WORKSPACE_EMAIL_DOMAIN?: string;
  EMAIL_FROM_ADDRESS?: string;
  EMAIL?: CloudflareEmailSender;
  TELEGRAM_BOT_TOKEN?: string;
  NEXTJS_ENV?: string;
  FIRECRAWL_API_KEY?: string;
  FIRECRAWL_BASE_URL?: string;
  PARALLEL_API_KEY?: string;
  PARALLEL_BASE_URL?: string;
  EXA_API_KEY?: string;
  EXA_BASE_URL?: string;
  WEB_PROVIDER_ORDER?: string;
  CHIRIDION_WEB_PROVIDER_ORDER?: string;
  APP_DB?: D1Database;
  RUN_AGENT_EVALS?: string;
}

export interface ChatContextState {
  threadId: string;
  workspaceId: string;
  orgId: string;
  userId: string | null;
  userName: string | null;
  userEmail: string | null;
}

interface ActiveAutomationRunState {
  workspaceId: string;
  automationId: string;
  runId: string;
}

export interface ChatThreadForkState {
  previewTarget: PreviewTarget | null;
  previewTabs: PreviewTarget[];
  previewActiveTabId: string | null;
  previewVersion: number;
  chatContext: ChatContextState | null;
  currentTodos: unknown[];
  contextUsedPercent: number | null;
  usageIsPostCompaction: boolean;
  cachedContextWindowByModel: Record<string, number>;
}

export interface ChatThreadForkStateTarget {
  threadId: string;
  workspaceId: string;
  orgId: string;
  userId?: string | null;
}

interface ChatThreadAgentState {
  isStreaming: boolean;
  previewTabs: PreviewTarget[];
  previewActiveTabId: string | null;
  previewVersion: number;
  previewRefreshTabId: string | null;
  currentTodos: unknown[];
  contextUsedPercent: number | null;
  pendingQuestion: PendingQuestionInfo | null;
  connectionSetupPrompt: PendingConnectionSetupPromptData | null;
  title: string | null;
  titleUpdatedAt: number | null;
  model: LlmModel | null;
  modelUpdatedAt: number | null;
  // Metadata for the most recently completed turn, keyed by the turn's
  // assistant message id, so the browser can render duration/turn badges
  // without replaying turn/completed events.
  lastCompletedTurn: { id: string; durationMs: number; completedAtMs: number } | null;
  // The most recent terminal error, with a unique id so the browser shows it
  // exactly once (and can recover it on reconnect). Cleared at agent_start.
  lastError: {
    id: string;
    error: string;
    billingSource: string | null;
    provider: string | null;
    status: number | string | null;
    errorType: string | null;
  } | null;
}

export interface AdminExplorerThreadSummary {
  userMessageCount: number;
  userMessageCountCapped: boolean;
  hasError: boolean;
  errorCount: number;
  lastErrorAt: number | null;
  lastErrorMessage: string | null;
  models: string[];
}

export interface ChatThreadPiCoreForkResult {
  success: boolean;
  messages?: AgentMessage[];
  messageCount?: number;
  error?: string;
  code?: "NO_PI_CORE_MESSAGES" | "TARGET_NOT_FOUND";
}

export interface PiCoreMessageRow {
  idx: number;
  payload: string;
  created_at: number;
}

export interface PiCoreMessageHistoryRepairReport {
  ok: true;
  mode: "dry_run" | "repair";
  persisted: boolean;
  changed: boolean;
  beforeCount: number;
  validBeforeCount: number;
  afterCount: number;
  invalidRows: number;
  repairedCount: number;
  stats: {
    droppedToolResults: number;
    syntheticToolResults: number;
    reorderedAssistantBlocks: number;
  };
}

function cloneDurableState<T>(value: T): T {
  if (value === null || value === undefined) {
    return value;
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

export type NormalizedTodoStatus = "pending" | "in_progress" | "completed";

export interface NormalizedTodoItem {
  content: string;
  status: NormalizedTodoStatus;
  activeForm: string;
}

interface ChatUserMessageInput {
  content?: string;
  clientMessageId?: string;
}

export interface InitialUserMessageRequest {
  threadId?: string;
  workspaceId?: string;
  orgId?: string;
  userId?: string | null;
  userName?: string | null;
  userEmail?: string | null;
  messageSource?: string | null;
  message?: string;
  clientMessageId?: string | null;
  automationRun?: {
    workspaceId: string;
    automationId: string;
    runId: string;
  };
}

export interface InitialUserMessageResult {
  status: "accepted" | "busy" | "error";
  error?: string;
}

export interface AgentEvalParsedMessage {
  id: string;
  thread_id: string;
  role: "user" | "assistant";
  content: unknown;
  created_at: number;
  forkEntryId: string;
}

export interface AgentEvalSessionRequest extends InitialUserMessageRequest {
  timeoutMs?: number;
}

export interface AgentEvalDeployedApp {
  name: string;
  /** Authoritative app URL (the *.evals.camelai.app host for real eval deploys). */
  url: string;
  isPublic: boolean;
}

export interface AgentEvalSessionResult {
  status: "completed" | "busy" | "error";
  error?: string;
  result?: string;
  events: Array<Record<string, unknown>>;
  messages: AgentEvalParsedMessage[];
  /**
   * Apps the agent deployed during this eval, from the eval deploy registry. Captured
   * directly in the result so the deployed URLs are authoritative regardless of what
   * list_apps/set_preview report. Omitted when no apps were deployed.
   */
  deployedApps?: AgentEvalDeployedApp[];
}

export interface ChannelHistoryEventRequest {
  threadId?: string;
  workspaceId?: string;
  orgId?: string;
  channelKind?: string;
  connectionId?: string | null;
  remoteConversationId?: string | null;
  sourceThreadId?: string | null;
  direction?: "inbound" | "outbound";
  text?: string | null;
  providerMessageIds?: Array<string | number | null | undefined>;
  attachmentCount?: number;
  sentAt?: number;
}

export interface ChannelHistoryEventResult {
  status: "appended" | "skipped" | "error";
  error?: string;
}

export interface ChatThreadRuntimeStatus {
  isStreaming: boolean;
  pendingQuestionCount: number;
  oldestPendingQuestion: string | null;
  updatedAt: number | null;
}

interface CodeModeJavascriptRequest {
  code: string;
  orgId: string;
  workspaceId: string;
  threadId?: string;
  userId?: string;
  toolUseId?: string;
  timeoutMs?: number | null;
  maxOutputCharacters?: number | null;
}

interface CodeModeJavascriptResult {
  text: string;
}

/**
 * Thrown by {@link ChatThreadDO.withPiTurnInactivityTimeout} when a Pi turn
 * stalls past PI_TURN_INACTIVITY_TIMEOUT_MS. This is a server-side stall, not a
 * user-initiated abort: the Pi session is disposed (handlers unsubscribed)
 * before this is thrown, so no agent_end handler runs and callers must reset
 * streaming state themselves. Detect with `instanceof` so it is not confused
 * with the benign AbortError raised by a genuine user `stop`.
 */
class PiTurnInactivityTimeoutError extends Error {
  constructor(message = "Pi turn inactivity timeout") {
    super(message);
    this.name = "PiTurnInactivityTimeoutError";
  }
}

const CHAT_CONTEXT_KEY = "chatContext";
// Durable resume of an interrupted Pi turn (e.g. the DO is evicted mid-turn by a
// deploy). Each turn runs inside the Agents SDK durable fiber `PI_TURN_FIBER`,
// which holds `keepAlive()` for the turn and — if the DO dies mid-turn — leaves
// an orphan run row the SDK detects on the next wake, calling `onFiberRecovered`.
// `piActiveTurn` marks the in-flight turn (gating + attempt budget); the
// `pi_turn_journal` table mirrors the not-yet-committed tail so we know *what* to
// resume. We must NOT touch the raw DO alarm — the base Agent owns it.
const PI_ACTIVE_TURN_KEY = "piActiveTurn";
// Durable list (sync KV) of user messages handed to steer() while a turn streams,
// so an eviction before Pi drains them can re-deliver instead of losing them.
const PI_STEER_JOURNAL_KEY = "piSteerJournal";
// Name of the durable fiber that wraps a Pi turn (used to filter recoveries).
const PI_TURN_FIBER = "pi-turn";
// Give up after this many resume attempts to avoid a crash -> resume -> crash loop.
const MAX_PI_RESUME_ATTEMPTS = 3;

interface PiActiveTurnMarker {
  turnId: string;
  attempt: number;
  openedAt: number;
}
const CHAT_TODOS_KEY = "chatTodos";
const CHAT_CONTEXT_USED_PERCENT_KEY = "chatContextUsedPercent";
const CHAT_CONTEXT_WINDOW_BY_MODEL_KEY = "chatContextWindowByModel";
const CHAT_ACTIVE_TURN_USER_ID_KEY = "chatActiveTurnUserId";
const PI_TURN_INACTIVITY_TIMEOUT_MS = 10 * 60_000;
const PI_TURN_PROGRESS_INTERVAL_MS = 30_000;
const CHAT_ERROR_DEDUPE_WINDOW_MS = 10_000;

// Coalesce high-frequency live-overlay syncs (streaming token/output deltas) so
// a chatty tool doesn't serialize+broadcast the whole overlay per chunk.
// Structural events (turn/completed, item/completed, errors) always force a sync.
const LIVE_STATE_SYNC_THROTTLE_MS = 100;
// Per-block cap on streamed tool/text output kept in the live overlay (Agent
// state is broadcast as one message, bounded by Cloudflare's ~1MB WS frame). The
// full output is always persisted durably and restored on reload.
const MAX_LIVE_OVERLAY_BLOCK_CHARS = 128_000;
const LIVE_OVERLAY_TRUNCATION_MARKER =
  "…[earlier output truncated — full output available on reload]…\n";

// Keep only the tail of an oversized streamed block so the live overlay stays
// well under the broadcast size limit. Idempotent: a prior marker at the head is
// sliced off (it falls outside the retained tail) and a fresh one is prepended.
function boundLiveOverlayText(text: string): string {
  if (text.length <= MAX_LIVE_OVERLAY_BLOCK_CHARS) return text;
  const tailLength = MAX_LIVE_OVERLAY_BLOCK_CHARS - LIVE_OVERLAY_TRUNCATION_MARKER.length;
  return LIVE_OVERLAY_TRUNCATION_MARKER + text.slice(text.length - tailLength);
}

const ASK_USER_QUESTION_UNAVAILABLE_MESSAGE = 'User is not at computer; AskUserQuestion is unavailable in this channel. Continue without asking and use best effort.';

// Passthrough harness tools in these categories are NOT advertised in the model's
// top-level tool list. They remain fully callable inside js_exec via `tools.<name>()`
// and discoverable through `tools.search()` / `tools.help()`; we simply stop spending
// per-turn context on their schemas (the executor-style "search → describe → call"
// approach). These are long-tail, rarely-needed tools the agent reliably rediscovers
// by category; the app/project lifecycle categories (workspace, apps, user_interaction,
// web, agents) intentionally STAY top-level, because dropping them led the agent to
// guess tool names on complex build+deploy tasks instead of searching.
const TOP_LEVEL_EXCLUDED_CATEGORIES = new Set<string>([
  "workflows",
  "schedules",
  "integrations",
  "domains",
  "connections",
  "communication",
]);

// Passthrough tools that always stay top-level even though their category is excluded:
// they block on human input and so cannot run inside js_exec's short-lived sandbox.
// Keep in sync with the js_exec-excluded names in code-mode-tools.ts.
const ALWAYS_TOP_LEVEL_PASSTHROUGH_NAMES = new Set<string>([
  "prompt_connection_setup",
  "delete_connection",
  "delete_project",
  "AskUserQuestion",
]);

// The names-only inventory of tools reachable only inside js_exec (executor's
// "Available integrations" pattern): names are cheap in the cached prompt prefix
// and directly prevent tool-name guessing, while the schemas stay behind
// tools.search()/tools.describe(). Computed over the full catalog (not just the
// passthrough list — communication tools like send_email were never advertised
// top-level) so it can never drift from the actual top-level exclusion.
const JS_EXEC_ONLY_TOOL_INVENTORY = (() => {
  const byCategory = new Map<string, string[]>();
  for (const definition of CODE_MODE_TOOL_DEFINITIONS) {
    if (definition.hidden) continue;
    if (ALWAYS_TOP_LEVEL_PASSTHROUGH_NAMES.has(definition.name)) continue;
    if (!TOP_LEVEL_EXCLUDED_CATEGORIES.has(definition.category)) continue;
    const names = byCategory.get(definition.category) ?? [];
    names.push(definition.name);
    byCategory.set(definition.category, names);
  }
  return [...byCategory.entries()]
    .map(([category, names]) => `${category}: ${names.join(", ")}`)
    .join("; ");
})();

// The js_exec tool description, kept executor-style small: a one-line intro, a
// pointer to the on-demand guide (`await tools.help()` inside the sandbox), the
// search → describe → call recipe, and the names-only inventory above. The
// long-form usage guidance lives in JS_EXEC_GUIDE in code-mode-runner.ts so it
// is fetched only when the model actually writes code, instead of sitting in
// every turn's prompt prefix.
const JS_EXEC_DESCRIPTION =
  "Run JavaScript or TypeScript (types are stripped) in a Worker-style sandbox with every workspace tool on the global `tools` object plus runtime bindings (`env.CONNECTIONS`, `env.AI`, `env.CAMELAI`, `env.WORKSPACE`, `env.PROJECTS`, `vm.exec`). The final expression is returned and console output is captured. " +
  "Before writing non-trivial code, run `await tools.help()` once — it returns the full usage guide (file locations, project VMs, connections, hosted helpers) plus the tool catalog by category. " +
  "NEVER guess a tool name: `await tools.search(\"<intent + key nouns>\")`, then `await tools.describe(items[0].name)`, then invoke as the result's `call` field shows (kind \"tool\" runs as `await tools.<name>(args)`; kind \"runtime\" results are sandbox globals, never on `tools`). " +
  "Every `tools.<name>(args)` call resolves to `{ ok: true, data }` or `{ ok: false, error: { message } }` — branch on `result.ok` instead of try/catch; failed calls do not throw, so you can describe the tool and retry in the same run. " +
  `Tools reachable ONLY here (not in your tool list) — ${JS_EXEC_ONLY_TOOL_INVENTORY}. ` +
  "After you deploy an app or make changes to it, ALWAYS call `set_preview` with the newly deployed app to surface it to the user, and verify the deploy by calling `list_apps` before reporting done. " +
  "Interactive tools that wait for the user (prompt_connection_setup, delete_connection, delete_project, AskUserQuestion) are top-level tools and cannot be called from js_exec.";

const HEADER_USER_NAME = "X-Chiridion-User-Name";
const HEADER_USER_EMAIL = "X-Chiridion-User-Email";
const HEADER_USER_ID = "X-Chiridion-User-Id";
const HEADER_AUTH_DEGRADED = "X-Chiridion-Auth-Degraded";
// Users who have passed full route-side authorization for this thread,
// mapped to when they last did (ms). Used to admit reconnects when the
// authorization DOs are unreachable (degraded auth); never admits a user who
// has not recently connected with full auth, so revoked members age out
// instead of keeping a permanent fail-open grant.
const CHAT_AUTHORIZED_USERS_KEY = "chat_authorized_user_ids";
const CHAT_AUTHORIZED_USERS_MAX = 100;
const CHAT_DEGRADED_AUTH_GRANT_TTL_MS = 24 * 60 * 60 * 1000;
// Avoid rewriting the grant map on every reconnect burst.
const CHAT_DEGRADED_AUTH_GRANT_REFRESH_MS = 5 * 60 * 1000;
// Recently accepted clientMessageIds, used to drop duplicate sends when the
// browser retransmits after a reconnect (it cannot know whether a message
// sent right before a socket drop was received).
const CHAT_RECENT_CLIENT_MESSAGE_IDS_KEY = "chat_recent_client_message_ids";
const CHAT_RECENT_CLIENT_MESSAGE_IDS_MAX = 200;

type ChatAgentEnv = Cloudflare.Env & Omit<ChatEnv, keyof Cloudflare.Env>;

const CODE_MODE_ARTIFACTS_KEY_PREFIX = 'codeModeArtifacts:';

/**
 * ChatThreadDO - One per thread, holds preview state, prompts, browser runner
 * traffic, and agent turns. Sandbox-host remains the backend for workspace
 * file/shell/container operations.
 */
export class ChatThreadDO extends Agent<ChatAgentEnv, ChatThreadAgentState> {
  private static readonly CONNECTION_SETUP_TIMEOUT_MS = 30 * 60 * 1000;

  private previewTarget: PreviewTarget | null = null;
  private previewTabs: PreviewTarget[] = [];
  private previewActiveTabId: string | null = null;
  private previewVersion: number = 0;

  // Chat bridge state
  private chatContext: ChatContextState | null = null;
  private agentEvalEventCollector: Array<Record<string, unknown>> | null = null;
  // The current turn's assistant/tool messages, built whole on the server and
  // sent to the browser as a wholesale-replaced overlay (see Tier 2 design).
  // Reset at agent_start; the browser folds finalized entries into its
  // committed history, so this never needs to hold prior turns.
  private liveMessages: Message[] = [];
  private liveStreamingMessageId: string | null = null;
  private lastCompletedTurn:
    | { id: string; durationMs: number; completedAtMs: number }
    | null = null;
  private lastError: ChatThreadAgentState["lastError"] = null;
  // Code-mode artifacts recorded before their js_exec tool result entered the
  // live overlay; drained onto the overlay once the tool result appears.
  private pendingOverlayArtifacts: Map<string, RuntimeCallArtifact[]> = new Map();
  private lastLiveSyncAtMs: number = 0;
  private liveStateHydrated: boolean = false;
  // In-memory debounce marker for build-container prewarm (see
  // maybePrewarmProjectBuildSandboxes). Best-effort only; a DO eviction resets
  // it, which at worst triggers one extra cheap no-op warm.
  private lastBuildSandboxPrewarmAtMs: number = 0;
  private currentTodos: unknown[] = [];
  // Canonical persisted/replayed value (set on result events only).
  private contextUsedPercent: number | null = null;
  // Ephemeral in-turn value (never persisted).
  private transientContextUsedPercent: number | null = null;
  private usageIsPostCompaction: boolean = true;
  private cachedContextWindowByModel: Record<string, number> = {};
  private activeAutomationRun: ActiveAutomationRunState | null = null;
  private currentTitle: string | null = null;
  private currentTitleUpdatedAt: number | null = null;
  private currentThreadModel: LlmModel | null = null;
  private currentThreadModelUpdatedAt: number | null = null;
  private assistantCompletionRecordedAt: number | null = null;
  private assistantCompletionSummaryRequestedAt: number | null = null;
  private readonly browserPrompts = new BrowserPromptCoordinator({
    hasAvailableBrowserUser: () => this.hasAvailableBrowserUser(),
    broadcast: (message) => this.handleBrowserPromptStateChange(message),
    askUserQuestionUnavailableMessage:
      ASK_USER_QUESTION_UNAVAILABLE_MESSAGE,
    questionTimeoutMs: 30 * 60 * 1000,
    connectionSetupTimeoutMs: ChatThreadDO.CONNECTION_SETUP_TIMEOUT_MS,
  });
  private titleGenerationInFlight: boolean = false;
  private activeTurnUserId: string | null = null;
  private workspaceStatusStubs = new Map<string, DurableObjectStub<WorkspaceDO>>();
  // Trailing-debounce state for coalescing WorkspaceDO.recordThreadStreaming
  // running-activity updates. This is a per-thread DO, so a single pending entry
  // (one timer + the latest payload) is sufficient. Terminal streaming
  // transitions clear this so a stale activity update can never overwrite the
  // final state.
  private pendingStreamingActivity: {
    workspaceId: string;
    threadId: string;
    activityText: string;
    activityAt: number;
    coalescedCount: number;
  } | null = null;
  private streamingActivityFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private runnerTransitionChain: Promise<void> = Promise.resolve();
  private piSessionPromise: Promise<PiCoreAgent> | null = null;
  private piSession: PiCoreAgent | null = null;
  private piMainBaselineIndex = 0;
  private piModelResolver: (() => Promise<PiResolvedModelConfig>) | null = null;
  private piUnsubscribe: (() => void) | null = null;
  /**
   * Turn-scoped cache of OrgDO.getLlmProviderConfig for this thread's org.
   * Caches both null (no BYOK config, the common hosted case) and non-null
   * records. Cleared at agent_start so each turn reads the config exactly
   * once, and on byokChanged() so admin updates apply promptly mid-turn.
   */
  private cachedLlmProviderConfig: CachedLlmProviderConfig | null = null;
  private pendingClientMessageEnqueues: Map<
    string,
    Promise<InitialUserMessageResult>
  > | null = null;
  private piEventHandlerChain: Promise<void> = Promise.resolve();
  private piActiveItemId: string | null = null;
  private piActiveItemText = "";
  private piReasoningItemId: string | null = null;
  private piToolArgs: Map<string, Record<string, unknown>> = new Map();
  private piAssistantText = "";
  private runningActivityLastText: string | null = null;
  private runningActivityLastSentAt = 0;
  private piTurnStartedAtMs: number = 0;
  private piAgentStartedAtMs: number = 0;
  private piUserStopRequestedAtMs: number = 0;
  private piLastTurnUsage: Record<string, unknown> | null = null;
  private piSdkTurnIndex: number = 0;
  private piSdkTurnUsageTotal: Record<string, unknown> | null = null;
  private piCurrentBillingSource: PiBillingSource = "hosted";
  private piCurrentCreditChargeable: boolean = false;
  private piCurrentUsageProvider: string | null = null;
  private piTurnLastProgressAtMs: number = 0;
  private piLastPersistedLoopError: { fingerprint: string; at: number } | null = null;
  private piRecordedProviderErrors = new Set<string>();
  private recordedChatErrors = new Map<string, number>();

  initialState: ChatThreadAgentState = {
    isStreaming: false,
    previewTabs: [],
    previewActiveTabId: null,
    previewVersion: 0,
    previewRefreshTabId: null,
    currentTodos: [],
    contextUsedPercent: null,
    pendingQuestion: null,
    connectionSetupPrompt: null,
    title: null,
    titleUpdatedAt: null,
    model: null,
    modelUpdatedAt: null,
    lastCompletedTurn: null,
    lastError: null,
  };

  static {
    const context = {} as ClassMethodDecoratorContext;
    callable()(this.prototype.requestStop, context);
    callable()(this.prototype.setPreviewTabsState, context);
    callable()(this.prototype.answerQuestion, context);
    callable()(this.prototype.submitConnectionSetupResponse, context);
    callable()(this.prototype.refreshModel, context);
    callable()(this.prototype.sendMessage, context);
  }

  private agentState(
    overrides: Partial<ChatThreadAgentState> = {},
  ): ChatThreadAgentState {
    const isStreaming = this.isThreadStreaming();
    return {
      isStreaming,
      previewTabs: cloneDurableState(this.previewTabs),
      previewActiveTabId: this.previewActiveTabId,
      previewVersion: this.previewVersion,
      previewRefreshTabId: null,
      currentTodos: cloneDurableState(this.currentTodos),
      contextUsedPercent: resolveContextUsageForInit(
        this.transientContextUsedPercent,
        this.contextUsedPercent,
        isStreaming,
      ),
      pendingQuestion: cloneDurableState(
        this.browserPrompts?.getOldestPendingQuestion?.() ?? null,
      ),
      connectionSetupPrompt: cloneDurableState(
        this.browserPrompts?.pendingConnectionSetupPrompts?.()[0] ?? null,
      ),
      title: this.currentTitle,
      titleUpdatedAt: this.currentTitleUpdatedAt,
      model: this.currentThreadModel,
      modelUpdatedAt: this.currentThreadModelUpdatedAt,
      lastCompletedTurn: this.lastCompletedTurn,
      lastError: this.lastError,
      ...overrides,
    };
  }

  // Restore coarse durable state on a cold wake. The live overlay is no longer
  // persisted here (it streams over the non-durable broadcast channel); a warm
  // reconnect gets the in-memory tail via onConnect, and committed history comes
  // from the durable transcript.
  private hydrateLiveStateFromAgentState(): void {
    if (this.liveStateHydrated) return;
    this.liveStateHydrated = true;
    const state = this.state as Partial<ChatThreadAgentState> | undefined;
    if (!state) return;
    // NOTE: streaming state is no longer restored here — it is derived on read from
    // execution ground truth ({@link isThreadStreaming}), so a cold wake recomputes
    // it (an evicted mid-turn thread reports streaming via its orphan fiber row /
    // pending resume; a completed one reports idle) with no flag to resurrect.
    if (state.lastCompletedTurn && typeof state.lastCompletedTurn === "object") {
      this.lastCompletedTurn = cloneDurableState(state.lastCompletedTurn);
    }
    if (state.lastError && typeof state.lastError === "object") {
      this.lastError = cloneDurableState(state.lastError);
    }
  }

  private syncAgentState(overrides?: Partial<ChatThreadAgentState>): void {
    this.hydrateLiveStateFromAgentState();
    this.setState(this.agentState(overrides));
  }

  private handleBrowserPromptStateChange(
    message: Record<string, unknown>,
  ): void {
    if (
      message.type === "ask_user_question" ||
      message.type === "question_answered" ||
      message.type === "connection_setup_prompt" ||
      message.type === "connection_setup_answered"
    ) {
      this.syncAgentState();
      return;
    }
    this.broadcastChat(message);
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
    try {
      return await fn();
    } finally {
      release();
    }
  }

  constructor(ctx: DurableObjectState, env: ChatEnv) {
    super(ctx, env as unknown as ChatAgentEnv);

    // SQLite-backed storage operations below are synchronous. Keep constructor
    // hydration out of blockConcurrencyWhile: if an active turn is being
    // recovered while route loaders reconnect, a blocked constructor can reset
    // the Durable Object and turn a normal recovery into another interruption.
    this.ensurePiCoreTables();

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
      this.currentTodos = normalizeTodoItems(storedTodos);
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

    const storedActiveTurnUserId = ctx.storage.kv.get<string>(
      CHAT_ACTIVE_TURN_USER_ID_KEY,
    );
    if (
      typeof storedActiveTurnUserId === "string" &&
      storedActiveTurnUserId.trim()
    ) {
      this.activeTurnUserId = storedActiveTurnUserId.trim();
    }

    this.activeAutomationRun = this.normalizeActiveAutomationRun(
      ctx.storage.kv.get<unknown>(CHAT_ACTIVE_AUTOMATION_RUN_KEY),
    );
  }

  async runCodeModeJavascript(
    request: CodeModeJavascriptRequest,
  ): Promise<CodeModeJavascriptResult> {
    const code = typeof request.code === "string" ? request.code : "";
    if (!code.trim()) {
      throw new Error("code is required");
    }
    if (!request.orgId || !request.workspaceId) {
      throw new Error("Code mode requires org and workspace scope");
    }

    const loader = this.env.CODE_MODE_LOADER as (WorkerLoader & {
      load?: (code: WorkerLoaderWorkerCode) => WorkerStub;
    }) | undefined;
    if (!loader) {
      throw new Error("CODE_MODE_LOADER binding is not configured");
    }

    const timeoutMs = clampCodeModeInteger(
      request.timeoutMs,
      CODE_MODE_DEFAULT_TIMEOUT_MS,
      100,
      CODE_MODE_MAX_TIMEOUT_MS,
    );
    const maxOutputCharacters = clampCodeModeInteger(
      request.maxOutputCharacters,
      CODE_MODE_DEFAULT_MAX_OUTPUT_CHARACTERS,
      1000,
      CODE_MODE_MAX_OUTPUT_CHARACTERS,
    );
    const tools = (this.ctx.exports as unknown as {
      CodeModeToolsBinding: (options: { props: CodeModeToolsProps }) => unknown;
    }).CodeModeToolsBinding({
      props: {
        orgId: request.orgId,
        workspaceId: request.workspaceId,
        userId: request.userId,
        threadId: request.threadId,
        parentToolUseId: request.toolUseId,
      },
    });
    const ai = (this.ctx.exports as unknown as {
      AIVirtualBinding: (options: { props: AIVirtualBindingProps }) => unknown;
    }).AIVirtualBinding({
      props: {
        orgId: request.orgId,
        workspaceId: request.workspaceId,
        userId: request.userId,
      },
    });
    const camelai = (this.ctx.exports as unknown as {
      CamelAiService: (options: { props: AIVirtualBindingProps }) => unknown;
    }).CamelAiService({
      props: {
        orgId: request.orgId,
        workspaceId: request.workspaceId,
        userId: request.userId,
      },
    });
    const secureFetch = (this.ctx.exports as unknown as {
      SecureFetchBinding: (options: { props: Pick<CodeModeToolsProps, "orgId" | "workspaceId"> }) => unknown;
    }).SecureFetchBinding({
      props: {
        orgId: request.orgId,
        workspaceId: request.workspaceId,
      },
    });
    const screenshot = (this.ctx.exports as unknown as {
      AppScreenshotBinding: (options: { props: Pick<CodeModeToolsProps, "orgId" | "workspaceId"> }) => unknown;
    }).AppScreenshotBinding({
      props: {
        orgId: request.orgId,
        workspaceId: request.workspaceId,
      },
    });
    const appBrowser = (this.ctx.exports as unknown as {
      AppBrowserBinding: (options: { props: Pick<CodeModeToolsProps, "orgId" | "workspaceId"> }) => unknown;
    }).AppBrowserBinding({
      props: {
        orgId: request.orgId,
        workspaceId: request.workspaceId,
      },
    });

    const workerCode: WorkerLoaderWorkerCode = {
      compatibilityDate: CODE_MODE_COMPATIBILITY_DATE,
      mainModule: "index.js",
      modules: {
        "index.js": { js: codeModeWorkerModule(code) },
      },
      env: { TOOLS: tools, AI: ai, CAMELAI: camelai, SECURE_FETCH: secureFetch, SCREENSHOT: screenshot, BROWSER: appBrowser },
    };
    const worker = typeof loader.load === "function"
      ? loader.load(workerCode)
      : loader.get(`pi-codemode-${crypto.randomUUID()}`, () => workerCode);
    const runner = worker.getEntrypoint("CodeModeRunner") as unknown as {
      run(): Promise<{ text?: unknown }>;
    };

    const runPromise = runner.run();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        runPromise,
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(
            () => reject(
              new Error(
                `JavaScript execution timed out after ${timeoutMs}ms. If this script needs more wall-clock time, call js_exec again with a larger timeoutMs value (maximum ${CODE_MODE_MAX_TIMEOUT_MS}ms).`,
              ),
            ),
            timeoutMs,
          );
        }),
      ]);
      return {
        text: truncateCodeModeText(result.text ?? "", maxOutputCharacters),
      };
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  async recordCodeModeArtifact(
    parentToolUseId: string,
    artifact: RuntimeCallArtifact,
  ): Promise<void> {
    const normalizedParentToolUseId = parentToolUseId.trim();
    if (!normalizedParentToolUseId) return;
    const key = this.codeModeArtifactsKey(normalizedParentToolUseId);
    const existing = this.ctx.storage.kv.get<RuntimeCallArtifact[]>(key);
    const artifacts = normalizeRuntimeCallArtifacts(existing);
    artifacts.push(artifact);
    this.ctx.storage.kv.put(key, artifacts);
    // The artifact rides the live overlay's tool-result message (and the durable
    // KV row above for reload), not a separate websocket event.
    this.attachLiveArtifact(normalizedParentToolUseId, artifact);
    await this.setPreviewTarget({ kind: "runtime_artifact", artifact });
  }

  // Attach a code-mode artifact to its tool result in the live overlay so it
  // flows to the browser through Agent state. The artifact is usually recorded
  // mid-js_exec, before item/completed builds the tool result, so hold it until
  // the tool result appears (drained in applyChatEventToLiveState).
  private attachLiveArtifact(
    parentToolUseId: string,
    artifact: RuntimeCallArtifact,
  ): void {
    this.hydrateLiveStateFromAgentState();
    const result = attachArtifactsToToolResultMessages(
      this.liveMessages,
      parentToolUseId,
      [artifact],
    );
    if (result.attached) {
      this.liveMessages = result.messages;
      this.broadcastLiveOverlay();
      return;
    }
    if (!this.pendingOverlayArtifacts) this.pendingOverlayArtifacts = new Map();
    const pending = this.pendingOverlayArtifacts.get(parentToolUseId) ?? [];
    this.pendingOverlayArtifacts.set(parentToolUseId, [...pending, artifact]);
  }

  async consumeCodeModeArtifacts(
    parentToolUseId: string,
    options: { deleteAfterRead?: boolean } = {},
  ): Promise<RuntimeCallArtifact[]> {
    const normalizedParentToolUseId = parentToolUseId.trim();
    if (!normalizedParentToolUseId) return [];
    const key = this.codeModeArtifactsKey(normalizedParentToolUseId);
    const artifacts = normalizeRuntimeCallArtifacts(
      this.ctx.storage.kv.get<RuntimeCallArtifact[]>(key),
    );
    if (options.deleteAfterRead === true) {
      this.ctx.storage.kv.delete(key);
    }
    return artifacts;
  }

  private codeModeArtifactsKey(parentToolUseId: string): string {
    return `${CODE_MODE_ARTIFACTS_KEY_PREFIX}${parentToolUseId}`;
  }

  override async onStart(props?: unknown): Promise<void> {
    await super.onStart?.(props as never);
    this.hydrateLiveStateFromAgentState();
    // PartyServer name bootstrap happens before onStart, not in the constructor.
    // syncAgentState() calls setState(), which emits through PartyServer and needs
    // this.name; doing it here keeps cold-wake state fresh without crashing stale
    // alarm/RPC wakes that haven't initialized the PartyServer name yet.
    this.syncAgentState();
  }

  /**
   * The single source of truth for the client loading indicator, DERIVED on read.
   * A turn is "working" iff pi-core is live in this isolate OR an active-turn marker
   * exists. The marker is written synchronously at turn start and cleared by every
   * terminal path (agent_end / resume completion / error cleanup); it survives
   * eviction, so a cold wake still reads busy across the gap between the SDK deleting
   * the recovered fiber row and the scheduled resume running — which also stops a new
   * turn from racing the pending resume. Because nothing sets a separate spinner
   * flag, there's no clear-site to forget; a genuinely hung turn keeps pi-core live
   * (the inactivity timeout's job, not a desync).
   */
  private isThreadStreaming(): boolean {
    if (this.piSession?.state.isStreaming) return true;
    // This derive is called on every state sync; never let a storage read throw.
    try {
      return this.readPiActiveTurn() !== null;
    } catch {
      return false;
    }
  }

  async onConnect(connection: Connection, ctx: ConnectionContext): Promise<void> {
    const url = new URL(ctx.request.url);
    const incomingOrgId = url.searchParams.get("orgId")?.trim() || "";
    if (
      this.chatContext?.orgId &&
      incomingOrgId &&
      this.chatContext.orgId !== incomingOrgId
    ) {
      connection.close(1008, "forbidden");
      return;
    }

    const upgradeUserId = ctx.request.headers.get(HEADER_USER_ID)?.trim() || "";
    const authDegraded =
      ctx.request.headers.get(HEADER_AUTH_DEGRADED)?.trim() === "1";
    if (authDegraded) {
      if (
        !upgradeUserId ||
        !this.chatContext ||
        !this.isPreviouslyAuthorizedChatUser(upgradeUserId)
      ) {
        connection.close(1008, "forbidden");
        return;
      }
    } else if (upgradeUserId) {
      this.recordAuthorizedChatUser(upgradeUserId);
    }

    this.captureChatContextFromRequest(url, ctx.request, connection);

    if (!this.isThreadStreaming() && this.currentTodos.length > 0) {
      // completeTodoStateForTurnEnd() syncs an override marking the stale todos
      // completed; a second unconditional sync here (with currentTodos already
      // cleared) would erase that checklist, so only sync in the else branch.
      await this.completeTodoStateForTurnEnd();
    } else {
      this.syncAgentState();
    }
    // The live overlay isn't in durable state; hand a warm reconnect the
    // in-progress turn directly (no-op when idle or after a cold eviction).
    this.sendLiveOverlayToConnection(connection);
    await this.maybeGenerateChatGroupAvatarForThread(
      this.chatContext?.threadId ?? "",
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.headers.get("Upgrade") === "websocket") {
      return super.fetch(request);
    }

    // HTTP API for setting preview state
    if (url.pathname === "/preview" && request.method === "POST") {
      const body = (await request.json()) as {
        target?: PreviewTarget | null;
        tabs?: PreviewTarget[];
        activeTabId?: string | null;
      };
      if (Array.isArray(body.tabs) || body.activeTabId !== undefined) {
        await this.setPreviewTabsStateInternal(
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

    return new Response("Not found", { status: 404 });
  }

  async onMessage(
    ws: Connection,
    message: WSMessage,
  ): Promise<void> {
    if (typeof message !== "string") return;

    let data: { type: string; [key: string]: unknown };
    try {
      data = JSON.parse(message) as { type: string; [key: string]: unknown };
    } catch {
      return;
    }

    try {
      // Browser commands use Agents SDK callables. Chronological chat data is
      // pushed server-to-client only; reload/reconnect recovery comes from
      // Agents SDK state sync.

    } catch (err) {
      this.emitChatError(
        `Internal error handling ${data.type}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async onClose(): Promise<void> {
    if (
      this.getChatSockets().length === 0 &&
      this.browserPrompts.pendingQuestionCount > 0
    ) {
      this.ctx.waitUntil(
        this.autoAnswerAllPendingQuestionsAsUnavailable(
          ASK_USER_QUESTION_UNAVAILABLE_MESSAGE,
        ),
      );
    }
  }

  getPreviewTarget(): PreviewTarget | null {
    return this.previewTarget;
  }

  getPiCoreMessageRows(limit = 200): PiCoreMessageRow[] {
    const resolvedLimit = Number.isFinite(limit)
      ? Math.max(1, Math.min(2000, Math.floor(limit)))
      : 200;

    return this.ctx.storage.sql
      .exec(
        "SELECT idx, payload, created_at FROM pi_core_messages ORDER BY idx DESC LIMIT ?",
        resolvedLimit,
      )
      .toArray()
      .reverse() as unknown as PiCoreMessageRow[];
  }

  async repairPiCoreMessageHistory(input: {
    mode?: "dry_run" | "repair";
  } = {}): Promise<PiCoreMessageHistoryRepairReport> {
    const mode = input.mode ?? "dry_run";
    if (mode !== "dry_run" && mode !== "repair") {
      throw new Error("mode must be dry_run or repair");
    }

    this.ensurePiCoreTables();
    const rows = this.ctx.storage.sql
      .exec<{ payload: string }>(
        "SELECT payload FROM pi_core_messages ORDER BY idx ASC",
      )
      .toArray();
    const messages: AgentMessage[] = [];
    let invalidRows = 0;
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.payload) as AgentMessage;
        if (parsed && typeof parsed === "object" && "role" in parsed) {
          const hydrated = await this.hydratePiStoredImages(parsed);
          messages.push(sanitizePiModelMessage(hydrated as AgentMessage));
        } else {
          invalidRows += 1;
        }
      } catch {
        invalidRows += 1;
      }
    }

    const repaired = repairPiMessageHistoryForReplay(messages);
    const changed = invalidRows > 0 || repaired.repairedCount > 0;
    const afterMessages = changed ? repaired.messages : messages;

    if (mode === "repair" && changed) {
      await this.replacePiCoreMessages(afterMessages);
    }

    return {
      ok: true,
      mode,
      persisted: mode === "repair" && changed,
      changed,
      beforeCount: rows.length,
      validBeforeCount: messages.length,
      afterCount: afterMessages.length,
      invalidRows,
      repairedCount: repaired.repairedCount,
      stats: repaired.stats,
    };
  }

  async putPiCoreMessageRow(input: {
    idx: number;
    payload: string;
    created_at?: number;
  }): Promise<{ ok: true; inserted: boolean; idx: number }> {
    const idx = Math.floor(input.idx);
    if (!Number.isFinite(idx) || idx < 0) {
      throw new Error("idx must be a non-negative integer");
    }

    let parsedPayload: unknown;
    try {
      parsedPayload = JSON.parse(input.payload);
    } catch {
      throw new Error("payload must be valid JSON");
    }
    const serialized = await this.serializePiMessageForSqlStorageDetailed(parsedPayload as AgentMessage);
    const normalizedPayload = serialized.payload;
    const createdAt = Number.isFinite(input.created_at)
      ? Math.floor(input.created_at as number)
      : Date.now();

    const existing = this.ctx.storage.sql
      .exec<{ idx: number }>("SELECT idx FROM pi_core_messages WHERE idx = ?", idx)
      .one();

    if (existing) {
      this.ctx.storage.sql.exec(
        "UPDATE pi_core_messages SET payload = ?, created_at = ? WHERE idx = ?",
        normalizedPayload,
        createdAt,
        idx,
      );
      this.recordPiSqlStorageSanitization("admin_put_row", serialized.stats, 1);
      return { ok: true, inserted: false, idx };
    }

    this.ctx.storage.sql.exec(
      "INSERT INTO pi_core_messages (idx, payload, created_at) VALUES (?, ?, ?)",
      idx,
      normalizedPayload,
      createdAt,
    );
    this.recordPiSqlStorageSanitization("admin_put_row", serialized.stats, 1);
    return { ok: true, inserted: true, idx };
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
      this.syncAgentState();
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
    if (previousActiveTabId === id) {
      this.syncAgentState({ previewRefreshTabId: id });
      this.syncAgentState({ previewRefreshTabId: null });
    } else {
      this.syncAgentState();
    }
  }

  async setPreviewTabsState(
    tabs: PreviewTarget[],
    activeTabId: string | null,
  ): Promise<void> {
    if (!this.chatContext) throw new Error("Missing chat context");
    const ok = await this.setPreviewTabsStateInternal(
      tabs,
      activeTabId,
      this.chatContext.workspaceId,
    );
    if (!ok) throw new Error("Invalid preview target workspace");
  }

  async requestStop(): Promise<void> {
    await this.ensurePiSessionReady();
    this.sendRunnerCommand({ type: "stop", threadId: this.chatContext?.threadId });
  }

  async answerQuestion(
    questionId: string,
    answers: Record<string, unknown>,
  ): Promise<void> {
    if (!questionId || !answers || typeof answers !== "object") {
      throw new Error("Missing questionId or answers");
    }

    if (this.browserPrompts.answerQuestion({ questionId, answers })) {
      return;
    }

    this.sendRunnerCommand({
      type: "question_response",
      questionId,
      answers,
      userId: this.chatContext?.userId ?? undefined,
    });
  }

  async submitConnectionSetupResponse(
    response: ConnectionSetupResponse,
  ): Promise<void> {
    const result = await this.handleConnectionSetupResponse(response);
    if (!result.accepted) {
      throw new Error(
        "Connection setup request is no longer pending. Please ask the agent to start connection setup again.",
      );
    }
  }

  async refreshModel(): Promise<void> {
    await this.refreshPiSessionModel();
  }

  async sendMessage(
    content: string,
    clientMessageId: string,
  ): Promise<InitialUserMessageResult> {
    return this.handleClientUserMessage({ content, clientMessageId });
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
    this.syncAgentState();
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
    this.syncAgentState();
  }

  // Set latest thread metadata for connected chat clients.
  async setTitle(title: string, updatedAt?: number): Promise<void> {
    const normalizedTitle = title.trim();
    if (!normalizedTitle) return;
    this.currentTitle = normalizedTitle;
    this.currentTitleUpdatedAt =
      typeof updatedAt === "number" && Number.isFinite(updatedAt)
        ? updatedAt
        : Date.now();
    this.syncAgentState();
  }

  async generateChatGroupAvatarForThread(context: {
    threadId: string;
    workspaceId: string;
    orgId: string;
    userId?: string | null;
  }): Promise<void> {
    const error = this.updateExternalChatContext(context);
    if (error) {
      console.warn("[ChatThreadDO] skipping chat group avatar generation", {
        reason: "invalid_context",
        threadId: context.threadId,
        workspaceId: context.workspaceId,
        orgId: context.orgId,
      });
      return;
    }
    await this.maybeGenerateChatGroupAvatarForThread(context.threadId);
  }

  async setModel(model: LlmModel, updatedAt?: number): Promise<void> {
    this.currentThreadModel = model;
    this.currentThreadModelUpdatedAt =
      typeof updatedAt === "number" && Number.isFinite(updatedAt)
        ? updatedAt
        : Date.now();
    this.syncAgentState();
  }

  async setTodoState(todos: unknown[]): Promise<void> {
    this.currentTodos = Array.isArray(todos) ? normalizeTodoItems(todos) : [];
    if (this.currentTodos.length > 0) {
      this.ctx.storage.kv.put(CHAT_TODOS_KEY, this.currentTodos);
    } else {
      this.ctx.storage.kv.delete(CHAT_TODOS_KEY);
    }
    this.syncAgentState();
  }

  getTodoState(): unknown[] {
    if (this.currentTodos.length > 0) {
      return cloneDurableState(this.currentTodos);
    }

    const storedTodos = this.ctx.storage.kv.get<unknown[]>(CHAT_TODOS_KEY);
    if (!Array.isArray(storedTodos) || storedTodos.length === 0) {
      return [];
    }

    this.currentTodos = normalizeTodoItems(storedTodos);
    return cloneDurableState(this.currentTodos);
  }

  async askUserQuestion(input: {
    questions?: unknown[];
    toolUseId?: string;
  }): Promise<Record<string, unknown>> {
    const pendingBefore = this.browserPrompts.pendingQuestionCount;
    const result = this.browserPrompts.askUserQuestion(input);
    if (this.browserPrompts.pendingQuestionCount > pendingBefore) {
      const pending = this.browserPrompts.getOldestPendingQuestion();
      const question = pending?.questions[0]?.question ?? null;
      this.updateActiveAutomationRun({
        status: "question",
        message: question,
        completedAt: null,
      });
    }
    return result;
  }

  getRuntimeStatus(): ChatThreadRuntimeStatus {
    const pending = this.browserPrompts.getOldestPendingQuestion();
    const isStreaming = this.isThreadStreaming();
    return {
      isStreaming,
      pendingQuestionCount: this.browserPrompts.pendingQuestionCount,
      oldestPendingQuestion: pending?.questions[0]?.question ?? null,
      updatedAt:
        isStreaming || this.browserPrompts.pendingQuestionCount > 0
          ? Date.now()
          : null,
    };
  }

  async promptConnectionSetup(input: {
    integrationId?: string;
    integrationType: string;
    suggestedName?: string;
    message?: string;
    instructions?: string;
    initialConfig?: Record<string, unknown>;
    initialCredentials?: Record<string, unknown>;
    dynamicSchema?: DynamicIntegrationSchema;
  }): Promise<ConnectionSetupResponse> {
    return this.browserPrompts.promptConnectionSetup(input);
  }

  async receiveConnectionSetupResponse(
    response: ConnectionSetupResponse,
  ): Promise<{ accepted: boolean }> {
    return this.handleConnectionSetupResponse(response);
  }

  async runCodeModeSubagent(
    toolName: "Agent" | "Explore",
    params: unknown,
  ): Promise<AgentToolResult<unknown>> {
    const baseContext = this.chatContext;
    const context = baseContext ?? {
      threadId: this.ctx.id.toString(),
      workspaceId: "",
      orgId: "",
      userId: null,
      userName: null,
      userEmail: null,
    };
    if (!context.threadId || !context.workspaceId || !context.orgId) {
      throw new Error("Subagent tools require chat thread, workspace, and org context");
    }
    return this.runPiSubagentTool(context, toolName, params);
  }

  async setBrowserTurnStreaming(isStreaming: boolean): Promise<void> {
    if (isStreaming) {
      this.markTurnStarted();
      return;
    }
    this.finishTurn({
      markUnread: true,
      completedAt: Date.now(),
      summarySource: null,
    });
  }

  async completeTodoStateForTurnEnd(): Promise<void> {
    if (this.currentTodos.length === 0) return;

    const completedTodos = this.currentTodos.map((todo) => {
      if (!todo || typeof todo !== "object") return todo;
      return {
        ...(todo as Record<string, unknown>),
        status: "completed",
      };
    });

    this.currentTodos = [];
    this.ctx.storage.kv.delete(CHAT_TODOS_KEY);
    this.syncAgentState({ currentTodos: completedTodos });
  }

  async getPiCoreParsedMessages(threadId: string): Promise<AgentEvalParsedMessage[]> {
    const normalizedThreadId = threadId.trim() || this.chatContext?.threadId || "";
    const parsed: AgentEvalParsedMessage[] = [];

    // The browser rebuilds live assistant/tool content from the replay buffer,
    // so only canonical persisted history is returned here.
    const storedMessages = await this.loadPiCoreMessages({ includeUiMetadata: true });
    storedMessages.forEach((message, index) => {
      const record = message as unknown as Record<string, unknown>;
      if (record.role === "toolResult") {
        attachPiToolResultToParsedMessages(parsed, record);
        return;
      }
      parsed.push(...piCoreMessageToParsedChatMessage(message, index, normalizedThreadId));
    });
    return parsed;
  }

  async getAdminExplorerSummary(input: {
    userMessageCap?: number;
  } = {}): Promise<AdminExplorerThreadSummary> {
    const cap = Number.isFinite(input.userMessageCap)
      ? Math.max(1, Math.min(100, Math.floor(input.userMessageCap as number)))
      : 20;
    const messages = await this.loadPiCoreMessages({ includeUiMetadata: true });
    const models: string[] = [];
    let userMessageCount = 0;
    let userMessageCountCapped = false;
    let errorCount = 0;
    let lastErrorAt: number | null = null;
    let lastErrorMessage: string | null = null;

    const addModel = (value: unknown) => {
      const model = normalizeModelHistoryValue(value);
      if (model && !models.includes(model)) models.push(model);
    };

    for (const [index, message] of messages.entries()) {
      const record = message as unknown as Record<string, unknown>;
      const timestamp = typeof record.timestamp === "number" && Number.isFinite(record.timestamp)
        ? record.timestamp
        : Date.now();

      if (record.role === "user") {
        if (
          !isInternalPiClientMessage(record) &&
          !isCompactSummaryPiMessage(record)
        ) {
          if (!userMessageCountCapped) {
            userMessageCount += 1;
            if (userMessageCount > cap) {
              userMessageCount = cap;
              userMessageCountCapped = true;
            }
          }
        }
        continue;
      }

      if (record.role !== "assistant") continue;
      addModel(record.responseModel);
      addModel(record.model);
      const errorMessage = this.getPiAssistantErrorMessage(message);
      if (errorMessage) {
        errorCount += 1;
        if (lastErrorAt === null || timestamp >= lastErrorAt) {
          lastErrorAt = timestamp;
          lastErrorMessage = errorMessage;
        }
      }

      if (index > 2000 && userMessageCountCapped) {
        break;
      }
    }

    const sessionModel = this.piSession?.state.model?.id;
    addModel(sessionModel);

    return {
      userMessageCount,
      userMessageCountCapped,
      hasError: errorCount > 0,
      errorCount,
      lastErrorAt,
      lastErrorMessage,
      models,
    };
  }

  async appendChannelHistoryEvent(
    input: ChannelHistoryEventRequest,
  ): Promise<ChannelHistoryEventResult> {
    const threadId =
      typeof input.threadId === "string" && input.threadId.trim()
        ? input.threadId.trim()
        : this.chatContext?.threadId || "";
    const channelKind =
      typeof input.channelKind === "string" && input.channelKind.trim()
        ? input.channelKind.trim()
        : "channel";
    const direction = input.direction === "inbound" ? "inbound" : "outbound";
    const sentAt = Number.isFinite(input.sentAt)
      ? Math.floor(Number(input.sentAt))
      : Date.now();
    const text = typeof input.text === "string" ? input.text.trim() : "";
    const attachmentCount = Number.isFinite(input.attachmentCount)
      ? Math.max(0, Math.floor(Number(input.attachmentCount)))
      : 0;
    if (!threadId) {
      return { status: "error", error: "Missing thread id" };
    }
    if (!text && attachmentCount === 0) {
      return { status: "skipped" };
    }

    const providerMessageIds = Array.isArray(input.providerMessageIds)
      ? input.providerMessageIds
          .map((id) => (id === undefined || id === null ? "" : String(id).trim()))
          .filter(Boolean)
      : [];
    const lines = [
      "<camelai system message>",
      `A camelAI run sent an outbound ${channelKind} message to this channel at ${new Date(sentAt).toISOString()}.`,
    ];
    if (direction !== "outbound") {
      lines.push(`Direction: ${direction}.`);
    }
    if (input.sourceThreadId?.trim()) {
      lines.push(`Source thread: ${input.sourceThreadId.trim()}.`);
    }
    if (input.connectionId?.trim()) {
      lines.push(`Channel connection: ${input.connectionId.trim()}.`);
    }
    if (input.remoteConversationId?.trim()) {
      lines.push(`Remote conversation: ${input.remoteConversationId.trim()}.`);
    }
    if (providerMessageIds.length > 0) {
      lines.push(`Provider message ids: ${providerMessageIds.join(", ")}.`);
    }
    if (attachmentCount > 0) {
      lines.push(`Attachment count: ${attachmentCount}.`);
    }
    lines.push(
      "Treat this as already-delivered channel history. Do not resend it unless the user explicitly asks.",
    );
    if (text) {
      lines.push("", "Delivered message:", text);
    }
    lines.push("</camelai system message>");

    const message = {
      role: "user" as const,
      content: lines.join("\n"),
      timestamp: sentAt,
    } satisfies AgentMessage;
    await this.appendPiCoreMessagesIfMissing([message]);
    const normalizedChannelKind = normalizeChannelIndicatorKind(channelKind);
    if (normalizedChannelKind) {
      await this.channelTools.markThreadChannelUsedBestEffort(
        {
          orgId: input.orgId || this.chatContext?.orgId,
          threadId,
        },
        normalizedChannelKind,
      );
    }

    const sessionState = this.piSession?.state as
      | { messages?: AgentMessage[]; isStreaming?: boolean }
      | undefined;
    if (
      sessionState &&
      !sessionState.isStreaming &&
      Array.isArray(sessionState.messages)
    ) {
      const key = this.piCoreMessageKey(message);
      const exists = sessionState.messages.some(
        (existing) => this.piCoreMessageKey(existing) === key,
      );
      if (!exists) {
        sessionState.messages.push(message);
        this.piMainBaselineIndex = Math.max(
          this.piMainBaselineIndex,
          sessionState.messages.length,
        );
      }
    }

    return { status: "appended" };
  }

  async getPiCoreForkMessages(options: {
    forkEntryId: string;
    renderedMessageId?: string;
  }): Promise<ChatThreadPiCoreForkResult> {
    const messages = await this.loadPiCoreMessages();
    if (messages.length === 0) {
      return {
        success: false,
        code: "NO_PI_CORE_MESSAGES",
        error: "Source thread has no Durable Object Pi messages",
      };
    }

    const targets = [options.forkEntryId, options.renderedMessageId]
      .map((value) => (typeof value === "string" ? value.trim() : ""))
      .filter(Boolean);
    if (targets.length === 0) {
      return {
        success: false,
        code: "TARGET_NOT_FOUND",
        error: "Fork target is required",
      };
    }

    const targetIndex = messages.findIndex((message, index) => {
      const ids = piCoreForkMessageIds(message, index);
      return targets.some((target) => ids.includes(target));
    });
    if (targetIndex < 0) {
      return {
        success: false,
        code: "TARGET_NOT_FOUND",
        error: "Fork target not found in Durable Object Pi messages",
      };
    }

    const forkedMessages = cloneDurableState(messages.slice(0, targetIndex + 1));
    return {
      success: true,
      messages: forkedMessages,
      messageCount: forkedMessages.length,
    };
  }

  async replacePiCoreForkMessages(messages: AgentMessage[]): Promise<void> {
    const normalizedMessages = Array.isArray(messages)
      ? messages.filter((message): message is AgentMessage => {
          return Boolean(
            message &&
              typeof message === "object" &&
              "role" in (message as unknown as Record<string, unknown>),
          );
        })
      : [];
    if (normalizedMessages.length === 0) {
      throw new Error("Forked Pi message history is empty");
    }

    this.disposePiSession();
    await this.replacePiCoreMessages(cloneDurableState(normalizedMessages));
    this.ctx.storage.sql.exec("DELETE FROM pi_core_compaction");
  }

  getForkStateSnapshot(): ChatThreadForkState {
    return {
      previewTarget: cloneDurableState(this.previewTarget),
      previewTabs: cloneDurableState(this.previewTabs),
      previewActiveTabId: this.previewActiveTabId,
      previewVersion: this.previewVersion,
      chatContext: cloneDurableState(this.chatContext),
      currentTodos: cloneDurableState(this.currentTodos),
      contextUsedPercent: this.contextUsedPercent,
      usageIsPostCompaction: this.usageIsPostCompaction,
      cachedContextWindowByModel: cloneDurableState(
        this.cachedContextWindowByModel,
      ),
    };
  }

  applyForkStateSnapshot(
    snapshot: ChatThreadForkState,
    target: ChatThreadForkStateTarget,
  ): void {
    const normalizedPreview =
      this.normalizePreviewTabsState(
        snapshot.previewTabs,
        snapshot.previewActiveTabId,
      ) ??
      this.normalizePreviewTabsState(
        snapshot.previewTarget ? [snapshot.previewTarget] : [],
        null,
      ) ?? {
        tabs: [],
        activeTabId: null,
        target: null,
      };

    this.previewTabs = normalizedPreview.tabs;
    this.previewActiveTabId = normalizedPreview.activeTabId;
    this.previewTarget = normalizedPreview.target;
    this.previewVersion =
      typeof snapshot.previewVersion === "number" &&
      Number.isFinite(snapshot.previewVersion)
        ? snapshot.previewVersion
        : 0;
    this.persistPreviewState(true);

    this.chatContext = snapshot.chatContext
      ? {
          ...snapshot.chatContext,
          threadId: target.threadId,
          workspaceId: target.workspaceId,
          orgId: target.orgId,
          userId: target.userId ?? snapshot.chatContext.userId ?? null,
        }
      : null;
    if (this.chatContext) {
      this.ctx.storage.kv.put(CHAT_CONTEXT_KEY, this.chatContext);
    } else {
      this.ctx.storage.kv.delete(CHAT_CONTEXT_KEY);
    }

    this.currentTodos = Array.isArray(snapshot.currentTodos)
      ? normalizeTodoItems(snapshot.currentTodos)
      : [];
    if (this.currentTodos.length > 0) {
      this.ctx.storage.kv.put(CHAT_TODOS_KEY, this.currentTodos);
    } else {
      this.ctx.storage.kv.delete(CHAT_TODOS_KEY);
    }

    this.contextUsedPercent =
      typeof snapshot.contextUsedPercent === "number" &&
      Number.isFinite(snapshot.contextUsedPercent)
        ? Math.max(0, Math.min(100, Math.round(snapshot.contextUsedPercent)))
        : null;
    if (this.contextUsedPercent !== null) {
      this.ctx.storage.kv.put(
        CHAT_CONTEXT_USED_PERCENT_KEY,
        this.contextUsedPercent,
      );
    } else {
      this.ctx.storage.kv.delete(CHAT_CONTEXT_USED_PERCENT_KEY);
    }

    this.usageIsPostCompaction =
      typeof snapshot.usageIsPostCompaction === "boolean"
        ? snapshot.usageIsPostCompaction
        : true;
    this.cachedContextWindowByModel = {};
    for (const [model, contextWindow] of Object.entries(
      snapshot.cachedContextWindowByModel ?? {},
    )) {
      if (
        typeof contextWindow === "number" &&
        Number.isFinite(contextWindow) &&
        contextWindow > 0
      ) {
        this.cachedContextWindowByModel[model] = contextWindow;
      }
    }
    this.ctx.storage.kv.put(
      CHAT_CONTEXT_WINDOW_BY_MODEL_KEY,
      this.cachedContextWindowByModel,
    );

    this.setActiveAutomationRun(null);
    this.browserPrompts.clearQuestions();
    this.titleGenerationInFlight = false;
    this.activeTurnUserId = null;
    this.ctx.storage.kv.delete(CHAT_ACTIVE_TURN_USER_ID_KEY);
  }

  getActiveTurnUserId(): string | null {
    return this.activeTurnUserId;
  }

  private normalizeActiveAutomationRun(
    value: unknown,
  ): ActiveAutomationRunState | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    const record = value as Record<string, unknown>;
    const workspaceId =
      typeof record.workspaceId === "string" ? record.workspaceId.trim() : "";
    const automationId =
      typeof record.automationId === "string" ? record.automationId.trim() : "";
    const runId = typeof record.runId === "string" ? record.runId.trim() : "";
    if (!workspaceId || !automationId || !runId) return null;
    return { workspaceId, automationId, runId };
  }

  private setActiveAutomationRun(
    value: ActiveAutomationRunState | null,
  ): void {
    this.activeAutomationRun = value;
    if (value) {
      this.ctx.storage.kv.put(CHAT_ACTIVE_AUTOMATION_RUN_KEY, value);
    } else {
      this.ctx.storage.kv.delete(CHAT_ACTIVE_AUTOMATION_RUN_KEY);
    }
  }

  private recordScheduledAutomationRun(
    run: ActiveAutomationRunState,
    input: {
      status: "success" | "error" | "question" | "busy";
      message?: string | null;
      completedAt?: number | null;
    },
  ): Promise<boolean> {
    if (!this.env.WORKSPACE_CRON) return Promise.resolve(false);
    const cronStub = this.env.WORKSPACE_CRON.get(
      this.env.WORKSPACE_CRON.idFromName(run.workspaceId),
    ) as DurableObjectStub<WorkspaceCronDO>;
    return cronStub.recordScheduledPromptRunResult({
      workspaceId: run.workspaceId,
      promptId: run.automationId,
      runId: run.runId,
      status: input.status,
      message: input.message ?? null,
      completedAt: input.completedAt,
    });
  }

  private updateActiveAutomationRun(
    input: {
      status: "success" | "error" | "question" | "busy";
      message?: string | null;
      completedAt?: number | null;
      clear?: boolean;
    },
  ): void {
    const run = this.activeAutomationRun;
    if (!run) return;
    if (input.clear) {
      this.setActiveAutomationRun(null);
    }
    this.ctx.waitUntil(
      this.recordScheduledAutomationRun(run, input).catch((error) => {
        console.error(
          "[ChatThreadDO] failed to record scheduled automation run",
          error,
        );
        return false;
      }),
    );
  }

  private reconcileInactiveAutomationRun(reason: string): boolean {
    if (
      !this.activeAutomationRun ||
      this.isThreadStreaming() ||
      this.browserPrompts.pendingQuestionCount > 0
    ) {
      return false;
    }
    this.updateActiveAutomationRun({
      status: "error",
      message: reason,
      completedAt: Date.now(),
      clear: true,
    });
    return true;
  }

  private setActiveTurnUserId(userId: string | null | undefined): void {
    const normalizedUserId =
      typeof userId === "string" && userId.trim() ? userId.trim() : null;
    const currentUserId = this.activeTurnUserId ?? null;
    if (currentUserId === normalizedUserId) {
      return;
    }

    this.activeTurnUserId = normalizedUserId;
    if (normalizedUserId) {
      this.ctx.storage.kv.put(CHAT_ACTIVE_TURN_USER_ID_KEY, normalizedUserId);
    } else {
      const kvStore = this.ctx.storage.kv as {
        put: (key: string, value: string) => unknown;
        delete?: (key: string) => unknown;
      };
      if (typeof kvStore.delete === "function") {
        kvStore.delete(CHAT_ACTIVE_TURN_USER_ID_KEY);
      } else {
        kvStore.put(CHAT_ACTIVE_TURN_USER_ID_KEY, "");
      }
    }

  }

  /**
   * Apply a mid-thread config change (model or BYOK provider/credentials) by
   * rebuilding the session: model + provider routing are baked in at creation, so a
   * cache refresh alone doesn't reach an in-flight turn. Disposing is safe now (the
   * spinner is derived), and an in-flight turn is continued via an idempotent resume.
   */
  private async rebuildPiSessionForConfigChange(lockLabel: string): Promise<void> {
    await this.withRunnerTransitionLock(lockLabel, async () => {
      const wasStreaming = this.isThreadStreaming();
      this.disposePiSession();
      if (wasStreaming) {
        await this.schedule(0, "resumeInterruptedPiTurn", undefined, {
          idempotent: true,
        });
      }
    });
  }

  async refreshRunnerConfig(): Promise<void> {
    await this.rebuildPiSessionForConfigChange("refresh_runner_config");
  }

  async byokChanged(): Promise<void> {
    // Drop the cached provider config so the rebuilt session reads the new values.
    this.cachedLlmProviderConfig = null;
    await this.rebuildPiSessionForConfigChange("byok_changed");
  }

  private disposePiSession(): void {
    this.piUnsubscribe?.();
    this.piUnsubscribe = null;
    this.piModelResolver = null;
    try {
      this.piSession?.abort();
    } catch {
      // Best effort: the session may already be idle or torn down.
    }
    this.piSession = null;
    this.piMainBaselineIndex = 0;
    this.piSessionPromise = null;
    this.piEventHandlerChain = Promise.resolve();
    this.piActiveItemId = null;
    this.piAssistantText = "";
  }

  private ensurePiCoreTables(): void {
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS pi_core_messages (
        idx INTEGER PRIMARY KEY,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
    );
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS pi_core_compaction (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        summary TEXT NOT NULL,
        first_kept_index INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    );
    // Staging buffer for the in-flight turn's not-yet-committed tail. It is a
    // discardable mirror of `agent.state.messages.slice(piMainBaselineIndex)`:
    // filled at message_end/tool_execution_end, drained (committed to
    // pi_core_messages) at turn_end, and dropped wholesale on a failed/aborted
    // turn. On a cold load with `piActiveTurn` set, it is folded back in to
    // resume the interrupted turn.
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS pi_turn_journal (
        seq INTEGER PRIMARY KEY,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
    );
  }

  private async sha256Hex(value: string): Promise<string> {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(value),
    );
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  private piStoredImageR2Key(sha256: string): string | null {
    const context = this.chatContext;
    if (!context?.orgId || !context.workspaceId || !context.threadId) {
      return null;
    }
    const safeSessionId = context.threadId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return buildWorkspaceScopedR2Key(
      context.orgId,
      context.workspaceId,
      `chat-sessions/${safeSessionId}/pi-images/${sha256}.base64`,
    );
  }

  private piStoredToolResultR2Location(
    toolName: string,
    toolCallId: string,
    sha256: string,
  ): { key: string; path: string } | null {
    const context = this.chatContext;
    if (!context?.orgId || !context.workspaceId || !context.threadId) {
      return null;
    }
    const safeSessionId = context.threadId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const safeToolName = (toolName || "tool")
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .slice(0, 48) || "tool";
    const safeToolCallId = (toolCallId || "call")
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .slice(0, 64) || "call";
    const filename = `${Date.now()}-${safeToolName}-${safeToolCallId}-${sha256.slice(0, 16)}.txt`;
    return {
      key: buildWorkspaceScopedR2Key(
        context.orgId,
        context.workspaceId,
        `chat-sessions/${safeSessionId}/pi-tool-results/tmp/${filename}`,
      ),
      path: `tmp/${filename}`,
    };
  }

  private piTextBytes(value: string): number {
    return new TextEncoder().encode(value).byteLength;
  }

  private piTextSliceByBytes(
    value: string,
    maxBytes: number,
    direction: "head" | "tail",
  ): string {
    if (maxBytes <= 0) return "";
    const chars = Array.from(value);
    const selected: string[] = [];
    let outputBytes = 0;
    const append = (char: string, prepend: boolean): boolean => {
      const charBytes = this.piTextBytes(char);
      if (outputBytes + charBytes > maxBytes) return false;
      if (prepend) selected.unshift(char);
      else selected.push(char);
      outputBytes += charBytes;
      return true;
    };
    if (direction === "tail") {
      for (let index = chars.length - 1; index >= 0; index -= 1) {
        if (!append(chars[index] ?? "", true)) break;
      }
    } else {
      for (const char of chars) {
        if (!append(char, false)) break;
      }
    }
    return selected.join("");
  }

  private truncatePiToolResultText(
    text: string,
    direction: "head" | "tail",
  ): { content: string; truncation?: Omit<PiToolResultTruncation, "fullOutput"> } {
    const lines = text.split("\n");
    const totalLines = lines.length;
    const totalBytes = this.piTextBytes(text);
    if (
      totalLines <= PI_TOOL_RESULT_MAX_LINES &&
      totalBytes <= PI_TOOL_RESULT_MAX_BYTES
    ) {
      return { content: text };
    }

    const selected: string[] = [];
    let outputBytes = 0;
    let truncatedBy: "lines" | "bytes" =
      totalLines > PI_TOOL_RESULT_MAX_LINES ? "lines" : "bytes";

    const appendLine = (line: string, prepend: boolean): boolean => {
      if (selected.length >= PI_TOOL_RESULT_MAX_LINES) {
        truncatedBy = "lines";
        return false;
      }
      const lineBytes = this.piTextBytes(line) + (selected.length > 0 ? 1 : 0);
      if (outputBytes + lineBytes > PI_TOOL_RESULT_MAX_BYTES) {
        truncatedBy = "bytes";
        const separatorBytes = selected.length > 0 ? 1 : 0;
        const availableBytes = PI_TOOL_RESULT_MAX_BYTES - outputBytes - separatorBytes;
        const clipped = this.piTextSliceByBytes(line, availableBytes, direction);
        if (clipped) {
          if (prepend) selected.unshift(clipped);
          else selected.push(clipped);
          outputBytes += separatorBytes + this.piTextBytes(clipped);
        }
        return false;
      }
      if (prepend) selected.unshift(line);
      else selected.push(line);
      outputBytes += lineBytes;
      return true;
    };

    if (direction === "tail") {
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        if (!appendLine(lines[index] ?? "", true)) break;
      }
    } else {
      for (const line of lines) {
        if (!appendLine(line, false)) break;
      }
    }

    const content = selected.join("\n");
    return {
      content,
      truncation: {
        truncated: true,
        truncatedBy,
        direction,
        totalLines,
        outputLines: selected.length,
        totalBytes,
        outputBytes: this.piTextBytes(content),
        maxLines: PI_TOOL_RESULT_MAX_LINES,
        maxBytes: PI_TOOL_RESULT_MAX_BYTES,
      },
    };
  }

  private async storePiFullToolResultInR2(
    toolName: string,
    toolCallId: string,
    text: string,
  ): Promise<PiR2ToolResultReference | undefined> {
    const sha256 = await this.sha256Hex(text);
    const location = this.piStoredToolResultR2Location(toolName, toolCallId, sha256);
    if (!location) return undefined;
    await this.env.R2_BUCKET.put(location.key, text, {
      httpMetadata: { contentType: "text/plain; charset=utf-8" },
      customMetadata: {
        type: "pi-tool-result-text",
        toolName,
        toolCallId,
        sessionId: this.chatContext?.threadId ?? "",
        threadId: this.chatContext?.threadId ?? "",
        workspaceId: this.chatContext?.workspaceId ?? "",
        orgId: this.chatContext?.orgId ?? "",
        sha256,
      },
    });
    return {
      path: location.path,
      sha256,
      size: this.piTextBytes(text),
      storedAt: Date.now(),
    };
  }

  private piToolResultTruncationNotice(
    truncation: PiToolResultTruncation,
  ): string {
    const shown =
      truncation.truncatedBy === "lines"
        ? `${truncation.outputLines} of ${truncation.totalLines} lines`
        : `${truncation.outputBytes} of ${truncation.totalBytes} bytes`;
    const source = truncation.fullOutput?.path
      ? ` Full output stored in R2 at ${truncation.fullOutput.path}. Read it with read({ location: "r2", path: "${truncation.fullOutput.path}" }).`
      : "";
    return `[Output truncated: showing ${truncation.direction === "tail" ? "last" : "first"} ${shown}.${source}]`;
  }

  private mergePiToolResultDetails(
    existing: unknown,
    patch: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      ...(existing && typeof existing === "object" && !Array.isArray(existing)
        ? existing as Record<string, unknown>
        : {}),
      ...patch,
    };
  }

  private async truncatePiToolResultForModel(
    context: AfterToolCallContext,
  ): Promise<AfterToolCallResult | undefined> {
    const content = Array.isArray(context.result.content)
      ? context.result.content
      : [];
    const textParts: string[] = [];
    const nonTextContent: AfterToolCallResult["content"] = [];
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      if (part.type === "text" && typeof part.text === "string") {
        textParts.push(part.text);
      } else if (part.type === "image") {
        nonTextContent.push(part);
      }
    }
    if (textParts.length === 0) return undefined;

    const fullText = textParts.join(textParts.length > 1 ? "\n" : "");
    const direction = PI_TAIL_TRUNCATED_TOOL_NAMES.has(context.toolCall.name)
      ? "tail"
      : "head";
    const truncated = this.truncatePiToolResultText(fullText, direction);
    if (!truncated.truncation) return undefined;

    let fullOutput: PiR2ToolResultReference | undefined;
    try {
      fullOutput = await this.storePiFullToolResultInR2(
        context.toolCall.name,
        context.toolCall.id,
        fullText,
      );
    } catch (error) {
      console.error("[ChatThreadDO] failed to store oversized Pi tool result in R2", error);
    }

    const truncation: PiToolResultTruncation = {
      ...truncated.truncation,
      ...(fullOutput ? { fullOutput } : {}),
    };

    return {
      content: [
        {
          type: "text",
          text: `${truncated.content}\n\n${this.piToolResultTruncationNotice(truncation)}`,
        },
        ...nonTextContent,
      ],
      details: this.mergePiToolResultDetails(context.result.details, {
        [PI_TOOL_RESULT_R2_REF_METADATA_KEY]: fullOutput,
        truncation,
        originalTextBlockCount: textParts.length,
      }),
    };
  }

  private async afterPiToolCall(
    context: AfterToolCallContext,
    signal?: AbortSignal,
  ): Promise<AfterToolCallResult | undefined> {
    if (signal?.aborted) return undefined;
    try {
      return await this.truncatePiToolResultForModel(context);
    } catch (error) {
      console.error("[ChatThreadDO] Pi afterToolCall hook failed", error);
      return undefined;
    }
  }

  private readPiR2ImageReference(part: Record<string, unknown>): PiR2ImageReference | null {
    const metadata = part.metadata;
    if (!metadata || typeof metadata !== "object") return null;
    const ref = (metadata as Record<string, unknown>)[PI_R2_IMAGE_REF_METADATA_KEY];
    if (!ref || typeof ref !== "object") return null;
    const record = ref as Record<string, unknown>;
    const key = typeof record.key === "string" ? record.key : "";
    const mimeType = typeof record.mimeType === "string" ? record.mimeType : "";
    const sha256 = typeof record.sha256 === "string" ? record.sha256 : "";
    if (!key || !mimeType || !sha256) return null;
    return {
      key,
      mimeType,
      sha256,
      size: Math.max(0, Math.floor(Number(record.size) || 0)),
      storedAt: Math.max(0, Math.floor(Number(record.storedAt) || 0)),
    };
  }

  private async externalizePiImagesForSqlStorage(value: unknown, stats: PiSqlStorageStats): Promise<unknown> {
    if (value === null || value === undefined || typeof value !== "object") return value;
    if (Array.isArray(value)) {
      return Promise.all(value.map((item) => this.externalizePiImagesForSqlStorage(item, stats)));
    }
    const record = value as Record<string, unknown>;
    if (record.type === "image" && typeof record.data === "string") {
      const data = record.data;
      const mimeType = typeof record.mimeType === "string"
        ? normalizePiImageMimeType(record.mimeType)
        : "";
      if (
        data.length > PI_MAX_PERSISTED_IMAGE_DATA_CHARS &&
        mimeType &&
        PI_PROVIDER_SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)
      ) {
        const sha256 = await this.sha256Hex(data);
        const key = this.piStoredImageR2Key(sha256);
        if (key) {
          try {
            await this.env.R2_BUCKET.put(key, data, {
              httpMetadata: { contentType: "text/plain; charset=utf-8" },
              customMetadata: {
                type: "pi-message-image-base64",
                mimeType,
                sessionId: this.chatContext?.threadId ?? "",
                threadId: this.chatContext?.threadId ?? "",
                workspaceId: this.chatContext?.workspaceId ?? "",
                orgId: this.chatContext?.orgId ?? "",
                sha256,
              },
            });
            stats.externalizedImages += 1;
            const metadata = record.metadata && typeof record.metadata === "object"
              ? { ...(record.metadata as Record<string, unknown>) }
              : {};
            metadata[PI_R2_IMAGE_REF_METADATA_KEY] = {
              key,
              mimeType,
              size: data.length,
              sha256,
              storedAt: Date.now(),
            } satisfies PiR2ImageReference;
            return {
              ...record,
              mimeType,
              data: "",
              metadata,
            };
          } catch (error) {
          }
        }
      }
    }
    const next: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(record)) {
      next[key] = await this.externalizePiImagesForSqlStorage(nested, stats);
    }
    return next;
  }

  private async hydratePiStoredImages(value: unknown): Promise<unknown> {
    if (value === null || value === undefined || typeof value !== "object") return value;
    if (Array.isArray(value)) {
      return Promise.all(value.map((item) => this.hydratePiStoredImages(item)));
    }
    const record = value as Record<string, unknown>;
    if (record.type === "image") {
      const ref = this.readPiR2ImageReference(record);
      if (ref && typeof record.data === "string" && record.data.length === 0) {
        let data = "";
        try {
          const object = await this.env.R2_BUCKET.get(ref.key);
          data = object ? await object.text() : "";
        } catch (error) {
        }
        if (data) {
          return {
            ...record,
            data,
            mimeType: ref.mimeType,
          };
        }
        return {
          type: "text",
          text: `(image data unavailable from persisted transcript: ${ref.mimeType}, ${ref.size} base64 chars)`,
        };
      }
    }
    const next: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(record)) {
      next[key] = await this.hydratePiStoredImages(nested);
    }
    return next;
  }

  private async serializePiMessageForSqlStorageDetailed(message: AgentMessage): Promise<PiSqlStorageSerialization> {
    const stats = emptyPiSqlStorageStats();
    stats.originalChars = JSON.stringify(message).length;
    const providerSanitized = sanitizePiProviderMessage(message);
    const externalized = await this.externalizePiImagesForSqlStorage(providerSanitized, stats);
    let prepared = preparePiMessageForSqlStorage(externalized as AgentMessage, stats);
    let serialized = JSON.stringify(prepared);
    if (serialized.length <= PI_SQLITE_STORAGE_SOFT_LIMIT_CHARS) {
      stats.storedChars = serialized.length;
      return { payload: serialized, stats };
    }

    prepared = shrinkPiValueForSqlStorage(prepared, 4, stats) as AgentMessage;
    serialized = JSON.stringify(prepared);
    if (serialized.length <= PI_SQLITE_STORAGE_SOFT_LIMIT_CHARS) {
      stats.storedChars = serialized.length;
      return { payload: serialized, stats };
    }

    stats.omittedWholeMessage = true;
    const payload = JSON.stringify({
      role: (message as unknown as Record<string, unknown>).role ?? "user",
      content: `[message omitted from persisted transcript: serialized size ${serialized.length} chars exceeded storage safety limit]`,
      timestamp:
        typeof (message as unknown as Record<string, unknown>).timestamp === "number"
          ? (message as unknown as Record<string, unknown>).timestamp
          : Date.now(),
      metadata: { storageOmitted: true },
    });
    stats.storedChars = payload.length;
    return { payload, stats };
  }

  private async attachCodeModeArtifactsToToolResult(
    message: AgentMessage,
    options: { consume?: boolean } = {},
  ): Promise<AgentMessage> {
    if (!message || typeof message !== "object" || Array.isArray(message)) return message;
    const record = message as unknown as Record<string, unknown>;
    if (record.role !== "toolResult" || record.toolName !== "js_exec") return message;
    const toolCallId = typeof record.toolCallId === "string" ? record.toolCallId.trim() : "";
    if (!toolCallId) return message;
    const artifacts = await this.consumeCodeModeArtifacts(toolCallId, {
      deleteAfterRead: options.consume === true,
    });
    if (artifacts.length === 0) return message;
    const existingMetadata = normalizePiUiMetadata(record.uiMetadata);
    const artifactsById = new Map<string, RuntimeCallArtifact>();
    for (const artifact of existingMetadata?.codeModeArtifacts ?? []) {
      artifactsById.set(artifact.id, artifact);
    }
    for (const artifact of artifacts) {
      artifactsById.set(artifact.id, artifact);
    }
    return {
      ...record,
      uiMetadata: {
        ...(existingMetadata ?? {}),
        codeModeArtifacts: Array.from(artifactsById.values()),
      } satisfies PiUiMetadata,
    } as unknown as AgentMessage;
  }

  private async loadPiCoreMessages(options: { includeUiMetadata?: boolean } = {}): Promise<AgentMessage[]> {
    this.ensurePiCoreTables();
    const compaction = this.loadPiCoreCompaction();
    const firstKeptIndex = compaction?.firstKeptIndex ?? 0;
    const rows = firstKeptIndex > 0
      ? this.ctx.storage.sql
        .exec<{ payload: string }>(
          "SELECT payload FROM pi_core_messages WHERE idx >= ? ORDER BY idx ASC",
          firstKeptIndex,
        )
        .toArray()
      : this.ctx.storage.sql
        .exec<{ payload: string }>(
          "SELECT payload FROM pi_core_messages ORDER BY idx ASC",
        )
        .toArray();
    const messages: AgentMessage[] = [];
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.payload) as AgentMessage;
        if (parsed && typeof parsed === "object" && "role" in parsed) {
          const hydrated = await this.hydratePiStoredImages(parsed);
          messages.push(options.includeUiMetadata
            ? sanitizePiProviderMessage(hydrated as AgentMessage)
            : sanitizePiModelMessage(hydrated as AgentMessage));
        }
      } catch {
        // Skip corrupt rows rather than failing the whole thread.
      }
    }
    if (!compaction || firstKeptIndex <= 0) return messages;
    return [
      this.createPiSummaryMessage(compaction.summary, compaction.updatedAt),
      ...messages,
    ];
  }

  private async replacePiCoreMessages(messages: AgentMessage[]): Promise<void> {
    this.ensurePiCoreTables();
    this.ctx.storage.sql.exec("DELETE FROM pi_core_messages");
    const now = Date.now();
    const aggregateStats = emptyPiSqlStorageStats();
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      const serialized = await this.serializePiMessageForSqlStorageDetailed(message);
      this.addPiSqlStorageStats(aggregateStats, serialized.stats);
      this.ctx.storage.sql.exec(
        "INSERT INTO pi_core_messages (idx, payload, created_at) VALUES (?, ?, ?)",
        index,
        serialized.payload,
        now,
      );
    }
    this.recordPiSqlStorageSanitization("replace", aggregateStats, messages.length);
  }

  private async appendPiCoreMessages(messages: AgentMessage[]): Promise<void> {
    if (messages.length === 0) return;
    this.ensurePiCoreTables();
    const rows = this.ctx.storage.sql
      .exec<{ next_idx: number }>(
        "SELECT COALESCE(MAX(idx) + 1, 0) AS next_idx FROM pi_core_messages",
      )
      .toArray();
    const startIndex = Math.max(0, Math.floor(Number(rows[0]?.next_idx) || 0));
    const now = Date.now();
    const aggregateStats = emptyPiSqlStorageStats();
    for (let offset = 0; offset < messages.length; offset += 1) {
      const message = messages[offset];
      const serialized = await this.serializePiMessageForSqlStorageDetailed(message);
      this.addPiSqlStorageStats(aggregateStats, serialized.stats);
      this.ctx.storage.sql.exec(
        "INSERT INTO pi_core_messages (idx, payload, created_at) VALUES (?, ?, ?)",
        startIndex + offset,
        serialized.payload,
        now,
      );
    }
    this.recordPiSqlStorageSanitization("append", aggregateStats, messages.length);
  }

  private piCoreMessageKey(message: AgentMessage): string {
    const record = stripPiUiMetadata(message) as unknown as Record<string, unknown>;
    if (record.role === "assistant" && typeof record.responseId === "string" && record.responseId.trim()) {
      return `assistant:${record.responseId.trim()}`;
    }
    if (record.role === "toolResult" && typeof record.toolCallId === "string" && record.toolCallId.trim()) {
      return [
        "toolResult",
        record.toolCallId.trim(),
        record.isError === true ? "error" : "ok",
        this.piCoreMessageKeyContent(record.content),
      ].join(":");
    }
    return [
      record.role,
      typeof record.timestamp === "number" ? record.timestamp : "",
      typeof record.responseId === "string" ? record.responseId : "",
      typeof record.toolCallId === "string" ? record.toolCallId : "",
      this.piCoreMessageKeyContent(record.content),
    ].join(":");
  }

  private piCoreMessageKeyContent(content: unknown): string {
    try {
      const serialized = JSON.stringify(preparePiMessageForSqlStorage({
        role: "user",
        content,
        timestamp: 0,
      } as unknown as AgentMessage));
      return serialized.length > 20_000
        ? serialized.slice(0, 20_000)
        : serialized;
    } catch {
      return String(content);
    }
  }

  private addPiSqlStorageStats(total: PiSqlStorageStats, next: PiSqlStorageStats): void {
    total.externalizedImages += next.externalizedImages;
    total.omittedImages += next.omittedImages;
    total.truncatedStrings += next.truncatedStrings;
    total.omittedWholeMessage = total.omittedWholeMessage || next.omittedWholeMessage;
    total.originalChars += next.originalChars;
    total.storedChars += next.storedChars;
  }

  private recordPiSqlStorageSanitization(
    operation: string,
    stats: PiSqlStorageStats,
    messageCount: number,
  ): void {
    if (
      stats.externalizedImages === 0 &&
      stats.omittedImages === 0 &&
      stats.truncatedStrings === 0 &&
      !stats.omittedWholeMessage &&
      stats.originalChars <= stats.storedChars
    ) {
      return;
    }
    const status = stats.omittedWholeMessage
      ? "omitted"
      : stats.externalizedImages > 0
        ? "externalized"
        : "truncated";
  }

  private dedupePiMessagesByKey(
    messages: AgentMessage[],
    existingKeys: Iterable<string> = [],
  ): AgentMessage[] {
    const seen = new Set(existingKeys);
    return messages.filter((message) => {
      const key = this.piCoreMessageKey(message);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private async appendPiCoreMessagesIfMissing(messages: AgentMessage[]): Promise<void> {
    if (messages.length === 0) return;
    const existingMessages = await this.loadPiCoreMessages();
    const existingKeys = new Set(
      existingMessages.map((message) => this.piCoreMessageKey(message)),
    );
    const missing = messages.filter((message) => {
      const key = this.piCoreMessageKey(message);
      if (existingKeys.has(key)) return false;
      existingKeys.add(key);
      return true;
    });
    await this.appendPiCoreMessages(missing);
    if (missing.length === 0) {
    }
  }

  // --- Durable resume of an interrupted Pi turn (Flue-style journal + reconcile) ---

  /**
   * Mirror the in-flight (not-yet-committed) tail of the live session into the
   * `pi_turn_journal` staging table. Called as the turn produces work
   * (message_end / tool_execution_end) so a mid-turn eviction can recover it.
   */
  private async recordPiTurnJournalTail(): Promise<void> {
    const session = this.piSession;
    if (!session) return;
    const tail = session.state.messages.slice(this.piMainBaselineIndex);
    // Serialize the replacement payloads FIRST. serializePiMessageForSqlStorageDetailed
    // can await R2/image work, and an eviction during that await must NOT leave us
    // with a half-written journal — so we keep the previous (valid) checkpoint until
    // the new payloads are fully prepared.
    const payloads: string[] = [];
    for (const message of tail) {
      payloads.push((await this.serializePiMessageForSqlStorageDetailed(message)).payload);
    }
    // Now swap the table contents with no await between DELETE and the INSERTs, so
    // the replacement is atomic from an eviction's standpoint (synchronous run).
    this.ensurePiCoreTables();
    const now = Date.now();
    this.ctx.storage.sql.exec("DELETE FROM pi_turn_journal");
    for (let index = 0; index < payloads.length; index += 1) {
      this.ctx.storage.sql.exec(
        "INSERT INTO pi_turn_journal (seq, payload, created_at) VALUES (?, ?, ?)",
        index,
        payloads[index],
        now,
      );
    }
  }

  /**
   * Seed the journal with the just-accepted user message BEFORE `prompt()` runs.
   * The first {@link recordPiTurnJournalTail} only happens on message_end, so
   * without this an eviction in the window between agent_start and the model's
   * first message would fold an empty journal, see the prior assistant turn as
   * already complete, and silently drop the accepted prompt.
   */
  private recordPiTurnJournalUserMessage(userMessage: AgentMessage): void {
    // Use the SYNCHRONOUS serializer (no R2 image externalization) so the durable
    // journal write happens with NO awaitable I/O before it — otherwise an eviction
    // during an image prompt's R2 PUT could land in a window where the marker is set
    // but the journal is still empty, and the prompt would be dropped. Oversized
    // messages are truncated/omitted by the serializer (bounded row); after the first
    // message_end, recordPiTurnJournalTail rewrites the journal with the full
    // R2-externalized tail.
    const payload = serializePiMessageForSqlStorageDetailed(userMessage).payload;
    this.ensurePiCoreTables();
    const now = Date.now();
    this.ctx.storage.sql.exec("DELETE FROM pi_turn_journal");
    // A fresh prompt only starts when not streaming, so any steer-journal entries
    // are stale leftovers from a prior run — drop them so they can't fold in here.
    this.clearPiTurnSteerJournal();
    this.ctx.storage.sql.exec(
      "INSERT INTO pi_turn_journal (seq, payload, created_at) VALUES (?, ?, ?)",
      0,
      payload,
      now,
    );
  }

  private async loadPiTurnJournalTail(): Promise<AgentMessage[]> {
    this.ensurePiCoreTables();
    const rows = this.ctx.storage.sql
      .exec<{ payload: string }>(
        "SELECT payload FROM pi_turn_journal ORDER BY seq ASC",
      )
      .toArray();
    const messages: AgentMessage[] = [];
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.payload) as AgentMessage;
        if (parsed && typeof parsed === "object" && "role" in parsed) {
          const hydrated = await this.hydratePiStoredImages(parsed);
          messages.push(sanitizePiModelMessage(hydrated as AgentMessage));
        }
      } catch {
        // Skip corrupt journal rows rather than failing recovery.
      }
    }
    return messages;
  }

  private clearPiTurnJournal(): void {
    this.ensurePiCoreTables();
    this.ctx.storage.sql.exec("DELETE FROM pi_turn_journal");
  }

  /**
   * Durably record a user message accepted via `steer()` while a turn is already
   * streaming, so a mid-turn eviction can re-deliver it instead of silently
   * dropping it. A small bounded list lives in sync KV (no table needed); the
   * sync serializer keeps each payload within KV's value limit, and the
   * read-push-write has no await between read and write so it is atomic against
   * eviction (same property as {@link recordPiTurnJournalUserMessage}). Appended,
   * not replaced: a single turn can accept several steering messages.
   */
  private recordPiTurnJournalSteerMessage(userMessage: AgentMessage): void {
    const payload = serializePiMessageForSqlStorageDetailed(userMessage).payload;
    const existing =
      this.ctx.storage.kv.get<string[]>(PI_STEER_JOURNAL_KEY) ?? [];
    existing.push(payload);
    this.ctx.storage.kv.put(PI_STEER_JOURNAL_KEY, existing);
  }

  private async loadPiTurnSteerJournal(): Promise<AgentMessage[]> {
    const payloads =
      this.ctx.storage.kv.get<string[]>(PI_STEER_JOURNAL_KEY) ?? [];
    const messages: AgentMessage[] = [];
    for (const payload of payloads) {
      try {
        const parsed = JSON.parse(payload) as AgentMessage;
        if (parsed && typeof parsed === "object" && "role" in parsed) {
          const hydrated = await this.hydratePiStoredImages(parsed);
          messages.push(sanitizePiModelMessage(hydrated as AgentMessage));
        }
      } catch {
        // Skip corrupt entries rather than failing recovery.
      }
    }
    return messages;
  }

  private clearPiTurnSteerJournal(): void {
    this.ctx.storage.kv.delete(PI_STEER_JOURNAL_KEY);
  }

  private readPiActiveTurn(): PiActiveTurnMarker | null {
    return this.ctx.storage.kv.get<PiActiveTurnMarker>(PI_ACTIVE_TURN_KEY) ?? null;
  }

  /** Mark a turn in flight (once per turn) so a cold load knows to resume it. */
  private openPiActiveTurnIfAbsent(): void {
    if (this.readPiActiveTurn()) return;
    this.writePiActiveTurn({
      turnId: crypto.randomUUID(),
      attempt: 0,
      openedAt: Date.now(),
    });
  }

  private writePiActiveTurn(marker: PiActiveTurnMarker): void {
    this.ctx.storage.kv.put(PI_ACTIVE_TURN_KEY, marker);
  }

  private async clearPiActiveTurnAndJournal(): Promise<void> {
    this.ctx.storage.kv.delete(PI_ACTIVE_TURN_KEY);
    this.clearPiTurnJournal();
    // Steering messages span the whole agent run (a steer can drain in a later
    // turn), so they are only dropped here at agent_end — not at per-turn turn_end.
    this.clearPiTurnSteerJournal();
  }

  /**
   * Agents SDK hook: called on the next wake when an interrupted durable fiber is
   * detected (the DO was evicted mid-turn). This runs BEFORE onStart, so the Pi
   * session isn't built yet — schedule the resume rather than driving Pi inline.
   */
  override async onFiberRecovered(ctx: { name: string }): Promise<void> {
    if (ctx.name !== PI_TURN_FIBER) return;
    if (!this.readPiActiveTurn()) return; // turn already committed -> nothing to resume
    // idempotent: this hook runs inside the SDK's wake-time fiber scan (onStart
    // context), so a thread re-woken while the marker persists must not stack
    // duplicate resume callbacks.
    await this.schedule(0, "resumeInterruptedPiTurn", undefined, { idempotent: true });
  }

  /**
   * Reconcile an interrupted turn (committed history + journal tail are folded in
   * by {@link createPiSession}) and drive it to completion via `Agent.continue()`
   * when the model still owes output. Invoked by the scheduler after
   * {@link onFiberRecovered}; re-wraps the continuation in a fiber so a second
   * eviction is recovered too. Bounded by the attempt budget on the active-turn
   * marker.
   */
  async resumeInterruptedPiTurn(): Promise<void> {
    const marker = this.readPiActiveTurn();
    if (!marker) return;
    // Bail only if a turn is genuinely running in THIS process.
    // `piSession.state.isStreaming` is the live in-memory signal (piSession is null
    // on a fresh wake, so we proceed to rebuild and continue).
    if (this.piSession?.state.isStreaming) return;
    if (!this.chatContext) {
      // No context to rebuild the session — drop the marker to avoid a hot loop.
      await this.clearPiActiveTurnAndJournal();
      return;
    }
    if (marker.attempt >= MAX_PI_RESUME_ATTEMPTS) {
      await this.failPiResume();
      return;
    }
    // Bump the attempt budget before doing work so a crash during resume is bounded.
    this.writePiActiveTurn({ ...marker, attempt: marker.attempt + 1 });

    try {
      // Rebuilding the Pi session can fail on its own (e.g. OrgDO/model-provider
      // config retries exhaust). Keep it INSIDE this try so a setup failure runs
      // the same release cleanup as a continuation failure — otherwise the marker,
      // journal, and isStreaming would stay set with the fiber row already consumed
      // and no remaining trigger to retry recovery, stranding the thread busy.
      await this.ensurePiSessionReady();
      const session = this.piSession;
      if (!session) return;
      const messages = session.state.messages;
      const last = messages[messages.length - 1] as { role?: string } | undefined;
      const owesModelOutput = last?.role === "user" || last?.role === "toolResult";
      if (!owesModelOutput) {
        // The interrupted turn already produced its final assistant message; commit
        // whatever the journal staged and close the turn out — nothing to continue.
        // Fold Code Mode / js_exec artifacts back onto their tool results first, the
        // same way turn_end does (consume drains the transient KV artifact bucket) —
        // otherwise the reloaded transcript would be missing those artifacts.
        const tail = messages.slice(this.piMainBaselineIndex);
        if (tail.length > 0) {
          const tailWithArtifacts = await Promise.all(
            tail.map((message) =>
              this.attachCodeModeArtifactsToToolResult(message, { consume: true }),
            ),
          );
          await this.appendPiCoreMessagesIfMissing(tailWithArtifacts);
          this.piMainBaselineIndex = messages.length;
        }
        await this.clearPiActiveTurnAndJournal();
        // This is the ONLY completion path for a turn recovered after its final
        // assistant message but before agent_end ran, so finalize it exactly like
        // the normal agent_end path via finishTurn({ markUnread }): it drives
        // recordThreadAssistantCompletion (workspace unread + completion timestamp),
        // the active automation run -> success, and the completion summary.
        const completedAt = Date.now();
        const finalText = this.extractLatestPiAssistantText(messages);
        const summarySource = extractThreadCompletionSummarySource(
          messages,
          finalText,
        );
        this.finishTurn({
          markUnread: true,
          completedAt,
          summarySource,
        });
        this.setActiveTurnUserId(null);
        await this.completeTodoStateForTurnEnd();
        return;
      }
      // Turn-start bookkeeping runs from the agent_start event the continuation
      // below emits; the spinner is already derived-on from the fiber row.
      await this.runFiber(PI_TURN_FIBER, async () => {
        await this.withPiTurnInactivityTimeout(async () => {
          const active = this.piSession;
          if (!active) {
            throw new Error("Pi session was not available to resume the interrupted turn");
          }
          await active.continue();
        });
      });
      // A successful continuation runs the normal lifecycle; `agent_end` clears the
      // marker + journal.
    } catch (error) {
      // A genuine eviction tears down the isolate before this catch can run, so
      // anything reaching here is an in-process failure: a session-rebuild failure
      // (ensurePiSessionReady), a provider error, the inactivity timeout, or a user
      // abort. The fiber row is already consumed/deleted, so without this cleanup
      // the marker, journal, and isStreaming would stay set with no trigger left to
      // retry recovery — the thread would be stuck busy until manual intervention.
      // Mirror the initial prompt path's failure cleanup.
      const isInactivityTimeout = error instanceof PiTurnInactivityTimeoutError;
      if (
        !isInactivityTimeout &&
        error instanceof Error &&
        (error.name === "AbortError" || /aborted/i.test(error.message))
      ) {
        // A user stop keeps the Pi handlers subscribed, so agent_end still runs and
        // clears the marker + journal + streaming. Leave it to that path.
        return;
      }
      console.error("[ChatThreadDO] Pi turn resume failed", error);
      this.persistPiAgentLoopErrorForDevelopers(error, { source: "pi_resume" });
      const errorMessage = isInactivityTimeout
        ? "The assistant stalled and the resumed turn was stopped after a period of inactivity. Please try again."
        : error instanceof Error
          ? error.message
          : String(error);
      this.pushChatEvent(this.piProviderErrorEvent(errorMessage));
      this.updateActiveAutomationRun({
        status: "error",
        message: errorMessage,
        clear: true,
      });
      this.finishTurn();
      this.setActiveTurnUserId(null);
      await this.clearPiActiveTurnAndJournal();
    } finally {
      // Post-settle: broadcast the derived state to clear the spinner once done.
      this.syncAgentState();
    }
  }

  private async failPiResume(): Promise<void> {
    await this.clearPiActiveTurnAndJournal();
    this.finishTurn();
    // Release turn ownership like the normal completion / resume-error paths,
    // otherwise getActiveTurnUserId() keeps attributing later sandbox MCP /
    // integration calls to the abandoned turn's author until the next turn.
    this.setActiveTurnUserId(null);
    this.recordChatThreadObservabilityEvent("pi_turn_resume_abandoned", {
      operation: "resume_interrupted_turn",
      status: "abandoned",
      severity: "warn",
    });
    try {
      this.pushChatEvent(
        this.piProviderErrorEvent(
          "This turn was interrupted and could not be resumed automatically. Please send your message again.",
        ),
      );
    } catch {
      // Best effort: the observability event above is the actionable signal.
    }
  }

  private discardUnpersistedPiSessionMessages(): number {
    const sessionMessages = this.piSession?.state.messages;
    if (!sessionMessages) return 0;
    const baselineIndex = Math.max(
      0,
      Math.min(this.piMainBaselineIndex, sessionMessages.length),
    );
    const droppedCount = sessionMessages.length - baselineIndex;
    if (droppedCount > 0 && this.piSession) {
      this.piSession.state.messages = sessionMessages.slice(0, baselineIndex);
    }
    this.piMainBaselineIndex = baselineIndex;
    return droppedCount;
  }

  private touchPiTurnProgress(): void {
    this.piTurnLastProgressAtMs = Date.now();
  }

  private async keepPiTurnToolProgressAliveWhile<T>(fn: () => Promise<T>): Promise<T> {
    this.touchPiTurnProgress();
    const interval = setInterval(() => this.touchPiTurnProgress(), PI_TURN_PROGRESS_INTERVAL_MS);
    try {
      return await fn();
    } finally {
      clearInterval(interval);
      this.touchPiTurnProgress();
    }
  }

  private async withPiTurnInactivityTimeout(
    fn: () => Promise<void>,
  ): Promise<void> {
    this.touchPiTurnProgress();
    let interval: ReturnType<typeof setInterval> | null = null;
    try {
      await Promise.race([
        fn(),
        new Promise<never>((_, reject) => {
          interval = setInterval(() => {
            const stalledMs = Math.max(0, Date.now() - this.piTurnLastProgressAtMs);
            if (stalledMs < PI_TURN_INACTIVITY_TIMEOUT_MS) return;
            this.disposePiSession();
            reject(new PiTurnInactivityTimeoutError());
          }, PI_TURN_PROGRESS_INTERVAL_MS);
        }),
      ]);
    } finally {
      if (interval) clearInterval(interval);
      this.piTurnLastProgressAtMs = 0;
    }
  }

  private emptyPiUsage() {
    return {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
  }

  private createPiUserStopMessage(timestamp: number): AgentMessage {
    const model = this.piSession?.state.model;
    return {
      role: "assistant",
      content: [{
        type: "text",
        text: PI_USER_STOP_TEXT,
      }],
      api: model?.api ?? "unknown",
      provider: model?.provider ?? "unknown",
      model: model?.id ?? "unknown",
      usage: this.emptyPiUsage(),
      stopReason: "aborted",
      responseId: `pi_user_stop_${timestamp}`,
      timestamp,
      metadata: {
        reason: PI_USER_STOP_METADATA_REASON,
      },
    } as unknown as AgentMessage;
  }

  private isAbortedPiAssistantMessage(message: AgentMessage): boolean {
    const record = message as unknown as Record<string, unknown>;
    return (
      record.role === "assistant" &&
      record.stopReason === "aborted"
    );
  }

  private isFailedPiAssistantMessage(message: AgentMessage): boolean {
    if (!message || typeof message !== "object") return false;
    const record = message as unknown as Record<string, unknown>;
    return (
      record.role === "assistant" &&
      (record.stopReason === "aborted" || record.stopReason === "error")
    );
  }

  private isEmptyAbortedPiAssistantMessage(message: AgentMessage): boolean {
    return (
      this.isAbortedPiAssistantMessage(message) &&
      this.extractPiMessageText(message).length === 0
    );
  }

  private ensurePiUserStopMessage(
    messages: AgentMessage[],
    stoppedAtMs: number,
  ): AgentMessage[] {
    const visibleMessages = messages.filter(
      (message) => !this.isEmptyAbortedPiAssistantMessage(message),
    );
    if (visibleMessages.some((message) => isPiUserStopMessage(message))) {
      return visibleMessages;
    }
    return [...visibleMessages, this.createPiUserStopMessage(stoppedAtMs)];
  }

  private piProviderErrorMetadata(message: string): {
    status?: number;
    errorType?: string;
  } {
    const trimmed = message.trim();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      const start = trimmed.indexOf("{");
      const end = trimmed.lastIndexOf("}");
      if (start !== -1 && end > start) {
        try {
          parsed = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
        } catch {
          parsed = null;
        }
      }
    }

    const root = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
    const nested = root?.error && typeof root.error === "object" && !Array.isArray(root.error)
      ? root.error as Record<string, unknown>
      : null;
    const statusCandidate =
      root?.status ??
      root?.statusCode ??
      root?.code ??
      nested?.status ??
      nested?.statusCode ??
      nested?.code;
    const statusFromText = /\bHTTP\s+(\d{3})\b/i.exec(trimmed)?.[1] ??
      /\berror code:\s*(\d{3})\b/i.exec(trimmed)?.[1];
    const parsedStatus =
      typeof statusCandidate === "number" && Number.isFinite(statusCandidate)
        ? Math.trunc(statusCandidate)
        : typeof statusCandidate === "string" && /^\d{3}$/.test(statusCandidate.trim())
          ? Number(statusCandidate.trim())
          : statusFromText
            ? Number(statusFromText)
            : /\b429\b/.test(trimmed)
              ? 429
              : /\b524\b/.test(trimmed)
                ? 524
            : undefined;
    const errorTypeCandidate =
      nested?.type ??
      nested?.error_type ??
      root?.type ??
      root?.error_type;

    return {
      ...(parsedStatus ? { status: parsedStatus } : {}),
      ...(typeof errorTypeCandidate === "string" && errorTypeCandidate.trim()
        ? { errorType: errorTypeCandidate.trim() }
        : {}),
    };
  }

  private annotatePiProviderErrorMessages(messages: AgentMessage[]): AgentMessage[] {
    let changed = false;
    const next = messages.map((message) => {
      const record = message as unknown as Record<string, unknown>;
      const errorMessage = this.getPiAssistantErrorMessage(message);
      if (!errorMessage) return message;

      changed = true;
      const billingSource =
        record.billingSource === "byok" || record.billingSource === "hosted"
          ? record.billingSource
          : this.piCurrentBillingSource;
      const provider =
        this.piCurrentUsageProvider ||
        (typeof record.provider === "string" ? record.provider : undefined);
      const metadata = this.piProviderErrorMetadata(errorMessage);
      const model =
        typeof record.model === "string" && record.model.trim()
          ? record.model.trim()
          : this.piSession?.state.model?.id;
      this.recordPiProviderErrorMessage({
        message,
        errorMessage,
        provider,
        model,
        metadata,
      });
      return {
        ...record,
        billingSource,
        ...(provider ? { provider } : {}),
        ...metadata,
      } as unknown as AgentMessage;
    });

    return changed ? next : messages;
  }

  private recordPiProviderErrorMessage(args: {
    message: AgentMessage;
    errorMessage: string;
    provider?: string | null;
    model?: string | null;
    metadata: { status?: number; errorType?: string };
  }): void {
    if (!this.piRecordedProviderErrors) {
      this.piRecordedProviderErrors = new Set();
    }
    const record = args.message as unknown as Record<string, unknown>;
    const fingerprint = [
      typeof record.responseId === "string" ? record.responseId : "",
      typeof record.timestamp === "number" ? String(record.timestamp) : "",
      args.provider ?? "",
      args.model ?? "",
      args.errorMessage,
    ].join("|");
    if (this.piRecordedProviderErrors.has(fingerprint)) return;
    this.piRecordedProviderErrors.add(fingerprint);
    if (this.piRecordedProviderErrors.size > 200) {
      const first = this.piRecordedProviderErrors.values().next().value;
      if (typeof first === "string") this.piRecordedProviderErrors.delete(first);
    }

    const error = new Error(args.errorMessage);
    error.name = "PiProviderError";
  }

  private getPiAssistantErrorMessage(message: AgentMessage): string {
    const record = message as unknown as Record<string, unknown>;
    if (record.role !== "assistant") return "";
    if (record.stopReason === "aborted") return "";
    if (typeof record.errorMessage === "string" && record.errorMessage.trim()) {
      return record.errorMessage.trim();
    }
    return "";
  }

  private getLatestPiAssistantErrorMessage(messages: AgentMessage[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      const errorMessage = this.getPiAssistantErrorMessage(messages[i]);
      if (errorMessage) return errorMessage;
    }
    return "";
  }

  private piAgentLoopErrorDetails(error: unknown): {
    name: string;
    message: string;
    stack?: string;
  } {
    if (error instanceof Error) {
      return {
        name: error.name || "Error",
        message: error.message.trim() || "Unknown Pi agent loop error",
        stack: typeof error.stack === "string" ? error.stack : undefined,
      };
    }
    if (typeof error === "string" && error.trim()) {
      return { name: "Error", message: error.trim() };
    }
    try {
      const serialized = JSON.stringify(error);
      if (serialized && serialized !== "{}") {
        return { name: "UnknownError", message: serialized };
      }
    } catch {
      // Fall through to the generic message.
    }
    return { name: "UnknownError", message: "Unknown Pi agent loop error" };
  }

  private retryChatDurableObjectRpc<T>(
    operation: string,
    fn: () => Promise<T>,
    options: { attempts?: number; initialDelayMs?: number } = {},
  ): Promise<T> {
    return retryTransientDurableObjectRpc(operation, fn, options);
  }

  private persistPiAgentLoopErrorForDevelopers(
    error: unknown,
    options: {
      source: string;
      eventType?: string;
    },
  ): string {
    const details = this.piAgentLoopErrorDetails(error);
    const source = options.source.trim() || "pi_agent_loop";
    const eventType = options.eventType?.trim();
    const fingerprint = `${source}:${eventType ?? ""}:${details.name}:${details.message}`;
    const now = Date.now();
    if (
      this.piLastPersistedLoopError?.fingerprint === fingerprint &&
      now - this.piLastPersistedLoopError.at < 5_000
    ) {
      return details.message;
    }
    this.piLastPersistedLoopError = { fingerprint, at: now };

    const context = this.chatContext;

    return details.message;
  }

  private ensurePiAssistantTextMessage(messages: AgentMessage[], text: string): AgentMessage[] {
    const trimmed = text.trim();
    if (!trimmed) return messages;

    const hasAssistantText = messages.some((message) => {
      const record = message as unknown as Record<string, unknown>;
      if (record.role !== "assistant" || !Array.isArray(record.content)) return false;
      return record.content.some((part) => {
        if (!part || typeof part !== "object") return false;
        const item = part as Record<string, unknown>;
        return item.type === "text" && typeof item.text === "string" && item.text.trim();
      });
    });
    if (hasAssistantText) return messages;

    const next = messages.slice();
    for (let i = next.length - 1; i >= 0; i--) {
      const record = next[i] as unknown as Record<string, unknown>;
      if (record.role !== "assistant") continue;
      next[i] = {
        ...record,
        content: [{ type: "text", text: trimmed }],
        timestamp: typeof record.timestamp === "number" ? record.timestamp : Date.now(),
      } as unknown as AgentMessage;
      return next;
    }

    const model = this.piSession?.state.model;
    next.push({
      role: "assistant",
      content: [{ type: "text", text: trimmed }],
      api: model?.api ?? "unknown",
      provider: model?.provider ?? "unknown",
      model: model?.id ?? "unknown",
      usage: this.emptyPiUsage(),
      stopReason: "stop",
      timestamp: Date.now(),
    } as AgentMessage);
    return next;
  }

  private loadPiCoreCompaction(): { summary: string; firstKeptIndex: number; updatedAt: number } | null {
    this.ensurePiCoreTables();
    const rows = this.ctx.storage.sql
      .exec<{ summary: string; first_kept_index: number; updated_at: number }>(
        "SELECT summary, first_kept_index, updated_at FROM pi_core_compaction WHERE id = 1",
      )
      .toArray();
    const row = rows[0];
    if (!row || typeof row.summary !== "string") return null;
    return {
      summary: row.summary,
      firstKeptIndex: Math.max(0, Math.floor(Number(row.first_kept_index) || 0)),
      updatedAt: Math.max(0, Math.floor(Number(row.updated_at) || 0)),
    };
  }

  private persistPiCoreCompaction(summary: string, firstKeptIndex: number): void {
    this.ensurePiCoreTables();
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO pi_core_compaction (id, summary, first_kept_index, updated_at)
       VALUES (1, ?, ?, ?)`,
      summary,
      Math.max(0, Math.floor(firstKeptIndex)),
      Date.now(),
    );
  }

  private clearPiCoreCompaction(): void {
    this.ensurePiCoreTables();
    this.ctx.storage.sql.exec("DELETE FROM pi_core_compaction");
  }

  private async handleConnectionSetupResponse(
    response: ConnectionSetupResponse,
  ): Promise<{ accepted: boolean }> {
    const result = this.browserPrompts.answerConnectionSetup(response);
    if (!result.accepted) {
      console.warn("[ChatThreadDO] Received connection setup response with no pending waiter", {
        requestId: response.requestId,
      });
    }
    return result;
  }

  private readAuthorizedChatUserGrants(): Record<string, number> {
    const value = this.ctx.storage.kv.get<unknown>(CHAT_AUTHORIZED_USERS_KEY);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      // Includes the pre-TTL string[] format: discard rather than grant
      // untimestamped fail-open access.
      return {};
    }
    return value as Record<string, number>;
  }

  private isPreviouslyAuthorizedChatUser(userId: string): boolean {
    const grantedAt = this.readAuthorizedChatUserGrants()[userId];
    return (
      typeof grantedAt === "number" &&
      Date.now() - grantedAt < CHAT_DEGRADED_AUTH_GRANT_TTL_MS
    );
  }

  private recordAuthorizedChatUser(userId: string): void {
    const grants = this.readAuthorizedChatUserGrants();
    const now = Date.now();
    const existing = grants[userId];
    if (
      typeof existing === "number" &&
      now - existing < CHAT_DEGRADED_AUTH_GRANT_REFRESH_MS
    ) {
      return;
    }
    grants[userId] = now;
    const entries = Object.entries(grants)
      .filter(
        ([, grantedAt]) =>
          typeof grantedAt === "number" &&
          now - grantedAt < CHAT_DEGRADED_AUTH_GRANT_TTL_MS,
      )
      .sort(([, a], [, b]) => a - b);
    while (entries.length > CHAT_AUTHORIZED_USERS_MAX) entries.shift();
    this.ctx.storage.kv.put(
      CHAT_AUTHORIZED_USERS_KEY,
      Object.fromEntries(entries),
    );
  }

  private hasRecentlyAcceptedClientMessage(clientMessageId: string): boolean {
    const ids = this.ctx.storage.kv.get<string[]>(
      CHAT_RECENT_CLIENT_MESSAGE_IDS_KEY,
    );
    return Array.isArray(ids) && ids.includes(clientMessageId);
  }

  private recordAcceptedClientMessageId(clientMessageId: string): void {
    const ids = this.ctx.storage.kv.get<string[]>(
      CHAT_RECENT_CLIENT_MESSAGE_IDS_KEY,
    );
    const list = Array.isArray(ids) ? ids : [];
    list.push(clientMessageId);
    while (list.length > CHAT_RECENT_CLIENT_MESSAGE_IDS_MAX) list.shift();
    this.ctx.storage.kv.put(CHAT_RECENT_CLIENT_MESSAGE_IDS_KEY, list);
  }

  // Lazily created so prototype-based test fakes work; holds enqueues that
  // have not yet resolved, keyed by clientMessageId. A retransmitted
  // duplicate awaits the original attempt's outcome instead of enqueueing
  // again or prematurely acking.
  private getPendingClientMessageEnqueues(): Map<
    string,
    Promise<InitialUserMessageResult>
  > {
    if (!this.pendingClientMessageEnqueues) {
      this.pendingClientMessageEnqueues = new Map();
    }
    return this.pendingClientMessageEnqueues;
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
  }

  private async applyMentionsForTurn(content: string): Promise<string> {
    if (!content) return content;
    if (!content.includes('@')) return content;
    const workspaceId = this.chatContext?.workspaceId;
    const orgId = this.chatContext?.orgId;
    if (!workspaceId || !orgId) return content;
    try {
      const orgStub = this.getOrgStub(orgId);
      const workspaceFs = new WorkspaceFilesystemClient(this.env, workspaceId);
      const [integrations, projects] = await Promise.all([
        Promise.resolve()
          .then(() => orgStub.getWorkspaceIntegrations(workspaceId))
          .catch((err) => {
            console.error('[ChatThreadDO] getIntegrations for mentions failed', err);
            return [];
          }),
        Promise.resolve()
          .then(() => workspaceFs.listProjects())
          .catch((err) => {
            console.error('[ChatThreadDO] listProjects for mentions failed', err);
            return [];
          }),
      ]);
      const result = applyMentionContext(content, { integrations, projects });
      return result.content;
    } catch (err) {
      console.error(
        '[ChatThreadDO] applyMentionsForTurn failed',
        err,
      );
      return content;
    }
  }

  private getOrgStub(orgId: string): DurableObjectStub<OrgDO> {
    if (!orgId) throw new Error("Missing org scope");
    return this.env.ORG.get(this.env.ORG.idFromName(orgId));
  }

  /**
   * Fire-and-forget prewarm of this org's DO-backed build container at
   * turn start. A user sending a message strongly predicts an imminent
   * build/deploy, so booting the container now hides its 10s+ cold start behind
   * the model's thinking/tool time. Debounced and best-effort: a warm failure
   * must never affect the turn.
   */
  private maybePrewarmProjectBuildSandboxes(): void {
    const context = this.chatContext;
    if (!context?.orgId || !context.workspaceId) return;
    if (!this.env.PROJECT_BUILD_SANDBOX) return;

    const now = Date.now();
    if (now - this.lastBuildSandboxPrewarmAtMs < BUILD_SANDBOX_PREWARM_DEBOUNCE_MS) {
      return;
    }
    this.lastBuildSandboxPrewarmAtMs = now;

    const { orgId, workspaceId } = context;
    this.ctx.waitUntil(
      prewarmWorkspaceBuildSandboxes(this.env, orgId, workspaceId).catch((err) => {
        console.warn("[ChatThreadDO] build sandbox prewarm failed", {
          workspaceId,
          error: err instanceof Error ? err.message : String(err),
        });
      }),
    );
  }

  private get channelTools(): ChannelTools {
    return new ChannelTools(this.env);
  }

  private get piModelMapping(): PiModelMapping {
    return new PiModelMapping();
  }

  private chatSendFailureStatus(
    status: "busy" | "error" | string,
    error: unknown,
  ): number {
    if (status === "busy") return 409;
    if (this.isChatBillingOrCreditError(error)) return 402;
    const message = error instanceof Error ? error.message : String(error ?? "");
    return this.piProviderErrorMetadata(message).status ?? 500;
  }

  private isChatBillingOrCreditError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? "");
    const lower = message.toLowerCase();
    return (
      lower.includes("credit") ||
      lower.includes("billing") ||
      lower.includes("subscription") ||
      lower.includes("payment") ||
      lower.includes("pay as you go") ||
      lower.includes("api key") ||
      lower.includes("usage limit") ||
      lower.includes("hosted model")
    );
  }

  private chatSendErrorPayload(
    error: unknown,
    options: {
      status?: "busy" | "error" | string;
      fallbackMessage: string;
    },
  ): Record<string, unknown> {
    const rawMessage =
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "";
    const message = rawMessage.trim() || options.fallbackMessage;
    const metadata = this.piProviderErrorMetadata(message);
    const status = this.chatSendFailureStatus(
      options.status ?? "error",
      message,
    );
    return {
      type: "error",
      error: message,
      status,
      ...(this.isChatBillingOrCreditError(message)
        ? { errorType: "billing" }
        : {}),
      ...(this.piCurrentBillingSource === "byok" || this.piCurrentBillingSource === "hosted"
        ? { billingSource: this.piCurrentBillingSource }
        : {}),
      ...(this.piCurrentUsageProvider ? { provider: this.piCurrentUsageProvider } : {}),
      ...metadata,
    };
  }

  private async handleClientUserMessage(
    data: ChatUserMessageInput,
  ): Promise<InitialUserMessageResult> {
    const startedAt = Date.now();
    const sendAttemptId = data.clientMessageId || crypto.randomUUID();

    const clientMessageId =
      typeof data.clientMessageId === "string" && data.clientMessageId
        ? data.clientMessageId
        : null;

    if (clientMessageId) {
      // Duplicate of a send whose enqueue already accepted a turn (the
      // browser retransmits when the acceptance ack was lost to a socket
      // drop): re-ack so the client clears its pending state, never enqueue
      // twice.
      if (this.hasRecentlyAcceptedClientMessage(clientMessageId)) {
        return { status: "accepted" };
      }

      // Duplicate of a send whose enqueue is still in flight (reconnect +
      // retransmit before the first attempt resolved). Do not ack yet and do
      // not enqueue again: relay the original attempt's real outcome to this
      // socket, so a failure reported to the old, dead socket still reaches
      // the client instead of being masked by a premature ack.
      const inFlight = this.getPendingClientMessageEnqueues().get(
        clientMessageId,
      );
      if (inFlight) {
        let outcome: InitialUserMessageResult;
        try {
          outcome = await inFlight;
        } catch (error) {
          return {
            status: "error",
            error: error instanceof Error ? error.message : "Failed to send message to sandbox",
          };
        }
        if (outcome.status === "accepted") {
          return { status: "accepted" };
        }
        return outcome;
      }

    }

    let result: InitialUserMessageResult;
    const enqueue = this.enqueueRunnerUserMessage(data, {
      sendAttemptId,
      startedAt,
    });
    if (clientMessageId) {
      this.getPendingClientMessageEnqueues().set(clientMessageId, enqueue);
    }
    try {
      result = await enqueue;
    } catch (error) {
      this.updateActiveAutomationRun({
        status: "error",
        message: error instanceof Error ? error.message : "Failed to send message",
        clear: true,
      });
      this.finishTurn();
      this.setActiveTurnUserId(null);
      console.error("[ChatThreadDO] failed to enqueue browser user message", error);
      return {
        status: "error",
        error: error instanceof Error ? error.message : "Failed to send message to sandbox",
      };
    } finally {
      if (clientMessageId) {
        this.getPendingClientMessageEnqueues().delete(clientMessageId);
      }
    }

    if (result.status !== "accepted") {
      return result;
    }

    // Only now is the id a safe dedupe marker: the message has actually
    // reached an accepted turn, so swallowing retransmits cannot lose it.
    if (clientMessageId) {
      this.recordAcceptedClientMessageId(clientMessageId);
    }

    return result;
  }

  private async enqueueRunnerUserMessage(
    data: ChatUserMessageInput,
    options: {
      sendAttemptId?: string;
      startedAt?: number;
      messageSource?: string | null;
      // Commit the user's message to the canonical transcript before returning
      // (new-turn only). Set by the initial new-chat send so the action can await
      // acceptance and the thread page then loads the message normally — no
      // optimistic client placeholder. Normal sends leave this unset and keep the
      // turn-end commit so their optimistic-echo reconciliation is unchanged.
      persistUserMessageImmediately?: boolean;
    } = {},
  ): Promise<InitialUserMessageResult> {
    const startedAt = options.startedAt ?? Date.now();
    const sampleKey = options.sendAttemptId;
    const context = this.chatContext;
    if (!context) {
      return { status: "error", error: "Missing chat context for thread" };
    }

    const rawContent =
      typeof data.content === "string" ? data.content.trim() : "";
    if (!rawContent) {
      return { status: "error", error: "Empty message" };
    }

    const banCheckStartedAt = Date.now();
    const orgBan = await isOrgBanned(this.env.APP_KV, {
      orgId: context.orgId,
    });
    if (orgBan) {
      return { status: "error", error: "Organization is blocked" };
    }

    // A user prompt strongly predicts a build/deploy this turn; start the
    // build container's cold boot now so it overlaps the model's work. Fired
    // before ensurePiSessionReady for maximum overlap; debounced + best-effort.
    this.maybePrewarmProjectBuildSandboxes();

    const runnerConnectStartedAt = Date.now();
    try {
      await this.ensurePiSessionReady();
    } catch (error) {
      throw error;
    }

    const messagePrepareStartedAt = Date.now();
    let attributedContent: string;
    try {
      const safeContent = injectFileSafetyMessage(rawContent);
      const mentionAugmented =
        await this.applyMentionsForTurn(safeContent);
      attributedContent = formatAttributedUserMessage(mentionAugmented, {
        userName: context.userName,
        userEmail: context.userEmail,
        messageSource: options.messageSource ?? "web",
      });
    } catch (error) {
      throw error;
    }
    if (!attributedContent) {
      return { status: "error", error: "Empty message" };
    }

    // A new turn (the user is prompting, not steering an in-flight run) is given a
    // single canonical timestamp shared by the message we persist below and the
    // one sendRunnerCommand prompts Pi with, so both carry the same
    // piCoreMessageKey and the turn-end commit dedups instead of double-storing.
    const startsNewTurn = !this.piSession?.state.isStreaming;
    const turnTimestamp = Date.now();

    let sent = false;
    try {
      this.setActiveTurnUserId(context.userId);
      // Turn-start bookkeeping runs from agent_start once the run begins; the
      // spinner turns on via the derived sync after the fiber row is created (below).
      this.publishRunningUserMessageActivity(rawContent);
      this.ctx.waitUntil(
        this.updateThreadMetadataForUserMessage(
          attributedContent,
          options.messageSource ?? "web",
        ).catch((err) => {
          console.error(
            '[ChatThreadDO] failed to update thread metadata after browser user message',
            err,
          );
        }),
      );

      sent = this.sendRunnerCommand({
        ...data,
        type: "message",
        content: attributedContent,
        threadId: context.threadId,
        userId: context.userId ?? undefined,
        timestamp: turnTimestamp,
      });
    } catch (error) {
      this.finishTurn();
      this.setActiveTurnUserId(null);
      throw error;
    }
    if (!sent) {
      this.updateActiveAutomationRun({
        status: "error",
        message: "Failed to send message",
        clear: true,
      });
      this.finishTurn();
      this.setActiveTurnUserId(null);
      return { status: "error", error: "Failed to send message" };
    }

    // Persist the user's message to the canonical transcript only after the send
    // is accepted (the fiber row now exists), but before we return "accepted",
    // so a reader that awaits this ack and immediately loads the thread sees it.
    // Deferring until acceptance means a failed/interrupted send never leaves an
    // orphaned first message with no turn behind it — and a retry that re-runs
    // this RPC won't double-append, because the interrupted attempt persisted
    // nothing. This is what lets the new-chat page render the thread normally,
    // with no optimistic client placeholder and no special new-thread loader
    // path. The matching turn-end commit skips it via piCoreMessageKey.
    if (startsNewTurn && options.persistUserMessageImmediately) {
      await this.appendPiCoreMessagesIfMissing([
        {
          role: "user",
          content: attributedContent,
          timestamp: turnTimestamp,
        } as unknown as AgentMessage,
      ]);
    }

    // sendRunnerCommand created the durable fiber row synchronously, so the derived
    // streaming state is now true — broadcast it for instant spinner feedback.
    this.syncAgentState();

    // A new turn's user message is now in the canonical transcript (above); the
    // server builds only the assistant/tool overlay live (see liveMessages).
    // Steered messages land in the transcript when Pi emits them and on the next
    // reload.
    return { status: "accepted" };
  }

  private getPreviewTabId(target: PreviewTarget): string {
    if (target.kind === "app") {
      return `app:${target.scriptName}`;
    }
    if (target.kind === "runtime_artifact") {
      return `artifact:${target.artifact.id}`;
    }
    return `file:${target.workspaceId}:${target.source}:${target.project ?? ""}:${target.path}`;
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

    if (target.kind === "runtime_artifact") {
      const artifacts = normalizeRuntimeCallArtifacts([target.artifact]);
      const artifact = artifacts[0];
      return artifact ? { kind: "runtime_artifact", artifact } : null;
    }

    if (target.kind === "file") {
      const source = target.source;
      if (
        source !== "workspace" &&
        source !== "upload" &&
        source !== "output" &&
        source !== "vm"
      ) {
        return null;
      }

      const workspaceId =
        typeof target.workspaceId === "string" ? target.workspaceId.trim() : "";
      const path = typeof target.path === "string" ? target.path.trim() : "";

      if (!workspaceId || !path || path.includes("..")) {
        return null;
      }
      const project =
        source === "vm" && typeof target.project === "string"
          ? target.project.trim()
          : undefined;
      if (source === "vm" && !project) {
        return null;
      }

      return {
        kind: "file",
        source,
        workspaceId,
        path,
        project,
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

  private resetRunningActivityState(): void {
    this.runningActivityLastText = null;
    this.runningActivityLastSentAt = 0;
    // Any debounced running-activity update queued for the previous activity
    // state is now stale: the turn is starting, ending, or the streaming state
    // is flipping. Drop it so it cannot race a terminal transition and resurrect
    // a "streaming" row. The authoritative streaming state is delivered
    // un-debounced by finishTurn / completion recording.
    this.discardPendingStreamingActivity();
  }

  private getWorkspaceStatusStub(workspaceId: string): DurableObjectStub<WorkspaceDO> {
    const normalizedWorkspaceId = workspaceId.trim();
    this.workspaceStatusStubs ??= new Map<string, DurableObjectStub<WorkspaceDO>>();
    let stub = this.workspaceStatusStubs.get(normalizedWorkspaceId);
    if (!stub) {
      stub = this.env.WORKSPACE.get(
        this.env.WORKSPACE.idFromName(normalizedWorkspaceId),
      ) as DurableObjectStub<WorkspaceDO>;
      this.workspaceStatusStubs.set(normalizedWorkspaceId, stub);
    }
    return stub;
  }

  private recordWorkspaceThreadStreaming(
    workspaceId: string | null | undefined,
    threadId: string | null | undefined,
    isStreaming: boolean,
    options?: WorkspaceThreadStreamingOptions,
  ): Promise<void> {
    const normalizedWorkspaceId = workspaceId?.trim();
    const normalizedThreadId = threadId?.trim();
    if (!normalizedWorkspaceId || !normalizedThreadId) {
      return Promise.resolve();
    }
    return this.retryChatDurableObjectRpc(
      "WorkspaceDO.recordThreadStreaming",
      () =>
        this.getWorkspaceStatusStub(normalizedWorkspaceId).recordThreadStreaming(
          normalizedThreadId,
          isStreaming,
          options,
        ),
      { attempts: 4, initialDelayMs: 150 },
    ).catch((error) => {
      console.error("[ChatThreadDO] failed to record workspace thread status", {
        workspaceId: normalizedWorkspaceId,
        threadId: normalizedThreadId,
        isStreaming,
        error,
      });
    });
  }

  /**
   * Coalesce high-frequency "still streaming" running-activity updates into a
   * single trailing-debounced RPC to the single WorkspaceDO instance.
   *
   * Each call records the LATEST activity payload and (re)arms a trailing timer.
   * A burst of N updates within {@link WORKSPACE_STREAMING_ACTIVITY_DEBOUNCE_MS}
   * collapses into one RPC carrying the most recent state.
   *
   * This is only used for `isStreaming = true` activity updates. Terminal
   * streaming transitions (start/stop) and completion-metadata updates bypass
   * the debounce via {@link flushPendingStreamingActivity} +
   * {@link recordWorkspaceThreadStreaming}, so the workspace UI is never stuck
   * showing "streaming".
   *
   * Eviction note: if the DO is evicted with a pending debounced update, that
   * single activity-text update is lost. This is acceptable here because the
   * value is a transient, best-effort "what is the agent doing right now" label,
   * not terminal state. The very next activity update re-sends fresh text, and
   * the turn-end terminal transition (always delivered, un-debounced) carries
   * the authoritative streaming=false. The WorkspaceDO row also self-prunes
   * after its TTL, so no permanently-stale "streaming" state can result from a
   * dropped activity update.
   */
  private queueStreamingActivityUpdate(
    workspaceId: string,
    threadId: string,
    activityText: string,
    activityAt: number,
  ): void {
    const normalizedWorkspaceId = workspaceId.trim();
    const normalizedThreadId = threadId.trim();
    if (!normalizedWorkspaceId || !normalizedThreadId) return;

    const existing = this.pendingStreamingActivity;
    // If the pending entry targets a different workspace/thread (extremely rare
    // for a per-thread DO, but the chat context can be re-pointed), flush the
    // stale entry first so its latest state is not dropped silently.
    if (
      existing &&
      (existing.workspaceId !== normalizedWorkspaceId ||
        existing.threadId !== normalizedThreadId)
    ) {
      this.flushPendingStreamingActivity();
    }

    const prior = this.pendingStreamingActivity;
    this.pendingStreamingActivity = {
      workspaceId: normalizedWorkspaceId,
      threadId: normalizedThreadId,
      activityText,
      activityAt,
      coalescedCount: (prior?.coalescedCount ?? 0) + 1,
    };

    if (this.streamingActivityFlushTimer === null) {
      this.streamingActivityFlushTimer = setTimeout(() => {
        this.streamingActivityFlushTimer = null;
        this.flushPendingStreamingActivity();
      }, WORKSPACE_STREAMING_ACTIVITY_DEBOUNCE_MS);
    }
  }

  /**
   * Send any pending debounced running-activity update immediately (fire and
   * forget) and clear the trailing timer. Safe to call when nothing is pending.
   * Called by the trailing timer, and synchronously by terminal streaming
   * transitions so the final state always wins over an in-flight activity blip.
   */
  private flushPendingStreamingActivity(): void {
    if (this.streamingActivityFlushTimer !== null) {
      clearTimeout(this.streamingActivityFlushTimer);
      this.streamingActivityFlushTimer = null;
    }
    const pending = this.pendingStreamingActivity;
    if (!pending) return;
    this.pendingStreamingActivity = null;

    if (pending.coalescedCount > 1) {
      this.recordChatThreadObservabilityEvent("workspace_streaming_activity_coalesced", {
        operation: "record_thread_streaming",
        status: "flushed",
        count: pending.coalescedCount,
        sampleKey: pending.threadId,
      });
    }

    this.ctx.waitUntil(
      this.recordWorkspaceThreadStreaming(pending.workspaceId, pending.threadId, true, {
        activityText: pending.activityText,
        activityAt: pending.activityAt,
      }).catch((error) => {
        console.error("[ChatThreadDO] failed to flush running activity", error);
      }),
    );
  }

  /**
   * Drop any pending debounced running-activity update without sending it.
   * Used when a terminal streaming transition (streaming -> not streaming)
   * supersedes the activity update: the activity payload only sets
   * `isStreaming = true`, so flushing it after we have decided streaming has
   * ended could resurrect a stale "streaming" row. The caller is responsible
   * for delivering the authoritative terminal state.
   */
  private discardPendingStreamingActivity(): void {
    if (this.streamingActivityFlushTimer !== null) {
      clearTimeout(this.streamingActivityFlushTimer);
      this.streamingActivityFlushTimer = null;
    }
    this.pendingStreamingActivity = null;
  }

  private recordChatThreadObservabilityEvent(
    event: string,
    details: {
      operation?: string;
      status?: string;
      severity?: "debug" | "info" | "warn" | "error";
      count?: number;
      size?: number;
      durationMs?: number;
      error?: unknown;
      statusCode?: number | null;
      provider?: string | null;
      model?: string | null;
      sampleKey?: string | null;
      insertedCount?: number;
      updatedCount?: number;
    } = {},
  ): void {
    const context = this.chatContext;
    const count =
      typeof details.insertedCount === "number" || typeof details.updatedCount === "number"
        ? (details.insertedCount ?? 0) + (details.updatedCount ?? 0)
        : details.count;
    if (details.error) {
      recordErrorEvent(this.env, {
        event,
        component: "chat_thread_do",
        operation: details.operation,
        status: details.status ?? "exception",
        threadId: context?.threadId,
        workspaceId: context?.workspaceId,
        orgId: context?.orgId,
        userId: context?.userId,
        durationMs: details.durationMs,
        statusCode: details.statusCode,
        count,
        size: details.size,
        provider: details.provider,
        model: details.model,
        sampleIndex: details.sampleKey,
        error: details.error,
      });
      return;
    }
    recordObservabilityEvent(this.env, {
      event,
      severity: details.severity ?? "info",
      component: "chat_thread_do",
      operation: details.operation,
      status: details.status ?? "ok",
      threadId: context?.threadId,
      workspaceId: context?.workspaceId,
      orgId: context?.orgId,
      userId: context?.userId,
      provider: details.provider,
      model: details.model,
      durationMs: details.durationMs,
      count,
      size: details.size,
      sampleIndex: details.sampleKey,
    });
  }

  private normalizeRunningActivityText(text: string | null | undefined): string | null {
    const normalized = text?.replace(/\s+/g, " ").trim() ?? "";
    if (!normalized) return null;
    return normalized.length > 240 ? `${normalized.slice(0, 237)}...` : normalized;
  }

  private shouldPublishRunningActivity(
    activityText: string,
    now: number,
    immediate: boolean,
  ): boolean {
    if (this.runningActivityLastText === activityText) return false;
    if (immediate || this.runningActivityLastSentAt === 0) return true;
    if (now - this.runningActivityLastSentAt >= 900) return true;
    return /[.!?)]$/.test(activityText);
  }

  private publishRunningActivity(
    text: string | null | undefined,
    options: { immediate?: boolean; activityAt?: number } = {},
  ): void {
    const activityText = this.normalizeRunningActivityText(text);
    if (!activityText) return;
    const context = this.chatContext;
    if (!context?.workspaceId || !context.threadId) return;
    const now =
      typeof options.activityAt === "number" && Number.isFinite(options.activityAt)
        ? Math.floor(options.activityAt)
        : Date.now();
    if (!this.shouldPublishRunningActivity(activityText, now, options.immediate === true)) {
      return;
    }
    this.runningActivityLastText = activityText;
    this.runningActivityLastSentAt = now;
    // Coalesce bursts of running-activity updates into a single trailing
    // debounced RPC carrying the latest state, instead of fanning in one RPC per
    // update to the single WorkspaceDO instance. Terminal streaming transitions
    // (see finishTurn / recordThreadAssistantCompletion) flush or discard this
    // pending update so the workspace UI never sticks on "streaming".
    this.queueStreamingActivityUpdate(
      context.workspaceId,
      context.threadId,
      activityText,
      now,
    );
  }

  private publishRunningUserMessageActivity(content: string | null | undefined): void {
    const preview = normalizeThreadPreviewUserMessage(content ?? "");
    this.publishRunningActivity(preview, { immediate: true });
  }

  private publishPiToolActivity(
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>,
    status: "running" | "complete" | "error",
    result?: unknown,
  ): void {
    const tool: ToolUseBlock = {
      type: "tool_use",
      id: toolCallId,
      name: toolName,
      input: args,
    };
    const resultBlock: ToolResultBlock | undefined =
      status === "running"
        ? undefined
        : {
            type: "tool_result",
            tool_use_id: toolCallId,
            content: this.piToolResultText(result),
          };
    this.publishRunningActivity(
      getToolSummary(tool, resultBlock, status, status === "running"),
      { immediate: true },
    );
  }

  // Fire-and-forget the workspace thread-list "streaming" indicator. Does NOT drive
  // the client spinner (that is derived; see {@link isThreadStreaming}).
  private pushWorkspaceStreaming(value: boolean): void {
    const context = this.chatContext;
    if (!context?.workspaceId || !context.threadId) return;
    this.ctx.waitUntil(
      this.recordWorkspaceThreadStreaming(context.workspaceId, context.threadId, value).catch(
        (error) => console.error("[ChatThreadDO] failed to record workspace thread status", error),
      ),
    );
  }

  /**
   * Turn-start bookkeeping. Resets the completion-recording guard, clears stale
   * todos, and broadcasts state. Invoked once per run from the agent_start event.
   */
  private markTurnStarted(): void {
    this.assistantCompletionRecordedAt = null;
    this.assistantCompletionSummaryRequestedAt = null;
    this.resetRunningActivityState();
    // Clear persisted todos so they don't go stale across reconnects.
    if (this.currentTodos.length > 0) {
      this.currentTodos = [];
      this.ctx.storage.kv.delete(CHAT_TODOS_KEY);
    }
    this.syncAgentState();
    this.pushWorkspaceStreaming(true);
  }

  /**
   * Turn-completion bookkeeping. Records the assistant completion / summary /
   * automation result exactly once per turn — idempotency rides on
   * {@link assistantCompletionRecordedAt}, NOT on any stored streaming flag — clears
   * the live overlay, and broadcasts the now-idle derived state. Safe to call on any
   * terminal path (agent_end, resume completion, or error/abort cleanup).
   */
  private finishTurn(
    options: { markUnread?: boolean; completedAt?: number; summarySource?: string | null } = {},
  ): void {
    const shouldRecordCompletion =
      options.markUnread === true && this.assistantCompletionRecordedAt === null;
    const shouldRecordCompletionSummary =
      options.markUnread === true &&
      !shouldRecordCompletion &&
      this.assistantCompletionRecordedAt !== null &&
      this.assistantCompletionSummaryRequestedAt !== this.assistantCompletionRecordedAt &&
      typeof options.summarySource === "string" &&
      options.summarySource.trim().length > 0;
    // A turn that stops after asking a browser question is still awaiting user
    // input; keep the automation run active so the eventual answer can finish it.
    if (
      shouldRecordCompletion &&
      this.activeAutomationRun &&
      this.browserPrompts.pendingQuestionCount === 0
    ) {
      this.updateActiveAutomationRun({
        status: "success",
        completedAt:
          typeof options.completedAt === "number" &&
          Number.isFinite(options.completedAt)
            ? options.completedAt
            : Date.now(),
        clear: true,
      });
    }
    this.resetRunningActivityState();
    // Turn over: ship the turn's messages as the authoritative snapshot on the
    // clearing frame. The client commits finalMessages to history directly, so
    // correctness never depends on it having received every throttled delta.
    const finalMessages = this.liveMessages.map((message) =>
      message.isStreaming ? { ...message, isStreaming: false } : message,
    );
    this.liveMessages = [];
    this.liveStreamingMessageId = null;
    this.broadcastLiveOverlay({ finalMessages });
    this.syncAgentState();
    const context = this.chatContext;
    if (context?.workspaceId && context.threadId) {
      if (shouldRecordCompletion) {
        const completedAt =
          typeof options.completedAt === "number" &&
          Number.isFinite(options.completedAt)
            ? options.completedAt
            : Date.now();
        this.assistantCompletionRecordedAt = completedAt;
        this.ctx.waitUntil(
          this.recordThreadAssistantCompletion(
            context,
            completedAt,
            options.summarySource ?? null,
          ).catch((error) => {
            console.error("[ChatThreadDO] failed to record assistant completion", error);
          }),
        );
      } else if (shouldRecordCompletionSummary) {
        const completedAt = this.assistantCompletionRecordedAt;
        if (completedAt === null) return;
        this.assistantCompletionSummaryRequestedAt = completedAt;
        this.ctx.waitUntil(
          this.generateAndPersistThreadAssistantCompletionSummary(
            context,
            completedAt,
            options.summarySource!,
          ).catch((error) => {
            console.error("[ChatThreadDO] failed to record assistant completion summary", error);
          }),
        );
      } else {
        // Not a completion (error/abort teardown): just clear the workspace
        // indicator. The completion branches clear it via recordThreadAssistantCompletion.
        this.pushWorkspaceStreaming(false);
      }
    }
  }

  private async recordThreadAssistantCompletion(
    context: ChatContextState,
    completedAt: number,
    summarySource: string | null,
  ): Promise<void> {
    const hasSummarySource = Boolean(summarySource?.trim());
    const initialSummaryStatus: ThreadCompletionSummaryStatus = hasSummarySource
      ? "pending"
      : "failed";
    const persistenceResult = await this.persistThreadAssistantCompletion(
      context,
      completedAt,
      null,
      initialSummaryStatus,
    );
    if (persistenceResult.status === "stale") {
      return;
    }
    if (persistenceResult.status === "failed") {
      await this.recordWorkspaceThreadStreaming(
        context.workspaceId,
        context.threadId,
        false,
        { completedAt, summaryStatus: "failed" },
      );
      return;
    }
    const storedCompletedAt = persistenceResult.completedAt;

    await this.recordWorkspaceThreadStreaming(
      context.workspaceId,
      context.threadId,
      false,
      { completedAt: storedCompletedAt, summaryStatus: initialSummaryStatus },
    );

    if (hasSummarySource) {
      this.assistantCompletionRecordedAt = storedCompletedAt;
      this.assistantCompletionSummaryRequestedAt = storedCompletedAt;
      await this.generateAndPersistThreadAssistantCompletionSummary(
        context,
        storedCompletedAt,
        summarySource!,
      );
    }
  }

  private async persistThreadAssistantCompletion(
    context: ChatContextState,
    completedAt: number,
    summary: string | null,
    summaryStatus: ThreadCompletionSummaryStatus | null,
  ): Promise<AssistantCompletionPersistenceResult> {
    try {
      const orgId = this.env.ORG.idFromName(context.orgId);
      const getOrgStub = () => this.env.ORG.get(orgId) as unknown as {
        recordThreadAssistantCompletion(
          id: string,
          input: {
            completedAt: number;
            summary: string | null;
            summaryStatus?: ThreadCompletionSummaryStatus | null;
          },
        ): Promise<number | false> | number | false;
      };
      const storedCompletedAt = await this.retryChatDurableObjectRpc(
        "OrgDO.recordThreadAssistantCompletion",
        () =>
          Promise.resolve(
            getOrgStub().recordThreadAssistantCompletion(context.threadId, {
              completedAt,
              summary,
              summaryStatus,
            }),
          ),
        { attempts: 4, initialDelayMs: 150 },
      );
      return typeof storedCompletedAt === "number" &&
        Number.isFinite(storedCompletedAt)
        ? { status: "stored", completedAt: storedCompletedAt }
        : { status: "stale" };
    } catch (error) {
      console.error("[ChatThreadDO] failed to persist assistant completion", error);
      return { status: "failed" };
    }
  }

  private async recordCompletionSummaryStatus(
    context: ChatContextState,
    completedAt: number,
    summaryStatus: ThreadCompletionSummaryStatus,
    summary?: string,
  ): Promise<void> {
    const persistenceResult = await this.persistThreadAssistantCompletion(
      context,
      completedAt,
      summary ?? null,
      summaryStatus,
    );
    if (persistenceResult.status === "stale") return;
    const statusCompletedAt =
      persistenceResult.status === "stored"
        ? persistenceResult.completedAt
        : completedAt;
    await this.recordWorkspaceThreadStreaming(
      context.workspaceId,
      context.threadId,
      false,
      {
        completedAt: statusCompletedAt,
        summaryStatus:
          persistenceResult.status === "failed" ? "failed" : summaryStatus,
        ...(persistenceResult.status === "stored" && summary
          ? { summary }
          : {}),
      },
    );
  }

  private async generateAndPersistThreadAssistantCompletionSummary(
    context: ChatContextState,
    completedAt: number,
    sourceText: string,
  ): Promise<void> {
    try {
      const summary = await generateThreadCompletionSummaryWithOpenAI(
        this.env.AI,
        sourceText,
        {
          orgId: context.orgId,
          workspaceId: context.workspaceId,
          threadId: context.threadId,
        },
        { gatewayName: this.env.CF_GATEWAY_NAME },
      );
      if (!summary) {
        await this.recordCompletionSummaryStatus(context, completedAt, "failed");
        return;
      }
      await this.recordCompletionSummaryStatus(
        context,
        completedAt,
        "ready",
        summary,
      );
    } catch (error) {
      console.error("[ChatThreadDO] failed to generate assistant completion summary", error);
      await this.recordCompletionSummaryStatus(context, completedAt, "failed");
    }
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

  async startInitialUserMessage(
    body: InitialUserMessageRequest,
  ): Promise<InitialUserMessageResult> {
    const startedAt = Date.now();
    const contextError = this.updateExternalChatContext(body);
    if (contextError) {
      return { status: "error", error: contextError };
    }

    const message =
      typeof body.message === "string" ? body.message.trim() : "";
    if (!message) {
      return { status: "error", error: "Missing message" };
    }

    const automationRun = this.normalizeActiveAutomationRun(body.automationRun);
    if (automationRun) {
      this.reconcileInactiveAutomationRun(
        "Automation run did not finish before the thread restarted",
      );
      if (
        this.activeAutomationRun ||
        this.isThreadStreaming() ||
        this.browserPrompts.pendingQuestionCount > 0
      ) {
        return {
          status: "busy",
          error: "Thread is busy with another run",
        };
      }
      this.setActiveAutomationRun(automationRun);
    }

    try {
      const result = await this.enqueueRunnerUserMessage({
        content: message,
        clientMessageId:
          typeof body.clientMessageId === "string" &&
          body.clientMessageId.trim()
            ? body.clientMessageId.trim()
            : undefined,
      }, {
        messageSource:
          typeof body.messageSource === "string" && body.messageSource.trim()
            ? body.messageSource.trim()
            : "web",
        persistUserMessageImmediately: true,
      });
      if (automationRun && result.status !== "accepted") {
        this.setActiveAutomationRun(null);
      }
      if (result.status !== "accepted") {
        this.pushChatEvent(
          this.chatSendErrorPayload(result.error, {
            status: result.status,
            fallbackMessage: "Failed to start initial message",
          }),
        );
      }
      return result;
    } catch (error) {
      if (automationRun) {
        this.setActiveAutomationRun(null);
      }
      this.pushChatEvent(
        this.chatSendErrorPayload(error, {
          fallbackMessage: "Failed to start initial message",
        }),
      );
      return {
        status: "error",
        error:
          error instanceof Error
            ? error.message
            : "Failed to start initial message",
      };
    }
  }

  async runAgentEvalSession(
    body: AgentEvalSessionRequest,
  ): Promise<AgentEvalSessionResult> {
    const startedAt = Date.now();
    this.agentEvalEventCollector = [];
    const contextError = this.updateExternalChatContext(body);
    if (contextError) {
      return await this.agentEvalResult("error", {
        error: contextError,
      });
    }

    const context = this.chatContext;
    if (!context) {
      return await this.agentEvalResult("error", {
        error: "Missing chat context for eval",
      });
    }

    const rawContent =
      typeof body.message === "string" ? body.message.trim() : "";
    if (!rawContent) {
      return await this.agentEvalResult("error", {
        error: "Missing message",
      });
    }

    if (this.isThreadStreaming()) {
      return await this.agentEvalResult("busy", {
        error: "Thread is busy with another run",
      });
    }

    try {
      const orgBan = await isOrgBanned(this.env.APP_KV, {
        orgId: context.orgId,
      });
      if (orgBan) {
        return await this.agentEvalResult("error", {
          error: "Organization is blocked",
        });
      }

      await this.ensurePiSessionReady();
      if (!this.piSession) {
        return await this.agentEvalResult("error", {
          error: "Pi session was not available for eval",
        });
      }

      const safeContent = injectFileSafetyMessage(rawContent);
      const mentionAugmented =
        await this.applyMentionsForTurn(safeContent);
      const attributedContent = formatAttributedUserMessage(mentionAugmented, {
        userName: context.userName,
        userEmail: context.userEmail,
        messageSource:
          typeof body.messageSource === "string" && body.messageSource.trim()
            ? body.messageSource.trim()
            : "eval",
      });
      if (!attributedContent.trim()) {
        return await this.agentEvalResult("error", {
          error: "Empty message",
        });
      }

      this.setActiveTurnUserId(context.userId);
      // Turn-start bookkeeping runs from the agent_start event the prompt emits.
      this.publishRunningUserMessageActivity(rawContent);
      await this.updateThreadMetadataForUserMessage(
        attributedContent,
        body.messageSource ?? "eval",
      ).catch((error) => {
        console.error("[ChatThreadDO] failed to update eval thread metadata", error);
      });

      const userMessage: AgentMessage = {
        role: "user",
        content: attributedContent,
        timestamp: Date.now(),
      };
      await this.refreshPiSessionModel();
      await this.withAgentEvalTimeout(
        this.withPiTurnInactivityTimeout(async () => {
          if (!this.piSession) {
            throw new Error("Pi session was not available for eval prompt");
          }
          await this.piSession.prompt(userMessage);
        }),
        body.timeoutMs,
      );
      await this.piEventHandlerChain;

      const events = this.agentEvalEventCollector ?? [];
      const result = this.latestAgentEvalResult(events);
      return await this.agentEvalResult("completed", {
        result,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[ChatThreadDO] agent eval session failed", error);
      try {
        this.piSession?.abort();
      } catch {
        // Best effort cleanup; the error below is the actionable eval failure.
      }
      this.pushChatEvent(this.piProviderErrorEvent(message));
      this.finishTurn();
      this.setActiveTurnUserId(null);
      return await this.agentEvalResult("error", {
        error: message,
      });
    }
  }

  private async withAgentEvalTimeout<T>(
    promise: Promise<T>,
    timeoutMs: unknown,
  ): Promise<T> {
    const normalizedTimeoutMs =
      typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
        ? Math.max(1_000, Math.floor(timeoutMs))
        : 120_000;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(new Error(`Agent eval timed out after ${normalizedTimeoutMs}ms`));
          }, normalizedTimeoutMs);
        }),
      ]);
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
  }

  private latestAgentEvalResult(
    events: Array<Record<string, unknown>>,
  ): string | undefined {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.type !== "result") continue;
      const result = event.result;
      return typeof result === "string" ? result : undefined;
    }
    return undefined;
  }

  private async agentEvalResult(
    status: AgentEvalSessionResult["status"],
    options: { error?: string; result?: string } = {},
  ): Promise<AgentEvalSessionResult> {
    const threadId = this.chatContext?.threadId ?? "";
    const events = this.agentEvalEventCollector ? [...this.agentEvalEventCollector] : [];
    this.agentEvalEventCollector = null;
    return {
      status,
      ...options,
      events,
      messages: await this.getPiCoreParsedMessages(threadId),
      deployedApps: await this.collectAgentEvalDeployedApps(),
    };
  }

  private async collectAgentEvalDeployedApps(): Promise<
    AgentEvalDeployedApp[] | undefined
  > {
    const workspaceId = this.chatContext?.workspaceId ?? "";
    const orgId = this.chatContext?.orgId ?? "";
    if (!workspaceId || !orgId) return undefined;
    const orgStub = this.env.ORG.get(this.env.ORG.idFromName(orgId));
    const scripts = await orgStub.listWorkerScriptsByWorkspace(workspaceId);
    if (!scripts.length) return undefined;
    // Build the app URL the same way the tools' getAppUrl does (the eval env pins the
    // testing-grounds host via WORKER_BASE_URL/LOCAL_APP_VANITY_DOMAIN), so the result
    // carries the authoritative *.evals.camelai.app URL with no eval-specific code.
    let appHostname = "camelai.dev";
    const workerBaseUrl = (this.env as { WORKER_BASE_URL?: string }).WORKER_BASE_URL;
    if (workerBaseUrl) {
      try {
        appHostname = new URL(workerBaseUrl).host;
      } catch {
        appHostname = "camelai.dev";
      }
    }
    const orgSlug = (await orgStub.getSlug()) ?? undefined;
    return scripts
      .sort((a, b) => b.updated_at - a.updated_at)
      .map((script) => ({
        name: script.script_name,
        url: getPreferredAppUrl(script, {
          hostname: {
            hostname: appHostname,
            vanityDomain: this.env.LOCAL_APP_VANITY_DOMAIN,
            iframeDomain: this.env.LOCAL_APP_IFRAME_DOMAIN,
          },
          orgSlug,
          orgCustomDomain: null,
        }),
        isPublic: script.is_public,
      }));
  }

  private hasAvailableBrowserUser(): boolean {
    return this.getChatSockets().length > 0;
  }

  private updateExternalChatContext(payload: {
    threadId?: string;
    workspaceId?: string;
    orgId?: string;
    userId?: string | null;
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
      userId:
        typeof payload.userId === "string" && payload.userId.trim()
          ? payload.userId.trim()
          : this.chatContext?.userId ?? null,
      userName:
        typeof payload.userName === "string" && payload.userName.trim()
          ? payload.userName.trim()
          : this.chatContext?.userName ?? null,
      userEmail:
        typeof payload.userEmail === "string" && payload.userEmail.trim()
          ? payload.userEmail.trim()
          : this.chatContext?.userEmail ?? null,
    };
    this.ctx.storage.kv.put(CHAT_CONTEXT_KEY, this.chatContext);
    return null;
  }

  private async autoAnswerPendingQuestionAsUnavailable(
    questionId: string,
    unavailableMessage: string,
  ): Promise<boolean> {
    const sent = this.sendRunnerCommand({
      type: "question_response",
      questionId,
      answers: {
        unavailable_reason: unavailableMessage,
      },
    });
    if (sent) {
      this.browserPrompts.deletePendingQuestion(questionId);
      this.syncAgentState();
    }
    return sent;
  }

  private async autoAnswerAllPendingQuestionsAsUnavailable(
    unavailableMessage: string,
  ): Promise<void> {
    const questionIds = this.browserPrompts.pendingQuestionIds();
    for (const questionId of questionIds) {
      try {
        await this.autoAnswerPendingQuestionAsUnavailable(
          questionId,
          unavailableMessage,
        );
      } catch (err) {
        console.error(
          "[ChatThreadDO] failed to auto-answer pending ask_user_question",
          {
            questionId,
            error: err instanceof Error ? err.message : String(err),
          },
        );
      }
    }
  }

  private async updateThreadMetadataForUserMessage(
    messageContent: string,
    messageSource?: string | null,
  ): Promise<void> {
    const context = this.chatContext;
    if (!context?.orgId || !context?.threadId || !context.workspaceId) return;

    const orgStub = this.env.ORG.get(this.env.ORG.idFromName(context.orgId));
    const thread = await orgStub.getThread(context.threadId);
    if (!thread) return;

    await orgStub.recordThreadUserMessage(
      context.threadId,
      messageContent,
      messageSource,
    );
    if (context.userId) {
      const userStub = this.env.USER.get(this.env.USER.idFromName(context.userId));
      await userStub.touchGroupForThread(context.threadId);
    }

    const messageSources = getThreadUserMessageSources(messageContent);
    if (!messageSources) {
      return;
    }
    const { metadataSourceMessage, titleSourceMessage } = messageSources;

    const hasFirstUserMessage = typeof thread.first_user_message === 'string'
      && thread.first_user_message.trim().length > 0;
    if (!hasFirstUserMessage) {
      await orgStub.setThreadFirstUserMessage(context.threadId, metadataSourceMessage);
    }

    if (!isPlaceholderThreadTitle(thread.title) || this.titleGenerationInFlight) {
      return;
    }

    this.titleGenerationInFlight = true;
    await this.generateThreadTitleFromMessage(context.threadId, titleSourceMessage);
  }

  private errorLogFields(error: unknown): {
    errorName: string;
    errorMessage: string;
  } {
    if (error instanceof Error) {
      return {
        errorName: error.name,
        errorMessage: error.message,
      };
    }
    return {
      errorName: "UnknownError",
      errorMessage: String(error),
    };
  }

  private async generateClaimedChatGroupAvatar(
    threadId: string,
    claim: { id: string; name: string; avatar: ChatGroupAvatar },
    userStub: {
      setGeneratedChatGroupEmoji: (groupId: string, emoji: string) => unknown;
      markChatGroupAvatarGenerationFailed: (groupId: string) => unknown;
    },
  ): Promise<void> {
    const context = this.chatContext;
    if (!context?.orgId || !context.workspaceId) return;

    this.broadcastChat({
      type: "chat_group_avatar_updated",
      threadId,
      groupId: claim.id,
      avatar: { ...claim.avatar, status: "pending" },
    });

    let generatedEmoji: string | null = null;
    const generationStartedAt = Date.now();
    let aiErrored = false;
    try {
      generatedEmoji = await generateChatGroupEmojiWithOpenAI(
        this.env.AI,
        claim.name,
        {
          orgId: context.orgId,
          workspaceId: context.workspaceId,
          threadId,
          groupId: claim.id,
        },
        { gatewayName: this.env.CF_GATEWAY_NAME },
      );
    } catch (error) {
      aiErrored = true;
      console.error("[ChatThreadDO] failed to generate chat group emoji", {
        reason: "ai_error",
        threadId,
        groupId: claim.id,
        workspaceId: context.workspaceId,
        orgId: context.orgId,
        ...this.errorLogFields(error),
      });
      this.recordChatThreadObservabilityEvent("chat_group_emoji_generation", {
        operation: "generate",
        status: "ai_error",
        model: AUXILIARY_AI_MODEL,
        durationMs: Date.now() - generationStartedAt,
        error,
      });
    }
    // One event per generation outcome so the failure rate is measurable.
    if (!aiErrored) {
      this.recordChatThreadObservabilityEvent("chat_group_emoji_generation", {
        operation: "generate",
        status: generatedEmoji ? "ok" : "no_emoji",
        severity: generatedEmoji ? "info" : "warn",
        model: AUXILIARY_AI_MODEL,
        durationMs: Date.now() - generationStartedAt,
      });
    }

    if (!generatedEmoji) {
      // No emoji: record the one-shot attempt (so reconnects don't retry) and
      // broadcast the group's *actual* current avatar to clear the pending
      // state. Re-reading avoids clobbering an avatar the user set while the AI
      // was in flight.
      try {
        const avatar = (await userStub.markChatGroupAvatarGenerationFailed(
          claim.id,
        )) as ChatGroupAvatar | null;
        if (avatar) {
          this.broadcastChat({
            type: "chat_group_avatar_updated",
            threadId,
            groupId: claim.id,
            avatar,
          });
        }
      } catch (error) {
        console.error("[ChatThreadDO] failed to mark chat group avatar attempt", {
          reason: "mark_failed",
          threadId,
          groupId: claim.id,
          workspaceId: context.workspaceId,
          orgId: context.orgId,
          ...this.errorLogFields(error),
        });
      }
      return;
    }

    try {
      // The write re-reads and returns the current avatar (which may be a
      // user-set avatar if it changed while the AI ran), so broadcast that.
      const avatar = (await userStub.setGeneratedChatGroupEmoji(
        claim.id,
        generatedEmoji,
      )) as ChatGroupAvatar | null;
      if (avatar) {
        this.broadcastChat({
          type: "chat_group_avatar_updated",
          threadId,
          groupId: claim.id,
          avatar,
        });
      }
    } catch (error) {
      console.error("[ChatThreadDO] failed to write chat group avatar", {
        reason: "write_skipped",
        threadId,
        groupId: claim.id,
        workspaceId: context.workspaceId,
        orgId: context.orgId,
        ...this.errorLogFields(error),
      });
    }
  }

  private async maybeGenerateChatGroupAvatarForThread(
    threadId: string,
  ): Promise<void> {
    const normalizedThreadId = threadId.trim();
    const context = this.chatContext;
    if (
      !normalizedThreadId ||
      !context?.orgId ||
      !context.workspaceId ||
      !context.userId
    ) {
      return;
    }
    if (!this.env.AI || typeof this.env.AI.run !== "function") {
      console.warn("[ChatThreadDO] skipping chat group avatar generation", {
        reason: "missing_ai",
        threadId: normalizedThreadId,
        workspaceId: context.workspaceId,
        orgId: context.orgId,
      });
      return;
    }

    try {
      const userStub = this.env.USER.get(this.env.USER.idFromName(context.userId));
      const claim = await userStub.claimChatGroupAvatarGenerationForThread(
        normalizedThreadId,
      );
      if (!claim) return;
      await this.generateClaimedChatGroupAvatar(
        normalizedThreadId,
        claim,
        userStub,
      );
    } catch (error) {
      console.error("[ChatThreadDO] failed to update accessed chat group avatar", {
        threadId: normalizedThreadId,
        workspaceId: context.workspaceId,
        orgId: context.orgId,
        ...this.errorLogFields(error),
      });
    }
  }

  private async generateThreadTitleFromMessage(threadId: string, message: string): Promise<void> {
    try {
      const context = this.chatContext;
      if (!context?.orgId) {
        return;
      }

      const title = await generateThreadTitleWithOpenAI(
        this.env.AI,
        message,
        {
          orgId: context.orgId,
          workspaceId: context.workspaceId,
          threadId,
        },
        { gatewayName: this.env.CF_GATEWAY_NAME },
      );
      if (!title) {
        return;
      }

      const orgStub = this.env.ORG.get(this.env.ORG.idFromName(context.orgId));
      const updated = await orgStub.updateThread(threadId, title);
      await this.setTitle(title, updated?.updated_at);
      if (context.userId) {
        const userStub = this.env.USER.get(this.env.USER.idFromName(context.userId));
        await userStub.renameEmptySingleThreadGroupForThread(threadId, title);
        if (!isPlaceholderThreadTitle(title)) {
          this.ctx.waitUntil(
            this.maybeGenerateChatGroupAvatarForThread(threadId).catch((error) => {
              console.error("[ChatThreadDO] failed to update chat group avatar", {
                threadId,
                ...this.errorLogFields(error),
              });
            }),
          );
        }
      }
    } catch (err) {
      console.error('[ChatThreadDO] failed to generate thread title', err);
    } finally {
      this.titleGenerationInFlight = false;
    }
  }

  private async ensurePiSessionReady(): Promise<void> {
    await this.withRunnerTransitionLock("ensure_pi_session_ready", async () => {
      if (this.piSession) {
        return;
      }

      const baseContext = this.chatContext;
      if (!baseContext) {
        throw new Error("Missing chat context");
      }

      const orgId = this.env.ORG.idFromName(baseContext.orgId);
      const getOrgStub = () => this.env.ORG.get(orgId);
      const [thread, llmProviderRecord] = await Promise.all([
        this.retryChatDurableObjectRpc(
          "OrgDO.getThread",
          () => getOrgStub().getThread(baseContext.threadId),
          { attempts: 4, initialDelayMs: 150 },
        ),
        this.getCachedLlmProviderConfig(baseContext.orgId),
      ]);
      const context: ChatContextState = { ...baseContext };
      this.chatContext = context;
      this.ctx.storage.kv.put(CHAT_CONTEXT_KEY, context);
      const threadWorkspaceId =
        thread && typeof thread === "object" && "workspace_id" in thread
          ? (thread as { workspace_id?: unknown }).workspace_id
          : null;
      const effectiveLlmProviderRecord = getEffectiveLlmProviderConfig(
        this.env,
        llmProviderRecord,
      );
      const customApi = getStoredCustomLlmProviderApi(effectiveLlmProviderRecord);
      const customModelId = getStoredCustomLlmProviderModelId(effectiveLlmProviderRecord);
      const storedThreadModel =
        thread && threadWorkspaceId === context.workspaceId
          ? (thread as { model?: unknown }).model
          : undefined;
      const threadModel =
        storedThreadModel === CUSTOM_LLM_MODEL
          ? normalizeLlmModel(storedThreadModel, effectiveLlmProviderRecord?.provider, {
              customApi,
              customModelId,
            })
          : storedThreadModel !== undefined
            ? normalizeLlmModel(storedThreadModel)
          : normalizeLlmModel(undefined, effectiveLlmProviderRecord?.provider, {
              customApi,
              customModelId,
            });
      await this.ensurePiSession(context, {
        CHIRIDION_MODEL: threadModel,
        CHIRIDION_CLAUDE_MODEL: threadModel,
        CHIRIDION_CODEX_MODEL: threadModel,
      });
    });
  }

  private async ensurePiSession(
    context: ChatContextState,
    envVars: Record<string, string>,
  ): Promise<PiCoreAgent> {
    if (this.piSession) {
      return this.piSession;
    }
    if (this.piSessionPromise) {
      return await this.piSessionPromise;
    }

    this.piSessionPromise = this.createPiSession(context, envVars)
      .then((session) => {
        this.piSession = session;
        return session;
      })
      .finally(() => {
        this.piSessionPromise = null;
      });

    return await this.piSessionPromise;
  }

  private async createPiSession(
    context: ChatContextState,
    envVars: Record<string, string>,
  ): Promise<PiCoreAgent> {
    const { Agent } = await import("@earendil-works/pi-agent-core");
    const { completeSimple, getModel, streamSimple } = await import("@earendil-works/pi-ai/compat");

    this.piUnsubscribe?.();
    this.piUnsubscribe = null;
    this.piActiveItemId = null;
    this.piAssistantText = "";

    const resolveCurrentModel = () => this.resolvePiModel(context, envVars, getModel);
    const modelConfig = await resolveCurrentModel();
    this.piModelResolver = resolveCurrentModel;
    const persistedMessages = await this.loadPiCoreMessages();
    let initialMessages = [...persistedMessages];
    this.piMainBaselineIndex = persistedMessages.length;
    // Resume an interrupted turn: fold the journaled in-flight tail back in and
    // reconcile (synthesize interrupted results for dispatched-but-unfinished
    // tools; reorder reasoning ahead of tool calls). The synthesized/reordered
    // tail commits at the next turn_end via appendPiCoreMessagesIfMissing, so we
    // keep the committed-message count as the baseline (and never persist the
    // virtual compaction-summary prefix).
    if (this.readPiActiveTurn()) {
      const journalTail = await this.loadPiTurnJournalTail();
      // If the DO was evicted mid-turn_end — after some journaled messages were
      // already appended to pi_core_messages but before the journal was cleared —
      // those messages live in BOTH stores. Drop journal entries already committed
      // (by the same identity appendPiCoreMessagesIfMissing dedups on) so we don't
      // fold a duplicated user/assistant/tool sequence into the resumed transcript.
      const committedKeys = new Set(
        persistedMessages.map((message) => this.piCoreMessageKey(message)),
      );
      const uncommittedTail = journalTail.filter(
        (message) => !committedKeys.has(this.piCoreMessageKey(message)),
      );
      // Re-deliver any steer()'d messages that never made it into the turn journal
      // before eviction. Dedup against both committed history and the journal tail:
      // a steer that already drained into messages (and committed, or sits in the
      // tail) carries the same piCoreMessageKey, so it is folded once, never twice.
      const tailKeys = new Set(
        uncommittedTail.map((message) => this.piCoreMessageKey(message)),
      );
      const pendingSteer = (await this.loadPiTurnSteerJournal()).filter((message) => {
        const key = this.piCoreMessageKey(message);
        return !committedKeys.has(key) && !tailKeys.has(key);
      });
      const plan = planPiTurnResume(persistedMessages, [
        ...uncommittedTail,
        ...pendingSteer,
      ]);
      initialMessages = [...plan.messages];
      this.recordChatThreadObservabilityEvent("pi_turn_recovered", {
        operation: "resume_interrupted_turn",
        status: plan.owesModelOutput ? "continue" : "complete",
        count: plan.interruptedToolResults,
        size: plan.messages.length,
      });
    }
    const session = new Agent({
      initialState: {
        systemPrompt: this.createPiSystemPrompt(context),
        model: modelConfig.model,
        tools: this.createPiToolDefinitions(context),
        messages: initialMessages,
        thinkingLevel: "medium",
      },
      transformContext: async (messages, signal) => {
        const current = await resolveCurrentModel();
        const compacted = await this.compactPiContext(
          messages,
          current.model,
          current.apiKey,
          completeSimple,
          signal,
        );
        const repaired = repairPiMessageHistoryForReplay(
          compacted.map((message) => sanitizePiModelMessage(message)),
        );
        if (repaired.repairedCount > 0) {
        }
        return repaired.messages;
      },
      getApiKey: async () => {
        const current = await resolveCurrentModel();
        if (this.piSession) {
          this.piSession.state.model = current.model;
        }
        return current.apiKey;
      },
      afterToolCall: (toolContext, signal) =>
        this.afterPiToolCall(toolContext, signal),
      streamFn: (model, llmContext, options) =>
        this.streamPiModel(model, llmContext, options, streamSimple),
      sessionId: context.threadId,
      toolExecution: "parallel",
    });

    this.piUnsubscribe = session.subscribe((event) => {
      const handled = this.piEventHandlerChain
        .catch(() => undefined)
        .then(() => this.handlePiSessionEvent(event));
      this.piEventHandlerChain = handled;
      this.ctx.waitUntil(
        handled.catch((error) => {
          console.error("[ChatThreadDO] Pi event handler failed", error);
          this.persistPiAgentLoopErrorForDevelopers(error, {
            source: "pi_event_handler",
            eventType: event.type,
          });
        }),
      );
      return handled;
    });
    return session;
  }

  private createPiSystemPrompt(context: ChatContextState): string {
    return createPiSystemPrompt(context, {
      skillNames: PI_SKILL_NAMES,
      skillDescriptions: PI_SKILL_DESCRIPTIONS,
    });
  }

  private async compactPiContext(
    messages: AgentMessage[],
    model: Model<any>,
    apiKey: string,
    completeSimple: typeof import("@earendil-works/pi-ai/compat").completeSimple,
    signal?: AbortSignal,
    force = false,
  ): Promise<AgentMessage[]> {
    const contextWindow = this.piModelContextWindow(model);
    const reserveTokens = this.piCompactionReserveTokens(model);
    const keepRecentTokens = 20_000;
    const tokens = this.estimatePiCompactionTokens(messages);
    if (!force && tokens < contextWindow - reserveTokens) {
      return messages;
    }

    const existing = this.loadPiCoreCompaction();
    const startsWithExistingSummary =
      Boolean(existing) && this.isPiSummaryMessage(messages[0]);
    if (existing && startsWithExistingSummary) {
      if (tokens < contextWindow - reserveTokens) {
        return messages;
      }
    } else if (existing && existing.firstKeptIndex > 0 && existing.firstKeptIndex < messages.length) {
      const tail = messages.slice(existing.firstKeptIndex);
      if (this.estimatePiCompactionTokens([
        this.createPiSummaryMessage(existing.summary),
        ...tail,
      ]) < contextWindow - reserveTokens) {
        return [this.createPiSummaryMessage(existing.summary), ...tail];
      }
    }

    const firstKeptIndex = this.findPiCompactionCutIndex(messages, keepRecentTokens);
    if (firstKeptIndex <= 0 || firstKeptIndex >= messages.length) {
      return messages;
    }

    const previousSummary = existing?.summary;
    const messagesToSummarize = messages.slice(0, firstKeptIndex);
    const storedFirstKeptIndex =
      existing && startsWithExistingSummary
        ? existing.firstKeptIndex + Math.max(0, firstKeptIndex - 1)
        : firstKeptIndex;
    try {
      const summary = await this.summarizePiMessages(
        messagesToSummarize,
        model,
        apiKey,
        completeSimple,
        signal,
        previousSummary,
      );
      this.persistPiCoreCompaction(summary, storedFirstKeptIndex);
      return [this.createPiSummaryMessage(summary), ...messages.slice(firstKeptIndex)];
    } catch (error) {
      console.error("[ChatThreadDO] Pi context compaction failed", error);
      const fallbackSummary = this.createFallbackPiCompactionSummary(
        messagesToSummarize,
        error,
      );
      this.persistPiCoreCompaction(fallbackSummary, storedFirstKeptIndex);
      return [this.createPiSummaryMessage(fallbackSummary), ...messages.slice(firstKeptIndex)];
    }
  }

  private piModelContextWindow(model: Model<any> | null | undefined): number {
    return typeof model?.contextWindow === "number" && model.contextWindow > 0
      ? model.contextWindow
      : 128_000;
  }

  private piEffectiveMaxOutputTokens(model: Model<any> | null | undefined): number {
    const maxTokens = Math.floor(Number(model?.maxTokens ?? 0));
    return Number.isFinite(maxTokens) && maxTokens > 0
      ? Math.min(maxTokens, 32_000)
      : 0;
  }

  private piCompactionReserveTokens(model: Model<any> | null | undefined): number {
    const contextWindow = this.piModelContextWindow(model);
    const outputReserveTokens = this.piEffectiveMaxOutputTokens(model);
    return Math.max(16_384, Math.ceil(contextWindow * 0.1), outputReserveTokens);
  }

  private estimatePiCompactionTokens(messages: AgentMessage[]): number {
    return Math.ceil(this.estimatePiContextTokens(messages) * 1.12);
  }

  private piAssistantContextTokens(message: AgentMessage): number | null {
    const record = message as unknown as {
      role?: unknown;
      usage?: {
        input?: unknown;
        output?: unknown;
        cacheRead?: unknown;
        cacheWrite?: unknown;
        totalTokens?: unknown;
      };
    };
    if (record.role !== "assistant") return null;
    const usage = record.usage;
    if (!usage || typeof usage !== "object") return null;
    const totalTokens = Number(usage.totalTokens);
    if (Number.isFinite(totalTokens) && totalTokens > 0) {
      return Math.floor(totalTokens);
    }
    const input = Math.max(0, Math.floor(Number(usage.input ?? 0)));
    const output = Math.max(0, Math.floor(Number(usage.output ?? 0)));
    const cacheRead = Math.max(0, Math.floor(Number(usage.cacheRead ?? 0)));
    const cacheWrite = Math.max(0, Math.floor(Number(usage.cacheWrite ?? 0)));
    const total = input + output + cacheRead + cacheWrite;
    return total > 0 ? total : null;
  }

  private shouldCompactPiAfterAssistantUsage(
    message: AgentMessage,
    model: Model<any> | null | undefined,
  ): boolean {
    const contextWindow = this.piModelContextWindow(model);
    if (this.isPiContextOverflowMessage(message, contextWindow)) return true;
    const contextTokens = this.piAssistantContextTokens(message);
    if (contextTokens === null) return false;
    return contextTokens >= contextWindow - this.piCompactionReserveTokens(model);
  }

  private isPiContextOverflowMessage(message: AgentMessage, contextWindow: number): boolean {
    const record = message as unknown as {
      role?: unknown;
      stopReason?: unknown;
      errorMessage?: unknown;
      usage?: unknown;
      content?: unknown;
      timestamp?: unknown;
    };
    if (record.role !== "assistant") return false;
    return isContextOverflow(record as Parameters<typeof isContextOverflow>[0], contextWindow);
  }

  private maybeSchedulePiPostTurnCompaction(messages: AgentMessage[]): void {
    const latestAssistant = this.latestPiAssistantMessage(messages);
    if (!latestAssistant || !this.shouldCompactPiAfterAssistantUsage(latestAssistant, this.piSession?.state.model)) {
      return;
    }

    this.ctx.waitUntil(
      this.compactPiContextAfterTurn(latestAssistant).catch((error) => {
        console.error("[ChatThreadDO] Pi post-turn compaction failed", error);
      }),
    );
  }

  private async loadPiCompleteSimple(): Promise<typeof import("@earendil-works/pi-ai/compat").completeSimple> {
    const { completeSimple } = await import("@earendil-works/pi-ai/compat");
    return completeSimple;
  }

  private async compactPiContextAfterTurn(triggerMessage: AgentMessage): Promise<void> {
    const resolver = this.piModelResolver;
    const session = this.piSession;
    if (
      !resolver ||
      !session ||
      session.state.isStreaming ||
      !this.shouldCompactPiAfterAssistantUsage(triggerMessage, session.state.model)
    ) {
      return;
    }

    const completeSimple = await this.loadPiCompleteSimple();
    const current = await resolver();
    if (
      session.state.isStreaming ||
      !this.shouldCompactPiAfterAssistantUsage(triggerMessage, current.model)
    ) {
      return;
    }

    const before = session.state.messages;
    const compacted = await this.compactPiContext(
      before,
      current.model,
      current.apiKey,
      completeSimple,
      undefined,
      true,
    );
    if (compacted === before || session.state.isStreaming || session.state.messages !== before) {
      return;
    }

    session.state.messages = compacted;
    await this.replacePiCoreMessages(compacted);
    this.clearPiCoreCompaction();
    this.piMainBaselineIndex = compacted.length;
  }

  private estimatePiContextTokens(messages: AgentMessage[]): number {
    return messages.reduce(
      (sum, message) => sum + this.estimatePiMessageTokens(message),
      0,
    );
  }

  private estimatePiMessageTokens(message: AgentMessage): number {
    const record = message as unknown as { role?: unknown; content?: unknown };
    let text = "";
    if (record.role === "user") {
      text = this.stringifyPiUserContentForCompaction(record.content);
    } else if (record.role === "assistant") {
      text = this.stringifyPiAssistantContentForCompaction(record.content);
    } else if (record.role === "toolResult") {
      text = this.stringifyPiToolResultContentForCompaction(record.content);
    } else {
      try {
        text = JSON.stringify(message);
      } catch {
        text = String(message);
      }
    }
    return Math.ceil(text.length / 4);
  }

  private stringifyPiUserContentForCompaction(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .map((part) => {
        if (!part || typeof part !== "object") return "";
        const record = part as { type?: unknown; text?: unknown; mimeType?: unknown };
        if (record.type === "text") return typeof record.text === "string" ? record.text : "";
        if (record.type === "image") return `[image:${String(record.mimeType || "unknown")}]`;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  private stringifyPiAssistantContentForCompaction(content: unknown): string {
    if (!Array.isArray(content)) return typeof content === "string" ? content : "";
    return content
      .map((part) => {
        if (!part || typeof part !== "object") return "";
        const record = part as {
          type?: unknown;
          text?: unknown;
          thinking?: unknown;
          name?: unknown;
          arguments?: unknown;
        };
        if (record.type === "text") return typeof record.text === "string" ? record.text : "";
        if (record.type === "thinking") return typeof record.thinking === "string" ? record.thinking : "";
        if (record.type === "toolCall") {
          return `Tool call: ${String(record.name || "unknown")} ${JSON.stringify(record.arguments ?? {})}`;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  private stringifyPiToolResultContentForCompaction(content: unknown): string {
    if (!Array.isArray(content)) return typeof content === "string" ? content : "";
    return content
      .map((part) => {
        if (!part || typeof part !== "object") return "";
        const record = part as { type?: unknown; text?: unknown; mimeType?: unknown };
        if (record.type === "text") return typeof record.text === "string" ? record.text : "";
        if (record.type === "image") return `[image:${String(record.mimeType || "unknown")}]`;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  private findPiCompactionCutIndex(messages: AgentMessage[], keepRecentTokens: number): number {
    let tokens = 0;
    for (let index = messages.length - 1; index >= 0; index--) {
      tokens += this.estimatePiContextTokens([messages[index] as AgentMessage]);
      if (tokens >= keepRecentTokens) {
        for (let cut = index; cut < messages.length; cut++) {
          const role = (messages[cut] as { role?: unknown }).role;
          if (role === "user" || role === "assistant") {
            return cut;
          }
        }
        return index;
      }
    }
    return 0;
  }

  private async summarizePiMessages(
    messages: AgentMessage[],
    model: Model<any>,
    apiKey: string,
    completeSimple: typeof import("@earendil-works/pi-ai/compat").completeSimple,
    signal?: AbortSignal,
    previousSummary?: string,
  ): Promise<string> {
    const summaryMaxTokens = this.piSummaryMaxTokens(model);
    const inputTokenBudget = this.piSummaryInputTokenBudget(model, summaryMaxTokens);
    const chunks = this.chunkPiMessagesForSummary(messages, inputTokenBudget);
    if (chunks.length === 0) {
      throw new Error("Nothing to compact");
    }

    let summary: string | undefined = previousSummary;
    for (const chunk of chunks) {
      summary = await this.summarizePiMessageChunk(
        chunk,
        model,
        apiKey,
        completeSimple,
        summaryMaxTokens,
        inputTokenBudget,
        signal,
        summary,
      );
    }
    return summary ?? "";
  }

  private piSummaryMaxTokens(model: Model<any>): number {
    const contextWindow = this.piModelContextWindow(model);
    const reserveTokens = this.piCompactionReserveTokens(model);
    const modelOutputTokens = this.piEffectiveMaxOutputTokens(model) || reserveTokens;
    return Math.max(
      512,
      Math.min(
        Math.floor(reserveTokens * 0.8),
        modelOutputTokens,
        Math.max(512, Math.floor(contextWindow * 0.25)),
      ),
    );
  }

  private piSummaryInputTokenBudget(model: Model<any>, summaryMaxTokens: number): number {
    const contextWindow = this.piModelContextWindow(model);
    const budget = Math.floor((contextWindow - summaryMaxTokens - 2048) * 0.85);
    return Math.max(2048, budget);
  }

  private chunkPiMessagesForSummary(messages: AgentMessage[], inputTokenBudget: number): AgentMessage[][] {
    const chunks: AgentMessage[][] = [];
    let chunk: AgentMessage[] = [];
    let chunkTokens = 0;
    for (const message of messages) {
      const messageTokens = Math.max(1, this.estimatePiMessageTokens(message));
      if (chunk.length > 0 && chunkTokens + messageTokens > inputTokenBudget) {
        chunks.push(chunk);
        chunk = [];
        chunkTokens = 0;
      }
      chunk.push(message);
      chunkTokens += messageTokens;
    }
    if (chunk.length > 0) chunks.push(chunk);
    return chunks;
  }

  private async summarizePiMessageChunk(
    messages: AgentMessage[],
    model: Model<any>,
    apiKey: string,
    completeSimple: typeof import("@earendil-works/pi-ai/compat").completeSimple,
    summaryMaxTokens: number,
    inputTokenBudget: number,
    signal?: AbortSignal,
    previousSummary?: string,
  ): Promise<string> {
    const serialized = messages
      .map((message) => this.serializePiMessageForSummary(message))
      .filter(Boolean)
      .join("\n\n");
    const previous = previousSummary
      ? `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`
      : "";
    const maxConversationCharacters = Math.max(
      4000,
      (inputTokenBudget * 4) - previous.length - 2000,
    );
    const boundedSerialized = serialized.length > maxConversationCharacters
      ? `${serialized.slice(0, maxConversationCharacters)}\n\n[...truncated oversized compaction chunk...]`
      : serialized;
    const prompt = `${previous}<conversation>\n${boundedSerialized}\n</conversation>\n\nSummarize this coding-agent conversation for future continuation. Preserve exact file paths, commands, tool results that changed decisions, completed work, current goal, constraints, and next steps. Do not answer the conversation.`;
    const summaryContext = {
      systemPrompt: "You produce compact continuation summaries for coding-agent conversations.",
      messages: [{ role: "user" as const, content: prompt, timestamp: Date.now() }],
    };
    const summaryOptions = {
      apiKey,
      signal,
      maxTokens: summaryMaxTokens,
      ...(model.reasoning ? { reasoning: "high" as const } : {}),
    } as Parameters<typeof completeSimple>[2];
    const response = await completeSimple(
      model,
      summaryContext,
      summaryOptions,
    );
    if ((response as { stopReason?: unknown }).stopReason === "error") {
      const errorMessage = typeof (response as { errorMessage?: unknown }).errorMessage === "string"
        ? (response as { errorMessage: string }).errorMessage
        : "Compaction summary generation failed";
      throw new Error(errorMessage);
    }
    if ((response as { stopReason?: unknown }).stopReason === "aborted") {
      throw new Error("Compaction summary generation was aborted");
    }
    const text = response.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (!text) throw new Error("Compaction summary was empty");
    return text;
  }

  private serializePiMessageForSummary(message: AgentMessage): string {
    const sanitizedMessage = stripPiUiMetadata(message);
    const role = (sanitizedMessage as { role?: unknown }).role;
    if (role === "user") {
      const content = (sanitizedMessage as { content?: unknown }).content;
      return `[User]\n${typeof content === "string" ? content : JSON.stringify(content)}`;
    }
    if (role === "assistant") {
      return `[Assistant]\n${JSON.stringify((sanitizedMessage as { content?: unknown }).content)}`;
    }
    if (role === "toolResult") {
      const toolName = (sanitizedMessage as { toolName?: unknown }).toolName;
      const content = (sanitizedMessage as { content?: unknown }).content;
      return `[Tool result: ${String(toolName || "unknown")}]\n${JSON.stringify(content).slice(0, 4000)}`;
    }
    return "";
  }

  private createFallbackPiCompactionSummary(messages: AgentMessage[], error: unknown): string {
    const details = this.piAgentLoopErrorDetails(error);
    const roleCounts = messages.reduce<Record<string, number>>((counts, message) => {
      const role = String((message as unknown as Record<string, unknown>).role || "unknown");
      counts[role] = (counts[role] ?? 0) + 1;
      return counts;
    }, {});
    const snippets = messages
      .map((message) => this.serializePiMessageForSummary(message))
      .filter((line): line is string => Boolean(line && line.trim()))
      .slice(-8)
      .map((line) => line.length > 1000 ? `${line.slice(0, 1000)}\n[...truncated...]` : line)
      .join("\n\n");
    return [
      "Automatic fallback summary created because model-generated compaction failed.",
      `Compaction error: ${details.name}: ${details.message}`,
      `Compacted message count: ${messages.length}`,
      `Role counts: ${JSON.stringify(roleCounts)}`,
      snippets ? `Recent compacted excerpts:\n${snippets}` : "",
    ].filter(Boolean).join("\n\n").slice(0, 80_000);
  }

  private createPiSummaryMessage(summary: string, timestamp = Date.now()): AgentMessage {
    return {
      role: "user",
      content: `[Context Summary]\n\n${summary}`,
      timestamp,
    };
  }

  private isPiSummaryMessage(message: AgentMessage | undefined): boolean {
    return (
      (message as unknown as Record<string, unknown> | undefined)?.role === "user" &&
      typeof (message as unknown as Record<string, unknown> | undefined)?.content === "string" &&
      ((message as unknown as Record<string, unknown>).content as string).startsWith(
        "[Context Summary]\n\n",
      )
    );
  }

  private async resolvePiModel(
    context: ChatContextState,
    envVars: Record<string, string>,
    getModelFn: (provider: never, modelId: never) => Model<any>,
  ): Promise<PiResolvedModelConfig> {
    const requestedModelId =
      envVars.CHIRIDION_MODEL ||
      envVars.CHIRIDION_CODEX_MODEL ||
      envVars.CHIRIDION_CLAUDE_MODEL ||
      DEFAULT_LLM_MODEL;
    const modelId = this.piModelMapping.normalizePiModelId(requestedModelId);
    const resolved = this.piModelMapping.resolvePiModelReference(modelId);
    const model =
      (getModelFn(
        resolved.provider as never,
        resolved.modelId as never,
      ) as Model<any> | null | undefined) ??
      resolvePiModelCatalogFallback(resolved);
    if (!model) {
      throw new Error(`Unsupported Pi model ${requestedModelId}`);
    }

    const configured = await this.resolvePiRequestConfig(
      resolved,
      context,
      requestedModelId,
    );
    const configuredModel =
      configured.modelLookupProvider && configured.requestModelId
        ? (getModelFn(
            configured.modelLookupProvider as never,
            (configured.modelLookupModelId ?? configured.requestModelId) as never,
          ) as Model<any> | null | undefined) ??
          resolvePiModelCatalogFallback({
            provider: configured.modelLookupProvider,
            modelId: configured.modelLookupModelId ?? configured.requestModelId,
            hostedGatewayProvider: resolved.hostedGatewayProvider,
          })
        : null;
    if (configured.modelLookupProvider && !configuredModel) {
      throw new Error(
        `Unsupported ${configured.modelLookupProvider} Pi model ${configured.requestModelId}`,
      );
    }
    const modelBase = configuredModel ?? model;
    const usageProvider = configured.usageProvider ?? resolved.provider;
    this.piCurrentBillingSource = configured.billingSource;
    this.piCurrentCreditChargeable = configured.creditChargeable;
    this.piCurrentUsageProvider = usageProvider;
    // E2E determinism: when TEST_LLM_REPLAY_URL is set, route every provider's
    // requests to the local deterministic fake LLM (scripts/fake-llm.mjs)
    // instead of the real model. Auth/headers are left untouched (the fake
    // ignores them); only the origin changes, so the agent loop runs offline
    // and deterministically. Unset in production -> no effect.
    const replayBaseUrl = (
      this.env as { TEST_LLM_REPLAY_URL?: string }
    ).TEST_LLM_REPLAY_URL?.trim();
    const resolvedModel = {
      ...modelBase,
      api: configured.api ?? resolved.api ?? modelBase.api,
      id: configured.requestModelId ?? modelBase.id,
      provider: configured.requestProvider ?? modelBase.provider,
      baseUrl: replayBaseUrl || configured.baseUrl || modelBase.baseUrl,
      headers: {
        ...(modelBase.headers ?? {}),
        ...(configured.headers ?? {}),
      },
    } as Model<any>;
    // Force a fixed reasoning effort on hosted AI Gateway models that need it
    // (e.g. DeepSeek V4 Pro/Auto -> xhigh). pi-ai treats the cloudflare-ai-gateway
    // provider as supportsReasoningEffort=false, so we flip it on and map every
    // agent thinking level to the target effort; otherwise reasoning_effort is
    // never emitted and the dynamic route falls back to its upstream default.
    if (
      resolved.hostedReasoningEffort &&
      resolvedModel.provider === "cloudflare-ai-gateway"
    ) {
      const effort = resolved.hostedReasoningEffort;
      resolvedModel.compat = {
        ...(resolvedModel.compat ?? {}),
        supportsReasoningEffort: true,
      };
      resolvedModel.thinkingLevelMap = {
        minimal: effort,
        low: effort,
        medium: effort,
        high: effort,
        xhigh: effort,
      } as Model<any>["thinkingLevelMap"];
    }
    return {
      model: resolvedModel,
      apiKey: configured.apiKey,
      headers: configured.headers,
      provider: resolved.provider,
      modelId: resolved.modelId,
      billingSource: configured.billingSource,
      creditChargeable: configured.creditChargeable,
      usageProvider,
    };
  }

  private async resolvePiRequestConfig(
    resolved: PiResolvedModelReference,
    context: ChatContextState,
    requestedModelId: string,
  ): Promise<PiRequestConfig> {
    const selfhostProvider = getSelfhostAiProviderCredentials(this.env);
    const byok = selfhostProvider ?? await this.resolveCurrentByokCredentials(context).catch((error) => {
      console.error("[ChatThreadDO] failed to resolve Pi BYOK credentials", error);
      return null;
    });
    const byokAllowed = resolved.byokAllowed !== false;
    if (byokAllowed && byok?.provider === "custom" && byok.apiKey && byok.baseUrl && byok.api) {
      const customModel = this.piModelMapping.resolveCustomProviderModelReference(
        byok.api,
        requestedModelId,
        byok.modelId,
      );
      return {
        apiKey: byok.apiKey,
        api: byok.api,
        billingSource: "byok",
        creditChargeable: false,
        requestProvider: "custom",
        requestModelId: customModel.requestModelId,
        modelLookupProvider: customModel.provider,
        modelLookupModelId: customModel.lookupModelId,
        baseUrl: byok.baseUrl,
        usageProvider: "custom",
        headers: this.piModelMapping.customProviderAuthHeaders(byok.api, byok.authType ?? "bearer", byok.apiKey),
      };
    }
    if (byokAllowed && byok?.provider === "openrouter" && byok.apiKey) {
      return {
        apiKey: byok.apiKey,
        billingSource: "byok",
        creditChargeable: false,
        usageProvider: "openrouter",
        // hostedModelId can be a gateway-only dynamic route (e.g.
        // "dynamic/..." on the AI Gateway compat endpoint); OpenRouter only
        // understands native model ids, so fall back to the OpenRouter id.
        requestModelId:
          resolved.hostedGatewayProvider === "openrouter"
            ? resolved.hostedModelId
            : this.piModelMapping.openRouterNitroModel(resolved.modelId),
        headers: {
          ...this.piModelMapping.openRouterAttributionHeaders(),
          ...(resolved.provider === "anthropic"
            ? { Authorization: `Bearer ${byok.apiKey}` }
            : {}),
        },
        baseUrl: resolved.provider === "anthropic"
          ? "https://openrouter.ai/api"
          : "https://openrouter.ai/api/v1",
      };
    }
    if (byokAllowed && byok?.provider === "bedrock" && byok.apiKey && resolved.provider === "anthropic") {
      return {
        apiKey: byok.apiKey,
        api: "anthropic-messages",
        billingSource: "byok",
        creditChargeable: false,
        requestProvider: "custom",
        requestModelId: this.piModelMapping.bedrockClaudeModel(resolved.modelId),
        modelLookupProvider: "anthropic",
        modelLookupModelId: resolved.modelId,
        baseUrl: this.piModelMapping.bedrockAnthropicMessagesBaseUrl(byok.awsRegion),
        usageProvider: "bedrock",
      };
    }
    if (byokAllowed && byok?.provider === "bedrock" && byok.apiKey && resolved.provider === "openai") {
      const bedrockOpenAi = this.piModelMapping.bedrockOpenAiModelConfig(resolved.modelId, byok.awsRegion);
      if (bedrockOpenAi) {
        return {
          apiKey: byok.apiKey,
          api: "openai-responses",
          billingSource: "byok",
          creditChargeable: false,
          requestProvider: "custom",
          requestModelId: bedrockOpenAi.modelId,
          modelLookupProvider: "openai",
          modelLookupModelId: resolved.modelId,
          baseUrl: bedrockOpenAi.baseUrl,
          usageProvider: "bedrock",
        };
      }
    }
    if (byokAllowed && byok?.provider === resolved.provider && byok.apiKey) {
      return {
        apiKey: byok.apiKey,
        billingSource: "byok",
        creditChargeable: false,
        usageProvider: resolved.provider,
      };
    }

    const creditChargeable = await this.checkHostedPiModelAccess(context);
    // E2E replay routes hosted calls to a local stub that ignores account/
    // gateway/auth, so stand in dummy values to clear this gateway-config check
    // (the real origin is swapped in resolveCloudflareGatewayOrigin). Lets the
    // credential-free CI path replay hosted turns without gateway secrets.
    const replay = this.env.TEST_LLM_REPLAY_URL?.trim() ? "replay" : undefined;
    const accountId = this.env.CF_ACCOUNT_ID?.trim() || replay;
    const gatewayName = this.env.CF_GATEWAY_NAME?.trim() || replay;
    const token =
      this.env.AI_GATEWAY_AUTH_TOKEN?.trim() ||
      this.env.CF_GATEWAY_TOKEN?.trim() ||
      replay;
    if (!accountId || !gatewayName || !token) {
      if (isSelfhostRuntime(this.env)) {
        throw new Error(
          "Self-host chat requires an AI provider. Set SELFHOST_AI_PROVIDER and SELFHOST_AI_API_KEY in the self-host environment, or configure CF_ACCOUNT_ID, CF_GATEWAY_NAME, and AI_GATEWAY_AUTH_TOKEN for a hosted Cloudflare AI Gateway.",
        );
      }
      throw new Error("Cloudflare AI Gateway is not configured for DO Pi");
    }

    return {
      apiKey: token,
      billingSource: "hosted",
      creditChargeable,
      requestProvider: "cloudflare-ai-gateway",
      requestModelId: resolved.hostedModelId,
      usageProvider: resolved.hostedGatewayProvider,
      baseUrl: buildCloudflareGatewayUrl(
        this.env,
        `/v1/${encodeURIComponent(accountId)}/${encodeURIComponent(gatewayName)}/${encodeURIComponent(resolved.hostedGatewayProvider)}`,
      ),
      headers: {
        ...(resolved.hostedGatewayProvider === "openrouter"
          ? this.piModelMapping.openRouterAttributionHeaders()
          : {}),
        "cf-aig-metadata": JSON.stringify({
          uid: [this.chatContext?.orgId, this.chatContext?.workspaceId, this.chatContext?.threadId]
            .filter(Boolean)
            .join(":"),
          chiridion: {
            orgId: this.chatContext?.orgId,
            workspaceId: this.chatContext?.workspaceId,
            threadId: this.chatContext?.threadId,
          },
        }),
      },
    };
  }

  private formatCreditCents(cents: number): string {
    return `${(Math.max(0, Math.floor(cents)) / 100).toFixed(2)} credits`;
  }

  private async checkHostedPiModelAccess(
    context: ChatContextState,
  ): Promise<boolean> {
    if (isSelfhostRuntime(this.env)) {
      return false;
    }

    const orgStub = this.env.ORG.get(this.env.ORG.idFromName(context.orgId));
    const org = await orgStub.getInfo();
    if (!org) {
      throw new Error("Organization not found");
    }

    const status = org.billing_status ?? "inactive";
    const plan = org.billing_plan ?? "payg";
    if (status === "enterprise") {
      return false;
    }
    const isPayAsYouGo = plan === "payg";
    if (status === "past_due") {
      throw new Error(
        "Your subscription is past due. Update payment details, switch to Pay as you go in Settings -> Billing, or add your own API key in Settings -> AI Provider to continue. Your workspace is saved.",
      );
    }
    if (status === "canceled") {
      throw new Error(
        "Your subscription was canceled. Start a new subscription, switch to Pay as you go in Settings -> Billing, or add your own API key in Settings -> AI Provider to continue. Your workspace is saved.",
      );
    }
    if (!isPayAsYouGo && status !== "trialing" && status !== "active") {
      throw new Error(
        "Hosted models require billing access. Choose Pay as you go, start a subscription, or add your own API key in Settings -> AI Provider. Your workspace is saved.",
      );
    }

    const usage = await orgStub.getUsageLogSum(0, Date.now(), true);
    const spentCents = Math.round(Number(usage.total_cost_usd ?? 0) * 100);
    const totalCreditsCents =
      (org.billing_credit_purchase_total_cents ?? 0) +
      (org.billing_credit_grant_total_cents ?? 0);
    if (totalCreditsCents - spentCents > 0) {
      return true;
    }

    throw new Error(
      `Hosted model credits are used up. You have used ${this.formatCreditCents(spentCents)} of ${this.formatCreditCents(totalCreditsCents)}. Buy credits or manage your subscription in Settings -> Billing, or add your own API key in Settings -> AI Provider. Your workspace is saved.`,
    );
  }

  /**
   * Read OrgDO.getLlmProviderConfig with a short TTL cache.
   *
   * BYOK provider config changes only on rare admin action but is read on
   * every turn across all of an org's threads, hammering the single OrgDO
   * instance. Within the TTL we serve the cached value (including a cached
   * null) and skip the RPC entirely. On a transient RPC failure we fall back
   * to any cached value (even an expired one); with no cached value we
   * propagate the error exactly as the underlying retry wrapper would.
   *
   * The cache is keyed defensively on orgId: a ChatThreadDO instance belongs
   * to a single thread/org, so a mismatch indicates a bug and forces a fresh
   * read rather than serving another org's config.
   */
  /**
   * Read OrgDO.getLlmProviderConfig once per agent turn.
   *
   * The Pi agent loop resolves provider credentials on every LLM call
   * (transformContext), which previously fanned one OrgDO RPC per call into
   * the single OrgDO instance. The cache is cleared at agent_start and by
   * byokChanged(), so each turn reads the config exactly once (first LLM
   * call) and reuses it for the rest of the turn: provider config is
   * constant within a turn by design. Caches both null and non-null records;
   * keyed defensively on orgId so a mismatch forces a fresh read. RPC
   * failures propagate exactly as before (the retry wrapper absorbs
   * transient blips).
   */
  private async getCachedLlmProviderConfig(
    orgId: string,
  ): Promise<LlmProviderConfigRecord> {
    const cached = this.cachedLlmProviderConfig;
    if (cached && cached.orgId === orgId) {
      return cached.value;
    }

    const orgDoId = this.env.ORG.idFromName(orgId);
    const getOrgStub = () => this.env.ORG.get(orgDoId);
    const value = await this.retryChatDurableObjectRpc(
      "OrgDO.getLlmProviderConfig",
      () => getOrgStub().getLlmProviderConfig(),
      { attempts: 4, initialDelayMs: 150 },
    );
    this.cachedLlmProviderConfig = { orgId, value };
    return value;
  }

  private async resolveCurrentByokCredentials(
    context: ChatContextState,
  ): Promise<{
    provider: string;
    apiKey?: string;
    awsRegion?: string;
    baseUrl?: string;
    authType?: "bearer" | "x-api-key";
    api?: "openai-completions" | "openai-responses" | "anthropic-messages";
    modelId?: string;
  } | null> {
    const record = await this.getCachedLlmProviderConfig(context.orgId);
    if (!record) {
      return null;
    }

    const creds = await decryptCredentials<Record<string, string>>(
      record.credentials_encrypted,
      this.env.INTEGRATION_SECRET_KEY,
    );
    const config = parseStoredLlmProviderConfig(record.config);

    if (record.provider === "anthropic" && creds.api_key) {
      return { provider: "anthropic", apiKey: creds.api_key };
    }
    if (record.provider === "openai" && creds.api_key) {
      return { provider: "openai", apiKey: creds.api_key };
    }
    if (record.provider === "openrouter" && creds.api_key) {
      return { provider: "openrouter", apiKey: creds.api_key };
    }
    if (record.provider === "custom" && creds.api_key && config.custom_base_url && config.custom_api) {
      return {
        provider: "custom",
        apiKey: creds.api_key,
        baseUrl: config.custom_base_url,
        authType: config.custom_auth_type ?? "bearer",
        api: config.custom_api,
        modelId: config.custom_model_id,
      };
    }
    if (record.provider === "bedrock" && creds.bearer_token) {
      return {
        provider: "bedrock",
        apiKey: creds.bearer_token,
        awsRegion: config.aws_region,
      };
    }

    if (config.aws_region) {
    }
    return null;
  }

  private streamPiModel(
    model: Model<any>,
    context: Parameters<typeof import("@earendil-works/pi-ai/compat").streamSimple>[1],
    options: Parameters<typeof import("@earendil-works/pi-ai/compat").streamSimple>[2],
    streamSimple: typeof import("@earendil-works/pi-ai/compat").streamSimple,
  ): ReturnType<typeof import("@earendil-works/pi-ai/compat").streamSimple> {
    return this.streamPiModelWithTransientRetry(
      model,
      options,
      () => streamSimple(model, context, options),
    ) as ReturnType<typeof import("@earendil-works/pi-ai/compat").streamSimple>;
  }

  private streamPiModelWithTransientRetry(
    model: Model<any>,
    options: Parameters<typeof import("@earendil-works/pi-ai/compat").streamSimple>[2],
    createStream: () => AssistantMessageEventStream,
  ): AssistantMessageEventStream {
    const outer = createAssistantMessageEventStream();

    void (async () => {
      let attempt = 0;
      while (true) {
        let forwardedEvent = false;
        let pendingStartEvent: AssistantMessageEvent | null = null;
        let retryErrorMessage = "";
        try {
          const inner = createStream();
          for await (const event of inner) {
            if (event.type === "start") {
              pendingStartEvent = event;
              continue;
            }
            const errorMessage = this.piProviderStreamErrorMessage(event);
            if (
              errorMessage &&
              !forwardedEvent &&
              !options?.signal?.aborted &&
              attempt < PI_PROVIDER_TRANSIENT_RETRY_ATTEMPTS &&
              this.isTransientPiProviderError(errorMessage)
            ) {
              retryErrorMessage = errorMessage;
              break;
            }
            if (errorMessage) {
              this.recordPiProviderStreamTerminalError(
                model,
                errorMessage,
                options?.signal?.aborted
                  ? "aborted"
                  : forwardedEvent
                    ? "after_forwarded_event"
                    : attempt >= PI_PROVIDER_TRANSIENT_RETRY_ATTEMPTS
                      ? "retry_exhausted"
                      : "non_transient",
                attempt + 1,
                forwardedEvent,
              );
            }
            if (pendingStartEvent) {
              outer.push(pendingStartEvent);
              pendingStartEvent = null;
              forwardedEvent = true;
            }
            outer.push(event);
            forwardedEvent = true;
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          if (
            !forwardedEvent &&
            !options?.signal?.aborted &&
            attempt < PI_PROVIDER_TRANSIENT_RETRY_ATTEMPTS &&
            this.isTransientPiProviderError(errorMessage)
          ) {
            retryErrorMessage = errorMessage;
          } else {
            this.persistPiAgentLoopErrorForDevelopers(error, {
              source: "pi_stream",
            });
            this.recordPiProviderStreamTerminalError(
              model,
              errorMessage,
              options?.signal?.aborted
                ? "aborted"
                : forwardedEvent
                  ? "after_forwarded_event"
                  : attempt >= PI_PROVIDER_TRANSIENT_RETRY_ATTEMPTS
                    ? "retry_exhausted"
                    : "non_transient",
              attempt + 1,
              forwardedEvent,
            );
            outer.push({
              type: "error",
              reason: options?.signal?.aborted ? "aborted" : "error",
              error: this.createPiProviderStreamErrorMessage(
                model,
                errorMessage,
                options?.signal?.aborted ? "aborted" : "error",
              ),
            });
            outer.end();
            return;
          }
        }

        if (!retryErrorMessage) {
          outer.end();
          return;
        }

        attempt += 1;
        await this.sleepForPiProviderRetry(options?.signal);
      }
    })().catch((error) => {
      this.persistPiAgentLoopErrorForDevelopers(error, {
        source: "pi_stream_retry",
      });
      outer.push({
        type: "error",
        reason: options?.signal?.aborted ? "aborted" : "error",
        error: this.createPiProviderStreamErrorMessage(
          model,
          error instanceof Error ? error.message : String(error),
          options?.signal?.aborted ? "aborted" : "error",
        ),
      });
      outer.end();
    });

    return outer;
  }

  private piProviderStreamErrorMessage(event: AssistantMessageEvent): string {
    if (event.type !== "error") return "";
    const message = event.error.errorMessage;
    return typeof message === "string" ? message.trim() : "";
  }

  private recordPiProviderStreamTerminalError(
    model: Model<any>,
    message: string,
    status: "retry_exhausted" | "after_forwarded_event" | "non_transient" | "aborted",
    attempt: number,
    forwardedEvent: boolean,
  ): void {
    console.warn("[ChatThreadDO] Pi provider stream error", {
      provider: this.piCurrentUsageProvider || model.provider,
      model: model.id,
      status,
      attempt,
      forwardedEvent,
      error: message,
    });
  }

  private isTransientPiProviderError(message: string): boolean {
    const lower = message.toLowerCase();
    return PI_PROVIDER_TRANSIENT_ERROR_PATTERNS.some((pattern) =>
      lower.includes(pattern),
    );
  }

  private sleepForPiProviderRetry(signal: AbortSignal | undefined): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(new Error("Request was aborted"));
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(resolve, PI_PROVIDER_TRANSIENT_RETRY_DELAY_MS);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timeout);
          reject(new Error("Request was aborted"));
        },
        { once: true },
      );
    });
  }

  private createPiProviderStreamErrorMessage(
    model: Model<any>,
    errorMessage: string,
    stopReason: "error" | "aborted",
  ): AssistantMessage {
    return {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason,
      errorMessage,
      timestamp: Date.now(),
    };
  }

  private scopedCodeModeTools(context: ChatContextState): CodeModeToolsBinding {
    return (this.ctx.exports as unknown as {
      CodeModeToolsBinding(init: { props: CodeModeToolsProps }): CodeModeToolsBinding;
    }).CodeModeToolsBinding({
      props: {
        orgId: context.orgId,
        workspaceId: context.workspaceId,
        threadId: context.threadId,
        userId: context.userId ?? undefined,
      },
    });
  }

  private extractToolText(result: unknown): string {
    if (typeof result === "string") return result;
    if (result && typeof result === "object") {
      const record = result as Record<string, unknown>;
      if (typeof record.content === "string") return record.content;
      if (typeof record.text === "string") return record.text;
      if (Array.isArray(record.content)) {
        const text = record.content
          .map((entry) => {
            if (!entry || typeof entry !== "object") return "";
            const item = entry as Record<string, unknown>;
            return item.type === "text" && typeof item.text === "string" ? item.text : "";
          })
          .filter(Boolean)
          .join("\n");
        if (text) return text;
      }
      if (typeof record.stdout === "string" || typeof record.stderr === "string") {
        return [record.stdout, record.stderr].filter((value) => typeof value === "string" && value).join("\n");
      }
    }
    return JSON.stringify(result, null, 2);
  }

  private extractToolContent(
    result: unknown,
  ): Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  > {
    type ExtractedToolContent =
      | { type: "text"; text: string }
      | { type: "image"; data: string; mimeType: string };
    if (result && typeof result === "object") {
      const record = result as Record<string, unknown>;
      if (Array.isArray(record.content)) {
        const content: ExtractedToolContent[] = [];
        for (const entry of record.content) {
          if (!entry || typeof entry !== "object") continue;
          const item = entry as Record<string, unknown>;
          if (item.type === "text" && typeof item.text === "string") {
            content.push({ type: "text", text: item.text });
          }
          if (
            item.type === "image" &&
            typeof item.data === "string" &&
            typeof item.mimeType === "string"
          ) {
            const mimeType = normalizePiImageMimeType(item.mimeType);
            if (PI_PROVIDER_SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) {
              content.push({ type: "image", data: item.data, mimeType });
            } else {
              content.push({
                type: "text",
                text: piUnsupportedImageText(item.mimeType),
              });
            }
          }
        }
        if (content.length > 0) return content;
      }
    }
    return [{ type: "text", text: this.extractToolText(result) }];
  }

  // Executor-style tool surface: the model sees the core file/bash/js_exec/subagent
  // tools plus the app/project-lifecycle passthrough tools, and reaches everything
  // else by writing code in js_exec (tools.search / tools.describe / tools.<name>).
  private createPiToolDefinitions(
    context: ChatContextState,
    options: PiToolDefinitionOptions = {},
  ): AgentTool[] {
    const tools = this.scopedCodeModeTools(context);
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await this.keepPiTurnToolProgressAliveWhile(() => tools.callTool(name, args));
      return {
        content: this.extractToolContent(result),
        details: result,
      };
    };

    const definitions: AgentTool[] = [
      {
        name: PI_CONTAINER_TOOL_DEFINITIONS.read.name,
        label: PI_CONTAINER_TOOL_DEFINITIONS.read.label,
        description: `${PI_CONTAINER_TOOL_DEFINITIONS.read.description} Also supports bundled skill files.`,
        parameters: PI_CONTAINER_TOOL_DEFINITIONS.read.parameters,
        execute: async (_id, params) => call("read", params as Record<string, unknown>),
      },
      {
        name: PI_CONTAINER_TOOL_DEFINITIONS.write.name,
        label: PI_CONTAINER_TOOL_DEFINITIONS.write.label,
        description: PI_CONTAINER_TOOL_DEFINITIONS.write.description,
        parameters: PI_CONTAINER_TOOL_DEFINITIONS.write.parameters,
        execute: async (_id, params) => call("write", params as Record<string, unknown>),
      },
      {
        name: PI_CONTAINER_TOOL_DEFINITIONS.edit.name,
        label: PI_CONTAINER_TOOL_DEFINITIONS.edit.label,
        description: PI_CONTAINER_TOOL_DEFINITIONS.edit.description,
        parameters: PI_CONTAINER_TOOL_DEFINITIONS.edit.parameters,
        execute: async (_id, params) => call("edit", params as Record<string, unknown>),
        executionMode: "sequential",
      },
      {
        name: PI_CONTAINER_TOOL_DEFINITIONS.delete.name,
        label: PI_CONTAINER_TOOL_DEFINITIONS.delete.label,
        description: PI_CONTAINER_TOOL_DEFINITIONS.delete.description,
        parameters: PI_CONTAINER_TOOL_DEFINITIONS.delete.parameters,
        execute: async (_id, params) => call("delete", params as Record<string, unknown>),
        executionMode: "sequential",
      },
      {
        name: PI_CONTAINER_TOOL_DEFINITIONS.ls.name,
        label: PI_CONTAINER_TOOL_DEFINITIONS.ls.label,
        description: `${PI_CONTAINER_TOOL_DEFINITIONS.ls.description} Also supports bundled skill directories.`,
        parameters: PI_CONTAINER_TOOL_DEFINITIONS.ls.parameters,
        execute: async (_id, params) => call("ls", params as Record<string, unknown>),
      },
      {
        name: "bash",
        label: "bash",
        description:
          "Run a bash command in a legacy project VM only. DO-backed projects reject this; use project file tools plus build_project, deploy_project, and add_dependency instead. Requires the unique workspace project name and a concise description. Commands run from /workspace by default; pass cwd only for subdirectories in that checkout. Use js_exec when orchestrating several tool calls in JavaScript.",
        parameters: BASH_TOOL.parameters,
        execute: async (_id, params) => call("bash", params as Record<string, unknown>),
        executionMode: "sequential",
      },
      {
        name: "js_exec",
        label: "JavaScript",
        description: JS_EXEC_DESCRIPTION,
        parameters: Type.Object({
          description: Type.String({
            description:
              "Required concise description of what this JavaScript will do. This is shown in the chat UI.",
          }),
          code: Type.String(),
          timeoutMs: Type.Optional(Type.Number({
            description:
              `Optional wall-clock timeout in milliseconds for this JavaScript run. Defaults to ${CODE_MODE_DEFAULT_TIMEOUT_MS}ms and can be raised up to ${CODE_MODE_MAX_TIMEOUT_MS}ms for longer-running scripts.`,
          })),
          maxOutputCharacters: Type.Optional(Type.Number()),
        }),
        execute: async (toolUseId, params) => {
          const raw = params as {
            code?: unknown;
            description?: unknown;
            timeoutMs?: unknown;
            maxOutputCharacters?: unknown;
          };
          const result = await this.keepPiTurnToolProgressAliveWhile(() => this.runCodeModeJavascript({
            code: typeof raw.code === "string" ? raw.code : "",
            orgId: context.orgId,
            workspaceId: context.workspaceId,
            threadId: context.threadId,
            userId: context.userId ?? undefined,
            toolUseId,
            timeoutMs: typeof raw.timeoutMs === "number" ? raw.timeoutMs : null,
            maxOutputCharacters:
              typeof raw.maxOutputCharacters === "number"
                ? raw.maxOutputCharacters
                : null,
          }));
          return {
            content: [{ type: "text" as const, text: result.text }],
            details: result,
          };
        },
        executionMode: "sequential",
      },
    ];

    for (const definition of CODE_MODE_PI_PASSTHROUGH_TOOL_DEFINITIONS) {
      const { name } = definition;
      // Hidden tools (deprecated aliases) never register top-level.
      if (definition.hidden) continue;
      // Drop long-tail-category passthrough tools from the top-level list; they stay
      // reachable inside js_exec and discoverable via tools.search(). Human-input tools
      // and app/project-lifecycle categories are always kept top-level.
      if (
        !ALWAYS_TOP_LEVEL_PASSTHROUGH_NAMES.has(name) &&
        TOP_LEVEL_EXCLUDED_CATEGORIES.has(definition.category)
      ) {
        continue;
      }
      definitions.push({
        name,
        label: name,
        description: definition.description,
        parameters: definition.parameters,
        execute: async (toolUseId, params) => {
          const raw = params && typeof params === "object"
            ? params as Record<string, unknown>
            : {};
          return call(name, {
            ...raw,
            toolUseId,
          });
        },
        executionMode: "sequential",
      });
    }

    if (options.includeSubagents !== false) {
      const runAgent = (
        toolName: "Agent" | "Explore",
        params: unknown,
        signal?: AbortSignal,
        onUpdate?: (partialResult: AgentToolResult<unknown>) => void,
      ) => this.keepPiTurnToolProgressAliveWhile(() =>
        this.runPiSubagentTool(context, toolName, params, signal, onUpdate)
      );

      definitions.push(
        {
          name: "Agent",
          label: "Agent",
          description:
            "Run a focused subagent in the same workspace. Use this for bounded investigation or implementation tasks that benefit from an isolated context.",
          parameters: Type.Object({
            prompt: Type.String(),
            description: Type.Optional(Type.String()),
            agent: Type.Optional(Type.String()),
            model: Type.Optional(Type.String()),
          }),
          execute: async (_id, params, signal, onUpdate) =>
            runAgent("Agent", params, signal, onUpdate),
          executionMode: "sequential",
        },
        {
          name: "Explore",
          label: "Explore",
          description:
            "Run a focused read-oriented exploration subagent in the same workspace. Use this to inspect code and report findings.",
          parameters: Type.Object({
            prompt: Type.Optional(Type.String()),
            query: Type.Optional(Type.String()),
            description: Type.Optional(Type.String()),
            agent: Type.Optional(Type.String()),
            model: Type.Optional(Type.String()),
          }),
          execute: async (_id, params, signal, onUpdate) =>
            runAgent("Explore", params, signal, onUpdate),
          executionMode: "sequential",
        },
      );
    }

    return definitions;
  }

  private async runPiSubagentTool(
    context: ChatContextState,
    toolName: "Agent" | "Explore",
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: (partialResult: AgentToolResult<unknown>) => void,
  ): Promise<AgentToolResult<unknown>> {
    const raw = params && typeof params === "object"
      ? params as Record<string, unknown>
      : {};
    const isExplore = toolName === "Explore";
    const prompt =
      typeof raw.prompt === "string" && raw.prompt.trim()
        ? raw.prompt.trim()
        : typeof raw.query === "string" && raw.query.trim()
          ? raw.query.trim()
          : "";
    if (!prompt) {
      throw new Error(`${toolName} requires a prompt`);
    }

    const { Agent } = await import("@earendil-works/pi-agent-core");
    const { getModel, streamSimple } = await import("@earendil-works/pi-ai/compat");
    const resolveCurrentModel =
      this.piModelResolver ?? (() => this.resolvePiModel(context, {}, getModel));
    let modelConfig = await resolveCurrentModel();
    const child = new Agent({
      initialState: {
        systemPrompt: await this.createPiSubagentSystemPrompt(context, isExplore),
        model: modelConfig.model,
        tools: this.createPiToolDefinitions(context, {
          includeSubagents: false,
        }),
        messages: [],
        thinkingLevel: "medium",
      },
      getApiKey: async () => {
        const current = await resolveCurrentModel();
        modelConfig = current;
        child.state.model = current.model;
        return current.apiKey;
      },
      afterToolCall: (toolContext, signal) =>
        this.afterPiToolCall(toolContext, signal),
      streamFn: (model, llmContext, options) =>
        this.streamPiModel(model, llmContext, options, streamSimple),
      sessionId: `${context.threadId}:${toolName}:${crypto.randomUUID()}`,
      toolExecution: "parallel",
    });

    let assistantText = "";
    let latestAssistantText = "";
    let toolUseCount = 0;
    let turnStartedAtMs = Date.now();
    let finalMessages: AgentMessage[] = [];
    const startedAtMs = Date.now();

    const update = (text: string, details: Record<string, unknown>) => {
      onUpdate?.({
        content: [{ type: "text", text }],
        details,
      });
    };

    const unsubscribe = child.subscribe((event) => {
      try {
        if (event.type === "turn_start") {
          turnStartedAtMs = Date.now();
          return;
        }
        if (event.type === "message_update") {
          const assistantEvent = event.assistantMessageEvent as {
            type?: string;
            delta?: string;
          };
          if (assistantEvent.type === "text_delta" && assistantEvent.delta) {
            assistantText += assistantEvent.delta;
          }
          return;
        }
        if (event.type === "message_end") {
          latestAssistantText = this.extractPiMessageText(event.message) || assistantText;
          return;
        }
        if (event.type === "tool_execution_start") {
          toolUseCount += 1;
          update(`Running ${event.toolName}...`, {
            status: "running",
            toolName: event.toolName,
            toolUseCount,
          });
          return;
        }
        if (event.type === "turn_end") {
          const durationMs = Math.max(0, Date.now() - turnStartedAtMs);
          this.ctx.waitUntil(
            this.recordPiAssistantUsage(
              event.message,
              durationMs,
              modelConfig.billingSource,
              modelConfig.creditChargeable,
              modelConfig.usageProvider,
            ).catch((error) => {
              console.error("[ChatThreadDO] failed to record Pi subagent usage", error);
            }),
          );
          return;
        }
        if (event.type === "agent_end") {
          finalMessages = event.messages;
        }
      } catch (error) {
        console.error("[ChatThreadDO] Pi subagent event handler failed", error);
        this.persistPiAgentLoopErrorForDevelopers(error, {
          source: `${toolName}_event_handler`,
          eventType: event.type,
        });
      }
    });

    const abort = () => child.abort();
    if (signal?.aborted) {
      unsubscribe();
      throw new Error(`${toolName} was aborted`);
    }
    signal?.addEventListener("abort", abort, { once: true });

    try {
      update(`${toolName} started.`, {
        status: "running",
        toolName,
      });
      await child.prompt({
        role: "user",
        content: isExplore
          ? `Explore the workspace and answer this request. Do not edit files.\n\n${prompt}`
          : prompt,
        timestamp: Date.now(),
      } as AgentMessage);
    } finally {
      signal?.removeEventListener("abort", abort);
      unsubscribe();
    }

    const finalText =
      latestAssistantText ||
      this.extractLatestPiAssistantText(finalMessages) ||
      assistantText.trim() ||
      `${toolName} completed without text output.`;
    return {
      content: [{ type: "text", text: finalText }],
      details: {
        status: "completed",
        toolName,
        durationMs: Math.max(0, Date.now() - startedAtMs),
        toolUseCount,
      },
    };
  }

  private async createPiSubagentSystemPrompt(
    context: ChatContextState,
    isExplore: boolean,
  ): Promise<string> {
    return createPiSubagentSystemPrompt(
      context,
      isExplore ? "explore" : "agent",
      {
        skillNames: PI_SKILL_NAMES,
        skillDescriptions: PI_SKILL_DESCRIPTIONS,
      },
    );
  }

  private extractLatestPiAssistantText(messages: AgentMessage[]): string {
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if ((message as { role?: unknown }).role === "assistant") {
        const text = this.extractPiMessageText(message);
        if (text) return text;
      }
    }
    return "";
  }

  private latestPiAssistantMessage(messages: AgentMessage[]): AgentMessage | null {
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if ((message as { role?: unknown }).role === "assistant") {
        return message;
      }
    }
    return null;
  }

  private extractPiMessageText(message: AgentMessage): string {
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") return content.trim();
    if (!Array.isArray(content)) return "";
    return content
      .filter((part): part is { type: string; text: string } =>
        part &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string",
      )
      .map((part) => part.text)
      .join("")
      .trim();
  }

  private pushPiRuntimeEvent(method: string, params: Record<string, unknown>): void {
    this.pushChatEvent({
      type: "runtime_event",
      event: {
        method,
        params,
      },
    });
  }

  private piRuntimeThreadId(): string {
    return this.chatContext?.threadId || "";
  }

  private piRuntimeToolItem(
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown> | null,
    status: string,
  ): Record<string, unknown> {
    const normalizedArgs = args ?? {};
    if (toolName.toLowerCase() === "bash") {
      return {
        id: toolCallId,
        type: "commandExecution",
        command: typeof normalizedArgs.command === "string" ? normalizedArgs.command : "",
        cwd: normalizedArgs.cwd,
        status,
        ...(typeof normalizedArgs.description === "string" && normalizedArgs.description
          ? { description: normalizedArgs.description }
          : {}),
      };
    }
    return {
      id: toolCallId,
      type: "dynamicToolCall",
      tool: toolName || "tool",
      arguments: normalizedArgs,
      status,
    };
  }

  private piEventArgs(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  }

  private rememberPiToolArgs(toolCallId: string, args: Record<string, unknown>): Record<string, unknown> {
    const existing = this.piToolArgs.get(toolCallId) ?? {};
    const merged = { ...existing, ...args };
    this.piToolArgs.set(toolCallId, merged);
    return merged;
  }

  private recallPiToolArgs(toolCallId: string, args: Record<string, unknown>): Record<string, unknown> {
    const existing = this.piToolArgs.get(toolCallId) ?? {};
    const merged = { ...existing, ...args };
    this.piToolArgs.delete(toolCallId);
    return merged;
  }

  private piToolResultText(result: unknown): string {
    if (typeof result === "string") return result;
    if (result && typeof result === "object") {
      const record = result as Record<string, unknown>;
      if (typeof record.text === "string") return record.text;
      const content = record.content;
      if (Array.isArray(content)) {
        return content
          .map((item) => {
            if (!item || typeof item !== "object") return "";
            const part = item as Record<string, unknown>;
            return typeof part.text === "string" ? part.text : "";
          })
          .filter(Boolean)
          .join("\n");
      }
    }
    return "";
  }

  private piRuntimeContentItems(result: unknown): unknown[] {
    if (!result || typeof result !== "object") return [];
    const content = (result as Record<string, unknown>).content;
    return Array.isArray(content) ? content : [];
  }

  private latestPiAssistantForkEntryId(messages: AgentMessage[]): string | null {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const record = messages[index] as unknown as Record<string, unknown>;
      if (record.role !== "assistant") continue;
      if (typeof record.responseId === "string" && record.responseId.trim()) {
        return record.responseId.trim();
      }
      const timestamp = typeof record.timestamp === "number" && Number.isFinite(record.timestamp)
        ? record.timestamp
        : Date.now();
      return `pi_assistant_${timestamp}_${index}`;
    }
    return null;
  }

  private isPiAssistantMessage(message: AgentMessage): boolean {
    return (message as unknown as Record<string, unknown>).role === "assistant";
  }

  private async handlePiSessionEvent(event: AgentEvent): Promise<void> {
    this.touchPiTurnProgress();
    if (event.type === "agent_start") {
      this.piAssistantText = "";
      this.piActiveItemText = "";
      this.piActiveItemId = null;
      this.piReasoningItemId = null;
      this.piToolArgs = new Map();
      this.piAgentStartedAtMs = Date.now();
      this.piTurnStartedAtMs = Date.now();
      this.piUserStopRequestedAtMs = 0;
      this.piLastTurnUsage = null;
      this.piSdkTurnIndex = 0;
      this.piSdkTurnUsageTotal = null;
      // Provider config is read once per agent turn: the first LLM call after
      // this re-reads from OrgDO and every later call in the turn reuses it.
      this.cachedLlmProviderConfig = null;
      this.resetRunningActivityState();
      // New turn: reset the overlay so the browser stops showing the previous
      // turn's tail (the previous turn-end frame's finalMessages already
      // committed it to client history).
      this.hydrateLiveStateFromAgentState();
      this.liveMessages = [];
      this.liveStreamingMessageId = null;
      this.pendingOverlayArtifacts?.clear();
      // A fresh turn supersedes any prior terminal error.
      this.lastError = null;
      // agent_start is the one turn-start hook for every run (prompt, resume, eval).
      this.markTurnStarted();
      // NOTE: do NOT open the recovery marker here. agent_start also fires for
      // non-fibered turns (e.g. the eval runner's direct piSession.prompt), which
      // have no cf_agents_runs row — opening a marker there would leave stale
      // recovery state that never recovers and shows the thread as busy. The
      // marker is opened only inside the chat turn's runFiber wrapper, so it
      // exists exactly when there is a durable fiber that can drive recovery.
      return;
    }

    if (event.type === "turn_start") {
      this.piTurnStartedAtMs = Date.now();
      this.piSdkTurnIndex += 1;
      this.pushPiRuntimeEvent("sdk/turn/started", {
        threadId: this.piRuntimeThreadId(),
        sdkTurnIndex: this.piSdkTurnIndex,
        startedAtMs: this.piTurnStartedAtMs,
      });
    }

    if (event.type === "turn_end") {
      if (
        this.piUserStopRequestedAtMs > 0 &&
        this.isAbortedPiAssistantMessage(event.message)
      ) {
        return;
      }

      if (this.isFailedPiAssistantMessage(event.message)) {
        this.discardUnpersistedPiSessionMessages();
        return;
      }

      const snapshot = this.piSession?.state.messages ?? [];
      const snapshotMessages = await Promise.all(
        snapshot
          .slice(this.piMainBaselineIndex)
          .map((message) => this.attachCodeModeArtifactsToToolResult(message, { consume: true })),
      );
      const newMessages = this.annotatePiProviderErrorMessages(snapshotMessages);
      if (newMessages.length > 0) {
        await this.appendPiCoreMessagesIfMissing(newMessages);
        this.piMainBaselineIndex = snapshot.length;
      }
      // This turn is committed to pi_core_messages; drop its journaled tail (the
      // agent run may still have more turns, which will re-journal their tail).
      this.clearPiTurnJournal();
      const durationMs = this.piTurnStartedAtMs
        ? Date.now() - this.piTurnStartedAtMs
        : 0;
      const billingSource = this.piCurrentBillingSource;
      const creditChargeable = this.piCurrentCreditChargeable;
      const usageProvider = this.piCurrentUsageProvider;
      this.piLastTurnUsage = this.piRuntimeUsageSummary(event.message);
      this.piSdkTurnUsageTotal = this.addPiRuntimeUsageSummaries(
        this.piSdkTurnUsageTotal,
        this.piLastTurnUsage,
      );
      this.pushPiRuntimeEvent("sdk/turn/completed", {
        threadId: this.piRuntimeThreadId(),
        sdkTurnIndex: this.piSdkTurnIndex,
        completedAtMs: Date.now(),
        durationMs,
        ...(usageProvider ? { provider: usageProvider } : {}),
        ...(this.piLastTurnUsage ? { usage: this.piLastTurnUsage } : {}),
      });
      this.ctx.waitUntil(
        this.recordPiAssistantUsage(
          event.message,
          durationMs,
          billingSource,
          creditChargeable,
          usageProvider,
        ).catch((error) => {
          console.error("[ChatThreadDO] failed to record Pi usage", error);
        }),
      );
    }

    if (event.type === "message_update") {
      const assistantEvent = event.assistantMessageEvent as {
        type?: string;
        contentIndex?: number;
        delta?: string;
        toolCall?: { id?: string; name?: string; arguments?: unknown };
      };
      const threadId = this.piRuntimeThreadId();
      switch (assistantEvent.type) {
        case "start":
          this.piReasoningItemId = null;
          break;
        case "thinking_start": {
          const contentIndex = typeof assistantEvent.contentIndex === "number"
            ? assistantEvent.contentIndex
            : 0;
          if (contentIndex === 0 || !this.piReasoningItemId) {
            this.piReasoningItemId = `pi_reasoning_${crypto.randomUUID()}`;
          }
          this.publishRunningActivity("Thinking", { immediate: true });
          break;
        }
        case "thinking_delta": {
          if (!assistantEvent.delta) break;
          const contentIndex = typeof assistantEvent.contentIndex === "number"
            ? assistantEvent.contentIndex
            : 0;
          if (!this.piReasoningItemId) {
            this.piReasoningItemId = `pi_reasoning_${crypto.randomUUID()}`;
          }
          this.pushPiRuntimeEvent("item/reasoning/textDelta", {
            threadId,
            itemId: this.piReasoningItemId,
            contentIndex,
            delta: assistantEvent.delta,
          });
          break;
        }
        case "text_delta": {
          if (!assistantEvent.delta) break;
          const itemId = this.piActiveItemId || `pi_agent_${crypto.randomUUID()}`;
          this.piActiveItemId = itemId;
          this.piAssistantText += assistantEvent.delta;
          this.piActiveItemText += assistantEvent.delta;
          this.pushPiRuntimeEvent("item/agentMessage/delta", {
            threadId,
            itemId,
            delta: assistantEvent.delta,
          });
          this.publishRunningActivity(this.piActiveItemText);
          break;
        }
        case "toolcall_start": {
          const toolCall = assistantEvent.toolCall ?? {};
          if (typeof toolCall.name !== "string" || !toolCall.name.trim()) {
            break;
          }
          const toolCallId = typeof toolCall.id === "string" && toolCall.id
            ? toolCall.id
            : `pi_tool_${crypto.randomUUID()}`;
          const toolName = toolCall.name.trim();
          const args = this.piEventArgs(toolCall.arguments);
          if (Object.keys(args).length > 0) {
            this.rememberPiToolArgs(toolCallId, args);
          }
          this.publishPiToolActivity(toolCallId, toolName, args, "running");
          this.pushPiRuntimeEvent("item/started", {
            threadId,
            item: this.piRuntimeToolItem(
              toolCallId,
              toolName,
              Object.keys(args).length > 0 ? args : null,
              "running",
            ),
          });
          break;
        }
      }
      return;
    }

    if (event.type === "message_end") {
      const isAssistant = this.isPiAssistantMessage(event.message);
      const text = isAssistant ? this.extractPiMessageText(event.message) : "";
      if (isAssistant && text) {
        const itemId = this.piActiveItemId || `pi_agent_${crypto.randomUUID()}`;
        const shouldSendCompleted = this.piActiveItemText.length === 0;
        if (shouldSendCompleted) {
          this.piAssistantText += text;
          this.piActiveItemText = text;
          this.publishRunningActivity(text, { immediate: true });
          this.pushPiRuntimeEvent("item/completed", {
            threadId: this.piRuntimeThreadId(),
            item: {
              id: itemId,
              type: "agentMessage",
              text,
            },
          });
        }
        this.piActiveItemId = `pi_agent_${crypto.randomUUID()}`;
        this.piActiveItemText = "";
      }
      // Journal the in-flight tail so a mid-turn eviction can recover this
      // assistant message (and any tool calls it issued) before turn_end commits.
      await this.recordPiTurnJournalTail();
      return;
    }

    if (event.type === "tool_execution_start") {
      const toolCallId = event.toolCallId || `pi_tool_${crypto.randomUUID()}`;
      const toolName = event.toolName || "tool";
      const args = this.rememberPiToolArgs(toolCallId, this.piEventArgs(event.args));
      this.publishPiToolActivity(toolCallId, toolName, args, "running");
      this.pushPiRuntimeEvent("item/started", {
        threadId: this.piRuntimeThreadId(),
        item: this.piRuntimeToolItem(toolCallId, toolName, args, "running"),
      });
      return;
    }

    if (event.type === "tool_execution_update") {
      const delta = this.piToolResultText(event.partialResult);
      if (event.toolCallId && delta) {
        this.pushPiRuntimeEvent("item/commandExecution/outputDelta", {
          threadId: this.piRuntimeThreadId(),
          itemId: event.toolCallId,
          delta,
        });
      }
      return;
    }

    if (event.type === "tool_execution_end") {
      const toolCallId = event.toolCallId || `pi_tool_${crypto.randomUUID()}`;
      const toolName = event.toolName || "tool";
      const eventWithArgs = event as typeof event & { args?: unknown };
      const args = this.recallPiToolArgs(toolCallId, this.piEventArgs(eventWithArgs.args));
      const isError = event.isError === true;
      const status = isError ? "failed" : "completed";
      let item: Record<string, unknown> = {
        id: toolCallId,
        type: "dynamicToolCall",
        tool: toolName,
        arguments: args,
        status,
        isError,
        result: event.result,
      };
      const contentItems = this.piRuntimeContentItems(event.result);
      if (contentItems.length > 0) {
        item.contentItems = contentItems;
      }
      if (toolName.toLowerCase() === "bash") {
        item = this.piRuntimeToolItem(toolCallId, toolName, args, status);
        item.isError = isError;
        item.aggregatedOutput = this.piToolResultText(event.result);
        item.result = event.result;
      }
      this.publishPiToolActivity(
        toolCallId,
        toolName,
        args,
        isError ? "error" : "complete",
        event.result,
      );
      this.pushPiRuntimeEvent("item/completed", {
        threadId: this.piRuntimeThreadId(),
        item,
      });
      // Journal the in-flight tail so a completed tool result survives a mid-turn
      // eviction and is not re-run on resume.
      await this.recordPiTurnJournalTail();
      return;
    }

    if (event.type === "agent_end") {
      const stoppedByUserAtMs = this.piUserStopRequestedAtMs;
      const stoppedByUser = stoppedByUserAtMs > 0;
      const newMessages = this.annotatePiProviderErrorMessages(
        stoppedByUser
          ? this.ensurePiUserStopMessage(event.messages, stoppedByUserAtMs)
          : this.ensurePiAssistantTextMessage(
              event.messages,
              this.piAssistantText,
            ),
      );
      this.maybeSchedulePiPostTurnCompaction(newMessages);
      if (stoppedByUser) {
        // The turn was aborted before turn_end could snapshot it, so persist
        // the uncommitted tail of the live session directly.
        const session = this.piSession;
        const sessionMessages = session?.state.messages ?? [];
        const uncommitted = await Promise.all(
          sessionMessages
            .slice(this.piMainBaselineIndex)
            .filter((message) => !this.isEmptyAbortedPiAssistantMessage(message))
            .map((message) =>
              this.attachCodeModeArtifactsToToolResult(message, { consume: true }),
            ),
        );
        const messagesToPersist = this.dedupePiMessagesByKey([
          ...this.annotatePiProviderErrorMessages(uncommitted),
          ...newMessages,
        ]);
        if (messagesToPersist.length > 0) {
          await this.appendPiCoreMessagesIfMissing(messagesToPersist);
          if (session?.state.messages) {
            const baselineMessages = sessionMessages.slice(0, this.piMainBaselineIndex);
            const baselineKeys = baselineMessages.map((message) =>
              this.piCoreMessageKey(message),
            );
            const messagesForSession = this.dedupePiMessagesByKey(
              messagesToPersist,
              baselineKeys,
            );
            session.state.messages = [...baselineMessages, ...messagesForSession];
            this.piMainBaselineIndex = baselineMessages.length + messagesForSession.length;
          }
        }
      } else {
        this.discardUnpersistedPiSessionMessages();
      }
      const completedAtMs = Date.now();
      const turnStartedAtMs =
        this.piAgentStartedAtMs || this.piTurnStartedAtMs || completedAtMs;
      const turnDurationMs = Math.max(0, completedAtMs - turnStartedAtMs);
      this.piAgentStartedAtMs = 0;
      const threadId = this.chatContext?.threadId || "";
      const finalText = stoppedByUser
        ? PI_USER_STOP_TEXT
        : this.piAssistantText || this.extractLatestPiAssistantText(newMessages);
      const errorMessage = finalText
        ? ""
        : this.getLatestPiAssistantErrorMessage(newMessages);
      const summarySource = extractThreadCompletionSummarySource(
        newMessages,
        finalText || errorMessage,
      );
      const forkEntryId = this.latestPiAssistantForkEntryId(newMessages);
      if (stoppedByUser) {
        this.pushPiRuntimeEvent("item/agentMessage/delta", {
          threadId,
          itemId: forkEntryId || `pi_user_stop_${stoppedByUserAtMs}`,
          itemKind: "userStop",
          delta: PI_USER_STOP_TEXT,
        });
      }
      this.pushPiRuntimeEvent("turn/completed", {
        threadId,
        ...(forkEntryId ? { forkEntryId } : {}),
        completedAtMs,
        turnDurationMs,
        ...(this.piSdkTurnUsageTotal ? { usage: this.piSdkTurnUsageTotal } : {}),
        ...(this.piSdkTurnIndex > 0 ? { sdkTurnCount: this.piSdkTurnIndex } : {}),
      });
      this.pushChatEvent({
        type: "result",
        threadId,
        result: finalText,
        sessionId: threadId,
        completedAt: completedAtMs,
      });
      if (stoppedByUser) {
        this.updateActiveAutomationRun({
          status: "error",
          message: PI_USER_STOP_TEXT,
          completedAt: completedAtMs,
          clear: true,
        });
      } else if (!finalText && errorMessage) {
        this.pushChatEvent(this.piProviderErrorEvent(errorMessage));
        this.updateActiveAutomationRun({
          status: "error",
          message: errorMessage,
          completedAt: completedAtMs,
          clear: true,
        });
      }
      this.finishTurn({
        markUnread: true,
        completedAt: completedAtMs,
        summarySource,
      });
      this.setActiveTurnUserId(null);
      this.completeTodoStateForTurnEnd();
      this.piActiveItemId = null;
      this.piActiveItemText = "";
      this.piReasoningItemId = null;
      this.piToolArgs = new Map();
      this.piAssistantText = "";
      this.piUserStopRequestedAtMs = 0;
      this.resetRunningActivityState();
      // The run is complete (success, user-stop, or a surfaced error): the turn is
      // no longer in flight, so clear the resume marker, journal, and alarm.
      await this.clearPiActiveTurnAndJournal();
      return;
    }

  }

  private piRuntimeUsageSummary(message: AgentMessage): Record<string, unknown> | null {
    if (message.role !== "assistant") return null;
    const usage = (message as AgentMessage & {
      usage?: {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
        totalTokens?: number;
        cost?: { total?: number };
      };
    }).usage;
    if (!usage) return null;

    const input = Math.max(0, Math.floor(Number(usage.input ?? 0)));
    const output = Math.max(0, Math.floor(Number(usage.output ?? 0)));
    const cacheRead = Math.max(0, Math.floor(Number(usage.cacheRead ?? 0)));
    const cacheWrite = Math.max(0, Math.floor(Number(usage.cacheWrite ?? 0)));
    const totalTokens = Math.max(
      input + output + cacheRead + cacheWrite,
      Math.floor(Number(usage.totalTokens ?? 0)),
    );
    if (totalTokens <= 0) return null;

    const costTotal = Number(usage.cost?.total);
    return {
      input,
      output,
      cacheRead,
      cacheWrite,
      totalTokens,
      ...(Number.isFinite(costTotal) && costTotal > 0
        ? { cost: { total: costTotal } }
        : {}),
    };
  }

  private addPiRuntimeUsageSummaries(
    current: Record<string, unknown> | null,
    next: Record<string, unknown> | null,
  ): Record<string, unknown> | null {
    if (!next) return current;
    const sum = (key: string) =>
      Math.max(0, Math.floor(Number(current?.[key] ?? 0))) +
      Math.max(0, Math.floor(Number(next[key] ?? 0)));
    const currentCost = Number((current?.cost as { total?: unknown } | undefined)?.total ?? 0);
    const nextCost = Number((next.cost as { total?: unknown } | undefined)?.total ?? 0);
    const costTotal =
      (Number.isFinite(currentCost) && currentCost > 0 ? currentCost : 0) +
      (Number.isFinite(nextCost) && nextCost > 0 ? nextCost : 0);
    return {
      input: sum("input"),
      output: sum("output"),
      cacheRead: sum("cacheRead"),
      cacheWrite: sum("cacheWrite"),
      totalTokens: sum("totalTokens"),
      ...(costTotal > 0 ? { cost: { total: costTotal } } : {}),
    };
  }

  private async recordPiAssistantUsage(
    message: AgentMessage,
    durationMs: number,
    billingSource: PiBillingSource,
    creditChargeable: boolean,
    usageProvider?: string | null,
  ): Promise<void> {
    if (message.role !== "assistant" || !this.chatContext) return;

    const assistant = message as AgentMessage & {
      provider?: string;
      model?: string;
      responseModel?: string;
      responseId?: string;
      usage?: {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
        totalTokens?: number;
        cost?: {
          total?: number;
        };
      };
    };
    const usage = assistant.usage;
    if (!usage) return;

    const inputTokens = Math.max(0, Math.floor(Number(usage.input ?? 0)));
    const outputTokens = Math.max(0, Math.floor(Number(usage.output ?? 0)));
    const cacheReadTokens = Math.max(0, Math.floor(Number(usage.cacheRead ?? 0)));
    const cacheWriteTokens = Math.max(0, Math.floor(Number(usage.cacheWrite ?? 0)));
    if (
      inputTokens <= 0 &&
      outputTokens <= 0 &&
      cacheReadTokens <= 0 &&
      cacheWriteTokens <= 0
    ) {
      return;
    }

    const context = this.chatContext;
    const usageSourceId = this.piUsageSourceId(
      context.threadId,
      assistant,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
    );
    const orgId = this.env.ORG.idFromName(context.orgId);
    const getOrgStub = () => this.env.ORG.get(orgId);
    await this.retryChatDurableObjectRpc(
      "OrgDO.recordUsage",
      () =>
        getOrgStub().recordUsage({
          workspace_id: context.workspaceId,
          user_id: context.userId ?? "",
          thread_id: context.threadId,
          model: assistant.responseModel || assistant.model || "unknown",
          provider: usageProvider || assistant.provider || "unknown",
          billing_source: billingSource,
          credit_chargeable: billingSource === "hosted" && creditChargeable,
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cache_creation_input_tokens: cacheWriteTokens,
          cache_read_input_tokens: cacheReadTokens,
          cost_usd:
            typeof usage.cost?.total === "number" && usage.cost.total > 0
              ? usage.cost.total
              : undefined,
          duration_ms: durationMs,
          created_at_ms: Date.now(),
          source: "pi_assistant",
          source_id: usageSourceId,
        }),
      { attempts: 4, initialDelayMs: 150 },
    );
  }

  private piUsageSourceId(
    threadId: string,
    assistant: {
      responseId?: string;
      responseModel?: string;
      model?: string;
      timestamp?: number;
    },
    inputTokens: number,
    outputTokens: number,
    cacheReadTokens: number,
    cacheWriteTokens: number,
  ): string {
    const responseId = assistant.responseId?.trim();
    if (responseId) {
      return `${threadId}:response:${responseId}`;
    }
    const model = assistant.responseModel || assistant.model || "unknown";
    const timestamp =
      typeof assistant.timestamp === "number" && Number.isFinite(assistant.timestamp)
        ? Math.floor(assistant.timestamp)
        : Date.now();
    return [
      threadId,
      "assistant",
      timestamp,
      model,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
    ].join(":");
  }

  private sendRunnerCommand(message: Record<string, unknown>): boolean {
    const type = typeof message.type === "string" ? message.type : "unknown";
    if (this.piSession) {
      try {
        if (type === "message") {
          const content = typeof message.content === "string" ? message.content : "";
          if (!content.trim()) {
            return false;
          }
          const wasStreaming = this.piSession.state.isStreaming;
          // Reuse the caller's timestamp when provided so a message persisted up
          // front (the new-turn path in enqueueRunnerUserMessage) shares its
          // piCoreMessageKey with the one Pi commits at turn end.
          const timestamp =
            typeof message.timestamp === "number"
              ? message.timestamp
              : Date.now();
          const userMessage: AgentMessage = {
            role: "user",
            content,
            timestamp,
            ...(wasStreaming
              ? { metadata: { sentDuringStreaming: true } }
              : {}),
          } as unknown as AgentMessage;
          // True only once we enter the fibered new-turn branch below, so the error
          // handler clears recovery state only for a turn THIS call made recoverable
          // (never a different, already-streaming turn whose steer/refresh threw).
          let recoverableTurnStarted = false;
          this.ctx.waitUntil(
            (async () => {
              if (!this.piSession) return;
              if (this.piSession.state.isStreaming) {
                // Durably journal the accepted message BEFORE any await, so an
                // eviction in the window before Pi drains the in-memory steering
                // queue re-delivers it on resume instead of silently losing it. The
                // in-flight turn's own fiber already makes the run recoverable, so
                // the model refresh can stay async here.
                this.recordPiTurnJournalSteerMessage(userMessage);
                await this.refreshPiSessionModel();
                if (!this.piSession) return;
                this.piSession.steer(userMessage);
              } else {
                recoverableTurnStarted = true;
                // Establish durable recoverability in the SAME synchronous tick that
                // persisted isStreaming=true upstream (enqueueRunnerUserMessage) — NO
                // await may run before this. The active-turn marker (kv.put) and
                // journal (sql.exec) are synchronous, and runFiber's own
                // cf_agents_runs INSERT runs synchronously too (before its first
                // keepAlive await), so the marker, journal, AND fiber row are all
                // durable in one tick. The model refresh therefore moves INSIDE the
                // fiber, right before prompt(): left here, its await would open a
                // window where isStreaming is persisted but no run row / marker
                // exists yet, so an eviction (e.g. a deploy) would strand the thread
                // "streaming" forever with nothing for onFiberRecovered to resume.
                this.openPiActiveTurnIfAbsent();
                this.recordPiTurnJournalUserMessage(userMessage);
                // Run the turn inside a durable fiber: it holds keepAlive() for the
                // turn and, if the DO is evicted mid-turn, leaves an orphan run row
                // the SDK detects on the next wake (onFiberRecovered ->
                // resumeInterruptedPiTurn). Normal completion/errors delete the row,
                // so only a true eviction triggers resume.
                await this.runFiber(PI_TURN_FIBER, async () => {
                  await this.withPiTurnInactivityTimeout(async () => {
                    if (!this.piSession) {
                      throw new Error("Pi session was not available for prompt");
                    }
                    await this.refreshPiSessionModel();
                    await this.piSession.prompt(userMessage);
                  });
                });
              }
            })().catch((error) => {
                // An inactivity timeout disposes the Pi session (unsubscribing
                // handlers) before throwing, so no agent_end handler runs to
                // reset streaming state. Treat it as an error condition and do
                // the cleanup here. A genuine user `stop` keeps handlers
                // subscribed, so its AbortError stays benign below.
                const isInactivityTimeout =
                  error instanceof PiTurnInactivityTimeoutError;
                if (
                  !isInactivityTimeout &&
                  error instanceof Error &&
                  (error.name === "AbortError" || /aborted/i.test(error.message))
                ) {
                  return;
                }
                console.error("[ChatThreadDO] Pi prompt failed", error);
                this.persistPiAgentLoopErrorForDevelopers(error, {
                  source: "pi_prompt",
                });
                const errorMessage = isInactivityTimeout
                  ? "The assistant stalled and the turn was stopped after a period of inactivity. Please try again."
                  : error instanceof Error
                    ? error.message
                    : String(error);
                this.pushChatEvent(this.piProviderErrorEvent(errorMessage));
                this.updateActiveAutomationRun({
                  status: "error",
                  message: errorMessage,
                  clear: true,
                });
                this.finishTurn();
                this.setActiveTurnUserId(null);
                // The turn failed before agent_end could clean up (the inactivity
                // timeout disposes the session first). The fiber row is already
                // deleted on error, so clear the recovery marker + journal too —
                // otherwise the next session build treats this stale tail as an
                // interrupted turn and reuses the old attempt budget. Only do this
                // for a turn THIS call made recoverable: a throw from the steer path
                // or refreshPiSessionModel() must not wipe a still-streaming turn's
                // recovery state.
                if (recoverableTurnStarted) {
                  void this.clearPiActiveTurnAndJournal();
                }
              })
              .finally(() => {
                // Post-settle: the fiber row is gone and pi-core is idle, so this
                // broadcast of the derived state is what clears the client spinner.
                this.syncAgentState();
              }),
          );
          return true;
        }
        if (type === "stop") {
          this.piUserStopRequestedAtMs = Date.now();
          this.piSession.abort();
          return true;
        }
        if (type === "question_response") {
          return true;
        }
      } catch (error) {
        console.error("[ChatThreadDO] send Pi command failed", error);
        return false;
      }
    }

    return false;
  }

  private async refreshPiSessionModel(): Promise<void> {
    if (!this.piSession || !this.piModelResolver) {
      return;
    }
    const current = await this.piModelResolver();
    this.piSession.state.model = current.model;
  }

  private recordCurrentThreadError(input: {
    message: string;
    source?: unknown;
    errorKind?: unknown;
    status?: unknown;
    provider?: unknown;
    model?: unknown;
    createdAt?: number;
  }): void {
    const context = this.chatContext;
    const message = input.message.trim();
    if (!context || !message) return;

    const explicitSource =
      typeof input.source === "string" && input.source.trim()
        ? input.source.trim()
        : "";
    const sourceCandidate =
      explicitSource === "chat_thread_do_pi"
        ? "pi_provider"
        : explicitSource || (input.provider ? "pi_provider" : undefined);
    const status = normalizeChatErrorStatus(input.status);
    const source = normalizeChatErrorSource(sourceCandidate);
    const messageNormalized = normalizeChatErrorMessage(message) || "Unknown chat error";
    const errorKind = normalizeChatErrorKind(input.errorKind, messageNormalized, status);
    const provider =
      typeof input.provider === "string" && input.provider.trim()
        ? input.provider.trim()
        : this.piCurrentUsageProvider;
    const model =
      typeof input.model === "string" && input.model.trim()
        ? input.model.trim()
        : this.piSession?.state.model?.id ?? null;
    const previewEvent = buildChatErrorEventPayload({
      threadId: context.threadId,
      orgId: context.orgId,
      workspaceId: context.workspaceId,
      userId: context.userId,
      message,
      source,
      errorKind,
      status,
      provider,
      model,
      createdAt: input.createdAt,
    });
    const fingerprint = createChatErrorFingerprint({
      source,
      messageNormalized,
      errorKind,
      status,
      provider,
      model,
    });
    const key = `${context.threadId}:${fingerprint}`;
    const now = Date.now();
    if (!this.recordedChatErrors) {
      this.recordedChatErrors = new Map();
    }
    for (const [existingKey, recordedAt] of this.recordedChatErrors.entries()) {
      if (now - recordedAt > CHAT_ERROR_DEDUPE_WINDOW_MS) {
        this.recordedChatErrors.delete(existingKey);
      }
    }
    const previous = this.recordedChatErrors.get(key);
    if (previous && now - previous <= CHAT_ERROR_DEDUPE_WINDOW_MS) return;
    this.recordedChatErrors.set(key, now);

    this.ctx.waitUntil(
      this.retryChatDurableObjectRpc(
        "OrgDO.recordThreadError",
        () => {
          const orgStub = this.env.ORG.get(this.env.ORG.idFromName(context.orgId));
          return orgStub.recordThreadError(context.threadId, {
            message,
            source: previewEvent.source,
            errorKind,
            status,
            provider,
            model,
            userId: context.userId,
            createdAt: previewEvent.created_at,
          });
        },
        { attempts: 3, initialDelayMs: 150 },
      ).catch((error) => {
        console.error("[ChatThreadDO] failed to record chat error metadata", error);
      }),
    );
  }

  private emitChatError(message: string): void {
    this.pushChatEvent({ type: "error", error: message });
  }

  // Publish the current turn's overlay over the non-durable broadcast channel
  // (no setState/SQLite write — this is live, not durable). Coarse state
  // (isStreaming, lastCompletedTurn, lastError, todos, …) still goes through
  // setState; only the high-frequency streaming tail rides the broadcast.
  private broadcastLiveOverlay(
    options: { throttle?: boolean; finalMessages?: Message[] } = {},
  ): void {
    const threadId = this.chatContext?.threadId;
    if (!threadId) return;
    if (options.throttle) {
      // Coalesce rapid delta broadcasts; a dropped frame only delays rendering —
      // the turn-end frame's finalMessages carry the authoritative content.
      const now = Date.now();
      if (now - this.lastLiveSyncAtMs < LIVE_STATE_SYNC_THROTTLE_MS) return;
      this.lastLiveSyncAtMs = now;
    } else {
      this.lastLiveSyncAtMs = Date.now();
    }
    this.broadcastChat({
      type: "live_overlay",
      threadId,
      messages: this.liveMessages,
      streamingMessageId: this.liveStreamingMessageId,
      ...(options.finalMessages && options.finalMessages.length > 0
        ? { finalMessages: options.finalMessages }
        : {}),
    });
  }

  // Send the current overlay to a single (re)connecting client so a warm
  // reconnect recovers the in-progress turn without it being persisted in state.
  //
  // When there IS a live overlay (warm reconnect mid-turn), send it so streaming
  // resumes. When the overlay is empty we send an empty snapshot ONLY if the thread
  // is actually idle: if the turn finished while the client was disconnected, the
  // client still holds its pre-disconnect streaming tail — the empty snapshot
  // clears it (the reconnect revalidation reloads the committed messages).
  //
  // But an empty overlay does NOT imply idle: a cold-woken DO mid-turn also has an
  // empty overlay (the non-durable tail isn't restored on wake) while
  // isThreadStreaming() is still true from the durable active-turn marker. Clearing
  // the client's tail there would blank a still-streaming message, so keep the
  // no-op and let the resuming turn's deltas drive the client.
  private sendLiveOverlayToConnection(connection: Connection): void {
    const threadId = this.chatContext?.threadId;
    if (!threadId) {
      return;
    }
    const hasOverlay =
      Array.isArray(this.liveMessages) && this.liveMessages.length > 0;
    if (!hasOverlay && this.isThreadStreaming()) {
      return;
    }
    try {
      connection.send(
        JSON.stringify({
          type: "live_overlay",
          threadId,
          messages: hasOverlay ? this.liveMessages : [],
          streamingMessageId: this.liveStreamingMessageId,
        }),
      );
    } catch {
      // Dead connection; ignore.
    }
  }

  // Bound oversized streamed tool/text blocks in the live overlay so the
  // broadcast snapshot stays well under the WS frame limit. Runs every event so
  // memory stays bounded and subsequent deltas append from the capped content.
  private boundLiveOverlaySize(): void {
    if (!Array.isArray(this.liveMessages) || this.liveMessages.length === 0) return;
    let changed = false;
    const next = this.liveMessages.map((message) => {
      if (!Array.isArray(message.content)) return message;
      let blockChanged = false;
      const content = message.content.map((block) => {
        const record = block as unknown as Record<string, unknown>;
        if (
          record.type === "tool_result" &&
          typeof record.content === "string" &&
          record.content.length > MAX_LIVE_OVERLAY_BLOCK_CHARS
        ) {
          blockChanged = true;
          return { ...block, content: boundLiveOverlayText(record.content) };
        }
        if (
          record.type === "text" &&
          typeof record.text === "string" &&
          record.text.length > MAX_LIVE_OVERLAY_BLOCK_CHARS
        ) {
          blockChanged = true;
          return { ...block, text: boundLiveOverlayText(record.text) };
        }
        return block;
      });
      if (!blockChanged) return message;
      changed = true;
      return { ...message, content };
    });
    if (changed) this.liveMessages = next;
  }

  // Build the current turn's assistant/tool messages whole from the broadcast
  // event stream and publish them as the wholesale overlay in Agent state. The
  // browser replaces its overlay with this snapshot on every update (it does
  // not accumulate deltas), so a re-id at turn/completed can never duplicate a
  // message. This is a per-thread DO, so a single streaming id replaces the old
  // per-thread map.
  private applyChatEventToLiveState(payload: Record<string, unknown>): void {
    this.hydrateLiveStateFromAgentState();
    const threadId = this.chatContext?.threadId;
    if (!threadId) return;

    let throttleSync = false;
    if (payload.type === "runtime_event") {
      const event = payload.event as
        | { method?: unknown; params?: Record<string, unknown> }
        | undefined;
      // Streamed token/output deltas are high-frequency; coalesce their syncs.
      // Structural events (item/turn completed, etc.) force a flush.
      const method = typeof event?.method === "string" ? event.method : "";
      throttleSync =
        method.toLowerCase().includes("delta") || method.endsWith("/progress");
      const previousStreamingId = this.liveStreamingMessageId;
      const streamingIds: Record<string, string | null> = {
        [threadId]: this.liveStreamingMessageId,
      };
      this.liveMessages = applyRuntimeEventToMessages(
        this.liveMessages,
        threadId,
        payload.event,
        streamingIds,
      );
      // Bound oversized streamed output every event so memory and the broadcast
      // snapshot stay capped (full output is persisted durably).
      this.boundLiveOverlaySize();
      this.liveStreamingMessageId = streamingIds[threadId] ?? null;
      // Drain any code-mode artifacts whose tool result has now appeared in the
      // overlay (they were recorded before item/completed built it).
      if (this.pendingOverlayArtifacts?.size) {
        for (const [toolUseId, artifacts] of [...this.pendingOverlayArtifacts]) {
          const result = attachArtifactsToToolResultMessages(
            this.liveMessages,
            toolUseId,
            artifacts,
          );
          if (result.attached) {
            this.liveMessages = result.messages;
            this.pendingOverlayArtifacts.delete(toolUseId);
          }
        }
      }
      if (event?.method === "turn/completed") {
        // Key the badge by the assistant message id the browser renders:
        // forkEntryId after finalize, else the streaming id it kept.
        const params = event.params ?? {};
        const forkEntryId =
          typeof params.forkEntryId === "string" && params.forkEntryId.trim()
            ? params.forkEntryId.trim()
            : null;
        const completedId = forkEntryId ?? previousStreamingId;
        if (completedId) {
          this.lastCompletedTurn = {
            id: completedId,
            durationMs:
              typeof params.turnDurationMs === "number" &&
              Number.isFinite(params.turnDurationMs)
                ? Math.max(0, params.turnDurationMs)
                : 0,
            completedAtMs:
              typeof params.completedAtMs === "number" &&
              Number.isFinite(params.completedAtMs)
                ? params.completedAtMs
                : Date.now(),
          };
          // lastCompletedTurn is coarse durable state (drives the badge), so it
          // goes through setState — not the broadcast overlay.
          this.syncAgentState();
        }
      }
    } else if (payload.type === "error") {
      const streamingId = this.liveStreamingMessageId;
      if (streamingId) {
        this.liveMessages = this.liveMessages.map((message) =>
          message.id === streamingId ? { ...message, isStreaming: false } : message,
        );
      }
      this.liveStreamingMessageId = null;
    } else {
      return;
    }

    this.broadcastLiveOverlay({ throttle: throttleSync });
  }

  private piProviderErrorEvent(message: string): Record<string, unknown> {
    const metadata = this.piProviderErrorMetadata(message);
    return {
      type: "error",
      error: message,
      source: "chat_thread_do_pi",
      billingSource: this.piCurrentBillingSource,
      provider: this.piCurrentUsageProvider,
      ...metadata,
    };
  }

  private pushChatEvent(payload: Record<string, unknown>): void {
    const sessionId = this.chatContext?.threadId || "";

    if (payload.type === "error") {
      const message =
        typeof payload.error === "string" && payload.error.trim()
          ? payload.error.trim()
          : typeof payload.message === "string" && payload.message.trim()
            ? payload.message.trim()
            : "";
      if (message) {
        this.recordCurrentThreadError({
          message,
          source: payload.source,
          errorKind: payload.errorType ?? payload.error_kind,
          status: payload.status ?? payload.statusCode,
          provider: payload.provider,
          model: payload.model,
          createdAt: Date.now(),
        });
      }
      // Surface the terminal error through Agent state (with a unique id for
      // one-shot client dedup) so a reconnect after a disconnected/early failure
      // still recovers it — the replay buffer is gone. Cleared at agent_start.
      this.lastError = {
        id: crypto.randomUUID(),
        error: message,
        billingSource:
          typeof payload.billingSource === "string" ? payload.billingSource : null,
        provider: typeof payload.provider === "string" ? payload.provider : null,
        status:
          typeof payload.status === "number" || typeof payload.status === "string"
            ? (payload.status as number | string)
            : null,
        errorType: typeof payload.errorType === "string" ? payload.errorType : null,
      };
      this.syncAgentState();
    }

    const envelope: Record<string, unknown> = {
      ...payload,
      sessionId,
    };

    this.applyChatEventToLiveState(envelope);
    this.agentEvalEventCollector?.push(envelope);
    // runtime_event content and error events both reach the browser through
    // Agent state (the overlay / lastError), not the websocket — broadcasting
    // them here would duplicate (runtime) or be lost on reconnect (error).
    // result/side-channel events are still delivered live over the socket.
    if (envelope.type !== "runtime_event" && envelope.type !== "error") {
      this.broadcastChat(envelope);
    }
  }

  private getChatSockets(): WebSocket[] {
    return Array.from(this.getConnections()) as unknown as WebSocket[];
  }

  private broadcastChat(message: object): void {
    const json = JSON.stringify(message);
    const typed = message as { type?: unknown };
    this.broadcast(json);
  }

}
