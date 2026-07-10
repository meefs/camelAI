
import {
  callable,
  type Connection,
  type ConnectionContext,
  type WSMessage,
} from "agents";
import { AIChatAgent } from "@cloudflare/ai-chat";
import type {
  ChatRecoveryConfig,
  ChatRecoveryExhaustedContext,
} from "@cloudflare/ai-chat";
import type {
  ChatRecoveryContext,
  ChatRecoveryOptions,
} from "@cloudflare/ai-chat";
import {
  CHAT_MESSAGE_TYPES,
  CHAT_RECOVERING_FLAG_TTL_MS,
  CHAT_RECOVERING_KEY,
  CHAT_RECOVERY_INCIDENT_KEY_PREFIX,
} from "agents/chat";
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
  isRetryableAssistantError,
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
// Types only — the `ai` package's runtime surface is heavy and chat-thread-do.ts
// sits in every worker/test isolate's module graph, so its stream builders are
// lazy-loaded via dynamic import() inside onChatMessage (the only runtime user)
// rather than eagerly pulled here. Static value imports from 'ai' roughly double
// the worker test-suite import time and time out unrelated slow tests.
import type { UIMessage, UIMessageStreamWriter } from 'ai';
import {
  PiChunkEncoder,
  piArtifactsPartId,
  piSteerMarkerPartId,
  PI_ERROR_PART_ID,
  PI_STEER_MARKER_PART,
  type PiRuntimeEvent,
  type PiUiMessageChunk,
} from '../../../src/lib/pi-chunk-encoder';
import { messageToUiMessage, uiMessageCreatedAtMs } from '../../../src/lib/ui-message-adapter';
import type { ChatAgentStatePayload } from '../../../src/lib/chat-agent-state';
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
// In-process regeneration budget for a turn whose run SETTLED with a retryable
// transient provider error (e.g. the AI Gateway's mid-stream "Upstream idle
// timeout exceeded"). This is a third, independent retry layer: the
// PI_PROVIDER_* wrapper above retries a transient stream error only BEFORE any
// event was forwarded, and chatRecovery re-drives only evictions/stalls — a
// post-forwarded provider error previously terminal-failed with no final
// message. Classification is pi-ai's isRetryableAssistantError; each attempt
// re-drives resumeActivePiTurn (rebuild from committed history + journal).
const PI_TURN_TRANSIENT_RETRY_ATTEMPTS = 2;
const PI_TURN_TRANSIENT_RETRY_BASE_MS = 500;
const PI_TURN_TRANSIENT_RETRY_MAX_MS = 4_000;
const CHAT_ACTIVE_AUTOMATION_RUN_KEY = "activeAutomationRun";

// Trailing-debounce window for coalescing the high-frequency "thread is still
// streaming" activity updates that ChatThreadDO fan-in RPCs to the single
// WorkspaceDO instance. A burst of running-activity updates for the same thread
// collapses into one RPC carrying the LATEST activity state. Terminal streaming
// transitions (streaming start/stop) bypass this debounce entirely so a
// workspace UI is never stuck showing "streaming".
const WORKSPACE_STREAMING_ACTIVITY_DEBOUNCE_MS = 5_000;
// Liveness-lease heartbeat cadence for the WorkspaceDO running row while a
// turn executes. Must be several times shorter than the WorkspaceDO's
// THREAD_STREAMING_LEASE_TTL_MS so a healthy turn always renews well before
// its lease can expire.
const WORKSPACE_STREAMING_LEASE_REFRESH_MS = 60_000;

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
  hostedRequestProfile?: {
    name: "deepseek-v4-auto-gateway";
    contextWindow?: number;
    maxTokens?: number;
    reasoning?: boolean;
    supportsReasoningEffort?: boolean;
    thinkingFormat?: "openai";
  };
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
  "openrouter/x-ai/grok-4.5": {
    id: "x-ai/grok-4.5",
    name: "xAI: Grok 4.5",
    api: "openai-responses",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 2,
      output: 6,
      cacheRead: 0.5,
      cacheWrite: 0,
    },
    contextWindow: 500000,
    maxTokens: 128000,
  } satisfies Model<"openai-responses">,
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

// The Agent-state payload synced to the browser. Structure (field set /
// nullability / lastError shape) is fixed in the shared module so the DO and the
// client can't drift; the DO instantiates the generic sub-types with its own
// worker-side types.
type ChatThreadAgentState = ChatAgentStatePayload<
  PreviewTarget,
  PendingQuestionInfo,
  PendingConnectionSetupPromptData,
  LlmModel
>;

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
  /** Render-history message id this row streams into (uiMetadata stamp);
   * absent on rows committed before stamping shipped. */
  renderMessageId?: string;
  /** User row accepted while its assistant turn was already streaming. */
  sentDuringStreaming?: boolean;
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
// deploy). ai-chat's `chatRecovery` owns recovery now: a turn runs through
// saveMessages -> _runProgrammaticChatTurn -> onChatMessage, wrapped by ai-chat's
// `_runChatRecoveryFiber`. A mid-turn eviction leaves an ai-chat fiber orphan the
// framework detects on the next wake and re-drives through onChatMessage
// (continueLastTurn for a mid-stream partial, _retryLastUserTurn for a pre-stream
// eviction) under a bounded attempt budget. `piActiveTurn` still marks the
// in-flight turn — it gates the derived spinner (isThreadStreaming), carries the
// stable stream/message id (turnId) so a recovery continuation re-streams into the
// SAME ai-chat assistant message, and pairs with the `pi_turn_journal` table (the
// not-yet-committed model tail) to tell onChatMessage's resume branch *what* to
// continue. The retry/attempt budget lives in chatRecovery, not on the marker.
const PI_ACTIVE_TURN_KEY = "piActiveTurn";
// Durable list (sync KV) of user messages handed to steer() while a turn streams,
// so an eviction before Pi drains them can re-deliver instead of losing them.
const PI_STEER_JOURNAL_KEY = "piSteerJournal";
// User-facing copy delivered as the chatRecovery `terminalMessage` when an
// interrupted turn exhausts its recovery budget (reused from the old resume path).
const PI_RESUME_EXHAUSTED_MESSAGE =
  "This turn was interrupted and could not be resumed automatically. Please send your message again.";

interface PiActiveTurnMarker {
  // The minted assistant-message / stream id for the turn. Persisted so a recovery
  // continuation re-streams into the SAME ai-chat assistant message (its encoder is
  // rebuilt with this id, and ai-chat's continuation clone keeps the same id).
  turnId: string;
  openedAt: number;
}
const CHAT_TODOS_KEY = "chatTodos";
const CHAT_CONTEXT_USED_PERCENT_KEY = "chatContextUsedPercent";
const CHAT_CONTEXT_WINDOW_BY_MODEL_KEY = "chatContextWindowByModel";
const CHAT_ACTIVE_TURN_USER_ID_KEY = "chatActiveTurnUserId";
const PI_TURN_INACTIVITY_TIMEOUT_MS = 10 * 60_000;
const PI_TURN_PROGRESS_INTERVAL_MS = 30_000;

// ai-chat's recovery-bookkeeping storage keys are imported from agents/chat
// (CHAT_RECOVERY_INCIDENT_KEY_PREFIX / CHAT_RECOVERING_KEY /
// CHAT_RECOVERING_FLAG_TTL_MS) so they can never drift from the framework. The
// stale-marker sweep reads them to confirm ai-chat has no in-flight recovery for
// an orphaned turn before clearing it.
const ACTIVE_CHAT_RECOVERY_STATUSES = new Set([
  "detected",
  "scheduled",
  "attempting",
]);

// Chat-protocol wire frames AIChatAgent's constructor-installed onMessage
// wrapper would service from ANY authorized socket. This DO's chat data flow is
// server-driven (sendMessage callable → sendRunnerCommand → saveMessages); no
// browser client legitimately submits these frames, and letting them through
// would allow any workspace member's socket to wipe/forge render history
// (chat_clear / chat_messages), start framework-owned turns (use_chat_request),
// abort the reply stream mid-turn (request_cancel → stall-dispose with the
// active-turn marker left set), or inject tool results/approvals. The guard
// installed in the constructor drops them before the framework handler runs.
// Resume-handshake frames (cf_agent_stream_resume_*) and the Agents SDK
// rpc/state frames are NOT protocol frames of this set and pass through.
const BLOCKED_CHAT_PROTOCOL_FRAME_TYPES = new Set<string>([
  CHAT_MESSAGE_TYPES.CHAT_CLEAR,
  CHAT_MESSAGE_TYPES.CHAT_MESSAGES,
  CHAT_MESSAGE_TYPES.USE_CHAT_REQUEST,
  CHAT_MESSAGE_TYPES.CHAT_REQUEST_CANCEL,
  CHAT_MESSAGE_TYPES.TOOL_RESULT,
  CHAT_MESSAGE_TYPES.TOOL_APPROVAL,
]);
const CHAT_ERROR_DEDUPE_WINDOW_MS = 10_000;

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

// High-water mark for the pi_core → ai-chat render-history top-up backfill
// (see topUpUiMessagesFromPiCore). The value is the count of parsed render
// messages already mirrored into cf_ai_chat_agent_messages; toolResult rows
// merge into their assistant message and internal/empty rows drop, so a parsed
// count (not the raw SQL idx) is the stable high-water unit for the deterministic
// array-index-based render ids. Every pi_core rewrite invalidates the mark;
// replacePiCoreMessages re-pins or rebuilds it per its uiRender option.
const UI_MESSAGES_PI_CORE_HIGH_WATER_KEY = "uiMessagesPiCoreHighWaterIdx";
// Last explicit created_at (ms) written by the backfill, persisted so successive
// top-ups keep strictly increasing timestamps even across DO wakes.
const UI_MESSAGES_PI_CORE_LAST_CREATED_AT_KEY = "uiMessagesPiCoreLastCreatedAtMs";
// One-shot marker for healLegacyUiMessageTimes (rows persisted before the
// pi.createdAtMs / pi.completedAtMs stamps existed render epoch 0 — "4:00 PM"
// in Pacific — until healed from the row's created_at column).
const UI_MESSAGES_TIME_HEAL_KEY = "uiMessagesTimeHealDone";
// Drop-oldest cap for the pre-attach chunk buffer so a turn that never attaches
// a writer (e.g. saveMessages skipped) cannot grow memory without bound.
const PI_STREAM_PRE_ATTACH_CHUNK_CAP = 5000;

// SQLite `current_timestamp` yields "YYYY-MM-DD HH:MM:SS" (UTC, 1s resolution).
// ai-chat orders render history by that column, so backfilled rows format their
// explicit created_at the same way but with milliseconds ("...:SS.mmm"): the
// millisecond suffix sorts lexicographically right after the whole-second live
// rows, keeping backfilled history correctly interleaved with live turns.
function formatAiChatCreatedAt(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace("Z", "");
}

/**
 * ChatThreadDO - One per thread, holds preview state, prompts, browser runner
 * traffic, and agent turns. Sandbox-host remains the backend for workspace
 * file/shell/container operations.
 */
// Extends AIChatAgent for its resumable-stream transport (SQLite chunk
// buffering + replay on reconnect) and, later, chatRecovery. The ai-chat
// message model is transport-internal only: pi_core_messages remains the
// canonical history and the Pi runtime owns the agent loop.
export class ChatThreadDO extends AIChatAgent<ChatAgentEnv, ChatThreadAgentState> {
  private static readonly CONNECTION_SETUP_TIMEOUT_MS = 30 * 60 * 1000;

  private previewTarget: PreviewTarget | null = null;
  private previewTabs: PreviewTarget[] = [];
  private previewActiveTabId: string | null = null;
  private previewVersion: number = 0;

  // Chat bridge state
  private chatContext: ChatContextState | null = null;
  private agentEvalEventCollector: Array<Record<string, unknown>> | null = null;
  private lastError: ChatThreadAgentState["lastError"] = null;
  // Guards the one-time cold-wake reload of lastError.
  private durableStateHydrated: boolean = false;
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
  // Interval renewing the WorkspaceDO running row's liveness lease during a
  // turn; started by markTurnStarted, stopped by resetRunningActivityState.
  private streamingLeaseRefreshTimer: ReturnType<typeof setInterval> | null = null;
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
  // In-process transient-retry state (see PI_TURN_TRANSIENT_RETRY_ATTEMPTS).
  // agent_end defers terminal surfacing of a retryable provider error by
  // setting the pending token; the turn body's retryPiTurnWhileTransient loop
  // consumes it. Both reset at the start of each onChatMessage execute.
  private piTurnTransientRetryAttempts = 0;
  private piPendingTransientTurnRetry: {
    errorText: string;
    provider: string | null;
    model: string | null;
  } | null = null;
  private piTransientRetryBackoffAbort: AbortController | null = null;
  private piLastPersistedLoopError: { fingerprint: string; at: number } | null = null;
  private piRecordedProviderErrors = new Set<string>();
  private recordedChatErrors = new Map<string, number>();

  // --- Native UIMessage stream bridge (commit 6, ai-chat-owned turn) --------
  // onChatMessage OWNS the Pi turn: its stream execute runs the model
  // (prompt for a fresh turn, resume-continue for a recovery) and relays the Pi
  // runtime events through the encoder into native UIMessage chunks. Fresh turns
  // queue their attributed Pi prompts here (in-memory, FIFO): two rapid sends on
  // a cold session both land before prompt() flips isStreaming, so admission
  // must queue rather than overwrite. onChatMessage drains the queue — the first
  // message is prompted, the rest are steer()ed into the just-started run. On a
  // recovery re-drive the queue is empty — the resume branch rebuilds the model
  // turn from the pi_turn_journal (which durably holds every queued user
  // message) instead.
  private pendingPiPromptQueue: Array<{ userMessage: AgentMessage }> = [];
  // The minted stream turnId for the in-flight turn — the id ai-chat adopts as the
  // assistant message id (and the client renders under). Restored from the active-
  // turn marker at the top of onChatMessage so a recovery continuation reuses it.
  // null between turns.
  private activePiStreamTurnId: string | null = null;
  // The stateful encoder for the in-flight turn (created in onChatMessage from the
  // marker turnId). null when no turn is bridging.
  private piChunkEncoder: PiChunkEncoder | null = null;
  // The live ai-chat stream writer once onChatMessage's execute has attached it.
  private piStreamWriter: UIMessageStreamWriter<UIMessage> | null = null;
  // Defensive buffer for any chunk produced before the writer attaches. The turn
  // body runs inside execute (after the writer is set) so this normally stays
  // empty, but it keeps a stray between-attach event from being dropped.
  private piPreAttachChunkBuffer: PiUiMessageChunk[] | null = null;

  // Durable chat recovery (commit 6). MUST be a class field (not set in onStart):
  // the SDK evaluates recovery budgets on wake BEFORE onStart runs. maxAttempts
  // bounds re-drives of an interrupted turn; onExhausted mirrors the old resume
  // give-up cleanup (the framework also delivers `terminalMessage` to the client).
  // Defaults fill stableTimeoutMs / noProgressTimeoutMs / maxOomRetries.
  chatRecovery: ChatRecoveryConfig = {
    maxAttempts: 3,
    terminalMessage: PI_RESUME_EXHAUSTED_MESSAGE,
    onExhausted: (ctx) => this.handlePiRecoveryExhausted(ctx),
  };

  // ai-chat's inter-chunk stall watchdog (commit 7). If no chunk reaches the
  // reply stream within this window the turn is aborted and routed into bounded
  // chatRecovery. Set as a class field (like chatRecovery) so it is live before
  // onStart. This replaces the bespoke `withPiTurnInactivityTimeout` on the
  // bridged turn paths. The watchdog counts REPLY-STREAM chunks, not Pi session
  // progress, and a healthy long turn has legitimate multi-minute wire silences
  // (a tool executing with no output deltas; runtime events the encoder maps to
  // zero chunks) — so genuine liveness is converted into transient
  // `data-pi-heartbeat` chunks ({@link writePiStreamHeartbeat}: 30s cadence while
  // a harness tool executes via keepPiTurnToolProgressAliveWhile, plus one per
  // zero-chunk runtime event in writePiStreamChunks). The watchdog then only
  // trips on a truly dead session (no events, no running tool). onChatMessage
  // wires the watchdog's stream-cancel to dispose the hung Pi session (see
  // {@link onPiReplyStreamCancelled}); the eval path keeps the bespoke wrapper
  // since it prompts the session directly, outside the ai-chat stream.
  chatStreamStallTimeoutMs = PI_TURN_INACTIVITY_TIMEOUT_MS;

  initialState: ChatThreadAgentState = {
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
    // Derived only to seed the initial context-usage estimate; streaming state
    // itself now reaches the browser through the ai-chat hook, not Agent state.
    const isStreaming = this.isThreadStreaming();
    return {
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
      lastError: this.lastError,
      ...overrides,
    };
  }

  // Restore the coarse durable error from Agent state on a cold wake, once.
  // Render history comes from ai-chat; streaming state is derived on read
  // ({@link isThreadStreaming}); only lastError is an instance field that a fresh
  // isolate must reload before the next syncAgentState() would otherwise
  // overwrite it with null.
  private hydrateDurableStateOnce(): void {
    if (this.durableStateHydrated) return;
    this.durableStateHydrated = true;
    const state = this.state as Partial<ChatThreadAgentState> | undefined;
    if (!state) return;
    // NOTE: streaming state is no longer restored here — it is derived on read from
    // execution ground truth ({@link isThreadStreaming}), so a cold wake recomputes
    // it (an evicted mid-turn thread reports streaming via its orphan fiber row /
    // pending resume; a completed one reports idle) with no flag to resurrect.
    if (state.lastError && typeof state.lastError === "object") {
      this.lastError = cloneDurableState(state.lastError);
    }
  }

  private syncAgentState(overrides?: Partial<ChatThreadAgentState>): void {
    this.hydrateDurableStateOnce();
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

    // AIChatAgent's constructor reassigned this.onMessage to a wrapper that
    // services cf_agent_* chat-protocol frames (chat_clear, chat_messages,
    // use_chat_request, request_cancel, tool_result, tool_approval) from any
    // authorized socket BEFORE subclass code runs. This DO never accepts those
    // frames from clients (see BLOCKED_CHAT_PROTOCOL_FRAME_TYPES), so wrap the
    // wrapper: drop the blocked frame types and pass everything else (resume
    // handshake, Agents SDK rpc/state frames, non-JSON) through unchanged.
    const frameworkOnMessage = this.onMessage.bind(this);
    this.onMessage = async (connection: Connection, message: WSMessage) => {
      if (typeof message === "string") {
        let frameType: string | null = null;
        try {
          const parsed = JSON.parse(message) as { type?: unknown } | null;
          frameType =
            parsed && typeof parsed === "object" && typeof parsed.type === "string"
              ? parsed.type
              : null;
        } catch {
          frameType = null;
        }
        if (frameType && BLOCKED_CHAT_PROTOCOL_FRAME_TYPES.has(frameType)) {
          // No frame contents in the event — the type alone is the signal.
          this.recordChatThreadObservabilityEvent("chat_ws_frame_blocked", {
            operation: frameType,
            status: "blocked",
            severity: "warn",
          });
          return;
        }
      }
      return frameworkOnMessage(connection, message);
    };

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
    // Deliver the artifact to the client on the native stream as a standalone
    // data part reconciled by tool call id (full accumulated set each time). The
    // artifact is usually recorded mid-js_exec, possibly after item/completed
    // built the tool result, so a separate part — folded onto the tool_result by
    // uiMessageToMessage at read time — is the right shape. The durable KV row
    // above backs reload/backfill (surfaced onto the tool_result there too).
    this.deliverCodeModeArtifacts(normalizedParentToolUseId, artifacts);
    await this.setPreviewTarget({ kind: "runtime_artifact", artifact });
  }

  // Emit the code-mode artifacts data part into the current turn's native stream.
  // A no-op when no turn is bridging (encoder null) — the artifacts still persist
  // to KV above and reach the client via top-up backfill on the next connect.
  private deliverCodeModeArtifacts(
    parentToolUseId: string,
    artifacts: RuntimeCallArtifact[],
  ): void {
    if (!this.piChunkEncoder) return;
    this.enqueuePiStreamChunks([
      {
        type: "data-pi-artifacts",
        id: piArtifactsPartId(parentToolUseId),
        data: { toolCallId: parentToolUseId, artifacts },
      },
    ]);
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
    this.hydrateDurableStateOnce();
    // super.onStart already let ai-chat evaluate recovery budgets and establish
    // any incident/stream for an interrupted turn, so it is now safe to clear a
    // marker that ai-chat is provably NOT recovering (an old→new deploy orphan).
    await this.sweepOrphanedActiveTurnMarker();
    // PartyServer name bootstrap happens before onStart, not in the constructor.
    // syncAgentState() calls setState(), which emits through PartyServer and needs
    // this.name; doing it here keeps cold-wake state fresh without crashing stale
    // alarm/RPC wakes that haven't initialized the PartyServer name yet.
    this.syncAgentState();
  }

  /**
   * Clear an active-turn marker whose turn is provably dead — nothing owns it and
   * nothing will re-drive it — so {@link isThreadStreaming} (and the workspace
   * thread-list "running" row finishTurn clears) can't report a dead turn as busy
   * forever. Two orphan sources: a marker written by the pre-ai-chat fiber
   * machinery across the old→new recovery boundary (commit 7), and a marker
   * stranded by an ai-chat recovery that gave up SILENTLY — the framework marks
   * its incident "skipped" (conversation_changed / no_unanswered_user_message /
   * continueLastTurn with no assistant) and returns without any app callback, so
   * no terminal path ever clears the marker. Runs at wake (after super.onStart)
   * AND on the page-open reads (getUiMessages, onConnect): a warm isolate never
   * re-runs onStart, so a marker stranded on an alarm wake would otherwise stick
   * for the isolate's whole lifetime — exactly the "thread stuck loading on open"
   * symptom. Clears the marker + journal ONLY when the turn is provably not
   * going to be recovered: no live Pi stream, no pending prompt, no onChatMessage
   * in flight, ai-chat has no active recovery incident
   * (detected/scheduled/attempting) and no non-stale recovering flag, and the
   * marker is not freshly opened (guards a same-wake race with a just-started
   * turn). Fails safe — any read error leaves the marker untouched.
   */
  private async sweepOrphanedActiveTurnMarker(): Promise<void> {
    let marker: PiActiveTurnMarker | null;
    try {
      marker = this.readPiActiveTurn();
    } catch {
      return;
    }
    if (!marker) return;
    // A live/starting turn legitimately owns the marker.
    if (this.piSession?.state.isStreaming) return;
    if (this.activePiStreamTurnId || this.pendingPiPromptQueue.length > 0) return;
    // Only sweep a marker old enough that it cannot be a turn starting on this
    // same wake (the stall timeout is a comfortable floor).
    if (Date.now() - marker.openedAt < PI_TURN_INACTIVITY_TIMEOUT_MS) return;
    // ai-chat still intends to recover this turn — leave it alone.
    if (this.hasActiveChatRecovery()) return;

    this.recordChatThreadObservabilityEvent("pi_turn_marker_swept", {
      operation: "sweep_orphan_marker",
      status: "cleared",
      severity: "warn",
    });
    await this.clearPiActiveTurnAndJournal();
    this.finishTurn();
    this.setActiveTurnUserId(null);
  }

  /**
   * True when ai-chat has an in-flight recovery for the current turn — a recovery
   * incident in an active state (detected/scheduled/attempting) or a non-stale
   * `recovering` flag. Reads ai-chat's own durable bookkeeping (keys imported
   * from agents/chat) through the sync SQLite-backed KV API.
   * Fails safe: on any read error, assume a recovery may be pending (return true)
   * so the sweep never clears a turn ai-chat could still resume.
   */
  private hasActiveChatRecovery(): boolean {
    try {
      const recovering = this.ctx.storage.kv.get<{ at?: number }>(
        CHAT_RECOVERING_KEY,
      );
      if (
        recovering &&
        typeof recovering === "object" &&
        Date.now() - (recovering.at ?? 0) < CHAT_RECOVERING_FLAG_TTL_MS
      ) {
        return true;
      }
      for (const [, incident] of this.ctx.storage.kv.list<{ status?: unknown }>({
        prefix: CHAT_RECOVERY_INCIDENT_KEY_PREFIX,
      })) {
        const status = incident?.status;
        if (
          typeof status === "string" &&
          ACTIVE_CHAT_RECOVERY_STATUSES.has(status)
        ) {
          return true;
        }
      }
      return false;
    } catch (error) {
      console.error(
        "[ChatThreadDO] failed to read chat recovery state for marker sweep",
        error,
      );
      return true;
    }
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

    // Heal a provably-dead turn before this socket derives any busy state from
    // it (working indicator, stale-todo completion below). onStart only covers
    // cold wakes; a marker stranded while the isolate stayed warm (e.g. an
    // ai-chat recovery that skipped silently on an alarm wake) is cleared here,
    // at the moment the user actually opens the thread. Guarded no-op whenever
    // the marker is live, freshly opened, or awaiting recovery.
    await this.sweepOrphanedActiveTurnMarker();

    // Deliver the current render history to THIS socket. Turns can complete
    // while a browser is disconnected (headless saveMessages turns from email/
    // Slack/cron ingress, recovery re-drives) and nothing else replays them to a
    // (re)connecting client: the resumable stream only replays an IN-FLIGHT
    // turn, and Agents SDK state sync carries no chat messages. Uses the same
    // frame shape ai-chat's persistMessages broadcast uses (the client handler
    // replaces its list wholesale), sent only to the new connection.
    if (this.messages.length > 0) {
      try {
        connection.send(
          JSON.stringify({
            messages: this.messages,
            type: CHAT_MESSAGE_TYPES.CHAT_MESSAGES,
          }),
        );
      } catch (error) {
        // A socket that closed mid-connect just reconnects; never fail onConnect.
        console.error(
          "[ChatThreadDO] failed to send render history on connect",
          error,
        );
      }
    }

    if (!this.isThreadStreaming() && this.currentTodos.length > 0) {
      // completeTodoStateForTurnEnd() syncs an override marking the stale todos
      // completed; a second unconditional sync here (with currentTodos already
      // cleared) would erase that checklist, so only sync in the else branch.
      await this.completeTodoStateForTurnEnd();
    } else {
      this.syncAgentState();
    }
    // An in-progress turn's stream is served by ai-chat's resumable stream on
    // reconnect; completed history was hand-delivered above (and the initial
    // page load also reads it via getUiMessages).
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
      await this.replacePiCoreMessages(afterMessages, { uiRender: "rebuild" });
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

    const channelSkeleton = text
      ? this.buildUserUiSkeleton({
          rawContent: text,
          channelHistory: true,
          piCoreMessageKey: sentAt,
        })
      : null;
    const message = this.withPiRenderMessageId(
      {
        role: "user" as const,
        content: lines.join("\n"),
        timestamp: sentAt,
      } satisfies AgentMessage,
      channelSkeleton?.id ?? null,
    );
    await this.appendPiCoreMessagesIfMissing([message]);
    // Mirror the channel event into the linear render history (commit 3b). A
    // direct linear append (persistMessages, not saveMessages) — this is history,
    // not a new agent turn.
    if (channelSkeleton) {
      this.ctx.waitUntil(
        this.persistMessages([...this.messages, channelSkeleton]).catch(
          (error) => {
            console.error(
              "[ChatThreadDO] failed to persist channel-history render message",
              error,
            );
          },
        ),
      );
    }
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

  /**
   * Append a one-off camelAI system notice to this thread's model transcript.
   * The agent sees the `<camelai system message>`-wrapped row on its next
   * cold session build; `visibility: "hidden"` keeps it out of the browser
   * render history entirely (isInternalPiClientMessage). Intended for manual
   * post-migration injection via admin_js_exec; warm sessions pick it up on
   * their next rebuild (a worker deploy resets all sessions). Idempotent per
   * (text, sentAt) via appendPiCoreMessagesIfMissing.
   */
  async appendCamelSystemNotice(input: {
    text: string;
    sentAt?: number;
  }): Promise<{ status: "appended" | "skipped" }> {
    const text = typeof input.text === "string" ? input.text.trim() : "";
    if (!text) return { status: "skipped" };
    const sentAt = Number.isFinite(input.sentAt)
      ? Math.floor(Number(input.sentAt))
      : Date.now();
    const message = {
      role: "user" as const,
      content: ["<camelai system message>", text, "</camelai system message>"].join("\n"),
      timestamp: sentAt,
      visibility: "hidden",
    } as AgentMessage;
    await this.appendPiCoreMessagesIfMissing([message]);
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
    await this.replacePiCoreMessages(cloneDurableState(normalizedMessages), {
      uiRender: "rebuild",
    });
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
   * cache refresh alone doesn't reach an in-flight turn. Disposing aborts the
   * in-flight prompt (onChatMessage swallows the AbortError, leaving the active-turn
   * marker set), and the interrupted turn is re-driven through ai-chat's recovery
   * entry points so its resume streams into the same assistant message.
   */
  private async rebuildPiSessionForConfigChange(lockLabel: string): Promise<void> {
    await this.withRunnerTransitionLock(lockLabel, async () => {
      const wasStreaming = this.isThreadStreaming();
      this.disposePiSession();
      if (wasStreaming) {
        // Fire-and-forget so the transition lock isn't held for the whole resumed
        // turn; ai-chat's turn queue serializes it behind the aborted turn's close.
        this.ctx.waitUntil(
          this.driveConfigChangeResume().catch((error) => {
            console.error("[ChatThreadDO] config-change resume failed", error);
          }),
        );
      }
    });
  }

  /**
   * Re-drive the interrupted turn after a config-change dispose through ai-chat's
   * recovery entry points (both re-enter onChatMessage's resume branch, which
   * rebuilds the session with the new config and folds the journal). Mirrors
   * ai-chat's own retry-vs-continue classification so the resumed output never
   * merges into a prior turn's bubble: continue when this turn already persisted a
   * partial assistant (last-assistant id === the marker's stream id), otherwise
   * retry from the trailing user message (a fresh assistant under the same id).
   */
  private async driveConfigChangeResume(): Promise<void> {
    const marker = this.readPiActiveTurn();
    if (!marker) return;
    const lastAssistant = [...this.messages]
      .reverse()
      .find((message) => message.role === "assistant");
    const agent = this as unknown as {
      continueLastTurn(): Promise<{ status: string }>;
      _retryLastUserTurn(
        clientTools?: unknown,
        body?: unknown,
      ): Promise<{ status: string }>;
    };
    const result =
      lastAssistant && lastAssistant.id === marker.turnId
        ? await agent.continueLastTurn()
        : await agent._retryLastUserTurn();
    if (result.status === "skipped") {
      // The recovery entry point declined to re-drive (no continuable assistant
      // / no unanswered user leaf / conversation changed). Nothing else observes
      // that outcome, so without cleanup the active-turn marker would keep the
      // thread "busy" forever. Close the turn out the same way the exhausted
      // path does.
      this.recordChatThreadObservabilityEvent("pi_turn_resume_skipped", {
        operation: "config_change_resume",
        status: "skipped",
        severity: "warn",
      });
      await this.clearPiActiveTurnAndJournal();
      this.finishTurn();
      this.setActiveTurnUserId(null);
      this.syncAgentState();
    }
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

  /**
   * Rewrite pi_core wholesale. Every rewrite invalidates the render-history
   * high-water mark (its unit is the parsed-render-message COUNT, which a
   * rewrite renumbers), so each caller must say what happens to the ai-chat
   * render mirror:
   *
   *  - `uiRender: "preserve"` — the rewrite only drops/summarizes old rows that
   *    were already mirrored (post-turn compaction): keep the render table
   *    (users keep their full visible history) and re-pin the mark to the new
   *    parsed count so the top-up never re-walks rewritten rows.
   *  - `uiRender: "rebuild"` — the rewrite replaces history semantically (fork
   *    seeding, admin repair): wipe the render table and rebuild it from the
   *    new pi_core via the shared resync.
   */
  private async replacePiCoreMessages(
    messages: AgentMessage[],
    options: { uiRender: "preserve" | "rebuild" },
  ): Promise<void> {
    this.ensurePiCoreTables();
    // Serialize first (this can await R2/image work); swap the table contents
    // with no await between DELETE and the INSERTs so an eviction or a
    // concurrent reader never observes a half-written history.
    const aggregateStats = emptyPiSqlStorageStats();
    const payloads: string[] = [];
    for (const message of messages) {
      const serialized = await this.serializePiMessageForSqlStorageDetailed(message);
      this.addPiSqlStorageStats(aggregateStats, serialized.stats);
      payloads.push(serialized.payload);
    }
    const now = Date.now();
    this.ctx.storage.sql.exec("DELETE FROM pi_core_messages");
    for (let index = 0; index < payloads.length; index += 1) {
      this.ctx.storage.sql.exec(
        "INSERT INTO pi_core_messages (idx, payload, created_at) VALUES (?, ?, ?)",
        index,
        payloads[index],
        now,
      );
    }
    this.recordPiSqlStorageSanitization("replace", aggregateStats, messages.length);
    if (options.uiRender === "rebuild") {
      await this.rebuildUiMessagesFromPiCore();
    } else {
      const parsed = await this.getPiCoreParsedMessages(
        this.chatContext?.threadId ?? "",
      );
      this.ctx.storage.kv.put(UI_MESSAGES_PI_CORE_HIGH_WATER_KEY, parsed.length);
    }
  }

  /**
   * Wipe the ai-chat render mirror and rebuild it from pi_core. Shared by the
   * admin resync RPC and every history-invalidating pi_core rewrite.
   */
  private async rebuildUiMessagesFromPiCore(): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM cf_ai_chat_agent_messages");
    this.ctx.storage.kv.delete(UI_MESSAGES_PI_CORE_HIGH_WATER_KEY);
    this.ctx.storage.kv.delete(UI_MESSAGES_PI_CORE_LAST_CREATED_AT_KEY);
    this.messages = [];
    // ai-chat's persistMessages skips upserts whose serialized form matches its
    // in-memory persisted cache; after wiping the table those entries are stale
    // and would silently drop unchanged rows from the rebuild. The framework's
    // own chat-clear handler clears this cache the same way.
    (
      this as unknown as { _persistedMessageCache?: Map<string, string> }
    )._persistedMessageCache?.clear();
    await this.topUpUiMessagesFromPiCore({ force: true });
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

  /**
   * Stamp assistant rows with the render-history message id they stream into
   * (`uiMetadata.renderMessageId`, the minted turnId) before a pi_core commit.
   * This is the same-content-same-id invariant: the backfill converts stamped
   * rows under exactly the id the live stream persists, so whichever writer
   * runs first, the other's upsert converges on one row — no content-heuristic
   * dedup or persist-ordering gates needed. Copies are stamped (the session's
   * own message objects are not mutated); piCoreMessageKey strips uiMetadata,
   * so dedup keys are unaffected.
   */
  private stampPiRenderMessageId(
    messages: AgentMessage[],
    renderMessageId: string | null,
  ): AgentMessage[] {
    if (!renderMessageId) return messages;
    return messages.map((message) => {
      const record = message as unknown as Record<string, unknown>;
      if (record.role !== "assistant") return message;
      return this.withPiRenderMessageId(message, renderMessageId);
    });
  }

  /** Single-message form of the render-id stamp (any role): user rows carry
   * the id of the ui skeleton persisted for them, assistant rows the turnId. */
  private withPiRenderMessageId(
    message: AgentMessage,
    renderMessageId: string | null,
  ): AgentMessage {
    if (!renderMessageId) return message;
    const record = message as unknown as Record<string, unknown>;
    const existing = normalizePiUiMetadata(record.uiMetadata);
    if (existing?.renderMessageId === renderMessageId) return message;
    return {
      ...record,
      uiMetadata: {
        ...(existing ?? {}),
        renderMessageId,
      } satisfies PiUiMetadata,
    } as unknown as AgentMessage;
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
  private recordPiTurnJournalUserMessage(
    userMessage: AgentMessage,
    options: { append?: boolean } = {},
  ): void {
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
    if (options.append) {
      // The active-turn marker was already open when this message was accepted
      // (a second rapid send, or a send while a recovery is pending): APPEND so
      // the journal keeps every accepted-but-uncommitted user message. The
      // resume fold (planPiTurnResume) handles multiple trailing user rows.
      const rows = this.ctx.storage.sql
        .exec<{ next_seq: number }>(
          "SELECT COALESCE(MAX(seq) + 1, 0) AS next_seq FROM pi_turn_journal",
        )
        .toArray();
      const nextSeq = Math.max(0, Math.floor(Number(rows[0]?.next_seq) || 0));
      this.ctx.storage.sql.exec(
        "INSERT INTO pi_turn_journal (seq, payload, created_at) VALUES (?, ?, ?)",
        nextSeq,
        payload,
        now,
      );
      return;
    }
    this.ctx.storage.sql.exec("DELETE FROM pi_turn_journal");
    // A brand-new turn (no marker was open), so any steer-journal entries are
    // stale leftovers from a prior run — drop them so they can't fold in here.
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
   * Drop failed (stopReason error/aborted) assistant rows from the turn
   * journal. Pi journals the in-flight tail at message_end — INCLUDING the
   * error assistant message a failed run terminates on (the failed turn_end
   * discards the session tail but leaves the journal untouched). A
   * transient-retry resume must not fold that row: planPiTurnResume would see
   * the transcript as already complete (trailing assistant) and commit the
   * error message instead of regenerating. Real work in the journal (the
   * accepted user message, completed tool results) is kept.
   */
  private prunePiTurnJournalFailedAssistantMessages(): void {
    this.ensurePiCoreTables();
    const rows = this.ctx.storage.sql
      .exec<{ seq: number; payload: string }>(
        "SELECT seq, payload FROM pi_turn_journal ORDER BY seq ASC",
      )
      .toArray();
    for (const row of rows) {
      let failed = false;
      try {
        const parsed = JSON.parse(row.payload) as AgentMessage;
        failed = this.isFailedPiAssistantMessage(parsed);
      } catch {
        // Corrupt rows are already skipped by loadPiTurnJournalTail; keep them.
      }
      if (failed) {
        this.ctx.storage.sql.exec(
          "DELETE FROM pi_turn_journal WHERE seq = ?",
          row.seq,
        );
      }
    }
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

  /**
   * Mark a turn in flight (once per turn) so a cold load knows to resume it and
   * derives the busy spinner. The minted turnId is the stable assistant-message /
   * stream id: onChatMessage builds the encoder from it, and a recovery
   * continuation re-streams into the same ai-chat message under it.
   */
  private openPiActiveTurnIfAbsent(): void {
    if (this.readPiActiveTurn()) return;
    this.writePiActiveTurn({
      turnId: crypto.randomUUID(),
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
   * Resume branch of {@link onChatMessage} (commit 6): re-drive an interrupted Pi
   * turn. Runs inside the stream execute when ai-chat re-invokes onChatMessage for
   * a recovery (continueLastTurn for a mid-stream partial, _retryLastUserTurn for a
   * pre-stream eviction) — i.e. when there is no fresh pending prompt. The committed
   * history + journal tail (and any pending steer) were folded into the rebuilt
   * session by {@link createPiSession}; from there either the model still owes
   * output (continue it, streaming into the SAME assistant message via the encoder
   * onChatMessage already attached) or the final assistant message already landed
   * pre-eviction (commit the staged tail and finish the turn).
   *
   * No attempt budget or fiber wrapping here — chatRecovery owns both. Errors
   * propagate to onChatMessage's catch, which runs the shared failure cleanup.
   */
  private async resumeActivePiTurn(): Promise<void> {
    this.recordChatThreadObservabilityEvent("pi_turn_recovery_attempt", {
      operation: "resume_interrupted_turn",
      status: "attempting",
    });
    await this.ensurePiSessionReady();
    const session = this.piSession;
    if (!session) {
      throw new Error(
        "Pi session was not available to resume the interrupted turn",
      );
    }
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
        await this.appendPiCoreMessagesIfMissing(
          this.stampPiRenderMessageId(
            tailWithArtifacts,
            this.activePiStreamTurnId,
          ),
        );
        this.piMainBaselineIndex = messages.length;
        // No continuation streams here, so the encoder never emits the
        // turn/completed metadata. If ai-chat orphan-persisted the interrupted
        // stream's partial (it did whenever the partial carried settled tool
        // results — see onChatRecovery), that live render row already SHOWS this
        // committed content: stamp it with the tail's assistant fork ids so the
        // top-up backfill skips these rows instead of duplicating them. When no
        // partial was persisted there is no row to stamp and the top-up converts
        // the rows exactly once.
        await this.stampLiveAssistantForkEntryIds(tailWithArtifacts);
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
    // emits; the spinner is already derived-on from the active-turn marker. The
    // Pi runtime events stream into the same assistant message through the encoder.
    // The ai-chat stall watchdog (chatStreamStallTimeoutMs) bounds this
    // continuation the same way it bounds a fresh prompt.
    const active = this.piSession;
    if (!active) {
      throw new Error(
        "Pi session was not available to resume the interrupted turn",
      );
    }
    // If ai-chat orphan-persisted a partial for this turn (only done when it
    // carried settled tool results — see onChatRecovery), its trailing
    // incomplete parts (a mid-stream text/reasoning run, a tool call whose input
    // never finished) describe output Pi does NOT continue: the model regenerates
    // its interrupted message from the journal-folded transcript. ai-chat's
    // continuation clones that partial and APPENDS the regenerated stream, so
    // drop the incomplete trailing parts first — otherwise the message renders
    // half text followed by the full regenerated text. Settled parts (completed
    // tools, finished text runs) are earlier, committed work and stay.
    await this.trimIncompleteLiveAssistantParts();
    await active.continue();
    // A successful continuation runs the normal lifecycle; `agent_end` clears the
    // marker + journal.
  }

  /**
   * Stamp the live render row for the in-flight stream (id = the active turnId)
   * with the assistant fork ids (`responseId`s) of pi_core rows whose content it
   * already displays, under `metadata.pi.forkEntryIds`. The top-up backfill
   * treats those ids exactly like the encoder-emitted `forkEntryId`, so the rows
   * are skipped instead of converted into duplicates. No-op when the stream has
   * no persisted render row (nothing displays the content — the top-up then
   * converts it exactly once).
   */
  private async stampLiveAssistantForkEntryIds(
    committedTail: AgentMessage[],
  ): Promise<void> {
    const turnId = this.activePiStreamTurnId;
    if (!turnId) return;
    const live = this.messages.find((message) => message.id === turnId);
    if (!live || live.role !== "assistant") return;
    // responseId is set on every provider-produced assistant message; a rare
    // assistant row without one falls back to a row-index-derived parsed id we
    // cannot know here, so it may still convert once (never a clobber — the
    // upsert identity check is by tool-call id, and such rows carry none).
    const forkIds: string[] = [];
    for (const message of committedTail) {
      const record = message as unknown as Record<string, unknown>;
      if (record.role !== "assistant") continue;
      if (typeof record.responseId === "string" && record.responseId.trim()) {
        forkIds.push(record.responseId.trim());
      }
    }
    if (forkIds.length === 0) return;
    const metadata = ((live as { metadata?: Record<string, unknown> }).metadata ??
      {}) as Record<string, unknown>;
    const pi = (metadata.pi && typeof metadata.pi === "object"
      ? { ...(metadata.pi as Record<string, unknown>) }
      : {}) as Record<string, unknown>;
    const existing = Array.isArray(pi.forkEntryIds)
      ? (pi.forkEntryIds as unknown[]).filter(
          (value): value is string => typeof value === "string" && !!value,
        )
      : [];
    pi.forkEntryIds = Array.from(new Set([...existing, ...forkIds]));
    const updated = {
      ...live,
      metadata: { ...metadata, pi },
    } as UIMessage;
    await this.persistMessages(
      this.messages.map((message) => (message.id === turnId ? updated : message)),
    );
  }

  /**
   * Drop trailing incomplete parts (text/reasoning still `streaming`, tool calls
   * still `input-streaming`) from the live render row of the in-flight stream
   * before a resume continuation appends the regenerated output. See the call
   * site in {@link resumeActivePiTurn}.
   */
  private async trimIncompleteLiveAssistantParts(): Promise<void> {
    const turnId = this.activePiStreamTurnId;
    if (!turnId) return;
    const live = this.messages.find((message) => message.id === turnId);
    if (!live || live.role !== "assistant" || !Array.isArray(live.parts)) return;
    const parts = [...live.parts];
    let trimmed = 0;
    while (parts.length > 0) {
      const last = parts[parts.length - 1] as { state?: unknown };
      if (last?.state === "streaming" || last?.state === "input-streaming") {
        parts.pop();
        trimmed += 1;
        continue;
      }
      break;
    }
    if (trimmed === 0) return;
    const updated = { ...live, parts } as UIMessage;
    await this.persistMessages(
      this.messages.map((message) => (message.id === turnId ? updated : message)),
    );
    this.recordChatThreadObservabilityEvent("pi_turn_partial_trimmed", {
      operation: "resume_interrupted_turn",
      status: "trimmed",
      count: trimmed,
    });
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
    const interval = setInterval(() => {
      this.touchPiTurnProgress();
      // An executing harness tool is genuine turn liveness even when it writes
      // nothing to the wire (a silent long command/build); keep the ai-chat
      // stall watchdog satisfied so it only trips on a truly hung session.
      this.writePiStreamHeartbeat();
    }, PI_TURN_PROGRESS_INTERVAL_MS);
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
        // Display fields for the native render-history user bubble (commit 3b):
        // the user's typed text (unattributed) and the source channel.
        rawContent,
        messageSource: options.messageSource ?? "web",
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
      // Stamp the render id when the client supplied a message id — the
      // skeleton sendRunnerCommand persists uses the same id. (Without one the
      // skeleton id is minted later; the row then just relies on the
      // piCoreMessageKey linkage as before.)
      const immediateClientMessageId =
        typeof data.clientMessageId === "string" && data.clientMessageId.trim()
          ? data.clientMessageId.trim()
          : null;
      await this.appendPiCoreMessagesIfMissing([
        this.withPiRenderMessageId(
          {
            role: "user",
            content: attributedContent,
            timestamp: turnTimestamp,
          } as unknown as AgentMessage,
          immediateClientMessageId,
        ),
      ]);
    }

    // sendRunnerCommand created the durable fiber row synchronously, so the derived
    // streaming state is now true — broadcast it for instant spinner feedback.
    this.syncAgentState();

    // A new turn's user message is now in the canonical transcript (above); the
    // turn's assistant/tool content streams to the client through ai-chat render
    // history. Steered messages land in the transcript when Pi emits them and on
    // the next reload.
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
        source !== "project" &&
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
      const requiresProject = source === "project" || source === "vm";
      const project =
        requiresProject && typeof target.project === "string"
          ? target.project.trim()
          : undefined;
      if (requiresProject && !project) {
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
    this.stopStreamingLeaseHeartbeat();
  }

  /**
   * While a turn executes, periodically renew the WorkspaceDO running row's
   * liveness lease. The row expires THREAD_STREAMING_LEASE_TTL_MS after its
   * last update and the WorkspaceDO alarm sweeps it (delete + idle broadcast),
   * so a turn killed without a terminal isStreaming=false — deploy, eviction,
   * crash — self-heals within minutes instead of pinning "running" in every
   * viewer's sidebar. The refresh is update-only server-side (`refresh: true`),
   * so a late tick racing the terminal transition can never resurrect a
   * cleared row; if the DO dies, the interval dies with it, which is exactly
   * the loss-of-heartbeat signal the lease exists to detect.
   */
  private startStreamingLeaseHeartbeat(): void {
    this.stopStreamingLeaseHeartbeat();
    this.streamingLeaseRefreshTimer = setInterval(() => {
      if (!this.isThreadStreaming()) {
        // Terminal paths stop the heartbeat via resetRunningActivityState;
        // this is a backstop so a missed clear-site cannot renew a dead turn
        // forever (which would recreate the exact stuck state the lease
        // is meant to prevent).
        this.stopStreamingLeaseHeartbeat();
        return;
      }
      const context = this.chatContext;
      if (!context?.workspaceId || !context.threadId) return;
      this.ctx.waitUntil(
        this.recordWorkspaceThreadStreaming(
          context.workspaceId,
          context.threadId,
          true,
          { refresh: true },
        ),
      );
    }, WORKSPACE_STREAMING_LEASE_REFRESH_MS);
  }

  private stopStreamingLeaseHeartbeat(): void {
    if (this.streamingLeaseRefreshTimer !== null) {
      clearInterval(this.streamingLeaseRefreshTimer);
      this.streamingLeaseRefreshTimer = null;
    }
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
    this.recordChatThreadObservabilityEvent("pi_turn_started", {
      operation: "run_pi_turn",
      status: "started",
    });
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
    this.startStreamingLeaseHeartbeat();
  }

  /**
   * Turn-completion bookkeeping. Records the assistant completion / summary /
   * automation result exactly once per turn — idempotency rides on
   * {@link assistantCompletionRecordedAt}, NOT on any stored streaming flag — and
   * broadcasts the now-idle derived state. Safe to call on any terminal path
   * (agent_end, resume completion, or error/abort cleanup).
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
    // Turn over: the assistant/tool content was streamed and persisted through
    // ai-chat render history; the stream's `finish` chunk marks it complete. Just
    // broadcast the now-idle derived state.
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
    // Compaction only summarizes away rows the render mirror already shows;
    // "preserve" keeps the visible history and re-pins the top-up mark to the
    // rewritten (shorter) parsed count.
    await this.replacePiCoreMessages(compacted, { uiRender: "preserve" });
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
    if (resolvedModel.provider === "cloudflare-ai-gateway" && resolved.hostedRequestProfile) {
      const profile = resolved.hostedRequestProfile;
      if (profile.reasoning !== undefined) {
        resolvedModel.reasoning = profile.reasoning;
      }
      if (profile.contextWindow) {
        resolvedModel.contextWindow = profile.contextWindow;
      }
      if (profile.maxTokens) {
        resolvedModel.maxTokens = Math.min(
          Math.floor(Number(resolvedModel.maxTokens || profile.maxTokens)),
          profile.maxTokens,
        );
      }
      if (profile.supportsReasoningEffort !== undefined || profile.thinkingFormat) {
        resolvedModel.compat = {
          ...(resolvedModel.compat ?? {}),
          ...(profile.supportsReasoningEffort !== undefined
            ? { supportsReasoningEffort: profile.supportsReasoningEffort }
            : {}),
          ...(profile.thinkingFormat ? { thinkingFormat: profile.thinkingFormat } : {}),
        };
      }
    }
    // Force a fixed reasoning effort on hosted AI Gateway models that need it
    // (e.g. DeepSeek V4 Pro/Auto -> xhigh). pi-ai treats the cloudflare-ai-gateway
    // provider as supportsReasoningEffort=false, so we flip it on and map every
    // agent thinking level to the target effort; otherwise reasoning_effort is
    // never emitted and the dynamic route falls back to its upstream default.
    if (
      resolved.hostedReasoningEffort &&
      resolvedModel.reasoning !== false &&
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
        ...(typeof normalizedArgs.project === "string" && normalizedArgs.project
          ? { project: normalizedArgs.project }
          : {}),
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
      // Hydrate the durable badge/error before clearing lastError below, so a
      // cold-wake hydrate (guarded once) can't restore the previous turn's error
      // after we've cleared it. A fresh turn supersedes any prior terminal error.
      this.hydrateDurableStateOnce();
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
        await this.appendPiCoreMessagesIfMissing(
          this.stampPiRenderMessageId(newMessages, this.activePiStreamTurnId),
        );
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
      // A run that settled with a RETRYABLE transient provider error is not
      // terminal yet: skip ALL terminal surfacing (no error/result events, no
      // finishTurn, marker + journal left set) and let the turn body's
      // retryPiTurnWhileTransient loop regenerate it in-process.
      if (!stoppedByUser && this.maybeDeferPiTurnForTransientRetry(event.messages)) {
        return;
      }
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
          await this.appendPiCoreMessagesIfMissing(
            this.stampPiRenderMessageId(
              messagesToPersist,
              this.activePiStreamTurnId,
            ),
          );
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
          // Display fields for the native render-history user bubble (commit 3b).
          // rawContent is the user's typed text (before attribution/mention/file-
          // safety augmentation), which is what the render bubble shows; content
          // above is the attributed prompt Pi actually receives.
          const rawContent =
            typeof message.rawContent === "string" && message.rawContent.trim()
              ? message.rawContent
              : content;
          const messageSource =
            typeof message.messageSource === "string" && message.messageSource.trim()
              ? message.messageSource
              : null;
          const clientMessageId =
            typeof message.clientMessageId === "string" && message.clientMessageId.trim()
              ? message.clientMessageId.trim()
              : undefined;
          if (wasStreaming) {
            // Steering: an in-flight turn is streaming. Durably journal the accepted
            // message BEFORE any await, so an eviction in the window before Pi drains
            // the in-memory steering queue re-delivers it on resume instead of losing
            // it. The in-flight turn's own recovery fiber makes the run recoverable,
            // so the model refresh + steer can run async. The pi_core copy is
            // stamped with the skeleton's id (same-content-same-id invariant).
            const steeredSkeleton = this.buildUserUiSkeleton({
              rawContent,
              clientMessageId,
              messageSource,
              piCoreMessageKey: timestamp,
              sentDuringStreaming: true,
            });
            const stampedSteerMessage = this.withPiRenderMessageId(
              userMessage,
              steeredSkeleton.id,
            );
            this.recordPiTurnJournalSteerMessage(stampedSteerMessage);
            this.pushChatEvent({
              type: "steer-marker",
              steerMessageId: steeredSkeleton.id,
              acceptedAtMs: Date.now(),
            });
            this.ctx.waitUntil(
              (async () => {
                // Append the steered bubble to linear render history directly
                // (persistMessages, NOT saveMessages — the latter would enqueue
                // another ai-chat turn). Persist before model refresh so a
                // refresh failure cannot erase the accepted render bubble.
                await this.persistMessages([
                  ...this.messages,
                  steeredSkeleton,
                ]);
                if (!this.piSession) return;
                await this.refreshPiSessionModel();
                if (!this.piSession) return;
                this.piSession.steer(stampedSteerMessage);
              })().catch((error) => {
                console.error(
                  "[ChatThreadDO] failed to steer / persist steered user render message",
                  error,
                );
                this.emitChatError(
                  "Your message could not be delivered to the running turn. Please resend it.",
                );
              }),
            );
            return true;
          }

          // Fresh turn. onChatMessage OWNS it (runs the model + streams the Pi
          // events); here we only make it durable and hand it to ai-chat.
          //
          // Establish durable recoverability in the SAME synchronous tick that
          // persisted isStreaming=true upstream (enqueueRunnerUserMessage) — NO await
          // runs before these two writes. The active-turn marker (kv.put) mints the
          // stable stream/message id and derives the busy spinner; the journal
          // (sql.exec) records the ATTRIBUTED prompt so a pre-stream eviction can
          // rebuild the model turn from it (the in-memory prompt queue below is
          // lost on eviction — the journal is the durable copy). From this tick on,
          // any eviction is recovered by chatRecovery: the ai-chat recovery fiber
          // wraps the saveMessages turn body, so a mid-stream cut resumes via
          // continueLastTurn and a pre-stream cut via _retryLastUserTurn, both
          // re-entering onChatMessage's resume branch.
          //
          // A second fresh send can land before the first prompt() flips
          // isStreaming (or while a recovery for an interrupted turn is still
          // pending) — the marker is then already open. Queue-correct admission:
          // APPEND the new user message to the journal (never replace — that
          // would durably drop the earlier accepted prompt) and push it onto the
          // FIFO queue for onChatMessage to drain (prompt the first, steer the
          // rest).
          const markerAlreadyOpen = this.readPiActiveTurn() !== null;
          this.openPiActiveTurnIfAbsent();
          const userSkeleton = this.buildUserUiSkeleton({
            rawContent,
            clientMessageId,
            messageSource,
            piCoreMessageKey: timestamp,
          });
          // The pi_core copy carries the skeleton's id (same-content-same-id
          // invariant) through the journal, the prompt queue, and the turn_end
          // commit of the session tail.
          const stampedUserMessage = this.withPiRenderMessageId(
            userMessage,
            userSkeleton.id,
          );
          this.recordPiTurnJournalUserMessage(stampedUserMessage, {
            append: markerAlreadyOpen,
          });
          this.pendingPiPromptQueue.push({ userMessage: stampedUserMessage });
          // Hand the turn to ai-chat. saveMessages persists the user bubble and drives
          // onChatMessage (wrapped in ai-chat's recovery fiber). Fire-and-forget:
          // saveMessages resolves only when the whole turn's stream closes, but the
          // caller's `sent=true` ack means the turn was ACCEPTED, not completed.
          this.ctx.waitUntil(
            this.saveMessages((msgs) => [...msgs, userSkeleton])
              .then((result) => {
                if (result.status === "error") {
                  console.error(
                    "[ChatThreadDO] ai-chat turn reported error",
                    result.error,
                  );
                }
              })
              .catch((error) => {
                console.error(
                  "[ChatThreadDO] saveMessages for Pi stream turn failed",
                  error,
                );
                this.recordChatThreadObservabilityEvent(
                  "pi_stream_save_messages_failed",
                  {
                    operation: "save_messages",
                    status: "error",
                    error,
                  },
                );
              }),
          );
          return true;
        }
        if (type === "stop") {
          this.piUserStopRequestedAtMs = Date.now();
          // A stop during a transient-retry backoff has no in-flight run to
          // abort — wake the sleeping retry loop so it terminal-stops now.
          this.piTransientRetryBackoffAbort?.abort();
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
    // Set in the error branch below and stamped onto the envelope so the encoder
    // relay can persist a durable `data-pi-error` part carrying the same id +
    // billing metadata (groundwork for the future terminal-error cutover).
    let errorId: string | null = null;

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
        // Also surface terminal turn errors (provider faults, loop failures) in the
        // structured errors dataset. Without this a mid-stream provider failure was
        // invisible there — indistinguishable from a stall or client disconnect,
        // since both only funnelled through the reply-stream cancel path.
        const statusValue = payload.status ?? payload.statusCode;
        this.recordChatThreadObservabilityEvent("pi_turn_error", {
          operation: "run_pi_turn",
          status: "error",
          severity: "error",
          provider:
            typeof payload.provider === "string" ? payload.provider : null,
          model: typeof payload.model === "string" ? payload.model : null,
          statusCode: typeof statusValue === "number" ? statusValue : null,
          error: {
            name:
              typeof payload.errorType === "string" ? payload.errorType : "PiTurnError",
            message,
          },
        });
      }
      // Surface the terminal error through Agent state (with a unique id for
      // one-shot client dedup) so a reconnect after a disconnected/early failure
      // still recovers it — the replay buffer is gone. Cleared at agent_start.
      errorId = crypto.randomUUID();
      this.lastError = {
        id: errorId,
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
      ...(errorId ? { errorId } : {}),
    };

    // The turn/completed badge now rides `message-metadata.pi` (turnDurationMs /
    // completedAtMs / forkEntryId) on the assistant message the encoder emits, so
    // the browser derives it from render history — no Agent-state mirror. Emit the
    // turn-finish lifecycle event here (once per turn/completed, low cardinality).
    if (envelope.type === "runtime_event") {
      const event = envelope.event as
        | { method?: unknown; params?: Record<string, unknown> }
        | undefined;
      if (event?.method === "turn/completed") {
        const params = event.params ?? {};
        const durationMs =
          typeof params.turnDurationMs === "number" &&
          Number.isFinite(params.turnDurationMs)
            ? Math.max(0, params.turnDurationMs)
            : undefined;
        this.recordChatThreadObservabilityEvent("pi_turn_finished", {
          operation: "run_pi_turn",
          status: "completed",
          durationMs,
        });
      }
    }

    // Mirror the event into the native ai-chat stream. All render content reaches
    // the browser through this stream (assistant/tool messages) or Agent state
    // (lastError, todos), never a raw websocket fan-out — so there is no socket
    // broadcast here. The eval collector still consumes every envelope (result
    // frames included) unchanged.
    this.writePiStreamChunks(envelope);
    this.agentEvalEventCollector?.push(envelope);
  }

  /**
   * Native UIMessage stream bridge (commit 3b, dual-emit): feed a chat event into
   * the turn's encoder and relay the resulting chunks to the attached ai-chat
   * stream writer, or buffer them until onChatMessage attaches one. A no-op when
   * no turn is bridging (encoder null) — every legacy emission is untouched.
   */
  private writePiStreamChunks(envelope: Record<string, unknown>): void {
    const encoder = this.piChunkEncoder;
    if (!encoder) return;

    let chunks: PiUiMessageChunk[];
    if (envelope.type === "runtime_event") {
      const event = envelope.event;
      if (!event || typeof event !== "object") return;
      chunks = encoder.encode(event as PiRuntimeEvent);
      if (chunks.length === 0) {
        // The event carries no render content (sdk/turn boundaries, unknown
        // methods, no-op item kinds) but IS proof the session is alive. Convert
        // it into a transient heartbeat so ai-chat's inter-chunk stall watchdog
        // — which counts wire chunks, not Pi events — doesn't read a healthy
        // quiet stretch as a hang.
        this.writePiStreamHeartbeat();
        return;
      }
    } else if (envelope.type === "steer-marker") {
      const steerMessageId =
        typeof envelope.steerMessageId === "string"
          ? envelope.steerMessageId
          : "";
      const acceptedAtMs =
        typeof envelope.acceptedAtMs === "number"
          ? envelope.acceptedAtMs
          : Date.now();
      if (!steerMessageId) return;
      chunks = encoder.encodeSteerMarker(steerMessageId, acceptedAtMs);
    } else if (envelope.type === "error") {
      const errorText =
        typeof envelope.error === "string" && envelope.error.trim()
          ? envelope.error.trim()
          : typeof envelope.message === "string" && envelope.message.trim()
            ? envelope.message.trim()
            : "Unknown error";
      // The native `error` chunk is broadcast-only (ai-chat never persists it), so
      // also emit a durable, non-transient `data-pi-error` part carrying the id +
      // billing metadata. This keeps the structured error in ai-chat render
      // history (a reload/late reconnect surfaces it, and the adapter renders it
      // as an inline error block) and is the groundwork for retiring the
      // Agent-state `lastError` channel — which still drives the live composer
      // banner + billing refresh for now.
      chunks = [{ type: "error", errorText }];
      const errorId =
        typeof envelope.errorId === "string" ? envelope.errorId : null;
      if (errorId) {
        chunks.push({
          type: "data-pi-error",
          id: PI_ERROR_PART_ID,
          data: {
            id: errorId,
            error: errorText,
            billingSource:
              typeof envelope.billingSource === "string"
                ? envelope.billingSource
                : null,
            provider:
              typeof envelope.provider === "string" ? envelope.provider : null,
            status:
              typeof envelope.status === "number" ||
              typeof envelope.status === "string"
                ? (envelope.status as number | string)
                : null,
            errorType:
              typeof envelope.errorType === "string"
                ? envelope.errorType
                : null,
          },
        });
      }
    } else {
      return;
    }
    this.enqueuePiStreamChunks(chunks);
  }

  /**
   * Write a transient `data-pi-heartbeat` chunk to the live reply stream so
   * ai-chat's stall watchdog registers genuine turn liveness that produces no
   * content chunks (see {@link chatStreamStallTimeoutMs}). Writer-attached only,
   * deliberately: a heartbeat is a liveness signal for the CURRENT stream, so
   * buffering one for a future stream is meaningless and would evict real chunks
   * from the bounded pre-attach buffer. Best-effort — a write racing stream
   * close/cancel (e.g. the tool keep-alive interval firing right after a stall
   * abort) is swallowed; the watchdog already owns that turn's outcome.
   */
  private writePiStreamHeartbeat(): void {
    const writer = this.piStreamWriter;
    if (!writer) return;
    try {
      writer.write({
        type: "data-pi-heartbeat",
        transient: true,
        data: { at: Date.now() },
      } as never);
    } catch {
      // Stream already closed/cancelled; nothing to keep alive.
    }
  }

  /**
   * Relay chunks to the attached ai-chat stream writer, or buffer them until
   * onChatMessage attaches one. Shared by the encoder relay (writePiStreamChunks)
   * and out-of-band data parts (code-mode artifacts) that aren't produced from a
   * Pi runtime event.
   */
  private enqueuePiStreamChunks(chunks: PiUiMessageChunk[]): void {
    if (chunks.length === 0) return;

    const writer = this.piStreamWriter;
    if (writer) {
      for (const chunk of chunks) writer.write(chunk as never);
      return;
    }
    // Defensive: the turn body runs inside onChatMessage's execute (after the
    // writer attaches), so this normally never buffers — but a stray between-attach
    // event is kept (drop-oldest, bounded) rather than dropped.
    const buffer = (this.piPreAttachChunkBuffer ??= []);
    for (const chunk of chunks) {
      if (buffer.length >= PI_STREAM_PRE_ATTACH_CHUNK_CAP) {
        buffer.shift();
        console.warn(
          "[ChatThreadDO] pi stream pre-attach buffer overflow; dropping oldest chunk",
        );
      }
      buffer.push(chunk);
    }
  }

  /**
   * ai-chat turn OWNER (commit 6). Driven by saveMessages for a fresh turn, or by
   * chatRecovery (continueLastTurn / _retryLastUserTurn) re-driving an interrupted
   * turn. Returns a native UIMessage stream whose execute RUNS the Pi turn — a
   * fresh prompt on the warm session, or the resume branch that rebuilds and
   * continues — relaying the turn's runtime events through the encoder. Returns
   * undefined when no Pi turn is in flight (no active-turn marker), so any stray
   * ai-chat frame stays inert.
   *
   * The encoder is (re)built from the marker's stable turnId, so a recovery
   * continuation streams into the SAME persisted assistant message: a fresh turn
   * has ai-chat adopt `start {messageId: turnId}`; a continuation ignores the start
   * messageId and appends to the cloned last-assistant message (which already
   * carries that id). See the ai-chat `_streamSSEReply` continuation handling.
   */
  async onChatMessage(
    _onFinish: unknown,
    _options?: unknown,
  ): Promise<Response | undefined> {
    const marker = this.readPiActiveTurn();
    // No in-flight turn to own (e.g. the marker was already cleared). Stay inert
    // WITHOUT draining the prompt queue — a queued admission racing a terminal
    // clear keeps its entry for the next admitted turn instead of being dropped.
    if (!marker) return undefined;

    const turnId = marker.turnId;
    this.activePiStreamTurnId = turnId;
    this.piChunkEncoder = new PiChunkEncoder({ messageId: turnId });
    this.piStreamWriter = null;
    this.piPreAttachChunkBuffer = null;

    // A fresh turn prompts on the already-warm session (built before the marker was
    // set, so createPiSession did NOT fold the journal and prompt() adds the user
    // messages exactly once). Rapid double-sends both queue before prompt() flips
    // isStreaming, so the drain prompts the FIRST message and steer()s the rest
    // into the run. A recovery re-drive has an empty queue and a cold/disposed
    // session — its resume branch rebuilds the session (folding the journal, which
    // durably holds every queued user message) and continues into the same message.
    // When the resume branch runs with a non-empty queue (e.g. a config-change
    // dispose raced admission), the drained entries are safe to discard: their
    // journal rows are what the rebuilt session folds.
    const drained =
      this.pendingPiPromptQueue.length > 0
        ? this.pendingPiPromptQueue.splice(0, this.pendingPiPromptQueue.length)
        : [];
    const freshPrompts =
      drained.length > 0 && this.piSession && !this.piSession.state.isStreaming
        ? drained
        : null;

    // Lazy-load `ai`'s stream builders so the heavy package stays out of the
    // module graph's eager-import cost (see the import note at the top of file).
    const { createUIMessageStream, createUIMessageStreamResponse } = await import(
      "ai"
    );

    const response = createUIMessageStreamResponse({
      stream: createUIMessageStream({
        execute: async ({ writer }) => {
          // Emit the stream head and attach the writer. The turn body runs below
          // (inside this execute), so every Pi event arrives after the writer is set
          // — the pre-attach buffer is a defensive drain only.
          const encoder = this.piChunkEncoder;
          if (encoder) {
            for (const chunk of encoder.start()) writer.write(chunk as never);
          }
          const buffered = this.piPreAttachChunkBuffer;
          this.piPreAttachChunkBuffer = null;
          if (buffered) {
            for (const chunk of buffered) writer.write(chunk as never);
          }
          this.piStreamWriter = writer;
          // Fresh transient-retry budget per stream invocation (a chatRecovery
          // re-drive is a new invocation and gets its own budget — chatRecovery
          // bounds those separately).
          this.piTurnTransientRetryAttempts = 0;
          this.piPendingTransientTurnRetry = null;
          try {
            if (freshPrompts) {
              // No bespoke inactivity race: the ai-chat stall watchdog
              // (chatStreamStallTimeoutMs) now bounds inter-chunk gaps and, on a
              // stall, cancels this reply stream — onPiReplyStreamCancelled
              // disposes the session, which resolves this prompt() and leaves the
              // marker for bounded recovery.
              if (!this.piSession) {
                throw new Error("Pi session was not available for prompt");
              }
              await this.refreshPiSessionModel();
              const session = this.piSession;
              if (!session) {
                throw new Error("Pi session was not available for prompt");
              }
              // Prompt the first queued message; steer the rest into the run in
              // the SAME synchronous tick (prompt() marks the session streaming
              // before its first await, and pi drains the steering queue at the
              // run's steering points — including messages queued before the
              // first poll). Each steered message is steer-journaled first so an
              // eviction before pi drains it re-delivers on resume; the run's
              // first message_end rewrites the turn journal from the session
              // tail, which would otherwise drop the not-yet-drained entries.
              const [first, ...rest] = freshPrompts;
              const promptPromise = session.prompt(first.userMessage);
              for (const queued of rest) {
                this.recordPiTurnJournalSteerMessage(queued.userMessage);
                session.steer(queued.userMessage);
              }
              await promptPromise;
            } else {
              await this.resumeActivePiTurn();
            }
            // Drain the Pi event handler chain so agent_end's turn/completed → the
            // encoder `finish` chunk is flushed before the stream closes.
            await this.piEventHandlerChain.catch(() => {});
            // If that agent_end deferred a retryable transient provider error,
            // regenerate in-process on this same open stream.
            await this.retryPiTurnWhileTransient();
          } catch (error) {
            this.handlePiTurnFailure(error);
          } finally {
            if (this.piStreamWriter === writer) this.piStreamWriter = null;
            this.piChunkEncoder = null;
            this.piPreAttachChunkBuffer = null;
            this.activePiStreamTurnId = null;
            // Post-settle: pi-core is idle (or the error path cleared the marker), so
            // broadcast the derived state to clear the client spinner.
            this.syncAgentState();
          }
        },
      }),
    });
    return this.wrapReplyResponseForStallDisposal(response);
  }

  /**
   * Recovery classification hook (finding: half+full text after mid-stream
   * eviction). Default ai-chat recovery persists the orphaned partial (e.g. a
   * text part cut mid-stream, still `state: "streaming"`) and then CONTINUES
   * onto it — but Pi's resume regenerates its interrupted message from the
   * journal-folded transcript rather than continuing the partial, so the
   * continuation would append the full regenerated text after the half text.
   *
   * `persist: false` skips the orphan persist, so a mid-text eviction leaves the
   * user message as the leaf and ai-chat classifies the recovery as RETRY
   * (`_dispatchRecoveredChatTurn`'s lost-partial branch → `_chatRecoveryRetry` →
   * `_retryLastUserTurn` → onChatMessage's marker resume branch), which
   * regenerates one clean message under the same turnId. The visible partial is
   * intentionally sacrificed — the regeneration replaces it.
   *
   * The framework's never-drop-settled-work clause overrides `persist: false`
   * when the partial carries settled tool results (agents/chat
   * `_shouldPersistOrphanedPartial`): those partials DO persist and recover via
   * CONTINUE. That path is reconciled in {@link resumeActivePiTurn}, which trims
   * the partial's trailing incomplete parts before continuing.
   */
  override async onChatRecovery(
    _ctx: ChatRecoveryContext,
  ): Promise<ChatRecoveryOptions> {
    return { persist: false };
  }

  /**
   * Wrap the onChatMessage reply so the stall watchdog's stream-cancel disposes
   * the hung Pi session. ai-chat's `chatStreamStallTimeoutMs` watchdog cancels
   * this response body when the turn stalls; that cancel does NOT fire the
   * onChatMessage abortSignal, so we hook the body's `cancel()` here. Bytes pass
   * through untouched (identical SSE); only the cancel path gains the side effect.
   * A normal turn end reaches `done` (no cancel), and this codebase's user-stop
   * completes agent_end normally and closes the stream — so cancel() fires only on
   * a stall (or DO teardown), where disposing the session is correct.
   */
  private wrapReplyResponseForStallDisposal(response: Response): Response {
    const body = response.body;
    if (!body) return response;
    const reader = body.getReader();
    const wrapped = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          controller.enqueue(value);
        } catch (error) {
          controller.error(error);
        }
      },
      cancel: (reason) => {
        void reader.cancel(reason);
        this.onPiReplyStreamCancelled();
      },
    });
    return new Response(wrapped, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  /**
   * The reply stream's reader was cancelled. This fires on two distinct paths and
   * they must be told apart:
   *
   *  - A genuine mid-turn interruption (the stall watchdog aborting a hung stream,
   *    or a deploy/eviction tearing down a live turn) cancels while the turn body
   *    is still running inside onChatMessage's `execute` — so `activePiStreamTurnId`
   *    is still set (the `finally` that clears it has not run yet). Here we dispose
   *    the hung Pi session so its in-flight prompt()/continue() resolves (pi-agent-core
   *    catches the abort and settles the run); disposePiSession() drops the handlers
   *    so the synthesized aborted agent_end never runs and the active-turn marker is
   *    LEFT set, routing the turn into bounded chatRecovery.
   *
   *  - A benign post-completion close: ai-chat releases the reader AFTER consuming the
   *    terminal finish chunk (it does not always drain to `done`), so `cancel()` fires
   *    on an already-finished turn. By then `execute`'s `finally` has cleared
   *    `activePiStreamTurnId`, but the Pi session is REUSED (not disposed) for the next
   *    turn, so it is still truthy. The old `!piSession && !activePiStreamTurnId` guard
   *    therefore fell through and disposed a healthy idle session while logging a false
   *    `stall_abort`. Gate on the turn actually being in flight instead: no active turn
   *    id ⇒ nothing to abort.
   */
  private onPiReplyStreamCancelled(): void {
    if (!this.activePiStreamTurnId) {
      // Post-finish reader release (or a deploy tearing down an already-idle
      // stream). The turn already settled; do not dispose the reused session and
      // do not raise a stall alarm. Record a low-severity marker so this remains
      // visible in telemetry without masquerading as a stall.
      this.recordChatThreadObservabilityEvent("pi_turn_stream_closed", {
        operation: "stream_closed",
        status: "closed",
        severity: "debug",
      });
      return;
    }
    this.recordChatThreadObservabilityEvent("pi_turn_stream_stall_abort", {
      operation: "stream_stall_abort",
      status: "aborted",
      severity: "warn",
    });
    this.disposePiSession();
  }

  /**
   * agent_end gate for the in-process transient retry: when the run settled
   * with a RETRYABLE provider error (pi-ai's isRetryableAssistantError — its
   * non-retryable pattern excludes refusals/usage limits, which must
   * terminal-fail immediately) and budget remains, stash a pending-retry token
   * and tell the caller to skip terminal surfacing. Returns false — keeping the
   * existing terminal path — when no ai-chat turn body is attached (direct
   * prompt() drivers like agent evals have no retry loop to consume the token),
   * when the budget is spent, or when the run did not end in a retryable error.
   */
  private maybeDeferPiTurnForTransientRetry(messages: AgentMessage[]): boolean {
    if (!this.activePiStreamTurnId) return false;
    if (this.piTurnTransientRetryAttempts >= PI_TURN_TRANSIENT_RETRY_ATTEMPTS) {
      return false;
    }
    // A failed run always terminates on its error assistant message (pi emits
    // turn_end + agent_end immediately after it), so only the LAST message can
    // carry the retryable error.
    const last = messages.length > 0 ? messages[messages.length - 1] : undefined;
    if (!last) return false;
    const errorText = this.getPiAssistantErrorMessage(last);
    if (!errorText) return false;
    if (!isRetryableAssistantError(last as unknown as AssistantMessage)) {
      return false;
    }
    const record = last as unknown as Record<string, unknown>;
    this.piPendingTransientTurnRetry = {
      errorText,
      provider:
        this.piCurrentUsageProvider ||
        (typeof record.provider === "string" ? record.provider : null),
      model:
        typeof record.model === "string" && record.model.trim()
          ? record.model.trim()
          : this.piSession?.state.model?.id ?? null,
    };
    return true;
  }

  /**
   * In-process regeneration loop for a turn whose run settled with a retryable
   * transient provider error (deferred by {@link maybeDeferPiTurnForTransientRetry}).
   * Runs in the turn body AFTER the event-handler chain drained, so the deferred
   * agent_end has already been processed. Each attempt: bounded exponential
   * backoff (heartbeats keep ai-chat's inter-chunk stall watchdog fed; a user
   * stop aborts the sleep), then re-drive via the SAME regeneration path
   * eviction recovery uses — prune the failed error row from the journal,
   * dispose the session so resumeActivePiTurn rebuilds it from committed
   * history + journal, and continue into the same assistant message. The
   * active-turn marker + journal stay set across attempts (they are what the
   * rebuild folds); the retried run's own agent_end clears them on success, and
   * on exhaustion or a non-retryable error the gate declines and the normal
   * terminal path runs. Errors thrown by the re-drive propagate to
   * onChatMessage's catch (handlePiTurnFailure).
   */
  private async retryPiTurnWhileTransient(): Promise<void> {
    while (this.piPendingTransientTurnRetry) {
      const pending = this.piPendingTransientTurnRetry;
      this.piPendingTransientTurnRetry = null;
      if (this.piUserStopRequestedAtMs > 0) {
        await this.finishPiTurnStoppedDuringTransientRetry();
        return;
      }
      this.piTurnTransientRetryAttempts += 1;
      const attempt = this.piTurnTransientRetryAttempts;
      // Routed to the errors dataset (via the `error` field): the deferred
      // agent_end surfaced nothing to the client, so this event is the only
      // record of the retried provider error — and each retry re-bills the
      // reprocessed input tokens, so this counter is also the spend signal.
      const retryError = new Error(pending.errorText);
      retryError.name = "PiProviderError";
      this.recordChatThreadObservabilityEvent("pi_turn_transient_retry", {
        operation: "transient_turn_retry",
        status: "retrying",
        severity: "warn",
        count: attempt,
        provider: pending.provider,
        model: pending.model,
        error: retryError,
      });
      // Prune the failed assistant row from the durable journal BEFORE the
      // evictable backoff sleep. If the DO is evicted during the sleep, the
      // in-memory pending-retry intent is lost, so cold-load recovery folds the
      // journal blind — and a lingering error row would make planPiTurnResume see
      // a trailing assistant, take the "already complete" branch, and commit the
      // provider error as a successful final message (silently abandoning the
      // retry). Pruning first means an eviction here folds a transcript ending in
      // the user/tool message and regenerates, exactly as an in-process retry
      // would. Idempotent: finishPiTurnStoppedDuringTransientRetry filters the
      // failed row rather than depending on it, and a second prune is a no-op.
      this.prunePiTurnJournalFailedAssistantMessages();
      // The backoff writes no content chunks; feed the stall watchdog so it
      // cannot cancel the open reply stream while we sleep.
      this.writePiStreamHeartbeat();
      const backoffAbort = new AbortController();
      this.piTransientRetryBackoffAbort = backoffAbort;
      try {
        await this.sleepForPiTransientTurnRetry(attempt, backoffAbort.signal);
      } catch {
        // The only abort source is a user stop (sendRunnerCommand's stop path).
        await this.finishPiTurnStoppedDuringTransientRetry();
        return;
      } finally {
        if (this.piTransientRetryBackoffAbort === backoffAbort) {
          this.piTransientRetryBackoffAbort = null;
        }
      }
      if (this.piUserStopRequestedAtMs > 0) {
        await this.finishPiTurnStoppedDuringTransientRetry();
        return;
      }
      this.writePiStreamHeartbeat();
      // Journal already pruned before the sleep (above); trim the in-flight
      // streaming reply parts (in-memory, not durable, so no eviction concern).
      this.trimIncompleteStreamingReplyParts();
      // resumeActivePiTurn folds committed history + journal only through a
      // session REBUILD (ensurePiSessionReady reuses a warm one) — dispose
      // first so the re-drive runs the same cold path eviction recovery does.
      // Known minor edge: a user `stop` landing in the dispose→rebuild window
      // hits sendRunnerCommand's `if (this.piSession)` guard while the session
      // is null, so that one click is dropped; the rebuilt run streams and can be
      // stopped again. Not a hang (the run completes and clears the marker); left
      // as-is rather than widening the stop path on the hot turn body.
      this.disposePiSession();
      await this.resumeActivePiTurn();
      await this.piEventHandlerChain.catch(() => {});
    }
  }

  /** Bounded exponential backoff between transient turn retries. */
  private sleepForPiTransientTurnRetry(
    attempt: number,
    signal: AbortSignal,
  ): Promise<void> {
    const delayMs = Math.min(
      PI_TURN_TRANSIENT_RETRY_MAX_MS,
      PI_TURN_TRANSIENT_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1),
    );
    if (signal.aborted) {
      return Promise.reject(new Error("Request was aborted"));
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timeout);
        reject(new Error("Request was aborted"));
      };
      const timeout = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, delayMs);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /**
   * Terminal path for a user stop that lands during a transient-retry backoff:
   * there is no in-flight run to emit the stoppedByUser agent_end, so run the
   * equivalent teardown here. The journal may hold accepted-but-uncommitted
   * real work (the turn's user message when the FIRST model call failed,
   * completed tool results) — commit it minus the failed error row before the
   * journal is cleared, so the stop doesn't drop the prompt from the transcript.
   */
  private async finishPiTurnStoppedDuringTransientRetry(): Promise<void> {
    const stoppedAtMs = this.piUserStopRequestedAtMs || Date.now();
    const completedAtMs = Date.now();
    const threadId = this.chatContext?.threadId || "";
    this.recordChatThreadObservabilityEvent("pi_turn_transient_retry", {
      operation: "transient_turn_retry",
      status: "stopped",
      severity: "warn",
      count: this.piTurnTransientRetryAttempts,
    });
    const journalTail = await this.loadPiTurnJournalTail();
    const realWork = journalTail.filter(
      (message) => !this.isFailedPiAssistantMessage(message),
    );
    await this.appendPiCoreMessagesIfMissing(
      this.stampPiRenderMessageId(
        [...realWork, this.createPiUserStopMessage(stoppedAtMs)],
        this.activePiStreamTurnId,
      ),
    );
    const turnStartedAtMs =
      this.piAgentStartedAtMs || this.piTurnStartedAtMs || completedAtMs;
    this.piAgentStartedAtMs = 0;
    this.pushPiRuntimeEvent("item/agentMessage/delta", {
      threadId,
      itemId: `pi_user_stop_${stoppedAtMs}`,
      itemKind: "userStop",
      delta: PI_USER_STOP_TEXT,
    });
    this.pushPiRuntimeEvent("turn/completed", {
      threadId,
      completedAtMs,
      turnDurationMs: Math.max(0, completedAtMs - turnStartedAtMs),
    });
    this.pushChatEvent({
      type: "result",
      threadId,
      result: PI_USER_STOP_TEXT,
      sessionId: threadId,
      completedAt: completedAtMs,
    });
    this.updateActiveAutomationRun({
      status: "error",
      message: PI_USER_STOP_TEXT,
      completedAt: completedAtMs,
      clear: true,
    });
    this.finishTurn({ markUnread: true, completedAt: completedAtMs });
    this.setActiveTurnUserId(null);
    this.completeTodoStateForTurnEnd();
    this.piUserStopRequestedAtMs = 0;
    this.resetRunningActivityState();
    // The warm session's uncommitted tail was discarded at the failed turn_end
    // and pi_core just gained the journal commit above — rebuild next turn.
    this.disposePiSession();
    await this.clearPiActiveTurnAndJournal();
  }

  /**
   * In-process analog of {@link trimIncompleteLiveAssistantParts}: mid-stream
   * nothing is persisted for this turn yet, but ai-chat's in-flight reply
   * message (the parts array `applyChunkToParts` builds and `_reply` persists
   * at stream end) still holds the failed attempt's incomplete trailing parts.
   * The regeneration re-produces that content, so drop the incomplete tail
   * before re-driving — otherwise the persisted message renders the half text
   * followed by the full regenerated text. Settled parts (completed tools,
   * finished text runs) correspond to journaled work the resume keeps, so they
   * stay. The client's live copy still shows the stale tail until the
   * end-of-turn persistMessages broadcast reconciles it.
   */
  private trimIncompleteStreamingReplyParts(): void {
    // ai-chat 0.9.3 holds the in-flight reply on the PRIVATE `_streamingMessage`
    // field: `_reply` assigns it `_createStreamingAssistantMessage()`'s
    // `{ id, role, parts }` and persists that same `parts` array verbatim at
    // stream end. We reach it through a cast (there is no public trim/reset API).
    // An upstream RENAME would make the cast read `undefined`, so this trim would
    // silently no-op and reintroduce the half+full render it exists to prevent.
    // Distinguish a MISSING field (rename — surface loudly so a dependency bump
    // that breaks the safeguard shows up in prod, not just in a stale test) from a
    // legitimately null one (no reply stream open — nothing to trim). The
    // keep-in-sync guard test (chat-thread-streaming-reply-trim.test.ts) pins the
    // field name and the `{ parts }` shape against the installed dist.
    const agent = this as unknown as {
      _streamingMessage?: { parts?: unknown[] } | null;
    };
    if (!("_streamingMessage" in agent)) {
      console.error(
        "[ChatThreadDO] @cloudflare/ai-chat _streamingMessage field is missing; " +
          "transient-retry partial trim is a no-op (upstream rename?)",
      );
      this.recordChatThreadObservabilityEvent("pi_streaming_reply_field_missing", {
        operation: "transient_turn_retry",
        status: "error",
        severity: "error",
      });
      return;
    }
    const streaming = agent._streamingMessage;
    const parts = streaming?.parts;
    if (!Array.isArray(parts)) return;
    let trimmed = 0;
    while (parts.length > 0) {
      const last = parts[parts.length - 1] as { state?: unknown };
      if (last?.state === "streaming" || last?.state === "input-streaming") {
        parts.pop();
        trimmed += 1;
        continue;
      }
      break;
    }
    if (trimmed === 0) return;
    this.recordChatThreadObservabilityEvent("pi_turn_partial_trimmed", {
      operation: "transient_turn_retry",
      status: "trimmed",
      count: trimmed,
    });
  }

  /**
   * Shared failure cleanup for a Pi turn that errored inside onChatMessage's stream
   * execute (a fresh prompt or a resume continuation). Consolidates the old
   * sendRunnerCommand / resume error paths.
   *
   * A genuine user `stop` keeps handlers subscribed, so agent_end already cleared
   * the marker + journal and its AbortError is benign. A config-change dispose (and
   * a stall dispose via {@link onPiReplyStreamCancelled}) also abort with no
   * agent_end but leave the marker set so the pending continuation resumes the turn
   * — all AbortError cases are swallowed WITHOUT clearing recovery state. (A stall
   * abort actually resolves prompt() rather than rejecting, so it usually doesn't
   * reach here at all; the AbortError guard covers the race where it does.)
   *
   * Otherwise: surface the error through the encoder relay (a terminal `error`
   * chunk) plus durable lastError state, run the completion/automation teardown,
   * and clear the marker + journal so chatRecovery does NOT re-drive a turn that
   * terminally errored.
   */
  private handlePiTurnFailure(error: unknown): void {
    if (
      error instanceof Error &&
      (error.name === "AbortError" || /aborted/i.test(error.message))
    ) {
      return;
    }
    console.error("[ChatThreadDO] Pi turn failed", error);
    this.persistPiAgentLoopErrorForDevelopers(error, { source: "pi_turn" });
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    this.pushChatEvent(this.piProviderErrorEvent(errorMessage));
    this.updateActiveAutomationRun({
      status: "error",
      message: errorMessage,
      clear: true,
    });
    this.finishTurn();
    this.setActiveTurnUserId(null);
    void this.clearPiActiveTurnAndJournal();
  }

  /**
   * chatRecovery `onExhausted` hook (commit 6): an interrupted turn spent its
   * recovery budget. The framework delivers `terminalMessage` to the client and
   * records the durable terminal itself; here we run the same give-up teardown the
   * old failPiResume path did — clear the marker + journal, release turn ownership,
   * fail any active automation run, surface durable lastError, and log.
   */
  private handlePiRecoveryExhausted(ctx: ChatRecoveryExhaustedContext): void {
    this.recordChatThreadObservabilityEvent("pi_turn_resume_abandoned", {
      operation: "resume_interrupted_turn",
      status: "abandoned",
      severity: "warn",
    });
    this.updateActiveAutomationRun({
      status: "error",
      message: ctx.terminalMessage,
      clear: true,
    });
    void this.clearPiActiveTurnAndJournal();
    this.finishTurn();
    this.setActiveTurnUserId(null);
    try {
      this.pushChatEvent(this.piProviderErrorEvent(ctx.terminalMessage));
    } catch {
      // Best effort: the framework already delivered the terminal banner; the
      // observability event above is the actionable signal.
    }
  }

  /**
   * Build a native user render bubble for the linear ai-chat history (commit 3b).
   * Uses the client-supplied message id when present so the client's optimistic
   * echo and the durable row share an id.
   */
  private buildUserUiSkeleton(args: {
    rawContent: string;
    clientMessageId?: string;
    messageSource?: string | null;
    channelHistory?: boolean;
    piCoreMessageKey?: number | string;
    sentDuringStreaming?: boolean;
  }): UIMessage {
    const metadata: Record<string, unknown> = {};
    if (args.messageSource) metadata.source = args.messageSource;
    if (args.channelHistory) metadata.channelHistory = true;
    if (args.sentDuringStreaming) metadata.sentDuringStreaming = true;
    // Stamp the pi_core timestamp of the row Pi commits for this same user
    // message so the top-up backfill can recognize the live-written skeleton and
    // skip re-converting the pi_core row into a duplicate (topUpUiMessagesFromPiCore).
    if (args.piCoreMessageKey !== undefined && args.piCoreMessageKey !== null) {
      metadata.piCoreMessageKey = String(args.piCoreMessageKey);
    }
    return {
      id:
        args.clientMessageId && args.clientMessageId.trim()
          ? args.clientMessageId.trim()
          : crypto.randomUUID(),
      role: "user",
      parts: [{ type: "text", text: args.rawContent, state: "done" }],
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    } as UIMessage;
  }

  /**
   * Render history for the live-user chat loader (commit 3b). Runs the pi_core →
   * ai-chat top-up backfill first, then returns the full ai-chat message list.
   * DO RPC only — intentionally NOT wired to any HTTP route (auth-sensitive; the
   * loader wiring is commit 4).
   */
  async getUiMessages(): Promise<UIMessage[]> {
    // The SSR loader is the first page-open touch (before the websocket
    // connects). Heal a provably-dead turn's stranded marker here so the load
    // doesn't derive a busy indicator from it — and so the top-up below (which
    // the marker gates) isn't skipped forever for a turn nothing will resume.
    await this.sweepOrphanedActiveTurnMarker();
    await this.topUpUiMessagesFromPiCore();
    await this.healLegacyUiMessageTimes();
    return this.messages as UIMessage[];
  }

  /**
   * One-shot lazy migration: rows persisted before the time stamps shipped
   * (the backfill's `pi.createdAtMs` and the encoder's `pi.completedAtMs`,
   * both from the ai-chat streaming migration) carry no recoverable creation
   * time, so the client renders epoch 0 — a fixed "4:00 PM" in Pacific.
   * Recover the time from the row's own `created_at` column (insert time —
   * within a turn of the truth for legacy rows) and stamp it durably. Gated
   * off while a turn is in flight (the streaming row legitimately has no
   * metadata yet and must not be stamped with an insert-time heal); the
   * marker is only written once a quiet pass completes.
   */
  private async healLegacyUiMessageTimes(): Promise<void> {
    if (this.ctx.storage.kv.get<boolean>(UI_MESSAGES_TIME_HEAL_KEY)) return;
    if (this.readPiActiveTurn() || this.activePiStreamTurnId !== null) return;
    const missing = (this.messages as UIMessage[]).filter(
      (message) => uiMessageCreatedAtMs(message) === undefined,
    );
    if (missing.length > 0) {
      const rows = this.ctx.storage.sql
        .exec<{ id: string; created_at: string }>(
          "SELECT id, created_at FROM cf_ai_chat_agent_messages",
        )
        .toArray();
      const createdById = new Map(rows.map((row) => [row.id, row.created_at]));
      let changed = false;
      const healed = (this.messages as UIMessage[]).map((message) => {
        if (uiMessageCreatedAtMs(message) !== undefined) return message;
        const raw = createdById.get(message.id);
        // Column format is SQLite UTC "YYYY-MM-DD HH:MM:SS(.mmm)".
        const ms = raw ? Date.parse(`${raw.replace(" ", "T")}Z`) : Number.NaN;
        if (!Number.isFinite(ms) || ms <= 0) return message;
        const metadata = (message.metadata ?? {}) as Record<string, unknown>;
        const pi = (metadata.pi && typeof metadata.pi === "object"
          ? { ...(metadata.pi as Record<string, unknown>) }
          : {}) as Record<string, unknown>;
        pi.createdAtMs = ms;
        changed = true;
        return { ...message, metadata: { ...metadata, pi } } as UIMessage;
      });
      if (changed) {
        await this.persistMessages(healed);
        this.recordChatThreadObservabilityEvent("pi_ui_message_times_healed", {
          operation: "heal_legacy_ui_message_times",
          status: "healed",
          count: missing.length,
        });
      }
    }
    this.ctx.storage.kv.put(UI_MESSAGES_TIME_HEAL_KEY, true);
  }

  /**
   * Admin repair RPC (commit 3b): rebuild the entire ai-chat render history from
   * pi_core. Clears the mirror + high-water mark, then re-runs the top-up. For
   * flows that rewrite pi_core (fork repair, compaction repair) where the append-
   * only high-water assumption no longer holds.
   */
  async resyncUiMessagesFromPiCore(): Promise<{
    ok: true;
    messageCount: number;
  }> {
    await this.rebuildUiMessagesFromPiCore();
    return { ok: true, messageCount: this.messages.length };
  }

  /**
   * High-water-mark top-up: convert pi_core render messages beyond the mark into
   * native UIMessages and persist them into ai-chat's durable render history. The
   * mark is the count of parsed render messages already mirrored; deterministic
   * ids (forkEntryId / pi item ids from the shared adapter) make the upsert
   * idempotent, and explicit monotonic created_at keeps ai-chat's `order by
   * created_at` load stable (its default per-row timestamp is 1s-resolution insert
   * time, so a burst of backfilled rows would otherwise tie and shuffle).
   */
  private async topUpUiMessagesFromPiCore(
    options: { force?: boolean } = {},
  ): Promise<void> {
    // While a Pi turn is in flight (or awaiting recovery), pi_core rows beyond
    // the mark belong to that turn: they stream into the live turnId render row
    // (or its recovery continuation), so converting them here would churn the
    // live message mid-stream. The turn's terminal paths clear the marker; the
    // next top-up reconciles. Ordering beyond the marker doesn't matter for
    // correctness: stamped rows convert under the SAME id the live stream
    // persists (uiMetadata.renderMessageId), so whichever writer runs first,
    // the other's upsert converges on one row. `force` bypasses the gate for
    // explicit rebuild flows (admin resync, fork seeding).
    if (!options.force && this.readPiActiveTurn()) return;
    const startedAt = Date.now();
    const threadId = this.chatContext?.threadId ?? "";
    const parsed = await this.getPiCoreParsedMessages(threadId);
    const mark = this.ctx.storage.kv.get<number>(
      UI_MESSAGES_PI_CORE_HIGH_WATER_KEY,
    ) ?? 0;
    if (parsed.length <= mark) return;

    const newParsed = parsed.slice(mark);
    let lastCreatedAtMs =
      this.ctx.storage.kv.get<number>(
        UI_MESSAGES_PI_CORE_LAST_CREATED_AT_KEY,
      ) ?? 0;
    // Dedup against rows the live paths already wrote:
    //  - STAMPED assistant rows (uiMetadata.renderMessageId, every commit since
    //    stamping shipped) convert under exactly the live stream's message id,
    //    so a plain id-existence check is the whole dedup — and when neither
    //    row exists yet, whichever writer runs first, the other upserts the
    //    same id and converges.
    //  - user rows match by the exact pi timestamp stamped on their skeleton
    //    (metadata.piCoreMessageKey).
    //  - LEGACY unstamped assistant rows (committed before stamping shipped,
    //    e.g. a turn that straddled the deploy) fall back to the old content
    //    heuristics: fork-id and tool-call identity against existing messages.
    //    Delete this fallback once pre-stamp in-flight turns are gone.
    // The high-water mark still advances past skipped rows.
    const existingIds = new Set<string>(this.messages.map((m) => m.id));
    const existingForkEntryIds = new Set<string>();
    const existingUserIdsByKey = new Map<string, string>();
    const existingToolCallIds = new Set<string>();
    for (const existing of this.messages) {
      const metadata = (existing as { metadata?: Record<string, unknown> })
        .metadata;
      if (metadata && typeof metadata === "object") {
        const pi = metadata.pi as
          | { forkEntryId?: unknown; forkEntryIds?: unknown }
          | undefined;
        if (pi && typeof pi.forkEntryId === "string" && pi.forkEntryId) {
          existingForkEntryIds.add(pi.forkEntryId);
        }
        if (pi && Array.isArray(pi.forkEntryIds)) {
          for (const id of pi.forkEntryIds) {
            if (typeof id === "string" && id) existingForkEntryIds.add(id);
          }
        }
        if (typeof metadata.piCoreMessageKey === "string" && metadata.piCoreMessageKey) {
          existingUserIdsByKey.set(metadata.piCoreMessageKey, existing.id);
        }
      }
      const parts = (existing as { parts?: unknown }).parts;
      if (existing.role === "assistant" && Array.isArray(parts)) {
        for (const part of parts) {
          const toolCallId = (part as { toolCallId?: unknown } | null)?.toolCallId;
          if (typeof toolCallId === "string" && toolCallId) {
            existingToolCallIds.add(toolCallId);
          }
        }
      }
    }
    const parsedAssistantToolCallIds = (content: unknown): string[] => {
      if (!Array.isArray(content)) return [];
      const ids: string[] = [];
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const record = block as Record<string, unknown>;
        if (record.type === "tool_use" && typeof record.id === "string" && record.id) {
          ids.push(record.id);
        }
      }
      return ids;
    };

    const convertedByIndex = new Map<number, UIMessage>();
    const convertAt = (index: number): UIMessage => {
      const cached = convertedByIndex.get(index);
      if (cached) return cached;
      const row = newParsed[index];
      let converted = messageToUiMessage(row as unknown as Message);
      // User pi_core rows are stamped with the id of their live skeleton. A
      // rebuild must preserve it so a synthetic steer marker can consume the
      // rebuilt bubble by the same-content-same-id invariant.
      if (
        row.role === "user" &&
        typeof row.renderMessageId === "string" &&
        row.renderMessageId
      ) {
        converted = { ...converted, id: row.renderMessageId } as UIMessage;
      }
      convertedByIndex.set(index, converted);
      return converted;
    };
    const resolvedUserIdAt = (index: number): string => {
      const row = newParsed[index];
      const existingId = existingUserIdsByKey.get(String(row.created_at));
      if (existingId) return existingId;
      if (
        typeof row.renderMessageId === "string" &&
        row.renderMessageId
      ) {
        return row.renderMessageId;
      }
      // The deterministic row-derived id is also the id assigned when this
      // user is converted during the same pass. If its bubble is unavailable,
      // the client safely joins around the unmatched marker.
      return convertAt(index).id;
    };

    // A multi-SDK-turn run commits one pi_core assistant row per SDK turn, all
    // stamped with the ONE live render id. Steered user rows break contiguity,
    // so fold by stamp across the whole pass and insert a marker for every user
    // row between assistant commits. This prevents a later same-id upsert from
    // clobbering the pre-steer half during a full rebuild.
    const assistantIndexesByStamp = new Map<string, number[]>();
    for (let index = 0; index < newParsed.length; index += 1) {
      const row = newParsed[index];
      if (
        row.role !== "assistant" ||
        typeof row.renderMessageId !== "string" ||
        !row.renderMessageId
      ) {
        continue;
      }
      const indexes = assistantIndexesByStamp.get(row.renderMessageId) ?? [];
      indexes.push(index);
      assistantIndexesByStamp.set(row.renderMessageId, indexes);
    }

    const stampedAssistantIndexes = new Set<number>();
    const foldedAssistantByFirstIndex = new Map<number, UIMessage>();
    for (const [renderMessageId, indexes] of assistantIndexesByStamp) {
      for (const index of indexes) stampedAssistantIndexes.add(index);
      // The live stream already persisted the complete marked row. Every
      // assistant commit sharing its id is covered by that one exact-id skip.
      if (existingIds.has(renderMessageId)) continue;

      const firstIndex = indexes[0];
      const parts: UIMessage["parts"] = [];
      let previousAssistantIndex = firstIndex;
      for (let offset = 0; offset < indexes.length; offset += 1) {
        const assistantIndex = indexes[offset];
        if (offset > 0) {
          for (
            let between = previousAssistantIndex + 1;
            between < assistantIndex;
            between += 1
          ) {
            const interposed = newParsed[between];
            if (interposed.role !== "user") continue;
            const steerMessageId = resolvedUserIdAt(between);
            const acceptedAtMs =
              typeof interposed.created_at === "number" &&
              Number.isFinite(interposed.created_at)
                ? interposed.created_at
                : Date.now();
            parts.push({
              type: PI_STEER_MARKER_PART,
              id: piSteerMarkerPartId(steerMessageId),
              data: { steerMessageId, acceptedAtMs },
            } as UIMessage["parts"][number]);
          }
        }
        parts.push(...convertAt(assistantIndex).parts);
        previousAssistantIndex = assistantIndex;
      }

      const rows = indexes.map((index) => newParsed[index]);
      const forkEntryIds = rows
        .map((row) => row.forkEntryId)
        .filter((id): id is string => typeof id === "string" && !!id);
      const pi: Record<string, unknown> = {
        ...(forkEntryIds.length > 0
          ? {
              forkEntryId: forkEntryIds[forkEntryIds.length - 1],
              forkEntryIds,
            }
          : {}),
      };
      const firstCreatedAt = (
        convertAt(firstIndex).metadata as
          | { pi?: { createdAtMs?: unknown } }
          | undefined
      )?.pi?.createdAtMs;
      if (typeof firstCreatedAt === "number") pi.createdAtMs = firstCreatedAt;
      foldedAssistantByFirstIndex.set(firstIndex, {
        id: renderMessageId,
        role: "assistant",
        parts,
        metadata: { pi },
      } as UIMessage);
    }

    const uiMessages: UIMessage[] = [];
    const createdAtById = new Map<string, number>();
    for (let index = 0; index < newParsed.length; index += 1) {
      const first = newParsed[index];
      let ui: UIMessage;

      if (stampedAssistantIndexes.has(index)) {
        const folded = foldedAssistantByFirstIndex.get(index);
        if (!folded) continue;
        ui = folded;
      } else if (first.role === "assistant") {
        // Legacy unstamped assistant row: old content heuristics.
        if (
          typeof first.forkEntryId === "string" &&
          existingForkEntryIds.has(first.forkEntryId)
        ) {
          continue;
        }
        const toolCallIds = parsedAssistantToolCallIds(first.content);
        if (toolCallIds.some((id) => existingToolCallIds.has(id))) {
          continue;
        }
        ui = convertAt(index);
      } else if (
        first.role === "user" &&
        existingUserIdsByKey.has(String(first.created_at))
      ) {
        continue;
      } else {
        ui = convertAt(index);
        if (existingIds.has(ui.id)) continue;
      }

      const baseMs =
        typeof first.created_at === "number" && Number.isFinite(first.created_at)
          ? first.created_at
          : Date.now();
      const createdAtMs = Math.max(baseMs, lastCreatedAtMs + 1);
      lastCreatedAtMs = createdAtMs;
      createdAtById.set(ui.id, createdAtMs);
      uiMessages.push(ui);
    }

    if (uiMessages.length > 0) {
      // persistMessages sanitizes, upserts (idempotent by id), refreshes the
      // in-memory list, and broadcasts — but stamps created_at with the insert-
      // time default, so overwrite it with the monotonic values and reload the
      // in-memory order to match a fresh wake's `order by created_at`.
      await this.persistMessages([...this.messages, ...uiMessages]);
      for (const [id, createdAtMs] of createdAtById) {
        this.ctx.storage.sql.exec(
          "UPDATE cf_ai_chat_agent_messages SET created_at = ? WHERE id = ?",
          formatAiChatCreatedAt(createdAtMs),
          id,
        );
      }
      this.reloadAiChatMessagesOrdered();
      this.ctx.storage.kv.put(
        UI_MESSAGES_PI_CORE_LAST_CREATED_AT_KEY,
        lastCreatedAtMs,
      );
      this.recordChatThreadObservabilityEvent("pi_ui_messages_backfilled", {
        operation: "topup_ui_messages",
        status: "converted",
        count: uiMessages.length,
        durationMs: Date.now() - startedAt,
      });
    }
    this.ctx.storage.kv.put(UI_MESSAGES_PI_CORE_HIGH_WATER_KEY, parsed.length);
  }

  /**
   * Reload the in-memory ai-chat message list from SQLite ordered by created_at,
   * matching ai-chat's own load semantics (used after a direct created_at UPDATE
   * that persistMessages' in-memory refresh predates).
   */
  private reloadAiChatMessagesOrdered(): void {
    const rows = this.ctx.storage.sql
      .exec<{ id: string; message: string }>(
        "SELECT id, message FROM cf_ai_chat_agent_messages ORDER BY created_at",
      )
      .toArray();
    const messages: UIMessage[] = [];
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.message) as UIMessage;
        if (
          parsed &&
          typeof parsed.id === "string" &&
          typeof parsed.role === "string" &&
          Array.isArray(parsed.parts)
        ) {
          messages.push(parsed);
        }
      } catch {
        // A row that fails to parse is skipped, matching ai-chat's loader.
      }
    }
    this.messages = messages;
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
