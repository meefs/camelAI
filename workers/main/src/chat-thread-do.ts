import { WorkerEntrypoint } from "cloudflare:workers";
import {
  Agent,
  type Connection,
  type ConnectionContext,
  type FiberInspection,
  type FiberRecoveryContext,
  type WSMessage,
} from "agents";
import { Type, type TSchema } from "typebox";
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
  setBedrockProviderModule,
} from "@earendil-works/pi-ai";
import {
  bedrockProviderModule,
  resolveBedrockModelFallback,
  withBedrockModelMetadata,
} from "./pi-bedrock-provider";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Model,
} from "@earendil-works/pi-ai";
import type { OrgDO, OrgThread, UserDO, WorkerScript } from "./auth";
import type { WorkspaceDO } from "./workspace";
import type { WorkspaceCronDO } from "./workspace-cron";
import type { WorkerLogsDO } from "./worker-logs-do";
import {
  WorkspaceFilesystemClient,
  normalizeWorkspacePath as normalizeDurableWorkspacePath,
  type LegacyWorkspaceMigrationStatus,
  type WorkspaceFilesystemEnv,
  type WorkspaceProject,
  type WorkspaceProjectCloneSummary,
  projectNameKey,
} from "./workspace-filesystem-do";
import {
  ProjectRuntimeServiceVmBridge,
  type ProjectRuntimeServiceVmEnv,
} from "./project-runtime-service-vm";
import { formatAttributedUserMessage } from './chat-author-attribution';
import { injectFileSafetyMessage } from './file-safety';
import { applyMentionContext } from './mention-context';
import {
  getThreadUserMessageSources,
  isPlaceholderThreadTitle,
} from '../../../src/lib/thread-title';
import { generateThreadTitleWithOpenAI } from '../../../src/lib/thread-title-generation.server';
import {
  extractThreadCompletionSummarySource,
  generateThreadCompletionSummaryWithOpenAI,
} from '../../../src/lib/thread-completion-summary-generation.server';
import { normalizeThreadPreviewUserMessage } from '../../../src/lib/thread-preview';
import { getToolSummary } from '../../../src/lib/tool-activity-summary';
import {
  normalizePiUiMetadata,
  normalizeRuntimeCallArtifacts,
  stripPiUiMetadata,
  type PiUiMetadata,
  type RuntimeCallArtifact,
  type RuntimeCallArtifactKind,
} from '../../../src/lib/runtime-artifacts';
import type {
  LlmModel,
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
  getEvalDeployApp,
  isEvalDeployEnabled,
  listEvalDeployApps,
  setEvalDeployAppPublic,
} from "./eval-deploy-registry";
import {
  findConnectionMethodEntry,
  getConnection,
  invokeConnectionMethod,
  listConnectionMethods,
  listConnections,
  listConnectionTools,
  testConnectionMethodEntry,
} from "./connections-runtime";
import { confirmDestructiveAction, DESTRUCTIVE_CONFIRM_LABEL } from "./confirmed-destructive-action";
import { collectProjectDeletionTargets, orderProjectsForRuntimeDelete } from "./project-deletion";
import {
  PI_SKILL_DESCRIPTIONS,
  PI_SKILL_NAMES,
} from "./pi-skills-bundle";
import {
  createPiSubagentSystemPrompt,
  createPiSystemPrompt,
} from "./pi-system-prompt";
import {
  listPiBundledSkillFiles,
  readPiBundledSkillFile,
} from "./pi-skill-bundle-helpers";
import {
  PiContainerTools,
  PI_CONTAINER_TOOL_DEFINITIONS,
} from "./pi-container-tools";
import { repairPiMessageHistoryForReplay } from "./pi-message-history";
import { parseFilePreviewPath } from "./preview-paths";
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
} from "./chat-thread-browser-prompts";
import {
  applyContextUsageSdkEvent,
  resolveContextUsageForInit,
  type LastMessageStartUsage,
} from "./chat-context-usage";
import { CodeModeWebSearch } from "./code-mode-web-search";
import { buildWorkspaceScopedR2Key } from "../../../src/lib/workspace-r2-paths";
import {
  buildWorkspaceEmailAddress,
  buildWorkspaceEmailSenderAddress,
  getWorkspaceEmailDomain,
} from "../../../src/lib/workspace-email";
import { getBillingPlanLimits } from "../../../src/lib/billing-plans";
import { retryTransientDurableObjectRpc } from "../../../src/lib/do-rpc-retry.server";
import { formatMarkdownForTelegram } from "../../../src/lib/telegram-format";
import { normalizeChannelIndicatorKind } from "../../../src/lib/channel-kinds";
import {
  appendEmailThreadReferenceIds,
  buildEmailReplyHeaders,
  EMAIL_REPLY_REFERENCE_TTL_SECONDS,
  getOrCreateChannelThread,
  getEmailReplyReferenceKey,
  getEmailThreadReferencesKey,
} from "./channels";
import { codeModeWorkerModule } from "./code-mode-runner";
import { CodeModeCustomDomains } from "./code-mode-custom-domains";
import {
  detectImageMimeType as detectSharedImageMimeType,
  getSupportedImageMimeTypeFromContentType,
  inlineImageMaxBase64Chars,
  prepareInlineImageFromStream,
  readImageSniffBytesAndReplayStream,
  type PreparedInlineImage,
  readStreamBytes,
} from "./image-tool-content";
import { CodeModeScheduledPrompts } from "./code-mode-scheduled-prompts";
import { CodeModeDeterministicAutomations } from "./code-mode-deterministic-automations";
import { CodeModeIntegrations } from "./code-mode-integrations";
import { createSignedToken } from "./signed-tokens";
import {
  editAutomationVirtualFile,
  listAutomationVirtualFiles,
  normalizeAutomationVirtualPath,
  readAutomationVirtualFile,
  writeAutomationVirtualFile,
} from "./deterministic-automation-virtual-files";
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

// Pi lazy-loads its Bedrock provider through the AWS SDK, which is brittle in
// Cloudflare Workers. Register our Worker-native Bedrock adapter instead.
setBedrockProviderModule(bedrockProviderModule);

export type PreviewTarget =
  | {
      kind: "app";
      scriptName: string;
      isPublic: boolean;
    }
  | {
      kind: "file";
      source: "workspace" | "upload" | "output" | "vm";
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
type PiHeaderValue = string | null;

const PI_USER_STOP_TEXT = "Stopped by user";
const PI_USER_STOP_METADATA_REASON = "user_stop";
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

type LlmProviderConfigRecord = ReturnType<
  import("./identity/org-do").OrgDO["getLlmProviderConfig"]
>;

interface CachedLlmProviderConfig {
  orgId: string;
  value: LlmProviderConfigRecord;
}

interface PiResolvedModelReference {
  provider: string;
  modelId: string;
  api?: string;
  hostedGatewayProvider: string;
  hostedModelId?: string;
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
  "anthropic/claude-sonnet-4-6": {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    thinkingLevelMap: { xhigh: "xhigh" },
    input: ["text", "image"],
    cost: {
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 3.75,
    },
    contextWindow: 1_000_000,
    maxTokens: 64_000,
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
};

function resolvePiModelCatalogFallback(
  resolved: PiResolvedModelReference,
): Model<any> | null {
  return PI_MODEL_CATALOG_FALLBACKS[`${resolved.provider}/${resolved.modelId}`] ?? null;
}

interface PiToolDefinitionOptions {
  includeSubagents?: boolean;
}

interface CloudflareEmailSender {
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

interface ChannelToolAttachmentInput {
  path: string;
  filename?: string;
  content_type?: string;
  caption?: string;
  send_as?: string;
}

interface ResolvedChannelAttachment {
  path: string;
  filename: string;
  contentType: string;
  content: ArrayBuffer;
  size: number;
  caption?: string;
  sendAs?: string;
}

const MAX_CHANNEL_OUTBOUND_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const ACTIVE_LEGACY_WORKSPACE_MIGRATION_STATUSES = new Set<LegacyWorkspaceMigrationStatus>([
  "queued",
  "scanning_legacy",
  "planning",
  "copying",
  "verifying",
  "failed",
  "canceled",
]);

export interface ChatEnv extends WorkspaceFilesystemEnv, ProjectRuntimeServiceVmEnv {
  CHAT_THREAD: DurableObjectNamespace<ChatThreadDO>;
  ORG: DurableObjectNamespace<OrgDO>;
  USER: DurableObjectNamespace<UserDO>;
  WORKSPACE: DurableObjectNamespace<WorkspaceDO>;
  WORKSPACE_CRON?: DurableObjectNamespace<WorkspaceCronDO>;
  DETERMINISTIC_AUTOMATION_WORKFLOWS?: Workflow;
  WORKER_LOGS?: DurableObjectNamespace<WorkerLogsDO>;
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
  CF_DISPATCH_NAMESPACE?: string;
  ENABLE_LEGACY_WORKSPACE_MIGRATION?: string;
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
    trimmedAssistantBlocks: number;
  };
}

export interface PiTurnRecoveryAdminState {
  pending: FiberInspection | null;
  legacyPending?: LegacyPiTurnRecoveryRow | null;
  inFlightCount: number;
}

interface LegacyPiTurnRecoveryRow {
  turn_id: string;
  status: "running" | "recovering";
  active_user_id: string | null;
  retry_count: number;
  started_at: number;
  updated_at: number;
}

function cloneDurableState<T>(value: T): T {
  if (value === null || value === undefined) {
    return value;
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

const PI_PROVIDER_SUPPORTED_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
]);

function normalizePiImageMimeType(mimeType: string): string {
  const normalized = mimeType.trim().toLowerCase();
  return normalized === "image/jpg" ? "image/jpeg" : normalized;
}

function piUnsupportedImageText(mimeType: unknown): string {
  const label =
    typeof mimeType === "string" && mimeType.trim()
      ? mimeType.trim()
      : "unknown MIME type";
  return `(image omitted: unsupported MIME type ${label})`;
}

const PI_SQLITE_STORAGE_SOFT_LIMIT_CHARS = 1_500_000;
const PI_MAX_PERSISTED_IMAGE_DATA_CHARS = 512_000;
const PI_MAX_PERSISTED_TEXT_CHARS = 200_000;
const PI_R2_IMAGE_REF_METADATA_KEY = "chiridionR2Image";
const PI_TOOL_RESULT_MAX_LINES = 2_000;
const PI_TOOL_RESULT_MAX_BYTES = 50 * 1024;
const PI_TOOL_RESULT_R2_REF_METADATA_KEY = "chiridionR2ToolResult";
const PI_TAIL_TRUNCATED_TOOL_NAMES = new Set([
  "bash",
]);

interface PiR2ImageReference {
  key: string;
  mimeType: string;
  size: number;
  sha256: string;
  storedAt: number;
}

interface PiR2ToolResultReference {
  path: string;
  size: number;
  sha256: string;
  storedAt: number;
}

interface PiToolResultTruncation {
  truncated: true;
  truncatedBy: "lines" | "bytes";
  direction: "head" | "tail";
  totalLines: number;
  outputLines: number;
  totalBytes: number;
  outputBytes: number;
  maxLines: number;
  maxBytes: number;
  fullOutput?: PiR2ToolResultReference;
}

interface PiSqlStorageStats {
  externalizedImages: number;
  omittedImages: number;
  truncatedStrings: number;
  omittedWholeMessage: boolean;
  originalChars: number;
  storedChars: number;
}

interface PiSqlStorageSerialization {
  payload: string;
  stats: PiSqlStorageStats;
}

function hasPiR2ImageReferenceMetadata(record: Record<string, unknown>): boolean {
  const metadata = record.metadata;
  if (!metadata || typeof metadata !== "object") return false;
  const ref = (metadata as Record<string, unknown>)[PI_R2_IMAGE_REF_METADATA_KEY];
  if (!ref || typeof ref !== "object") return false;
  const refRecord = ref as Record<string, unknown>;
  return (
    typeof refRecord.key === "string" &&
    refRecord.key.length > 0 &&
    typeof refRecord.mimeType === "string" &&
    refRecord.mimeType.length > 0 &&
    typeof refRecord.sha256 === "string" &&
    refRecord.sha256.length > 0
  );
}

function piLargeImageStorageText(mimeType: unknown, dataChars: number): string {
  const label =
    typeof mimeType === "string" && mimeType.trim()
      ? mimeType.trim()
      : "unknown MIME type";
  return `(image data omitted from persisted transcript: ${label}, ${dataChars} base64 chars)`;
}

function emptyPiSqlStorageStats(): PiSqlStorageStats {
  return {
    omittedImages: 0,
    externalizedImages: 0,
    truncatedStrings: 0,
    omittedWholeMessage: false,
    originalChars: 0,
    storedChars: 0,
  };
}

function truncatePiStorageString(value: string, stats?: PiSqlStorageStats): string {
  if (value.length <= PI_MAX_PERSISTED_TEXT_CHARS) return value;
  const omitted = value.length - PI_MAX_PERSISTED_TEXT_CHARS;
  if (stats) stats.truncatedStrings += 1;
  return `${value.slice(0, PI_MAX_PERSISTED_TEXT_CHARS)}\n\n[...truncated ${omitted} characters for storage safety...]`;
}

function sanitizePiProviderContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  let changed = false;
  const sanitized = content.map((part) => {
    if (!part || typeof part !== "object") return part;
    const item = part as Record<string, unknown>;
    if (item.type !== "image") return part;

    const mimeType = typeof item.mimeType === "string"
      ? normalizePiImageMimeType(item.mimeType)
      : "";
    const data = typeof item.data === "string" ? item.data : "";
    if (
      mimeType &&
      PI_PROVIDER_SUPPORTED_IMAGE_MIME_TYPES.has(mimeType) &&
      (data || hasPiR2ImageReferenceMetadata(item))
    ) {
      if (mimeType === item.mimeType) return part;
      changed = true;
      return { ...item, mimeType };
    }

    changed = true;
    return { type: "text", text: piUnsupportedImageText(item.mimeType) };
  });

  return changed ? sanitized : content;
}

function sanitizePiProviderMessage(message: AgentMessage): AgentMessage {
  if (!message || typeof message !== "object") return message;
  const record = message as unknown as Record<string, unknown>;
  if (!Array.isArray(record.content)) return message;
  const content = sanitizePiProviderContent(record.content);
  if (content === record.content) return message;
  return { ...record, content } as unknown as AgentMessage;
}

function sanitizePiModelMessage(message: AgentMessage): AgentMessage {
  return sanitizePiProviderMessage(stripPiUiMetadata(message));
}

function sanitizePiProviderContentForSqlStorage(content: unknown, stats?: PiSqlStorageStats): unknown {
  const supported = sanitizePiProviderContent(content);
  if (!Array.isArray(supported)) return supported;
  let changed = supported !== content;
  const sanitized = supported.map((part) => {
    if (!part || typeof part !== "object") return part;
    const item = part as Record<string, unknown>;
    if (item.type === "image") {
      const data = typeof item.data === "string" ? item.data : "";
      if (data.length > PI_MAX_PERSISTED_IMAGE_DATA_CHARS) {
        if (stats) stats.omittedImages += 1;
        changed = true;
        return {
          type: "text",
          text: piLargeImageStorageText(item.mimeType, data.length),
        };
      }
    }
    return part;
  });
  return changed ? sanitized : content;
}

function shrinkPiValueForSqlStorage(value: unknown, depth = 0, stats?: PiSqlStorageStats): unknown {
  if (typeof value === "string") return truncatePiStorageString(value, stats);
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (depth > 8) return "[nested value omitted for storage safety]";
  if (Array.isArray(value)) {
    return value.map((item) => shrinkPiValueForSqlStorage(item, depth + 1, stats));
  }
  const record = value as Record<string, unknown>;
  if (record.type === "image" && typeof record.data === "string") {
    if (record.data.length > PI_MAX_PERSISTED_IMAGE_DATA_CHARS) {
      if (stats) stats.omittedImages += 1;
      return {
        type: "text",
        text: piLargeImageStorageText(record.mimeType, record.data.length),
      };
    }
    return { ...record, data: record.data };
  }
  const next: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(record)) {
    next[key] = shrinkPiValueForSqlStorage(nested, depth + 1, stats);
  }
  return next;
}

function preparePiMessageForSqlStorage(message: AgentMessage, stats?: PiSqlStorageStats): AgentMessage {
  if (!message || typeof message !== "object") return message;
  const providerSanitized = sanitizePiProviderMessage(message);
  const record = providerSanitized as unknown as Record<string, unknown>;
  const content = Array.isArray(record.content)
    ? sanitizePiProviderContentForSqlStorage(record.content, stats)
    : record.content;
  const next = content === record.content ? record : { ...record, content };
  return shrinkPiValueForSqlStorage(next, 0, stats) as AgentMessage;
}

function serializePiMessageForSqlStorageDetailed(message: AgentMessage): PiSqlStorageSerialization {
  const stats = emptyPiSqlStorageStats();
  stats.originalChars = JSON.stringify(message).length;
  let prepared = preparePiMessageForSqlStorage(message, stats);
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

function serializePiMessageForSqlStorage(message: AgentMessage): string {
  return serializePiMessageForSqlStorageDetailed(message).payload;
}

type NormalizedTodoStatus = "pending" | "in_progress" | "completed";

interface NormalizedTodoItem {
  content: string;
  status: NormalizedTodoStatus;
  activeForm: string;
}

interface ChatClientInitMessage {
  type: "init";
  threadId?: string;
  lastEventId?: number;
}

interface ChatClientMessage {
  type: "message";
  content?: string;
  clientMessageId?: string;
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

export interface AgentEvalSessionResult {
  status: "completed" | "busy" | "error";
  error?: string;
  result?: string;
  events: Array<Record<string, unknown>>;
  messages: AgentEvalParsedMessage[];
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

export interface CodeModeToolsProps {
  orgId: string;
  workspaceId: string;
  threadId?: string;
  userId?: string;
  parentToolUseId?: string;
}

interface AIVirtualBindingProps {
  orgId: string;
  workspaceId: string;
  userId?: string;
}

interface CodeModeToolDefinition {
  name: string;
  description: string;
  parameters: TSchema;
  category: CodeModeToolCategory;
  examples: string[];
  sideEffect: boolean;
  externalDelivery: boolean;
}

interface CodeModeToolRegistration extends CodeModeToolDefinition {
  piPassthrough: boolean;
}

type CodeModeToolCategory =
  | "workspace"
  | "user_interaction"
  | "communication"
  | "apps"
  | "schedules"
  | "workflows"
  | "integrations"
  | "domains"
  | "web"
  | "agents"
  | "connections";

interface CodeModeToolOptions {
  piPassthrough?: boolean;
  category?: CodeModeToolCategory;
  examples?: string[];
  sideEffect?: boolean;
  externalDelivery?: boolean;
}

type CodeModeToolCallHandler = (
  binding: CodeModeToolsBinding,
  args: Record<string, unknown>,
  name: string,
) => Promise<unknown> | unknown;

type CodeModeR2Mount = "uploads" | "outputs" | "tmp";

interface CodeModeR2Path {
  mount: CodeModeR2Mount;
  key: string;
  path: string;
  relativePath: string;
}

type CodeModeFileLocation = "workspace" | "vm" | "r2";

interface CodeModeMoveEndpoint {
  location: CodeModeFileLocation;
  path: string;
  project?: string;
  contentType?: string;
}

interface CodeModeMoveFile {
  path: string;
  relativePath: string;
  size?: number;
  contentType?: string;
}

interface LegacyParsedChatMessageForPi {
  id?: unknown;
  role?: unknown;
  content?: unknown;
  created_at?: unknown;
  forkEntryId?: unknown;
}

const CODE_MODE_COMPATIBILITY_DATE = "2026-05-11";
const CODE_MODE_DEFAULT_TIMEOUT_MS = 60_000;
const CODE_MODE_MAX_TIMEOUT_MS = 600_000;
const TELEGRAM_BOT_API_TIMEOUT_MS = 15_000;
const CODE_MODE_DEFAULT_MAX_OUTPUT_CHARACTERS = 60_000;
const CODE_MODE_MAX_OUTPUT_CHARACTERS = 200_000;
const CODE_MODE_R2_READ_NOTICE_RESERVED_BYTES = 1024;
const CODE_MODE_R2_MAX_WRITE_BYTES = 10 * 1024 * 1024;
const CODE_MODE_R2_MAX_TEXT_OBJECT_BYTES = 10 * 1024 * 1024;
const JS_EXEC_EXCLUDED_TOOL_NAMES = new Set([
  // This tool waits for human input and can outlive js_exec's short sandbox
  // timeout. Keep it as a top-level Pi tool so the agent sees the submission.
  "prompt_connection_setup",
  "delete_connection",
  "delete_project",
  // Backing tool for env.WORKSPACE.*. Keep the user-facing runtime facade in
  // tools.help(), not the implementation detail.
  "workspace_info",
]);

function clampCodeModeInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? Math.trunc(value) : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function truncateCodeModeText(value: unknown, maxCharacters: number): string {
  const text = String(value ?? "");
  if (text.length <= maxCharacters) return text;
  return `${text.slice(0, maxCharacters)}\n\n[Truncated: ${maxCharacters} of ${text.length} characters]`;
}

function basenameForMove(path: string): string {
  return path.split("/").filter(Boolean).pop() || "";
}

function joinRelativeMovePath(root: string, child: string): string {
  const cleanRoot = root.replace(/^\/+|\/+$/g, "");
  const cleanChild = child.replace(/^\/+|\/+$/g, "");
  if (!cleanRoot) return cleanChild;
  if (!cleanChild) return cleanRoot;
  return `${cleanRoot}/${cleanChild}`;
}

function joinMoveDestinationPath(location: CodeModeFileLocation, root: string, child: string): string {
  const cleanChild = child.replace(/^\/+/, "");
  if (location === "r2") {
    const cleanRoot = root.replace(/^\/+|\/+$/g, "");
    return cleanRoot ? `${cleanRoot}/${cleanChild}` : cleanChild;
  }
  const cleanRoot = root.replace(/\/+$/g, "");
  if (!cleanRoot || cleanRoot === "/") return `/${cleanChild}`;
  return `${cleanRoot}/${cleanChild}`;
}

function bytesToBase64ForMove(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytesForMove(value: string): Uint8Array {
  const binary = atob(value.replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function normalizeTodoStatus(value: unknown): NormalizedTodoStatus {
  const status = typeof value === "string" ? value.trim().toLowerCase() : "";
  switch (status) {
    case "completed":
    case "complete":
    case "done":
      return "completed";
    case "inprogress":
    case "in_progress":
    case "in-progress":
    case "running":
    case "active":
      return "in_progress";
    default:
      return "pending";
  }
}

function normalizeTodoText(value: unknown): string {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value).trim();
  }
  if (Array.isArray(value)) {
    return value
      .map(normalizeTodoText)
      .filter(Boolean)
      .join("");
  }
  return "";
}

function normalizeTodoItem(value: unknown, index: number): NormalizedTodoItem | null {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    const content = String(value).trim();
    return content ? { content, status: "pending", activeForm: content } : null;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const content =
    normalizeTodoText(record.content) ||
    normalizeTodoText(record.step) ||
    normalizeTodoText(record.title) ||
    normalizeTodoText(record.task) ||
    normalizeTodoText(record.text) ||
    normalizeTodoText(record.description) ||
    normalizeTodoText(record.name) ||
    `Task ${index + 1}`;
  const activeForm =
    normalizeTodoText(record.activeForm) ||
    normalizeTodoText(record.active_form) ||
    normalizeTodoText(record.active) ||
    content;

  return {
    content,
    status: normalizeTodoStatus(record.status),
    activeForm,
  };
}

function normalizeTodoItems(values: unknown[]): NormalizedTodoItem[] {
  return values
    .map(normalizeTodoItem)
    .filter((todo): todo is NormalizedTodoItem => todo !== null);
}

const EMPTY_PARAMETERS = Type.Object({});
const CONNECTION_QUERY_PARAMETERS = Type.Object({
  query: Type.Union([
    Type.String(),
    Type.Object({}, { additionalProperties: true }),
  ]),
});

function codeModeTool(
  name: string,
  description: string,
  parameters: TSchema = EMPTY_PARAMETERS,
  options: CodeModeToolOptions = {},
): CodeModeToolRegistration {
  return {
    name,
    description,
    parameters,
    category: options.category ?? "workspace",
    examples: options.examples ?? [],
    sideEffect: options.sideEffect ?? false,
    externalDelivery: options.externalDelivery ?? false,
    piPassthrough: options.piPassthrough ?? false,
  };
}

function codeModePassthroughTool(
  name: string,
  description: string,
  parameters: TSchema = EMPTY_PARAMETERS,
  options: Omit<CodeModeToolOptions, "piPassthrough"> = {},
): CodeModeToolRegistration {
  return codeModeTool(name, description, parameters, { ...options, piPassthrough: true });
}

function codeModeDefinition(
  registration: CodeModeToolRegistration,
): CodeModeToolDefinition {
  return {
    name: registration.name,
    description: registration.description,
    parameters: registration.parameters,
    category: registration.category,
    examples: registration.examples,
    sideEffect: registration.sideEffect,
    externalDelivery: registration.externalDelivery,
  };
}

const CODE_MODE_CONTAINER_TOOL_NAMES = [
  "read",
  "write",
  "ls",
  "edit",
  "grep",
  "find",
  "delete",
] as const;

const CODE_MODE_CONTAINER_TOOL_DEFINITIONS = CODE_MODE_CONTAINER_TOOL_NAMES.map(
  (name) => {
    const definition = PI_CONTAINER_TOOL_DEFINITIONS[name];
    return codeModeTool(definition.name, definition.description, definition.parameters, {
      category: "workspace",
      sideEffect: ["bash", "write", "edit"].includes(definition.name),
    });
  },
);

const MOVE_ENDPOINT_PARAMETERS = Type.Object({
  location: Type.Union([
    Type.Literal("workspace"),
    Type.Literal("vm"),
    Type.Literal("r2"),
  ], {
    description: "Required filesystem location: workspace, vm, or r2.",
  }),
  path: Type.String({
    description: "Path at that location. R2 paths must be uploads/<path>, outputs/<path>, or tmp/<path> with no leading slash.",
  }),
  project: Type.Optional(Type.String({
    description: "Required when location is vm; unique workspace project name.",
  })),
  content_type: Type.Optional(Type.String({
    description: "Destination R2 content type override.",
  })),
}, { additionalProperties: false });

const BASH_TOOL = codeModeTool(
  "bash",
  "Run a bash command in a project VM. Requires the unique workspace project name and a concise description for the UI. Commands run from /workspace by default; pass cwd only for subdirectories in that checkout. Arguments: { command, project, description, cwd?, timeoutMs?, timeoutSeconds?, env? }.",
  Type.Object({
    command: Type.String(),
    project: Type.String(),
    description: Type.String(),
    cwd: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
    timeoutSeconds: Type.Optional(Type.Number()),
    env: Type.Optional(Type.Object({}, { additionalProperties: true })),
  }, { additionalProperties: false }),
);

function vmTargetParameters() {
  return {
    location: Type.Optional(Type.Literal("vm")),
    project: Type.String(),
  };
}

const ASK_USER_QUESTION_TOOL = codeModePassthroughTool(
  "AskUserQuestion",
  "Ask the user one or more multiple-choice questions in the chat UI and wait for answers. Arguments: { questions }.",
  Type.Object({
    questions: Type.Array(Type.Object({}, { additionalProperties: true })),
  }),
  {
    category: "user_interaction",
  },
);
const CHANNEL_ATTACHMENT_PARAMETERS = Type.Optional(Type.Array(Type.Object({
  path: Type.String(),
  filename: Type.Optional(Type.String()),
  content_type: Type.Optional(Type.String()),
  caption: Type.Optional(Type.String()),
  send_as: Type.Optional(Type.String()),
})));
const SEND_EMAIL_TOOL = codeModeTool(
  "send_email",
  "Send an email from the current workspace. This tool is available only inside js_exec as tools.send_email(...) or deterministic workflows as this.env.TOOLS.send_email(...); it is not a top-level tool. Use this only when channel instructions require an external reply or the user explicitly asks to send an email. Normal assistant replies stay in chat and must not be emailed. Arguments: { to, subject, text?, html?, reply_to?, attachments? }.",
  Type.Object({
    to: Type.String(),
    subject: Type.String(),
    text: Type.Optional(Type.String()),
    html: Type.Optional(Type.String()),
    reply_to: Type.Optional(Type.String()),
    attachments: CHANNEL_ATTACHMENT_PARAMETERS,
  }),
  {
    category: "communication",
    examples: [
      `await tools.send_email({ to: "person@example.com", subject: "Update", text: "Here is the update." })`,
      `await tools.send_email({ to: "person@example.com", subject: "Files", text: "Attached.", attachments: [{ path: "uploads/report.pdf" }] })`,
    ],
    sideEffect: true,
    externalDelivery: true,
  },
);
const SEND_SLACK_MESSAGE_TOOL = codeModeTool(
  "send_slack_message",
  "Send a Slack message from the current workspace. This tool is available only inside js_exec as tools.send_slack_message(...) or deterministic workflows as this.env.TOOLS.send_slack_message(...); it is not a top-level tool. In a Slack-originated thread, routing defaults to that Slack conversation. Otherwise provide channel_id and, when multiple Slack connections exist, integration_id or team_id. Use thread_ts to reply in a Slack thread. Arguments: { text?, integration_id?, team_id?, channel_id?, thread_ts?, attachments? }.",
  Type.Object({
    text: Type.Optional(Type.String()),
    integration_id: Type.Optional(Type.String()),
    team_id: Type.Optional(Type.String()),
    channel_id: Type.Optional(Type.String()),
    thread_ts: Type.Optional(Type.String()),
    attachments: CHANNEL_ATTACHMENT_PARAMETERS,
  }),
  {
    category: "communication",
    examples: [
      `await tools.send_slack_message({ channel_id: "C123", text: "Here is the update." })`,
      `await tools.send_slack_message({ integration_id: "slack_prod", channel_id: "C123", thread_ts: "1712345678.901", text: "Replying in thread." })`,
    ],
    sideEffect: true,
    externalDelivery: true,
  },
);
const SEND_TELEGRAM_MESSAGE_TOOL = codeModeTool(
  "send_telegram_message",
  "Send a Telegram message from the current workspace. This tool is available only inside js_exec as tools.send_telegram_message(...) or deterministic workflows as this.env.TOOLS.send_telegram_message(...); it is not a top-level tool. In a Telegram-originated thread, routing defaults to that chat. Outside Telegram threads, integration_id is optional when exactly one connected Telegram integration exists; if there are multiple, call tools.list_integrations({}) and use the Telegram integration id. Do not invent chat ids. Image attachments are sent as native Telegram photos when possible; use attachments[].send_as = 'document' to force file/document delivery. Arguments: { text?, chat_id?, integration_id?, attachments? }.",
  Type.Object({
    text: Type.Optional(Type.String()),
    chat_id: Type.Optional(Type.String()),
    integration_id: Type.Optional(Type.String()),
    attachments: CHANNEL_ATTACHMENT_PARAMETERS,
  }),
  {
    category: "communication",
    examples: [
      `await tools.send_telegram_message({ integration_id: "telegram_direct", text: "Here is the update." })`,
      `await tools.send_telegram_message({ integration_id: "telegram_direct", text: "Attached.", attachments: [{ path: "uploads/photo.jpg" }] })`,
    ],
    sideEffect: true,
    externalDelivery: true,
  },
);
const WEB_SEARCH_TOOL = codeModePassthroughTool(
  "WebSearch",
  "Search the web. Arguments: { query, numResults?, maxCharacters? }.",
  Type.Object({
    query: Type.String(),
    numResults: Type.Optional(Type.Number()),
    maxCharacters: Type.Optional(Type.Number()),
    includeDomains: Type.Optional(Type.Array(Type.String())),
    excludeDomains: Type.Optional(Type.Array(Type.String())),
    startPublishedDate: Type.Optional(Type.String()),
    endPublishedDate: Type.Optional(Type.String()),
    searchType: Type.Optional(Type.String()),
    category: Type.Optional(Type.String()),
  }),
  {
    category: "web",
    examples: [`await tools.WebSearch({ query: "Cloudflare Workers Durable Objects", numResults: 5 })`],
  },
);
const WEB_FETCH_TOOL = codeModePassthroughTool(
  "WebFetch",
  "Fetch text from a URL. Arguments: { url, maxCharacters? }.",
  Type.Object({
    url: Type.String(),
    maxCharacters: Type.Optional(Type.Number()),
    query: Type.Optional(Type.String()),
    fresh: Type.Optional(Type.Boolean()),
    content: Type.Optional(Type.String()),
  }),
  {
    category: "web",
    examples: [`await tools.WebFetch({ url: "https://developers.cloudflare.com/workers/", maxCharacters: 12000 })`],
  },
);
const AGENT_TOOL = codeModeTool(
  "Agent",
  "Run a focused subagent in the same workspace. Arguments: { prompt, description?, agent?, model? }.",
  Type.Object({
    prompt: Type.String(),
    description: Type.Optional(Type.String()),
    agent: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
  }),
  {
    category: "agents",
  },
);
const EXPLORE_TOOL = codeModeTool(
  "Explore",
  "Run a focused read-oriented exploration subagent in the same workspace. Arguments: { prompt? or query?, description?, agent?, model? }.",
  Type.Object({
    prompt: Type.Optional(Type.String()),
    query: Type.Optional(Type.String()),
    description: Type.Optional(Type.String()),
    agent: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
  }),
  {
    category: "agents",
  },
);

const CODE_MODE_TOOL_REGISTRY: CodeModeToolRegistration[] = [
  ...CODE_MODE_CONTAINER_TOOL_DEFINITIONS,
  BASH_TOOL,
  codeModeTool(
    "vm_exec",
    "Run a command in a project VM. Prefer the js_exec vm.exec({ command, project, ...options }) facade; vm.exec(command, options) also works. Commands run from /workspace by default; pass cwd only for subdirectories in that checkout. Arguments: { command, project, location?: 'vm', cwd?, timeoutMs?, timeoutSeconds?, env? }.",
    Type.Object({
      command: Type.String(),
      ...vmTargetParameters(),
      cwd: Type.Optional(Type.String()),
      timeoutMs: Type.Optional(Type.Number()),
      timeoutSeconds: Type.Optional(Type.Number()),
      env: Type.Optional(Type.Object({}, { additionalProperties: true })),
    }),
  ),
  codeModeTool(
    "move",
    "Transfer files between any two explicit locations: workspace, vm, or r2. Copies by default and overwrites the destination. Use deleteSource: true only when you intentionally want a destructive move after a successful copy. Arguments: { source: { location, path, project? }, destination: { location, path, project?, content_type? }, deleteSource? }.",
    Type.Object({
      source: MOVE_ENDPOINT_PARAMETERS,
      destination: MOVE_ENDPOINT_PARAMETERS,
      deleteSource: Type.Optional(Type.Boolean({
        description: "Delete the source after all destination writes succeed. Defaults to false.",
      })),
    }, { additionalProperties: false }),
    { category: "workspace", sideEffect: true },
  ),
  codeModePassthroughTool(
    "list_projects",
    "List known git/compute projects for this workspace as a nested tree. Includes project descriptions. Top-level rows are source projects; clone projects are nested under each source project's clones[] with cloneCount, like worktrees attached to the same remote. Arguments: {}.",
  ),
  codeModePassthroughTool(
    "create_project",
    "Create a project with one Artifacts Git repo and one default main VM checkout. Project names must be unique within the workspace. New projects require a concise description explaining what the project is for. Arguments: { name, description }.",
    Type.Object({
      name: Type.String(),
      description: Type.String(),
    }, { additionalProperties: false }),
  ),
  codeModePassthroughTool(
    "set_project_description",
    "Set the description for an existing project by its unique workspace project name. Use this when the project's purpose changes or needs clarification. Arguments: { project, description }.",
    Type.Object({
      project: Type.String(),
      description: Type.String(),
    }, { additionalProperties: false }),
    {
      sideEffect: true,
    },
  ),
  codeModePassthroughTool(
    "clone_project",
    "Clone an existing project's VM filesystem into a fresh project VM while keeping the same Artifacts Git remote. This captures current VM files, including uncommitted changes. Optional description overrides the generated clone description. Arguments: { sourceProject, name?, description? }.",
    Type.Object({
      sourceProject: Type.String(),
      name: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
    }, { additionalProperties: false }),
    {
      sideEffect: true,
    },
  ),
  codeModePassthroughTool(
    "delete_project",
    "Delete a project after the user confirms in chat. Use this as a top-level tool, not from js_exec. Accepts the unique workspace project name. Deleting a source project also deletes its clone projects. Arguments: { project }.",
    Type.Object({
      project: Type.String(),
    }, { additionalProperties: false }),
    {
      sideEffect: true,
    },
  ),
  ASK_USER_QUESTION_TOOL,
  SEND_EMAIL_TOOL,
  SEND_SLACK_MESSAGE_TOOL,
  SEND_TELEGRAM_MESSAGE_TOOL,
  codeModePassthroughTool(
    "TodoWrite",
    "Update the visible task list in the chat UI. Arguments: { todos: [{ content, status, activeForm? }] }. Status is pending, in_progress, or completed.",
    Type.Object({
      todos: Type.Array(
        Type.Object({
          content: Type.Optional(Type.String()),
          step: Type.Optional(Type.String()),
          title: Type.Optional(Type.String()),
          task: Type.Optional(Type.String()),
          status: Type.Optional(Type.String()),
          activeForm: Type.Optional(Type.String()),
          active_form: Type.Optional(Type.String()),
        }, { additionalProperties: true }),
      ),
    }),
    {
      category: "user_interaction",
      sideEffect: true,
    },
  ),
  codeModeTool(
    "workspace_info",
    "Get current workspace metadata for js_exec, including email_address when users can email the current workspace. Prefer await env.WORKSPACE.emailAddress() when you only need the address. Arguments: {}.",
    EMPTY_PARAMETERS,
    {
      category: "workspace",
    },
  ),
  codeModePassthroughTool(
    "set_preview",
    "Set the active preview to exactly one real target: an app or a file. App example: { app_name: 'poll-maker' }. Durable workspace file example: { location: 'workspace', path: '/notes.md' }. Project VM file example: { location: 'vm', project: 'menu-app', path: 'index.html' }. R2 file example: { location: 'r2', path: 'outputs/report.html' }. Successful file previews are validated before the preview changes. Arguments: { script_name?, app_name?, is_public?, path?, content_type?, location?, project? }.",
    Type.Object({
      script_name: Type.Optional(Type.String()),
      app_name: Type.Optional(Type.String()),
      is_public: Type.Optional(Type.Boolean()),
      path: Type.Optional(Type.String()),
      content_type: Type.Optional(Type.String()),
      location: Type.Optional(Type.Union([
        Type.Literal("workspace"),
        Type.Literal("vm"),
        Type.Literal("r2"),
      ])),
      project: Type.Optional(Type.String()),
    }),
    {
      category: "apps",
      sideEffect: true,
    },
  ),
  codeModePassthroughTool("list_apps", "List deployed apps for the current workspace.", EMPTY_PARAMETERS, {
    category: "apps",
  }),
  codeModePassthroughTool(
    "set_app_visibility",
    "Change a deployed app visibility. Arguments: { script_name, is_public }.",
    Type.Object({
      script_name: Type.String(),
      is_public: Type.Boolean(),
    }),
    {
      category: "apps",
      sideEffect: true,
    },
  ),
  codeModePassthroughTool(
    "get_latest_logs",
    "Get recent logs for a deployed app. Arguments: { script_name, limit?, since_ms? }.",
    Type.Object({
      script_name: Type.String(),
      limit: Type.Optional(Type.Number()),
      since_ms: Type.Optional(Type.Number()),
    }),
    {
      category: "apps",
    },
  ),
  codeModePassthroughTool(
    "take_screenshot",
    "Capture a screenshot of a deployed workspace app. Arguments: { script_name, path?, width?, height?, wait_ms? }.",
    Type.Object({
      script_name: Type.String(),
      path: Type.Optional(Type.String()),
      width: Type.Optional(Type.Number()),
      height: Type.Optional(Type.Number()),
      wait_ms: Type.Optional(Type.Number()),
    }),
    {
      category: "apps",
    },
  ),
  codeModePassthroughTool("list_scheduled_prompts", "List scheduled prompts for the current workspace.", EMPTY_PARAMETERS, {
    category: "schedules",
  }),
  codeModePassthroughTool(
    "create_scheduled_prompt",
    "Create a scheduled prompt. Arguments: { name, prompt, cron_expression, enabled? }.",
    Type.Object({
      name: Type.String(),
      prompt: Type.String(),
      cron_expression: Type.String(),
      enabled: Type.Optional(Type.Boolean()),
    }),
    {
      category: "schedules",
      sideEffect: true,
    },
  ),
  codeModePassthroughTool(
    "update_scheduled_prompt",
    "Update a scheduled prompt. Arguments: { prompt_id, name?, prompt?, cron_expression?, enabled? }.",
    Type.Object({
      prompt_id: Type.String(),
      name: Type.Optional(Type.String()),
      prompt: Type.Optional(Type.String()),
      cron_expression: Type.Optional(Type.String()),
      enabled: Type.Optional(Type.Boolean()),
    }),
    {
      category: "schedules",
      sideEffect: true,
    },
  ),
  codeModePassthroughTool(
    "delete_scheduled_prompt",
    "Delete a scheduled prompt. Arguments: { prompt_id }.",
    Type.Object({ prompt_id: Type.String() }),
    {
      category: "schedules",
      sideEffect: true,
    },
  ),
  codeModePassthroughTool(
    "run_scheduled_prompt_now",
    "Trigger a scheduled prompt immediately. Arguments: { prompt_id }.",
    Type.Object({ prompt_id: Type.String() }),
    {
      category: "schedules",
      sideEffect: true,
    },
  ),
  codeModePassthroughTool(
    "list_workflows",
    "List workflows for the current workspace. Workflows are deterministic JavaScript code that runs on a schedule.",
    EMPTY_PARAMETERS,
    {
      category: "workflows",
    },
  ),
  codeModePassthroughTool(
    "validate_workflow",
    "Validate workflow source without saving it. Arguments: { source }.",
    Type.Object({ source: Type.String() }),
    {
      category: "workflows",
    },
  ),
  codeModePassthroughTool(
    "create_workflow",
    "Create a workflow. Arguments: { name, source, cron_expression, description, enabled? }.",
    Type.Object({
      name: Type.String(),
      source: Type.String(),
      cron_expression: Type.String(),
      description: Type.String(),
      enabled: Type.Optional(Type.Boolean()),
    }),
    {
      category: "workflows",
      sideEffect: true,
    },
  ),
  codeModePassthroughTool(
    "update_workflow",
    "Update a workflow. Arguments: { workflow_id, name?, source?, cron_expression?, description?, enabled? }.",
    Type.Object({
      workflow_id: Type.String(),
      name: Type.Optional(Type.String()),
      source: Type.Optional(Type.String()),
      cron_expression: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      enabled: Type.Optional(Type.Boolean()),
    }),
    {
      category: "workflows",
      sideEffect: true,
    },
  ),
  codeModePassthroughTool(
    "delete_workflow",
    "Delete a workflow. Arguments: { workflow_id }.",
    Type.Object({ workflow_id: Type.String() }),
    {
      category: "workflows",
      sideEffect: true,
    },
  ),
  codeModePassthroughTool(
    "run_workflow_now",
    "Start a workflow immediately. Arguments: { workflow_id }.",
    Type.Object({ workflow_id: Type.String() }),
    {
      category: "workflows",
      sideEffect: true,
    },
  ),
  codeModePassthroughTool(
    "list_integrations",
    "List configured integrations for the current workspace. Channel integrations include recommended_access.recommended_actions with js_exec examples such as tools.send_telegram_message(...). Arguments: { category? }.",
    Type.Object({ category: Type.Optional(Type.String()) }),
    {
      category: "integrations",
      examples: [`await tools.list_integrations({ category: "communication" })`],
    },
  ),
  codeModePassthroughTool(
    "list_integration_types",
    "List available integration types. Arguments: { category? }. For a native remote MCP server, use integration_type `remote_mcp`; the returned type metadata includes setup hints and MCP capability flags.",
    Type.Object({ category: Type.Optional(Type.String()) }),
    {
      category: "integrations",
    },
  ),
  codeModePassthroughTool(
    "create_integration",
    "Create an integration. Arguments: { integration_type, name, config?, credentials? }. Use integration_type `remote_mcp` for native remote MCP servers; set config.server_url, config.auth_type, and credentials.token when token auth is required.",
    Type.Object({
      integration_type: Type.String(),
      name: Type.String(),
      config: Type.Optional(Type.Object({}, { additionalProperties: true })),
      credentials: Type.Optional(Type.Object({}, { additionalProperties: true })),
    }),
    {
      category: "integrations",
      sideEffect: true,
    },
  ),
  codeModePassthroughTool(
    "prompt_connection_setup",
    "Prompt the user to set up or reauthorize a connection in the chat UI and wait for completion. Use this as a top-level tool, not from js_exec. Use integration_type `remote_mcp` for native remote MCP servers. Pass integration_id or connection_id to update an existing connection during reauth. You may pass config and credentials to pre-populate known form fields. Arguments: { integration_type, integration_id?, connection_id?, suggested_name?, message?, config?, credentials?, display_name?, description?, instructions?, fields? }.",
    Type.Object({
      integration_type: Type.String(),
      integration_id: Type.Optional(Type.String()),
      connection_id: Type.Optional(Type.String()),
      suggested_name: Type.Optional(Type.String()),
      message: Type.Optional(Type.String()),
      config: Type.Optional(Type.Object({}, { additionalProperties: true })),
      credentials: Type.Optional(Type.Object({}, { additionalProperties: true })),
      display_name: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      instructions: Type.Optional(Type.String()),
      fields: Type.Optional(Type.Array(Type.Object({}, { additionalProperties: true }))),
    }),
    {
      category: "integrations",
      sideEffect: true,
    },
  ),
  codeModePassthroughTool(
    "delete_connection",
    "Delete a workspace connection after the user confirms in chat. Use this as a top-level tool, not from js_exec. Accepts a connection id, alias, type, or name. Arguments: { connection }.",
    Type.Object({
      connection: Type.String(),
    }, { additionalProperties: false }),
    {
      category: "integrations",
      sideEffect: true,
    },
  ),
  codeModePassthroughTool("get_custom_domain", "Get custom domain diagnostics for deployed apps.", EMPTY_PARAMETERS, {
    category: "domains",
  }),
  codeModePassthroughTool(
    "set_custom_domain",
    "Set an exact custom hostname for an app. Arguments: { app_name, hostname }.",
    Type.Object({
      app_name: Type.String(),
      hostname: Type.String(),
    }),
    {
      category: "domains",
      sideEffect: true,
    },
  ),
  codeModePassthroughTool(
    "remove_custom_domain",
    "Remove a custom hostname from an app. Arguments: { app_name }.",
    Type.Object({ app_name: Type.String() }),
    {
      category: "domains",
      sideEffect: true,
    },
  ),
  codeModePassthroughTool(
    "retry_custom_domain_hostnames",
    "Retry hostname provisioning for configured app custom domains.",
    EMPTY_PARAMETERS,
    {
      category: "domains",
      sideEffect: true,
    },
  ),
  WEB_SEARCH_TOOL,
  WEB_FETCH_TOOL,
  AGENT_TOOL,
  EXPLORE_TOOL,
  codeModeTool(
    "connections_list",
    "List workspace connections. Prefer calling this from js_exec as await env.CONNECTIONS.list().",
    EMPTY_PARAMETERS,
    {
      category: "connections",
      examples: [`await env.CONNECTIONS.list()`],
    },
  ),
  codeModeTool(
    "connections_get",
    "Get one workspace connection. Prefer calling this from js_exec as await env.CONNECTIONS.get(connection). Arguments: { connection }.",
    Type.Object({ connection: Type.String() }),
    {
      category: "connections",
      examples: [`await env.CONNECTIONS.get("telegram_direct")`],
    },
  ),
  codeModeTool(
    "connections_tools",
    "List MCP-backed tools for a workspace connection. Prefer calling this from js_exec as await env.CONNECTIONS.tools(connection). Arguments: { connection }.",
    Type.Object({ connection: Type.String() }),
    {
      category: "connections",
      examples: [`await env.CONNECTIONS.tools("stripe")`],
    },
  ),
  codeModeTool(
    "connections_methods",
    "List workspace connections and their method aliases, virtual channel actions, tool names, examples, and input schemas. Prefer calling this from js_exec as await env.CONNECTIONS.methods().",
    EMPTY_PARAMETERS,
    {
      category: "connections",
      examples: [`await env.CONNECTIONS.methods()`],
    },
  ),
  codeModeTool(
    "connections_find",
    "Find one workspace connection method catalog entry by alias, id, type, or name. Prefer calling this from js_exec as await env.CONNECTIONS.find(query). Arguments: { query }.",
    CONNECTION_QUERY_PARAMETERS,
    {
      category: "connections",
      examples: [`const entry = await env.CONNECTIONS.find("clickhouse")`],
    },
  ),
  codeModeTool(
    "connections_test",
    "Run a quick workspace connection smoke test. Prefer calling this from js_exec as await env.CONNECTIONS.test(query). Arguments: { query }.",
    CONNECTION_QUERY_PARAMETERS,
    {
      category: "connections",
      examples: [`await env.CONNECTIONS.test("clickhouse")`],
    },
  ),
];

const CODE_MODE_TOOL_DEFINITIONS: CodeModeToolDefinition[] = CODE_MODE_TOOL_REGISTRY
  .map(codeModeDefinition);
const CODE_MODE_PI_PASSTHROUGH_TOOL_DEFINITIONS: CodeModeToolDefinition[] =
  CODE_MODE_TOOL_REGISTRY
    .filter((registration) => registration.piPassthrough)
    .map(codeModeDefinition);

const FILE_TOOL_NAMES = new Set(["read", "write", "edit", "ls", "delete", "grep", "find"]);

function requireFileLocation(toolName: string, args: Record<string, unknown>): "workspace" | "vm" | "r2" {
  const location = args.location;
  if (location !== "workspace" && location !== "vm" && location !== "r2") {
    throw new Error(`${toolName} requires an explicit location: "workspace", "vm", or "r2"`);
  }
  if (location === "vm" && (typeof args.project !== "string" || args.project.trim().length === 0)) {
    throw new Error(`${toolName} with location "vm" requires a project name`);
  }
  if ((toolName === "grep" || toolName === "find") && location === "r2") {
    throw new Error(`${toolName} does not support location "r2"; use ls/read for R2 objects`);
  }
  return location;
}

function hasVmTarget(args: Record<string, unknown>): boolean {
  return args.location === "vm";
}

function hasR2Target(args: Record<string, unknown>): boolean {
  return args.location === "r2";
}

function projectForAgent(project: WorkspaceProject): Record<string, unknown> {
  return {
    name: project.name,
    description: project.description,
    kind: project.kind,
    defaultVmId: project.defaultVmId,
    cloneSource: project.cloneSource
      ? {
          name: project.cloneSource.name,
          description: project.cloneSource.description,
        }
      : undefined,
    clones: project.clones?.map(projectCloneForAgent),
    cloneCount: project.cloneCount,
    artifactRemote: project.artifactRemote,
    artifactDefaultBranch: project.artifactDefaultBranch,
    artifactStatus: project.artifactStatus,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

function projectCloneForAgent(project: WorkspaceProjectCloneSummary): Record<string, unknown> {
  return {
    name: project.name,
    description: project.description,
    defaultVmId: project.defaultVmId,
    artifactRemote: project.artifactRemote,
    artifactStatus: project.artifactStatus,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

export class CodeModeToolsBinding extends WorkerEntrypoint<ChatEnv, CodeModeToolsProps> {
  private static readonly TOOL_CALL_HANDLERS: Record<string, CodeModeToolCallHandler> = {
    AskUserQuestion: (binding, args) => binding.askUserQuestion(args),
    TodoWrite: (binding, args) => binding.updateTodos(args),
    set_preview: (binding, args) => binding.setPreview(args),
    list_apps: (binding) => binding.listApps(),
    set_app_visibility: (binding, args) => binding.setAppVisibility(args),
    get_latest_logs: (binding, args) => binding.getLatestLogs(args),
    take_screenshot: (binding, args) => binding.takeScreenshot(args),
    list_scheduled_prompts: (binding) => binding.listScheduledPrompts(),
    create_scheduled_prompt: (binding, args) => binding.createScheduledPrompt(args),
    update_scheduled_prompt: (binding, args) => binding.updateScheduledPrompt(args),
    delete_scheduled_prompt: (binding, args) => binding.deleteScheduledPrompt(args),
    run_scheduled_prompt_now: (binding, args) => binding.runScheduledPromptNow(args),
    list_workflows: (binding) => binding.listDeterministicAutomations(),
    validate_workflow: (binding, args) => binding.validateDeterministicAutomation(args),
    create_workflow: (binding, args) => binding.createDeterministicAutomation(args),
    update_workflow: (binding, args) => binding.updateDeterministicAutomation(args),
    delete_workflow: (binding, args) => binding.deleteDeterministicAutomation(args),
    run_workflow_now: (binding, args) => binding.runDeterministicAutomationNow(args),
    list_deterministic_automations: (binding) => binding.listDeterministicAutomations(),
    validate_deterministic_automation: (binding, args) => binding.validateDeterministicAutomation(args),
    create_deterministic_automation: (binding, args) => binding.createDeterministicAutomation(args),
    update_deterministic_automation: (binding, args) => binding.updateDeterministicAutomation(args),
    delete_deterministic_automation: (binding, args) => binding.deleteDeterministicAutomation(args),
    run_deterministic_automation_now: (binding, args) => binding.runDeterministicAutomationNow(args),
    workspace_info: (binding) => binding.getWorkspaceRuntimeInfo(),
    list_integrations: (binding, args) => binding.listIntegrations(args),
    list_integration_types: (binding, args) => binding.listIntegrationTypes(args),
    create_integration: (binding, args) => binding.createIntegration(args),
    prompt_connection_setup: (binding, args) => binding.promptConnectionSetup(args),
    delete_connection: (binding, args) => binding.deleteConnection(args),
    delete_project: (binding, args) => binding.deleteProject(args),
    send_email: (binding, args) => binding.sendEmail(args),
    send_slack_message: (binding, args) => binding.sendSlackMessage(args),
    send_telegram_message: (binding, args) => binding.sendTelegramMessage(args),
    get_custom_domain: (binding) => binding.getCustomDomain(),
    set_custom_domain: (binding, args) => binding.setCustomDomain(args),
    remove_custom_domain: (binding, args) => binding.removeCustomDomain(args),
    retry_custom_domain_hostnames: (binding) => binding.retryCustomDomainHostnames(),
    WebSearch: (binding, args) => binding.webSearch(args),
    WebFetch: (binding, args) => binding.webFetch(args),
    Agent: (binding, args, name) => binding.runSubagentTool(name, args),
    Explore: (binding, args, name) => binding.runSubagentTool(name, args),
    connections_list: (binding) => listConnections(binding.env, binding.connectionsContext),
    connections_get: (binding, args) => {
      const connection = typeof args.connection === "string" ? args.connection : "";
      if (!connection) throw new Error("connection is required");
      return getConnection(binding.env, binding.connectionsContext, connection);
    },
    connections_tools: (binding, args) => {
      const connection = typeof args.connection === "string" ? args.connection : "";
      if (!connection) throw new Error("connection is required");
      return listConnectionTools(binding.env, binding.connectionsContext, connection);
    },
    connections_methods: (binding) => listConnectionMethods(binding.env, binding.connectionsContext),
    connections_find: (binding, args) =>
      findConnectionMethodEntry(binding.env, binding.connectionsContext, binding.connectionQuery(args)),
    connections_test: (binding, args) =>
      testConnectionMethodEntry(binding.env, binding.connectionsContext, binding.connectionQuery(args)),
    connections_invoke: (binding, args) => invokeConnectionMethod(binding.env, binding.connectionsContext, {
      connection: typeof args.connection === "string" ? args.connection : "",
      method: typeof args.method === "string" ? args.method : undefined,
      input: args.input,
    }),
  };

  private get workspaceFs(): WorkspaceFilesystemClient {
    const { workspaceId } = this.ctx.props;
    if (!workspaceId) {
      throw new Error("Code mode tool binding is missing workspace scope");
    }
    return new WorkspaceFilesystemClient(this.env, workspaceId);
  }

  private get connectionsContext() {
    const { workspaceId, orgId, userId } = this.ctx.props;
    if (!workspaceId || !orgId) {
      throw new Error("Code mode tool binding is missing connection scope");
    }
    return { workspaceId, orgId, userId };
  }

  private get piContainerTools(): PiContainerTools {
    return new PiContainerTools(this.workspaceFs, { images: this.env.IMAGES });
  }

  private get projectVm(): ProjectRuntimeServiceVmBridge {
    const { workspaceId, orgId } = this.ctx.props;
    if (!workspaceId || !orgId) {
      throw new Error("Code mode VM binding is missing workspace scope");
    }
    return new ProjectRuntimeServiceVmBridge({
      env: this.env,
      workspace: this.workspaceFs,
      commandEnv: () => this.createContainerCommandEnv(),
    });
  }

  private get orgStub(): DurableObjectStub<OrgDO> {
    const { orgId } = this.ctx.props;
    if (!orgId) throw new Error("Code mode tool binding is missing org scope");
    return this.env.ORG.get(this.env.ORG.idFromName(orgId));
  }

  private get workspaceStub(): DurableObjectStub<WorkspaceDO> {
    const { workspaceId } = this.ctx.props;
    if (!workspaceId) {
      throw new Error("Code mode tool binding is missing workspace scope");
    }
    return this.env.WORKSPACE.get(this.env.WORKSPACE.idFromName(workspaceId));
  }

  private get chatThreadStub(): DurableObjectStub<ChatThreadDO> {
    const { threadId } = this.ctx.props;
    if (!threadId) throw new Error("This tool requires chat thread scope");
    return this.env.CHAT_THREAD.get(this.env.CHAT_THREAD.idFromName(threadId));
  }

  private get cronStub(): DurableObjectStub<WorkspaceCronDO> {
    const { workspaceId } = this.ctx.props;
    if (!workspaceId) {
      throw new Error("Code mode tool binding is missing workspace scope");
    }
    if (!this.env.WORKSPACE_CRON) {
      throw new Error("Scheduled prompt tools are not configured");
    }
    return this.env.WORKSPACE_CRON.get(this.env.WORKSPACE_CRON.idFromName(workspaceId));
  }

  private async getOrgSlug(): Promise<string | null> {
    const info = await this.orgStub.getInfo();
    return typeof info?.slug === "string" && info.slug.trim() ? info.slug.trim() : null;
  }

  private async getWorkspaceRuntimeInfo(): Promise<Record<string, unknown>> {
    const workspaceInfo = await this.workspaceStub.getInfo();
    const emailDomain = getWorkspaceEmailDomain(this.env);
    const emailHandle = typeof workspaceInfo?.email_handle === "string"
      ? workspaceInfo.email_handle.trim()
      : "";
    const emailAddress = emailDomain && emailHandle
      ? buildWorkspaceEmailAddress(emailHandle, emailDomain)
      : null;
    return {
      id: workspaceInfo?.id ?? this.ctx.props.workspaceId,
      name: workspaceInfo?.name ?? null,
      email_address: emailAddress,
    };
  }

  private async createContainerCommandEnv(): Promise<Record<string, string>> {
    return {
      ...(await this.createWorkspaceCommandEnv()),
      ...(await this.createWranglerDeployEnv()),
    };
  }

  private async createWorkspaceCommandEnv(): Promise<Record<string, string>> {
    const { orgId, workspaceId, userId, threadId } = this.ctx.props;
    const env: Record<string, string> = {
      WORKSPACE_ID: workspaceId,
      ORG_ID: orgId,
      WRANGLER_SEND_METRICS: "false",
      CI: "1",
    };
    const dispatchNamespace = this.env.CF_DISPATCH_NAMESPACE?.trim();
    if (dispatchNamespace) {
      env.CF_DISPATCH_NAMESPACE = dispatchNamespace;
    }
    if (this.env.RUN_AGENT_EVALS === "1") {
      env.EVAL_ORG_ID = orgId;
      env.EVAL_WORKSPACE_ID = workspaceId;
      if (userId) env.EVAL_USER_ID = userId;
      if (threadId) env.EVAL_THREAD_ID = threadId;
    }
    return env;
  }

  private async createWranglerDeployEnv(): Promise<Record<string, string>> {
    const { orgId, workspaceId, threadId } = this.ctx.props;
    if (!orgId || !workspaceId) {
      return {};
    }

    const dockerProxyBaseUrl =
      this.env.SANDBOX_DOCKER_PROXY_BASE_URL?.trim().replace(/\/+$/, "") ||
      "http://host.docker.internal:8081";
    let proxyPath =
      `/v1/workspaces/${encodeURIComponent(orgId)}` +
      `/${encodeURIComponent(workspaceId)}`;
    const sandboxProxySecret = this.env.SANDBOX_PROXY_SECRET?.trim();
    if (threadId && sandboxProxySecret) {
      const threadToken = await createSignedToken(sandboxProxySecret, {
        org_id: orgId,
        // The host only validates org/workspace/thread claims; org_slug is
        // required by the shared signed-token helper but is not trusted here.
        org_slug: orgId,
        workspace_id: workspaceId,
        thread_id: threadId,
        scopes: ["sandbox_thread"],
        name: "sandbox-proxy-thread",
        exp: Date.now() + 6 * 60 * 60 * 1000,
      });
      proxyPath += `/thread-tokens/${encodeURIComponent(threadToken)}`;
    }
    proxyPath += "/client/v4";

    return {
      CLOUDFLARE_API_BASE_URL: `${dockerProxyBaseUrl}${proxyPath}`,
      CLOUDFLARE_API_TOKEN: "sandbox-outbound-proxy",
      CLOUDFLARE_ACCOUNT_ID: this.env.CF_ACCOUNT_ID?.trim() || "chiridion",
    };
  }

  private safeThreadR2SessionId(): string {
    const { threadId } = this.ctx.props;
    if (!threadId) {
      throw new Error("R2 temp paths require chat thread scope");
    }
    return threadId.replace(/[^a-zA-Z0-9_-]/g, "_");
  }

  private r2MountBaseKey(mount: CodeModeR2Mount): string {
    const { orgId, workspaceId } = this.ctx.props;
    if (!orgId || !workspaceId) {
      throw new Error("Code mode tool binding is missing R2 scope");
    }
    switch (mount) {
      case "uploads":
        return buildWorkspaceScopedR2Key(orgId, workspaceId, "user-uploads/");
      case "outputs":
        return buildWorkspaceScopedR2Key(orgId, workspaceId, "user-outputs/");
      case "tmp":
        return buildWorkspaceScopedR2Key(
          orgId,
          workspaceId,
          `chat-sessions/${this.safeThreadR2SessionId()}/pi-tool-results/tmp/`,
        );
    }
  }

  private normalizeR2RelativePath(path: string, allowDirectory: boolean): string {
    if (path.startsWith("/")) {
      throw new Error("R2 paths must be relative: use uploads/<path>, outputs/<path>, or tmp/<path>");
    }
    const relativePath = allowDirectory ? path.replace(/\/+$/, "") : path;
    if (relativePath.length > 1024) {
      throw new Error("R2 path exceeds the maximum length of 1024 characters");
    }
    if (!relativePath) return "";
    const segments = relativePath.split("/");
    if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
      throw new Error("R2 paths must not contain empty, '.', or '..' segments");
    }
    return relativePath;
  }

  private r2PathFromRelative(mount: CodeModeR2Mount, relativePath: string): string {
    return relativePath ? `${mount}/${relativePath}` : mount;
  }

  private resolveCodeModeR2Path(
    raw: Record<string, unknown>,
    options: { allowDirectory?: boolean; requireWritable?: boolean } = {},
  ): CodeModeR2Path {
    const rawPath = typeof raw.path === "string" ? raw.path.trim().replace(/\\/g, "/") : "";
    if (!rawPath) throw new Error("R2 path is required");
    const normalizedPath = this.normalizeR2RelativePath(rawPath, options.allowDirectory ?? false);
    const [mountPart, ...rest] = normalizedPath.split("/");
    if (mountPart !== "uploads" && mountPart !== "outputs" && mountPart !== "tmp") {
      throw new Error("R2 path must start with uploads/, outputs/, or tmp/");
    }
    const relativePath = rest.join("/");
    if (!options.allowDirectory && !relativePath) throw new Error("R2 object path is required");
    if (options.requireWritable && mountPart === "uploads") throw new Error("uploads/ is read-only");
    return {
      mount: mountPart,
      key: `${this.r2MountBaseKey(mountPart)}${relativePath}`,
      path: this.r2PathFromRelative(mountPart, relativePath),
      relativePath,
    };
  }

  private r2PublicUrl(target: CodeModeR2Path): string | null {
    if (target.mount === "tmp") return null;
    return `/api/workspaces/${this.ctx.props.workspaceId}/${target.mount}/${target.relativePath}`;
  }

  private formatR2ObjectMetadata(obj: R2Object, target: CodeModeR2Path): Record<string, unknown> {
    return {
      location: "r2",
      path: target.path,
      namespace: target.mount,
      publicUrl: this.r2PublicUrl(target),
      size: obj.size,
      etag: obj.etag,
      uploaded: obj.uploaded instanceof Date ? obj.uploaded.toISOString() : String(obj.uploaded),
      contentType: obj.httpMetadata?.contentType ?? null,
      customMetadata: obj.customMetadata ?? {},
    };
  }

  private textByteLength(value: string): number {
    return new TextEncoder().encode(value).byteLength;
  }

  private truncateR2ReadHead(
    content: string,
    maxBytes: number,
  ): {
    content: string;
    truncated: boolean;
    truncatedBy: "lines" | "bytes" | null;
    totalLines: number;
    totalBytes: number;
    outputLines: number;
    outputBytes: number;
    firstLineExceedsLimit: boolean;
    maxLines: number;
    maxBytes: number;
  } {
    const lines = content.split("\n");
    const totalLines = lines.length;
    const totalBytes = this.textByteLength(content);
    if (totalLines <= PI_TOOL_RESULT_MAX_LINES && totalBytes <= maxBytes) {
      return {
        content,
        truncated: false,
        truncatedBy: null,
        totalLines,
        totalBytes,
        outputLines: totalLines,
        outputBytes: totalBytes,
        firstLineExceedsLimit: false,
        maxLines: PI_TOOL_RESULT_MAX_LINES,
        maxBytes,
      };
    }
    if (this.textByteLength(lines[0] ?? "") > maxBytes) {
      return {
        content: "",
        truncated: true,
        truncatedBy: "bytes",
        totalLines,
        totalBytes,
        outputLines: 0,
        outputBytes: 0,
        firstLineExceedsLimit: true,
        maxLines: PI_TOOL_RESULT_MAX_LINES,
        maxBytes,
      };
    }
    const selected: string[] = [];
    let outputBytes = 0;
    let truncatedBy: "lines" | "bytes" = "lines";
    for (let index = 0; index < lines.length && index < PI_TOOL_RESULT_MAX_LINES; index += 1) {
      const line = lines[index] ?? "";
      if (selected.length >= PI_TOOL_RESULT_MAX_LINES) {
        truncatedBy = "lines";
        break;
      }
      const lineBytes = this.textByteLength(line) + (selected.length > 0 ? 1 : 0);
      if (outputBytes + lineBytes > maxBytes) {
        truncatedBy = "bytes";
        break;
      }
      selected.push(line);
      outputBytes += lineBytes;
    }
    if (selected.length >= PI_TOOL_RESULT_MAX_LINES && outputBytes <= maxBytes) {
      truncatedBy = "lines";
    }
    const outputContent = selected.join("\n");
    return {
      content: outputContent,
      truncated: true,
      truncatedBy,
      totalLines,
      totalBytes,
      outputLines: selected.length,
      outputBytes: this.textByteLength(outputContent),
      firstLineExceedsLimit: false,
      maxLines: PI_TOOL_RESULT_MAX_LINES,
      maxBytes,
    };
  }

  private r2ImageReadResult(
    head: R2Object,
    target: CodeModeR2Path,
    imageMimeType: string,
    inlineImage: PreparedInlineImage | null,
  ): Record<string, unknown> {
    const metadata = this.formatR2ObjectMetadata(head, target);
    let text = `Read R2 image object [${inlineImage?.mimeType ?? imageMimeType}]`;
    if (inlineImage?.optimizedForInlineView) {
      text += `\n[Image optimized for inline model context and may be scaled/compressed from the source.]`;
    }
    const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
      { type: "text", text },
    ];
    if (inlineImage) {
      content.push({ type: "image", data: inlineImage.data, mimeType: inlineImage.mimeType });
    } else {
      text += `\n[Image omitted: could not be resized below the inline image size limit of ${inlineImageMaxBase64Chars()} base64 chars.]`;
      content[0] = { type: "text", text };
    }
    return {
      text,
      content,
      details: {
        ...metadata,
        image: true,
        mimeType: inlineImage?.mimeType ?? imageMimeType,
        originalMimeType: imageMimeType,
        inlineImage: Boolean(inlineImage),
        optimizedForInlineView: inlineImage?.optimizedForInlineView ?? false,
        maxInlineDimension: inlineImage?.maxInlineDimension ?? null,
        usedImagesBinding: inlineImage?.usedImagesBinding ?? false,
        base64Chars: inlineImage?.base64Chars ?? null,
        offset: null,
        nextOffset: null,
        totalLines: null,
        truncation: null,
      },
    };
  }

  private async readR2File(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const target = this.resolveCodeModeR2Path(args);
    const offset = clampCodeModeInteger(args.offset, 1, 1, Number.MAX_SAFE_INTEGER);
    const limit = typeof args.limit === "number"
      ? clampCodeModeInteger(args.limit, PI_TOOL_RESULT_MAX_LINES, 1, PI_TOOL_RESULT_MAX_LINES)
      : undefined;
    const head = await this.env.R2_BUCKET.head(target.key);
    if (!head) {
      throw new Error(`R2 object not found: ${target.path}`);
    }
    const contentTypeImageMimeType = getSupportedImageMimeTypeFromContentType(
      head.httpMetadata?.contentType,
    );
    const object = await this.env.R2_BUCKET.get(target.key);
    if (!object) {
      throw new Error(`R2 object not found: ${target.path}`);
    }
    const images = this.env.IMAGES;
    if (!images) throw new Error("IMAGES binding is required for image reads");
    let bytes: Uint8Array;
    if (object.body) {
      const sniffed = await readImageSniffBytesAndReplayStream(object.body);
      const imageDetection = detectSharedImageMimeType(sniffed.prefix);
      const imageMimeType = imageDetection.kind === "supported"
        ? imageDetection.mimeType
        : imageDetection.kind === "unknown"
          ? contentTypeImageMimeType
          : null;
      if (imageMimeType) {
        const inlineImage = await prepareInlineImageFromStream(sniffed.stream, imageMimeType, images, {
          createRetryStream: async () => {
            const retryObject = await this.env.R2_BUCKET.get(target.key);
            if (!retryObject?.body) throw new Error(`R2 image object is not streamable: ${target.path}`);
            return retryObject.body;
          },
        });
        return this.r2ImageReadResult(head, target, imageMimeType, inlineImage);
      }
      if (head.size > CODE_MODE_R2_MAX_TEXT_OBJECT_BYTES) {
        await sniffed.stream.cancel("R2 object exceeds text read limit").catch(() => undefined);
        throw new Error(
          `R2 object is too large for text read (${head.size} bytes; max ${CODE_MODE_R2_MAX_TEXT_OBJECT_BYTES} bytes)`,
        );
      }
      bytes = await readStreamBytes(sniffed.stream);
    } else {
      bytes = typeof object.arrayBuffer === "function"
        ? new Uint8Array(await object.arrayBuffer())
        : new TextEncoder().encode(await object.text());
      const imageDetection = detectSharedImageMimeType(bytes);
      const imageMimeType = imageDetection.kind === "supported"
        ? imageDetection.mimeType
        : imageDetection.kind === "unknown"
          ? contentTypeImageMimeType
          : null;
      if (imageMimeType) throw new Error(`R2 image object is not streamable: ${target.path}`);
    }
    if (head.size > CODE_MODE_R2_MAX_TEXT_OBJECT_BYTES) {
      throw new Error(
        `R2 object is too large for text read (${head.size} bytes; max ${CODE_MODE_R2_MAX_TEXT_OBJECT_BYTES} bytes)`,
      );
    }
    const fullText = new TextDecoder().decode(bytes);
    const allLines = fullText.split("\n");
    const startLine = offset - 1;
    if (startLine >= allLines.length) {
      throw new Error(`Offset ${offset} is beyond end of R2 object (${allLines.length} lines total)`);
    }
    let selectedContent: string;
    let userLimitedLines: number | undefined;
    if (limit !== undefined) {
      const endLine = Math.min(startLine + limit, allLines.length);
      selectedContent = allLines.slice(startLine, endLine).join("\n");
      userLimitedLines = endLine - startLine;
    } else {
      selectedContent = allLines.slice(startLine).join("\n");
    }
    const maxBytes = PI_TOOL_RESULT_MAX_BYTES - CODE_MODE_R2_READ_NOTICE_RESERVED_BYTES;
    const truncation = this.truncateR2ReadHead(selectedContent, maxBytes);
    const startLineDisplay = startLine + 1;
    let text: string;
    let nextOffset: number | null = null;
    if (truncation.firstLineExceedsLimit) {
      text =
        `[Line ${startLineDisplay} is ${this.textByteLength(allLines[startLine] ?? "")} bytes, exceeds ${maxBytes} byte read budget. R2 path: ${target.path}]`;
    } else if (truncation.truncated) {
      const endLineDisplay = startLine + truncation.outputLines;
      nextOffset = endLineDisplay + 1;
      const limitLabel = truncation.truncatedBy === "bytes"
        ? ` (${maxBytes} byte read budget)`
        : "";
      text = truncation.content;
      text +=
        `${text ? "\n\n" : ""}` +
        `[Showing lines ${startLineDisplay}-${endLineDisplay} of ${allLines.length}${limitLabel}. Use offset=${nextOffset} to continue.]`;
    } else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
      const remaining = allLines.length - (startLine + userLimitedLines);
      nextOffset = startLine + userLimitedLines + 1;
      text = `${truncation.content}\n\n[${remaining} more lines in R2 object. Use offset=${nextOffset} to continue.]`;
    } else {
      text = truncation.content;
    }

    return {
      text,
      content: [{ type: "text", text }],
      details: {
        ...this.formatR2ObjectMetadata(head, target),
        offset,
        nextOffset,
        totalLines: allLines.length,
        truncation,
      },
    };
  }

  private async writeR2File(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const target = this.resolveCodeModeR2Path(args, { requireWritable: true });
    const content = typeof args.content === "string" ? args.content : "";
    const contentBytes = new TextEncoder().encode(content).byteLength;
    if (contentBytes > CODE_MODE_R2_MAX_WRITE_BYTES) {
      throw new Error(`R2 write content exceeds ${CODE_MODE_R2_MAX_WRITE_BYTES} bytes`);
    }
    const contentType = typeof args.content_type === "string" && args.content_type.trim()
      ? args.content_type.trim()
      : "text/plain; charset=utf-8";
    const object = await this.env.R2_BUCKET.put(target.key, content, {
      httpMetadata: { contentType },
      customMetadata: {
        type: "code-mode-r2-file",
        orgId: this.ctx.props.orgId,
        workspaceId: this.ctx.props.workspaceId,
        threadId: this.ctx.props.threadId ?? "",
      },
    });
    const text = `Wrote ${contentBytes} bytes to ${target.path}`;
    return {
      text,
      content: [{ type: "text", text }],
      details: {
        ...(object ? this.formatR2ObjectMetadata(object, target) : {
          location: "r2",
          path: target.path,
          namespace: target.mount,
          publicUrl: this.r2PublicUrl(target),
          size: contentBytes,
          contentType,
        }),
        bytesWritten: contentBytes,
      },
    };
  }

  private async editR2File(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const target = this.resolveCodeModeR2Path(args, { requireWritable: true });
    const edits = Array.isArray(args.edits)
      ? args.edits.map((entry, index) => {
          if (!entry || typeof entry !== "object") {
            throw new Error(`edits[${index}] must be an object`);
          }
          const raw = entry as Record<string, unknown>;
          const oldText = typeof raw.oldText === "string"
            ? raw.oldText
            : typeof raw.old_string === "string"
              ? raw.old_string
              : "";
          const newText = typeof raw.newText === "string"
            ? raw.newText
            : typeof raw.new_string === "string"
              ? raw.new_string
              : "";
          if (!oldText) throw new Error(`edits[${index}].oldText is required`);
          return { oldText, newText };
        })
      : [];
    if (edits.length === 0) throw new Error("edits must be a non-empty array");

    const head = await this.env.R2_BUCKET.head(target.key);
    if (!head) throw new Error(`R2 object not found: ${target.path}`);
    if (head.size > CODE_MODE_R2_MAX_TEXT_OBJECT_BYTES) {
      throw new Error(
        `R2 object is too large for text edit (${head.size} bytes; max ${CODE_MODE_R2_MAX_TEXT_OBJECT_BYTES} bytes)`,
      );
    }
    const object = await this.env.R2_BUCKET.get(target.key);
    if (!object) throw new Error(`R2 object not found: ${target.path}`);
    const originalContent = await object.text();
    const replacements = edits.map((edit, index) => {
      const start = originalContent.indexOf(edit.oldText);
      if (start === -1) throw new Error(`edits[${index}].oldText not found in ${target.path}`);
      if (originalContent.indexOf(edit.oldText, start + edit.oldText.length) !== -1) {
        throw new Error(`edits[${index}].oldText is not unique in ${target.path}`);
      }
      return {
        index,
        start,
        end: start + edit.oldText.length,
        newText: edit.newText,
      };
    }).sort((a, b) => a.start - b.start);

    for (let index = 1; index < replacements.length; index += 1) {
      const previous = replacements[index - 1]!;
      const current = replacements[index]!;
      if (current.start < previous.end) {
        throw new Error(`edits[${current.index}].oldText overlaps another edit in ${target.path}`);
      }
    }

    let content = originalContent;
    for (const replacement of replacements.slice().reverse()) {
      content = `${content.slice(0, replacement.start)}${replacement.newText}${content.slice(replacement.end)}`;
    }

    return this.writeR2File({
      ...args,
      path: target.path,
      content,
      content_type: head.httpMetadata?.contentType ?? "text/plain; charset=utf-8",
    });
  }

  private async listR2Files(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const target = this.resolveCodeModeR2Path(args, { allowDirectory: true });
    const limit = clampCodeModeInteger(args.limit, 100, 1, 1000);
    const cursor = typeof args.cursor === "string" && args.cursor.trim()
      ? args.cursor.trim()
      : undefined;
    const directoryRelativePath = target.relativePath
      ? `${target.relativePath}/`
      : "";
    const baseKey = this.r2MountBaseKey(target.mount);
    const result = await this.env.R2_BUCKET.list({
      prefix: `${baseKey}${directoryRelativePath}`,
      delimiter: "/",
      limit,
      cursor,
      include: ["httpMetadata", "customMetadata"],
    });
    const objects = result.objects.map((object) => {
      const relativePath = object.key.startsWith(baseKey)
        ? object.key.slice(baseKey.length)
        : object.key;
      return this.formatR2ObjectMetadata(object, {
        ...target,
        relativePath,
        path: this.r2PathFromRelative(target.mount, relativePath),
        key: object.key,
      });
    });
    const prefixes = result.delimitedPrefixes.map((prefix) => {
      const relativePath = prefix.startsWith(baseKey)
        ? prefix.slice(baseKey.length).replace(/\/+$/, "")
        : prefix.replace(/\/+$/, "");
      return { path: this.r2PathFromRelative(target.mount, relativePath) };
    });
    const lines = [
      ...prefixes.map((prefix) => `dir  ${prefix.path}/`),
      ...objects.map((object) => `${String(object.size).padStart(8, " ")} ${object.path}`),
    ];
    const text = lines.length > 0 ? lines.join("\n") : "(empty)";
    return {
      text,
      content: [{ type: "text", text }],
      details: {
        location: "r2",
        path: target.path,
        namespace: target.mount,
        objects,
        prefixes,
        truncated: result.truncated,
        cursor: result.truncated ? result.cursor : undefined,
      },
    };
  }

  private async deleteR2File(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const target = this.resolveCodeModeR2Path(args, { requireWritable: true });
    await this.env.R2_BUCKET.delete(target.key);
    const text = `Deleted ${target.path}`;
    return {
      text,
      content: [{ type: "text", text }],
      details: {
        location: "r2",
        path: target.path,
        namespace: target.mount,
        publicUrl: this.r2PublicUrl(target),
        deleted: true,
      },
    };
  }

  private normalizeMoveEndpoint(value: unknown, label: "source" | "destination"): CodeModeMoveEndpoint {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${label} must be an object`);
    }
    const raw = value as Record<string, unknown>;
    const location = raw.location;
    if (location !== "workspace" && location !== "vm" && location !== "r2") {
      throw new Error(`${label}.location must be "workspace", "vm", or "r2"`);
    }
    const path = typeof raw.path === "string" ? raw.path.trim().replace(/\\/g, "/") : "";
    if (!path) throw new Error(`${label}.path is required`);
    const project = typeof raw.project === "string" && raw.project.trim()
      ? raw.project.trim()
      : undefined;
    if (location === "vm" && !project) {
      throw new Error(`${label}.project is required when ${label}.location is "vm"`);
    }
    const contentType = typeof raw.content_type === "string" && raw.content_type.trim()
      ? raw.content_type.trim()
      : undefined;
    return { location, path, project, contentType };
  }

  private async collectMoveSourceFiles(source: CodeModeMoveEndpoint): Promise<{ files: CodeModeMoveFile[]; sourceIsDirectory: boolean }> {
    if (source.location === "workspace") return this.collectWorkspaceMoveFiles(source);
    if (source.location === "vm") {
      const stat = await this.projectVm.statPathForTransfer(source);
      const files = await this.projectVm.collectFilesForTransfer(source);
      return { files, sourceIsDirectory: stat.isDirectory };
    }
    return this.collectR2MoveFiles(source);
  }

  private async collectWorkspaceMoveFiles(source: CodeModeMoveEndpoint): Promise<{ files: CodeModeMoveFile[]; sourceIsDirectory: boolean }> {
    const path = normalizeDurableWorkspacePath(source.path);
    const exists = await this.workspaceFs.exists(path);
    if (!exists.exists) throw new Error(`Workspace path not found: ${path}`);
    if (exists.isFile) {
      return {
        files: [{ path, relativePath: basenameForMove(path), size: exists.size, contentType: exists.mimeType }],
        sourceIsDirectory: false,
      };
    }
    if (!exists.isDirectory) throw new Error(`Workspace path is not a file or directory: ${path}`);
    const listing = await this.workspaceFs.listFiles(path, { recursive: true, includeHidden: true });
    if (!listing.success) throw new Error(listing.error || `Failed to list ${path}`);
    const rootName = basenameForMove(path);
    const files = listing.files
      .filter((entry) => entry.type === "file")
      .map((entry) => ({
        path: normalizeDurableWorkspacePath(entry.absolutePath),
        relativePath: joinRelativeMovePath(rootName, entry.relativePath),
        size: entry.size,
        contentType: entry.mimeType,
      }))
      .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    return { files, sourceIsDirectory: true };
  }

  private async collectR2MoveFiles(source: CodeModeMoveEndpoint): Promise<{ files: CodeModeMoveFile[]; sourceIsDirectory: boolean }> {
    const target = this.resolveCodeModeR2Path(source as unknown as Record<string, unknown>, { allowDirectory: true });
    if (target.relativePath) {
      const head = await this.env.R2_BUCKET.head(target.key);
      if (head) {
        return {
          files: [{
            path: target.path,
            relativePath: basenameForMove(target.path),
            size: head.size,
            contentType: head.httpMetadata?.contentType,
          }],
          sourceIsDirectory: false,
        };
      }
    }

    const baseKey = this.r2MountBaseKey(target.mount);
    const directoryRelativePath = target.relativePath ? `${target.relativePath}/` : "";
    const prefix = `${baseKey}${directoryRelativePath}`;
    const rootName = basenameForMove(target.path);
    const files: CodeModeMoveFile[] = [];
    let cursor: string | undefined;
    do {
      const listed = await this.env.R2_BUCKET.list({
        prefix,
        cursor,
        limit: 1000,
        include: ["httpMetadata"],
      });
      for (const object of listed.objects) {
        const objectRelativePath = object.key.startsWith(prefix)
          ? object.key.slice(prefix.length)
          : object.key.slice(baseKey.length);
        if (!objectRelativePath) continue;
        files.push({
          path: this.r2PathFromRelative(target.mount, target.relativePath
            ? `${target.relativePath}/${objectRelativePath}`
            : objectRelativePath),
          relativePath: joinRelativeMovePath(rootName, objectRelativePath),
          size: object.size,
          contentType: object.httpMetadata?.contentType,
        });
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);

    if (files.length === 0) throw new Error(`R2 path not found: ${target.path}`);
    files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    return { files, sourceIsDirectory: true };
  }

  private async readMoveSourceFile(source: CodeModeMoveEndpoint, file: CodeModeMoveFile): Promise<{ bytes: Uint8Array; contentType?: string }> {
    if (source.location === "workspace") {
      const read = await this.workspaceFs.readFile(file.path);
      if (!read.success || typeof read.content !== "string") {
        throw new Error(read.error || `Failed to read ${file.path}`);
      }
      return {
        bytes: read.encoding === "base64"
          ? base64ToBytesForMove(read.content)
          : new TextEncoder().encode(read.content),
        contentType: read.mimeType ?? file.contentType,
      };
    }
    if (source.location === "vm") {
      const read = await this.projectVm.readFileBytesForTransfer({ ...source, path: file.path });
      return { bytes: read.bytes, contentType: read.contentType ?? file.contentType };
    }
    const target = this.resolveCodeModeR2Path({ ...source, path: file.path });
    const object = await this.env.R2_BUCKET.get(target.key);
    if (!object) throw new Error(`R2 object not found: ${target.path}`);
    return {
      bytes: new Uint8Array(await object.arrayBuffer()),
      contentType: object.httpMetadata?.contentType ?? file.contentType,
    };
  }

  private async writeMoveDestinationFile(
    destination: CodeModeMoveEndpoint,
    path: string,
    bytes: Uint8Array,
    contentType?: string,
  ): Promise<{ path: string; bytes: number }> {
    if (destination.location === "workspace") {
      const normalizedPath = normalizeDurableWorkspacePath(path);
      const result = await this.workspaceFs.writeBinaryFile(normalizedPath, bytesToBase64ForMove(bytes));
      if (!result.success) throw new Error(result.error || `Failed to write ${normalizedPath}`);
      return { path: normalizedPath, bytes: bytes.byteLength };
    }
    if (destination.location === "vm") {
      return this.projectVm.writeFileBytesForTransfer({ ...destination, path }, bytes);
    }
    const target = this.resolveCodeModeR2Path({ ...destination, path }, { requireWritable: true });
    await this.env.R2_BUCKET.put(target.key, bytes, {
      httpMetadata: { contentType: destination.contentType ?? contentType ?? "application/octet-stream" },
      customMetadata: {
        type: "code-mode-move-file",
        orgId: this.ctx.props.orgId,
        workspaceId: this.ctx.props.workspaceId,
        threadId: this.ctx.props.threadId ?? "",
      },
    });
    return { path: target.path, bytes: bytes.byteLength };
  }

  private async deleteMoveSource(source: CodeModeMoveEndpoint, files: CodeModeMoveFile[]): Promise<void> {
    if (source.location === "workspace") {
      const result = await this.workspaceFs.deleteFile(source.path, { recursive: true });
      if (!result.success) throw new Error(result.error || `Failed to delete ${source.path}`);
      return;
    }
    if (source.location === "vm") {
      await this.projectVm.deletePathForTransfer(source, { recursive: true });
      return;
    }
    const target = this.resolveCodeModeR2Path(source as unknown as Record<string, unknown>, { allowDirectory: true });
    if (target.mount === "uploads") throw new Error("uploads/ is read-only");
    for (const file of files) {
      const fileTarget = this.resolveCodeModeR2Path({ ...source, path: file.path }, { requireWritable: true });
      await this.env.R2_BUCKET.delete(fileTarget.key);
    }
  }

  private async comparableMovePath(endpoint: CodeModeMoveEndpoint): Promise<string> {
    if (endpoint.location === "workspace") {
      return normalizeDurableWorkspacePath(endpoint.path).replace(/\/+$/g, "") || "/";
    }
    if (endpoint.location === "r2") {
      return this.resolveCodeModeR2Path(endpoint as unknown as Record<string, unknown>, { allowDirectory: true }).path.replace(/\/+$/g, "");
    }
    const resolved = await this.projectVm.resolvePathForTransfer(endpoint);
    return resolved.path.replace(/\/+$/g, "") || "/";
  }

  private isMovePathEqualOrDescendant(sourcePath: string, destinationPath: string): boolean {
    if (destinationPath === sourcePath) return true;
    const prefix = sourcePath.endsWith("/") ? sourcePath : `${sourcePath}/`;
    return destinationPath.startsWith(prefix);
  }

  private async assertSafeMoveDeleteDestination(
    source: CodeModeMoveEndpoint,
    destination: CodeModeMoveEndpoint,
    sourceIsDirectory: boolean,
  ): Promise<void> {
    if (source.location !== destination.location) return;
    if (source.location === "vm" && source.project !== destination.project) return;

    const sourcePath = await this.comparableMovePath(source);
    const destinationPath = await this.comparableMovePath(destination);
    const overlaps = sourceIsDirectory
      ? this.isMovePathEqualOrDescendant(sourcePath, destinationPath)
      : sourcePath === destinationPath;
    if (overlaps) {
      throw new Error("move with deleteSource cannot use an equal or descendant destination in the same location");
    }
  }

  private async moveFile(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const source = this.normalizeMoveEndpoint(args.source, "source");
    const destination = this.normalizeMoveEndpoint(args.destination, "destination");
    const deleteSource = args.deleteSource === true || args.delete_source === true;
    if (deleteSource && source.location === "r2") {
      const sourceTarget = this.resolveCodeModeR2Path(source as unknown as Record<string, unknown>, { allowDirectory: true });
      if (sourceTarget.mount === "uploads") throw new Error("uploads/ is read-only");
    }
    if (destination.location === "r2") {
      this.resolveCodeModeR2Path(destination as unknown as Record<string, unknown>, { allowDirectory: true, requireWritable: true });
    }

    const { files, sourceIsDirectory } = await this.collectMoveSourceFiles(source);
    if (files.length === 0) throw new Error(`No files found at ${source.path}`);
    if (deleteSource) {
      await this.assertSafeMoveDeleteDestination(source, destination, sourceIsDirectory);
    }

    const copied: Array<{ from: string; to: string; bytes: number }> = [];
    let totalBytes = 0;
    const useDestinationAsRoot = sourceIsDirectory || files.length > 1;
    for (const file of files) {
      const destinationPath = useDestinationAsRoot
        ? joinMoveDestinationPath(destination.location, destination.path, file.relativePath)
        : destination.path;
      const read = await this.readMoveSourceFile(source, file);
      const written = await this.writeMoveDestinationFile(destination, destinationPath, read.bytes, read.contentType);
      totalBytes += written.bytes;
      copied.push({ from: file.path, to: written.path, bytes: written.bytes });
    }

    if (deleteSource) await this.deleteMoveSource(source, files);

    const verb = deleteSource ? "Moved" : "Copied";
    const text = `${verb} ${copied.length} file${copied.length === 1 ? "" : "s"} (${totalBytes} bytes)`;
    return {
      text,
      content: [{ type: "text", text }],
      details: {
        source: { location: source.location, path: source.path, project: source.project ?? null },
        destination: { location: destination.location, path: destination.path, project: destination.project ?? null },
        deleteSource,
        files: copied,
        count: copied.length,
        bytes: totalBytes,
      },
    };
  }

  private async getAppUrl(script: WorkerScript): Promise<string> {
    if ("eval" in script && script.eval === true && typeof (script as { vanity_url?: unknown }).vanity_url === "string") {
      return (script as unknown as { vanity_url: string }).vanity_url;
    }
    let appHostname = "camelai.dev";
    const workerBaseUrl = (this.env as { WORKER_BASE_URL?: string }).WORKER_BASE_URL;
    if (workerBaseUrl) {
      try {
        appHostname = new URL(workerBaseUrl).host;
      } catch {
        appHostname = "camelai.dev";
      }
    }
    const orgSlug = await this.getOrgSlug();
    return getPreferredAppUrl(script, {
      hostname: {
        hostname: appHostname,
        vanityDomain: this.env.LOCAL_APP_VANITY_DOMAIN,
        iframeDomain: this.env.LOCAL_APP_IFRAME_DOMAIN,
      },
      orgSlug: orgSlug ?? undefined,
      orgCustomDomain: null,
    });
  }

  async listTools(): Promise<CodeModeToolDefinition[]> {
    return CODE_MODE_TOOL_DEFINITIONS
      .filter((definition) => !JS_EXEC_EXCLUDED_TOOL_NAMES.has(definition.name));
  }

  async callTool(name: string, rawArgs: unknown = {}): Promise<unknown> {
    if (rawArgs != null && (typeof rawArgs !== "object" || Array.isArray(rawArgs))) {
      throw new Error("tool arguments must be an object");
    }
    const args = rawArgs == null ? {} : rawArgs as Record<string, unknown>;
    await this.assertWorkspaceNotMigrating();
    const handler = CodeModeToolsBinding.TOOL_CALL_HANDLERS[name];
    if (handler) {
      return this.callToolWithArtifactCapture(name, args, () => handler(this, args, name));
    }

    return this.callToolWithArtifactCapture(name, args, async () => {
      if (FILE_TOOL_NAMES.has(name)) requireFileLocation(name, args);
      switch (name) {
        case "bash":
          return this.projectVm.exec({ ...args, location: "vm" });

        case "read":
          if (hasR2Target(args)) return this.readR2File(args);
          if (hasVmTarget(args)) return this.projectVm.read(args);
        {
          const path = typeof args.path === "string" ? args.path : "";
          if (normalizeAutomationVirtualPath(path) !== null) {
            const automationFile = await readAutomationVirtualFile({
              cronStub: this.cronStub,
              workspaceId: this.ctx.props.workspaceId,
              path,
            });
            if (automationFile) return automationFile;
          }
          const skill = readPiBundledSkillFile(path);
          if (skill) {
            return {
              text: skill.text,
              content: [{ type: "text", text: skill.text }],
              details: {
                path: skill.path,
                size: skill.size,
                encoding: skill.encoding,
                source: skill.source,
              },
            };
          }
        }
        return this.piContainerTools.callTool("read", args);

        case "write":
          if (hasR2Target(args)) return this.writeR2File(args);
          if (hasVmTarget(args)) return this.projectVm.write(args);
        {
          const path = typeof args.path === "string" ? args.path : "";
          const content = typeof args.content === "string" ? args.content : "";
          if (normalizeAutomationVirtualPath(path) !== null) {
            const automationFile = await writeAutomationVirtualFile({
              cronStub: this.cronStub,
              workspaceId: this.ctx.props.workspaceId,
              path,
              content,
            });
            if (automationFile) return automationFile;
          }
        }
        return this.piContainerTools.callTool("write", args);

        case "ls":
          if (hasR2Target(args)) return this.listR2Files(args);
          if (hasVmTarget(args)) return this.projectVm.ls(args);
        {
          if (typeof args.path === "string") {
            if (normalizeAutomationVirtualPath(args.path) !== null) {
              const automationListing = await listAutomationVirtualFiles({
                cronStub: this.cronStub,
                workspaceId: this.ctx.props.workspaceId,
                path: args.path,
              });
              if (automationListing) return automationListing;
            }
            const listing = listPiBundledSkillFiles(args.path);
            if (listing) {
              return {
                text: listing.text,
                content: [{ type: "text", text: listing.text }],
                details: {
                  path: listing.path,
                  files: listing.files,
                  source: listing.source,
                },
              };
            }
          }
        }
        return this.piContainerTools.callTool("ls", args);

        case "edit":
          if (hasR2Target(args)) return this.editR2File(args);
          if (hasVmTarget(args)) return this.projectVm.edit(args);
        {
          const path = typeof args.path === "string" ? args.path : "";
          const edits = Array.isArray(args.edits)
            ? args.edits.flatMap((entry) => {
                if (!entry || typeof entry !== "object") return [];
                const raw = entry as Record<string, unknown>;
                return [{
                  oldText: String(raw.oldText ?? raw.old_string ?? ""),
                  newText: String(raw.newText ?? raw.new_string ?? ""),
                }];
              })
            : [];
          if (normalizeAutomationVirtualPath(path) !== null) {
            const automationFile = await editAutomationVirtualFile({
              cronStub: this.cronStub,
              workspaceId: this.ctx.props.workspaceId,
              path,
              edits,
            });
            if (automationFile) return automationFile;
          }
        }
        return this.piContainerTools.callTool("edit", args);

        case "delete":
          if (hasR2Target(args)) return this.deleteR2File(args);
          if (hasVmTarget(args)) {
            throw new Error("delete does not support project VM files; use bash or vm_exec with rm for explicit VM deletion");
          }
          return this.piContainerTools.callTool("delete", args);

        case "grep":
          if (hasVmTarget(args)) return this.projectVm.grep(args);
          return this.piContainerTools.callTool("grep", args);

        case "find":
          if (hasVmTarget(args)) return this.projectVm.find(args);
          return this.piContainerTools.callTool("find", args);

        case "vm_exec":
          return this.projectVm.exec(args);

        case "move":
          return this.moveFile(args);

        case "list_projects":
          return (await this.workspaceFs.listProjects()).map(projectForAgent);

        case "create_project":
          return projectForAgent(await this.workspaceFs.createProject(args));

        case "set_project_description":
          return projectForAgent(await this.workspaceFs.setProjectDescription(args));

        case "clone_project":
          return this.projectVm.cloneProject(args);

        case "delete_project":
          return this.deleteProject(args);

        case "delete_connection":
          return this.deleteConnection(args);

        default:
          throw new Error(`Unknown code mode tool: ${name}`);
      }
    });
  }

  private async callToolWithArtifactCapture(
    name: string,
    args: Record<string, unknown>,
    execute: () => Promise<unknown> | unknown,
  ): Promise<unknown> {
    try {
      const result = await execute();
      await this.recordCodeModeArtifactBestEffort(name, args, result);
      return result;
    } catch (error) {
      await this.recordCodeModeArtifactBestEffort(name, args, undefined, error);
      throw error;
    }
  }

  private async assertWorkspaceNotMigrating(): Promise<void> {
    if (!this.env || this.env.ENABLE_LEGACY_WORKSPACE_MIGRATION !== "1" || !this.env.WORKSPACE_FS) return;
    const state = await this.workspaceFs.getLegacyWorkspaceMigrationState();
    if (!ACTIVE_LEGACY_WORKSPACE_MIGRATION_STATUSES.has(state.status)) return;
    throw new Error(
      `Workspace legacy migration is currently ${state.status}. The app is temporarily unavailable while camelAI upgrades this workspace. Please check back in 5 minutes.`,
    );
  }

  private async recordCodeModeArtifactBestEffort(
    name: string,
    args: Record<string, unknown>,
    result?: unknown,
    error?: unknown,
  ): Promise<void> {
    try {
      await this.maybeRecordCodeModeArtifact(name, args, result, error);
    } catch (recordError) {
      console.error("Failed to record code mode artifact", {
        toolName: name,
        threadId: this.ctx?.props?.threadId,
        parentToolUseId: this.ctx?.props?.parentToolUseId,
        error: recordError instanceof Error ? recordError.message : String(recordError),
      });
    }
  }

  private async maybeRecordCodeModeArtifact(
    name: string,
    args: Record<string, unknown>,
    result?: unknown,
    error?: unknown,
  ): Promise<void> {
    const props = this.ctx?.props;
    const parentToolUseId = props?.parentToolUseId?.trim();
    const threadId = props?.threadId?.trim();
    if (!parentToolUseId || !threadId) return;
    const artifact = this.buildCodeModeArtifact(name, args, result, error);
    if (!artifact) return;
    await (this.chatThreadStub as unknown as {
      recordCodeModeArtifact(parentToolUseId: string, artifact: RuntimeCallArtifact): Promise<void>;
    }).recordCodeModeArtifact(parentToolUseId, artifact);
  }

  private buildCodeModeArtifact(
    name: string,
    args: Record<string, unknown>,
    result?: unknown,
    error?: unknown,
  ): RuntimeCallArtifact | null {
    const kindByTool: Record<string, RuntimeCallArtifactKind> = {
      send_email: "outbound_email",
      send_slack_message: "outbound_slack_message",
      send_telegram_message: "outbound_telegram_message",
    };
    const kind = kindByTool[name];
    if (!kind) return null;
    const now = Date.now();
    const status = error ? "failed" : "sent";
    const details = this.codeModeArtifactDetails(result);
    const summary = this.summarizeCodeModeArtifactArgs(name, args);
    const titleByKind: Record<RuntimeCallArtifactKind, string> = {
      outbound_email: status === "sent" ? "Email sent" : "Email failed",
      outbound_slack_message: status === "sent" ? "Slack message sent" : "Slack message failed",
      outbound_telegram_message: status === "sent" ? "Telegram message sent" : "Telegram message failed",
    };
    return {
      id: `${this.ctx.props.parentToolUseId}:${name}:${crypto.randomUUID()}`,
      kind,
      toolName: name as RuntimeCallArtifact["toolName"],
      status,
      title: titleByKind[kind],
      subtitle: this.codeModeArtifactSubtitle(kind, summary, details),
      createdAt: now,
      updatedAt: now,
      summary,
      ...(Object.keys(details).length > 0 ? { result: details } : {}),
      ...(error ? { error: this.codeModeArtifactError(error) } : {}),
    };
  }

  private summarizeCodeModeArtifactArgs(
    name: string,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    const attachmentCount = Array.isArray(args.attachments) ? args.attachments.length : 0;
    const text = typeof args.text === "string" ? args.text : "";
    switch (name) {
      case "send_email": {
        const to = typeof args.to === "string" ? args.to.trim() : "";
        return {
          to,
          toDomain: to.includes("@") ? to.split("@").pop() : undefined,
          subject: typeof args.subject === "string" ? args.subject : undefined,
          hasText: typeof args.text === "string" && args.text.length > 0,
          hasHtml: typeof args.html === "string" && args.html.length > 0,
          attachmentCount,
        };
      }
      case "send_slack_message":
        return {
          channelId: typeof args.channel_id === "string" ? args.channel_id : undefined,
          teamId: typeof args.team_id === "string" ? args.team_id : undefined,
          integrationId: typeof args.integration_id === "string" ? args.integration_id : undefined,
          threadTs: typeof args.thread_ts === "string" ? args.thread_ts : undefined,
          hasText: text.length > 0,
          textPreview: text ? this.truncateArtifactPreviewText(text) : undefined,
          attachmentCount,
        };
      case "send_telegram_message":
        return {
          chatId: typeof args.chat_id === "string" ? args.chat_id : undefined,
          integrationId: typeof args.integration_id === "string" ? args.integration_id : undefined,
          hasText: text.length > 0,
          textPreview: text ? this.truncateArtifactPreviewText(text) : undefined,
          attachmentCount,
        };
      default:
        return { attachmentCount };
    }
  }

  private codeModeArtifactDetails(result: unknown): Record<string, unknown> {
    if (!result || typeof result !== "object" || Array.isArray(result)) return {};
    const details = (result as { details?: unknown }).details;
    return details && typeof details === "object" && !Array.isArray(details)
      ? details as Record<string, unknown>
      : {};
  }

  private codeModeArtifactSubtitle(
    kind: RuntimeCallArtifactKind,
    summary: Record<string, unknown>,
    result: Record<string, unknown>,
  ): string | undefined {
    if (kind === "outbound_email") {
      return typeof summary.to === "string" && summary.to ? summary.to : undefined;
    }
    if (kind === "outbound_slack_message") {
      const channelId = typeof result.channelId === "string" ? result.channelId : summary.channelId;
      return typeof channelId === "string" && channelId ? `Channel ${channelId}` : undefined;
    }
    const chatId = typeof result.chatId === "string" ? result.chatId : summary.chatId;
    return typeof chatId === "string" && chatId ? `Chat ${chatId}` : undefined;
  }

  private codeModeArtifactError(error: unknown): { name: string; message: string } {
    return error instanceof Error
      ? { name: error.name || "Error", message: error.message || "Unknown error" }
      : { name: "Error", message: String(error || "Unknown error") };
  }

  private truncateArtifactPreviewText(text: string): string {
    const normalized = text.replace(/\s+/g, " ").trim();
    return normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized;
  }

  private askUserQuestion(args: Record<string, unknown>): Promise<unknown> {
    return this.chatThreadStub.askUserQuestion({
      questions: Array.isArray(args.questions) ? args.questions : [args],
      toolUseId: typeof args.toolUseId === "string" ? args.toolUseId : undefined,
    });
  }

  private runSubagentTool(name: string, args: Record<string, unknown>): Promise<AgentToolResult<unknown>> {
    return (this.chatThreadStub as unknown as {
      runCodeModeSubagent(toolName: "Agent" | "Explore", params: unknown): Promise<AgentToolResult<unknown>>;
    }).runCodeModeSubagent(name as "Agent" | "Explore", args);
  }

  private connectionQuery(args: Record<string, unknown>): string | Record<string, string> {
    return typeof args.query === "string" || (args.query && typeof args.query === "object" && !Array.isArray(args.query))
      ? args.query as string | Record<string, string>
      : "";
  }

  private async updateTodos(args: Record<string, unknown>): Promise<unknown> {
    const todos = normalizeTodoItems(
      Array.isArray(args.todos)
        ? args.todos
        : Array.isArray(args.items)
          ? args.items
          : [],
    );
    await this.chatThreadStub.setTodoState(todos);
    return { success: true, todos };
  }

  private async setPreview(args: Record<string, unknown>): Promise<unknown> {
    const scriptNameArg = typeof args.script_name === "string" ? args.script_name.trim() : "";
    const appNameArg = typeof args.app_name === "string" ? args.app_name.trim() : "";
    if (scriptNameArg && appNameArg && scriptNameArg !== appNameArg) {
      throw new Error("set_preview accepts only one app target; use script_name or app_name, not both");
    }
    const scriptName = scriptNameArg || appNameArg;
    const filePath = typeof args.path === "string" ? args.path.trim() : "";
    if (args.location === "vm" && !filePath) {
      throw new Error("path is required when previewing a VM file");
    }
    const targetKinds = [scriptName ? "app" : "", filePath ? "file" : ""].filter(Boolean);
    if (targetKinds.length === 0) {
      throw new Error("set_preview requires app_name/script_name or path");
    }
    if (targetKinds.length > 1) {
      throw new Error("set_preview accepts exactly one target: app_name/script_name or path");
    }
    if (args.location !== "vm" && typeof args.project === "string" && args.project.trim()) {
      throw new Error("project is only valid with location: 'vm'");
    }
    if (filePath && typeof args.is_public === "boolean") {
      throw new Error("is_public is only valid for app previews");
    }

    if (scriptName) {
      const script =
        (await this.orgStub.getWorkerScript(scriptName)) ??
        (isEvalDeployEnabled(this.env)
          ? await getEvalDeployApp(this.env.APP_DB, this.ctx.props.workspaceId, scriptName)
          : null);
      if (!script) throw new Error(`App '${scriptName}' not found`);
      if (script.workspace_id !== this.ctx.props.workspaceId) {
        throw new Error(`App '${scriptName}' belongs to a different workspace`);
      }
      const target: PreviewTarget = {
        kind: "app",
        scriptName,
        isPublic: typeof args.is_public === "boolean" ? args.is_public : script.is_public,
      };
      await this.chatThreadStub.setPreviewTarget(target);
      return { success: true, target, app: { name: scriptName, url: await this.getAppUrl(script), is_public: target.isPublic } };
    }
    const location = typeof args.location === "string" ? args.location.trim() : "";
    if (location && location !== "workspace" && location !== "vm" && location !== "r2") {
      throw new Error('set_preview location must be "workspace", "vm", or "r2"');
    }
    let parsedPath = parseFilePreviewPath(filePath);
    let source: Extract<PreviewTarget, { kind: "file" }>["source"];
    if (location === "workspace" || location === "vm") {
      parsedPath = parseFilePreviewPath(filePath.startsWith("/") ? filePath : `/${filePath}`);
      if (!parsedPath || parsedPath.source !== "workspace") {
        throw new Error("Invalid preview file path");
      }
      source = location;
    } else if (location === "r2") {
      if (!parsedPath || parsedPath.source === "workspace") {
        throw new Error("R2 preview path must start with uploads/ or outputs/");
      }
      source = parsedPath.source;
    } else {
      if (!parsedPath) {
        throw new Error("Invalid preview file path");
      }
      source = parsedPath.source;
    }
    const target: PreviewTarget = {
      kind: "file",
      source,
      workspaceId: this.ctx.props.workspaceId,
      path: parsedPath.path,
      project:
        source === "vm" && typeof args.project === "string"
          ? args.project.trim()
          : undefined,
      filename: parsedPath.filename,
      contentType: typeof args.content_type === "string" ? args.content_type.trim() : undefined,
    };
    if (target.source === "vm" && !target.project) {
      throw new Error("project is required when previewing a VM file");
    }
    await this.assertPreviewFileReadable(target);
    await this.chatThreadStub.setPreviewTarget(target);
    return { success: true, target };
  }

  private async assertPreviewFileReadable(target: Extract<PreviewTarget, { kind: "file" }>): Promise<void> {
    switch (target.source) {
      case "workspace": {
        const exists = await this.workspaceFs.exists(target.path);
        if (!exists.exists) {
          throw new Error(`Preview file not found: ${target.path}`);
        }
        if (exists.isDirectory) {
          throw new Error(`Preview path is a directory, not a file: ${target.path}`);
        }
        return;
      }
      case "upload":
      case "output": {
        const { orgId, workspaceId } = this.ctx.props;
        if (!orgId || !workspaceId) {
          throw new Error("Code mode tool binding is missing R2 scope");
        }
        const bucketDir = target.source === "upload" ? "user-uploads" : "user-outputs";
        const relativePath = target.path.replace(/^\/+/, "");
        const object = await this.env.R2_BUCKET.head(
          buildWorkspaceScopedR2Key(orgId, workspaceId, `${bucketDir}/${relativePath}`),
        );
        if (!object) {
          const publicPath = `${target.source === "upload" ? "uploads" : "outputs"}/${relativePath}`;
          throw new Error(`Preview file not found: ${publicPath}`);
        }
        return;
      }
      case "vm": {
        if (!target.project) {
          throw new Error("project is required when previewing a VM file");
        }
        await this.projectVm.assertFileReadable({
          location: "vm",
          project: target.project,
          path: target.path,
        });
        return;
      }
    }
  }

  private async listApps(): Promise<unknown> {
    const realScripts = await this.orgStub.listWorkerScriptsByWorkspace(this.ctx.props.workspaceId);
    const evalScripts = isEvalDeployEnabled(this.env)
      ? await listEvalDeployApps(this.env.APP_DB, this.ctx.props.workspaceId)
      : [];
    const scriptsByName = new Map<string, WorkerScript>();
    for (const script of evalScripts) scriptsByName.set(script.script_name, script);
    for (const script of realScripts) scriptsByName.set(script.script_name, script);
    const scripts = Array.from(scriptsByName.values()).sort((a, b) => b.updated_at - a.updated_at);
    return {
      count: scripts.length,
      apps: await Promise.all(scripts.map(async (script) => ({
        name: script.script_name,
        url: await this.getAppUrl(script),
        is_public: script.is_public,
        created_by: script.created_by,
        created_at: new Date(script.created_at).toISOString(),
        updated_at: new Date(script.updated_at).toISOString(),
        preview_status: script.preview_status,
        eval: "eval" in script && script.eval === true,
      }))),
    };
  }

  private async setAppVisibility(args: Record<string, unknown>): Promise<unknown> {
    const scriptName = typeof args.script_name === "string" ? args.script_name.trim() : "";
    if (!scriptName) throw new Error("script_name is required");
    if (typeof args.is_public !== "boolean") throw new Error("is_public must be a boolean");
    const script =
      (await this.orgStub.getWorkerScript(scriptName)) ??
      (isEvalDeployEnabled(this.env)
        ? await getEvalDeployApp(this.env.APP_DB, this.ctx.props.workspaceId, scriptName)
        : null);
    if (!script) return { success: false, error: `App '${scriptName}' not found` };
    if (script.workspace_id !== this.ctx.props.workspaceId) {
      return { success: false, error: `App '${scriptName}' belongs to a different workspace` };
    }
    if ("eval" in script && script.eval === true) {
      const updated = await setEvalDeployAppPublic(
        this.env.APP_DB,
        this.ctx.props.workspaceId,
        scriptName,
        args.is_public,
      );
      if (!updated) return { success: false, error: `Failed to update app '${scriptName}'` };
      await this.chatThreadStub.setPreviewAppVisibility(scriptName, updated.is_public);
      return {
        success: true,
        app: {
          name: updated.script_name,
          url: await this.getAppUrl(updated),
          is_public: updated.is_public,
          updated_at: new Date(updated.updated_at).toISOString(),
        },
        message: `App '${scriptName}' is now ${updated.is_public ? "public" : "private"}`,
      };
    }
    const updated = await this.orgStub.setWorkerScriptPublic(
      scriptName,
      args.is_public,
      this.ctx.props.userId || "system",
    );
    if (!updated) return { success: false, error: `Failed to update app '${scriptName}'` };
    await this.chatThreadStub.setPreviewAppVisibility(scriptName, updated.is_public);
    return {
      success: true,
      app: {
        name: updated.script_name,
        url: await this.getAppUrl(updated),
        is_public: updated.is_public,
        updated_at: new Date(updated.updated_at).toISOString(),
      },
      message: `App '${scriptName}' is now ${updated.is_public ? "public" : "private"}`,
    };
  }

  private async getLatestLogs(args: Record<string, unknown>): Promise<unknown> {
    const scriptName = typeof args.script_name === "string" ? args.script_name.trim() : "";
    if (!scriptName) throw new Error("script_name is required");
    if (!this.env.WORKER_LOGS) throw new Error("Worker logs are not configured");
    const script = await this.orgStub.getWorkerScript(scriptName);
    if (!script) return { success: false, error: `App '${scriptName}' not found` };
    if (script.workspace_id !== this.ctx.props.workspaceId) {
      return { success: false, error: `App '${scriptName}' belongs to a different workspace` };
    }
    const limit = clampCodeModeInteger(args.limit, 100, 1, 500);
    const since = typeof args.since_ms === "number" && Number.isFinite(args.since_ms)
      ? Math.max(0, Math.floor(args.since_ms))
      : undefined;
    const orgSlug = await this.getOrgSlug();
    const storageKey = orgSlug ? `${scriptName}--${orgSlug}` : scriptName;
    const logsStub = this.env.WORKER_LOGS.get(this.env.WORKER_LOGS.idFromName(storageKey));
    const [logs, stats] = await Promise.all([
      logsStub.getLogs({ limit, since }),
      logsStub.getStats(),
    ]);
    return {
      success: true,
      script: { name: scriptName, storage_key: storageKey, dispatch_name: storageKey },
      count: logs.length,
      limit,
      since_ms: since ?? null,
      stats: {
        total_log_count: stats.logCount,
        last_log_at_ms: stats.lastLogAt,
        last_log_at: stats.lastLogAt ? new Date(stats.lastLogAt).toISOString() : null,
      },
      logs: logs.map((entry) => ({
        id: entry.id,
        timestamp_ms: entry.timestamp,
        timestamp: new Date(entry.timestamp).toISOString(),
        level: entry.level,
        message: entry.message,
        exception: entry.exception,
        script_version: entry.scriptVersion,
      })),
    };
  }

  private async takeScreenshot(args: Record<string, unknown>): Promise<unknown> {
    const scriptName = typeof args.script_name === "string" ? args.script_name.trim() : "";
    if (!scriptName) throw new Error("script_name is required");
    const screenshotBinding = (this.ctx.exports as unknown as {
      AppScreenshotBinding: (options: { props: Pick<CodeModeToolsProps, "orgId" | "workspaceId"> }) => {
        capture(input: {
          scriptName: string;
          path?: string;
          width?: number;
          height?: number;
          waitMs?: number;
        }): Promise<{ imageDataUrl: string; width: number; height: number }>;
      };
    }).AppScreenshotBinding({
      props: {
        orgId: this.ctx.props.orgId,
        workspaceId: this.ctx.props.workspaceId,
      },
    });
    return screenshotBinding.capture({
      scriptName,
      path: typeof args.path === "string" ? args.path : undefined,
      width: typeof args.width === "number" ? args.width : undefined,
      height: typeof args.height === "number" ? args.height : undefined,
      waitMs: typeof args.wait_ms === "number" ? args.wait_ms : undefined,
    });
  }

  private get scheduledPrompts(): CodeModeScheduledPrompts {
    return new CodeModeScheduledPrompts({
      cronStub: this.cronStub,
      workspaceId: this.ctx.props.workspaceId,
      threadId: this.ctx.props.threadId,
      userId: this.ctx.props.userId,
    });
  }

  private get deterministicAutomations(): CodeModeDeterministicAutomations {
    return new CodeModeDeterministicAutomations({
      cronStub: this.cronStub,
      workspaceId: this.ctx.props.workspaceId,
      userId: this.ctx.props.userId,
    });
  }

  private async listScheduledPrompts(): Promise<unknown> {
    return this.scheduledPrompts.list();
  }

  private async createScheduledPrompt(args: Record<string, unknown>): Promise<unknown> {
    return this.scheduledPrompts.create(args);
  }

  private async updateScheduledPrompt(args: Record<string, unknown>): Promise<unknown> {
    return this.scheduledPrompts.update(args);
  }

  private async deleteScheduledPrompt(args: Record<string, unknown>): Promise<unknown> {
    return this.scheduledPrompts.delete(args);
  }

  private async runScheduledPromptNow(args: Record<string, unknown>): Promise<unknown> {
    return this.scheduledPrompts.runNow(args);
  }

  private async listDeterministicAutomations(): Promise<unknown> {
    return this.deterministicAutomations.list();
  }

  private async validateDeterministicAutomation(args: Record<string, unknown>): Promise<unknown> {
    return this.deterministicAutomations.validate(args);
  }

  private async createDeterministicAutomation(args: Record<string, unknown>): Promise<unknown> {
    return this.deterministicAutomations.create(args);
  }

  private async updateDeterministicAutomation(args: Record<string, unknown>): Promise<unknown> {
    return this.deterministicAutomations.update(args);
  }

  private async deleteDeterministicAutomation(args: Record<string, unknown>): Promise<unknown> {
    return this.deterministicAutomations.delete(args);
  }

  private async runDeterministicAutomationNow(args: Record<string, unknown>): Promise<unknown> {
    return this.deterministicAutomations.runNow(args);
  }

  private get integrations(): CodeModeIntegrations {
    return new CodeModeIntegrations({
      env: this.env,
      orgStub: this.orgStub,
      workspaceId: this.ctx.props.workspaceId,
      userId: this.ctx.props.userId,
      promptConnectionSetup: (input) =>
        (this.chatThreadStub as unknown as {
          promptConnectionSetup(input: {
            integrationId?: string;
            integrationType: string;
            suggestedName?: string;
            message?: string;
            instructions?: string;
            initialConfig?: Record<string, unknown>;
            initialCredentials?: Record<string, unknown>;
            dynamicSchema?: DynamicIntegrationSchema;
          }): Promise<ConnectionSetupResponse>;
        }).promptConnectionSetup(input),
    });
  }

  private async listIntegrations(args: Record<string, unknown>): Promise<unknown> {
    return this.integrations.list(args);
  }

  private listIntegrationTypes(args: Record<string, unknown>): unknown {
    return this.integrations.listTypes(args);
  }

  private async createIntegration(args: Record<string, unknown>): Promise<unknown> {
    return this.integrations.create(args);
  }

  private async promptConnectionSetup(args: Record<string, unknown>): Promise<unknown> {
    return this.integrations.promptConnectionSetup(args);
  }

  private async deleteConnection(args: Record<string, unknown>): Promise<unknown> {
    const connection = typeof args.connection === "string" ? args.connection.trim() : "";
    if (!connection) throw new Error("connection is required");

    const entry = await findConnectionMethodEntry(this.env, this.connectionsContext, connection);
    const summary = entry.connection;
    const question =
      `Delete connection "${summary.name}" (${summary.type})? This removes its stored configuration and cannot be undone.`;
    const confirmation = await confirmDestructiveAction(
      (questionArgs) => this.askUserQuestion(questionArgs),
      {
        question,
        header: "Delete connection?",
        confirmLabel: DESTRUCTIVE_CONFIRM_LABEL,
      },
    );
    if (confirmation.unavailableReason) {
      return {
        success: false,
        cancelled: true,
        unavailable_reason: confirmation.unavailableReason,
        message: confirmation.unavailableReason,
      };
    }
    if (!confirmation.confirmed) {
      return {
        success: false,
        cancelled: true,
        message: "Connection deletion cancelled.",
      };
    }

    const actorId = this.ctx.props.userId?.trim() || "system";
    await this.orgStub.deleteWorkspaceIntegration(
      this.ctx.props.workspaceId,
      summary.id,
      actorId,
    );
    return {
      success: true,
      connection: summary.name,
      message: `Deleted connection "${summary.name}"`,
    };
  }

  private async deleteProject(args: Record<string, unknown>): Promise<unknown> {
    const projectName = typeof args.project === "string" ? args.project.trim() : "";
    if (!projectName) throw new Error("project is required");

    const projects = await this.workspaceFs.listProjectsForMigrationReset();
    const nameKey = projectNameKey(projectName);
    const target = projects.find((project) => projectNameKey(project.name) === nameKey);
    if (!target) {
      throw new Error(`Project not found: ${projectName}`);
    }

    const confirmedTargets = collectProjectDeletionTargets(projects, target);
    const cloneNames = confirmedTargets
      .filter((project) => project.id !== target.id)
      .map((project) => project.name);
    const question = cloneNames.length > 0
      ? `Delete project "${target.name}" and its ${cloneNames.length} clone project(s) (${cloneNames.join(", ")})? This removes their VM checkouts and metadata. This cannot be undone.`
      : `Delete project "${target.name}"? This removes its VM checkout and metadata. This cannot be undone.`;
    const confirmation = await confirmDestructiveAction(
      (questionArgs) => this.askUserQuestion(questionArgs),
      {
        question,
        header: "Delete project?",
        confirmLabel: DESTRUCTIVE_CONFIRM_LABEL,
      },
    );
    if (confirmation.unavailableReason) {
      return {
        success: false,
        cancelled: true,
        unavailable_reason: confirmation.unavailableReason,
        message: confirmation.unavailableReason,
      };
    }
    if (!confirmation.confirmed) {
      return {
        success: false,
        cancelled: true,
        message: "Project deletion cancelled.",
      };
    }

    const confirmedProjectIds = orderProjectsForRuntimeDelete(confirmedTargets);
    return this.projectVm.deleteProject({ projectIds: confirmedProjectIds });
  }

  private chatContextFromProps(): ChatContextState {
    return {
      orgId: this.ctx.props.orgId,
      workspaceId: this.ctx.props.workspaceId,
      threadId: this.ctx.props.threadId || "",
      userId: this.ctx.props.userId ?? null,
      userName: null,
      userEmail: null,
    };
  }

  private channelToolHost(): ChatThreadDO {
    const host = Object.create(ChatThreadDO.prototype) as {
      env: ChatEnv;
      chatContext: ChatContextState;
    };
    host.env = this.env;
    host.chatContext = this.chatContextFromProps();
    return host as unknown as ChatThreadDO;
  }

  private async sendEmail(args: Record<string, unknown>): Promise<unknown> {
    return this.channelToolHost().sendChannelEmailTool(this.chatContextFromProps(), args);
  }

  private async sendSlackMessage(args: Record<string, unknown>): Promise<unknown> {
    return this.channelToolHost().sendChannelSlackMessageTool(this.chatContextFromProps(), args);
  }

  private async sendTelegramMessage(args: Record<string, unknown>): Promise<unknown> {
    return this.channelToolHost().sendChannelTelegramMessageTool(this.chatContextFromProps(), args);
  }

  private get customDomains(): CodeModeCustomDomains {
    return new CodeModeCustomDomains({
      env: this.env,
      orgStub: this.orgStub,
      workspaceId: this.ctx.props.workspaceId,
      userId: this.ctx.props.userId,
    });
  }

  private async getCustomDomain(): Promise<unknown> {
    return this.customDomains.get();
  }

  private async setCustomDomain(args: Record<string, unknown>): Promise<unknown> {
    return this.customDomains.set(args);
  }

  private async removeCustomDomain(args: Record<string, unknown>): Promise<unknown> {
    return this.customDomains.remove(args);
  }

  private async retryCustomDomainHostnames(): Promise<unknown> {
    return this.customDomains.retryHostnames();
  }

  private get webSearchClient(): CodeModeWebSearch {
    return new CodeModeWebSearch(
      this.env,
      this.ctx.props.threadId || this.ctx.props.workspaceId,
    );
  }

  private async webFetch(args: Record<string, unknown>): Promise<unknown> {
    return this.webSearchClient.fetch(args);
  }

  private async webSearch(args: Record<string, unknown>): Promise<unknown> {
    return this.webSearchClient.search(args);
  }
}


const CHAT_CONTEXT_KEY = "chatContext";
const CHAT_TODOS_KEY = "chatTodos";
const CHAT_CONTEXT_USED_PERCENT_KEY = "chatContextUsedPercent";
const CHAT_CONTEXT_WINDOW_BY_MODEL_KEY = "chatContextWindowByModel";
const CHAT_NEXT_EVENT_ID_KEY = "chatNextEventId";
const CHAT_ACTIVE_TURN_USER_ID_KEY = "chatActiveTurnUserId";
const PI_TURN_FIBER_NAME = "pi-turn";
const PI_TURN_INACTIVITY_TIMEOUT_MS = 10 * 60_000;
const PI_TURN_PROGRESS_INTERVAL_MS = 30_000;
const PI_TURN_RECOVERY_CONTEXT_PURPOSE = "pi_turn_recovery_context";
const PI_TURN_RECOVERY_CONTINUE_PROMPT = "continue";
const PI_TURN_RECOVERY_PROMPT_OBSERVATION_MS = 5 * 60_000;
const CHAT_ERROR_DEDUPE_WINDOW_MS = 10_000;

const MAX_CHAT_EVENT_BUFFER = 500;
const ASK_USER_QUESTION_UNAVAILABLE_MESSAGE = 'User is not at computer; AskUserQuestion is unavailable in this channel. Continue without asking and use best effort.';

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

const CHAT_CODEX_SESSION_ID_KEY = 'chatCodexSessionId';
const CODE_MODE_ARTIFACTS_KEY_PREFIX = 'codeModeArtifacts:';

/**
 * ChatThreadDO - One per thread, holds preview state, prompts, browser runner
 * traffic, and agent turns. Sandbox-host remains the backend for workspace
 * file/shell/container operations.
 */
export class ChatThreadDO extends Agent<ChatAgentEnv> {
  private static readonly CONNECTION_SETUP_TIMEOUT_MS = 30 * 60 * 1000;

  private previewTarget: PreviewTarget | null = null;
  private previewTabs: PreviewTarget[] = [];
  private previewActiveTabId: string | null = null;
  private previewVersion: number = 0;

  // Chat bridge state
  private chatContext: ChatContextState | null = null;
  private chatEventBuffer: Array<Record<string, unknown>> = [];
  private agentEvalEventCollector: Array<Record<string, unknown>> | null = null;
  private nextChatEventId: number = 1;
  private currentTodos: unknown[] = [];
  // Canonical persisted/replayed value (set on result events only).
  private contextUsedPercent: number | null = null;
  // Ephemeral in-turn value (never persisted).
  private transientContextUsedPercent: number | null = null;
  private usageIsPostCompaction: boolean = true;
  private cachedContextWindowByModel: Record<string, number> = {};
  private chatIsStreaming: boolean = false;
  private activeAutomationRun: ActiveAutomationRunState | null = null;
  private assistantCompletionRecordedAt: number | null = null;
  private assistantCompletionSummaryRequestedAt: number | null = null;
  private readonly browserPrompts = new BrowserPromptCoordinator({
    hasAvailableBrowserUser: () => this.hasAvailableBrowserUser(),
    broadcast: (message) => this.broadcastChat(message),
    sendDirect: (ws, message) => this.sendDirect(ws, message),
    askUserQuestionUnavailableMessage:
      ASK_USER_QUESTION_UNAVAILABLE_MESSAGE,
    questionTimeoutMs: 30 * 60 * 1000,
    connectionSetupTimeoutMs: ChatThreadDO.CONNECTION_SETUP_TIMEOUT_MS,
  });
  private titleGenerationInFlight: boolean = false;
  private codexSessionId: string | null = null;
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
  private suppressNextPiRecoveryPromptEvent = false;
  private piRecoveryContinuePromptSentAtMs: number = 0;
  private piUserStopRequestedAtMs: number = 0;
  private piCurrentBillingSource: PiBillingSource = "hosted";
  private piCurrentCreditChargeable: boolean = false;
  private piCurrentUsageProvider: string | null = null;
  private piTurnLastProgressAtMs: number = 0;
  private piLastPersistedLoopError: { fingerprint: string; at: number } | null = null;
  private piRecordedProviderErrors = new Set<string>();
  private recordedChatErrors = new Map<string, number>();

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

    // Restore state from storage
    ctx.blockConcurrencyWhile(async () => {
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

      const storedNextEventId = ctx.storage.kv.get<number>(
        CHAT_NEXT_EVENT_ID_KEY,
      );
      if (typeof storedNextEventId === "number" && storedNextEventId > 0) {
        this.nextChatEventId = storedNextEventId;
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

      const storedCodexSessionId = ctx.storage.kv.get<string>(CHAT_CODEX_SESSION_ID_KEY);
      if (typeof storedCodexSessionId === 'string' && storedCodexSessionId.trim()) {
        this.codexSessionId = storedCodexSessionId.trim();
      }

      if (
        this.loadLegacyPiTurnRecoveryForMigration() ||
        (await this.hasOrphanedPiInFlightRecovery())
      ) {
        await ctx.storage.setAlarm(Date.now() + 1_000);
      }
    });
  }

  async alarm(): Promise<void> {
    await super.alarm();
    await this.drainLegacyPiTurnRecoveryForMigration();
    await this.drainOrphanedPiInFlightRecovery();
  }

  async onFiberRecovered(ctx: FiberRecoveryContext) {
    if (ctx.name !== PI_TURN_FIBER_NAME) return await super.onFiberRecovered(ctx);

    try {
      await this.recoverInterruptedPiTurn(ctx);
      return { status: "completed" as const };
    } catch (error) {
      console.error("[ChatThreadDO] failed to recover interrupted Pi fiber", error);
      this.persistPiAgentLoopErrorForDevelopers(error, {
        source: "pi_turn_fiber_recovery",
      });
      return {
        status: "interrupted" as const,
        reason: "Pi turn recovery failed; retry later",
        snapshot: ctx.snapshot,
      };
    }
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

    const workerCode: WorkerLoaderWorkerCode = {
      compatibilityDate: CODE_MODE_COMPATIBILITY_DATE,
      mainModule: "index.js",
      modules: {
        "index.js": { js: codeModeWorkerModule(code) },
      },
      env: { TOOLS: tools, AI: ai, CAMELAI: camelai, SECURE_FETCH: secureFetch, SCREENSHOT: screenshot },
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
    this.pushChatEvent({
      type: "code_mode_artifact",
      parentToolUseId: normalizedParentToolUseId,
      artifact,
    });
    await this.setPreviewTarget({ kind: "runtime_artifact", artifact });
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
      if (data.type === "connection_setup_response") {
        const result = await this.handleConnectionSetupResponse(
          data as unknown as ConnectionSetupResponse,
        );
        if (!result.accepted) {
          this.sendDirect(ws, {
            type: "connection_setup_error",
            requestId: typeof data.requestId === "string" ? data.requestId : "",
            error: "Connection setup request is no longer pending. Please ask the agent to start connection setup again.",
          });
        }
        return;
      }

      // Chat transport messages
      if (data.type === "init") {
        await this.handleChatInit(ws, data as unknown as ChatClientInitMessage);
        return;
      }

      if (
        data.type === "message" ||
        data.type === "stop" ||
        data.type === "set_model"
      ) {
        await this.handleRunnerClientMessage(ws, data);
        return;
      }

      if (data.type === "question_response") {
        await this.handleQuestionResponse(
          ws,
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
  async setTitle(title: string, updatedAt?: number): Promise<void> {
    const normalizedTitle = title.trim();
    if (!normalizedTitle) return;
    this.pushChatEvent({
      type: "title_updated",
      title: normalizedTitle,
      ...(typeof updatedAt === "number" && Number.isFinite(updatedAt)
        ? { updatedAt }
        : {}),
    });
  }

  async setModel(model: LlmModel, updatedAt?: number): Promise<void> {
    this.broadcastChat({ type: 'thread_model_updated', model, updatedAt });
  }

  async setTodoState(todos: unknown[]): Promise<void> {
    this.currentTodos = Array.isArray(todos) ? normalizeTodoItems(todos) : [];
    if (this.currentTodos.length > 0) {
      this.ctx.storage.kv.put(CHAT_TODOS_KEY, this.currentTodos);
    } else {
      this.ctx.storage.kv.delete(CHAT_TODOS_KEY);
    }
    this.broadcastChat({ type: 'todo_state', todos: this.currentTodos });
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
    return {
      isStreaming: this.chatIsStreaming,
      pendingQuestionCount: this.browserPrompts.pendingQuestionCount,
      oldestPendingQuestion: pending?.questions[0]?.question ?? null,
      updatedAt:
        this.chatIsStreaming || this.browserPrompts.pendingQuestionCount > 0
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
      this.setChatIsStreaming(true);
      return;
    }
    this.setChatIsStreaming(
      false,
      this.chatIsStreaming
        ? {
            markUnread: true,
            completedAt: Date.now(),
            summarySource: null,
          }
        : {},
    );
  }

  async completeTodoStateForTurnEnd(): Promise<void> {
    if (this.currentTodos.length === 0) return;

    const completedTodos = this.currentTodos.map((todo) => {
      if (!todo || typeof todo !== "object") {
        return todo;
      }
      return {
        ...(todo as Record<string, unknown>),
        status: "completed",
      };
    });

    this.currentTodos = [];
    this.ctx.storage.kv.delete(CHAT_TODOS_KEY);
    this.broadcastChat({ type: "todo_state", todos: completedTodos });
  }

  getLegacyClaudeSessionId(): string | null {
    try {
      const rows = this.ctx.storage.sql
        .exec<{ value: string }>(
          "SELECT value FROM metadata WHERE key = ?",
          "claude_session_id",
        )
        .toArray();
      const value = rows[0]?.value;
      return typeof value === "string" && value.trim() ? value.trim() : null;
    } catch {
      return null;
    }
  }

  getCodexSessionId(): string | null {
    const value = this.codexSessionId;
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  async getPiCoreParsedMessages(threadId: string): Promise<AgentEvalParsedMessage[]> {
    const normalizedThreadId = threadId.trim() || this.chatContext?.threadId || "";
    const parsed: AgentEvalParsedMessage[] = [];

    const [coreMessages, inFlightMessages] = await Promise.all([
      this.loadPiCoreMessages({ includeUiMetadata: true }),
      this.loadPiInFlightMessages({ includeUiMetadata: true }),
    ]);
    const storedMessages = [...coreMessages, ...inFlightMessages];
    storedMessages.forEach((message, index) => {
      const record = message as unknown as Record<string, unknown>;
      if (record.role === "toolResult") {
        this.attachPiToolResultToParsedMessages(parsed, record);
        return;
      }
      parsed.push(...this.piCoreMessageToParsedChatMessage(message, index, normalizedThreadId));
    });
    return parsed;
  }

  async getAdminExplorerSummary(input: {
    userMessageCap?: number;
  } = {}): Promise<AdminExplorerThreadSummary> {
    const cap = Number.isFinite(input.userMessageCap)
      ? Math.max(1, Math.min(100, Math.floor(input.userMessageCap as number)))
      : 20;
    const [coreMessages, inFlightMessages] = await Promise.all([
      this.loadPiCoreMessages({ includeUiMetadata: true }),
      this.loadPiInFlightMessages({ includeUiMetadata: true }),
    ]);
    const messages = [...coreMessages, ...inFlightMessages];
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
          !this.isInternalPiClientMessage(record) &&
          !this.isCompactSummaryPiMessage(record)
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

  async hydratePiCoreFromParsedMessages(
    threadId: string,
    messages: Array<{
      id?: string;
      thread_id?: string;
      role?: string;
      content?: unknown;
      created_at?: number;
      forkEntryId?: string;
      isMeta?: boolean;
      isCompactSummary?: boolean;
      sentDuringStreaming?: boolean;
    }>,
  ): Promise<{ hydrated: boolean; count: number; existingCount: number; deferred?: boolean }> {
    const existingMessages = await this.loadPiCoreMessages();
    const normalizedThreadId = threadId.trim() || this.chatContext?.threadId || "";
    const agentMessages = messages.flatMap((message) =>
      this.parsedChatMessageToPiCoreMessage(message, normalizedThreadId),
    );
    if (agentMessages.length === 0) {
      return {
        hydrated: false,
        count: 0,
        existingCount: existingMessages.length,
      };
    }

    const existingKeys = new Set(
      existingMessages.map((message) => this.piCoreMessageKey(message)),
    );
    const missingLegacyMessages = agentMessages.filter((message) => {
      const key = this.piCoreMessageKey(message);
      if (existingKeys.has(key)) return false;
      existingKeys.add(key);
      return true;
    });
    if (missingLegacyMessages.length === 0) {
      return {
        hydrated: false,
        count: 0,
        existingCount: existingMessages.length,
      };
    }

    const inFlightMessages = await this.loadPiInFlightMessages();
    if (
      this.chatIsStreaming ||
      this.piSession?.state.isStreaming ||
      this.activeTurnUserId ||
      inFlightMessages.length > 0
    ) {
      return {
        hydrated: false,
        count: 0,
        existingCount: existingMessages.length,
        deferred: true,
      };
    }

    this.disposePiSession();
    await this.replacePiCoreMessages([
      ...missingLegacyMessages,
      ...existingMessages,
    ]);
    this.ctx.storage.sql.exec("DELETE FROM pi_core_compaction");
    this.clearPiInFlightMessages();
    return {
      hydrated: true,
      count: missingLegacyMessages.length,
      existingCount: existingMessages.length,
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
      await this.markThreadChannelUsedBestEffort(
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
      const ids = this.piCoreForkMessageIds(message, index);
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
    this.clearPiInFlightMessages();
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

    this.chatIsStreaming = false;
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
      this.chatIsStreaming ||
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

  async refreshRunnerConfig(): Promise<void> {
    await this.withRunnerTransitionLock('refresh_runner_config', async () => {
      this.disposePiSession();
    });
  }

  async byokChanged(): Promise<void> {
    // Admin changed this org's BYOK config: drop the cached llm provider
    // config so the next turn re-reads it instead of waiting out the TTL.
    this.cachedLlmProviderConfig = null;
    await this.withRunnerTransitionLock('byok_changed', async () => {
      this.disposePiSession();
    });
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
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS pi_in_flight_messages (
        idx INTEGER PRIMARY KEY,
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

  private async loadPiInFlightMessages(options: { includeUiMetadata?: boolean } = {}): Promise<AgentMessage[]> {
    this.ensurePiCoreTables();
    const rows = this.ctx.storage.sql
      .exec<{ payload: string }>(
        "SELECT payload FROM pi_in_flight_messages ORDER BY idx ASC",
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
        // Skip corrupt rows.
      }
    }
    return messages;
  }

  private async appendPiInFlightMessages(messages: AgentMessage[]): Promise<void> {
    if (messages.length === 0) return;
    this.ensurePiCoreTables();
    const rows = this.ctx.storage.sql
      .exec<{ next_idx: number }>(
        "SELECT COALESCE(MAX(idx) + 1, 0) AS next_idx FROM pi_in_flight_messages",
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
        "INSERT INTO pi_in_flight_messages (idx, payload, created_at) VALUES (?, ?, ?)",
        startIndex + offset,
        serialized.payload,
        now,
      );
    }
    this.recordPiSqlStorageSanitization("append_in_flight", aggregateStats, messages.length);
  }

  private clearPiInFlightMessages(): void {
    this.ensurePiCoreTables();
    this.ctx.storage.sql.exec("DELETE FROM pi_in_flight_messages");
  }

  private buildPiRecoveryUserMessage(messages: AgentMessage[]): AgentMessage {
    const lines = messages
      .map((message) => this.serializePiMessageForSummary(message))
      .filter((line): line is string => Boolean(line && line.trim()));
    const body = lines.length > 0
      ? lines.join("\n\n")
      : "(no recorded events before the interruption)";
    const text =
      "[The previous turn was interrupted by a restart before it could finish. " +
      "Here is what had been recorded up to that point. Use this as context only; " +
      "do not assume any tool side effects completed unless the user confirms.]\n\n" +
      body;
    return {
      role: "user",
      content: text,
      timestamp: Date.now(),
      visibility: "hidden",
      metadata: {
        purpose: PI_TURN_RECOVERY_CONTEXT_PURPOSE,
      },
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

  private isPiRecoveryContinueMessage(message: AgentMessage): boolean {
    const record = message as unknown as Record<string, unknown>;
    const content = record.content;
    return record.role === "user" &&
      typeof content === "string" &&
      content.trim() === PI_TURN_RECOVERY_CONTINUE_PROMPT;
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
    const continueCount = messages.filter((message) => this.isPiRecoveryContinueMessage(message)).length;
    if (continueCount > 0) {
    }
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

  // TODO(remove after next deploy): one-release migration shim for pi_turn_recovery
  // rows created by the pre-Agents-SDK ChatThreadDO. New turns use managed fibers.
  private ensureLegacyPiTurnRecoveryTableForMigration(): void {
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS pi_turn_recovery (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        turn_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'recovering')),
        user_content TEXT NOT NULL,
        user_timestamp INTEGER NOT NULL,
        active_user_id TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        started_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    );
  }

  private loadLegacyPiTurnRecoveryForMigration(): LegacyPiTurnRecoveryRow | null {
    this.ensureLegacyPiTurnRecoveryTableForMigration();
    const row = this.ctx.storage.sql
      .exec<{
        turn_id: string;
        status: string;
        active_user_id: string | null;
        retry_count: number;
        started_at: number;
        updated_at: number;
      }>(
        `SELECT turn_id, status, active_user_id, retry_count, started_at, updated_at
         FROM pi_turn_recovery
         WHERE id = 1`,
      )
      .toArray()[0];
    if (!row || (row.status !== "running" && row.status !== "recovering")) return null;
    return {
      turn_id: row.turn_id,
      status: row.status,
      active_user_id:
        typeof row.active_user_id === "string" && row.active_user_id.trim()
          ? row.active_user_id.trim()
          : null,
      retry_count: Math.max(0, Math.floor(Number(row.retry_count) || 0)),
      started_at: Math.max(0, Math.floor(Number(row.started_at) || 0)),
      updated_at: Math.max(0, Math.floor(Number(row.updated_at) || 0)),
    };
  }

  private clearLegacyPiTurnRecoveryForMigration(): void {
    this.ensureLegacyPiTurnRecoveryTableForMigration();
    this.ctx.storage.sql.exec("DELETE FROM pi_turn_recovery WHERE id = 1");
  }

  private async hasActivePiTurnFiber(): Promise<boolean> {
    const [fiber] = await this.listFibers({
      name: PI_TURN_FIBER_NAME,
      status: ["pending", "running", "interrupted"],
      limit: 1,
    });
    return Boolean(fiber);
  }

  private async drainLegacyPiTurnRecoveryForMigration(): Promise<void> {
    const pending = this.loadLegacyPiTurnRecoveryForMigration();
    if (!pending) return;
    if (await this.hasActivePiTurnFiber()) return;

    await this.recoverInterruptedPiTurn({
      id: pending.turn_id,
      name: PI_TURN_FIBER_NAME,
      snapshot: { activeUserId: pending.active_user_id },
      createdAt: pending.started_at || pending.updated_at || Date.now(),
      recoveryReason: "interrupted",
    });
    this.clearLegacyPiTurnRecoveryForMigration();
  }

  private async hasOrphanedPiInFlightRecovery(): Promise<boolean> {
    if (this.loadLegacyPiTurnRecoveryForMigration()) return false;
    if (await this.hasActivePiTurnFiber()) return false;
    return (await this.loadPiInFlightMessages()).length > 0;
  }

  private async drainOrphanedPiInFlightRecovery(): Promise<void> {
    if (!(await this.hasOrphanedPiInFlightRecovery())) return;
    const inFlight = await this.loadPiInFlightMessages();
    const firstTimestamp = Math.max(0, Math.floor(Number(
      (inFlight[0] as unknown as Record<string, unknown> | undefined)?.timestamp,
    ) || 0));
    const createdAt = firstTimestamp || Date.now();
    try {
      await this.recoverInterruptedPiTurn({
        id: "orphaned-in-flight",
        name: PI_TURN_FIBER_NAME,
        snapshot: { activeUserId: this.activeTurnUserId },
        createdAt,
        recoveryReason: "interrupted",
      });
    } catch (error) {
      console.error("[ChatThreadDO] failed to recover orphaned Pi in-flight messages", error);
      this.persistPiAgentLoopErrorForDevelopers(error, {
        source: "pi_turn_orphaned_in_flight_recovery",
      });
      await this.ctx.storage.setAlarm(Date.now() + 30_000);
    }
  }

  async getPiTurnRecoveryAdminState(): Promise<PiTurnRecoveryAdminState> {
    return {
      pending: (await this.listFibers({
        name: PI_TURN_FIBER_NAME,
        status: ["pending", "running", "interrupted"],
        limit: 1,
      }))[0] ?? null,
      legacyPending: this.loadLegacyPiTurnRecoveryForMigration(),
      inFlightCount: (await this.loadPiInFlightMessages()).length,
    };
  }

  private async startPiTurnRecovery(userMessage: AgentMessage): Promise<void> {
    await this.appendPiInFlightMessages([userMessage]);
  }

  async clearPiTurnRecoveryForAdmin(): Promise<PiTurnRecoveryAdminState> {
    const fibers = await this.listFibers({
      name: PI_TURN_FIBER_NAME,
      status: ["pending", "running", "interrupted"],
      limit: 20,
    });
    await Promise.all(fibers.map((fiber) =>
      fiber.status === "interrupted"
        ? this.resolveFiber(fiber.fiberId, { status: "aborted", reason: "Admin cleared Pi recovery" })
        : this.cancelFiber(fiber.fiberId, "Admin cleared Pi recovery"),
    ));
    this.clearLegacyPiTurnRecoveryForMigration();
    this.clearPiInFlightMessages();
    this.setChatIsStreaming(false);
    return await this.getPiTurnRecoveryAdminState();
  }

  private async keepAlivePiTurnWhile(fn: () => Promise<void>): Promise<void> {
    const inFlight = await this.loadPiInFlightMessages();
    const lastUserMessage = inFlight.findLast((message) =>
      (message as unknown as Record<string, unknown>).role === "user"
    ) as (AgentMessage & { content?: unknown; timestamp?: unknown }) | undefined;
    const content = typeof lastUserMessage?.content === "string" ? lastUserMessage.content : "";
    const metadata = {
      activeUserId: this.activeTurnUserId,
      inFlightCount: inFlight.length,
      userTimestamp: typeof lastUserMessage?.timestamp === "number" ? lastUserMessage.timestamp : Date.now(),
      startedAt: Date.now(),
    };
    let timedOut = false;
    const result = await this.startFiber(
      PI_TURN_FIBER_NAME,
      async (fiber) => {
        fiber.stash(metadata);
        await this.withPiTurnInactivityTimeout(fn, () => {
          timedOut = true;
        });
      },
      {
        waitForCompletion: true,
        metadata,
        ...(content.trim()
          ? { idempotencyKey: `pi-turn:${metadata.userTimestamp}:${(await this.sha256Hex(content)).slice(0, 16)}` }
          : {}),
      },
    );
    if (result.status === "error") {
      if (timedOut) {
        await this.recoverInterruptedPiTurn({
          id: result.fiberId,
          name: PI_TURN_FIBER_NAME,
          snapshot: result.snapshot ?? result.metadata ?? null,
          createdAt: result.createdAt,
          recoveryReason: "interrupted",
        });
        return;
      }
      if (this.piUserStopRequestedAtMs > 0) {
        throw new DOMException(result.error ?? "Pi turn aborted", "AbortError");
      }
      throw new Error(result.error ?? "Pi turn fiber failed");
    }
    if (result.status === "aborted") throw new DOMException(result.error ?? "Pi turn fiber aborted", "AbortError");
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
    onTimeout?: () => void,
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
            onTimeout?.();
            this.disposePiSession();
            reject(new DOMException("Pi turn inactivity timeout", "AbortError"));
          }, PI_TURN_PROGRESS_INTERVAL_MS);
        }),
      ]);
    } finally {
      if (interval) clearInterval(interval);
      this.piTurnLastProgressAtMs = 0;
    }
  }

  private async recoverInterruptedPiTurn(ctx: FiberRecoveryContext): Promise<void> {
    if (!this.chatContext) throw new Error("missing chat context for Pi turn recovery");
    const snapshot = ctx.snapshot && typeof ctx.snapshot === "object"
      ? ctx.snapshot as Record<string, unknown>
      : {};
    const activeUserId = typeof snapshot.activeUserId === "string" ? snapshot.activeUserId : null;

    this.setActiveTurnUserId(activeUserId);
    this.setChatIsStreaming(true);

    await this.ensurePiSessionReady();
    if (!this.piSession) throw new Error("Pi session was not available for turn recovery");
    await this.refreshPiSessionModel();
    this.suppressNextPiRecoveryPromptEvent = true;
    this.piRecoveryContinuePromptSentAtMs = Date.now();
    try {
      await this.withPiTurnInactivityTimeout(async () => {
        if (!this.piSession) throw new Error("Pi session was not available for turn recovery");
        await this.piSession.prompt({
          role: "user",
          content: PI_TURN_RECOVERY_CONTINUE_PROMPT,
          timestamp: this.piRecoveryContinuePromptSentAtMs,
        });
      });
    } finally {
      this.suppressNextPiRecoveryPromptEvent = false;
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

  private isPiUserStopMessage(message: AgentMessage): boolean {
    const record = message as unknown as Record<string, unknown>;
    if (record.role !== "assistant") return false;
    const metadata = record.metadata;
    if (metadata && typeof metadata === "object") {
      const reason = (metadata as Record<string, unknown>).reason;
      if (reason === PI_USER_STOP_METADATA_REASON) return true;
    }
    return false;
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
    if (visibleMessages.some((message) => this.isPiUserStopMessage(message))) {
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

  private piCoreMessageToParsedChatMessage(
    message: AgentMessage,
    index: number,
    threadId: string,
  ): Array<{
    id: string;
    thread_id: string;
    role: "user" | "assistant";
    content: unknown;
    created_at: number;
    forkEntryId: string;
    sentDuringStreaming?: boolean;
    isCompactSummary?: boolean;
  }> {
    const record = message as unknown as Record<string, unknown>;
    const role = record.role;
    const timestamp = typeof record.timestamp === "number" && Number.isFinite(record.timestamp)
      ? record.timestamp
      : Date.now();

    if (this.isInternalPiClientMessage(record)) {
      return [];
    }

    if (role === "user") {
      const metadata =
        record.metadata && typeof record.metadata === "object"
          ? (record.metadata as Record<string, unknown>)
          : null;
      const sentDuringStreaming =
        record.sentDuringStreaming === true ||
        metadata?.sentDuringStreaming === true;
      const isCompactSummary =
        record.isCompactSummary === true ||
        metadata?.compactSummary === true ||
        metadata?.isCompactSummary === true;
      return [{
        id: `pi_user_${timestamp}_${index}`,
        thread_id: threadId,
        role: "user",
        content: this.piUserContentToChatContent(record.content),
        created_at: timestamp,
        forkEntryId: `pi_user_${timestamp}_${index}`,
        ...(sentDuringStreaming ? { sentDuringStreaming: true } : {}),
        ...(isCompactSummary ? { isCompactSummary: true } : {}),
      }];
    }

    if (role === "assistant") {
      const content = this.piAssistantContentToChatContent(record);
      if (Array.isArray(content) && content.length === 0) return [];
      const responseId = typeof record.responseId === "string" && record.responseId.trim()
        ? record.responseId.trim()
        : `pi_assistant_${timestamp}_${index}`;
      return [{
        id: responseId,
        thread_id: threadId,
        role: "assistant",
        content,
        created_at: timestamp,
        forkEntryId: responseId,
      }];
    }

    return [];
  }

  private parsedChatMessageToPiCoreMessage(
    message: {
      id?: string;
      thread_id?: string;
      role?: string;
      content?: unknown;
      created_at?: number;
      forkEntryId?: string;
      isMeta?: boolean;
      isCompactSummary?: boolean;
      sentDuringStreaming?: boolean;
    },
    threadId: string,
  ): AgentMessage[] {
    const role = message.role;
    if (role !== "user" && role !== "assistant") return [];
    if (message.isMeta === true) return [];
    const timestamp =
      typeof message.created_at === "number" && Number.isFinite(message.created_at)
        ? message.created_at
        : Date.now();
    const content = role === "user"
      ? this.parsedChatUserContentToPiContent(message.content)
      : this.parsedChatAssistantContentToPiContent(message.content);
    if (typeof content === "string" && !content.trim()) return [];
    if (Array.isArray(content) && content.length === 0) return [];

    if (role === "user") {
      return [{
        role: "user",
        content,
        timestamp,
        metadata: {
          hydratedFromLegacyThread: threadId,
          legacyMessageId: typeof message.id === "string" ? message.id : undefined,
          ...(message.isCompactSummary === true ? { compactSummary: true } : {}),
          ...(message.sentDuringStreaming === true ? { sentDuringStreaming: true } : {}),
        },
      } as unknown as AgentMessage];
    }

    return [{
      role: "assistant",
      content,
      api: "legacy",
      provider: "legacy",
      model: "legacy",
      usage: this.emptyPiUsage(),
      stopReason: "stop",
      responseId:
        typeof message.forkEntryId === "string" && message.forkEntryId.trim()
          ? message.forkEntryId.trim()
          : typeof message.id === "string" && message.id.trim()
            ? message.id.trim()
            : `legacy_assistant_${timestamp}`,
      timestamp,
      metadata: {
        hydratedFromLegacyThread: threadId,
        legacyMessageId: typeof message.id === "string" ? message.id : undefined,
        ...(message.isCompactSummary === true ? { compactSummary: true } : {}),
      },
    } as unknown as AgentMessage];
  }

  private parsedChatUserContentToPiContent(content: unknown): string | Array<Record<string, unknown>> {
    if (typeof content === "string") return content;
    const textBlocks = this.extractTextBlocksFromParsedChatContent(content);
    return textBlocks.length > 0 ? textBlocks : "";
  }

  private parsedChatAssistantContentToPiContent(content: unknown): Array<Record<string, unknown>> {
    const textBlocks = this.extractTextBlocksFromParsedChatContent(content);
    if (textBlocks.length > 0) return textBlocks;
    if (typeof content === "string" && content.trim()) {
      return [{ type: "text", text: content }];
    }
    return [];
  }

  private extractTextBlocksFromParsedChatContent(content: unknown): Array<Record<string, unknown>> {
    if (typeof content === "string") {
      return content.trim() ? [{ type: "text", text: content }] : [];
    }
    if (!Array.isArray(content)) return [];
    return content.flatMap((part): Array<Record<string, unknown>> => {
      if (!part || typeof part !== "object") return [];
      const item = part as Record<string, unknown>;
      if (item.type === "text" && typeof item.text === "string") {
        return item.text.trim() ? [{ type: "text", text: item.text }] : [];
      }
      if (item.type === "thinking" || item.type === "tool_use" || item.type === "tool_result") {
        return [];
      }
      if (item.type === "error" && typeof item.error === "string") {
        return item.error.trim() ? [{ type: "text", text: item.error }] : [];
      }
      if (item.type === "task_notification") {
        const summary = this.legacyChatStringField(item.summary ?? item.text);
        return summary ? [{ type: "text", text: summary }] : [];
      }
      if (item.type === "teammate_message") {
        const content = this.legacyChatStringField(item.content ?? item.text);
        return content ? [{ type: "text", text: content }] : [];
      }
      return [];
    });
  }

  private legacyChatStringField(value: unknown): string {
    if (typeof value === "string") return value.trim();
    if (value === undefined || value === null) return "";
    return this.stringifyLegacyChatBlock(value).trim();
  }

  private stringifyLegacyChatBlock(value: unknown): string {
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  private piCoreForkMessageIds(message: AgentMessage, index: number): string[] {
    const record = message as unknown as Record<string, unknown>;
    const role = record.role;
    const timestamp = typeof record.timestamp === "number" && Number.isFinite(record.timestamp)
      ? record.timestamp
      : Date.now();
    const ids: string[] = [];

    if (role === "user") {
      ids.push(`pi_user_${timestamp}_${index}`);
    } else if (role === "assistant") {
      const responseId = typeof record.responseId === "string" && record.responseId.trim()
        ? record.responseId.trim()
        : `pi_assistant_${timestamp}_${index}`;
      ids.push(responseId);
    }

    if (typeof record.id === "string" && record.id.trim()) {
      ids.push(record.id.trim());
    }
    return Array.from(new Set(ids));
  }

  private isInternalPiClientMessage(message: unknown): boolean {
    if (!message || typeof message !== "object") return false;
    const record = message as Record<string, unknown>;
    if (record.visibility === "hidden") return true;
    const metadata = record.metadata;
    if (!metadata || typeof metadata !== "object") return false;
    const meta = metadata as Record<string, unknown>;
    return meta.purpose === PI_TURN_RECOVERY_CONTEXT_PURPOSE;
  }

  private isCompactSummaryPiMessage(message: unknown): boolean {
    if (!message || typeof message !== "object") return false;
    const record = message as Record<string, unknown>;
    if (record.isCompactSummary === true || record.isMeta === true) return true;
    const metadata = record.metadata;
    if (!metadata || typeof metadata !== "object") return false;
    const meta = metadata as Record<string, unknown>;
    return meta.compactSummary === true || meta.isCompactSummary === true;
  }

  private piSdkUserEventText(event: unknown): string | null {
    if (!event || typeof event !== "object") return null;
    const record = event as Record<string, unknown>;
    if (record.type !== "user") return null;
    const message = record.message;
    if (!message || typeof message !== "object") return null;
    const content = (message as Record<string, unknown>).content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return null;
    return content
      .flatMap((part): string[] => {
        if (!part || typeof part !== "object") return [];
        const item = part as Record<string, unknown>;
        return item.type === "text" && typeof item.text === "string"
          ? [item.text]
          : [];
      })
      .join("\n");
  }

  private shouldSuppressPiSdkEventForChat(event: unknown): boolean {
    if (event && typeof event === "object") {
      const record = event as Record<string, unknown>;
      if (record.type === "user" && this.isInternalPiClientMessage(record.message)) {
        return true;
      }
    }
    const userText = this.piSdkUserEventText(event)?.trim();
    if (!this.suppressNextPiRecoveryPromptEvent) {
      if (
        userText === PI_TURN_RECOVERY_CONTINUE_PROMPT &&
        this.piRecoveryContinuePromptSentAtMs > 0 &&
        Date.now() - this.piRecoveryContinuePromptSentAtMs <= PI_TURN_RECOVERY_PROMPT_OBSERVATION_MS
      ) {
      }
      return false;
    }
    if (userText !== PI_TURN_RECOVERY_CONTINUE_PROMPT) {
      return false;
    }
    this.suppressNextPiRecoveryPromptEvent = false;
    return true;
  }

  private piUserContentToChatContent(content: unknown): unknown {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    const blocks = content.flatMap((part): Array<Record<string, unknown>> => {
      if (!part || typeof part !== "object") return [];
      const item = part as Record<string, unknown>;
      if (item.type === "text" && typeof item.text === "string") {
        return [{ type: "text", text: item.text }];
      }
      return [];
    });
    return blocks.length > 0 ? blocks : "";
  }

  private piAssistantContentToChatContent(message: Record<string, unknown>): Array<Record<string, unknown>> {
    const isUserStop = this.isPiUserStopMessage(message as unknown as AgentMessage);
    const content = message.content;
    const blocks = Array.isArray(content) ? content.flatMap((part): Array<Record<string, unknown>> => {
      if (!part || typeof part !== "object") return [];
      const item = part as Record<string, unknown>;
      if (item.type === "text" && typeof item.text === "string") {
        return [{
          type: "text",
          text: item.text,
          ...(isUserStop ? { itemKind: "userStop" } : {}),
        }];
      }
      if (item.type === "thinking" && typeof item.thinking === "string") {
        return [{
          type: "thinking",
          thinking: item.thinking,
          signature: typeof item.thinkingSignature === "string" ? item.thinkingSignature : undefined,
        }];
      }
      if (item.type === "toolCall" && typeof item.id === "string" && typeof item.name === "string") {
        return [{
          type: "tool_use",
          id: item.id,
          name: item.name,
          input: item.arguments && typeof item.arguments === "object" ? item.arguments : {},
        }];
      }
      return [];
    }) : [];
    if (
      blocks.length === 0 &&
      typeof message.errorMessage === "string" &&
      message.errorMessage.trim()
    ) {
      const status = typeof message.status === "number" && Number.isFinite(message.status)
        ? Math.trunc(message.status)
        : undefined;
      return [{
        type: "error",
        title: "Assistant error",
        error: message.errorMessage.trim(),
        ...(message.billingSource === "byok" || message.billingSource === "hosted"
          ? { billingSource: message.billingSource }
          : {}),
        ...(typeof message.provider === "string" && message.provider.trim()
          ? { provider: message.provider.trim() }
          : {}),
        ...(status ? { status } : {}),
        ...(typeof message.errorType === "string" && message.errorType.trim()
          ? { errorType: message.errorType.trim() }
          : {}),
      }];
    }
    return blocks;
  }

  private attachPiToolResultToParsedMessages(
    messages: Array<{
      id: string;
      thread_id: string;
      role: "user" | "assistant";
      content: unknown;
      created_at: number;
      forkEntryId: string;
    }>,
    toolResult: Record<string, unknown>,
  ): void {
    const toolCallId =
      typeof toolResult.toolCallId === "string" && toolResult.toolCallId.trim()
        ? toolResult.toolCallId.trim()
        : "";
    if (!toolCallId) return;

    const uiMetadata = normalizePiUiMetadata(toolResult.uiMetadata);
    const isError = toolResult.isError === true;
    const block: ToolResultBlock = {
      type: "tool_result",
      tool_use_id: toolCallId,
      content: this.piToolResultContentToChatContent(toolResult.content),
      is_error: isError,
      status: isError ? "failed" : "succeeded",
      itemId: toolCallId,
      itemKind:
        typeof toolResult.toolName === "string" &&
        toolResult.toolName.trim().toLowerCase() === "bash"
          ? "commandExecution"
          : "dynamicToolCall",
      ...(uiMetadata?.codeModeArtifacts?.length
        ? { artifacts: uiMetadata.codeModeArtifacts }
        : {}),
    };

    let fallbackAssistantIndex = -1;
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (message.role !== "assistant") continue;
      if (fallbackAssistantIndex === -1) fallbackAssistantIndex = index;
      const content = Array.isArray(message.content) ? message.content : [];
      if (
        content.some((part) => {
          if (!part || typeof part !== "object") return false;
          const item = part as Record<string, unknown>;
          return item.type === "tool_use" && item.id === toolCallId;
        })
      ) {
        messages[index] = {
          ...message,
          content: [...content, block],
        };
        return;
      }
    }

    if (fallbackAssistantIndex !== -1) {
      const message = messages[fallbackAssistantIndex];
      const content = Array.isArray(message.content) ? message.content : [];
      messages[fallbackAssistantIndex] = {
        ...message,
        content: [...content, block],
      };
    }
  }

  private piToolResultContentToChatContent(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return this.safeLegacyString(content);
    const text = content
      .flatMap((part): string[] => {
        if (!part || typeof part !== "object") return [];
        const item = part as Record<string, unknown>;
        if (item.type === "text" && typeof item.text === "string") {
          return [item.text];
        }
        return [this.safeLegacyString(item)];
      })
      .filter(Boolean)
      .join("\n");
    return text || this.safeLegacyString(content);
  }

  private safeLegacyString(value: unknown): string {
    if (typeof value === "string") return value;
    if (value === null || value === undefined) return "";
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
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

  private async handleChatInit(
    ws: WebSocket,
    data: ChatClientInitMessage,
  ): Promise<void> {
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
    this.browserPrompts.sendPendingPromptsToWebSocket(ws);

    for (const pending of this.browserPrompts.pendingQuestionPrompts()) {
      this.sendDirect(ws, {
        type: "ask_user_question",
        questionId: pending.questionId,
        toolUseId: pending.toolUseId,
        questions: pending.questions,
      });
    }

    this.replayChatEvents(ws, lastEventId);

    if (!this.chatIsStreaming && this.currentTodos.length > 0) {
      await this.completeTodoStateForTurnEnd();
    }

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

  private async handleRunnerClientMessage(
    ws: WebSocket,
    data: { type: string; [key: string]: unknown },
  ): Promise<void> {
    if (data.type === "message") {
      await this.handleRunnerClientUserMessage(ws, data as unknown as ChatClientMessage);
      return;
    }

    await this.ensurePiSessionReady();
    this.sendRunnerCommand({ ...data, threadId: this.chatContext?.threadId });
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

  private sendDirectChatError(
    ws: WebSocket,
    error: unknown,
    options: {
      status?: "busy" | "error" | string;
      fallbackMessage: string;
      source: "runner_enqueue" | "runner_send" | "chat_init" | string;
    },
  ): void {
    const payload = this.chatSendErrorPayload(error, {
      status: options.status,
      fallbackMessage: options.fallbackMessage,
    });
    const message =
      typeof payload.error === "string" && payload.error.trim()
        ? payload.error.trim()
        : options.fallbackMessage;
    this.recordCurrentThreadError({
      message,
      source: options.source,
      errorKind: payload.errorType ?? payload.error_kind,
      status: payload.status ?? payload.statusCode,
      provider: payload.provider,
      model: payload.model,
      createdAt: Date.now(),
    });
    this.sendDirect(ws, payload);
  }

  private async handleRunnerClientUserMessage(
    ws: WebSocket,
    data: ChatClientMessage,
  ): Promise<void> {
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
        this.sendDirect(ws, {
          type: "message_accepted",
          clientMessageId,
        });
        return;
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
          this.sendDirect(
            ws,
            this.chatSendErrorPayload(error, {
              fallbackMessage: "Failed to send message to sandbox",
            }),
          );
          return;
        }
        if (outcome.status === "accepted") {
          this.sendDirect(ws, {
            type: "message_accepted",
            clientMessageId,
          });
        } else {
          this.sendDirect(
            ws,
            this.chatSendErrorPayload(outcome.error, {
              status: outcome.status,
              fallbackMessage: "Failed to send message",
            }),
          );
        }
        return;
      }

      this.sendDirect(ws, {
        type: "message_accepted",
        clientMessageId,
      });
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
      this.setChatIsStreaming(false);
      this.setActiveTurnUserId(null);
      console.error("[ChatThreadDO] failed to enqueue browser user message", error);
      this.sendDirectChatError(ws, error, {
        source: "runner_enqueue",
        fallbackMessage: "Failed to send message to sandbox",
      });
      return;
    } finally {
      if (clientMessageId) {
        this.getPendingClientMessageEnqueues().delete(clientMessageId);
      }
    }

    if (result.status !== "accepted") {
      this.sendDirectChatError(ws, result.error, {
        source: "runner_send",
        status: result.status,
        fallbackMessage: "Failed to send message",
      });
      return;
    }

    // Only now is the id a safe dedupe marker: the message has actually
    // reached an accepted turn, so swallowing retransmits cannot lose it.
    if (clientMessageId) {
      this.recordAcceptedClientMessageId(clientMessageId);
    }


  }

  private async enqueueRunnerUserMessage(
    data: ChatClientMessage,
    options: {
      sendAttemptId?: string;
      startedAt?: number;
      messageSource?: string | null;
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

    let sent = false;
    try {
      this.setActiveTurnUserId(context.userId);
      this.setChatIsStreaming(true);
      this.publishRunningUserMessageActivity(rawContent);
      this.broadcastChat({ type: "streaming_state", isStreaming: true });
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
      });
    } catch (error) {
      this.setChatIsStreaming(false);
      this.setActiveTurnUserId(null);
      throw error;
    }
    if (!sent) {
      this.updateActiveAutomationRun({
        status: "error",
        message: "Failed to send message",
        clear: true,
      });
      this.setChatIsStreaming(false);
      this.setActiveTurnUserId(null);
      return { status: "error", error: "Failed to send message" };
    }

    return { status: "accepted" };
  }

  private async handleQuestionResponse(
    ws: WebSocket,
    data: ChatClientQuestionResponse,
  ): Promise<void> {
    if (!data.questionId || !data.answers || typeof data.answers !== "object") {
      this.emitChatError("Missing questionId or answers");
      return;
    }

    if (this.browserPrompts.answerQuestion(data)) {
      return;
    }

    const answeringUserId =
      this.getSocketChatContext(ws)?.userId ?? this.chatContext?.userId ?? null;
    this.sendRunnerCommand({
      type: "question_response",
      questionId: data.questionId,
      answers: data.answers,
      userId: answeringUserId ?? undefined,
    });
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
    // un-debounced by setChatIsStreaming / completion recording.
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
    // (see setChatIsStreaming / recordThreadAssistantCompletion) flush or
    // discard this pending update so the workspace UI never sticks on
    // "streaming".
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

  private broadcastPreviewState(options?: {
    refreshTabId?: string | null;
  }): void {
    const refreshTabId =
      typeof options?.refreshTabId === "string" && options.refreshTabId
        ? options.refreshTabId
        : null;
    this.broadcastChat({
      type: "preview_state",
      target: this.previewTarget,
      tabs: this.previewTabs,
      activeTabId: this.previewActiveTabId,
      version: this.previewVersion,
      refreshTabId,
    });
  }

  private setChatIsStreaming(
    value: boolean,
    options: { markUnread?: boolean; completedAt?: number; summarySource?: string | null } = {},
  ): void {
    const shouldRecordCompletion =
      !value && options.markUnread === true && this.assistantCompletionRecordedAt === null;
    const shouldRecordCompletionSummary =
      !value &&
      options.markUnread === true &&
      !shouldRecordCompletion &&
      this.assistantCompletionRecordedAt !== null &&
      this.assistantCompletionSummaryRequestedAt !== this.assistantCompletionRecordedAt &&
      typeof options.summarySource === "string" &&
      options.summarySource.trim().length > 0;
    if (
      this.chatIsStreaming === value &&
      !shouldRecordCompletion &&
      !shouldRecordCompletionSummary
    ) {
      return;
    }
    if (value) {
      this.assistantCompletionRecordedAt = null;
      this.assistantCompletionSummaryRequestedAt = null;
    }
    // A turn that stops after asking a browser question is still awaiting user
    // input; keep the automation run active so the eventual answer can finish it.
    if (
      !value &&
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
    const statusChanged = this.chatIsStreaming !== value;
    this.chatIsStreaming = value;
    // Clear persisted todos when a new turn starts so they don't go stale
    // across reconnects. The next TodoWrite will re-persist fresh state.
    if (value && this.currentTodos.length > 0) {
      this.currentTodos = [];
      this.ctx.storage.kv.delete(CHAT_TODOS_KEY);
      this.broadcastChat({ type: "todo_state", todos: [] });
    }
    if (statusChanged) {
      this.broadcastChat({ type: "streaming_state", isStreaming: value });
    }
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
      } else if (statusChanged) {
        this.ctx.waitUntil(
          this.recordWorkspaceThreadStreaming(
            context.workspaceId,
            context.threadId,
            value,
          ).catch((error) => {
            console.error("[ChatThreadDO] failed to record workspace thread status", error);
          }),
        );
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
        this.chatIsStreaming ||
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
        type: "message",
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
    const baselineEventId = this.nextChatEventId - 1;
    this.agentEvalEventCollector = [];
    const contextError = this.updateExternalChatContext(body);
    if (contextError) {
      return await this.agentEvalResult("error", baselineEventId, {
        error: contextError,
      });
    }

    const context = this.chatContext;
    if (!context) {
      return await this.agentEvalResult("error", baselineEventId, {
        error: "Missing chat context for eval",
      });
    }

    const rawContent =
      typeof body.message === "string" ? body.message.trim() : "";
    if (!rawContent) {
      return await this.agentEvalResult("error", baselineEventId, {
        error: "Missing message",
      });
    }

    if (this.chatIsStreaming || this.piSession?.state.isStreaming) {
      return await this.agentEvalResult("busy", baselineEventId, {
        error: "Thread is busy with another run",
      });
    }

    try {
      const orgBan = await isOrgBanned(this.env.APP_KV, {
        orgId: context.orgId,
      });
      if (orgBan) {
        return await this.agentEvalResult("error", baselineEventId, {
          error: "Organization is blocked",
        });
      }

      await this.ensurePiSessionReady();
      if (!this.piSession) {
        return await this.agentEvalResult("error", baselineEventId, {
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
        return await this.agentEvalResult("error", baselineEventId, {
          error: "Empty message",
        });
      }

      this.setActiveTurnUserId(context.userId);
      this.setChatIsStreaming(true);
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
      await this.startPiTurnRecovery(userMessage);
      await this.refreshPiSessionModel();
      await this.withAgentEvalTimeout(
        this.keepAlivePiTurnWhile(async () => {
          if (!this.piSession) {
            throw new Error("Pi session was not available for eval prompt");
          }
          await this.piSession.prompt(userMessage);
        }),
        body.timeoutMs,
      );
      await this.piEventHandlerChain;

      const events = this.chatEventsAfter(baselineEventId);
      const result = this.latestAgentEvalResult(events);
      return await this.agentEvalResult("completed", baselineEventId, {
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
      this.clearPiInFlightMessages();
      this.pushChatEvent(this.piProviderErrorEvent(message));
      this.setChatIsStreaming(false);
      this.setActiveTurnUserId(null);
      return await this.agentEvalResult("error", baselineEventId, {
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

  private chatEventsAfter(eventId: number): Array<Record<string, unknown>> {
    return this.chatEventBuffer.filter((event) => {
      const current =
        typeof event.eventId === "number" && Number.isFinite(event.eventId)
          ? event.eventId
          : 0;
      return current > eventId;
    });
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
    baselineEventId: number,
    options: { error?: string; result?: string } = {},
  ): Promise<AgentEvalSessionResult> {
    const threadId = this.chatContext?.threadId ?? "";
    const events = this.agentEvalEventCollector
      ? [...this.agentEvalEventCollector]
      : this.chatEventsAfter(baselineEventId);
    this.agentEvalEventCollector = null;
    return {
      status,
      ...options,
      events,
      messages: await this.getPiCoreParsedMessages(threadId),
    };
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
    if (hasFirstUserMessage) {
      return;
    }

    await orgStub.setThreadFirstUserMessage(context.threadId, metadataSourceMessage);

    if (!isPlaceholderThreadTitle(thread.title) || this.titleGenerationInFlight) {
      return;
    }

    this.titleGenerationInFlight = true;
    await this.generateThreadTitleFromMessage(context.threadId, titleSourceMessage);
  }

  private async markThreadChannelUsedBestEffort(
    context: { orgId?: string | null; threadId?: string | null },
    channelKind: "email" | "slack" | "telegram",
  ): Promise<void> {
    if (!context.orgId || !context.threadId) return;
    try {
      const orgStub = this.env.ORG.get(this.env.ORG.idFromName(context.orgId));
      await orgStub.recordThreadChannelUsed(context.threadId, channelKind);
    } catch (error) {
      console.error("[ChatThreadDO] failed to record thread channel usage", {
        threadId: context.threadId,
        channelKind,
        error,
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
    const { completeSimple, getModel, streamSimple } = await import("@earendil-works/pi-ai");

    this.piUnsubscribe?.();
    this.piUnsubscribe = null;
    this.piActiveItemId = null;
    this.piAssistantText = "";

    const resolveCurrentModel = () => this.resolvePiModel(context, envVars, getModel);
    const modelConfig = await resolveCurrentModel();
    this.piModelResolver = resolveCurrentModel;
    const persistedMessages = await this.loadPiCoreMessages();
    const initialMessages = [...persistedMessages];
    const inFlight = await this.loadPiInFlightMessages();
    if (inFlight.length > 0) {
      // Leave the in-flight rows in place. They are only released when the
      // next turn_end snapshots the recovery message into main (or when an
      // agent_end failure discards them). Clearing here would lose the
      // recovery data if the DO is evicted again before any turn commits.
      initialMessages.push(this.buildPiRecoveryUserMessage(inFlight));
    }
    this.piMainBaselineIndex = persistedMessages.length;
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
    });
    this.pushChatEvent({ type: "ready" });
    return session;
  }

  private createPiSystemPrompt(context: ChatContextState): string {
    return createPiSystemPrompt(context, {
      skillNames: PI_SKILL_NAMES,
      skillDescriptions: PI_SKILL_DESCRIPTIONS,
    });
  }

  private async getCurrentThreadRecord(
    context: ChatContextState,
  ): Promise<OrgThread> {
    const orgStub = this.env.ORG.get(
      this.env.ORG.idFromName(context.orgId),
    ) as unknown as OrgDO;
    const thread = await orgStub.getThread(context.threadId);
    if (!thread) {
      throw new Error("Thread not found");
    }
    return thread;
  }

  private async getCurrentThreadRecordIfAvailable(
    context: ChatContextState,
  ): Promise<OrgThread | null> {
    if (!context.threadId) return null;
    try {
      return await this.getCurrentThreadRecord(context);
    } catch (error) {
      if (error instanceof Error && error.message === "Thread not found") {
        return null;
      }
      throw error;
    }
  }

  private async getOriginatingChannelThread(
    context: ChatContextState,
    kind: "email" | "slack" | "telegram",
  ): Promise<OrgThread | null> {
    const thread = await this.getCurrentThreadRecordIfAvailable(context);
    if (!thread) return null;
    return thread.source?.trim() === "channel" && thread.channel_kind === kind
      ? thread
      : null;
  }

  private async readEmailThreadReferenceIds(
    context: ChatContextState,
    thread: OrgThread | null,
  ): Promise<string[]> {
    if (!context.threadId) return [];

    let rawReferences: string | null = null;
    try {
      rawReferences = await this.env.APP_KV.get(
        getEmailThreadReferencesKey(context.workspaceId, context.threadId),
      );
    } catch (error) {
      console.error("[send_email] failed to read email thread metadata", {
        orgId: context.orgId,
        workspaceId: context.workspaceId,
        threadId: context.threadId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }

    if (rawReferences) {
      try {
        const parsed = JSON.parse(rawReferences);
        if (Array.isArray(parsed)) {
          const ids = appendEmailThreadReferenceIds(
            parsed.filter((value): value is string => typeof value === "string"),
          );
          if (ids.length > 0) return ids;
        }
      } catch {
        // Ignore malformed KV data and fall back to real channel metadata.
      }
    }

    if (
      thread?.source?.trim() !== "channel" ||
      thread.channel_kind !== "email" ||
      !thread.channel_message_id
    ) {
      return [];
    }
    return appendEmailThreadReferenceIds([], thread?.channel_message_id);
  }

  private readChannelAttachmentInputs(
    raw: Record<string, unknown>,
  ): ChannelToolAttachmentInput[] {
    const value = raw.attachments;
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) {
      throw new Error("attachments must be an array");
    }
    if (value.length > 10) {
      throw new Error("At most 10 attachments can be sent at once");
    }
    return value.map((entry, index) => {
      if (!entry || typeof entry !== "object") {
        throw new Error(`attachments[${index}] must be an object`);
      }
      const candidate = entry as Record<string, unknown>;
      const path =
        typeof candidate.path === "string" ? candidate.path.trim() : "";
      if (!path) {
        throw new Error(`attachments[${index}].path is required`);
      }
      return {
        path,
        filename:
          typeof candidate.filename === "string" &&
          candidate.filename.trim()
            ? candidate.filename.trim()
            : undefined,
        content_type:
          typeof candidate.content_type === "string" &&
          candidate.content_type.trim()
            ? candidate.content_type.trim()
            : undefined,
        caption:
          typeof candidate.caption === "string" && candidate.caption.trim()
            ? candidate.caption.trim()
            : undefined,
        send_as:
          typeof candidate.send_as === "string" && candidate.send_as.trim()
            ? candidate.send_as.trim().toLowerCase()
            : undefined,
      };
    });
  }

  private async resolveChannelOutboundAttachments(
    context: ChatContextState,
    raw: Record<string, unknown>,
  ): Promise<ResolvedChannelAttachment[]> {
    const inputs = this.readChannelAttachmentInputs(raw);
    const attachments: ResolvedChannelAttachment[] = [];
    let totalBytes = 0;

    for (const input of inputs) {
      const attachment = await this.resolveChannelOutboundAttachment(
        context,
        input,
      );
      totalBytes += attachment.size;
      if (totalBytes > MAX_CHANNEL_OUTBOUND_ATTACHMENT_BYTES) {
        throw new Error("Total attachment size must be 25 MB or less");
      }
      attachments.push(attachment);
    }

    return attachments;
  }

  private async resolveChannelOutboundAttachment(
    context: ChatContextState,
    input: ChannelToolAttachmentInput,
  ): Promise<ResolvedChannelAttachment> {
    const resolved = this.resolveMountedAttachmentPath(input.path);
    if (!resolved) {
      throw new Error(
        "attachments[].path must start with uploads/ or outputs/",
      );
    }

    const key = buildWorkspaceScopedR2Key(
      context.orgId,
      context.workspaceId,
      `${resolved.bucketDir}/${resolved.relativePath}`,
    );
    const object = await this.env.R2_BUCKET.get(key);
    if (!object) {
      throw new Error(`Attachment not found: ${input.path}`);
    }
    if (
      typeof object.size === "number" &&
      object.size > MAX_CHANNEL_OUTBOUND_ATTACHMENT_BYTES
    ) {
      throw new Error("Attachment size must be 25 MB or less");
    }

    const content = await object.arrayBuffer();
    if (content.byteLength > MAX_CHANNEL_OUTBOUND_ATTACHMENT_BYTES) {
      throw new Error("Attachment size must be 25 MB or less");
    }
    const filename =
      input.filename ||
      resolved.relativePath.split("/").filter(Boolean).pop() ||
      "attachment";
    const contentType =
      input.content_type ||
      object.httpMetadata?.contentType ||
      this.inferContentType(filename);

    return {
      path: input.path,
      filename: this.sanitizeAttachmentFilename(filename),
      contentType,
      content,
      size: object.size || content.byteLength,
      caption: input.caption,
      sendAs: input.send_as,
    };
  }

  private resolveMountedAttachmentPath(path: string): {
    bucketDir: "user-uploads" | "user-outputs";
    relativePath: string;
  } | null {
    const normalized = path.trim().replace(/\\/g, "/");
    const prefixes: Array<{
      prefix: string;
      bucketDir: "user-uploads" | "user-outputs";
    }> = [
      { prefix: "uploads/", bucketDir: "user-uploads" },
      { prefix: "outputs/", bucketDir: "user-outputs" },
    ];
    for (const { prefix, bucketDir } of prefixes) {
      if (!normalized.startsWith(prefix)) continue;
      const relativePath = normalized.slice(prefix.length);
      if (
        !relativePath ||
        relativePath.startsWith("/") ||
        relativePath.split("/").some((part) => part === ".." || part === "")
      ) {
        return null;
      }
      return { bucketDir, relativePath };
    }
    return null;
  }

  private sanitizeAttachmentFilename(filename: string): string {
    const base = filename.split(/[\\/]/).filter(Boolean).pop() || "attachment";
    const sanitized = base.replace(/[\r\n"]/g, "_").slice(0, 180).trim();
    return sanitized || "attachment";
  }

  private inferContentType(filename: string): string {
    const ext = filename.toLowerCase().split(".").pop() || "";
    const map: Record<string, string> = {
      csv: "text/csv",
      gif: "image/gif",
      html: "text/html",
      jpeg: "image/jpeg",
      jpg: "image/jpeg",
      json: "application/json",
      md: "text/markdown",
      pdf: "application/pdf",
      png: "image/png",
      txt: "text/plain",
      webp: "image/webp",
      xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      zip: "application/zip",
    };
    return map[ext] || "application/octet-stream";
  }

  async sendChannelEmailTool(
    context: ChatContextState,
    params: unknown,
  ): Promise<AgentToolResult<unknown>> {
    const orgStub = this.env.ORG.get(
      this.env.ORG.idFromName(context.orgId),
    ) as unknown as OrgDO;
    const orgInfo = await orgStub.getInfo();
    if (
      !orgInfo ||
      !getBillingPlanLimits(orgInfo.billing_plan, orgInfo.billing_status)
        .emailInbox
    ) {
      throw new Error(
        "Workspace email inbox requires a Starter, Pro, Team, or Enterprise plan.",
      );
    }

    const currentThread = await this.getCurrentThreadRecordIfAvailable(context);
    const originatingEmailThread =
      currentThread?.source?.trim() === "channel" &&
      currentThread.channel_kind === "email"
        ? currentThread
        : null;
    const raw = this.readToolObjectParams(params);
    const to = this.requiredToolString(raw, "to");
    const subject = this.requiredToolString(raw, "subject");
    const text = this.optionalToolString(raw, "text");
    const html = this.optionalToolString(raw, "html");
    const attachments = await this.resolveChannelOutboundAttachments(
      context,
      raw,
    );
    if (!text && !html && attachments.length === 0) {
      throw new Error("send_email requires text, html, or attachments");
    }

    if (!this.env.EMAIL) {
      throw new Error("Cloudflare Email Sending binding EMAIL is not configured");
    }
    const fallbackFrom = originatingEmailThread?.channel_connection_id?.trim() || "";
    let from = fallbackFrom;
    const emailDomain = getWorkspaceEmailDomain(this.env);
    const workspaceInfo = await orgStub.getWorkspaceRecord(context.workspaceId);
    const emailHandle = workspaceInfo?.email_handle?.trim();
    if (emailDomain && emailHandle) {
      from = buildWorkspaceEmailSenderAddress(
        emailHandle,
        emailDomain,
      );
    } else if (!from) {
      if (!emailDomain) {
        throw new Error("Workspace email domain is not configured");
      }
      throw new Error("Workspace email sender is not configured");
    }

    const explicitReplyTo = this.optionalToolString(raw, "reply_to");
    const replyTo = explicitReplyTo || originatingEmailThread?.channel_connection_id || undefined;
    const emailReferenceIds = currentThread
      ? await this.readEmailThreadReferenceIds(context, currentThread)
      : [];
    const emailReplyHeaders = emailReferenceIds.length > 0
      ? buildEmailReplyHeaders({
          inReplyToMessageId: emailReferenceIds.at(-1),
          referenceMessageIds: emailReferenceIds,
        })
      : undefined;
    const body: Parameters<CloudflareEmailSender["send"]>[0] = {
      from,
      to,
      subject,
    };
    if (text) body.text = text;
    if (html) body.html = html;
    if (replyTo) body.replyTo = replyTo;
    if (emailReplyHeaders) body.headers = emailReplyHeaders;
    if (attachments.length > 0) {
      body.attachments = attachments.map((attachment) => ({
        content: attachment.content,
        filename: attachment.filename,
        type: attachment.contentType,
        disposition: "attachment",
      }));
    }
    const response = await this.env.EMAIL.send(body);
    if (response.messageId) {
      const nextReferenceIds = appendEmailThreadReferenceIds(
        emailReferenceIds,
        response.messageId,
      );
      await Promise.all([
        this.env.APP_KV.put(
          getEmailReplyReferenceKey(context.workspaceId, response.messageId),
          context.threadId,
          { expirationTtl: EMAIL_REPLY_REFERENCE_TTL_SECONDS },
        ),
        currentThread && nextReferenceIds.length > 0
          ? this.env.APP_KV.put(
              getEmailThreadReferencesKey(context.workspaceId, context.threadId),
              JSON.stringify(nextReferenceIds),
              { expirationTtl: EMAIL_REPLY_REFERENCE_TTL_SECONDS },
            )
          : Promise.resolve(),
      ]).catch((error) => {
        console.error("[send_email] failed to persist email thread metadata", {
          orgId: context.orgId,
          workspaceId: context.workspaceId,
          threadId: context.threadId,
          messageId: response.messageId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    await this.markThreadChannelUsedBestEffort(context, "email");

    return {
      content: [{ type: "text", text: "Email sent." }],
      details: {
        status: "sent",
        channel: "email",
        provider: "cloudflare_email",
        messageId: response.messageId,
        attachmentCount: attachments.length,
      },
    };
  }

  async sendChannelSlackMessageTool(
    context: ChatContextState,
    params: unknown,
  ): Promise<AgentToolResult<unknown>> {
    const thread = await this.getOriginatingChannelThread(context, "slack");
    const raw = this.readToolObjectParams(params);
    const text = this.optionalToolString(raw, "text");
    const attachments = await this.resolveChannelOutboundAttachments(
      context,
      raw,
    );
    if (!text && attachments.length === 0) {
      throw new Error("send_slack_message requires text or attachments");
    }

    const explicitChannelId = this.optionalToolString(raw, "channel_id");
    const explicitThreadTs = this.optionalToolString(raw, "thread_ts");
    const threadConversation = thread?.channel_conversation_id
      ? this.parseSlackChannelConversation(thread.channel_conversation_id)
      : null;
    const conversation = explicitChannelId
      ? {
          teamId: this.optionalToolString(raw, "team_id") || threadConversation?.teamId || "",
          channelId: explicitChannelId,
          rootTs: explicitThreadTs || "dm",
        }
      : threadConversation;
    if (!conversation?.channelId) {
      throw new Error("Slack channel_id is required outside Slack-originated threads");
    }

    const explicitIntegrationId = this.optionalToolString(raw, "integration_id");
    const explicitTeamId = this.optionalToolString(raw, "team_id") || conversation.teamId;
    const integrationId = explicitIntegrationId || thread?.channel_connection_id?.trim() || "";
    const orgStub = this.getOrgStub(context.orgId);
    const integrations = integrationId
      ? []
      : await orgStub.getWorkspaceIntegrations(context.workspaceId);
    const slackIntegrations = integrations.filter((candidate) => candidate.integration_type === "slack");
    if (!integrationId && slackIntegrations.length === 0) {
      throw new Error("Slack integration_id is required because no Slack connection is available");
    }
    if (!integrationId && slackIntegrations.length > 1 && !explicitTeamId) {
      throw new Error("Multiple Slack integrations are available; provide integration_id or team_id");
    }

    const candidates = integrationId
      ? [await orgStub.getWorkspaceIntegration(context.workspaceId, integrationId)]
      : slackIntegrations;
    let selected: {
      integration: Awaited<ReturnType<OrgDO["getWorkspaceIntegration"]>>;
      credentials: Record<string, unknown>;
    } | null = null;
    for (const candidate of candidates) {
      if (!candidate || candidate.integration_type !== "slack") continue;
      const credentials = await decryptCredentials<Record<string, unknown>>(
        candidate.credentials_encrypted,
        this.env.INTEGRATION_SECRET_KEY,
      );
      const credentialTeamId = typeof credentials.team_id === "string"
        ? credentials.team_id.trim()
        : "";
      if (explicitTeamId && credentialTeamId && credentialTeamId !== explicitTeamId) {
        continue;
      }
      selected = { integration: candidate, credentials };
      break;
    }
    if (!selected) {
      throw new Error(
        explicitTeamId
          ? `Slack integration is no longer available for team ${explicitTeamId}`
          : "Slack integration is no longer available",
      );
    }
    const { credentials } = selected;
    const token =
      typeof credentials.access_token === "string"
        ? credentials.access_token.trim()
        : "";
    if (!token) {
      throw new Error("Slack access token is not configured");
    }

    let responseJson: {
      ok?: boolean;
      error?: string;
      ts?: string;
      files?: Array<{ id?: string }>;
    } | null;
    if (attachments.length > 0) {
      responseJson = await this.uploadSlackAttachments({
        token,
        channelId: conversation.channelId,
        threadTs: conversation.rootTs && conversation.rootTs !== "dm" ? conversation.rootTs : undefined,
        text,
        attachments,
      });
    } else {
      const response = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          channel: conversation.channelId,
          thread_ts: conversation.rootTs && conversation.rootTs !== "dm" ? conversation.rootTs : undefined,
          text,
        }),
      });
      responseJson = await response.json().catch(() => null) as {
        ok?: boolean;
        error?: string;
        ts?: string;
      } | null;
      if (!response.ok || responseJson?.ok !== true) {
        throw new Error(
          `Slack send failed: ${responseJson?.error || response.statusText}`,
        );
      }
    }
    await this.markThreadChannelUsedBestEffort(context, "slack");

    return {
      content: [{ type: "text", text: "Slack message sent." }],
      details: {
        status: "sent",
        channel: "slack",
        teamId: conversation.teamId,
        channelId: conversation.channelId,
        ts: responseJson.ts,
        attachmentCount: attachments.length,
        fileIds: responseJson.files?.map((file) => file.id).filter(Boolean),
      },
    };
  }

  async sendChannelTelegramMessageTool(
    context: ChatContextState,
    params: unknown,
  ): Promise<AgentToolResult<unknown>> {
    const thread = await this.getOriginatingChannelThread(context, "telegram");
    const token = this.env.TELEGRAM_BOT_TOKEN?.trim();
    if (!token) {
      throw new Error("Telegram channel is not configured");
    }
    const raw = this.readToolObjectParams(params);
    const text = this.optionalToolString(raw, "text");
    const attachments = await this.resolveChannelOutboundAttachments(
      context,
      raw,
    );
    if (!text && attachments.length === 0) {
      throw new Error("send_telegram_message requires text or attachments");
    }
    const explicitChatId = this.optionalToolString(raw, "chat_id");
    let integrationId = this.optionalToolString(raw, "integration_id");
    let chatId = thread?.channel_conversation_id?.trim() || "";
    let telegramIntegrationId = thread?.channel_connection_id?.trim() || "";
    let telegramTitle = thread?.title || "Telegram chat";
    let recordChannelHistory = false;
    if (!chatId) {
      const orgStub = this.getOrgStub(context.orgId);
      if (!integrationId) {
        const integrations = await orgStub.getWorkspaceIntegrations(
          context.workspaceId,
        );
        const connectedTelegramIntegrations = integrations.filter((candidate) => {
          if (candidate.integration_type !== "telegram") return false;
          try {
            const config = JSON.parse(candidate.config || "{}") as Record<string, unknown>;
            return typeof config.chat_id === "string" && config.chat_id.trim().length > 0;
          } catch {
            return false;
          }
        });
        if (connectedTelegramIntegrations.length === 0) {
          throw new Error(
            "No connected Telegram integrations are available. Ask the user to connect Telegram first.",
          );
        }
        if (connectedTelegramIntegrations.length > 1) {
          throw new Error(
            "Multiple Telegram integrations are available. Call tools.list_integrations({}) and pass the desired Telegram integration id as integration_id.",
          );
        }
        integrationId = connectedTelegramIntegrations[0].id;
      }
      if (!integrationId) {
        throw new Error("Telegram integration_id is required");
      }
      const integration = await orgStub.getWorkspaceIntegration(
        context.workspaceId,
        integrationId,
      );
      if (!integration || integration.integration_type !== "telegram") {
        throw new Error("Telegram integration is no longer available");
      }
      const config = JSON.parse(integration.config || "{}") as Record<string, unknown>;
      const configuredChatId = typeof config.chat_id === "string"
        ? config.chat_id.trim()
        : "";
      if (!configuredChatId) {
        throw new Error("Telegram integration is not connected to a chat");
      }
      if (explicitChatId && explicitChatId !== configuredChatId) {
        throw new Error(
          "Telegram chat_id does not match the configured workspace integration",
        );
      }
      chatId = configuredChatId;
      telegramIntegrationId = integrationId;
      telegramTitle =
        (typeof config.chat_title === "string" && config.chat_title.trim()) ||
        integration.name ||
        "Telegram chat";
      recordChannelHistory = true;
    } else if (explicitChatId && explicitChatId !== chatId) {
      throw new Error("Telegram chat_id does not match the originating conversation");
    }

    const sentMessageIds: Array<number | undefined> = [];
    if (text) {
      const formatted = formatMarkdownForTelegram(text);
      const response = await this.fetchTelegramBotApi(token, "sendMessage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: formatted.text,
          parse_mode: formatted.parseMode,
        }),
      });
      const responseJson = await response.json().catch(() => null) as {
        ok?: boolean;
        description?: string;
        result?: { message_id?: number };
      } | null;
      if (!response.ok || responseJson?.ok !== true) {
        throw new Error(
          `Telegram send failed: ${responseJson?.description || response.statusText}`,
        );
      }
      sentMessageIds.push(responseJson.result?.message_id);
    }

    for (const attachment of attachments) {
      const responseJson = await this.sendTelegramAttachment({
        token,
        chatId,
        attachment,
      });
      sentMessageIds.push(responseJson.result?.message_id);
    }

    const channelHistoryStatus = await this.recordTelegramOutboundHistory(context, {
      chatId,
      integrationId: telegramIntegrationId,
      title: telegramTitle,
      recordHistory: recordChannelHistory,
      text: text || undefined,
      sentMessageIds,
      attachmentCount: attachments.length,
    }).catch((error) => {
      console.error("[ChatThreadDO] failed to record Telegram outbound history", error);
      return "error" as const;
    });
    await this.markThreadChannelUsedBestEffort(context, "telegram");

    return {
      content: [{ type: "text", text: "Telegram message sent." }],
      details: {
        status: "sent",
        channel: "telegram",
        chatId,
        integrationId: telegramIntegrationId || undefined,
        messageId: sentMessageIds[0],
        messageIds: sentMessageIds,
        attachmentCount: attachments.length,
        channelHistoryStatus,
      },
    };
  }

  private async recordTelegramOutboundHistory(
    context: ChatContextState,
    args: {
      chatId: string;
      integrationId: string;
      title: string;
      recordHistory: boolean;
      text?: string;
      sentMessageIds: Array<number | undefined>;
      attachmentCount: number;
    },
  ): Promise<"recorded" | "skipped"> {
    if (!args.recordHistory || !args.integrationId) return "skipped";
    const firstProviderMessageId = args.sentMessageIds
      .map((id) => (id === undefined ? "" : String(id)))
      .find(Boolean);
    const thread = await getOrCreateChannelThread(
      this.env as Parameters<typeof getOrCreateChannelThread>[0],
      {
        kind: "telegram",
        workspaceId: context.workspaceId,
        orgId: context.orgId,
        connectionId: args.integrationId,
        remoteConversationId: args.chatId,
        title: args.title,
        createdBy: "telegram",
        firstUserMessage:
          args.text?.trim() ||
          (args.attachmentCount > 0 ? "Outbound Telegram attachment sent." : null),
        firstRemoteMessageId: firstProviderMessageId
          ? `outbound:${firstProviderMessageId}`
          : undefined,
      },
    );
    if (thread.threadId === context.threadId) return "skipped";

    const stub = this.env.CHAT_THREAD.get(
      this.env.CHAT_THREAD.idFromName(thread.threadId),
    ) as unknown as {
      appendChannelHistoryEvent: (
        input: ChannelHistoryEventRequest,
      ) => Promise<ChannelHistoryEventResult> | ChannelHistoryEventResult;
    };
    const result = await stub.appendChannelHistoryEvent({
      threadId: thread.threadId,
      workspaceId: context.workspaceId,
      orgId: context.orgId,
      channelKind: "telegram",
      connectionId: args.integrationId,
      remoteConversationId: args.chatId,
      sourceThreadId: context.threadId,
      direction: "outbound",
      text: args.text,
      providerMessageIds: args.sentMessageIds,
      attachmentCount: args.attachmentCount,
      sentAt: Date.now(),
    });
    if (result.status === "error") {
      throw new Error(result.error || "Failed to record Telegram channel history");
    }
    return result.status === "appended" ? "recorded" : "skipped";
  }

  private async fetchTelegramBotApi(
    token: string,
    method: string,
    init: RequestInit,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TELEGRAM_BOT_API_TIMEOUT_MS);
    try {
      return await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        ...init,
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(
          `Telegram ${method} request timed out after ${TELEGRAM_BOT_API_TIMEOUT_MS}ms`,
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async uploadSlackAttachments(args: {
    token: string;
    channelId: string;
    threadTs?: string;
    text: string | null;
    attachments: ResolvedChannelAttachment[];
  }): Promise<{ ts?: string; files?: Array<{ id?: string }> }> {
    const files: Array<{ id: string; title: string }> = [];
    for (const attachment of args.attachments) {
      const uploadUrlResponse = await fetch(
        "https://slack.com/api/files.getUploadURLExternal",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${args.token}`,
            "Content-Type": "application/json; charset=utf-8",
          },
          body: JSON.stringify({
            filename: attachment.filename,
            length: attachment.size,
          }),
        },
      );
      const uploadUrlJson = await uploadUrlResponse.json().catch(() => null) as {
        ok?: boolean;
        error?: string;
        upload_url?: string;
        file_id?: string;
      } | null;
      if (
        !uploadUrlResponse.ok ||
        uploadUrlJson?.ok !== true ||
        !uploadUrlJson.upload_url ||
        !uploadUrlJson.file_id
      ) {
        throw new Error(
          `Slack file upload URL failed: ${uploadUrlJson?.error || uploadUrlResponse.statusText}`,
        );
      }

      const uploadResponse = await fetch(uploadUrlJson.upload_url, {
        method: "POST",
        headers: { "Content-Type": attachment.contentType },
        body: attachment.content,
      });
      if (!uploadResponse.ok) {
        throw new Error(
          `Slack file upload failed: ${uploadResponse.status} ${uploadResponse.statusText}`,
        );
      }
      files.push({
        id: uploadUrlJson.file_id,
        title: attachment.filename,
      });
    }

    const completeResponse = await fetch(
      "https://slack.com/api/files.completeUploadExternal",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${args.token}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          files,
          channel_id: args.channelId,
          ...(args.threadTs ? { thread_ts: args.threadTs } : {}),
          ...(args.text ? { initial_comment: args.text } : {}),
        }),
      },
    );
    const completeJson = await completeResponse.json().catch(() => null) as {
      ok?: boolean;
      error?: string;
      ts?: string;
      files?: Array<{ id?: string }>;
    } | null;
    if (!completeResponse.ok || completeJson?.ok !== true) {
      throw new Error(
        `Slack file upload completion failed: ${completeJson?.error || completeResponse.statusText}`,
      );
    }
    return completeJson;
  }

  private isTelegramPhotoAttachment(attachment: ResolvedChannelAttachment): boolean {
    if (attachment.sendAs === "document") return false;
    if (attachment.sendAs === "photo") return true;
    const contentType = attachment.contentType.toLowerCase().split(";")[0]?.trim();
    if (contentType === "image/jpeg" || contentType === "image/png") {
      return true;
    }
    // Telegram Bot API sendPhoto accepts JPEG/PNG-style photos. Avoid sending
    // formats such as SVG/GIF/WebP as photos because they have separate Bot API
    // methods or may be rejected; keep those as documents for reliability.
    const filename = attachment.filename.toLowerCase();
    return filename.endsWith(".jpg") ||
      filename.endsWith(".jpeg") ||
      filename.endsWith(".png");
  }

  private async sendTelegramAttachment(args: {
    token: string;
    chatId: string;
    attachment: ResolvedChannelAttachment;
  }): Promise<{ result?: { message_id?: number } }> {
    const asPhoto = this.isTelegramPhotoAttachment(args.attachment);
    try {
      return await this.sendTelegramMultipart({
        ...args,
        method: asPhoto ? "sendPhoto" : "sendDocument",
        fieldName: asPhoto ? "photo" : "document",
        errorLabel: asPhoto ? "photo" : "document",
      });
    } catch (error) {
      if (!asPhoto || args.attachment.sendAs === "photo") throw error;
      console.warn("[ChatThreadDO] Telegram photo send failed; retrying as document", {
        filename: args.attachment.filename,
        error: error instanceof Error ? error.message : String(error),
      });
      return this.sendTelegramMultipart({
        ...args,
        method: "sendDocument",
        fieldName: "document",
        errorLabel: "document",
      });
    }
  }

  private async sendTelegramMultipart(args: {
    token: string;
    chatId: string;
    attachment: ResolvedChannelAttachment;
    method: "sendPhoto" | "sendDocument";
    fieldName: "photo" | "document";
    errorLabel: "photo" | "document";
  }): Promise<{ result?: { message_id?: number } }> {
    const formData = new FormData();
    formData.set("chat_id", args.chatId);
    if (args.attachment.caption) {
      const formattedCaption = formatMarkdownForTelegram(
        args.attachment.caption.slice(0, 1024),
      );
      formData.set("caption", formattedCaption.text);
      formData.set("parse_mode", formattedCaption.parseMode);
    }
    formData.set(
      args.fieldName,
      new Blob([args.attachment.content], {
        type: args.attachment.contentType,
      }),
      args.attachment.filename,
    );

    const response = await this.fetchTelegramBotApi(args.token, args.method, {
      method: "POST",
      body: formData,
    });
    const responseJson = await response.json().catch(() => null) as {
      ok?: boolean;
      description?: string;
      result?: { message_id?: number };
    } | null;
    if (!response.ok || responseJson?.ok !== true) {
      throw new Error(
        `Telegram ${args.errorLabel} send failed: ${responseJson?.description || response.statusText}`,
      );
    }
    return responseJson;
  }

  private readToolObjectParams(params: unknown): Record<string, unknown> {
    return params && typeof params === "object"
      ? params as Record<string, unknown>
      : {};
  }

  private requiredToolString(
    params: Record<string, unknown>,
    key: string,
  ): string {
    const value = this.optionalToolString(params, key);
    if (!value) {
      throw new Error(`${key} is required`);
    }
    return value;
  }

  private optionalToolString(
    params: Record<string, unknown>,
    key: string,
  ): string | null {
    const value = params[key];
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  private parseSlackChannelConversation(value: string | null): {
    teamId: string;
    channelId: string;
    rootTs: string;
  } {
    const parts = value?.split(":") ?? [];
    const [teamId, channelId, ...rest] = parts;
    const rootTs = rest.join(":");
    if (!teamId || !channelId || !rootTs) {
      throw new Error("Slack thread is missing channel routing metadata");
    }
    return { teamId, channelId, rootTs };
  }

  private async compactPiContext(
    messages: AgentMessage[],
    model: Model<any>,
    apiKey: string,
    completeSimple: typeof import("@earendil-works/pi-ai").completeSimple,
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

  private async loadPiCompleteSimple(): Promise<typeof import("@earendil-works/pi-ai").completeSimple> {
    const { completeSimple } = await import("@earendil-works/pi-ai");
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
    completeSimple: typeof import("@earendil-works/pi-ai").completeSimple,
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
    completeSimple: typeof import("@earendil-works/pi-ai").completeSimple,
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
    const response =
      model.api === "bedrock-converse-stream"
        ? await bedrockProviderModule
            .streamBedrock(
              model,
              summaryContext,
              this.buildBedrockByokOptions(model, summaryOptions),
            )
            .result()
        : await completeSimple(
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
    const modelId = this.normalizePiModelId(requestedModelId);
    const resolved = this.resolvePiModelReference(modelId);
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
          (configured.modelLookupProvider === "amazon-bedrock"
            ? resolveBedrockModelFallback(
                configured.modelLookupModelId ?? configured.requestModelId,
              )
            : resolvePiModelCatalogFallback({
                provider: configured.modelLookupProvider,
                modelId: configured.modelLookupModelId ?? configured.requestModelId,
                hostedGatewayProvider: resolved.hostedGatewayProvider,
              }))
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
    const resolvedModel = {
      ...modelBase,
      api: configured.api ?? resolved.api ?? modelBase.api,
      id: configured.requestModelId ?? modelBase.id,
      provider: configured.requestProvider ?? modelBase.provider,
      baseUrl: configured.baseUrl || modelBase.baseUrl,
      headers: {
        ...(modelBase.headers ?? {}),
        ...(configured.headers ?? {}),
      },
    } as Model<any>;
    return {
      model:
        resolvedModel.api === "bedrock-converse-stream"
          ? withBedrockModelMetadata(resolvedModel as Model<"bedrock-converse-stream">)
          : resolvedModel,
      apiKey: configured.apiKey,
      headers: configured.headers,
      provider: resolved.provider,
      modelId: resolved.modelId,
      billingSource: configured.billingSource,
      creditChargeable: configured.creditChargeable,
      usageProvider,
    };
  }

  private resolvePiModelReference(modelId: string): PiResolvedModelReference {
    const normalizedModelId = this.normalizePiModelId(modelId);
    const claudeReference = (resolvedModelId: string): PiResolvedModelReference => ({
      provider: "anthropic",
      modelId: resolvedModelId,
      hostedGatewayProvider: "openrouter",
      hostedModelId: this.openRouterNitroModel(this.openRouterClaudeModel(resolvedModelId)),
    });
    const openRouterReference = (resolvedModelId: string): PiResolvedModelReference => ({
      provider: "openrouter",
      modelId: resolvedModelId,
      hostedGatewayProvider: "openrouter",
      hostedModelId: this.openRouterNitroModel(resolvedModelId),
    });
    const openRouterResponsesReference = (resolvedModelId: string): PiResolvedModelReference => ({
      ...openRouterReference(resolvedModelId),
      api: "openai-responses",
    });
    const openAiReference = (resolvedModelId: string): PiResolvedModelReference => ({
      provider: "openai",
      modelId: resolvedModelId,
      hostedGatewayProvider: "openrouter",
      hostedModelId: this.openRouterNitroModel(`openai/${resolvedModelId}`),
    });
    switch (normalizedModelId) {
      case "haiku":
        return claudeReference("claude-haiku-4-5-20251001");
      case "opus":
      case "opus-4.7":
      case "opus-4.8":
        return claudeReference("claude-opus-4-8");
      case "sonnet":
        return claudeReference("claude-sonnet-4-6");
      case "gpt-5.4-mini":
      case "gpt-5.4":
      case "gpt-5.5":
        return openAiReference(normalizedModelId);
      case "custom":
        return openAiReference("gpt-5.4");
      case "kimi-k2.7-code":
        return openRouterReference("moonshotai/kimi-k2.7-code");
      case "grok-4.3":
        return openRouterResponsesReference("x-ai/grok-4.3");
      case "gemini-3.5-flash":
        return openRouterReference("google/gemini-3.5-flash");
      case "gemini-3-flash-preview":
        return openRouterReference("google/gemini-3-flash-preview");
      case "gemini-3.1-pro-preview":
        return openRouterReference("google/gemini-3.5-flash");
      case "deepseek-v4-pro":
        return openRouterReference("deepseek/deepseek-v4-pro");
      case "deepseek-v4-flash":
        return openRouterReference("deepseek/deepseek-v4-flash");
      default:
        if (normalizedModelId.includes("/")) {
          return openRouterReference(normalizedModelId);
        }
        return openAiReference("gpt-5.5");
    }
  }

  private normalizePiModelId(modelId: string): string {
    const trimmed = modelId.trim();
    const normalized = trimmed.replace(/^(claude|codex)\//, "");
    const lower = normalized.toLowerCase();
    if (lower === "fable-5" || lower === "claude-fable-5") {
      return "sonnet";
    }
    if (
      lower === "kimi-k2.6" ||
      lower === "kimi-latest" ||
      lower === "~moonshotai/kimi-latest" ||
      lower === "moonshotai/kimi-latest" ||
      lower === "moonshotai/kimi-k2.6"
    ) {
      return "kimi-k2.7-code";
    }
    return normalized;
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
    if (byok?.provider === "custom" && byok.apiKey && byok.baseUrl && byok.api) {
      const customModel = this.resolveCustomProviderModelReference(
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
        headers: this.customProviderAuthHeaders(byok.api, byok.authType ?? "bearer", byok.apiKey),
      };
    }
    if (byok?.provider === "openrouter" && byok.apiKey) {
      return {
        apiKey: byok.apiKey,
        billingSource: "byok",
        creditChargeable: false,
        usageProvider: "openrouter",
        requestModelId: resolved.hostedModelId,
        headers: {
          ...this.openRouterAttributionHeaders(),
          ...(resolved.provider === "anthropic"
            ? { Authorization: `Bearer ${byok.apiKey}` }
            : {}),
        },
        baseUrl: resolved.provider === "anthropic"
          ? "https://openrouter.ai/api"
          : "https://openrouter.ai/api/v1",
      };
    }
    if (byok?.provider === "bedrock" && byok.apiKey && resolved.provider === "anthropic") {
      return {
        apiKey: byok.apiKey,
        billingSource: "byok",
        creditChargeable: false,
        requestProvider: "amazon-bedrock",
        requestModelId: this.bedrockClaudeModel(resolved.modelId),
        modelLookupProvider: "amazon-bedrock",
        baseUrl: this.bedrockRuntimeBaseUrl(byok.awsRegion),
        usageProvider: "bedrock",
      };
    }
    if (byok?.provider === "bedrock" && byok.apiKey && resolved.provider === "openai") {
      const bedrockOpenAi = this.bedrockOpenAiModelConfig(resolved.modelId, byok.awsRegion);
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
    if (byok?.provider === resolved.provider && byok.apiKey) {
      return {
        apiKey: byok.apiKey,
        billingSource: "byok",
        creditChargeable: false,
        usageProvider: resolved.provider,
      };
    }

    const creditChargeable = await this.checkHostedPiModelAccess(context);
    const accountId = this.env.CF_ACCOUNT_ID?.trim();
    const gatewayName = this.env.CF_GATEWAY_NAME?.trim();
    const token = this.env.AI_GATEWAY_AUTH_TOKEN?.trim() || this.env.CF_GATEWAY_TOKEN?.trim();
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
          ? this.openRouterAttributionHeaders()
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

  private openRouterAttributionHeaders(): Record<string, string> {
    return {
      "HTTP-Referer": "https://camelai.dev",
      "X-OpenRouter-Title": "camelAI",
      "X-OpenRouter-Categories": "cloud-agent,programming-app",
    };
  }

  private customProviderAuthHeaders(
    api: "openai-completions" | "openai-responses" | "anthropic-messages",
    authType: "bearer" | "x-api-key",
    apiKey: string,
  ): Record<string, PiHeaderValue> | undefined {
    if (api === "anthropic-messages") {
      return authType === "bearer"
        ? { "x-api-key": null, Authorization: `Bearer ${apiKey}` }
        : undefined;
    }

    return authType === "x-api-key"
      ? { Authorization: null, "x-api-key": apiKey }
      : undefined;
  }

  private resolveCustomProviderModelReference(
    api: "openai-completions" | "openai-responses" | "anthropic-messages",
    requestedModelId: string,
    customModelId: string | undefined,
  ): { provider: string; lookupModelId: string; requestModelId: string } {
    const model = normalizeLlmModel(this.normalizePiModelId(requestedModelId), "custom", {
      customApi: api,
      customModelId,
    });
    if (model === "custom" && customModelId?.trim()) {
      const lookupModel =
        api === "anthropic-messages" ? DEFAULT_LLM_MODEL : "gpt-5.4";
      const lookupReference = this.resolvePiModelReference(lookupModel);
      return {
        provider: lookupReference.provider,
        lookupModelId: lookupReference.modelId,
        requestModelId: customModelId.trim(),
      };
    }
    const reference = this.resolvePiModelReference(model);
    return {
      provider: reference.provider,
      lookupModelId: reference.modelId,
      requestModelId: reference.modelId,
    };
  }

  private openRouterClaudeModel(model: string): string {
    switch (model.trim().toLowerCase()) {
      case "sonnet":
        return "anthropic/claude-sonnet-4.6";
      case "haiku":
        return "anthropic/claude-haiku-4.5";
      case "opus":
      case "opus-4.7":
      case "opus-4.8":
      case "claude-opus-4-8":
      case "claude-opus-4.8":
      case "claude-opus-4-7":
      case "claude-opus-4.7":
      case "claude-opus-4-6":
      case "claude-opus-4.6":
        return "anthropic/claude-opus-4.8";
      case "claude-sonnet-4-6":
        return "anthropic/claude-sonnet-4.6";
      case "claude-sonnet-4-5-20250929":
        return "anthropic/claude-sonnet-4.5";
      case "claude-haiku-4-5-20251001":
        return "anthropic/claude-haiku-4.5";
      case "claude-opus-4-5-20251101":
        return "anthropic/claude-opus-4.5";
      case "claude-sonnet-4-20250514":
        return "anthropic/claude-sonnet-4";
      case "claude-opus-4-20250514":
        return "anthropic/claude-opus-4";
      case "claude-3-7-sonnet-20250219":
        return "anthropic/claude-3.7-sonnet";
      case "claude-3-5-sonnet-20241022":
      case "claude-3-5-sonnet-20240620":
        return "anthropic/claude-3.5-sonnet";
      case "claude-3-5-haiku-20241022":
        return "anthropic/claude-3.5-haiku";
      default:
        return model;
    }
  }

  private openRouterNitroModel(model: string): string {
    const trimmed = model.trim();
    if (!trimmed) return model;
    const lower = trimmed.toLowerCase();
    if (
      lower.startsWith("dynamic/") ||
      lower.startsWith("google/gemini-") ||
      lower.startsWith("deepseek/deepseek-v4-") ||
      lower.startsWith("anthropic/claude-opus-4.") ||
      lower.endsWith(":nitro")
    ) {
      return trimmed;
    }
    const lastSegment = trimmed.slice(trimmed.lastIndexOf("/") + 1);
    if (lastSegment.includes(":")) {
      return trimmed;
    }
    return `${trimmed}:nitro`;
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

  private bedrockClaudeModel(modelId: string): string {
    switch (modelId) {
      case "claude-haiku-4-5-20251001":
        return "global.anthropic.claude-haiku-4-5-20251001-v1:0";
      case "claude-opus-4-8":
        return "global.anthropic.claude-opus-4-8";
      case "claude-opus-4-6":
      case "claude-opus-4-7":
        return "global.anthropic.claude-opus-4-8";
      case "claude-sonnet-4-6":
      default:
        return "global.anthropic.claude-sonnet-4-6";
    }
  }

  private bedrockRuntimeBaseUrl(region: string | undefined): string | undefined {
    const normalized = region?.trim();
    if (!normalized) return undefined;
    if (!/^[a-z0-9-]+$/.test(normalized)) return undefined;
    return `https://bedrock-runtime.${normalized}.amazonaws.com`;
  }

  private bedrockOpenAiModelConfig(
    modelId: string,
    region: string | undefined,
  ): { modelId: string; baseUrl: string } | null {
    const normalizedModel = modelId.trim().toLowerCase();
    const supportedRegionsByModel: Record<string, readonly string[]> = {
      "gpt-5.5": ["us-east-1", "us-east-2"],
      "gpt-5.4": ["us-east-1", "us-east-2", "us-west-2", "us-gov-west-1"],
    };
    const supportedRegions = supportedRegionsByModel[normalizedModel];
    if (!supportedRegions) return null;

    const normalizedRegion = region?.trim() || "us-east-1";
    if (!/^[a-z0-9-]+$/.test(normalizedRegion)) {
      throw new Error(`Invalid Bedrock AWS region: ${normalizedRegion}`);
    }
    if (!supportedRegions.includes(normalizedRegion)) {
      throw new Error(
        `OpenAI ${modelId} on Amazon Bedrock is not available in ${normalizedRegion}. Supported regions: ${supportedRegions.join(", ")}.`,
      );
    }

    return {
      modelId: `openai.${normalizedModel}`,
      baseUrl: `https://bedrock-mantle.${normalizedRegion}.api.aws/openai/v1`,
    };
  }

  private streamPiModel(
    model: Model<any>,
    context: Parameters<typeof import("@earendil-works/pi-ai").streamSimple>[1],
    options: Parameters<typeof import("@earendil-works/pi-ai").streamSimple>[2],
    streamSimple: typeof import("@earendil-works/pi-ai").streamSimple,
    streamBedrock = bedrockProviderModule.streamBedrock,
  ): ReturnType<typeof import("@earendil-works/pi-ai").streamSimple> {
    return this.streamPiModelWithTransientRetry(
      model,
      options,
      () => {
        if (model.api === "bedrock-converse-stream" && options?.apiKey) {
          return streamBedrock(
            model,
            context,
            this.buildBedrockByokOptions(model, options),
          ) as ReturnType<typeof import("@earendil-works/pi-ai").streamSimple>;
        }
        return streamSimple(model, context, options);
      },
    ) as ReturnType<typeof import("@earendil-works/pi-ai").streamSimple>;
  }

  private streamPiModelWithTransientRetry(
    model: Model<any>,
    options: Parameters<typeof import("@earendil-works/pi-ai").streamSimple>[2],
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

  private buildBedrockByokOptions(
    model: Model<any>,
    options: Parameters<typeof import("@earendil-works/pi-ai").streamSimple>[2],
  ): Parameters<typeof bedrockProviderModule.streamBedrock>[2] {
    return {
      ...options,
      bearerToken: options?.apiKey,
      maxTokens:
        options?.maxTokens ??
        (typeof model.maxTokens === "number" && model.maxTokens > 0
          ? Math.min(model.maxTokens, 32000)
          : undefined),
    } as Parameters<typeof bedrockProviderModule.streamBedrock>[2];
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
          "Run a bash command in a project VM. Requires the unique workspace project name and a concise description. Commands run from /workspace by default; pass cwd only for subdirectories in that checkout. Use this for direct shell commands; use js_exec when orchestrating several tool calls in JavaScript.",
        parameters: BASH_TOOL.parameters,
        execute: async (_id, params) => call("bash", params as Record<string, unknown>),
        executionMode: "sequential",
      },
      {
        name: "js_exec",
        label: "JavaScript",
        description:
          "Run short JavaScript in the Worker-style code mode runtime. Use this for workspace connections and for small scripts that need to orchestrate multiple harness tools. " +
          "The final expression is returned automatically, and `console.log`/`console.warn`/`console.error` output is shown in the tool result. Use explicit `return` when a script has branches or loops. " +
          "Connection globals: `env.CONNECTIONS`, `connections`, `context.cloudflare.connections`, and `context.cloudflare.env.CONNECTIONS` expose the same method facade. " +
          "To use a connection, prefer `const entry = await env.CONNECTIONS.find(\"clickhouse\"); return await env.CONNECTIONS[entry.alias].query({ query: \"SELECT 1 AS ok\" });`. `find` accepts an alias, id, type, name, or object such as `{ type: \"clickhouse\" }` and throws on missing/ambiguous matches. " +
          "Use `await env.CONNECTIONS.methods()` when you need the full catalog; method entries include copyable `example` strings. Virtual channel action entries such as Telegram sends are called through their `tools.<action>(...)` examples, not through `env.CONNECTIONS[alias]` or `connections[alias]`. Use `await env.CONNECTIONS.test(\"clickhouse\")` for a quick smoke test. " +
          "Custom `other` connections expose `fetch`, for example `const response = await connections[entry.alias].fetch(\"/v1/items\", { method: \"GET\" }); return await response.json();`; camelAI applies the stored auth settings. " +
          "Global `fetch()` is also available for direct HTTP requests. It automatically authenticates to this workspace's deployed apps, including private apps on `*.camelai.app`, `*.apps.camelai.dev`, and active custom domains. For web search and page retrieval, prefer `await tools.WebSearch({ query: \"...\" })` and `await tools.WebFetch({ url: \"...\" })`. " +
          "Connection credentials are intentionally hidden behind the binding. " +
          "For workflows that need a project VM, use `env.PROJECTS` to list/create/describe/clone projects and the `vm` facade for project VM execution and file transfer. Project names are unique within the workspace and are the handle to use in tools: `const project = await env.PROJECTS.create({ name: \"web-app\", description: \"Customer-facing React app for tracking pizza orders.\" }); await vm.exec({ command: \"git status && bun install && bun run build\", project: project.name, timeoutSeconds: 120 }); await env.PROJECTS.setDescription({ project: project.name, description: \"Updated project purpose.\" }); const clone = await env.PROJECTS.clone({ sourceProject: project.name, name: \"web-app-experiment\" });`. Each project has one default VM checkout; cloning a project copies the source project VM filesystem, so it can include uncommitted files and be used like a lightweight worktree. When commands are independent, especially across different project VMs or clones, run them concurrently with `const rows = await env.PROJECTS.list(); const targets = rows.flatMap((project) => [project, ...(project.clones ?? [])]); await Promise.all(targets.map((project) => vm.exec({ command: \"bun run test:run\", project: project.name, timeoutSeconds: 120 })))`; this is explicitly better than looping through `await vm.exec(...)` calls synchronously. `vm.exec(command, options)` also works. The active project VM checkout is `/workspace`, and `vm.exec`/`bash` commands run there by default; do not prepend `cd /workspace &&`. Pass `cwd` only for subdirectories in that checkout. Do not use `/home/claude`; it is a legacy path and can fail with permission errors in the current runtime image. The platform configures the Git remote outside the VM so Artifacts credentials stay outside the VM; use normal Git commands in the VM for selective commits and pushes. The normal file tools require an explicit `location` every time: `await tools.read({ location: \"vm\", project: project.name, path: \"/src/App.tsx\" })` reads from the project VM, `await tools.read({ location: \"workspace\", path: \"/notes.md\" })` reads from durable workspace files, and `await tools.read({ location: \"r2\", path: \"outputs/chart.png\" })` reads workspace-scoped R2 objects including images; use `tools.write({ location: \"r2\", path: \"tmp/result.txt\", content })`, `tools.edit({ location: \"r2\", path, edits })`, `tools.ls({ location: \"r2\", path: \"outputs\" })`, or `tools.delete({ location: \"r2\", path })` for R2 writes/edits/listing/deletion. R2 paths are relative: `uploads/<path>` for read-only uploads, `outputs/<path>` for user-visible outputs, and `tmp/<path>` for temporary objects. Search tools are also available inside js_exec: `await tools.grep({ location: \"vm\", project: project.name, pattern: \"TODO\", path: \"/workspace\" })` searches file contents and `await tools.find({ location: \"vm\", project: project.name, pattern: \"**/*.tsx\" })` finds files by glob. Copy files between durable workspace files, project VM files, and R2 objects with `await tools.move({ source: { location: \"workspace\", path: \"/package.json\" }, destination: { location: \"vm\", project: project.name, path: \"/workspace/package.json\" } })` or `await tools.move({ source: { location: \"vm\", project: project.name, path: \"/workspace/dist\" }, destination: { location: \"r2\", path: \"outputs/dist\" } })`. The durable workspace filesystem remains separate. " +
          "AI globals: `env.AI` and `context.cloudflare.env.AI` expose the virtual AI binding (`run()` only). Call `await env.AI.run(\"auto\", { messages: [{ role: \"user\", content: \"hello\" }] })`; model tiers are `cheap`, `fast`, `auto` (default), and `smart`, and any OpenRouter model id is also accepted. For images, call `await env.CAMELAI.generateImage(\"prompt\")` or `await env.CAMELAI.generateImage({ prompt, referenceImageUrl })` on `context.cloudflare.env.CAMELAI`. Returns `{ text, imageDataUrl, images }`. For audio transcription, call `await env.CAMELAI.transcribeAudio({ path: \"uploads/audio.ogg\" })` or pass base64 audio; it returns `{ text }`. Use `await env.CAMELAI.help()` for its method catalog. " +
          "Workspace metadata: call `await env.WORKSPACE.emailAddress()` when users want to email the current workspace; it returns the address string or null. `await env.WORKSPACE.info()` also includes `email_address`. " +
          "Every registered harness tool is also available on the global `tools` object. Start with `await tools.help()` for expandable categories, `await tools.help(\"communication\")` for a category, or `await tools.help(\"send_email\")` for one tool. `ALL_TOOLS` contains the same names, descriptions, schemas, categories, examples, and side-effect metadata. Provider-specific outbound channel tools are intentionally available only here; use them only when the current turn's channel instructions require an external reply or the user explicitly asks for external delivery. " +
          "Interactive tools that wait for the user, such as `prompt_connection_setup`, `delete_connection`, `delete_project`, and `AskUserQuestion`, must be called as top-level tools instead of from js_exec.",
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
    const { getModel, streamSimple } = await import("@earendil-works/pi-ai");
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
      // Provider config is read once per agent turn: the first LLM call after
      // this re-reads from OrgDO and every later call in the turn reuses it.
      this.cachedLlmProviderConfig = null;
      this.resetRunningActivityState();
      this.setChatIsStreaming(true);
      return;
    }

    if (event.type === "turn_start") {
      this.piTurnStartedAtMs = Date.now();
    }

    if (event.type === "turn_end") {
      if (
        this.piUserStopRequestedAtMs > 0 &&
        this.isAbortedPiAssistantMessage(event.message)
      ) {
        return;
      }

      if (this.isFailedPiAssistantMessage(event.message)) {
        const droppedSessionMessages = this.discardUnpersistedPiSessionMessages();
        this.clearPiInFlightMessages();
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
      this.clearPiInFlightMessages();
      const durationMs = this.piTurnStartedAtMs
        ? Date.now() - this.piTurnStartedAtMs
        : 0;
      const billingSource = this.piCurrentBillingSource;
      const creditChargeable = this.piCurrentCreditChargeable;
      const usageProvider = this.piCurrentUsageProvider;
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
      const record = event.message as unknown as Record<string, unknown>;
      if (record.role === "assistant" || record.role === "toolResult") {
        if (this.isFailedPiAssistantMessage(event.message)) {
          return;
        }
        const buffered = isAssistant
          ? this.ensurePiAssistantTextMessage([event.message], text)
          : [await this.attachCodeModeArtifactsToToolResult(event.message)];
        await this.appendPiInFlightMessages(
          this.annotatePiProviderErrorMessages(buffered),
        );
      }
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
      const inFlightMessages = await this.loadPiInFlightMessages({
        includeUiMetadata: stoppedByUser,
      });
      const droppedInFlight = inFlightMessages.length;
      if (stoppedByUser) {
        const messagesToPersist = this.dedupePiMessagesByKey([
          ...inFlightMessages,
          ...newMessages,
        ]);
        if (messagesToPersist.length > 0) {
          await this.appendPiCoreMessagesIfMissing(messagesToPersist);
          const session = this.piSession;
          const sessionMessages = session?.state.messages;
          if (sessionMessages) {
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
      }
      this.clearPiInFlightMessages();
      if (!stoppedByUser) {
        const droppedSessionMessages = this.discardUnpersistedPiSessionMessages();
        if (droppedInFlight > 0 || droppedSessionMessages > 0) {
        }
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
      this.setChatIsStreaming(false, {
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
      return;
    }

    if (!this.shouldSuppressPiSdkEventForChat(event)) {
      this.pushChatEvent({ type: "sdk_event", event });
    }
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
          const userMessage: AgentMessage = {
            role: "user",
            content,
            timestamp: Date.now(),
            ...(wasStreaming
              ? { metadata: { sentDuringStreaming: true } }
              : {}),
          } as unknown as AgentMessage;
          const shouldStartRecovery = !wasStreaming;
          this.ctx.waitUntil(
            (async () => {
              if (!this.piSession) return;
              if (shouldStartRecovery) {
                try {
                  await this.startPiTurnRecovery(userMessage);
                } catch (error) {
                  console.error("[ChatThreadDO] failed to persist Pi recovery user message", error);
                  this.persistPiAgentLoopErrorForDevelopers(error, {
                    source: "pi_turn_recovery_start",
                  });
                  throw error;
                }
              }
              await this.refreshPiSessionModel();
              if (this.piSession.state.isStreaming) {
                this.piSession.steer(userMessage);
              } else {
                await this.keepAlivePiTurnWhile(async () => {
                  if (!this.piSession) {
                    throw new Error("Pi session was not available for prompt");
                  }
                  await this.piSession.prompt(userMessage);
                });
              }
            })().catch((error) => {
                if (
                  error instanceof Error &&
                  (error.name === "AbortError" || /aborted/i.test(error.message))
                ) {
                  return;
                }
                console.error("[ChatThreadDO] Pi prompt failed", error);
                this.persistPiAgentLoopErrorForDevelopers(error, {
                  source: "pi_prompt",
                });
                this.clearPiInFlightMessages();
                const errorMessage =
                  error instanceof Error ? error.message : String(error);
                this.pushChatEvent(this.piProviderErrorEvent(errorMessage));
                this.updateActiveAutomationRun({
                  status: "error",
                  message: errorMessage,
                  clear: true,
                });
                this.setChatIsStreaming(false);
                this.setActiveTurnUserId(null);
              }),
          );
          return true;
        }
        if (type === "stop") {
          this.piUserStopRequestedAtMs = Date.now();
          this.piSession.abort();
          return true;
        }
        if (type === "ping") {
          this.pushChatEvent({ type: "pong", ts: message.ts });
          return true;
        }
        if (type === "set_model") {
          this.ctx.waitUntil(
            this.refreshPiSessionModel().catch((error) => {
              console.error("[ChatThreadDO] failed to refresh Pi model", error);
            }),
          );
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
    const eventId = this.nextChatEventId++;
    this.ctx.storage.kv.put(CHAT_NEXT_EVENT_ID_KEY, this.nextChatEventId);

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
    }

    const envelope: Record<string, unknown> = {
      ...payload,
      eventId,
      sessionId,
    };

    this.agentEvalEventCollector?.push(envelope);
    this.chatEventBuffer.push(envelope);
    if (this.chatEventBuffer.length > MAX_CHAT_EVENT_BUFFER) {
      this.chatEventBuffer.shift();
    }

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
    return Array.from(this.getConnections()) as unknown as WebSocket[];
  }

  private broadcastChat(message: object): void {
    const json = JSON.stringify(message);
    const typed = message as { type?: unknown };
    this.broadcast(json);
  }

  private sendDirect(ws: WebSocket, message: object): void {
    try {
      const json = JSON.stringify(message);
      const typed = message as { type?: unknown };
      ws.send(json);
    } catch {
      // Ignore dead connections; Agents SDK reconnect/replay covers clients.
    }
  }

}
