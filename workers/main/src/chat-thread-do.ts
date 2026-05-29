import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { Type, type TSchema } from "typebox";
import type {
  Agent as PiCoreAgent,
  AgentEvent,
  AgentMessage,
  AgentTool,
  AgentToolResult,
} from "@mariozechner/pi-agent-core";
import { isContextOverflow, setBedrockProviderModule } from "@mariozechner/pi-ai";
import {
  bedrockProviderModule,
  resolveBedrockModelFallback,
  withBedrockModelMetadata,
} from "./pi-bedrock-provider";
import type { Model } from "@mariozechner/pi-ai";
import type { OrgDO, OrgThread, UserDO, WorkerScript } from "./auth";
import type { WorkspaceDO } from "./workspace";
import type { WorkspaceCronDO } from "./workspace-cron";
import type { WorkerLogsDO } from "./worker-logs-do";
import {
  WorkspaceContainer,
  type WorkspaceContainerEnv,
} from "./workspace-container";
import { formatAttributedUserMessage } from './chat-author-attribution';
import { injectFileSafetyMessage } from './file-safety';
import { applyConnectionMentionContext } from './connection-mention-context';
import {
  getThreadTitleSourceMessage,
  isPlaceholderThreadTitle,
} from '../../../src/lib/thread-title';
import { generateThreadTitleWithOpenAI } from '../../../src/lib/thread-title-generation.server';
import {
  extractThreadCompletionSummarySource,
  generateThreadCompletionSummaryWithOpenAI,
} from '../../../src/lib/thread-completion-summary-generation.server';
import { normalizeThreadPreviewUserMessage } from '../../../src/lib/thread-preview';
import { getToolSummary } from '../../../src/lib/tool-activity-summary';
import type {
  LlmModel,
  ThreadCompletionSummaryStatus,
  ToolResultBlock,
  ToolUseBlock,
} from '../../../src/types';
import { decryptCredentials } from "../../../src/lib/integration-crypto";
import {
  DEFAULT_LLM_MODEL,
  normalizeLlmModel,
  parseStoredLlmProviderConfig,
} from "../../../src/lib/llm-provider-config";
import { isOrgBanned } from "./ban-list";
import type { WorkspaceThreadStreamingOptions } from "./thread-status";
import { getPreferredAppUrl } from "../../../src/lib/app-url";
import {
  findConnectionMethodEntry,
  getConnection,
  listConnectionMethods,
  listConnections,
  listConnectionTools,
  testConnectionMethodEntry,
} from "./connections-runtime";
import {
  PI_SKILL_NAMES,
  PI_SKILLS_ROOT,
} from "./pi-skills-bundle";
import {
  listPiBundledSkillFiles,
  readPiBundledSkillFile,
} from "./pi-skill-bundle-helpers";
import {
  PiContainerTools,
  PI_CONTAINER_TOOL_DEFINITIONS,
} from "./pi-container-tools";
import { repairPiMessageHistoryForReplay } from "./pi-message-history";
import { ensureLegacyHostUsageBackfilled } from "./legacy-usage-backfill-gate";
import { parseFilePreviewPath } from "./preview-paths";
import {
  recordErrorEvent,
  recordObservabilityEvent,
} from "./observability";
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
  getWorkspaceEmailDomain,
} from "../../../src/lib/workspace-email";
import {
  EMAIL_REPLY_REFERENCE_TTL_SECONDS,
  getEmailReplyReferenceKey,
} from "./channels";
import { codeModeWorkerModule } from "./code-mode-runner";
import { CodeModeCustomDomains } from "./code-mode-custom-domains";
import { CodeModeScheduledPrompts } from "./code-mode-scheduled-prompts";
import { CodeModeDeterministicAutomations } from "./code-mode-deterministic-automations";
import { CodeModeIntegrations } from "./code-mode-integrations";
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
      source: "workspace" | "upload" | "output";
      workspaceId: string;
      path: string;
      filename?: string;
      contentType?: string;
    };

type PiBillingSource = "hosted" | "byok";

const PI_USER_STOP_TEXT = "Stopped by user";
const PI_USER_STOP_METADATA_REASON = "user_stop";
const CHAT_ACTIVE_AUTOMATION_RUN_KEY = "activeAutomationRun";

interface PiResolvedModelReference {
  provider: string;
  modelId: string;
  api?: string;
  hostedGatewayProvider: string;
  hostedModelId?: string;
}

interface PiRequestConfig {
  apiKey: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  requestProvider?: string;
  requestModelId?: string;
  billingSource: PiBillingSource;
  creditChargeable: boolean;
  usageProvider?: string;
}

interface PiResolvedModelConfig {
  model: Model<any>;
  apiKey: string;
  headers?: Record<string, string>;
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

export interface ChatEnv extends WorkspaceContainerEnv {
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
  AI: Ai;
  ANTHROPIC_API_KEY: string;
  CF_ACCOUNT_ID?: string;
  CF_GATEWAY_NAME?: string;
  CF_GATEWAY_TOKEN?: string;
  INTEGRATION_SECRET_KEY: string;
  TOKEN_SIGNING_SECRET: string;
  AI_GATEWAY_AUTH_TOKEN?: string;
  CF_DISPATCH_NAMESPACE?: string;
  EMAIL_TO_USER: KVNamespace;
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
  pending: PiTurnRecoveryRow | null;
  quarantined: {
    reason: string;
    retryCount: number;
    updatedAt: number;
  } | null;
  inFlightCount: number;
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

interface PiR2ImageReference {
  key: string;
  mimeType: string;
  size: number;
  sha256: string;
  storedAt: number;
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
  mode?: "side_channel";
  lastSeq?: number;
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
}

interface ConnectionsServiceProps {
  orgId: string;
  workspaceId: string;
  userId?: string;
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
}

interface CodeModeToolRegistration extends CodeModeToolDefinition {
  piPassthrough: boolean;
}

type CodeModeToolCallHandler = (
  binding: CodeModeToolsBinding,
  args: Record<string, unknown>,
  name: string,
) => Promise<unknown> | unknown;

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
const CODE_MODE_DEFAULT_MAX_OUTPUT_CHARACTERS = 60_000;
const CODE_MODE_MAX_OUTPUT_CHARACTERS = 200_000;
const JS_EXEC_EXCLUDED_TOOL_NAMES = new Set([
  // This tool waits for human input and can outlive js_exec's short sandbox
  // timeout. Keep it as a top-level Pi tool so the agent sees the submission.
  "prompt_connection_setup",
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
  options: { piPassthrough?: boolean } = {},
): CodeModeToolRegistration {
  return {
    name,
    description,
    parameters,
    piPassthrough: options.piPassthrough ?? false,
  };
}

function codeModePassthroughTool(
  name: string,
  description: string,
  parameters: TSchema = EMPTY_PARAMETERS,
): CodeModeToolRegistration {
  return codeModeTool(name, description, parameters, { piPassthrough: true });
}

function codeModeAlias(
  alias: string,
  target: CodeModeToolRegistration,
  description: string,
): CodeModeToolRegistration {
  return {
    name: alias,
    description,
    parameters: target.parameters,
    piPassthrough: target.piPassthrough,
  };
}

function codeModeDefinition(
  registration: CodeModeToolRegistration,
): CodeModeToolDefinition {
  return {
    name: registration.name,
    description: registration.description,
    parameters: registration.parameters,
  };
}

const CODE_MODE_CONTAINER_TOOL_NAMES = [
  "bash",
  "read",
  "write",
  "ls",
  "edit",
  "grep",
  "find",
] as const;

const CODE_MODE_CONTAINER_TOOL_DEFINITIONS = CODE_MODE_CONTAINER_TOOL_NAMES.map(
  (name) => {
    const definition = PI_CONTAINER_TOOL_DEFINITIONS[name];
    return codeModeTool(definition.name, definition.description, definition.parameters);
  },
);

const ASK_USER_QUESTION_TOOL = codeModePassthroughTool(
  "AskUserQuestion",
  "Ask the user one or more multiple-choice questions in the chat UI and wait for answers. Arguments: { questions }.",
  Type.Object({
    questions: Type.Array(Type.Object({}, { additionalProperties: true })),
  }),
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
  "Send an email from the current workspace. This tool is available only inside js_exec as tools.send_email(...); it is not a top-level tool. Use this only when the user should receive an external email; final assistant text is not emailed automatically. Arguments: { to, subject, text?, html?, reply_to?, attachments? }.",
  Type.Object({
    to: Type.String(),
    subject: Type.String(),
    text: Type.Optional(Type.String()),
    html: Type.Optional(Type.String()),
    reply_to: Type.Optional(Type.String()),
    attachments: CHANNEL_ATTACHMENT_PARAMETERS,
  }),
);
const SEND_SLACK_MESSAGE_TOOL = codeModeTool(
  "send_slack_message",
  "Send a Slack message from the current workspace. This tool is available only inside js_exec as tools.send_slack_message(...); it is not a top-level tool. In a Slack-originated thread, routing defaults to that Slack conversation. Otherwise provide channel_id and, when multiple Slack connections exist, integration_id or team_id. Use thread_ts to reply in a Slack thread. Arguments: { text?, integration_id?, team_id?, channel_id?, thread_ts?, attachments? }.",
  Type.Object({
    text: Type.Optional(Type.String()),
    integration_id: Type.Optional(Type.String()),
    team_id: Type.Optional(Type.String()),
    channel_id: Type.Optional(Type.String()),
    thread_ts: Type.Optional(Type.String()),
    attachments: CHANNEL_ATTACHMENT_PARAMETERS,
  }),
);
const SEND_TELEGRAM_MESSAGE_TOOL = codeModeTool(
  "send_telegram_message",
  "Send a Telegram message from the current workspace. This tool is available only inside js_exec as tools.send_telegram_message(...); it is not a top-level tool. In a Telegram-originated thread, chat_id defaults to that chat. Otherwise provide chat_id, or integration_id for a configured Telegram chat. Image attachments are sent as native Telegram photos when possible; use attachments[].send_as = 'document' to force file/document delivery. Arguments: { text?, chat_id?, integration_id?, attachments? }.",
  Type.Object({
    text: Type.Optional(Type.String()),
    chat_id: Type.Optional(Type.String()),
    integration_id: Type.Optional(Type.String()),
    attachments: CHANNEL_ATTACHMENT_PARAMETERS,
  }),
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
);

const CODE_MODE_TOOL_REGISTRY: CodeModeToolRegistration[] = [
  ...CODE_MODE_CONTAINER_TOOL_DEFINITIONS,
  ASK_USER_QUESTION_TOOL,
  SEND_EMAIL_TOOL,
  SEND_SLACK_MESSAGE_TOOL,
  SEND_TELEGRAM_MESSAGE_TOOL,
  codeModeAlias(
    "ask_user_question",
    ASK_USER_QUESTION_TOOL,
    "Alias for AskUserQuestion. Arguments: { questions }.",
  ),
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
  ),
  codeModePassthroughTool(
    "set_preview",
    "Set the active preview to an app or file. Arguments: { script_name?, app_name?, is_public?, path?, content_type? }.",
    Type.Object({
      script_name: Type.Optional(Type.String()),
      app_name: Type.Optional(Type.String()),
      is_public: Type.Optional(Type.Boolean()),
      path: Type.Optional(Type.String()),
      content_type: Type.Optional(Type.String()),
    }),
  ),
  codeModePassthroughTool("list_apps", "List deployed apps for the current workspace."),
  codeModePassthroughTool(
    "set_app_visibility",
    "Change a deployed app visibility. Arguments: { script_name, is_public }.",
    Type.Object({
      script_name: Type.String(),
      is_public: Type.Boolean(),
    }),
  ),
  codeModePassthroughTool(
    "get_latest_logs",
    "Get recent logs for a deployed app. Arguments: { script_name, limit?, since_ms? }.",
    Type.Object({
      script_name: Type.String(),
      limit: Type.Optional(Type.Number()),
      since_ms: Type.Optional(Type.Number()),
    }),
  ),
  codeModePassthroughTool("list_scheduled_prompts", "List scheduled prompts for the current workspace."),
  codeModePassthroughTool(
    "create_scheduled_prompt",
    "Create a scheduled prompt. Arguments: { name, prompt, cron_expression, enabled? }.",
    Type.Object({
      name: Type.String(),
      prompt: Type.String(),
      cron_expression: Type.String(),
      enabled: Type.Optional(Type.Boolean()),
    }),
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
  ),
  codeModePassthroughTool(
    "delete_scheduled_prompt",
    "Delete a scheduled prompt. Arguments: { prompt_id }.",
    Type.Object({ prompt_id: Type.String() }),
  ),
  codeModePassthroughTool(
    "run_scheduled_prompt_now",
    "Trigger a scheduled prompt immediately. Arguments: { prompt_id }.",
    Type.Object({ prompt_id: Type.String() }),
  ),
  codeModePassthroughTool(
    "list_deterministic_automations",
    "List deterministic workflow automations for the current workspace.",
  ),
  codeModePassthroughTool(
    "validate_deterministic_automation",
    "Validate deterministic automation source without saving it. Arguments: { source }.",
    Type.Object({ source: Type.String() }),
  ),
  codeModePassthroughTool(
    "create_deterministic_automation",
    "Create a deterministic workflow automation. Arguments: { name, source, cron_expression, description, enabled? }.",
    Type.Object({
      name: Type.String(),
      source: Type.String(),
      cron_expression: Type.String(),
      description: Type.String(),
      enabled: Type.Optional(Type.Boolean()),
    }),
  ),
  codeModePassthroughTool(
    "update_deterministic_automation",
    "Update a deterministic workflow automation. Arguments: { automation_id, name?, source?, cron_expression?, description?, enabled? }.",
    Type.Object({
      automation_id: Type.String(),
      name: Type.Optional(Type.String()),
      source: Type.Optional(Type.String()),
      cron_expression: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      enabled: Type.Optional(Type.Boolean()),
    }),
  ),
  codeModePassthroughTool(
    "delete_deterministic_automation",
    "Delete a deterministic workflow automation. Arguments: { automation_id }.",
    Type.Object({ automation_id: Type.String() }),
  ),
  codeModePassthroughTool(
    "run_deterministic_automation_now",
    "Start a deterministic workflow automation immediately. Arguments: { automation_id }.",
    Type.Object({ automation_id: Type.String() }),
  ),
  codeModePassthroughTool(
    "list_integrations",
    "List configured integrations for the current workspace. Arguments: { category? }.",
    Type.Object({ category: Type.Optional(Type.String()) }),
  ),
  codeModePassthroughTool(
    "list_integration_types",
    "List available integration types. Arguments: { category? }. For a native remote MCP server, use integration_type `remote_mcp`; the returned type metadata includes setup hints and MCP capability flags.",
    Type.Object({ category: Type.Optional(Type.String()) }),
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
  ),
  codeModePassthroughTool("get_custom_domain", "Get custom domain diagnostics for deployed apps."),
  codeModePassthroughTool(
    "set_custom_domain",
    "Set an exact custom hostname for an app. Arguments: { app_name, hostname }.",
    Type.Object({
      app_name: Type.String(),
      hostname: Type.String(),
    }),
  ),
  codeModePassthroughTool(
    "remove_custom_domain",
    "Remove a custom hostname from an app. Arguments: { app_name }.",
    Type.Object({ app_name: Type.String() }),
  ),
  codeModePassthroughTool(
    "retry_custom_domain_hostnames",
    "Retry hostname provisioning for configured app custom domains.",
  ),
  WEB_SEARCH_TOOL,
  codeModeAlias(
    "web_search",
    WEB_SEARCH_TOOL,
    "Alias for WebSearch. Arguments: { query, numResults?, maxCharacters? }.",
  ),
  WEB_FETCH_TOOL,
  codeModeAlias(
    "web_fetch",
    WEB_FETCH_TOOL,
    "Alias for WebFetch. Arguments: { url, maxCharacters? }.",
  ),
  AGENT_TOOL,
  codeModeAlias(
    "agent",
    AGENT_TOOL,
    "Alias for Agent. Arguments: { prompt, description?, agent?, model? }.",
  ),
  EXPLORE_TOOL,
  codeModeAlias(
    "explore",
    EXPLORE_TOOL,
    "Alias for Explore. Arguments: { prompt? or query?, description?, agent?, model? }.",
  ),
  codeModeTool(
    "connections_list",
    "List workspace connections. Prefer calling this from js_exec as await env.CONNECTIONS.list().",
  ),
  codeModeTool(
    "connections_get",
    "Get one workspace connection. Prefer calling this from js_exec as await env.CONNECTIONS.get(connection). Arguments: { connection }.",
    Type.Object({ connection: Type.String() }),
  ),
  codeModeTool(
    "connections_tools",
    "List MCP-backed tools for a workspace connection. Prefer calling this from js_exec as await env.CONNECTIONS.tools(connection). Arguments: { connection }.",
    Type.Object({ connection: Type.String() }),
  ),
  codeModeTool(
    "connections_methods",
    "List workspace connections and their method aliases, tool names, and input schemas. Prefer calling this from js_exec as await env.CONNECTIONS.methods().",
  ),
  codeModeTool(
    "connections_find",
    "Find one workspace connection method catalog entry by alias, id, type, or name. Prefer calling this from js_exec as await env.CONNECTIONS.find(query). Arguments: { query }.",
    CONNECTION_QUERY_PARAMETERS,
  ),
  codeModeTool(
    "connections_test",
    "Run a quick workspace connection smoke test. Prefer calling this from js_exec as await env.CONNECTIONS.test(query). Arguments: { query }.",
    CONNECTION_QUERY_PARAMETERS,
  ),
];

const CODE_MODE_TOOL_DEFINITIONS: CodeModeToolDefinition[] = CODE_MODE_TOOL_REGISTRY
  .map(codeModeDefinition);
const CODE_MODE_PI_PASSTHROUGH_TOOL_DEFINITIONS: CodeModeToolDefinition[] =
  CODE_MODE_TOOL_REGISTRY
    .filter((registration) => registration.piPassthrough)
    .map(codeModeDefinition);

export class CodeModeToolsBinding extends WorkerEntrypoint<ChatEnv, CodeModeToolsProps> {
  private static readonly TOOL_CALL_HANDLERS: Record<string, CodeModeToolCallHandler> = {
    AskUserQuestion: (binding, args) => binding.askUserQuestion(args),
    ask_user_question: (binding, args) => binding.askUserQuestion(args),
    TodoWrite: (binding, args) => binding.updateTodos(args),
    set_preview: (binding, args) => binding.setPreview(args),
    list_apps: (binding) => binding.listApps(),
    set_app_visibility: (binding, args) => binding.setAppVisibility(args),
    get_latest_logs: (binding, args) => binding.getLatestLogs(args),
    list_scheduled_prompts: (binding) => binding.listScheduledPrompts(),
    create_scheduled_prompt: (binding, args) => binding.createScheduledPrompt(args),
    update_scheduled_prompt: (binding, args) => binding.updateScheduledPrompt(args),
    delete_scheduled_prompt: (binding, args) => binding.deleteScheduledPrompt(args),
    run_scheduled_prompt_now: (binding, args) => binding.runScheduledPromptNow(args),
    list_deterministic_automations: (binding) => binding.listDeterministicAutomations(),
    validate_deterministic_automation: (binding, args) => binding.validateDeterministicAutomation(args),
    create_deterministic_automation: (binding, args) => binding.createDeterministicAutomation(args),
    update_deterministic_automation: (binding, args) => binding.updateDeterministicAutomation(args),
    delete_deterministic_automation: (binding, args) => binding.deleteDeterministicAutomation(args),
    run_deterministic_automation_now: (binding, args) => binding.runDeterministicAutomationNow(args),
    list_integrations: (binding, args) => binding.listIntegrations(args),
    list_integration_types: (binding, args) => binding.listIntegrationTypes(args),
    create_integration: (binding, args) => binding.createIntegration(args),
    prompt_connection_setup: (binding, args) => binding.promptConnectionSetup(args),
    send_email: (binding, args) => binding.sendEmail(args),
    send_slack_message: (binding, args) => binding.sendSlackMessage(args),
    send_telegram_message: (binding, args) => binding.sendTelegramMessage(args),
    get_custom_domain: (binding) => binding.getCustomDomain(),
    set_custom_domain: (binding, args) => binding.setCustomDomain(args),
    remove_custom_domain: (binding, args) => binding.removeCustomDomain(args),
    retry_custom_domain_hostnames: (binding) => binding.retryCustomDomainHostnames(),
    WebSearch: (binding, args) => binding.webSearch(args),
    web_search: (binding, args) => binding.webSearch(args),
    WebFetch: (binding, args) => binding.webFetch(args),
    web_fetch: (binding, args) => binding.webFetch(args),
    Agent: (binding, args, name) => binding.runSubagentTool(name, args),
    agent: (binding, args, name) => binding.runSubagentTool(name, args),
    Explore: (binding, args, name) => binding.runSubagentTool(name, args),
    explore: (binding, args, name) => binding.runSubagentTool(name, args),
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
  };

  private get workspace(): WorkspaceContainer {
    const { workspaceId, orgId } = this.ctx.props;
    if (!workspaceId || !orgId) {
      throw new Error("Code mode tool binding is missing workspace scope");
    }
    return new WorkspaceContainer(this.env, workspaceId, orgId);
  }

  private get connectionsContext() {
    const { workspaceId, orgId, userId } = this.ctx.props;
    if (!workspaceId || !orgId) {
      throw new Error("Code mode tool binding is missing connection scope");
    }
    return { workspaceId, orgId, userId };
  }

  private get piContainerTools(): PiContainerTools {
    return new PiContainerTools(this.workspace, {
      commandEnv: async () => ({
        ...(await this.workspace.buildContainerCommandEnv()),
        ...(await this.createWranglerDeployEnv()),
      }),
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

  private async createWranglerDeployEnv(): Promise<Record<string, string>> {
    const { orgId, workspaceId } = this.ctx.props;
    if (!orgId || !workspaceId) {
      return {};
    }

    const dockerProxyBaseUrl =
      this.env.SANDBOX_DOCKER_PROXY_BASE_URL?.trim().replace(/\/+$/, "") ||
      "http://host.docker.internal:8081";
    const proxyPath =
      `/v1/workspaces/${encodeURIComponent(orgId)}` +
      `/${encodeURIComponent(workspaceId)}/client/v4`;

    return {
      CLOUDFLARE_API_BASE_URL: `${dockerProxyBaseUrl}${proxyPath}`,
      CLOUDFLARE_API_TOKEN: "chiridion-sandbox-proxy",
      CLOUDFLARE_ACCOUNT_ID: this.env.CF_ACCOUNT_ID?.trim() || "chiridion",
    };
  }

  private async getAppUrl(script: WorkerScript): Promise<string> {
    let appHostname = "camelai.dev";
    const workerBaseUrl = (this.env as { WORKER_BASE_URL?: string }).WORKER_BASE_URL;
    if (workerBaseUrl) {
      try {
        appHostname = new URL(workerBaseUrl).hostname;
      } catch {
        appHostname = "camelai.dev";
      }
    }
    const orgSlug = await this.getOrgSlug();
    return getPreferredAppUrl(script, {
      hostname: appHostname,
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
    const handler = CodeModeToolsBinding.TOOL_CALL_HANDLERS[name];
    if (handler) {
      return handler(this, args, name);
    }

    switch (name) {
      case "bash":
        return this.piContainerTools.callTool("bash", args);

      case "read":
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

      case "grep":
        return this.piContainerTools.callTool("grep", args);

      case "find":
        return this.piContainerTools.callTool("find", args);

      default:
        throw new Error(`Unknown code mode tool: ${name}`);
    }
  }

  private askUserQuestion(args: Record<string, unknown>): Promise<unknown> {
    return this.chatThreadStub.askUserQuestion({
      questions: Array.isArray(args.questions) ? args.questions : [args],
      toolUseId: typeof args.toolUseId === "string" ? args.toolUseId : undefined,
    });
  }

  private runSubagentTool(name: string, args: Record<string, unknown>): Promise<AgentToolResult<unknown>> {
    return (this.chatThreadStub as unknown as {
      runCodeModeSubagent(toolName: "Agent" | "agent" | "Explore" | "explore", params: unknown): Promise<AgentToolResult<unknown>>;
    }).runCodeModeSubagent(name as "Agent" | "agent" | "Explore" | "explore", args);
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
    const scriptName =
      typeof args.script_name === "string" && args.script_name.trim()
        ? args.script_name.trim()
        : typeof args.app_name === "string" && args.app_name.trim()
          ? args.app_name.trim()
          : "";
    if (scriptName) {
      const script = await this.orgStub.getWorkerScript(scriptName);
      if (!script) throw new Error(`App '${scriptName}' not found`);
      const target: PreviewTarget = {
        kind: "app",
        scriptName,
        isPublic: typeof args.is_public === "boolean" ? args.is_public : script.is_public,
      };
      await this.chatThreadStub.setPreviewTarget(target);
      return { success: true, target, app: { name: scriptName, url: await this.getAppUrl(script), is_public: target.isPublic } };
    }
    const filePath = typeof args.path === "string" ? args.path.trim() : "";
    if (!filePath) {
      await this.chatThreadStub.setPreviewTarget(null);
      return { success: true, target: null };
    }
    const parsedPath = parseFilePreviewPath(filePath);
    if (!parsedPath) {
      throw new Error("Invalid preview file path");
    }
    const target: PreviewTarget = {
      kind: "file",
      source: parsedPath.source,
      workspaceId: this.ctx.props.workspaceId,
      path: parsedPath.path,
      filename: parsedPath.filename,
      contentType: typeof args.content_type === "string" ? args.content_type : undefined,
    };
    await this.chatThreadStub.setPreviewTarget(target);
    return { success: true, target };
  }

  private async listApps(): Promise<unknown> {
    const scripts = await this.orgStub.listWorkerScriptsByWorkspace(this.ctx.props.workspaceId);
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
      }))),
    };
  }

  private async setAppVisibility(args: Record<string, unknown>): Promise<unknown> {
    const scriptName = typeof args.script_name === "string" ? args.script_name.trim() : "";
    if (!scriptName) throw new Error("script_name is required");
    if (typeof args.is_public !== "boolean") throw new Error("is_public must be a boolean");
    const script = await this.orgStub.getWorkerScript(scriptName);
    if (!script) return { success: false, error: `App '${scriptName}' not found` };
    if (script.workspace_id !== this.ctx.props.workspaceId) {
      return { success: false, error: `App '${scriptName}' belongs to a different workspace` };
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
      workspaceStub: this.workspaceStub,
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

  private async sendEmail(args: Record<string, unknown>): Promise<unknown> {
    return (this.chatThreadStub as unknown as {
      sendChannelEmailTool(context: ChatContextState, params: unknown): Promise<unknown>;
    }).sendChannelEmailTool(this.chatContextFromProps(), args);
  }

  private async sendSlackMessage(args: Record<string, unknown>): Promise<unknown> {
    return (this.chatThreadStub as unknown as {
      sendChannelSlackMessageTool(context: ChatContextState, params: unknown): Promise<unknown>;
    }).sendChannelSlackMessageTool(this.chatContextFromProps(), args);
  }

  private async sendTelegramMessage(args: Record<string, unknown>): Promise<unknown> {
    return (this.chatThreadStub as unknown as {
      sendChannelTelegramMessageTool(context: ChatContextState, params: unknown): Promise<unknown>;
    }).sendChannelTelegramMessageTool(this.chatContextFromProps(), args);
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

const CHAT_SOCKET_TAG = "chat";
const RUNNER_CLIENT_SOCKET_TAG = "runner";

const CHAT_CONTEXT_KEY = "chatContext";
const CHAT_TODOS_KEY = "chatTodos";
const CHAT_CONTEXT_USED_PERCENT_KEY = "chatContextUsedPercent";
const CHAT_CONTEXT_WINDOW_BY_MODEL_KEY = "chatContextWindowByModel";
const CHAT_NEXT_EVENT_ID_KEY = "chatNextEventId";
const CHAT_RUNNER_LAST_SEQ_KEY = "chatRunnerLastSeq";
const CHAT_ACTIVE_TURN_USER_ID_KEY = "chatActiveTurnUserId";
const PI_TURN_RECOVERY_ROW_ID = 1;
const PI_TURN_RECOVERY_ALARM_MS = 10_000;
const PI_TURN_RECOVERY_MAX_ALARM_MS = 5 * 60_000;
const PI_TURN_RECOVERY_STALE_MS = 30_000;
const PI_TURN_RECOVERY_MAX_RETRIES = 3;
const PI_TURN_RECOVERY_QUARANTINE_KEY = "piTurnRecoveryQuarantined";
const PI_TURN_RECOVERY_CONTEXT_PURPOSE = "pi_turn_recovery_context";
const PI_TURN_RECOVERY_CONTINUE_PROMPT = "continue";
const PI_TURN_RECOVERY_PROMPT_OBSERVATION_MS = 5 * 60_000;

const MAX_CHAT_EVENT_BUFFER = 500;
const ASK_USER_QUESTION_UNAVAILABLE_MESSAGE = 'User is not at computer; ask_user_question is unavailable in this channel. Continue without asking and use best effort.';

export interface PiTurnRecoveryRow {
  turn_id: string;
  status: "running" | "recovering";
  user_content: string;
  user_timestamp: number;
  active_user_id: string | null;
  retry_count: number;
  started_at: number;
  updated_at: number;
}

const HEADER_USER_NAME = "X-Chiridion-User-Name";
const HEADER_USER_EMAIL = "X-Chiridion-User-Email";
const HEADER_USER_ID = "X-Chiridion-User-Id";

const TRACE_CHAT_THREAD_DO = false;
const CHAT_CODEX_SESSION_ID_KEY = 'chatCodexSessionId';

/**
 * ChatThreadDO - One per thread, holds preview state, prompts, browser runner
 * traffic, and agent turns. Sandbox-host remains the backend for workspace
 * file/shell/container operations.
 */
export class ChatThreadDO extends DurableObject<ChatEnv> {
  private static readonly CONNECTION_SETUP_TIMEOUT_MS = 30 * 60 * 1000;

  private previewTarget: PreviewTarget | null = null;
  private previewTabs: PreviewTarget[] = [];
  private previewActiveTabId: string | null = null;
  private previewVersion: number = 0;

  // Chat bridge state
  private chatContext: ChatContextState | null = null;
  private chatEventBuffer: Array<Record<string, unknown>> = [];
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
  private runnerConnectPromise: Promise<void> | null = null;
  private lastRunnerSeq: number = 0;
  private runnerTransitionChain: Promise<void> = Promise.resolve();
  private piSessionPromise: Promise<PiCoreAgent> | null = null;
  private piSession: PiCoreAgent | null = null;
  private piMainBaselineIndex = 0;
  private piModelResolver: (() => Promise<PiResolvedModelConfig>) | null = null;
  private piUnsubscribe: (() => void) | null = null;
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
  private piRecoveryInFlight: Promise<void> | null = null;
  private piLastPersistedLoopError: { fingerprint: string; at: number } | null = null;

  private trace(event: string, details: Record<string, unknown> = {}): void {
    if (!TRACE_CHAT_THREAD_DO) return;
    const context = this.chatContext;
    const payload = {
      event,
      threadId: context?.threadId || "",
      workspaceId: context?.workspaceId || "",
      orgId: context?.orgId || "",
      chatSockets: this.getChatSockets().length,
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
    this.trace("runner_activity", {
      source,
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

      const storedRunnerLastSeq = ctx.storage.kv.get<number>(
        CHAT_RUNNER_LAST_SEQ_KEY,
      );
      if (typeof storedRunnerLastSeq === "number" && storedRunnerLastSeq > 0) {
        this.lastRunnerSeq = Math.floor(storedRunnerLastSeq);
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

      const pendingPiTurn = this.loadPiTurnRecovery();
      if (pendingPiTurn) {
        this.chatIsStreaming = true;
        this.activeTurnUserId = pendingPiTurn.active_user_id;
        this.recordChatThreadObservabilityEvent("pi_turn_recovery_loaded_on_boot", {
          operation: "constructor",
          status: pendingPiTurn.status,
          severity: "warn",
          count: pendingPiTurn.retry_count,
          size: Math.max(0, Date.now() - pendingPiTurn.started_at),
          sampleKey: `turn:${pendingPiTurn.turn_id}|active:${pendingPiTurn.active_user_id ? 1 : 0}`,
        });
        this.schedulePiTurnRecoveryAlarm(1_000);
      }
    });
  }

  async alarm(): Promise<void> {
    const pendingPiTurn = this.loadPiTurnRecovery();
    if (!pendingPiTurn) return;
    if (this.loadPiTurnRecoveryQuarantine()) return;
    if (pendingPiTurn.retry_count >= PI_TURN_RECOVERY_MAX_RETRIES) {
      this.quarantinePiTurnRecovery(
        `retry_count ${pendingPiTurn.retry_count} reached max ${PI_TURN_RECOVERY_MAX_RETRIES}`,
        pendingPiTurn.retry_count,
      );
      return;
    }

    if (this.piSession?.state.isStreaming) {
      this.schedulePiTurnRecoveryAlarm(PI_TURN_RECOVERY_ALARM_MS);
      return;
    }

    const ageMs = Date.now() - pendingPiTurn.updated_at;
    if (ageMs < PI_TURN_RECOVERY_STALE_MS) {
      this.schedulePiTurnRecoveryAlarm(PI_TURN_RECOVERY_STALE_MS - ageMs);
      return;
    }

    if (!this.piRecoveryInFlight) {
      this.piRecoveryInFlight = this.recoverInterruptedPiTurn(pendingPiTurn)
        .catch((error) => {
          console.error("[ChatThreadDO] failed to recover interrupted Pi turn", error);
          this.persistPiAgentLoopErrorForDevelopers(error, {
            source: "pi_turn_recovery",
          });
          const nextRetryCount = pendingPiTurn.retry_count + 1;
          if (nextRetryCount >= PI_TURN_RECOVERY_MAX_RETRIES) {
            this.quarantinePiTurnRecovery(
              error instanceof Error ? error.message : "Pi turn recovery failed",
              nextRetryCount,
            );
            return;
          }
          this.schedulePiTurnRecoveryAlarm(
            this.piTurnRecoveryRetryDelayMs(nextRetryCount),
          );
        })
        .finally(() => {
          this.piRecoveryInFlight = null;
        });
    }

    await this.piRecoveryInFlight;
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
      },
    });
    const connections = (this.ctx.exports as unknown as {
      ConnectionsService: (options: { props: ConnectionsServiceProps }) => unknown;
    }).ConnectionsService({
      props: {
        orgId: request.orgId,
        workspaceId: request.workspaceId,
        userId: request.userId,
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

    const workerCode: WorkerLoaderWorkerCode = {
      compatibilityDate: CODE_MODE_COMPATIBILITY_DATE,
      mainModule: "index.js",
      modules: {
        "index.js": { js: codeModeWorkerModule(code) },
      },
      env: { TOOLS: tools, CONNECTIONS: connections, AI: ai, CAMELAI: camelai },
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
      const socketTag =
        url.pathname === "/chat"
          ? CHAT_SOCKET_TAG
          : url.pathname === "/runner"
            ? RUNNER_CLIENT_SOCKET_TAG
            : null;
      if (!socketTag) {
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
      this.ctx.acceptWebSocket(server, [socketTag]);
      this.captureChatContextFromRequest(url, request, server);
      this.trace("ws_upgrade_accepted", {
        path: url.pathname,
        socketTag,
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

      if (this.isRunnerClientSocket(ws)) {
        await this.handleRunnerClientMessage(ws, data);
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
        data.type === "set_model" ||
        data.type === "ping"
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
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ): void {
    if (this.isRunnerClientSocket(ws)) {
      this.trace("runner_client_ws_close", {
        code,
        reason,
        wasClean,
        remainingRunnerSockets: this.getRunnerClientSockets().length,
      });
      return;
    }

    this.trace("chat_ws_close", {
      code,
      reason,
      wasClean,
      remainingChatSockets: this.getChatSockets().length,
    });
    if (this.getChatSockets().length === 0) {
      if (this.browserPrompts.pendingQuestionCount > 0) {
        this.markRunnerActivity("chat_socket_closed_question_unavailable");
        this.ctx.waitUntil(
          this.autoAnswerAllPendingQuestionsAsUnavailable(
            ASK_USER_QUESTION_UNAVAILABLE_MESSAGE,
          ),
        );
      }
    }
    // Intentional no-op on side-channel socket close. Browser runner traffic is
    // owned by ChatThreadDO on a separate tagged WebSocket.
  }

  webSocketError(ws: WebSocket, error: unknown): void {
    if (this.isRunnerClientSocket(ws)) {
      this.trace("runner_client_ws_error", {
        error: String(error),
      });
      return;
    }
    this.trace("chat_ws_error", {
      error: String(error),
    });
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
          messages.push(sanitizePiProviderMessage(hydrated as AgentMessage));
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
      this.recordChatThreadObservabilityEvent("pi_core_message_history_repaired", {
        operation: "repair_persisted_history",
        status: "ok",
        count: repaired.repairedCount + invalidRows,
        size: afterMessages.length,
      });
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
    toolName: "Agent" | "agent" | "Explore" | "explore",
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

  async getPiCoreParsedMessages(threadId: string): Promise<Array<{
    id: string;
    thread_id: string;
    role: "user" | "assistant";
    content: unknown;
    created_at: number;
    forkEntryId: string;
  }>> {
    const normalizedThreadId = threadId.trim() || this.chatContext?.threadId || "";
    const parsed: Array<{
      id: string;
      thread_id: string;
      role: "user" | "assistant";
      content: unknown;
      created_at: number;
      forkEntryId: string;
    }> = [];

    const [coreMessages, inFlightMessages] = await Promise.all([
      this.loadPiCoreMessages(),
      this.loadPiInFlightMessages(),
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
    this.clearPiTurnRecovery();
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

    this.trace("active_turn_user_updated", {
      userIdPresent: Boolean(normalizedUserId),
    });
  }

  async refreshRunnerConfig(): Promise<void> {
    await this.withRunnerTransitionLock('refresh_runner_config', async () => {
      this.disposePiSession();
    });
  }

  async byokChanged(): Promise<void> {
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
            this.recordChatThreadObservabilityEvent("pi_r2_image_externalize_failed", {
              operation: "persist_history",
              status: "error",
              severity: "error",
              error,
              size: data.length,
            });
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
          this.recordChatThreadObservabilityEvent("pi_r2_image_hydrate_failed", {
            operation: "load_history",
            status: "error",
            severity: "error",
            error,
            size: ref.size,
          });
        }
        if (data) {
          this.recordChatThreadObservabilityEvent("pi_r2_image_hydrated", {
            operation: "load_history",
            status: "ok",
            count: 1,
            size: data.length,
          });
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

  private async loadPiInFlightMessages(): Promise<AgentMessage[]> {
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
          messages.push(sanitizePiProviderMessage(hydrated as AgentMessage));
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

  private async loadPiCoreMessages(): Promise<AgentMessage[]> {
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
          messages.push(sanitizePiProviderMessage(hydrated as AgentMessage));
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
    this.recordChatThreadObservabilityEvent("pi_core_messages_replaced", {
      operation: "replace",
      status: "ok",
      count: messages.length,
    });
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
    this.recordChatThreadObservabilityEvent("pi_core_messages_appended", {
      operation: "append",
      status: "ok",
      count: messages.length,
      size: startIndex,
    });
    const continueCount = messages.filter((message) => this.isPiRecoveryContinueMessage(message)).length;
    if (continueCount > 0) {
      const pending = this.loadPiTurnRecovery();
      this.recordChatThreadObservabilityEvent("pi_recovery_continue_persisted", {
        operation: "append",
        status: pending ? pending.status : "no_pending_recovery",
        severity: "warn",
        count: continueCount,
        size: startIndex,
        sampleKey: pending
          ? `turn:${pending.turn_id}|retry:${pending.retry_count}`
          : "no_pending_recovery",
      });
    }
  }

  private piCoreMessageKey(message: AgentMessage): string {
    const record = message as unknown as Record<string, unknown>;
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
    this.recordChatThreadObservabilityEvent("pi_sql_storage_sanitized", {
      operation,
      status,
      severity: "warn",
      count: messageCount,
      size: stats.originalChars - stats.storedChars,
      sampleKey: [
        `externalized:${stats.externalizedImages}`,
        `images:${stats.omittedImages}`,
        `strings:${stats.truncatedStrings}`,
        `whole:${stats.omittedWholeMessage ? 1 : 0}`,
      ].join("|"),
    });
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
      this.recordChatThreadObservabilityEvent("pi_core_messages_append_skipped", {
        operation: "append_if_missing",
        status: "duplicate",
        count: 0,
        size: messages.length,
      });
    }
  }

  private loadPiTurnRecovery(): PiTurnRecoveryRow | null {
    this.ensurePiCoreTables();
    const row = this.ctx.storage.sql
      .exec<{
        turn_id: string;
        status: string;
        user_content: string;
        user_timestamp: number;
        active_user_id: string | null;
        retry_count: number;
        started_at: number;
        updated_at: number;
      }>(
        `SELECT turn_id, status, user_content, user_timestamp, active_user_id,
          retry_count, started_at, updated_at
         FROM pi_turn_recovery
         WHERE id = ?`,
        PI_TURN_RECOVERY_ROW_ID,
      )
      .toArray()[0];
    if (!row || (row.status !== "running" && row.status !== "recovering")) {
      return null;
    }
    return {
      turn_id: row.turn_id,
      status: row.status,
      user_content: row.user_content,
      active_user_id:
        typeof row.active_user_id === "string" && row.active_user_id.trim()
          ? row.active_user_id.trim()
          : null,
      retry_count: Math.max(0, Math.floor(Number(row.retry_count) || 0)),
      user_timestamp: Math.max(0, Math.floor(Number(row.user_timestamp) || 0)),
      started_at: Math.max(0, Math.floor(Number(row.started_at) || 0)),
      updated_at: Math.max(0, Math.floor(Number(row.updated_at) || 0)),
    };
  }

  private loadPiTurnRecoveryQuarantine(): PiTurnRecoveryAdminState["quarantined"] {
    const value = this.ctx.storage.kv.get<unknown>(PI_TURN_RECOVERY_QUARANTINE_KEY);
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    const reason = typeof record.reason === "string" && record.reason.trim()
      ? record.reason.trim()
      : "Pi turn recovery quarantined";
    return {
      reason,
      retryCount: Math.max(0, Math.floor(Number(record.retryCount) || 0)),
      updatedAt: Math.max(0, Math.floor(Number(record.updatedAt) || 0)),
    };
  }

  async getPiTurnRecoveryAdminState(): Promise<PiTurnRecoveryAdminState> {
    return {
      pending: this.loadPiTurnRecovery(),
      quarantined: this.loadPiTurnRecoveryQuarantine(),
      inFlightCount: (await this.loadPiInFlightMessages()).length,
    };
  }

  private async startPiTurnRecovery(userMessage: AgentMessage): Promise<void> {
    const content = typeof userMessage.content === "string" ? userMessage.content : "";
    if (!content.trim()) return;
    const now = Date.now();
    const timestamp =
      typeof (userMessage as unknown as Record<string, unknown>).timestamp === "number"
        ? ((userMessage as unknown as Record<string, unknown>).timestamp as number)
        : now;
    this.ensurePiCoreTables();
    this.ctx.storage.sql.exec(
      `INSERT INTO pi_turn_recovery
        (id, turn_id, status, user_content, user_timestamp, active_user_id,
          retry_count, started_at, updated_at)
       VALUES (?, ?, 'running', ?, ?, ?, 0, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
        turn_id = excluded.turn_id,
        status = excluded.status,
        user_content = excluded.user_content,
        user_timestamp = excluded.user_timestamp,
        active_user_id = excluded.active_user_id,
        retry_count = 0,
        started_at = excluded.started_at,
        updated_at = excluded.updated_at`,
      PI_TURN_RECOVERY_ROW_ID,
      crypto.randomUUID(),
      content,
      timestamp,
      this.activeTurnUserId,
      now,
      now,
    );
    await this.appendPiInFlightMessages([userMessage]);
    this.schedulePiTurnRecoveryAlarm(PI_TURN_RECOVERY_ALARM_MS);
    this.recordChatThreadObservabilityEvent("pi_turn_recovery_started", {
      operation: "start_recovery",
      status: "running",
      count: 1,
    });
  }

  private touchPiTurnRecovery(status: PiTurnRecoveryRow["status"]): void {
    this.ensurePiCoreTables();
    this.ctx.storage.sql.exec(
      "UPDATE pi_turn_recovery SET status = ?, updated_at = ? WHERE id = ?",
      status,
      Date.now(),
      PI_TURN_RECOVERY_ROW_ID,
    );
    this.schedulePiTurnRecoveryAlarm(PI_TURN_RECOVERY_ALARM_MS);
  }

  private markPiTurnRecovering(): void {
    this.ensurePiCoreTables();
    this.ctx.storage.sql.exec(
      `UPDATE pi_turn_recovery
       SET status = 'recovering', retry_count = retry_count + 1, updated_at = ?
       WHERE id = ?`,
      Date.now(),
      PI_TURN_RECOVERY_ROW_ID,
    );
    this.schedulePiTurnRecoveryAlarm(PI_TURN_RECOVERY_ALARM_MS);
  }

  private clearPiTurnRecovery(): void {
    this.ensurePiCoreTables();
    this.ctx.storage.sql.exec(
      "DELETE FROM pi_turn_recovery WHERE id = ?",
      PI_TURN_RECOVERY_ROW_ID,
    );
    this.ctx.storage.kv.delete(PI_TURN_RECOVERY_QUARANTINE_KEY);
  }

  async clearPiTurnRecoveryForAdmin(): Promise<PiTurnRecoveryAdminState> {
    this.clearPiTurnRecovery();
    this.clearPiInFlightMessages();
    this.setChatIsStreaming(false);
    this.ctx.waitUntil(
      this.ctx.storage.deleteAlarm().catch((error) => {
        console.error("[ChatThreadDO] failed to clear Pi recovery alarm", error);
      }),
    );
    this.recordChatThreadObservabilityEvent("pi_turn_recovery_admin_cleared", {
      operation: "admin_clear_recovery",
      status: "ok",
    });
    return await this.getPiTurnRecoveryAdminState();
  }

  private quarantinePiTurnRecovery(reason: string, retryCount: number): void {
    const updatedAt = Date.now();
    this.ctx.storage.kv.put(PI_TURN_RECOVERY_QUARANTINE_KEY, {
      reason,
      retryCount,
      updatedAt,
    });
    this.setChatIsStreaming(false);
    this.ctx.waitUntil(
      this.ctx.storage.deleteAlarm().catch((error) => {
        console.error("[ChatThreadDO] failed to clear quarantined Pi recovery alarm", error);
      }),
    );
    this.recordChatThreadObservabilityEvent("pi_turn_recovery_quarantined", {
      operation: "recover_interrupted_turn",
      status: "quarantined",
      severity: "warn",
      count: retryCount,
    });
  }

  private schedulePiTurnRecoveryAlarm(delayMs: number): void {
    const normalizedDelayMs = Math.max(1_000, Math.floor(delayMs));
    this.ctx.waitUntil(
      this.ctx.storage
        .setAlarm(Date.now() + normalizedDelayMs)
        .catch((error) => {
          console.error("[ChatThreadDO] failed to schedule Pi recovery alarm", error);
        }),
    );
  }

  private piTurnRecoveryRetryDelayMs(retryCount: number): number {
    const exponent = Math.max(0, Math.min(8, Math.floor(retryCount) - 1));
    return Math.min(
      PI_TURN_RECOVERY_MAX_ALARM_MS,
      PI_TURN_RECOVERY_ALARM_MS * (2 ** exponent),
    );
  }

  private async recoverInterruptedPiTurn(
    pendingPiTurn: PiTurnRecoveryRow,
  ): Promise<void> {
    if (!this.chatContext) {
      this.quarantinePiTurnRecovery("missing chat context for Pi turn recovery", pendingPiTurn.retry_count);
      return;
    }

    // The original user message is already captured in the in-flight buffer
    // by startPiTurnRecovery; runPi will fold it into the recovery context
    // message on the next session boot. Re-appending here would duplicate
    // rows on every retry and inflate the eventual recovery context.
    this.markPiTurnRecovering();
    this.recordChatThreadObservabilityEvent("pi_turn_recovery_resumed", {
      operation: "recover_interrupted_turn",
      status: "recovering",
      count: pendingPiTurn.retry_count + 1,
      size: Math.max(0, Date.now() - pendingPiTurn.started_at),
    });
    this.setActiveTurnUserId(pendingPiTurn.active_user_id);
    this.setChatIsStreaming(true);

    await this.ensureRunnerConnected();
    if (!this.piSession) {
      throw new Error("Pi session was not available for turn recovery");
    }
    await this.refreshPiSessionModel();
    this.suppressNextPiRecoveryPromptEvent = true;
    this.piRecoveryContinuePromptSentAtMs = Date.now();
    try {
      await this.piSession.prompt({
        role: "user",
        content: PI_TURN_RECOVERY_CONTINUE_PROMPT,
        timestamp: this.piRecoveryContinuePromptSentAtMs,
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
    const parsedStatus =
      typeof statusCandidate === "number" && Number.isFinite(statusCandidate)
        ? Math.trunc(statusCandidate)
        : typeof statusCandidate === "string" && /^\d{3}$/.test(statusCandidate.trim())
          ? Number(statusCandidate.trim())
          : /\b429\b/.test(trimmed)
            ? 429
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
      return {
        ...record,
        billingSource,
        ...(provider ? { provider } : {}),
        ...this.piProviderErrorMetadata(errorMessage),
      } as unknown as AgentMessage;
    });

    return changed ? next : messages;
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
    recordErrorEvent(this.env, {
      event: "pi_agent_loop_error",
      component: "chat_thread_do",
      operation: source,
      status: eventType ?? "error",
      threadId: context?.threadId,
      workspaceId: context?.workspaceId,
      orgId: context?.orgId,
      userId: context?.userId,
      error,
    });

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
      return [{
        id: `pi_user_${timestamp}_${index}`,
        thread_id: threadId,
        role: "user",
        content: this.piUserContentToChatContent(record.content),
        created_at: timestamp,
        forkEntryId: `pi_user_${timestamp}_${index}`,
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
        const pending = this.loadPiTurnRecovery();
        this.recordChatThreadObservabilityEvent("pi_recovery_continue_event_leaked", {
          operation: "handle_pi_session_event",
          status: pending ? pending.status : "no_pending_recovery",
          severity: "warn",
          count: pending?.retry_count ?? 0,
          size: Math.max(0, Date.now() - this.piRecoveryContinuePromptSentAtMs),
          sampleKey: pending
            ? `turn:${pending.turn_id}|retry:${pending.retry_count}`
            : "recent_recovery_prompt",
        });
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

    const block = {
      type: "tool_result",
      tool_use_id: toolCallId,
      content: this.piToolResultContentToChatContent(toolResult.content),
      itemId: toolCallId,
      itemKind:
        typeof toolResult.toolName === "string" &&
        toolResult.toolName.trim().toLowerCase() === "bash"
          ? "commandExecution"
          : "dynamicToolCall",
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
    this.trace("handle_chat_init_complete", {
      incomingThreadId,
      replayFromEventId: lastEventId,
      bufferedEvents: this.chatEventBuffer.length,
      pendingQuestions: this.browserPrompts.pendingQuestionCount,
      currentTodos: this.currentTodos.length,
      chatIsStreaming: this.chatIsStreaming,
    });
  }

  private async applyConnectionMentionsForTurn(content: string): Promise<string> {
    if (!content) return content;
    if (!content.includes('@')) return content;
    const workspaceId = this.chatContext?.workspaceId;
    if (!workspaceId) return content;
    try {
      const workspaceStub = this.env.WORKSPACE.get(
        this.env.WORKSPACE.idFromName(workspaceId),
      );
      const integrations = await workspaceStub.getIntegrations();
      const result = applyConnectionMentionContext(content, integrations);
      return result.content;
    } catch (err) {
      console.error(
        '[ChatThreadDO] applyConnectionMentionsForTurn failed',
        err,
      );
      return content;
    }
  }

  private async handleRunnerClientMessage(
    ws: WebSocket,
    data: { type: string; [key: string]: unknown },
  ): Promise<void> {
    if (data.type === "init") {
      await this.handleRunnerClientInit(ws, data as unknown as ChatClientInitMessage);
      return;
    }

    if (data.type === "ping") {
      this.sendDirect(ws, { type: "pong", ts: data.ts });
      return;
    }

    if (data.type === "message") {
      await this.handleRunnerClientUserMessage(ws, data as unknown as ChatClientMessage);
      return;
    }

    if (data.type === "question_response") {
      await this.handleQuestionResponse(
        ws,
        data as unknown as ChatClientQuestionResponse,
      );
      return;
    }

    await this.ensureRunnerConnected();
    this.sendRunnerCommand({ ...data, threadId: this.chatContext?.threadId });
  }

  private async handleRunnerClientInit(
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

    const lastSeq = this.normalizeRunnerClientSeq(data.lastSeq ?? data.lastEventId);
    if (lastSeq > this.lastRunnerSeq) {
      this.lastRunnerSeq = lastSeq;
      this.ctx.storage.kv.put(CHAT_RUNNER_LAST_SEQ_KEY, this.lastRunnerSeq);
    }

    await this.ensureRunnerConnected();

    this.sendDirect(ws, {
      type: "session",
      sessionId: this.chatContext.threadId,
    });
    this.sendDirect(ws, {
      type: "streaming_state",
      isStreaming: this.chatIsStreaming,
    });
    this.sendDirect(ws, { type: "ready" });
    this.replayRunnerEvents(ws, lastSeq);
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

  private async handleRunnerClientUserMessage(
    ws: WebSocket,
    data: ChatClientMessage,
  ): Promise<void> {
    const startedAt = Date.now();
    const sendAttemptId = data.clientMessageId || crypto.randomUUID();
    this.recordChatThreadObservabilityEvent("runner_user_message_send_attempt", {
      operation: "received",
      status: "started",
      count: data.clientMessageId ? 1 : 0,
      sampleKey: sendAttemptId,
    });

    if (data.clientMessageId) {
      this.sendDirect(ws, {
        type: "message_accepted",
        clientMessageId: data.clientMessageId,
      });
    }

    let result: InitialUserMessageResult;
    try {
      result = await this.enqueueRunnerUserMessage(data, {
        sendAttemptId,
        startedAt,
      });
    } catch (error) {
      this.updateActiveAutomationRun({
        status: "error",
        message: error instanceof Error ? error.message : "Failed to send message",
        clear: true,
      });
      this.setChatIsStreaming(false);
      this.setActiveTurnUserId(null);
      console.error("[ChatThreadDO] failed to enqueue browser user message", error);
      this.recordChatThreadObservabilityEvent("runner_user_message_send_attempt", {
        operation: "enqueue_runner_user_message",
        status: "exception",
        severity: "error",
        durationMs: Date.now() - startedAt,
        sampleKey: sendAttemptId,
        error,
      });
      this.sendDirect(
        ws,
        this.chatSendErrorPayload(error, {
          fallbackMessage: "Failed to send message to sandbox",
        }),
      );
      return;
    }

    if (result.status !== "accepted") {
      this.recordChatThreadObservabilityEvent("runner_user_message_send_attempt", {
        operation: "enqueue_runner_user_message",
        status: result.status,
        severity: result.status === "busy" ? "warn" : "error",
        durationMs: Date.now() - startedAt,
        sampleKey: sendAttemptId,
      });
      this.sendDirect(
        ws,
        this.chatSendErrorPayload(result.error, {
          status: result.status,
          fallbackMessage: "Failed to send message",
        }),
      );
      return;
    }

    this.recordChatThreadObservabilityEvent("runner_user_message_send_attempt", {
      operation: "enqueue_runner_user_message",
      status: "accepted",
      durationMs: Date.now() - startedAt,
      sampleKey: sendAttemptId,
    });

  }

  private async enqueueRunnerUserMessage(
    data: ChatClientMessage,
    options: { sendAttemptId?: string; startedAt?: number } = {},
  ): Promise<InitialUserMessageResult> {
    const startedAt = options.startedAt ?? Date.now();
    const sampleKey = options.sendAttemptId;
    const context = this.chatContext;
    if (!context) {
      this.recordChatThreadObservabilityEvent("runner_user_message_enqueue", {
        operation: "validate_context",
        status: "error",
        severity: "warn",
        durationMs: Date.now() - startedAt,
        sampleKey,
      });
      return { status: "error", error: "Missing chat context for thread" };
    }

    const rawContent =
      typeof data.content === "string" ? data.content.trim() : "";
    if (!rawContent) {
      this.recordChatThreadObservabilityEvent("runner_user_message_enqueue", {
        operation: "validate_message",
        status: "error",
        severity: "warn",
        durationMs: Date.now() - startedAt,
        size: 0,
        sampleKey,
      });
      return { status: "error", error: "Empty message" };
    }

    const banCheckStartedAt = Date.now();
    const orgBan = await isOrgBanned(this.env.APP_KV, {
      orgId: context.orgId,
    });
    this.recordChatThreadObservabilityEvent("runner_user_message_enqueue_stage", {
      operation: "org_ban_checked",
      durationMs: Date.now() - banCheckStartedAt,
      size: rawContent.length,
      sampleKey,
    });
    if (orgBan) {
      this.recordChatThreadObservabilityEvent("runner_user_message_enqueue", {
        operation: "org_ban_checked",
        status: "error",
        severity: "warn",
        durationMs: Date.now() - startedAt,
        size: rawContent.length,
        sampleKey,
      });
      return { status: "error", error: "Organization is blocked" };
    }

    const runnerConnectStartedAt = Date.now();
    try {
      await this.ensureRunnerConnected();
      this.recordChatThreadObservabilityEvent("runner_user_message_enqueue_stage", {
        operation: "ensure_runner_connected",
        durationMs: Date.now() - runnerConnectStartedAt,
        size: rawContent.length,
        sampleKey,
      });
    } catch (error) {
      this.recordChatThreadObservabilityEvent("runner_user_message_enqueue", {
        operation: "ensure_runner_connected",
        status: "exception",
        severity: "error",
        durationMs: Date.now() - startedAt,
        size: rawContent.length,
        sampleKey,
        error,
      });
      throw error;
    }

    const messagePrepareStartedAt = Date.now();
    let attributedContent: string;
    try {
      const safeContent = injectFileSafetyMessage(rawContent);
      const mentionAugmented =
        await this.applyConnectionMentionsForTurn(safeContent);
      attributedContent = formatAttributedUserMessage(mentionAugmented, {
        userName: context.userName,
        userEmail: context.userEmail,
      });
      this.recordChatThreadObservabilityEvent("runner_user_message_enqueue_stage", {
        operation: "message_prepared",
        durationMs: Date.now() - messagePrepareStartedAt,
        size: rawContent.length,
        sampleKey,
      });
    } catch (error) {
      this.recordChatThreadObservabilityEvent("runner_user_message_enqueue", {
        operation: "message_prepared",
        status: "exception",
        severity: "error",
        durationMs: Date.now() - startedAt,
        size: rawContent.length,
        sampleKey,
        error,
      });
      throw error;
    }
    if (!attributedContent) {
      this.recordChatThreadObservabilityEvent("runner_user_message_enqueue", {
        operation: "message_prepared",
        status: "error",
        severity: "warn",
        durationMs: Date.now() - startedAt,
        size: rawContent.length,
        sampleKey,
      });
      return { status: "error", error: "Empty message" };
    }

    let sent = false;
    try {
      this.setActiveTurnUserId(context.userId);
      this.setChatIsStreaming(true);
      this.publishRunningUserMessageActivity(rawContent);
      this.broadcastRunnerClients({ type: "streaming_state", isStreaming: true });
      this.ctx.waitUntil(
        this.updateThreadMetadataForUserMessage(attributedContent).catch((err) => {
          console.error(
            '[ChatThreadDO] failed to update thread metadata after browser user message',
            err,
          );
          this.recordChatThreadObservabilityEvent("runner_user_message_enqueue", {
            operation: "update_thread_metadata",
            status: "exception",
            severity: "warn",
            sampleKey,
            error: err,
          });
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
      this.recordChatThreadObservabilityEvent("runner_user_message_enqueue", {
        operation: "send_runner_command",
        status: "exception",
        severity: "error",
        durationMs: Date.now() - startedAt,
        size: rawContent.length,
        sampleKey,
        error,
      });
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
      this.recordChatThreadObservabilityEvent("runner_user_message_enqueue", {
        operation: "send_runner_command",
        status: "error",
        severity: "error",
        durationMs: Date.now() - startedAt,
        size: rawContent.length,
        sampleKey,
      });
      return { status: "error", error: "Failed to send message" };
    }

    this.recordChatThreadObservabilityEvent("runner_user_message_enqueue", {
      operation: "send_runner_command",
      status: "accepted",
      durationMs: Date.now() - startedAt,
      size: rawContent.length,
      sampleKey,
    });
    this.ctx.waitUntil(
      this.warmWorkspaceContainerForTurn(context).catch((error) => {
        console.warn("[ChatThreadDO] container warmup failed", error);
        this.recordChatThreadObservabilityEvent("container_warmup", {
          operation: "warm_after_user_message",
          status: "error",
          severity: "warn",
          error,
        });
      }),
    );
    return { status: "accepted" };
  }

  private async warmWorkspaceContainerForTurn(
    context: ChatContextState,
  ): Promise<void> {
    const startedAt = Date.now();
    const container = new WorkspaceContainer(
      this.env,
      context.workspaceId,
      context.orgId,
    );
    const result = await container.warmContainer({ skipBanCheck: true });
    this.recordChatThreadObservabilityEvent("container_warmup", {
      operation: "warm_after_user_message",
      status: result.success ? "ok" : "error",
      severity: result.success ? "info" : "warn",
      durationMs: Date.now() - startedAt,
      error: result.success ? undefined : new Error(result.error || "Container warmup failed"),
    });
  }

  private async handleQuestionResponse(
    ws: WebSocket,
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

    if (this.browserPrompts.answerQuestion(data)) {
      return;
    }

    this.markRunnerActivity("question_response");
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

  private resetRunningActivityState(): void {
    this.runningActivityLastText = null;
    this.runningActivityLastSentAt = 0;
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
    return this.getWorkspaceStatusStub(normalizedWorkspaceId).recordThreadStreaming(
      normalizedThreadId,
      isStreaming,
      options,
    );
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
    this.ctx.waitUntil(
      this.recordWorkspaceThreadStreaming(
        context.workspaceId,
        context.threadId,
        true,
        { activityText, activityAt: now },
      ).catch((error) => {
        console.error("[ChatThreadDO] failed to record running activity", error);
      }),
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
    this.trace("set_chat_is_streaming", {
      from: this.chatIsStreaming,
      to: value,
    });
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
      const orgStub = this.env.ORG.get(this.env.ORG.idFromName(context.orgId)) as unknown as {
        recordThreadAssistantCompletion(
          id: string,
          input: {
            completedAt: number;
            summary: string | null;
            summaryStatus?: ThreadCompletionSummaryStatus | null;
          },
        ): Promise<number | false> | number | false;
      };
      const storedCompletedAt = await orgStub.recordThreadAssistantCompletion(context.threadId, {
        completedAt,
        summary,
        summaryStatus,
      });
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
        this.env,
        sourceText,
        {
          orgId: context.orgId,
          workspaceId: context.workspaceId,
          threadId: context.threadId,
        },
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
      this.recordChatThreadObservabilityEvent("initial_user_message_start", {
        operation: "validate_context",
        status: "error",
        severity: "warn",
        durationMs: Date.now() - startedAt,
        size: typeof body.message === "string" ? body.message.length : 0,
      });
      return { status: "error", error: contextError };
    }

    const message =
      typeof body.message === "string" ? body.message.trim() : "";
    if (!message) {
      this.recordChatThreadObservabilityEvent("initial_user_message_start", {
        operation: "validate_message",
        status: "error",
        severity: "warn",
        durationMs: Date.now() - startedAt,
        size: 0,
      });
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
        this.recordChatThreadObservabilityEvent("initial_user_message_start", {
          operation: "automation_run_busy",
          status: "busy",
          severity: "warn",
          durationMs: Date.now() - startedAt,
          size: message.length,
        });
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
      });
      this.recordChatThreadObservabilityEvent("initial_user_message_start", {
        operation: "enqueue_runner_user_message",
        status: result.status,
        severity: result.status === "accepted" ? "info" : "warn",
        durationMs: Date.now() - startedAt,
        size: message.length,
      });
      if (automationRun && result.status !== "accepted") {
        this.setActiveAutomationRun(null);
      }
      return result;
    } catch (error) {
      if (automationRun) {
        this.setActiveAutomationRun(null);
      }
      this.recordChatThreadObservabilityEvent("initial_user_message_start", {
        operation: "enqueue_runner_user_message",
        durationMs: Date.now() - startedAt,
        size: message.length,
        error,
      });
      return {
        status: "error",
        error:
          error instanceof Error
            ? error.message
            : "Failed to start initial message",
      };
    }
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

  private async updateThreadMetadataForUserMessage(messageContent: string): Promise<void> {
    const context = this.chatContext;
    if (!context?.orgId || !context?.threadId || !context.workspaceId) return;

    const orgStub = this.env.ORG.get(this.env.ORG.idFromName(context.orgId));
    const thread = await orgStub.getThread(context.threadId);
    if (!thread) return;

    await orgStub.recordThreadUserMessage(context.threadId, messageContent);
    if (context.userId) {
      const userStub = this.env.USER.get(this.env.USER.idFromName(context.userId));
      await userStub.touchGroupForThread(context.threadId);
    }

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
      const context = this.chatContext;
      if (!context?.orgId) {
        return;
      }

      const title = await generateThreadTitleWithOpenAI(this.env, message, {
        orgId: context.orgId,
        workspaceId: context.workspaceId,
        threadId,
      });
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

  private async ensureRunnerConnected(): Promise<void> {
    await this.withRunnerTransitionLock("ensure_runner_connected", async () => {
      await this.ensureRunnerConnectedUnlocked();
    });
  }

  private async ensureRunnerConnectedUnlocked(): Promise<void> {
    if (this.piSession) {
      this.trace("ensure_runner_connected_pi_already_connected");
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
      const baseContext = this.chatContext;
      if (!baseContext) {
        throw new Error("Missing chat context");
      }

      console.log(
        `[ChatThreadDO] ensureRunnerConnected: connecting for thread=${baseContext.threadId}`,
      );
      this.trace("ensure_runner_connected_start", {
        contextThreadId: baseContext.threadId,
        contextWorkspaceId: baseContext.workspaceId,
        contextOrgId: baseContext.orgId,
      });

      const orgStub = this.env.ORG.get(this.env.ORG.idFromName(baseContext.orgId));
      const [thread, llmProviderRecord] = await Promise.all([
        orgStub.getThread(baseContext.threadId),
        orgStub.getLlmProviderConfig(),
      ]);
      const context: ChatContextState = { ...baseContext };
      this.chatContext = context;
      this.ctx.storage.kv.put(CHAT_CONTEXT_KEY, context);
      const threadWorkspaceId =
        thread && typeof thread === "object" && "workspace_id" in thread
          ? (thread as { workspace_id?: unknown }).workspace_id
          : null;
      const threadModel =
        thread && threadWorkspaceId === context.workspaceId
          ? normalizeLlmModel((thread as { model?: unknown }).model)
          : normalizeLlmModel(undefined, llmProviderRecord?.provider);
      const envVars = {
        CHIRIDION_MODEL: threadModel,
        CHIRIDION_CLAUDE_MODEL: threadModel,
        CHIRIDION_CODEX_MODEL: threadModel,
      };
      this.trace("ensure_runner_env_built", {
        envVarCount: Object.keys(envVars).length,
      });

      await this.ensurePiSession(context, envVars);
      this.trace("ensure_runner_pi_connected");

      console.log(
        `[ChatThreadDO] ensureRunnerConnected: connected for thread=${context.threadId}`,
      );
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
    const { Agent } = await import("@mariozechner/pi-agent-core");
    const { completeSimple, getModel, streamSimple } = await import("@mariozechner/pi-ai");

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
      this.recordChatThreadObservabilityEvent("pi_in_flight_recovered", {
        operation: "build_recovery_message",
        status: "ok",
        count: inFlight.length,
      });
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
          compacted.map((message) => sanitizePiProviderMessage(message)),
        );
        if (repaired.repairedCount > 0) {
          this.recordChatThreadObservabilityEvent("pi_provider_history_repaired", {
            operation: "repair_message_history",
            status: "ok",
            count: repaired.repairedCount,
            size: repaired.messages.length,
            provider: current.usageProvider || current.provider,
            model: current.model.id || current.modelId,
          });
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
    this.pushChatEvent({ type: "session", sessionId: context.threadId });
    this.pushChatEvent({ type: "ready" });
    return session;
  }

  private createPiSystemPrompt(context: ChatContextState): string {
    const skillLines = PI_SKILL_NAMES.map(
      (name) => `- ${name}: ${PI_SKILLS_ROOT}/${name}/SKILL.md`,
    );
    return [
      "You are camelAI, an AI coding agent running inside the user's camelAI workspace.",
      "Use the provided tools for workspace files, shell commands, container operations, JavaScript code mode, and connections.",
      "File, shell, and container operations execute through sandbox-host; do not assume local Worker filesystem access.",
      "For channel-originated conversations, final assistant text is not sent to the external provider. To send an external email, Slack message, or Telegram message, call `js_exec` and use `tools.send_email(...)`, `tools.send_slack_message(...)`, or `tools.send_telegram_message(...)`. These outbound channel tools are available only inside `js_exec`, are usable from any chat context, and should be called only when you intentionally need to send an external message.",
      "When you create or edit a user-visible file or app, call the `set_preview` tool with the relevant file path or app name so the user can inspect the result in the preview pane.",
      "For workspace connections, prefer the `js_exec` tool. In `js_exec`, use `await env.CONNECTIONS.find(\"provider-or-type\")` to resolve one connection, then call it through `connections[entry.alias].method(input)` or `context.cloudflare.connections[entry.alias].method(input)`. Database-style connections expose `query({ query })`; custom `other` connections expose `fetch(input, init)`. Global `fetch()` is also available in `js_exec` for direct HTTP requests; prefer `tools.WebSearch` and `tools.WebFetch` for web lookup. Use `await env.CONNECTIONS.methods()` only when you need the full catalog, schemas, or examples. Connection credentials are intentionally hidden behind the binding.",
      "For hosted AI in `js_exec`, use `env.AI` or `context.cloudflare.env.AI` with `run()` only, for example `await env.AI.run(\"auto\", { messages: [{ role: \"user\", content: \"hello\" }] })`. Model tiers are `cheap`, `fast`, `auto` (default), and `smart`; any OpenRouter model id is also accepted. For images, call `await env.CAMELAI.generateImage(\"prompt\")`; for audio transcription, call `await env.CAMELAI.transcribeAudio({ path: \"/mnt/user-uploads/audio.ogg\" })` or pass base64 audio (same on `context.cloudflare.env.CAMELAI`).",
      "Before relying on repository-specific conventions, read /home/claude/AGENTS.md, /home/claude/CLAUDE.md, /AGENTS.md, or /CLAUDE.md if present.",
      "",
      "## Available Skills",
      "When a task matches a skill, read that skill file with the read tool and follow it. Built-in skills are available at:",
      ...skillLines,
      "",
      `Thread ID: ${context.threadId}`,
      `Workspace ID: ${context.workspaceId}`,
      `Organization ID: ${context.orgId}`,
    ].filter(Boolean).join("\n");
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
        "attachments[].path must be under /mnt/user-uploads/ or /mnt/user-outputs/",
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
      { prefix: "/mnt/user-uploads/", bucketDir: "user-uploads" },
      { prefix: "/mnt/user-outputs/", bucketDir: "user-outputs" },
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
    const thread = await this.getOriginatingChannelThread(context, "email");
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
    let from = thread?.channel_connection_id?.trim() || "";
    if (!from) {
      const emailDomain = getWorkspaceEmailDomain(this.env);
      if (!emailDomain) {
        throw new Error("Workspace email domain is not configured");
      }
      const workspaceStub = this.env.WORKSPACE.get(
        this.env.WORKSPACE.idFromName(context.workspaceId),
      ) as unknown as WorkspaceDO;
      const workspaceInfo = await workspaceStub.getInfo();
      const emailHandle = workspaceInfo?.email_handle?.trim();
      if (!emailHandle) {
        throw new Error("Workspace email sender is not configured");
      }
      from = buildWorkspaceEmailAddress(emailHandle, emailDomain);
    }

    const explicitReplyTo = this.optionalToolString(raw, "reply_to");
    const replyTo = explicitReplyTo || thread?.channel_connection_id || undefined;
    const body: Parameters<CloudflareEmailSender["send"]>[0] = {
      from,
      to,
      subject,
    };
    if (text) body.text = text;
    if (html) body.html = html;
    if (replyTo) body.replyTo = replyTo;
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
      await this.env.APP_KV.put(
        getEmailReplyReferenceKey(context.workspaceId, response.messageId),
        context.threadId,
        { expirationTtl: EMAIL_REPLY_REFERENCE_TTL_SECONDS },
      );
    }

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

    const wsStub = this.env.WORKSPACE.get(
      this.env.WORKSPACE.idFromName(context.workspaceId),
    ) as unknown as WorkspaceDO;
    const explicitIntegrationId = this.optionalToolString(raw, "integration_id");
    const explicitTeamId = this.optionalToolString(raw, "team_id") || conversation.teamId;
    const integrationId = explicitIntegrationId || thread?.channel_connection_id?.trim() || "";
    const integrations = integrationId ? [] : await wsStub.getIntegrations();
    const slackIntegrations = integrations.filter((candidate) => candidate.integration_type === "slack");
    if (!integrationId && slackIntegrations.length === 0) {
      throw new Error("Slack integration_id is required because no Slack connection is available");
    }
    if (!integrationId && slackIntegrations.length > 1 && !explicitTeamId) {
      throw new Error("Multiple Slack integrations are available; provide integration_id or team_id");
    }

    const candidates = integrationId
      ? [await wsStub.getIntegration(integrationId)]
      : slackIntegrations;
    let selected: {
      integration: Awaited<ReturnType<WorkspaceDO["getIntegration"]>>;
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
    const integrationId = this.optionalToolString(raw, "integration_id");
    let chatId = thread?.channel_conversation_id?.trim() || "";
    if (!chatId) {
      if (!integrationId) {
        throw new Error(
          "Telegram integration_id is required outside Telegram-originated threads",
        );
      }
      const wsStub = this.env.WORKSPACE.get(
        this.env.WORKSPACE.idFromName(context.workspaceId),
      ) as unknown as WorkspaceDO;
      const integration = await wsStub.getIntegration(integrationId);
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
    } else if (explicitChatId && explicitChatId !== chatId) {
      throw new Error("Telegram chat_id does not match the originating conversation");
    }

    const sentMessageIds: Array<number | undefined> = [];
    if (text) {
      const response = await fetch(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text,
          }),
        },
      );
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

    return {
      content: [{ type: "text", text: "Telegram message sent." }],
      details: {
        status: "sent",
        channel: "telegram",
        chatId,
        messageId: sentMessageIds[0],
        messageIds: sentMessageIds,
        attachmentCount: attachments.length,
      },
    };
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
      formData.set("caption", args.attachment.caption.slice(0, 1024));
    }
    formData.set(
      args.fieldName,
      new Blob([args.attachment.content], {
        type: args.attachment.contentType,
      }),
      args.attachment.filename,
    );

    const response = await fetch(
      `https://api.telegram.org/bot${args.token}/${args.method}`,
      {
        method: "POST",
        body: formData,
      },
    );
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
    completeSimple: typeof import("@mariozechner/pi-ai").completeSimple,
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
      this.recordChatThreadObservabilityEvent("pi_context_compaction_fallback_persisted", {
        operation: "compact_context",
        status: "fallback",
        severity: "warn",
        count: messagesToSummarize.length,
        size: messages.length - firstKeptIndex,
      });
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
        this.recordChatThreadObservabilityEvent("pi_post_turn_compaction_failed", {
          operation: "post_turn_compaction",
          status: "error",
          error,
        });
      }),
    );
  }

  private async loadPiCompleteSimple(): Promise<typeof import("@mariozechner/pi-ai").completeSimple> {
    const { completeSimple } = await import("@mariozechner/pi-ai");
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
    this.recordChatThreadObservabilityEvent("pi_post_turn_compacted", {
      operation: "post_turn_compaction",
      status: "ok",
      count: before.length,
      size: compacted.length,
      provider: current.usageProvider || current.provider,
      model: current.model.id || current.modelId,
    });
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
    completeSimple: typeof import("@mariozechner/pi-ai").completeSimple,
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
    completeSimple: typeof import("@mariozechner/pi-ai").completeSimple,
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
    const role = (message as { role?: unknown }).role;
    if (role === "user") {
      const content = (message as { content?: unknown }).content;
      return `[User]\n${typeof content === "string" ? content : JSON.stringify(content)}`;
    }
    if (role === "assistant") {
      return `[Assistant]\n${JSON.stringify((message as { content?: unknown }).content)}`;
    }
    if (role === "toolResult") {
      const toolName = (message as { toolName?: unknown }).toolName;
      const content = (message as { content?: unknown }).content;
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
    const modelId =
      envVars.CHIRIDION_MODEL ||
      envVars.CHIRIDION_CODEX_MODEL ||
      envVars.CHIRIDION_CLAUDE_MODEL ||
      DEFAULT_LLM_MODEL;
    const resolved = this.resolvePiModelReference(modelId);
    const model =
      (getModelFn(
        resolved.provider as never,
        resolved.modelId as never,
      ) as Model<any> | null | undefined) ??
      resolvePiModelCatalogFallback(resolved);
    if (!model) {
      throw new Error(`Unsupported Pi model ${modelId}`);
    }

    const configured = await this.resolvePiRequestConfig(resolved, context);
    const configuredModel =
      configured.requestProvider === "amazon-bedrock" && configured.requestModelId
        ? (getModelFn(
            configured.requestProvider as never,
            configured.requestModelId as never,
          ) as Model<any> | null | undefined) ??
          resolveBedrockModelFallback(configured.requestModelId)
        : null;
    if (configured.requestProvider === "amazon-bedrock" && !configuredModel) {
      throw new Error(`Unsupported Bedrock Pi model ${configured.requestModelId}`);
    }
    const modelBase = configuredModel ?? model;
    const usageProvider = configured.usageProvider ?? resolved.provider;
    this.piCurrentBillingSource = configured.billingSource;
    this.piCurrentCreditChargeable = configured.creditChargeable;
    this.piCurrentUsageProvider = usageProvider;
    const resolvedModel = {
      ...modelBase,
      api: resolved.api ?? modelBase.api,
      id: configured.requestModelId ?? modelBase.id,
      provider: configured.requestProvider ?? modelBase.provider,
      baseUrl: configured.baseUrl || modelBase.baseUrl,
      headers: {
        ...(modelBase.headers ?? {}),
        ...(configured.headers ?? {}),
      },
    };
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
      hostedModelId: this.openRouterNitroModel(resolvedModelId),
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
      case "kimi-k2.6":
        return openRouterReference("~moonshotai/kimi-latest");
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
    return trimmed.replace(/^(claude|codex)\//, "");
  }

  private async resolvePiRequestConfig(
    resolved: PiResolvedModelReference,
    context: ChatContextState,
  ): Promise<PiRequestConfig> {
    const byok = await this.resolveCurrentByokCredentials(context).catch((error) => {
      console.error("[ChatThreadDO] failed to resolve Pi BYOK credentials", error);
      return null;
    });
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
        baseUrl: this.bedrockRuntimeBaseUrl(byok.awsRegion),
        usageProvider: "bedrock",
      };
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
      throw new Error("Cloudflare AI Gateway is not configured for DO Pi");
    }

    return {
      apiKey: token,
      billingSource: "hosted",
      creditChargeable,
      requestProvider: "cloudflare-ai-gateway",
      requestModelId: resolved.hostedModelId,
      usageProvider: resolved.hostedGatewayProvider,
      baseUrl:
        `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(accountId)}` +
        `/${encodeURIComponent(gatewayName)}/${encodeURIComponent(resolved.hostedGatewayProvider)}`,
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

    await ensureLegacyHostUsageBackfilled(this.env, context.orgId);
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

  private async resolveCurrentByokCredentials(
    context: ChatContextState,
  ): Promise<{ provider: string; apiKey?: string; awsRegion?: string } | null> {
    const orgStub = this.env.ORG.get(this.env.ORG.idFromName(context.orgId));
    const record = await orgStub.getLlmProviderConfig();
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
    if (record.provider === "bedrock" && creds.bearer_token) {
      return {
        provider: "bedrock",
        apiKey: creds.bearer_token,
        awsRegion: config.aws_region,
      };
    }

    if (config.aws_region) {
      this.trace("pi_byok_bedrock_region_ignored", {
        provider: record.provider,
      });
    }
    return null;
  }

  private bedrockClaudeModel(modelId: string): string {
    switch (modelId) {
      case "claude-haiku-4-5-20251001":
        return "global.anthropic.claude-haiku-4-5-20251001-v1:0";
      case "claude-opus-4-8":
        return "us.anthropic.claude-opus-4-8";
      case "claude-opus-4-6":
      case "claude-opus-4-7":
        return "us.anthropic.claude-opus-4-8";
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

  private streamPiModel(
    model: Model<any>,
    context: Parameters<typeof import("@mariozechner/pi-ai").streamSimple>[1],
    options: Parameters<typeof import("@mariozechner/pi-ai").streamSimple>[2],
    streamSimple: typeof import("@mariozechner/pi-ai").streamSimple,
    streamBedrock = bedrockProviderModule.streamBedrock,
  ): ReturnType<typeof import("@mariozechner/pi-ai").streamSimple> {
    try {
      if (model.api === "bedrock-converse-stream" && options?.apiKey) {
        return streamBedrock(
          model,
          context,
          this.buildBedrockByokOptions(model, options),
        ) as ReturnType<typeof import("@mariozechner/pi-ai").streamSimple>;
      }
      return streamSimple(model, context, options);
    } catch (error) {
      this.persistPiAgentLoopErrorForDevelopers(error, {
        source: "pi_stream",
      });
      throw error;
    }
  }

  private buildBedrockByokOptions(
    model: Model<any>,
    options: Parameters<typeof import("@mariozechner/pi-ai").streamSimple>[2],
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
      const result = await tools.callTool(name, args);
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
        name: PI_CONTAINER_TOOL_DEFINITIONS.ls.name,
        label: PI_CONTAINER_TOOL_DEFINITIONS.ls.label,
        description: `${PI_CONTAINER_TOOL_DEFINITIONS.ls.description} Also supports bundled skill directories.`,
        parameters: PI_CONTAINER_TOOL_DEFINITIONS.ls.parameters,
        execute: async (_id, params) => call("ls", params as Record<string, unknown>),
      },
      {
        name: PI_CONTAINER_TOOL_DEFINITIONS.grep.name,
        label: PI_CONTAINER_TOOL_DEFINITIONS.grep.label,
        description: PI_CONTAINER_TOOL_DEFINITIONS.grep.description,
        parameters: PI_CONTAINER_TOOL_DEFINITIONS.grep.parameters,
        execute: async (_id, params) => call("grep", params as Record<string, unknown>),
      },
      {
        name: PI_CONTAINER_TOOL_DEFINITIONS.find.name,
        label: PI_CONTAINER_TOOL_DEFINITIONS.find.label,
        description: PI_CONTAINER_TOOL_DEFINITIONS.find.description,
        parameters: PI_CONTAINER_TOOL_DEFINITIONS.find.parameters,
        execute: async (_id, params) => call("find", params as Record<string, unknown>),
      },
      {
        name: PI_CONTAINER_TOOL_DEFINITIONS.bash.name,
        label: PI_CONTAINER_TOOL_DEFINITIONS.bash.label,
        description: PI_CONTAINER_TOOL_DEFINITIONS.bash.description,
        parameters: PI_CONTAINER_TOOL_DEFINITIONS.bash.parameters,
        execute: async (_id, params) => call("bash", params as Record<string, unknown>),
        executionMode: "sequential",
      },
      {
        name: "js_exec",
        label: "JavaScript",
        description:
          "Run short JavaScript in the Worker-style code mode runtime. Use this for workspace connections and for small scripts that need to orchestrate multiple harness tools. " +
          "The final expression is returned automatically, and `console.log`/`console.warn`/`console.error` output is shown in the tool result. Use explicit `return` when a script has branches or loops. " +
          "Connection globals: `env.CONNECTIONS` is the virtual Worker binding, `connections` and `context.cloudflare.connections` are method facades, and `context.cloudflare.env.CONNECTIONS` is the same binding. " +
          "To use a connection, prefer `const entry = await env.CONNECTIONS.find(\"clickhouse\"); return await connections[entry.alias].query({ query: \"SELECT 1 AS ok\" });`. `find` accepts an alias, id, type, name, or object such as `{ type: \"clickhouse\" }` and throws on missing/ambiguous matches. " +
          "Use `await env.CONNECTIONS.methods()` when you need the full catalog; method entries include copyable `example` strings. Use `await env.CONNECTIONS.test(\"clickhouse\")` for a quick smoke test. " +
          "Custom `other` connections expose `fetch`, for example `const response = await connections[entry.alias].fetch(\"/v1/items\", { method: \"GET\" }); return await response.json();`; camelAI applies the stored auth settings. " +
          "Global `fetch()` is also available for direct HTTP requests to public URLs. For web search and page retrieval, prefer `await tools.WebSearch({ query: \"...\" })` and `await tools.WebFetch({ url: \"...\" })`. " +
          "Connection credentials are intentionally hidden behind the binding. " +
          "AI globals: `env.AI` and `context.cloudflare.env.AI` expose the virtual AI binding (`run()` only). Call `await env.AI.run(\"auto\", { messages: [{ role: \"user\", content: \"hello\" }] })`; model tiers are `cheap`, `fast`, `auto` (default), and `smart`, and any OpenRouter model id is also accepted. For images, call `await env.CAMELAI.generateImage(\"prompt\")` or `await env.CAMELAI.generateImage({ prompt, referenceImageUrl })` on `context.cloudflare.env.CAMELAI`. Returns `{ text, imageDataUrl, images }`. For audio transcription, call `await env.CAMELAI.transcribeAudio({ path: \"/mnt/user-uploads/audio.ogg\" })` or pass base64 audio; it returns `{ text }`. " +
          "Every registered harness tool is also available on the global `tools` object; inspect `ALL_TOOLS` for names, descriptions, and schemas, then call tools like `await tools.WebSearch({ query: \"Cloudflare Workers\" })`. Outbound channel tools are intentionally available only here: use `await tools.send_email(...)`, `await tools.send_slack_message(...)`, or `await tools.send_telegram_message(...)` to send external messages from any chat context. " +
          "Interactive tools that wait for the user, such as `prompt_connection_setup` and `AskUserQuestion`, must be called as top-level tools instead of from js_exec.",
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
        execute: async (_id, params) => {
          const raw = params as {
            code?: unknown;
            timeoutMs?: unknown;
            maxOutputCharacters?: unknown;
          };
          const result = await this.runCodeModeJavascript({
            code: typeof raw.code === "string" ? raw.code : "",
            orgId: context.orgId,
            workspaceId: context.workspaceId,
            threadId: context.threadId,
            userId: context.userId ?? undefined,
            timeoutMs: typeof raw.timeoutMs === "number" ? raw.timeoutMs : null,
            maxOutputCharacters:
              typeof raw.maxOutputCharacters === "number"
                ? raw.maxOutputCharacters
                : null,
          });
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
        toolName: "Agent" | "agent" | "Explore" | "explore",
        params: unknown,
        signal?: AbortSignal,
        onUpdate?: (partialResult: AgentToolResult<unknown>) => void,
      ) =>
        this.runPiSubagentTool(context, toolName, params, signal, onUpdate);

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
          name: "agent",
          label: "Agent",
          description:
            "Alias for Agent. Run a focused subagent in the same workspace with an isolated context.",
          parameters: Type.Object({
            prompt: Type.String(),
            description: Type.Optional(Type.String()),
            agent: Type.Optional(Type.String()),
            model: Type.Optional(Type.String()),
          }),
          execute: async (_id, params, signal, onUpdate) =>
            runAgent("agent", params, signal, onUpdate),
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
        {
          name: "explore",
          label: "Explore",
          description:
            "Alias for Explore. Run a focused read-oriented exploration subagent in the same workspace.",
          parameters: Type.Object({
            prompt: Type.Optional(Type.String()),
            query: Type.Optional(Type.String()),
            description: Type.Optional(Type.String()),
            agent: Type.Optional(Type.String()),
            model: Type.Optional(Type.String()),
          }),
          execute: async (_id, params, signal, onUpdate) =>
            runAgent("explore", params, signal, onUpdate),
          executionMode: "sequential",
        },
      );
    }

    return definitions;
  }

  private async runPiSubagentTool(
    context: ChatContextState,
    toolName: "Agent" | "agent" | "Explore" | "explore",
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: (partialResult: AgentToolResult<unknown>) => void,
  ): Promise<AgentToolResult<unknown>> {
    const raw = params && typeof params === "object"
      ? params as Record<string, unknown>
      : {};
    const isExplore = toolName === "Explore" || toolName === "explore";
    const prompt =
      typeof raw.prompt === "string" && raw.prompt.trim()
        ? raw.prompt.trim()
        : typeof raw.query === "string" && raw.query.trim()
          ? raw.query.trim()
          : "";
    if (!prompt) {
      throw new Error(`${toolName} requires a prompt`);
    }

    const { Agent } = await import("@mariozechner/pi-agent-core");
    const { getModel, streamSimple } = await import("@mariozechner/pi-ai");
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
    const base = this.createPiSystemPrompt(context);
    return [
      base,
      "",
      "## Subagent Mode",
      "You are running as an isolated subagent for the primary coding agent.",
      "Keep the task bounded, report concrete findings, and include exact file paths when relevant.",
      isExplore
        ? "This is an exploration task. Inspect and reason about the workspace, but do not edit files."
        : "This is a delegated implementation or investigation task. Make focused changes only when the prompt asks for them.",
      "Do not spawn additional subagents.",
    ].join("\n");
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
    if (event.type === "agent_start") {
      this.piAssistantText = "";
      this.piActiveItemText = "";
      this.piActiveItemId = null;
      this.piReasoningItemId = null;
      this.piToolArgs = new Map();
      this.piAgentStartedAtMs = Date.now();
      this.piTurnStartedAtMs = Date.now();
      this.piUserStopRequestedAtMs = 0;
      this.resetRunningActivityState();
      this.touchPiTurnRecovery("running");
      this.setChatIsStreaming(true);
      return;
    }

    if (event.type === "turn_start") {
      this.piTurnStartedAtMs = Date.now();
      this.touchPiTurnRecovery("running");
    }

    if (event.type === "turn_end") {
      if (
        this.piUserStopRequestedAtMs > 0 &&
        this.isAbortedPiAssistantMessage(event.message)
      ) {
        this.recordChatThreadObservabilityEvent("pi_user_stop_turn_end_suppressed", {
          operation: "handle_pi_session_event",
          status: "turn_end",
          count: 1,
        });
        return;
      }

      const snapshot = this.piSession?.state.messages ?? [];
      const newMessages = this.annotatePiProviderErrorMessages(
        snapshot.slice(this.piMainBaselineIndex),
      );
      if (newMessages.length > 0) {
        await this.appendPiCoreMessagesIfMissing(newMessages);
        this.piMainBaselineIndex = snapshot.length;
        this.recordChatThreadObservabilityEvent("pi_turn_end_persisted", {
          operation: "handle_pi_session_event",
          status: "turn_end",
          count: newMessages.length,
        });
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
        const buffered = isAssistant
          ? this.ensurePiAssistantTextMessage([event.message], text)
          : [event.message];
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
      const status = event.isError ? "failed" : "completed";
      let item: Record<string, unknown> = {
        id: toolCallId,
        type: "dynamicToolCall",
        tool: toolName,
        arguments: args,
        status,
        result: event.result,
      };
      const contentItems = this.piRuntimeContentItems(event.result);
      if (contentItems.length > 0) {
        item.contentItems = contentItems;
      }
      if (toolName.toLowerCase() === "bash") {
        item = this.piRuntimeToolItem(toolCallId, toolName, args, status);
        item.aggregatedOutput = this.piToolResultText(event.result);
        item.result = event.result;
      }
      this.publishPiToolActivity(
        toolCallId,
        toolName,
        args,
        event.isError ? "error" : "complete",
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
      const inFlightMessages = await this.loadPiInFlightMessages();
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
          this.recordChatThreadObservabilityEvent("pi_user_stop_persisted", {
            operation: "handle_pi_session_event",
            status: "agent_end",
            count: messagesToPersist.length,
          });
        }
      }
      this.clearPiInFlightMessages();
      if (droppedInFlight > 0 && !stoppedByUser) {
        this.recordChatThreadObservabilityEvent("pi_in_flight_discarded", {
          operation: "handle_pi_session_event",
          status: "agent_end_without_turn_end",
          count: droppedInFlight,
        });
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
      this.clearPiTurnRecovery();
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

    const orgStub = this.env.ORG.get(
      this.env.ORG.idFromName(this.chatContext.orgId),
    );
    await orgStub.recordUsage({
      workspace_id: this.chatContext.workspaceId,
      user_id: this.chatContext.userId ?? "",
      thread_id: this.chatContext.threadId,
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
    });
  }

  private sendRunnerCommand(message: Record<string, unknown>): boolean {
    if (this.piSession) {
      const type = typeof message.type === "string" ? message.type : "unknown";
      try {
        if (type === "message") {
          const content = typeof message.content === "string" ? message.content : "";
          if (!content.trim()) return false;
          const userMessage: AgentMessage = {
            role: "user",
            content,
            timestamp: Date.now(),
          };
          const shouldStartRecovery = !this.piSession.state.isStreaming;
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
                await this.piSession.prompt(userMessage);
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
                this.clearPiTurnRecovery();
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
          this.clearPiTurnRecovery();
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
    this.broadcastRunnerClients(envelope);
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

  private getRunnerClientSockets(): WebSocket[] {
    return this.ctx.getWebSockets(RUNNER_CLIENT_SOCKET_TAG);
  }

  private isRunnerClientSocket(ws: WebSocket): boolean {
    return this.ctx.getTags(ws).includes(RUNNER_CLIENT_SOCKET_TAG);
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

  private broadcastRunnerClients(message: object): void {
    const json = JSON.stringify(message);
    const typed = message as { type?: unknown };
    this.trace("broadcast_runner_clients", {
      payloadType: typeof typed.type === "string" ? typed.type : "unknown",
      bytes: json.length,
      recipients: this.getRunnerClientSockets().length,
    });
    for (const ws of this.getRunnerClientSockets()) {
      try {
        ws.send(json);
      } catch {
        // ignore closed sockets
      }
    }
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

  private replayRunnerEvents(ws: WebSocket, lastSeq: number): void {
    for (const envelope of this.chatEventBuffer) {
      const eventId =
        typeof envelope.eventId === "number" ? envelope.eventId : 0;
      if (eventId > lastSeq) {
        this.sendDirect(ws, envelope);
      }
    }
  }

  private normalizeRunnerClientSeq(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value)
      ? Math.max(0, Math.floor(value))
      : 0;
  }

}
