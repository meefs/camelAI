import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { Type } from "typebox";
import type {
  Agent as PiCoreAgent,
  AgentEvent,
  AgentMessage,
  AgentTool,
  AgentToolResult,
} from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import type { OrgDO, UserDO, WorkerScript } from "./auth";
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
import type { IntegrationCategory, LlmModel } from '../../../src/types';
import { decryptCredentials, encryptCredentials } from "../../../src/lib/integration-crypto";
import { parseStoredLlmProviderConfig } from "../../../src/lib/llm-provider-config";
import { isOrgBanned } from "./ban-list";
import { recordWorkspaceThreadStreaming } from "./thread-status";
import {
  getAllIntegrations,
  getIntegrationsByCategory,
  getIntegrationDefinition,
  shouldStoreIntegrationCredentials,
  validateConfig,
  validateCredentials,
} from "../../../src/lib/integration-registry";
import { getEnvVarSuffixesForType, normalizeEnvVarName } from "./integration-env";
import {
  createOrRefreshCustomHostname,
  deleteCustomHostname,
  findCustomHostnameByHostname,
  getCustomHostnameStatus,
  syncAllWorkspaceWorkerSecrets,
  type CfApiProxyEnv,
} from "./cf-api-proxy";
import { createSignedToken } from "./signed-tokens";
import { getPreferredAppUrl } from "../../../src/lib/app-url";
import {
  buildCustomDomainDnsCheck,
  getCustomHostnameDnsTarget,
  type CnameLookupResult,
  type CustomDomainDnsCheck,
} from "../../../src/lib/custom-domain-dns";
import {
  getAppCustomDomainDiagnosticState,
  shouldRefreshAppCustomDomainState,
  shouldRetryAppCustomDomainProvisioning,
} from "../../../src/lib/custom-domain-state";
import {
  getConnection,
  listConnectionMethods,
  listConnections,
  listConnectionTools,
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
import { ensureLegacyHostUsageBackfilled } from "./legacy-usage-backfill-gate";

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
  model: LlmModel;
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
  receiveBugReportCaptureResponse(response: BugReportCaptureResponse): void;
}

type PiBillingSource = "hosted" | "byok";

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

interface PiToolDefinitionOptions {
  includeSubagents?: boolean;
}

export interface ChatEnv extends WorkspaceContainerEnv {
  CHAT_THREAD: DurableObjectNamespace<ChatThreadDO>;
  ORG: DurableObjectNamespace<OrgDO>;
  USER: DurableObjectNamespace<UserDO>;
  WORKSPACE: DurableObjectNamespace<WorkspaceDO>;
  WORKSPACE_CRON?: DurableObjectNamespace<WorkspaceCronDO>;
  WORKER_LOGS?: DurableObjectNamespace<WorkerLogsDO>;
  MCP_OBJECT: DurableObjectNamespace;
  APP_KV: KVNamespace;
  R2_BUCKET: R2Bucket;
  AI: Ai;
  ANTHROPIC_API_KEY: string;
  CF_ACCOUNT_ID?: string;
  CF_GATEWAY_NAME?: string;
  CF_GATEWAY_TOKEN?: string;
  TOKEN_SIGNING_SECRET: string;
  AI_GATEWAY_AUTH_TOKEN?: string;
  CF_DISPATCH_NAMESPACE?: string;
  EMAIL_TO_USER: KVNamespace;
  R2_MOUNT_DIR?: string;
  PLATFORM_SCRIPT_TOKENS?: KVNamespace;
  SANDBOX_PROXY_SECRET?: string;
  CODE_MODE_LOADER?: WorkerLoader;
  CF_ZONE_ID?: string;
  CF_API_TOKEN?: string;
  CF_CUSTOM_HOSTNAME_FALLBACK?: string;
  CF_CUSTOM_HOSTNAME_CNAME_TARGET?: string;
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

interface PendingConnectionSetupPromptInfo {
  createdAt: number;
  integrationType: string;
  suggestedName?: string;
  message?: string;
  instructions?: string;
  dynamicSchema?: DynamicIntegrationSchema;
}

// Pending bug report capture with MCP callback info
interface PendingBugReportInfo {
  mcpDoId: string;
  createdAt: number;
  message?: string;
}

export interface ChatContextState {
  threadId: string;
  workspaceId: string;
  orgId: string;
  provider?: 'claude' | 'codex';
  userId: string | null;
  userName: string | null;
  userEmail: string | null;
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

function cloneDurableState<T>(value: T): T {
  if (value === null || value === undefined) {
    return value;
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

interface PendingQuestionInfo {
  questionId: string;
  toolUseId?: string;
  questions: unknown[];
}

interface NormalizedAskQuestionOption {
  label: string;
  description: string;
}

interface NormalizedAskQuestion {
  question: string;
  header: string;
  options: NormalizedAskQuestionOption[];
  multiSelect: boolean;
}

type NormalizedTodoStatus = "pending" | "in_progress" | "completed";

interface NormalizedTodoItem {
  content: string;
  status: NormalizedTodoStatus;
  activeForm: string;
}

interface PendingQuestionWaiter {
  resolve: (answers: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

interface PendingConnectionSetupWaiter {
  resolve: (response: ConnectionSetupResponse) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
  info: PendingConnectionSetupPromptInfo;
}

interface PendingBugReportWaiter {
  resolve: (response: BugReportCaptureResponse) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
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

export interface ExternalMessageRequest {
  threadId?: string;
  workspaceId?: string;
  orgId?: string;
  userId?: string | null;
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

interface CodeModeToolsProps {
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

interface CodeModeToolDefinition {
  name: string;
  description: string;
  parameters?: unknown;
}

interface LegacyParsedChatMessageForPi {
  id?: unknown;
  role?: unknown;
  content?: unknown;
  created_at?: unknown;
  forkEntryId?: unknown;
}

type WebProvider = "firecrawl" | "parallel" | "exa";

interface WebResult {
  title?: string;
  url?: string;
  publishedDate?: string;
  author?: string;
  snippet?: string;
  text?: string;
}

interface WebProviderResult {
  provider: WebProvider;
  results: WebResult[];
  costUSD: number;
}

const CODE_MODE_COMPATIBILITY_DATE = "2026-05-11";
const CODE_MODE_DEFAULT_TIMEOUT_MS = 60_000;
const CODE_MODE_MAX_TIMEOUT_MS = 120_000;
const CODE_MODE_DEFAULT_MAX_OUTPUT_CHARACTERS = 60_000;
const CODE_MODE_MAX_OUTPUT_CHARACTERS = 200_000;
const WEB_PROVIDER_DEFAULT_ORDER: WebProvider[] = ["firecrawl", "parallel", "exa"];
const WEB_PROVIDER_ROUND_ROBIN_KEY = "code-mode:web-provider:index";
const WEB_PROVIDER_TIMEOUT_MS = 20_000;
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

function normalizeCodeModeArgs(args: unknown): Record<string, unknown> {
  if (args == null) return {};
  if (typeof args !== "object" || Array.isArray(args)) {
    throw new Error("tool arguments must be an object");
  }
  return args as Record<string, unknown>;
}

function normalizeAskQuestionOption(value: unknown): NormalizedAskQuestionOption | null {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const label = String(value).trim();
    return label ? { label, description: "" } : null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const rawLabel = record.label ?? record.value ?? record.text ?? record.name;
  const label = typeof rawLabel === "string" || typeof rawLabel === "number" || typeof rawLabel === "boolean"
    ? String(rawLabel).trim()
    : "";
  if (!label) return null;
  const description = typeof record.description === "string" ? record.description.trim() : "";
  return { label, description };
}

function normalizeAskQuestion(value: unknown): NormalizedAskQuestion | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const question = typeof record.question === "string" && record.question.trim()
    ? record.question.trim()
    : typeof record.prompt === "string" && record.prompt.trim()
      ? record.prompt.trim()
      : "";
  if (!question) return null;
  const header = typeof record.header === "string" && record.header.trim()
    ? record.header.trim()
    : typeof record.label === "string" && record.label.trim()
      ? record.label.trim()
      : "";
  const options = Array.isArray(record.options)
    ? record.options
        .map(normalizeAskQuestionOption)
        .filter((option): option is NormalizedAskQuestionOption => option !== null)
    : [];
  return {
    question,
    header,
    options,
    multiSelect: record.multiSelect === true || record.multi_select === true,
  };
}

function normalizeAskQuestions(values: unknown[]): NormalizedAskQuestion[] {
  return values
    .map(normalizeAskQuestion)
    .filter((question): question is NormalizedAskQuestion => question !== null);
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

function stringParam(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  return typeof value === "string" ? value.trim() : "";
}

function boolParam(params: Record<string, unknown>, key: string): boolean {
  return params[key] === true;
}

function defaultString(value: string, fallback: string): string {
  return value.trim() ? value : fallback;
}

function contentString(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map(contentString).map((text) => text.trim()).filter(Boolean).join("\n\n");
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function webFirstString(values: Record<string, unknown> | undefined, ...keys: string[]): string {
  if (!values) return "";
  for (const key of keys) {
    const text = contentString(values[key]).trim();
    if (text) return text;
  }
  return "";
}

function firstContent(values: Record<string, unknown>, ...keys: string[]): string {
  return webFirstString(values, ...keys);
}

function webNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function webPayloadMessage(payload: Record<string, unknown>): string {
  const error = payload.error;
  if (typeof error === "string" && error.trim()) return error.trim();
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  const message = payload.message;
  if (typeof message === "string" && message.trim()) return message.trim();
  return "unknown error";
}

function normalizeWebDomains(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    let domain = String(entry ?? "").trim();
    if (!domain) continue;
    if (!domain.includes("://")) domain = `https://${domain}`;
    try {
      const parsed = new URL(domain);
      if (parsed.hostname) domain = parsed.hostname;
    } catch {
      // Keep the caller-provided value and normalize below.
    }
    domain = domain.toLowerCase().replace(/^\.+|\.+$/g, "");
    if (domain) out.push(domain);
    if (out.length >= 20) break;
  }
  return out;
}

function anyDomainMatches(hostname: string, domains: string[]): boolean {
  return domains.some((domain) => {
    const normalized = domain.toLowerCase().replace(/^\.+|\.+$/g, "");
    return hostname === normalized || hostname.endsWith(`.${normalized}`);
  });
}

function filterWebDomains(results: WebResult[], includeDomains: string[], excludeDomains: string[]): WebResult[] {
  return results.filter((result) => {
    if (!result.url) return false;
    let hostname = "";
    try {
      hostname = new URL(result.url).hostname.toLowerCase();
    } catch {
      return false;
    }
    if (includeDomains.length > 0 && !anyDomainMatches(hostname, includeDomains)) return false;
    if (anyDomainMatches(hostname, excludeDomains)) return false;
    return true;
  });
}

function dateOnly(value: unknown): string {
  const match = String(value ?? "").trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? match[0] : "";
}

function firecrawlDate(date: string): string {
  const parts = date.split("-");
  return parts.length === 3 ? `${parts[1]}/${parts[2]}/${parts[0]}` : date;
}

function firecrawlTimeFilter(startValue: unknown, endValue: unknown): string {
  const start = dateOnly(startValue);
  const end = dateOnly(endValue);
  if (!start && !end) return "";
  const parts = ["cdr:1"];
  if (start) parts.push(`cd_min:${firecrawlDate(start)}`);
  if (end) parts.push(`cd_max:${firecrawlDate(end)}`);
  return parts.join(",");
}

function firecrawlCategories(category: unknown): string[] | undefined {
  switch (String(category ?? "").trim()) {
    case "github":
      return ["github"];
    case "pdf":
      return ["pdf"];
    case "research paper":
      return ["research"];
    default:
      return undefined;
  }
}

function firecrawlSources(category: unknown): string[] {
  return String(category ?? "").trim() === "news" ? ["web", "news"] : ["web"];
}

function firecrawlQuery(query: string, includeDomains: string[], excludeDomains: string[], category: unknown): string {
  const parts = [query];
  if (String(category ?? "").trim() === "pdf") parts.push("filetype:pdf");
  if (includeDomains.length === 1) parts.push(`site:${includeDomains[0]}`);
  for (const domain of excludeDomains) parts.push(`-site:${domain}`);
  return parts.join(" ");
}

function parallelMode(value: unknown): string {
  return String(value ?? "").trim() === "fast" ? "basic" : "advanced";
}

function parallelUsageCostUSD(payload: Record<string, unknown>): number {
  if (!Array.isArray(payload.usage)) return 0;
  let total = 0;
  for (const entry of payload.usage) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const item = entry as Record<string, unknown>;
    const count = webNumber(item.count) ?? 1;
    switch (String(item.name ?? "").trim()) {
      case "sku_search":
        total += count * 0.005;
        break;
      case "sku_extract_excerpts":
      case "sku_extract_full_content":
        total += count * 0.001;
        break;
    }
  }
  return total;
}

function exaCostUSD(payload: Record<string, unknown>): number {
  const cost = payload.costDollars;
  if (!cost || typeof cost !== "object" || Array.isArray(cost)) return 0;
  return webNumber((cost as Record<string, unknown>).total) ?? 0;
}

function normalizeFirecrawlResult(entry: unknown, includeContent: boolean): WebResult | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const item = entry as Record<string, unknown>;
  const metadata = item.metadata && typeof item.metadata === "object" && !Array.isArray(item.metadata)
    ? item.metadata as Record<string, unknown>
    : undefined;
  const targetURL = webFirstString(item, "url", "sourceURL") || webFirstString(metadata, "sourceURL", "url");
  if (!targetURL) return null;
  const result: WebResult = {
    title: defaultString(webFirstString(item, "title"), webFirstString(metadata, "title", "ogTitle")),
    url: targetURL,
    publishedDate: defaultString(
      webFirstString(item, "publishedDate", "published_date", "date"),
      webFirstString(metadata, "publishedDate", "publishedTime", "date"),
    ),
    author: defaultString(webFirstString(item, "author"), webFirstString(metadata, "author")),
    snippet: firstContent(item, "description", "snippet"),
  };
  if (includeContent) {
    result.text = firstContent(item, "markdown", "text", "summary", "content") || result.snippet;
  }
  return result;
}

function firecrawlEntries(payload: Record<string, unknown>): unknown[] {
  if (Array.isArray(payload.data)) return payload.data;
  if (!payload.data || typeof payload.data !== "object" || Array.isArray(payload.data)) return [];
  const data = payload.data as Record<string, unknown>;
  return ["web", "news", "images"].flatMap((key) => Array.isArray(data[key]) ? data[key] as unknown[] : []);
}

function normalizeParallelResults(value: unknown, includeContent: boolean): WebResult[] {
  if (!Array.isArray(value)) return [];
  const results: WebResult[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const item = entry as Record<string, unknown>;
    const targetURL = webFirstString(item, "url");
    if (!targetURL) continue;
    results.push({
      title: webFirstString(item, "title"),
      url: targetURL,
      publishedDate: webFirstString(item, "publish_date", "publishedDate", "published_date"),
      snippet: firstContent(item, "description", "snippet", "excerpts"),
      text: includeContent ? defaultString(contentString(item.full_content), contentString(item.excerpts)) : "",
    });
  }
  return results;
}

function normalizeExaResults(value: unknown, includeContent: boolean): WebResult[] {
  if (!Array.isArray(value)) return [];
  const results: WebResult[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const item = entry as Record<string, unknown>;
    const targetURL = webFirstString(item, "url");
    if (!targetURL) continue;
    results.push({
      title: webFirstString(item, "title"),
      url: targetURL,
      publishedDate: webFirstString(item, "publishedDate"),
      author: webFirstString(item, "author"),
      snippet: firstContent(item, "snippet", "description", "highlights"),
      text: includeContent ? firstContent(item, "text", "summary", "highlights") : "",
    });
  }
  return results;
}

function truncateWebResultText(text: unknown, maxCharacters: number): string {
  return truncateCodeModeText(String(text ?? "").trim(), maxCharacters).trim();
}

function truncateWebResults(results: WebResult[], limit: number, maxCharacters: number): WebResult[] {
  return results.slice(0, Math.max(0, limit)).map((result) => ({
    ...result,
    snippet: truncateWebResultText(result.snippet, maxCharacters),
    text: truncateWebResultText(result.text, maxCharacters),
  }));
}

function formatWebResults(results: WebResult[], maxCharacters: number, empty: string): string {
  if (results.length === 0) return empty;
  return results.map((result, index) => {
    const lines = [`${index + 1}. ${result.title?.trim() || "Untitled"}`];
    if (result.url) lines.push(`URL: ${result.url}`);
    if (result.publishedDate) lines.push(`Published: ${result.publishedDate}`);
    if (result.author) lines.push(`Author: ${result.author}`);
    const snippet = truncateWebResultText(result.snippet, maxCharacters);
    if (snippet) lines.push(`Snippet: ${snippet}`);
    const text = truncateWebResultText(result.text, maxCharacters);
    if (text) lines.push("", text);
    return lines.join("\n");
  }).join("\n\n");
}

function isIntegrationCategory(value: string): value is IntegrationCategory {
  return value === "databases" ||
    value === "saas" ||
    value === "ai_services" ||
    value === "cloud_providers" ||
    value === "communication";
}

const CODE_MODE_TOOL_DEFINITIONS: CodeModeToolDefinition[] = [
  {
    name: "bash",
    description: "Run a shell command inside the sandbox container. Arguments: { command, cwd?, timeout? }.",
  },
  {
    name: "read",
    description: "Read a UTF-8 file from the sandbox workspace. Arguments: { path }.",
  },
  {
    name: "write",
    description: "Write a UTF-8 file into the sandbox workspace. Arguments: { path, content }.",
  },
  {
    name: "ls",
    description: "List files in the sandbox workspace. Arguments: { path?, recursive?, includeHidden? }.",
  },
  {
    name: "edit",
    description: PI_CONTAINER_TOOL_DEFINITIONS.edit.description,
  },
  {
    name: "grep",
    description: PI_CONTAINER_TOOL_DEFINITIONS.grep.description,
  },
  {
    name: "find",
    description: PI_CONTAINER_TOOL_DEFINITIONS.find.description,
  },
  {
    name: "AskUserQuestion",
    description: "Ask the user one or more multiple-choice questions in the chat UI and wait for answers. Arguments: { questions }.",
  },
  {
    name: "ask_user_question",
    description: "Alias for AskUserQuestion. Arguments: { questions }.",
  },
  {
    name: "TodoWrite",
    description: "Update the visible task list in the chat UI. Arguments: { todos: [{ content, status, activeForm? }] }. Status is pending, in_progress, or completed.",
  },
  {
    name: "set_preview",
    description: "Set the active preview to an app or file. Arguments: { script_name?, app_name?, is_public?, path?, content_type? }.",
  },
  {
    name: "list_apps",
    description: "List deployed apps for the current workspace.",
  },
  {
    name: "set_app_visibility",
    description: "Change a deployed app visibility. Arguments: { script_name, is_public }.",
  },
  {
    name: "get_latest_logs",
    description: "Get recent logs for a deployed app. Arguments: { script_name, limit?, since_ms? }.",
  },
  {
    name: "list_scheduled_prompts",
    description: "List scheduled prompts for the current workspace.",
  },
  {
    name: "create_scheduled_prompt",
    description: "Create a scheduled prompt. Arguments: { name, prompt, cron_expression, enabled? }.",
  },
  {
    name: "update_scheduled_prompt",
    description: "Update a scheduled prompt. Arguments: { prompt_id, name?, prompt?, cron_expression?, enabled? }.",
  },
  {
    name: "delete_scheduled_prompt",
    description: "Delete a scheduled prompt. Arguments: { prompt_id }.",
  },
  {
    name: "run_scheduled_prompt_now",
    description: "Trigger a scheduled prompt immediately. Arguments: { prompt_id }.",
  },
  {
    name: "list_integrations",
    description: "List configured integrations for the current workspace. Arguments: { category? }.",
  },
  {
    name: "list_integration_types",
    description: "List available integration types. Arguments: { category? }.",
  },
  {
    name: "create_integration",
    description: "Create an integration. Arguments: { integration_type, name, config?, credentials? }.",
  },
  {
    name: "prompt_connection_setup",
    description: "Prompt the user to set up a connection in the chat UI and wait for completion. Use this as a top-level tool, not from js_exec. Arguments: { integration_type, suggested_name?, message?, display_name?, description?, instructions?, fields? }.",
  },
  {
    name: "capture_bug_report",
    description: "Prompt the browser to capture a deployed-app bug report. Arguments: { message? }.",
  },
  {
    name: "get_custom_domain",
    description: "Get custom domain diagnostics for deployed apps.",
  },
  {
    name: "set_custom_domain",
    description: "Set an exact custom hostname for an app. Arguments: { app_name, hostname }.",
  },
  {
    name: "remove_custom_domain",
    description: "Remove a custom hostname from an app. Arguments: { app_name }.",
  },
  {
    name: "retry_custom_domain_hostnames",
    description: "Retry hostname provisioning for configured app custom domains.",
  },
  {
    name: "WebSearch",
    description: "Search the web. Arguments: { query, numResults?, maxCharacters? }.",
  },
  {
    name: "web_search",
    description: "Alias for WebSearch. Arguments: { query, numResults?, maxCharacters? }.",
  },
  {
    name: "WebFetch",
    description: "Fetch text from a URL. Arguments: { url, maxCharacters? }.",
  },
  {
    name: "web_fetch",
    description: "Alias for WebFetch. Arguments: { url, maxCharacters? }.",
  },
  {
    name: "Agent",
    description: "Run a focused subagent in the same workspace. Arguments: { prompt, description?, agent?, model? }.",
  },
  {
    name: "agent",
    description: "Alias for Agent. Arguments: { prompt, description?, agent?, model? }.",
  },
  {
    name: "Explore",
    description: "Run a focused read-oriented exploration subagent in the same workspace. Arguments: { prompt? or query?, description?, agent?, model? }.",
  },
  {
    name: "explore",
    description: "Alias for Explore. Arguments: { prompt? or query?, description?, agent?, model? }.",
  },
  {
    name: "connections_list",
    description: "List workspace connections. Prefer CONNECTIONS.list().",
  },
  {
    name: "connections_get",
    description: "Get one workspace connection. Prefer CONNECTIONS.get(connection). Arguments: { connection }.",
  },
  {
    name: "connections_tools",
    description: "List tools for a workspace connection. Prefer CONNECTIONS.tools(connection). Arguments: { connection }.",
  },
  {
    name: "connections_methods",
    description: "List workspace connections and their method aliases, tool names, and input schemas. Prefer CONNECTIONS.methods().",
  },
];

function codeModePiToolParameters(name: string) {
  switch (name) {
    case "bash":
      return PI_CONTAINER_TOOL_DEFINITIONS.bash.parameters;
    case "read":
      return PI_CONTAINER_TOOL_DEFINITIONS.read.parameters;
    case "write":
      return PI_CONTAINER_TOOL_DEFINITIONS.write.parameters;
    case "ls":
      return PI_CONTAINER_TOOL_DEFINITIONS.ls.parameters;
    case "edit":
      return PI_CONTAINER_TOOL_DEFINITIONS.edit.parameters;
    case "grep":
      return PI_CONTAINER_TOOL_DEFINITIONS.grep.parameters;
    case "find":
      return PI_CONTAINER_TOOL_DEFINITIONS.find.parameters;
    case "WebSearch":
    case "web_search":
      return Type.Object({
        query: Type.String(),
        numResults: Type.Optional(Type.Number()),
        maxCharacters: Type.Optional(Type.Number()),
        includeDomains: Type.Optional(Type.Array(Type.String())),
        excludeDomains: Type.Optional(Type.Array(Type.String())),
        startPublishedDate: Type.Optional(Type.String()),
        endPublishedDate: Type.Optional(Type.String()),
        searchType: Type.Optional(Type.String()),
        category: Type.Optional(Type.String()),
      });
    case "WebFetch":
    case "web_fetch":
      return Type.Object({
        url: Type.String(),
        maxCharacters: Type.Optional(Type.Number()),
        query: Type.Optional(Type.String()),
        fresh: Type.Optional(Type.Boolean()),
        content: Type.Optional(Type.String()),
      });
    case "AskUserQuestion":
    case "ask_user_question":
      return Type.Object({
        questions: Type.Array(Type.Object({}, { additionalProperties: true })),
      });
    case "TodoWrite":
      return Type.Object({
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
      });
    case "set_preview":
      return Type.Object({
        script_name: Type.Optional(Type.String()),
        app_name: Type.Optional(Type.String()),
        is_public: Type.Optional(Type.Boolean()),
        path: Type.Optional(Type.String()),
        content_type: Type.Optional(Type.String()),
      });
    case "get_latest_logs":
      return Type.Object({
        script_name: Type.String(),
        limit: Type.Optional(Type.Number()),
        since_ms: Type.Optional(Type.Number()),
      });
    case "set_app_visibility":
      return Type.Object({
        script_name: Type.String(),
        is_public: Type.Boolean(),
      });
    case "create_scheduled_prompt":
      return Type.Object({
        name: Type.String(),
        prompt: Type.String(),
        cron_expression: Type.String(),
        enabled: Type.Optional(Type.Boolean()),
      });
    case "update_scheduled_prompt":
      return Type.Object({
        prompt_id: Type.String(),
        name: Type.Optional(Type.String()),
        prompt: Type.Optional(Type.String()),
        cron_expression: Type.Optional(Type.String()),
        enabled: Type.Optional(Type.Boolean()),
      });
    case "delete_scheduled_prompt":
    case "run_scheduled_prompt_now":
      return Type.Object({
        prompt_id: Type.String(),
      });
    case "list_integrations":
    case "list_integration_types":
      return Type.Object({
        category: Type.Optional(Type.String()),
      });
    case "create_integration":
      return Type.Object({
        integration_type: Type.String(),
        name: Type.String(),
        config: Type.Optional(Type.Object({}, { additionalProperties: true })),
        credentials: Type.Optional(Type.Object({}, { additionalProperties: true })),
      });
    case "prompt_connection_setup":
      return Type.Object({
        integration_type: Type.String(),
        suggested_name: Type.Optional(Type.String()),
        message: Type.Optional(Type.String()),
        display_name: Type.Optional(Type.String()),
        description: Type.Optional(Type.String()),
        instructions: Type.Optional(Type.String()),
        fields: Type.Optional(Type.Array(Type.Object({}, { additionalProperties: true }))),
      });
    case "capture_bug_report":
      return Type.Object({
        message: Type.Optional(Type.String()),
      });
    case "set_custom_domain":
      return Type.Object({
        app_name: Type.String(),
        hostname: Type.String(),
      });
    case "remove_custom_domain":
      return Type.Object({
        app_name: Type.String(),
      });
    case "connections_get":
    case "connections_tools":
      return Type.Object({
        connection: Type.String(),
      });
    case "connections_list":
    case "connections_methods":
      return Type.Object({});
    default:
      return Type.Object({}, { additionalProperties: true });
  }
}

function codeModeToolDefinitionWithParameters(
  definition: CodeModeToolDefinition,
): CodeModeToolDefinition {
  return {
    ...definition,
    parameters: codeModePiToolParameters(definition.name),
  };
}

export class CodeModeToolsBinding extends WorkerEntrypoint<ChatEnv, CodeModeToolsProps> {
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

  private async createContainerCommandEnv(): Promise<Record<string, string>> {
    return {
      ...(await this.workspace.buildContainerCommandEnv()),
      ...(await this.createWranglerDeployEnv()),
    };
  }

  private async createWranglerDeployEnv(): Promise<Record<string, string>> {
    const workerBaseUrl = this.env.WORKER_BASE_URL?.trim().replace(/\/+$/, "");
    const tokenSecret = this.env.TOKEN_SIGNING_SECRET?.trim();
    const { orgId, workspaceId, userId, threadId } = this.ctx.props;
    if (!workerBaseUrl || !tokenSecret || !orgId || !workspaceId) {
      return {};
    }

    const orgSlug = await this.getOrgSlug();
    if (!orgSlug) {
      return {};
    }

    const token = await createSignedToken(tokenSecret, {
      org_id: orgId,
      org_slug: orgSlug,
      user_id: userId,
      scopes: ["deploy"],
      exp: Date.now() + 12 * 60 * 60 * 1000,
      workspace_id: workspaceId,
      thread_id: threadId,
      name: `workspace-${workspaceId}-wrangler-deploy`,
    });

    return {
      CLOUDFLARE_API_BASE_URL: `${workerBaseUrl}/client/v4`,
      CLOUDFLARE_API_TOKEN: token,
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
      .filter((definition) => !JS_EXEC_EXCLUDED_TOOL_NAMES.has(definition.name))
      .map(codeModeToolDefinitionWithParameters);
  }

  async callTool(name: string, rawArgs: unknown = {}): Promise<unknown> {
    const args = normalizeCodeModeArgs(rawArgs);
    switch (name) {
      case "bash":
        return this.piContainerTools.callTool("bash", args);

      case "read":
        {
          const path = typeof args.path === "string" ? args.path : "";
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
        return this.piContainerTools.callTool("write", args);

      case "ls":
        {
          if (typeof args.path === "string") {
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
        return this.piContainerTools.callTool("edit", args);

      case "grep":
        return this.piContainerTools.callTool("grep", args);

      case "find":
        return this.piContainerTools.callTool("find", args);

      case "AskUserQuestion":
      case "ask_user_question":
        return this.chatThreadStub.askUserQuestion({
          questions: Array.isArray(args.questions) ? args.questions : [args],
          toolUseId: typeof args.toolUseId === "string" ? args.toolUseId : undefined,
        });

      case "TodoWrite":
        return this.updateTodos(args);

      case "set_preview":
        return this.setPreview(args);

      case "list_apps":
        return this.listApps();

      case "set_app_visibility":
        return this.setAppVisibility(args);

      case "get_latest_logs":
        return this.getLatestLogs(args);

      case "list_scheduled_prompts":
        return this.listScheduledPrompts();

      case "create_scheduled_prompt":
        return this.createScheduledPrompt(args);

      case "update_scheduled_prompt":
        return this.updateScheduledPrompt(args);

      case "delete_scheduled_prompt":
        return this.deleteScheduledPrompt(args);

      case "run_scheduled_prompt_now":
        return this.runScheduledPromptNow(args);

      case "list_integrations":
        return this.listIntegrations(args);

      case "list_integration_types":
        return this.listIntegrationTypes(args);

      case "create_integration":
        return this.createIntegration(args);

      case "prompt_connection_setup":
        return this.promptConnectionSetup(args);

      case "capture_bug_report":
        return this.chatThreadStub.captureBugReport({
          message: typeof args.message === "string" ? args.message : undefined,
        });

      case "get_custom_domain":
        return this.getCustomDomain();

      case "set_custom_domain":
        return this.setCustomDomain(args);

      case "remove_custom_domain":
        return this.removeCustomDomain(args);

      case "retry_custom_domain_hostnames":
        return this.retryCustomDomainHostnames();

      case "WebSearch":
      case "web_search":
        return this.webSearch(args);

      case "WebFetch":
      case "web_fetch":
        return this.webFetch(args);

      case "Agent":
      case "agent":
      case "Explore":
      case "explore":
        return (this.chatThreadStub as unknown as {
          runCodeModeSubagent(toolName: "Agent" | "agent" | "Explore" | "explore", params: unknown): Promise<AgentToolResult<unknown>>;
        }).runCodeModeSubagent(name, args);

      case "connections_list":
        return listConnections(this.env, this.connectionsContext);

      case "connections_get": {
        const connection = typeof args.connection === "string" ? args.connection : "";
        if (!connection) throw new Error("connection is required");
        return getConnection(this.env, this.connectionsContext, connection);
      }

      case "connections_tools": {
        const connection = typeof args.connection === "string" ? args.connection : "";
        if (!connection) throw new Error("connection is required");
        return listConnectionTools(this.env, this.connectionsContext, connection);
      }

      case "connections_methods":
        return listConnectionMethods(this.env, this.connectionsContext);

      default:
        throw new Error(`Unknown code mode tool: ${name}`);
    }
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
    const normalizedPath = filePath.startsWith("/") ? filePath : `/${filePath}`;
    const target: PreviewTarget = {
      kind: "file",
      source: "workspace",
      workspaceId: this.ctx.props.workspaceId,
      path: normalizedPath,
      filename: normalizedPath.split("/").filter(Boolean).pop() ?? "file",
      contentType: typeof args.content_type === "string" ? args.content_type : undefined,
    };
    await this.chatThreadStub.setPreviewTarget(target);
    return { success: true, target };
  }

  private formatScheduledPrompt(prompt: {
    id: string;
    name: string;
    prompt: string;
    cron_expression: string;
    thread_id: string;
    scheduled_by_thread_id: string | null;
    enabled: boolean;
    created_by: string;
    created_at: number;
    updated_at: number;
    next_run_at: number | null;
    last_run_at: number | null;
    last_run_status: string | null;
    last_run_error: string | null;
    run_count: number;
  }): Record<string, unknown> {
    return {
      id: prompt.id,
      name: prompt.name,
      prompt: prompt.prompt,
      cron_expression: prompt.cron_expression,
      thread_id: prompt.thread_id,
      scheduled_by_thread_id: prompt.scheduled_by_thread_id,
      enabled: prompt.enabled,
      created_by: prompt.created_by,
      created_at: new Date(prompt.created_at).toISOString(),
      updated_at: new Date(prompt.updated_at).toISOString(),
      next_run_at: prompt.next_run_at ? new Date(prompt.next_run_at).toISOString() : null,
      last_run_at: prompt.last_run_at ? new Date(prompt.last_run_at).toISOString() : null,
      last_run_status: prompt.last_run_status,
      last_run_error: prompt.last_run_error,
      run_count: prompt.run_count,
    };
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

  private async listScheduledPrompts(): Promise<unknown> {
    const prompts = await this.cronStub.listScheduledPrompts(this.ctx.props.workspaceId);
    return {
      success: true,
      count: prompts.length,
      timezone: "UTC",
      prompts: prompts.map((prompt) => this.formatScheduledPrompt(prompt)),
    };
  }

  private async createScheduledPrompt(args: Record<string, unknown>): Promise<unknown> {
    const name = typeof args.name === "string" ? args.name : "";
    const prompt = typeof args.prompt === "string" ? args.prompt : "";
    const cronExpression =
      typeof args.cron_expression === "string" ? args.cron_expression : "";
    if (!name.trim()) throw new Error("name is required");
    if (!prompt.trim()) throw new Error("prompt is required");
    if (!cronExpression.trim()) throw new Error("cron_expression is required");
    const created = await this.cronStub.createScheduledPrompt({
      workspaceId: this.ctx.props.workspaceId,
      name,
      prompt,
      cronExpression,
      createdBy: this.ctx.props.userId || "system",
      scheduledByThreadId: this.ctx.props.threadId,
      enabled: typeof args.enabled === "boolean" ? args.enabled : undefined,
    });
    return {
      success: true,
      timezone: "UTC",
      scheduled_prompt: this.formatScheduledPrompt(created),
      message: `Created scheduled prompt "${created.name}"`,
    };
  }

  private async updateScheduledPrompt(args: Record<string, unknown>): Promise<unknown> {
    const promptId = typeof args.prompt_id === "string" ? args.prompt_id.trim() : "";
    if (!promptId) throw new Error("prompt_id is required");
    const updated = await this.cronStub.updateScheduledPrompt({
      workspaceId: this.ctx.props.workspaceId,
      id: promptId,
      name: typeof args.name === "string" ? args.name : undefined,
      prompt: typeof args.prompt === "string" ? args.prompt : undefined,
      cronExpression: typeof args.cron_expression === "string" ? args.cron_expression : undefined,
      enabled: typeof args.enabled === "boolean" ? args.enabled : undefined,
    });
    if (!updated) return { success: false, error: `Scheduled prompt "${promptId}" not found` };
    return {
      success: true,
      timezone: "UTC",
      scheduled_prompt: this.formatScheduledPrompt(updated),
      message: `Updated scheduled prompt "${updated.name}"`,
    };
  }

  private async deleteScheduledPrompt(args: Record<string, unknown>): Promise<unknown> {
    const promptId = typeof args.prompt_id === "string" ? args.prompt_id.trim() : "";
    if (!promptId) throw new Error("prompt_id is required");
    const deleted = await this.cronStub.deleteScheduledPrompt(this.ctx.props.workspaceId, promptId);
    if (!deleted) return { success: false, error: `Scheduled prompt "${promptId}" not found` };
    return { success: true, message: `Deleted scheduled prompt "${promptId}"` };
  }

  private async runScheduledPromptNow(args: Record<string, unknown>): Promise<unknown> {
    const promptId = typeof args.prompt_id === "string" ? args.prompt_id.trim() : "";
    if (!promptId) throw new Error("prompt_id is required");
    const result = await this.cronStub.runScheduledPromptNow(this.ctx.props.workspaceId, promptId);
    if (!result) return { success: false, error: `Scheduled prompt "${promptId}" not found` };
    return {
      success: true,
      timezone: "UTC",
      scheduled_prompt: this.formatScheduledPrompt(result.prompt),
      run: {
        status: result.dispatch.status,
        thread_id: result.dispatch.thread_id,
        error: result.dispatch.error,
        reply: result.dispatch.reply,
      },
    };
  }

  private async listIntegrations(args: Record<string, unknown>): Promise<unknown> {
    const category = typeof args.category === "string" ? args.category : "";
    const rawIntegrations = await this.workspaceStub.getIntegrations();
    const integrations = rawIntegrations.map((record) => {
      let parsedConfig: Record<string, unknown> = {};
      try {
        parsedConfig = record.config ? JSON.parse(record.config) : {};
      } catch {
        parsedConfig = {};
      }
      return {
        id: record.id,
        integration_type: record.integration_type,
        name: record.name,
        category: record.category,
        auth_method: record.auth_method,
        has_credentials: Boolean(record.credentials_encrypted),
        created_at: record.created_at,
        updated_at: record.updated_at,
        config: parsedConfig,
      };
    });
    const filtered = category
      ? integrations.filter((integration) => integration.category === category)
      : integrations;
    return {
      count: filtered.length,
      integrations: filtered.map((integration) => {
        const dynamicFields = integration.integration_type === "other" && Array.isArray(integration.config.dynamic_fields)
          ? integration.config.dynamic_fields as DynamicField[]
          : undefined;
        const envVarPrefix = `INT_${normalizeEnvVarName(integration.integration_type)}_${normalizeEnvVarName(integration.name)}`;
        const envVarSuffixes = getEnvVarSuffixesForType(integration.integration_type, dynamicFields);
        return {
          id: integration.id,
          type: integration.integration_type,
          name: integration.name,
          category: integration.category,
          auth_method: integration.auth_method,
          has_credentials: integration.has_credentials,
          created_at: new Date(integration.created_at).toISOString(),
          updated_at: new Date(integration.updated_at).toISOString(),
          env_var_prefix: envVarPrefix,
          env_vars: envVarSuffixes.map((suffix) => `${envVarPrefix}_${suffix}`),
          display_name: integration.integration_type === "other" && typeof integration.config.display_name === "string"
            ? integration.config.display_name
            : undefined,
        };
      }),
    };
  }

  private listIntegrationTypes(args: Record<string, unknown>): unknown {
    const category = typeof args.category === "string" ? args.category : "";
    const validCategory = isIntegrationCategory(category) ? category : "";
    const definitions = validCategory ? getIntegrationsByCategory(validCategory) : getAllIntegrations();
    const types = definitions.map((definition) => ({
      type: definition.type,
      display_name: definition.displayName,
      description: definition.description,
      category: definition.category,
      auth_method: definition.authMethod,
      config_fields: definition.configSchema.map((field) => ({
        name: field.name,
        label: field.label,
        type: field.type,
        required: field.required,
        description: field.description,
      })),
      credential_fields: definition.credentialSchema.map((field) => ({
        name: field.name,
        label: field.label,
        required: field.required,
        description: field.description,
      })),
      supports_proxy: false,
    }));
    const byCategory: Record<string, typeof types> = {};
    for (const type of types) {
      if (!byCategory[type.category]) byCategory[type.category] = [];
      byCategory[type.category].push(type);
    }
    return { total_count: types.length, by_category: byCategory };
  }

  private async createIntegration(args: Record<string, unknown>): Promise<unknown> {
    const integrationType = typeof args.integration_type === "string" ? args.integration_type.trim() : "";
    const name = typeof args.name === "string" ? args.name.trim() : "";
    const config = args.config && typeof args.config === "object" ? args.config as Record<string, unknown> : {};
    const credentials = args.credentials && typeof args.credentials === "object" ? args.credentials as Record<string, unknown> : {};
    if (!integrationType) throw new Error("integration_type is required");
    if (!name) throw new Error("name is required");
    const definition = getIntegrationDefinition(integrationType);
    if (!definition) {
      return {
        success: false,
        error: `Unknown integration type: ${integrationType}. Use list_integration_types to see available types.`,
      };
    }
    const configErrors = validateConfig(integrationType, config);
    if (configErrors.length > 0) {
      return { success: false, error: "Invalid configuration", validation_errors: configErrors };
    }
    const credentialErrors = validateCredentials(integrationType, credentials);
    if (credentialErrors.length > 0) {
      return { success: false, error: "Invalid credentials", validation_errors: credentialErrors };
    }
    const credentialsEncrypted = shouldStoreIntegrationCredentials(integrationType, credentials)
      ? await encryptCredentials(credentials, this.env.INTEGRATION_SECRET_KEY)
      : "";
    const integrationId = crypto.randomUUID();
    await this.workspaceStub.createIntegration(
      integrationId,
      integrationType,
      name,
      definition.category,
      definition.authMethod,
      JSON.stringify(config),
      credentialsEncrypted,
      this.ctx.props.userId || "system",
    );
    await syncAllWorkspaceWorkerSecrets(
      this.env as unknown as CfApiProxyEnv,
      this.ctx.props.workspaceId,
      this.ctx.props.orgId,
    ).catch((err) => console.error("[CodeModeToolsBinding] Failed to sync integration secrets", err));
    const dynamicFields = integrationType === "other" && Array.isArray(config.dynamic_fields)
      ? config.dynamic_fields as DynamicField[]
      : undefined;
    const envVarPrefix = `INT_${normalizeEnvVarName(integrationType)}_${normalizeEnvVarName(name)}`;
    const envVarSuffixes = getEnvVarSuffixesForType(integrationType, dynamicFields);
    return {
      success: true,
      integration: {
        id: integrationId,
        type: integrationType,
        name,
        category: definition.category,
        env_var_prefix: envVarPrefix,
        env_vars: envVarSuffixes.map((suffix) => `${envVarPrefix}_${suffix}`),
      },
      message: `Integration '${name}' created successfully.`,
    };
  }

  private async promptConnectionSetup(args: Record<string, unknown>): Promise<unknown> {
    const integrationType = typeof args.integration_type === "string" ? args.integration_type.trim() : "";
    if (!integrationType) throw new Error("integration_type is required");
    const definition = getIntegrationDefinition(integrationType);
    if (!definition) {
      return {
        success: false,
        error: `Unknown integration type: ${integrationType}. Use list_integration_types to see available types.`,
      };
    }
    const dynamicSchema = integrationType === "other" && Array.isArray(args.fields)
      ? {
          displayName:
            typeof args.display_name === "string" && args.display_name.trim()
              ? args.display_name.trim()
              : typeof args.suggested_name === "string" && args.suggested_name.trim()
                ? args.suggested_name.trim()
                : "Custom Integration",
          description: typeof args.description === "string" ? args.description : undefined,
          instructions: typeof args.instructions === "string" ? args.instructions : undefined,
          fields: args.fields as DynamicField[],
        }
      : undefined;
    const response = await (this.chatThreadStub as unknown as {
      promptConnectionSetup(input: {
        integrationType: string;
        suggestedName?: string;
        message?: string;
        instructions?: string;
        dynamicSchema?: DynamicIntegrationSchema;
      }): Promise<ConnectionSetupResponse>;
    }).promptConnectionSetup({
      integrationType,
      suggestedName:
        typeof args.suggested_name === "string" && args.suggested_name.trim()
          ? args.suggested_name.trim()
          : dynamicSchema?.displayName ?? definition.displayName,
      message: typeof args.message === "string" ? args.message : undefined,
      instructions: typeof args.instructions === "string" ? args.instructions : undefined,
      dynamicSchema,
    });
    if (response.cancelled) {
      return { success: false, cancelled: true, message: "User cancelled the connection setup" };
    }
    if (!response.integration) {
      return { success: false, error: "Invalid response from user - missing integration data" };
    }
    const { type, name, config, credentials } = response.integration;
    const responseDefinition = getIntegrationDefinition(type);
    if (!responseDefinition) {
      return { success: false, error: `Unknown integration type from user response: ${type}` };
    }
    if (credentials._oauth_completed && credentials.integration_id) {
      const integrationId = String(credentials.integration_id);
      const envVarPrefix = `INT_${normalizeEnvVarName(type)}_${normalizeEnvVarName(name)}`;
      const envVarSuffixes = getEnvVarSuffixesForType(type);
      return {
        success: true,
        integration: {
          id: integrationId,
          type,
          name,
          category: responseDefinition.category,
          env_var_prefix: envVarPrefix,
          env_vars: envVarSuffixes.map((suffix) => `${envVarPrefix}_${suffix}`),
        },
        message: `Integration '${name}' connected successfully via OAuth.`,
      };
    }
    const finalConfig =
      type === "other" && dynamicSchema?.fields.length
        ? {
            ...config,
            display_name: dynamicSchema.displayName,
            dynamic_fields: dynamicSchema.fields,
          }
        : config;
    return this.createIntegration({
      integration_type: type,
      name,
      config: finalConfig,
      credentials,
    });
  }

  private async getCustomDomain(): Promise<unknown> {
    const zoneId = this.env.CF_ZONE_ID?.trim();
    const apiToken = this.env.CF_API_TOKEN?.trim();
    const dnsTarget = getCustomHostnameDnsTarget({
      cnameTarget: this.env.CF_CUSTOM_HOSTNAME_CNAME_TARGET,
      fallbackOrigin: this.env.CF_CUSTOM_HOSTNAME_FALLBACK,
    });
    const scripts = await this.orgStub.listWorkerScriptsByWorkspace(this.ctx.props.workspaceId);
    const now = Date.now();
    const apps = [];
    for (const script of scripts) {
      let currentScript = script;
      if (
        zoneId &&
        apiToken &&
        shouldRefreshAppCustomDomainState(script, null, now) &&
        script.custom_domain_hostname
      ) {
        try {
          let record = null;
          if (script.custom_domain_cf_hostname_id) {
            record = await getCustomHostnameStatus(zoneId, apiToken, script.custom_domain_cf_hostname_id);
          }
          if (!record) {
            record = await findCustomHostnameByHostname(zoneId, apiToken, script.custom_domain_hostname);
          }
          if (record) {
            currentScript =
              (await this.orgStub.updateWorkerScriptCustomDomain(script.script_name, {
                hostname: script.custom_domain_hostname,
                cf_hostname_id: record.id,
                status: record.status,
                ssl_status: record.ssl.status,
                error: null,
              })) ?? currentScript;
          }
        } catch {
          // Keep cached state if Cloudflare diagnostics are unavailable.
        }
      }
      const appState = getAppCustomDomainDiagnosticState(currentScript, null);
      const dnsChecks = { routing_cname: null as CustomDomainDnsCheck | null };
      if (appState.hostname) {
        dnsChecks.routing_cname = buildCustomDomainDnsCheck({
          queried: appState.hostname,
          expectedTarget: dnsTarget,
          lookup: await resolveCnameViaDoH(appState.hostname),
        });
      }
      apps.push({
        name: script.script_name,
        hostname: appState.hostname,
        cf_hostname_id: appState.cf_hostname_id,
        status: appState.status,
        ssl_status: appState.ssl_status,
        error: appState.error,
        updated_at: appState.updated_at,
        dns_checks: dnsChecks,
      });
    }
    const configuredApps = apps.filter((app) => app.hostname);
    const activeCount = configuredApps.filter(
      (app) => app.status === "active" && app.ssl_status === "active",
    ).length;
    return {
      configured: configuredApps.length > 0,
      dns_target: dnsTarget,
      apps,
      message:
        configuredApps.length === 0
          ? "No exact custom domains configured."
          : `${activeCount}/${configuredApps.length} configured custom domains have active SSL.`,
    };
  }

  private async setCustomDomain(args: Record<string, unknown>): Promise<unknown> {
    const appName = typeof args.app_name === "string" ? args.app_name.trim() : "";
    const hostname = typeof args.hostname === "string"
      ? args.hostname.trim().toLowerCase().replace(/\.$/, "")
      : "";
    if (!appName) throw new Error("app_name is required");
    if (!hostname) throw new Error("hostname is required");
    const member = this.ctx.props.userId
      ? await this.orgStub.getMember(this.ctx.props.userId)
      : null;
    if (!member || (member.role !== "owner" && member.role !== "admin")) {
      return { success: false, error: "Only org admins can manage custom domains" };
    }
    const script = await this.orgStub.getWorkerScript(appName);
    if (!script) return { success: false, error: "App not found" };
    if (script.workspace_id !== this.ctx.props.workspaceId) {
      return { success: false, error: `App '${appName}' belongs to a different workspace` };
    }
    const scripts = await this.orgStub.listWorkerScriptsByWorkspace(this.ctx.props.workspaceId);
    const conflictingScript = scripts.find(
      (candidate) =>
        candidate.script_name !== appName &&
        candidate.custom_domain_hostname === hostname,
    );
    if (conflictingScript) {
      return {
        success: false,
        error: `That hostname is already assigned to ${conflictingScript.script_name}`,
      };
    }
    if (
      hostname.includes("*") ||
      !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(hostname)
    ) {
      return { success: false, error: "Invalid exact hostname. Wildcards are not supported." };
    }
    if (hostname.endsWith(".camelai.app") || hostname.endsWith(".camelai.dev")) {
      return { success: false, error: "Cannot use camelAI domains as custom domains" };
    }
    const zoneId = this.env.CF_ZONE_ID?.trim();
    const apiToken = this.env.CF_API_TOKEN?.trim();
    if (!zoneId || !apiToken) {
      return { success: false, error: "Cloudflare API not configured" };
    }
    const dnsTarget = getCustomHostnameDnsTarget({
      cnameTarget: this.env.CF_CUSTOM_HOSTNAME_CNAME_TARGET,
      fallbackOrigin: this.env.CF_CUSTOM_HOSTNAME_FALLBACK,
    });
    try {
      const record = await createOrRefreshCustomHostname(zoneId, apiToken, hostname);
      if (!record) {
        await this.orgStub.updateWorkerScriptCustomDomain(appName, {
          hostname,
          error: "Failed to create or locate Cloudflare custom hostname",
        });
        return { success: false, error: "Failed to create or locate Cloudflare custom hostname" };
      }
      if (script.custom_domain_cf_hostname_id && script.custom_domain_cf_hostname_id !== record.id) {
        await deleteCustomHostname(zoneId, apiToken, script.custom_domain_cf_hostname_id).catch(() => {});
      }
      await this.orgStub.updateWorkerScriptCustomDomain(appName, {
        hostname,
        cf_hostname_id: record.id,
        status: record.status,
        ssl_status: record.ssl.status,
        error: null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.orgStub.updateWorkerScriptCustomDomain(appName, { hostname, error: message });
      return { success: false, error: message };
    }
    return {
      success: true,
      app: appName,
      hostname,
      dns_target: dnsTarget,
      routing_record: `${hostname} CNAME ${dnsTarget}`,
      message: `Custom hostname set for ${appName}. Add ${hostname} CNAME ${dnsTarget}.`,
    };
  }

  private async removeCustomDomain(args: Record<string, unknown>): Promise<unknown> {
    const appName = typeof args.app_name === "string" ? args.app_name.trim() : "";
    if (!appName) throw new Error("app_name is required");
    const member = this.ctx.props.userId
      ? await this.orgStub.getMember(this.ctx.props.userId)
      : null;
    if (!member || (member.role !== "owner" && member.role !== "admin")) {
      return { success: false, error: "Only org admins can manage custom domains" };
    }
    const script = await this.orgStub.getWorkerScript(appName);
    if (!script?.custom_domain_hostname) {
      return { success: false, error: "No custom domain configured for this app" };
    }
    if (script.workspace_id !== this.ctx.props.workspaceId) {
      return { success: false, error: `App '${appName}' belongs to a different workspace` };
    }
    const removedDomain = script.custom_domain_hostname;
    const zoneId = this.env.CF_ZONE_ID?.trim();
    const apiToken = this.env.CF_API_TOKEN?.trim();
    if (zoneId && apiToken && script.custom_domain_cf_hostname_id) {
      await deleteCustomHostname(zoneId, apiToken, script.custom_domain_cf_hostname_id).catch(() => {});
    }
    await this.orgStub.clearWorkerScriptCustomDomain(appName);
    return {
      success: true,
      app: appName,
      removed_domain: removedDomain,
      message: `Custom domain ${removedDomain} removed from ${appName}.`,
    };
  }

  private async retryCustomDomainHostnames(): Promise<unknown> {
    const member = this.ctx.props.userId
      ? await this.orgStub.getMember(this.ctx.props.userId)
      : null;
    if (!member || (member.role !== "owner" && member.role !== "admin")) {
      return { success: false, error: "Only org admins can retry hostname provisioning" };
    }
    const zoneId = this.env.CF_ZONE_ID?.trim();
    const apiToken = this.env.CF_API_TOKEN?.trim();
    if (!zoneId || !apiToken) {
      return { success: false, error: "Cloudflare API not configured" };
    }
    const scripts = await this.orgStub.listWorkerScriptsByWorkspace(this.ctx.props.workspaceId);
    const scriptsToSync = scripts.filter((script) =>
      shouldRetryAppCustomDomainProvisioning(script, null),
    );
    let succeeded = 0;
    const errors: Array<{ app: string; error: string }> = [];
    for (const script of scriptsToSync) {
      if (!script.custom_domain_hostname) continue;
      try {
        const result = await createOrRefreshCustomHostname(zoneId, apiToken, script.custom_domain_hostname);
        if (result) {
          await this.orgStub.updateWorkerScriptCustomDomain(script.script_name, {
            hostname: script.custom_domain_hostname,
            cf_hostname_id: result.id,
            status: result.status,
            ssl_status: result.ssl.status,
            error: null,
          });
          succeeded++;
        } else {
          const error = "Failed to create or locate Cloudflare hostname";
          await this.orgStub.updateWorkerScriptCustomDomain(script.script_name, {
            hostname: script.custom_domain_hostname,
            cf_hostname_id: null,
            status: null,
            ssl_status: null,
            error,
          });
          errors.push({ app: script.script_name, error });
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        await this.orgStub.updateWorkerScriptCustomDomain(script.script_name, {
          hostname: script.custom_domain_hostname,
          error,
        });
        errors.push({ app: script.script_name, error });
      }
    }
    return {
      success: true,
      retried: scriptsToSync.length,
      succeeded,
      errors: errors.length ? errors : undefined,
      message:
        scriptsToSync.length === 0
          ? "No apps need hostname retry; all are either active or still provisioning normally."
          : `Retried ${scriptsToSync.length} app(s): ${succeeded} succeeded${errors.length ? `, ${errors.length} failed` : ""}.`,
    };
  }

  private webProviderBaseURL(provider: WebProvider): string {
    switch (provider) {
      case "firecrawl":
        return (this.env.FIRECRAWL_BASE_URL || "https://api.firecrawl.dev").replace(/\/+$/, "");
      case "parallel":
        return (this.env.PARALLEL_BASE_URL || "https://api.parallel.ai").replace(/\/+$/, "");
      case "exa":
        return (this.env.EXA_BASE_URL || "https://api.exa.ai").replace(/\/+$/, "");
    }
  }

  private webProviderAPIKey(provider: WebProvider): string {
    switch (provider) {
      case "firecrawl":
        return (this.env.FIRECRAWL_API_KEY || "").trim();
      case "parallel":
        return (this.env.PARALLEL_API_KEY || "").trim();
      case "exa":
        return (this.env.EXA_API_KEY || "").trim();
    }
  }

  private webProviderConfigured(provider: WebProvider): boolean {
    return this.webProviderAPIKey(provider) !== "";
  }

  private configuredWebProviders(): WebProvider[] {
    const configuredOrder = (this.env.WEB_PROVIDER_ORDER || this.env.CHIRIDION_WEB_PROVIDER_ORDER || "firecrawl,parallel,exa")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter((value): value is WebProvider => value === "firecrawl" || value === "parallel" || value === "exa");
    const preferred = [...configuredOrder];
    for (const provider of WEB_PROVIDER_DEFAULT_ORDER) {
      if (!preferred.includes(provider)) preferred.push(provider);
    }
    const out: WebProvider[] = [];
    for (const provider of preferred) {
      if (!out.includes(provider) && this.webProviderConfigured(provider)) out.push(provider);
    }
    return out;
  }

  private async rotatedWebProviders(): Promise<WebProvider[]> {
    const providers = this.configuredWebProviders();
    if (providers.length <= 1) return providers;
    let start = 0;
    try {
      const raw = await this.env.APP_KV.get(WEB_PROVIDER_ROUND_ROBIN_KEY);
      const parsed = Number.parseInt(raw || "0", 10);
      start = Number.isFinite(parsed) ? parsed % providers.length : 0;
      await this.env.APP_KV.put(WEB_PROVIDER_ROUND_ROBIN_KEY, String(start + 1));
    } catch (error) {
      console.warn("Failed to update web provider round robin index", error);
    }
    return [...providers.slice(start), ...providers.slice(0, start)];
  }

  private async withWebProviderFallback(
    operation: "search" | "fetch",
    call: (provider: WebProvider) => Promise<WebProviderResult>,
  ): Promise<WebProviderResult> {
    const providers = await this.rotatedWebProviders();
    if (providers.length === 0) {
      throw new Error("no web provider API keys are configured");
    }
    const failures: string[] = [];
    for (const provider of providers) {
      try {
        return await call(provider);
      } catch (error) {
        failures.push(`${provider}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new Error(`${operation} failed for all web providers: ${failures.join("; ")}`);
  }

  private async webJSON(
    provider: WebProvider,
    target: string,
    headers: Record<string, string>,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), WEB_PROVIDER_TIMEOUT_MS);
    try {
      const response = await fetch(target, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...headers,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const raw = await response.text();
      let payload: Record<string, unknown> = {};
      if (raw.trim()) {
        try {
          payload = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          payload = { message: raw.slice(0, 4096) };
        }
      }
      if (!response.ok) {
        throw new Error(`${provider} request failed with HTTP ${response.status}: ${webPayloadMessage(payload)}`);
      }
      if (payload.success === false) {
        throw new Error(`${provider} request failed: ${webPayloadMessage(payload)}`);
      }
      return payload;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async webSearchWithProvider(
    provider: WebProvider,
    args: Record<string, unknown>,
    query: string,
    numResults: number,
    maxCharacters: number,
  ): Promise<WebProviderResult> {
    switch (provider) {
      case "firecrawl":
        return this.firecrawlSearch(args, query, numResults, maxCharacters);
      case "parallel":
        return this.parallelSearch(args, query, numResults, maxCharacters);
      case "exa":
        return this.exaSearch(args, query, numResults, maxCharacters);
    }
  }

  private async webFetchWithProvider(
    provider: WebProvider,
    args: Record<string, unknown>,
    targetURL: string,
    maxCharacters: number,
  ): Promise<WebProviderResult> {
    switch (provider) {
      case "firecrawl":
        return this.firecrawlFetch(args, targetURL, maxCharacters);
      case "parallel":
        return this.parallelFetch(args, targetURL, maxCharacters);
      case "exa":
        return this.exaFetch(args, targetURL, maxCharacters);
    }
  }

  private async firecrawlSearch(
    args: Record<string, unknown>,
    query: string,
    numResults: number,
    maxCharacters: number,
  ): Promise<WebProviderResult> {
    const includeDomains = normalizeWebDomains(args.includeDomains);
    const excludeDomains = normalizeWebDomains(args.excludeDomains);
    const body: Record<string, unknown> = {
      query: firecrawlQuery(query, includeDomains, excludeDomains, args.category),
      limit: numResults,
      sources: firecrawlSources(args.category),
      ignoreInvalidURLs: true,
      timeout: 30000,
    };
    const categories = firecrawlCategories(args.category);
    if (categories?.length) body.categories = categories;
    const tbs = firecrawlTimeFilter(args.startPublishedDate, args.endPublishedDate);
    if (tbs) body.tbs = tbs;
    const payload = await this.webJSON("firecrawl", `${this.webProviderBaseURL("firecrawl")}/v2/search`, {
      authorization: `Bearer ${this.webProviderAPIKey("firecrawl")}`,
    }, body);
    const results = firecrawlEntries(payload)
      .map((entry) => normalizeFirecrawlResult(entry, false))
      .filter((result): result is WebResult => result !== null);
    return {
      provider: "firecrawl",
      results: truncateWebResults(filterWebDomains(results, includeDomains, excludeDomains), numResults, maxCharacters),
      costUSD: 0.005,
    };
  }

  private async firecrawlFetch(
    args: Record<string, unknown>,
    targetURL: string,
    maxCharacters: number,
  ): Promise<WebProviderResult> {
    const payload = await this.webJSON("firecrawl", `${this.webProviderBaseURL("firecrawl")}/v2/scrape`, {
      authorization: `Bearer ${this.webProviderAPIKey("firecrawl")}`,
    }, {
      url: targetURL,
      formats: ["markdown"],
      onlyMainContent: true,
      timeout: 30000,
      maxAge: boolParam(args, "fresh") ? 0 : 172800000,
    });
    const data = payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)
      ? { ...(payload.data as Record<string, unknown>), url: targetURL }
      : { ...payload, url: targetURL };
    const result = normalizeFirecrawlResult(data, true);
    return {
      provider: "firecrawl",
      results: result ? truncateWebResults([result], 1, maxCharacters) : [],
      costUSD: 0.001,
    };
  }

  private async parallelSearch(
    args: Record<string, unknown>,
    query: string,
    numResults: number,
    maxCharacters: number,
  ): Promise<WebProviderResult> {
    const includeDomains = normalizeWebDomains(args.includeDomains);
    const excludeDomains = normalizeWebDomains(args.excludeDomains);
    const sourcePolicy: Record<string, unknown> = {};
    if (includeDomains.length) sourcePolicy.include_domains = includeDomains;
    if (excludeDomains.length) sourcePolicy.exclude_domains = excludeDomains;
    const afterDate = dateOnly(args.startPublishedDate);
    if (afterDate) sourcePolicy.after_date = afterDate;
    const advanced: Record<string, unknown> = { max_results: numResults };
    if (Object.keys(sourcePolicy).length) advanced.source_policy = sourcePolicy;
    const payload = await this.webJSON("parallel", `${this.webProviderBaseURL("parallel")}/v1/search`, {
      "x-api-key": this.webProviderAPIKey("parallel"),
    }, {
      objective: query,
      search_queries: [query],
      mode: parallelMode(args.searchType),
      max_chars_total: Math.max(1000, numResults * maxCharacters),
      session_id: this.ctx.props.threadId || this.ctx.props.workspaceId,
      advanced_settings: advanced,
    });
    const costUSD = parallelUsageCostUSD(payload) || 0.005;
    return {
      provider: "parallel",
      results: truncateWebResults(
        filterWebDomains(normalizeParallelResults(payload.results, false), includeDomains, excludeDomains),
        numResults,
        maxCharacters,
      ),
      costUSD,
    };
  }

  private async parallelFetch(
    args: Record<string, unknown>,
    targetURL: string,
    maxCharacters: number,
  ): Promise<WebProviderResult> {
    const objective = stringParam(args, "query") || `Extract the main content from ${targetURL}.`;
    const payload = await this.webJSON("parallel", `${this.webProviderBaseURL("parallel")}/v1/extract`, {
      "x-api-key": this.webProviderAPIKey("parallel"),
    }, {
      urls: [targetURL],
      objective,
      max_chars_total: maxCharacters,
      session_id: this.ctx.props.threadId || this.ctx.props.workspaceId,
      advanced_settings: {
        fetch_policy: {
          max_age_seconds: boolParam(args, "fresh") ? 600 : 172800,
          timeout_seconds: 30,
          disable_cache_fallback: false,
        },
        excerpt_settings: { max_chars_per_result: Math.max(1000, Math.min(maxCharacters, 30000)) },
        full_content: { max_chars_per_result: maxCharacters },
      },
    });
    const results = normalizeParallelResults(payload.results, true);
    if (results.length === 0 && Array.isArray(payload.errors) && payload.errors.length > 0) {
      throw new Error("parallel extract returned errors");
    }
    return {
      provider: "parallel",
      results: truncateWebResults(results, 1, maxCharacters),
      costUSD: parallelUsageCostUSD(payload) || 0.001,
    };
  }

  private async exaSearch(
    args: Record<string, unknown>,
    query: string,
    numResults: number,
    maxCharacters: number,
  ): Promise<WebProviderResult> {
    const body: Record<string, unknown> = {
      query,
      type: stringParam(args, "searchType") || "auto",
      numResults,
    };
    for (const key of ["category", "startPublishedDate", "endPublishedDate"] as const) {
      const value = stringParam(args, key);
      if (value) body[key] = value;
    }
    const includeDomains = normalizeWebDomains(args.includeDomains);
    const excludeDomains = normalizeWebDomains(args.excludeDomains);
    if (includeDomains.length) body.includeDomains = includeDomains;
    if (excludeDomains.length) body.excludeDomains = excludeDomains;
    const payload = await this.webJSON("exa", `${this.webProviderBaseURL("exa")}/search`, {
      "x-api-key": this.webProviderAPIKey("exa"),
    }, body);
    return {
      provider: "exa",
      results: truncateWebResults(normalizeExaResults(payload.results, false), numResults, maxCharacters),
      costUSD: exaCostUSD(payload) || 0.007,
    };
  }

  private async exaFetch(
    args: Record<string, unknown>,
    targetURL: string,
    maxCharacters: number,
  ): Promise<WebProviderResult> {
    const body: Record<string, unknown> = {
      urls: [targetURL],
      livecrawl: boolParam(args, "fresh") ? "always" : "fallback",
      livecrawlTimeout: 15000,
    };
    switch (stringParam(args, "content")) {
      case "highlights": {
        const highlights: Record<string, unknown> = { numSentences: 4, highlightsPerUrl: 5 };
        const query = stringParam(args, "query");
        if (query) highlights.query = query;
        body.highlights = highlights;
        break;
      }
      case "summary": {
        const query = stringParam(args, "query");
        body.summary = query ? { query } : {};
        break;
      }
      default:
        body.text = { maxCharacters };
    }
    const payload = await this.webJSON("exa", `${this.webProviderBaseURL("exa")}/contents`, {
      "x-api-key": this.webProviderAPIKey("exa"),
    }, body);
    return {
      provider: "exa",
      results: truncateWebResults(normalizeExaResults(payload.results, true), 1, maxCharacters),
      costUSD: exaCostUSD(payload) || 0.001,
    };
  }

  private async webFetch(args: Record<string, unknown>): Promise<unknown> {
    const rawUrl = typeof args.url === "string" ? args.url.trim() : "";
    if (!rawUrl) throw new Error("url is required");
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Only http and https URLs are supported");
    }
    const maxCharacters = clampCodeModeInteger(args.maxCharacters, 12_000, 500, 30_000);
    const providerResult = await this.withWebProviderFallback("fetch", (provider) =>
      this.webFetchWithProvider(provider, args, url.toString(), maxCharacters)
    );
    const text = formatWebResults(
      providerResult.results,
      maxCharacters,
      `No content returned for ${url.toString()}.`,
    );
    return {
      content: [{ type: "text", text }],
      costUSD: providerResult.costUSD,
      provider: providerResult.provider,
      results: providerResult.results,
      success: true,
      url: url.toString(),
      text,
    };
  }

  private async webSearch(args: Record<string, unknown>): Promise<unknown> {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) throw new Error("query is required");
    const numResults = clampCodeModeInteger(args.numResults, 5, 1, 10);
    const maxCharacters = clampCodeModeInteger(args.maxCharacters, 1200, 200, 8000);
    const providerResult = await this.withWebProviderFallback("search", (provider) =>
      this.webSearchWithProvider(provider, args, query, numResults, maxCharacters)
    );
    const text = formatWebResults(
      providerResult.results,
      maxCharacters,
      `No results found for ${query}.`,
    );
    return {
      content: [{ type: "text", text }],
      costUSD: providerResult.costUSD,
      provider: providerResult.provider,
      results: providerResult.results,
      success: true,
      query,
      text,
    };
  }
}

async function resolveCnameViaDoH(hostname: string): Promise<CnameLookupResult> {
  const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=CNAME`;
  try {
    const resp = await fetch(url, {
      headers: { Accept: "application/dns-json" },
    });
    if (!resp.ok) {
      return {
        status: "unavailable",
        error: `DoH query failed with HTTP ${resp.status}`,
        http_status: resp.status,
      };
    }
    const data = await resp.json() as {
      Status?: number;
      Answer?: Array<{ type: number; data: string }>;
    };
    const dnsStatus = data.Status ?? 0;
    const cname = data.Answer?.find((answer) => answer.type === 5);
    if (!cname) {
      if (dnsStatus !== 0 && dnsStatus !== 3) {
        return {
          status: "unavailable",
          error: `DNS resolver returned status ${dnsStatus}`,
          http_status: null,
        };
      }
      return { status: "missing" };
    }
    return { status: "resolved", target: cname.data.replace(/\.$/, "") };
  } catch (error) {
    return {
      status: "unavailable",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function codeModeWorkerModule(userCode: string): string {
  return `${String.raw`
import { WorkerEntrypoint } from "cloudflare:workers";

const store = new Map();

function stringifyOutput(value) {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function hardenTimingSurface() {
  globalThis.performance = undefined;
  globalThis.SharedArrayBuffer = undefined;
  globalThis.Atomics = undefined;

  const NativeDate = Date;
  const coarseNow = () => Math.floor(NativeDate.now() / 1000) * 1000;
  function CoarseDate(...args) {
    if (new.target) {
      return args.length === 0 ? new NativeDate(coarseNow()) : new NativeDate(...args);
    }
    return new NativeDate(coarseNow()).toString();
  }
  Object.setPrototypeOf(CoarseDate, NativeDate);
  CoarseDate.prototype = NativeDate.prototype;
  Object.defineProperty(CoarseDate, "now", { value: coarseNow });
  Object.defineProperty(CoarseDate, "parse", { value: NativeDate.parse });
  Object.defineProperty(CoarseDate, "UTC", { value: NativeDate.UTC });
  globalThis.Date = CoarseDate;
}

function createConnectionsFacade(binding) {
  return new Proxy({}, {
    get(_target, connectionName) {
      if (connectionName === "then") return undefined;
      if (connectionName === "$methods") return () => binding.methods();
      if (connectionName === "$list") return () => binding.list();
      if (connectionName === "$get") return (connection) => binding.get(connection);
      if (connectionName === "$tools") return (connection) => binding.tools(connection);
      if (typeof connectionName !== "string") return undefined;

      return new Proxy({}, {
        get(_connectionTarget, methodName) {
          if (methodName === "then") return undefined;
          if (typeof methodName !== "string") return undefined;
          return (input = {}) => binding.__invoke({
            connection: connectionName,
            method: methodName,
            input,
          });
        },
      });
    },
  });
}

async function runUserCode(tools, CONNECTIONS, connections, env, context, ALL_TOOLS, text, store, load) {
  "use strict";
`}${userCode}${String.raw`
}

export class CodeModeRunner extends WorkerEntrypoint {
  async run() {
    hardenTimingSurface();
    const output = [];
    const allTools = Object.freeze((await this.env.TOOLS.listTools()).map((tool) => Object.freeze({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })));
    const callTool = (name, args = {}) => this.env.TOOLS.callTool(name, args);
    const tools = Object.freeze(Object.fromEntries(allTools.map((tool) => [tool.name, (args = {}) => callTool(tool.name, args)])));
    const CONNECTIONS = this.env.CONNECTIONS;
    const connections = createConnectionsFacade(CONNECTIONS);
    const env = Object.freeze({ CONNECTIONS });
    const context = Object.freeze({ cloudflare: Object.freeze({ env, connections }) });
    const text = (value) => {
      output.push(stringifyOutput(value));
    };
    const load = (key) => {
      if (typeof key !== "string" || !key) throw new Error("load key must be a non-empty string");
      return store.get(key);
    };
    const save = (key, value) => {
      if (typeof key !== "string" || !key) throw new Error("store key must be a non-empty string");
      store.set(key, value);
    };

    const result = await runUserCode(tools, CONNECTIONS, connections, env, context, allTools, text, save, load);
    if (result !== undefined) output.push(stringifyOutput(result));
    return { text: output.join("\n") };
  }
}
`}`;
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
const PI_TURN_RECOVERY_STALE_MS = 30_000;
const PI_TURN_RECOVERY_CONTINUE_PROMPT =
  "<camelai system message>continue</camelai system message>";
const CAMELAI_SYSTEM_MESSAGE_TAG_REGEX =
  /<camelai system message>[\s\S]*?<\/camelai system message>/g;

const MAX_CHAT_EVENT_BUFFER = 500;
const RUNNER_PING_INTERVAL_MS = 10_000;
const RUNNER_CLOSE_CODE_BYOK_CHANGED = 4001;
const DEFAULT_EXTERNAL_ASK_USER_QUESTION_UNAVAILABLE_MESSAGE = 'User is not at computer; ask_user_question is unavailable in this channel. Continue without asking and use best effort.';

interface PiTurnRecoveryRow {
  turn_id: string;
  status: "running" | "recovering";
  user_content: string;
  user_timestamp: number;
  active_user_id: string | null;
  retry_count: number;
  started_at: number;
  updated_at: number;
}

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

/**
 * ChatThreadDO - One per thread, holds preview state, prompts, browser runner
 * traffic, and external turns. Sandbox-host remains the backend for workspace
 * file/shell/container operations.
 */
export class ChatThreadDO extends DurableObject<ChatEnv> {
  private static readonly CONNECTION_SETUP_TIMEOUT_MS = 30 * 60 * 1000;
  private static readonly BUG_REPORT_TIMEOUT_MS = 5 * 60 * 1000;

  private previewTarget: PreviewTarget | null = null;
  private previewTabs: PreviewTarget[] = [];
  private previewActiveTabId: string | null = null;
  private previewVersion: number = 0;

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
  private assistantCompletionRecordedAt: number | null = null;
  private pendingQuestions: Map<string, PendingQuestionInfo> = new Map();
  private pendingQuestionWaiters: Map<string, PendingQuestionWaiter> = new Map();
  private pendingConnectionSetupWaiters: Map<string, PendingConnectionSetupWaiter> =
    new Map();
  private pendingBugReportWaiters: Map<string, PendingBugReportWaiter> =
    new Map();
  private pendingExternalTurn: PendingExternalTurn | null = null;
  private titleGenerationInFlight: boolean = false;
  private codexSessionId: string | null = null;
  private activeTurnUserId: string | null = null;
  private runnerSocket: WebSocket | null = null;
  private runnerConnectPromise: Promise<void> | null = null;
  private runnerPingTimer: number | null = null;
  private lastRunnerSeq: number = 0;
  private runnerTransitionChain: Promise<void> = Promise.resolve();
  private piSessionPromise: Promise<PiCoreAgent> | null = null;
  private piSession: PiCoreAgent | null = null;
  private piModelResolver: (() => Promise<PiResolvedModelConfig>) | null = null;
  private piUnsubscribe: (() => void) | null = null;
  private piActiveItemId: string | null = null;
  private piActiveItemText = "";
  private piReasoningItemId: string | null = null;
  private piToolArgs: Map<string, Record<string, unknown>> = new Map();
  private piAssistantText = "";
  private piTurnStartedAtMs: number = 0;
  private piCurrentBillingSource: PiBillingSource = "hosted";
  private piCurrentCreditChargeable: boolean = false;
  private piCurrentUsageProvider: string | null = null;
  private piRecoveryInFlight: Promise<void> | null = null;

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

      const storedCodexSessionId = ctx.storage.kv.get<string>(CHAT_CODEX_SESSION_ID_KEY);
      if (typeof storedCodexSessionId === 'string' && storedCodexSessionId.trim()) {
        this.codexSessionId = storedCodexSessionId.trim();
      }

      const pendingPiTurn = this.loadPiTurnRecovery();
      if (pendingPiTurn) {
        this.chatIsStreaming = true;
        this.activeTurnUserId = pendingPiTurn.active_user_id;
        this.schedulePiTurnRecoveryAlarm(1_000);
      }
    });
  }

  async alarm(): Promise<void> {
    const pendingPiTurn = this.loadPiTurnRecovery();
    if (!pendingPiTurn) return;

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
          this.schedulePiTurnRecoveryAlarm(PI_TURN_RECOVERY_ALARM_MS);
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

    const workerCode: WorkerLoaderWorkerCode = {
      compatibilityDate: CODE_MODE_COMPATIBILITY_DATE,
      mainModule: "index.js",
      modules: {
        "index.js": { js: codeModeWorkerModule(code) },
      },
      env: { TOOLS: tools, CONNECTIONS: connections },
      globalOutbound: null,
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
            () => reject(new Error(`JavaScript execution timed out after ${timeoutMs}ms`)),
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

      if (data.type === "bug_report_response") {
        await this.handleBugReportResponse(
          data as unknown as BugReportCaptureResponse,
        );
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

      if (data.type === "message") {
        await this.handleChatMessage(ws);
        return;
      }

      if (data.type === "stop") {
        await this.handleChatStop(ws);
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
      if (this.pendingQuestions.size > 0) {
        this.markRunnerActivity("chat_socket_closed_question_unavailable");
        this.ctx.waitUntil(
          this.autoAnswerAllPendingQuestionsAsUnavailable(
            DEFAULT_EXTERNAL_ASK_USER_QUESTION_UNAVAILABLE_MESSAGE,
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

  async setModel(model: LlmModel, provider?: 'claude' | 'codex'): Promise<void> {
    this.broadcastRealtime({ type: 'thread_model_updated', model, provider });
  }

  async setTodoState(todos: unknown[]): Promise<void> {
    this.currentTodos = Array.isArray(todos) ? normalizeTodoItems(todos) : [];
    if (this.currentTodos.length > 0) {
      this.ctx.storage.kv.put(CHAT_TODOS_KEY, this.currentTodos);
    } else {
      this.ctx.storage.kv.delete(CHAT_TODOS_KEY);
    }
    this.broadcastRealtime({ type: 'todo_state', todos: this.currentTodos });
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
    const questions = normalizeAskQuestions(Array.isArray(input.questions) ? input.questions : []);
    if (questions.length === 0) {
      throw new Error("questions is required");
    }
    if (!this.hasAvailableBrowserUser()) {
      return {
        unavailable_reason: DEFAULT_EXTERNAL_ASK_USER_QUESTION_UNAVAILABLE_MESSAGE,
      };
    }
    const questionId = crypto.randomUUID();
    this.pendingQuestions.set(questionId, {
      questionId,
      toolUseId: input.toolUseId,
      questions,
    });
    this.broadcastRealtime({
      type: "ask_user_question",
      questionId,
      toolUseId: input.toolUseId,
      questions,
    });
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingQuestionWaiters.delete(questionId);
        this.pendingQuestions.delete(questionId);
        this.broadcastRealtime({
          type: "question_answered",
          questionId,
        });
        reject(new Error("ask_user_question timed out"));
      }, 30 * 60 * 1000);
      this.pendingQuestionWaiters.set(questionId, {
        resolve,
        reject,
        timeoutId,
      });
    });
  }

  async promptConnectionSetup(input: {
    integrationType: string;
    suggestedName?: string;
    message?: string;
    instructions?: string;
    dynamicSchema?: DynamicIntegrationSchema;
  }): Promise<ConnectionSetupResponse> {
    const integrationType = input.integrationType?.trim();
    if (!integrationType) {
      throw new Error("integrationType is required");
    }
    if (!this.hasAvailableBrowserUser()) {
      return { requestId: "", cancelled: true };
    }
    const requestId = crypto.randomUUID();
    const info: PendingConnectionSetupPromptInfo = {
      createdAt: Date.now(),
      integrationType,
      suggestedName: input.suggestedName,
      message: input.message,
      instructions: input.instructions,
      dynamicSchema: input.dynamicSchema,
    };
    const pendingResponse = new Promise<ConnectionSetupResponse>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingConnectionSetupWaiters.delete(requestId);
        this.broadcastRealtime({
          type: "connection_setup_answered",
          requestId,
        });
        reject(new Error("Connection setup timed out"));
      }, ChatThreadDO.CONNECTION_SETUP_TIMEOUT_MS);
      this.pendingConnectionSetupWaiters.set(requestId, {
        resolve,
        reject,
        timeoutId,
        info,
      });
    });
    this.broadcastRealtime({
      type: "connection_setup_prompt",
      requestId,
      integrationType,
      suggestedName: input.suggestedName,
      message: input.message,
      instructions: input.instructions,
      dynamicSchema: input.dynamicSchema,
    });
    return pendingResponse;
  }

  async receiveConnectionSetupResponse(
    response: ConnectionSetupResponse,
  ): Promise<{ accepted: boolean }> {
    return await this.handleConnectionSetupResponse(response);
  }

  async captureBugReport(input: {
    message?: string;
  }): Promise<BugReportCaptureResponse> {
    if (!this.hasAvailableBrowserUser()) {
      return { requestId: "", cancelled: true };
    }
    const requestId = crypto.randomUUID();
    this.broadcastRealtime({
      type: "bug_report_prompt",
      requestId,
      message: input.message,
    });
    return new Promise<BugReportCaptureResponse>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingBugReportWaiters.delete(requestId);
        reject(new Error("Bug report capture timed out"));
      }, ChatThreadDO.BUG_REPORT_TIMEOUT_MS);
      this.pendingBugReportWaiters.set(requestId, {
        resolve,
        reject,
        timeoutId,
      });
    });
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
    this.setChatIsStreaming(isStreaming);
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
    this.broadcastRealtime({ type: "todo_state", todos: completedTodos });
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

  getPiCoreParsedMessages(threadId: string): Array<{
    id: string;
    thread_id: string;
    role: "user" | "assistant";
    content: unknown;
    created_at: number;
    forkEntryId: string;
  }> {
    const normalizedThreadId = threadId.trim() || this.chatContext?.threadId || "";
    const parsed: Array<{
      id: string;
      thread_id: string;
      role: "user" | "assistant";
      content: unknown;
      created_at: number;
      forkEntryId: string;
    }> = [];

    const storedMessages = this.loadPiCoreMessages();
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

  getPiCoreForkMessages(options: {
    forkEntryId: string;
    renderedMessageId?: string;
  }): ChatThreadPiCoreForkResult {
    const messages = this.loadPiCoreMessages();
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

  replacePiCoreForkMessages(messages: AgentMessage[]): void {
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
    this.replacePiCoreMessages(cloneDurableState(normalizedMessages));
    this.ctx.storage.sql.exec("DELETE FROM pi_core_compaction");
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
    this.pendingQuestions.clear();
    this.pendingExternalTurn = null;
    this.titleGenerationInFlight = false;
    this.activeTurnUserId = null;
    this.ctx.storage.kv.delete(CHAT_ACTIVE_TURN_USER_ID_KEY);
  }

  getActiveTurnUserId(): string | null {
    return this.activeTurnUserId;
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
      if (!this.runnerSocket) {
        return;
      }
      try {
        this.runnerSocket.close(1000, 'runner_config_changed');
      } catch {
        this.trace('refresh_runner_config_close_failed');
      }
    });
  }

  async byokChanged(): Promise<void> {
    await this.withRunnerTransitionLock('byok_changed', async () => {
      this.disposePiSession();
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
    this.piSessionPromise = null;
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
  }

  private loadPiCoreMessages(): AgentMessage[] {
    this.ensurePiCoreTables();
    const rows = this.ctx.storage.sql
      .exec<{ payload: string }>(
        "SELECT payload FROM pi_core_messages ORDER BY idx ASC",
      )
      .toArray();
    const messages: AgentMessage[] = [];
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.payload) as AgentMessage;
        if (parsed && typeof parsed === "object" && "role" in parsed) {
          messages.push(parsed);
        }
      } catch {
        // Skip corrupt rows rather than failing the whole thread.
      }
    }
    return messages;
  }

  private replacePiCoreMessages(messages: AgentMessage[]): void {
    this.ensurePiCoreTables();
    this.ctx.storage.sql.exec("DELETE FROM pi_core_messages");
    const now = Date.now();
    messages.forEach((message, index) => {
      this.ctx.storage.sql.exec(
        "INSERT INTO pi_core_messages (idx, payload, created_at) VALUES (?, ?, ?)",
        index,
        JSON.stringify(message),
        now,
      );
    });
  }

  private appendPiCoreMessages(messages: AgentMessage[]): void {
    if (messages.length === 0) return;
    this.ensurePiCoreTables();
    const rows = this.ctx.storage.sql
      .exec<{ next_idx: number }>(
        "SELECT COALESCE(MAX(idx) + 1, 0) AS next_idx FROM pi_core_messages",
      )
      .toArray();
    const startIndex = Math.max(0, Math.floor(Number(rows[0]?.next_idx) || 0));
    const now = Date.now();
    messages.forEach((message, offset) => {
      this.ctx.storage.sql.exec(
        "INSERT INTO pi_core_messages (idx, payload, created_at) VALUES (?, ?, ?)",
        startIndex + offset,
        JSON.stringify(message),
        now,
      );
    });
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
        JSON.stringify(record.content ?? null),
      ].join(":");
    }
    return [
      record.role,
      typeof record.timestamp === "number" ? record.timestamp : "",
      typeof record.responseId === "string" ? record.responseId : "",
      typeof record.toolCallId === "string" ? record.toolCallId : "",
      JSON.stringify(record.content ?? null),
    ].join(":");
  }

  private appendPiCoreMessagesIfMissing(messages: AgentMessage[]): void {
    if (messages.length === 0) return;
    const existingMessages = this.loadPiCoreMessages();
    const existingKeys = new Set(
      existingMessages.map((message) => this.piCoreMessageKey(message)),
    );
    const missing = messages.filter((message) => {
      const key = this.piCoreMessageKey(message);
      if (existingKeys.has(key)) return false;
      existingKeys.add(key);
      return true;
    });
    this.appendPiCoreMessages(missing);
  }

  private upsertPiCoreMessages(messages: AgentMessage[]): void {
    if (messages.length === 0) return;
    this.ensurePiCoreTables();
    const rows = this.ctx.storage.sql
      .exec<{ idx: number; payload: string }>(
        "SELECT idx, payload FROM pi_core_messages ORDER BY idx ASC",
      )
      .toArray();
    const existingByKey = new Map<string, number>();
    let nextIndex = 0;
    for (const row of rows) {
      nextIndex = Math.max(nextIndex, Math.floor(Number(row.idx) || 0) + 1);
      try {
        const parsed = JSON.parse(row.payload) as AgentMessage;
        if (parsed && typeof parsed === "object" && "role" in parsed) {
          existingByKey.set(this.piCoreMessageKey(parsed), row.idx);
        }
      } catch {
        // Ignore corrupt rows here; loadPiCoreMessages skips them too.
      }
    }

    const now = Date.now();
    for (const message of messages) {
      const key = this.piCoreMessageKey(message);
      const existingIndex = existingByKey.get(key);
      if (existingIndex !== undefined) {
        this.ctx.storage.sql.exec(
          "UPDATE pi_core_messages SET payload = ? WHERE idx = ?",
          JSON.stringify(message),
          existingIndex,
        );
        continue;
      }

      this.ctx.storage.sql.exec(
        "INSERT INTO pi_core_messages (idx, payload, created_at) VALUES (?, ?, ?)",
        nextIndex,
        JSON.stringify(message),
        now,
      );
      existingByKey.set(key, nextIndex);
      nextIndex += 1;
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

  private startPiTurnRecovery(userMessage: AgentMessage): void {
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
    this.upsertPiCoreMessages([userMessage]);
    this.schedulePiTurnRecoveryAlarm(PI_TURN_RECOVERY_ALARM_MS);
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

  private async recoverInterruptedPiTurn(
    pendingPiTurn: PiTurnRecoveryRow,
  ): Promise<void> {
    if (!this.chatContext) {
      this.schedulePiTurnRecoveryAlarm(PI_TURN_RECOVERY_ALARM_MS);
      return;
    }

    const userMessage: AgentMessage = {
      role: "user",
      content: pendingPiTurn.user_content,
      timestamp: pendingPiTurn.user_timestamp || pendingPiTurn.started_at,
    };
    this.appendPiCoreMessagesIfMissing([userMessage]);
    this.markPiTurnRecovering();
    this.setActiveTurnUserId(pendingPiTurn.active_user_id);
    this.setChatIsStreaming(true);

    await this.ensureRunnerConnected();
    if (!this.piSession) {
      throw new Error("Pi session was not available for turn recovery");
    }
    await this.refreshPiSessionModel();
    await this.piSession.prompt({
      role: "user",
      content: PI_TURN_RECOVERY_CONTINUE_PROMPT,
      timestamp: Date.now(),
    });
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

  private mergePiCoreMessages(
    existing: AgentMessage[] | undefined,
    incoming: AgentMessage[] | undefined,
  ): AgentMessage[] {
    const merged: AgentMessage[] = [];
    const seen = new Set<string>();
    const push = (message: AgentMessage) => {
      const record = message as unknown as Record<string, unknown>;
      const key = [
        record.role,
        typeof record.timestamp === "number" ? record.timestamp : "",
        typeof record.responseId === "string" ? record.responseId : "",
        typeof record.toolCallId === "string" ? record.toolCallId : "",
        JSON.stringify(record.content ?? null),
      ].join(":");
      if (seen.has(key)) return;
      seen.add(key);
      merged.push(message);
    };

    for (const message of existing ?? []) push(message);
    for (const message of incoming ?? []) push(message);
    return merged;
  }

  private getPiAssistantErrorMessage(message: AgentMessage): string {
    const record = message as unknown as Record<string, unknown>;
    if (record.role !== "assistant") return "";
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

    if (role === "user") {
      if (this.isInvisibleSystemOnlyUserContent(record.content)) {
        return [];
      }
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

  private isInvisibleSystemOnlyUserContent(content: unknown): boolean {
    if (typeof content === "string") {
      return (
        content.trim().length > 0 &&
        content.replace(CAMELAI_SYSTEM_MESSAGE_TAG_REGEX, "").trim().length === 0
      );
    }
    if (!Array.isArray(content) || content.length === 0) return false;
    const text = content
      .flatMap((part): string[] => {
        if (!part || typeof part !== "object") return [];
        const item = part as Record<string, unknown>;
        return item.type === "text" && typeof item.text === "string"
          ? [item.text]
          : [];
      })
      .join("\n");
    return (
      text.trim().length > 0 &&
      text.replace(CAMELAI_SYSTEM_MESSAGE_TAG_REGEX, "").trim().length === 0
    );
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
    const content = message.content;
    const blocks = Array.isArray(content) ? content.flatMap((part): Array<Record<string, unknown>> => {
      if (!part || typeof part !== "object") return [];
      const item = part as Record<string, unknown>;
      if (item.type === "text" && typeof item.text === "string") {
        return [{ type: "text", text: item.text }];
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
      return [{
        type: "error",
        title: "Assistant error",
        error: message.errorMessage.trim(),
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

  private async hydratePiCoreMessagesFromLegacy(
    context: ChatContextState,
    container: WorkspaceContainer,
    options: { claudeSessionId?: string | null; codexSessionId?: string | null },
  ): Promise<void> {
    if (this.loadPiCoreMessages().length > 0) return;

    try {
      const piCoreResult = await container.readPiCoreMessagesStream(context.threadId, {
        skipBanCheck: true,
      });
      if (piCoreResult.success && piCoreResult.response) {
        const piCoreBody = await piCoreResult.response.json().catch(() => null) as { messages?: unknown } | null;
        const piCoreMessages = Array.isArray(piCoreBody?.messages)
          ? this.normalizeHostPiCoreMessages(piCoreBody.messages)
          : [];
        if (piCoreMessages.length > 0) {
          if (this.loadPiCoreMessages().length > 0) return;
          this.replacePiCoreMessages(piCoreMessages);
          this.trace("pi_core_host_hydrated", { messageCount: piCoreMessages.length });
          return;
        }
      } else {
        this.trace("pi_core_host_hydration_skipped", {
          code: piCoreResult.code,
          error: piCoreResult.error,
        });
      }

      const result = await container.readThreadMessagesStream(context.threadId, {
        claudeSessionId: options.claudeSessionId,
        codexSessionId: options.codexSessionId,
        skipBanCheck: true,
      });
      if (!result.success || !result.response) {
        this.trace("pi_core_legacy_hydration_skipped", {
          code: result.code,
          error: result.error,
        });
        return;
      }

      const body = await result.response.json().catch(() => null) as { messages?: unknown } | null;
      const messages = Array.isArray(body?.messages)
        ? this.legacyParsedMessagesToPiCoreMessages(body.messages)
        : [];
      if (messages.length === 0) return;

      if (this.loadPiCoreMessages().length > 0) return;
      this.replacePiCoreMessages(messages);
      this.trace("pi_core_legacy_hydrated", { messageCount: messages.length });
    } catch (error) {
      console.warn("[ChatThreadDO] failed to hydrate Pi history from legacy sessions", error);
      this.trace("pi_core_legacy_hydration_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private normalizeHostPiCoreMessages(rawMessages: unknown[]): AgentMessage[] {
    const messages: AgentMessage[] = [];
    for (const rawMessage of rawMessages) {
      if (!rawMessage || typeof rawMessage !== "object") continue;
      const record = rawMessage as Record<string, unknown>;
      const role = record.role;
      const timestamp = this.normalizeLegacyMessageTimestamp(record.timestamp);
      if (role === "user") {
        const content = typeof record.content === "string" || Array.isArray(record.content)
          ? record.content
          : "";
        if (typeof content === "string" && !content.trim()) continue;
        if (Array.isArray(content) && content.length === 0) continue;
        messages.push({
          ...record,
          role: "user",
          content,
          timestamp,
        } as unknown as AgentMessage);
        continue;
      }
      if (role === "assistant") {
        const content = Array.isArray(record.content) ? record.content : [];
        if (content.length === 0 && typeof record.errorMessage !== "string") continue;
        messages.push({
          ...record,
          role: "assistant",
          content,
          api: typeof record.api === "string" ? record.api : "legacy",
          provider: typeof record.provider === "string" ? record.provider : "legacy",
          model: typeof record.model === "string" ? record.model : "legacy",
          usage: record.usage && typeof record.usage === "object" ? record.usage : this.emptyPiUsage(),
          stopReason: typeof record.stopReason === "string" ? record.stopReason : "stop",
          timestamp,
        } as unknown as AgentMessage);
        continue;
      }
      if (role === "toolResult") {
        if (typeof record.toolCallId !== "string" || typeof record.toolName !== "string") continue;
        messages.push({
          ...record,
          role: "toolResult",
          content: Array.isArray(record.content) ? record.content : [],
          isError: record.isError === true,
          timestamp,
        } as unknown as AgentMessage);
      }
    }
    return messages;
  }

  private legacyParsedMessagesToPiCoreMessages(rawMessages: unknown[]): AgentMessage[] {
    const messages: AgentMessage[] = [];
    for (const rawMessage of rawMessages) {
      const message = this.legacyParsedMessageToPiCoreMessage(rawMessage);
      if (message) messages.push(message);
    }
    return messages;
  }

  private legacyParsedMessageToPiCoreMessage(rawMessage: unknown): AgentMessage | null {
    if (!rawMessage || typeof rawMessage !== "object") return null;
    const message = rawMessage as LegacyParsedChatMessageForPi;
    const role = typeof message.role === "string" ? message.role : "";
    const timestamp = this.normalizeLegacyMessageTimestamp(message.created_at);

    if (role === "user") {
      const content = this.legacyUserContentToPiContent(message.content);
      if (Array.isArray(content) && content.length === 0) return null;
      if (typeof content === "string" && !content.trim()) return null;
      return {
        role: "user",
        content,
        timestamp,
      } as AgentMessage;
    }

    if (role === "assistant") {
      const content = this.legacyAssistantContentToPiContent(message.content);
      const errorMessage = this.legacyErrorMessage(message.content);
      if (content.length === 0 && !errorMessage) return null;
      const responseId = typeof message.id === "string" && message.id.trim()
        ? message.id.trim()
        : typeof message.forkEntryId === "string" && message.forkEntryId.trim()
          ? message.forkEntryId.trim()
          : undefined;
      return {
        role: "assistant",
        content,
        api: "legacy",
        provider: "legacy",
        model: "legacy",
        responseId,
        usage: this.emptyPiUsage(),
        stopReason: errorMessage ? "error" : "stop",
        errorMessage: errorMessage || undefined,
        timestamp,
      } as unknown as AgentMessage;
    }

    return null;
  }

  private normalizeLegacyMessageTimestamp(value: unknown): number {
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return Date.now();
    return parsed < 10_000_000_000 ? Math.round(parsed * 1000) : Math.round(parsed);
  }

  private legacyUserContentToPiContent(content: unknown): string | Array<Record<string, unknown>> {
    const parsed = this.parseLegacyChatContent(content);
    if (typeof parsed === "string") return parsed;
    const blocks = parsed.flatMap((block) => {
      if (!block || typeof block !== "object") return [];
      const item = block as Record<string, unknown>;
      if (item.type === "text" && typeof item.text === "string") {
        return [{ type: "text", text: item.text }];
      }
      const text = this.legacyContentBlockToText(item);
      return text ? [{ type: "text", text }] : [];
    });
    return blocks.length > 0 ? blocks : "";
  }

  private legacyAssistantContentToPiContent(content: unknown): Array<Record<string, unknown>> {
    const parsed = this.parseLegacyChatContent(content);
    if (typeof parsed === "string") {
      return parsed.trim() ? [{ type: "text", text: parsed }] : [];
    }

    return parsed.flatMap((block): Array<Record<string, unknown>> => {
      if (!block || typeof block !== "object") return [];
      const item = block as Record<string, unknown>;
      if (item.type === "text" && typeof item.text === "string") {
        return [{ type: "text", text: item.text }];
      }
      if (item.type === "thinking" && typeof item.thinking === "string") {
        return [{
          type: "thinking",
          thinking: item.thinking,
          thinkingSignature: typeof item.signature === "string" ? item.signature : undefined,
        }];
      }
      if (
        item.type === "tool_use" &&
        typeof item.id === "string" &&
        typeof item.name === "string"
      ) {
        return [{
          type: "toolCall",
          id: item.id,
          name: item.name,
          arguments: item.input && typeof item.input === "object" && !Array.isArray(item.input)
            ? item.input
            : {},
        }];
      }
      const text = this.legacyContentBlockToText(item);
      return text ? [{ type: "text", text }] : [];
    });
  }

  private parseLegacyChatContent(content: unknown): string | unknown[] {
    if (Array.isArray(content)) return content;
    if (typeof content !== "string") return this.safeLegacyString(content);

    const trimmed = content.trim();
    if (
      (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
      (trimmed.startsWith("{") && trimmed.endsWith("}"))
    ) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (Array.isArray(parsed)) return parsed;
        if (parsed && typeof parsed === "object" && "type" in parsed) return [parsed];
      } catch {
        // Treat malformed JSON-looking content as plain text.
      }
    }
    return content;
  }

  private legacyContentBlockToText(block: Record<string, unknown>): string {
    const type = typeof block.type === "string" ? block.type : "content";
    if (type === "tool_result") {
      const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : "unknown";
      return `[Tool result: ${toolUseId}]\n${this.safeLegacyString(block.content)}`.trim();
    }
    if (type === "error") {
      const title = typeof block.title === "string" && block.title.trim()
        ? block.title.trim()
        : "Assistant error";
      const error = typeof block.error === "string" ? block.error : this.safeLegacyString(block.error);
      return `[${title}]\n${error}`.trim();
    }
    if (type === "task_notification") {
      return [
        "[Task notification]",
        typeof block.status === "string" ? `Status: ${block.status}` : "",
        typeof block.summary === "string" ? block.summary : "",
        typeof block.outputFile === "string" ? `Output: ${block.outputFile}` : "",
      ].filter(Boolean).join("\n");
    }
    if (type === "teammate_message") {
      const teammate = typeof block.teammateId === "string" ? block.teammateId : "teammate";
      const text = typeof block.content === "string" ? block.content : this.safeLegacyString(block.content);
      return `[${teammate}]\n${text}`.trim();
    }
    return "";
  }

  private legacyErrorMessage(content: unknown): string {
    const parsed = this.parseLegacyChatContent(content);
    if (typeof parsed === "string") return "";
    for (const block of parsed) {
      if (!block || typeof block !== "object") continue;
      const item = block as Record<string, unknown>;
      if (item.type === "error" && typeof item.error === "string" && item.error.trim()) {
        return item.error.trim();
      }
    }
    return "";
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

  private loadPiCoreCompaction(): { summary: string; firstKeptIndex: number } | null {
    this.ensurePiCoreTables();
    const rows = this.ctx.storage.sql
      .exec<{ summary: string; first_kept_index: number }>(
        "SELECT summary, first_kept_index FROM pi_core_compaction WHERE id = 1",
      )
      .toArray();
    const row = rows[0];
    if (!row || typeof row.summary !== "string") return null;
    return {
      summary: row.summary,
      firstKeptIndex: Math.max(0, Math.floor(Number(row.first_kept_index) || 0)),
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

  private async handleConnectionSetupResponse(
    response: ConnectionSetupResponse,
  ): Promise<{ accepted: boolean }> {
    const nativeWaiter = this.pendingConnectionSetupWaiters.get(response.requestId);
    if (response.requestId && nativeWaiter) {
      this.pendingConnectionSetupWaiters.delete(response.requestId);
      clearTimeout(nativeWaiter.timeoutId);
      nativeWaiter.resolve(response);
      this.broadcastRealtime({
        type: "connection_setup_answered",
        requestId: response.requestId,
      });
      return { accepted: true };
    }

    console.warn("[ChatThreadDO] Received connection setup response with no pending waiter", {
      requestId: response.requestId,
    });
    return { accepted: false };
  }

  private async handleBugReportResponse(
    response: BugReportCaptureResponse,
  ): Promise<void> {
    const nativeWaiter = this.pendingBugReportWaiters.get(response.requestId);
    if (response.requestId && nativeWaiter) {
      this.pendingBugReportWaiters.delete(response.requestId);
      clearTimeout(nativeWaiter.timeoutId);
      nativeWaiter.resolve(response);
      return;
    }

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
      pendingQuestions: this.pendingQuestions.size,
      currentTodos: this.currentTodos.length,
      chatIsStreaming: this.chatIsStreaming,
    });
  }

  private async handleChatMessage(ws: WebSocket): Promise<void> {
    this.trace("handle_chat_message_rejected_side_channel");
    this.sendDirect(ws, {
      type: "error",
      error: "Chat messages must use the runner WebSocket",
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

  private async handleChatStop(ws: WebSocket): Promise<void> {
    this.trace("handle_chat_stop_rejected_side_channel");
    this.sendDirect(ws, {
      type: "error",
      error: "Stop requests must use the runner WebSocket",
    });
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
      if (this.runnerSocket) {
        this.sendRunnerCommand({ type: "ping", ts: data.ts });
      }
      return;
    }

    if (data.type === "message") {
      await this.handleRunnerClientUserMessage(ws, data as unknown as ChatClientMessage);
      return;
    }

    if (data.type === "stop") {
      await this.ensureRunnerConnected();
      if (!this.sendRunnerCommand({ ...data, type: "stop", threadId: this.chatContext?.threadId })) {
        this.sendDirect(ws, { type: "error", error: "Sandbox is not connected" });
      }
      return;
    }

    if (data.type === "set_model") {
      await this.ensureRunnerConnected();
      if (!this.sendRunnerCommand({ ...data, threadId: this.chatContext?.threadId })) {
        this.sendDirect(ws, { type: "error", error: "Sandbox is not connected" });
      }
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
    if (!this.sendRunnerCommand({ ...data, threadId: this.chatContext?.threadId })) {
      this.sendDirect(ws, { type: "error", error: "Sandbox is not connected" });
    }
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

  private async handleRunnerClientUserMessage(
    ws: WebSocket,
    data: ChatClientMessage,
  ): Promise<void> {
    const context = this.chatContext;
    if (!context) {
      this.sendDirect(ws, { type: "error", error: "Missing chat context for thread" });
      return;
    }

    const rawContent = typeof data.content === "string" ? data.content.trim() : "";
    if (!rawContent) {
      return;
    }

    const orgBan = await isOrgBanned(this.env.APP_KV, {
      orgId: context.orgId,
    });
    if (orgBan) {
      this.sendDirect(ws, { type: "error", error: "Organization is blocked" });
      return;
    }

    await this.ensureRunnerConnected();

    const safeContent = injectFileSafetyMessage(rawContent);
    const mentionAugmented = await this.applyConnectionMentionsForTurn(safeContent);
    const attributedContent = formatAttributedUserMessage(mentionAugmented, {
      userName: context.userName,
      userEmail: context.userEmail,
    });
    if (!attributedContent) {
      return;
    }

    this.setActiveTurnUserId(context.userId);
    this.setChatIsStreaming(true);
    this.broadcastRunnerClients({ type: "streaming_state", isStreaming: true });
    this.ctx.waitUntil(
      this.updateThreadMetadataForUserMessage(attributedContent).catch((err) => {
        console.error('[ChatThreadDO] failed to update thread metadata after browser user message', err);
      }),
    );

    const sent = this.sendRunnerCommand({
      ...data,
      type: "message",
      content: attributedContent,
      threadId: context.threadId,
      userId: context.userId ?? undefined,
    });
    if (!sent) {
      this.setChatIsStreaming(false);
      this.setActiveTurnUserId(null);
      this.sendDirect(ws, { type: "error", error: "Failed to send message to sandbox" });
      return;
    }

    if (data.clientMessageId) {
      this.sendDirect(ws, {
        type: "message_accepted",
        clientMessageId: data.clientMessageId,
      });
    }
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

    const nativeWaiter = this.pendingQuestionWaiters.get(data.questionId);
    if (nativeWaiter) {
      this.pendingQuestionWaiters.delete(data.questionId);
      this.pendingQuestions.delete(data.questionId);
      clearTimeout(nativeWaiter.timeoutId);
      this.broadcastRealtime({
        type: "question_answered",
        questionId: data.questionId,
      });
      nativeWaiter.resolve(data.answers);
      return;
    }

    this.markRunnerActivity("question_response");
    const answeringUserId =
      this.getSocketChatContext(ws)?.userId ?? this.chatContext?.userId ?? null;
    if (
      !this.sendRunnerCommand({
        type: "question_response",
        questionId: data.questionId,
        answers: data.answers,
        userId: answeringUserId ?? undefined,
      })
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

  private setChatIsStreaming(
    value: boolean,
    options: { markUnread?: boolean; completedAt?: number } = {},
  ): void {
    const shouldRecordCompletion =
      !value && options.markUnread === true && this.assistantCompletionRecordedAt === null;
    if (this.chatIsStreaming === value && !shouldRecordCompletion) return;
    this.trace("set_chat_is_streaming", {
      from: this.chatIsStreaming,
      to: value,
    });
    if (value) {
      this.assistantCompletionRecordedAt = null;
    }
    const statusChanged = this.chatIsStreaming !== value;
    this.chatIsStreaming = value;
    // Clear persisted todos when a new turn starts so they don't go stale
    // across reconnects. The next TodoWrite will re-persist fresh state.
    if (value && this.currentTodos.length > 0) {
      this.currentTodos = [];
      this.ctx.storage.kv.delete(CHAT_TODOS_KEY);
      this.broadcastRealtime({ type: "todo_state", todos: [] });
    }
    if (statusChanged) {
      this.broadcastRealtime({ type: "streaming_state", isStreaming: value });
    }
    const context = this.chatContext;
    if (context?.workspaceId && context.threadId) {
      if (shouldRecordCompletion) {
        const completedAt = normalizeCompletionTimestamp(options.completedAt);
        this.assistantCompletionRecordedAt = completedAt;
        this.ctx.waitUntil(
          this.recordThreadAssistantCompletion(context, completedAt).catch((error) => {
            console.error("[ChatThreadDO] failed to record assistant completion", error);
          }),
        );
      } else if (statusChanged) {
        this.ctx.waitUntil(
          recordWorkspaceThreadStreaming(
            this.env,
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
  ): Promise<void> {
    try {
      const orgStub = this.env.ORG.get(this.env.ORG.idFromName(context.orgId)) as unknown as {
        touchThreadActivity(id: string, at?: number): Promise<boolean> | boolean;
      };
      await orgStub.touchThreadActivity(context.threadId, completedAt);
    } catch (error) {
      console.error("[ChatThreadDO] failed to touch thread activity", error);
    }

    await recordWorkspaceThreadStreaming(
      this.env,
      context.workspaceId,
      context.threadId,
      false,
      { completedAt },
    );
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
            "ask_user_question is unavailable in this channel and could not be auto-answered.",
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
    const mentionAugmented = await this.applyConnectionMentionsForTurn(safeRawMessage);
    const attributedContent = formatAttributedUserMessage(mentionAugmented, {
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
      !this.sendRunnerCommand({
        type: "message",
        content: attributedContent,
        userId:
          typeof body.userId === "string" && body.userId.trim()
            ? body.userId.trim()
            : undefined,
      })
    ) {
      this.resolvePendingExternalTurn({
        status: "error",
        error: "Failed to send message to sandbox",
      });
      return { status: "error", error: "Failed to send message to sandbox" };
    }

    this.setChatIsStreaming(true);
    this.ctx.waitUntil(
      this.updateThreadMetadataForUserMessage(attributedContent).catch((err) => {
        console.error('[ChatThreadDO] failed to update thread metadata after external user message', err);
      })
    );

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
    const sent = this.sendRunnerCommand({
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
          "[ChatThreadDO] failed to auto-answer pending ask_user_question",
          {
            questionId,
            error: err instanceof Error ? err.message : String(err),
          },
        );
      }
    }
  }

  private clearPendingQuestions(reason: string): void {
    if (this.pendingQuestions.size === 0) return;

    const questionIds = [...this.pendingQuestions.keys()];
    this.pendingQuestions.clear();
    this.trace("pending_questions_cleared", {
      reason,
      count: questionIds.length,
    });
    for (const questionId of questionIds) {
      this.broadcastRealtime({
        type: "question_answered",
        questionId,
      });
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

  private async updateThreadMetadataForUserMessage(messageContent: string): Promise<void> {
    const context = this.chatContext;
    if (!context?.orgId || !context?.threadId || !context.workspaceId) return;

    const orgStub = this.env.ORG.get(this.env.ORG.idFromName(context.orgId));
    const thread = await orgStub.getThread(context.threadId);
    if (!thread) return;

    await orgStub.touchThread(context.threadId);
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
      await orgStub.updateThread(threadId, title);
      await this.setTitle(title);
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
      const { envVars } = await container.buildChatRunnerEnv({
        threadId: context.threadId,
        provider,
      });
      const legacyClaudeSessionId = this.getLegacyClaudeSessionId();
      if (legacyClaudeSessionId) {
        envVars.CHIRIDION_CLAUDE_SESSION_ID = legacyClaudeSessionId;
      }
      if (provider === 'codex' && this.codexSessionId) {
        envVars.CHIRIDION_CODEX_SESSION_ID = this.codexSessionId;
      }
      this.trace("ensure_runner_env_built", {
        envVarCount: Object.keys(envVars).length,
      });

      await this.hydratePiCoreMessagesFromLegacy(context, container, {
        claudeSessionId: legacyClaudeSessionId,
        codexSessionId: this.codexSessionId,
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
    const session = new Agent({
      initialState: {
        systemPrompt: await this.createPiSystemPrompt(context),
        model: modelConfig.model,
        tools: this.createPiToolDefinitions(context),
        messages: this.loadPiCoreMessages(),
        thinkingLevel: "medium",
      },
      transformContext: (messages, signal) =>
        resolveCurrentModel().then((current) =>
          this.compactPiContext(messages, current.model, current.apiKey, completeSimple, signal)
        ),
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
      this.handlePiSessionEvent(event);
    });
    this.pushChatEvent({ type: "session", sessionId: context.threadId });
    this.pushChatEvent({ type: "ready" });
    return session;
  }

  private async createPiSystemPrompt(context: ChatContextState): Promise<string> {
    const workspaceContext = await this.readWorkspaceContextPrompt(context).catch((error) => {
      console.warn("[ChatThreadDO] failed to read workspace context", error);
      return "";
    });
    const skillLines = PI_SKILL_NAMES.map(
      (name) => `- ${name}: ${PI_SKILLS_ROOT}/${name}/SKILL.md`,
    );
    return [
      "You are camelAI, an AI coding agent running inside the user's camelAI workspace.",
      "Use the provided tools for workspace files, shell commands, container operations, JavaScript code mode, and connections.",
      "File, shell, and container operations execute through sandbox-host; do not assume local Worker filesystem access.",
      "",
      workspaceContext,
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

  private async readWorkspaceContextPrompt(context: ChatContextState): Promise<string> {
    const tools = this.scopedCodeModeTools(context);
    const parts: string[] = [];
    for (const filePath of ["/home/claude/AGENTS.md", "/home/claude/CLAUDE.md", "/AGENTS.md", "/CLAUDE.md"]) {
      try {
        const result = await tools.callTool("read", { path: filePath });
        const content = this.extractToolText(result).trim();
        if (content) {
          parts.push(`## ${filePath}\n${content}`);
        }
      } catch {
        // Optional context file.
      }
    }
    return parts.join("\n\n");
  }

  private async compactPiContext(
    messages: AgentMessage[],
    model: Model<any>,
    apiKey: string,
    completeSimple: typeof import("@mariozechner/pi-ai").completeSimple,
    signal?: AbortSignal,
  ): Promise<AgentMessage[]> {
    const contextWindow = typeof model.contextWindow === "number" && model.contextWindow > 0
      ? model.contextWindow
      : 128_000;
    const reserveTokens = 16_384;
    const keepRecentTokens = 20_000;
    const tokens = this.estimatePiContextTokens(messages);
    if (tokens < contextWindow - reserveTokens) {
      return messages;
    }

    const existing = this.loadPiCoreCompaction();
    if (existing && existing.firstKeptIndex > 0 && existing.firstKeptIndex < messages.length) {
      const tail = messages.slice(existing.firstKeptIndex);
      if (this.estimatePiContextTokens([
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
    try {
      const summary = await this.summarizePiMessages(
        messagesToSummarize,
        model,
        apiKey,
        completeSimple,
        signal,
        previousSummary,
      );
      this.persistPiCoreCompaction(summary, firstKeptIndex);
      return [this.createPiSummaryMessage(summary), ...messages.slice(firstKeptIndex)];
    } catch (error) {
      console.error("[ChatThreadDO] Pi context compaction failed", error);
      return messages;
    }
  }

  private estimatePiContextTokens(messages: AgentMessage[]): number {
    let chars = 0;
    for (const message of messages) {
      chars += JSON.stringify(message).length;
    }
    return Math.ceil(chars / 4);
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
    const serialized = messages
      .map((message) => this.serializePiMessageForSummary(message))
      .filter(Boolean)
      .join("\n\n");
    const previous = previousSummary
      ? `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`
      : "";
    const prompt = `${previous}<conversation>\n${serialized}\n</conversation>\n\nSummarize this coding-agent conversation for future continuation. Preserve exact file paths, commands, tool results that changed decisions, completed work, current goal, constraints, and next steps. Do not answer the conversation.`;
    const response = await completeSimple(
      model,
      {
        systemPrompt: "You produce compact continuation summaries for coding-agent conversations.",
        messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
      },
      {
        apiKey,
        signal,
        maxTokens: 4096,
        ...(model.api === "bedrock-converse-stream"
          ? { bearerToken: apiKey }
          : {}),
      } as Parameters<typeof completeSimple>[2],
    );
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

  private createPiSummaryMessage(summary: string): AgentMessage {
    return {
      role: "user",
      content: `[Context Summary]\n\n${summary}`,
      timestamp: Date.now(),
    };
  }

  private async resolvePiModel(
    context: ChatContextState,
    envVars: Record<string, string>,
    getModelFn: (provider: never, modelId: never) => Model<any>,
  ): Promise<PiResolvedModelConfig> {
    const provider = context.provider === "claude" ? "claude" : "codex";
    const modelId =
      provider === "claude"
        ? envVars.CHIRIDION_CLAUDE_MODEL || "sonnet"
        : envVars.CHIRIDION_CODEX_MODEL || "gpt-5.5";
    const resolved = this.resolvePiModelReference(provider, modelId);
    const model = getModelFn(resolved.provider as never, resolved.modelId as never) as Model<any>;
    if (!model) {
      throw new Error(`Unsupported Pi model ${provider}/${modelId}`);
    }

    const configured = await this.resolvePiRequestConfig(resolved, context);
    const configuredModel =
      configured.requestProvider === "amazon-bedrock" && configured.requestModelId
        ? getModelFn(
            configured.requestProvider as never,
            configured.requestModelId as never,
          ) as Model<any>
        : null;
    if (configured.requestProvider === "amazon-bedrock" && !configuredModel) {
      throw new Error(`Unsupported Bedrock Pi model ${configured.requestModelId}`);
    }
    const modelBase = configuredModel ?? model;
    const usageProvider = configured.usageProvider ?? resolved.provider;
    this.piCurrentBillingSource = configured.billingSource;
    this.piCurrentCreditChargeable = configured.creditChargeable;
    this.piCurrentUsageProvider = usageProvider;
    return {
      model: {
        ...modelBase,
        api: resolved.api ?? modelBase.api,
        id: configured.requestModelId ?? modelBase.id,
        provider: configured.requestProvider ?? modelBase.provider,
        baseUrl: configured.baseUrl || modelBase.baseUrl,
        headers: {
          ...(modelBase.headers ?? {}),
          ...(configured.headers ?? {}),
        },
      },
      apiKey: configured.apiKey,
      headers: configured.headers,
      provider: resolved.provider,
      modelId: resolved.modelId,
      billingSource: configured.billingSource,
      creditChargeable: configured.creditChargeable,
      usageProvider,
    };
  }

  private resolvePiModelReference(
    provider: "claude" | "codex",
    modelId: string,
  ): PiResolvedModelReference {
    const normalizedModelId = this.normalizePiModelId(provider, modelId);
    if (provider === "claude") {
      const reference = (resolvedModelId: string): PiResolvedModelReference => ({
        provider: "anthropic",
        modelId: resolvedModelId,
        hostedGatewayProvider: "openrouter",
        hostedModelId: this.openRouterNitroModel(this.openRouterClaudeModel(resolvedModelId)),
      });
      switch (normalizedModelId) {
        case "haiku":
          return reference("claude-haiku-4-5-20251001");
        case "opus-4.7":
          return reference("claude-opus-4-7");
        case "opus":
          return reference("claude-opus-4-6");
        case "sonnet":
        default:
          return reference("claude-sonnet-4-6");
      }
    }

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
      case "gpt-5.4-mini":
      case "gpt-5.4":
      case "gpt-5.5":
        return openAiReference(normalizedModelId);
      case "kimi-k2.6":
        return openRouterReference("~moonshotai/kimi-latest");
      case "grok-4.3":
        return openRouterResponsesReference("x-ai/grok-4.3");
      case "gemini-3-flash-preview":
        return openRouterReference("google/gemini-3-flash-preview");
      case "gemini-3.1-pro-preview":
        return openRouterReference("google/gemini-3.1-pro-preview");
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

  private normalizePiModelId(provider: "claude" | "codex", modelId: string): string {
    const trimmed = modelId.trim();
    const providerPrefix = `${provider}/`;
    return trimmed.startsWith(providerPrefix)
      ? trimmed.slice(providerPrefix.length)
      : trimmed;
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
        return "anthropic/claude-opus-4.6";
      case "opus-4.7":
      case "claude-opus-4-7":
      case "claude-opus-4.7":
        return "anthropic/claude-opus-4.7";
      case "claude-sonnet-4-6":
        return "anthropic/claude-sonnet-4.6";
      case "claude-opus-4-6":
        return "anthropic/claude-opus-4.6";
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
    if (status === "enterprise") {
      return false;
    }
    if (status === "past_due") {
      throw new Error(
        "Your subscription is past due. Update payment details in Settings -> Billing or add your own API key in Settings -> AI Provider to continue. Your workspace is saved.",
      );
    }
    if (status === "canceled") {
      throw new Error(
        "Your subscription was canceled. Start a new subscription in Settings -> Billing or add your own API key in Settings -> AI Provider to continue. Your workspace is saved.",
      );
    }
    if (status !== "trialing" && status !== "active") {
      throw new Error(
        "Hosted models require billing access. Start a subscription or add your own API key in Settings -> AI Provider. Your workspace is saved.",
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

    const prefix =
      status === "trialing"
        ? "Trial hosted-model credits are used up."
        : "Hosted model credits are used up.";
    throw new Error(
      `${prefix} You have used ${this.formatCreditCents(spentCents)} of ${this.formatCreditCents(totalCreditsCents)}. Buy credits or manage your subscription in Settings -> Billing, or add your own API key in Settings -> AI Provider. Your workspace is saved.`,
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
      case "claude-opus-4-6":
        return "global.anthropic.claude-opus-4-6-v1";
      case "claude-opus-4-7":
        return "global.anthropic.claude-opus-4-7";
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
  ): ReturnType<typeof import("@mariozechner/pi-ai").streamSimple> {
    if (model.api === "bedrock-converse-stream" && options?.apiKey) {
      return streamSimple(model, context, {
        ...options,
        bearerToken: options.apiKey,
      } as Parameters<typeof streamSimple>[2]);
    }
    return streamSimple(model, context, options);
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
            content.push({ type: "image", data: item.data, mimeType: item.mimeType });
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
          "Run JavaScript code mode with access to every registered harness tool through the global tools object. " +
          "Inspect ALL_TOOLS for names, descriptions, and parameter schemas. " +
          "Inside the code, call tools by name, for example: await tools.WebSearch({ query: \"Cloudflare Workers\" }); " +
          "Interactive tools that wait for the user, such as prompt_connection_setup, must be called as top-level tools instead of from js_exec. " +
          "Connection methods are available at context.cloudflare.connections and connections.",
        parameters: Type.Object({
          code: Type.String(),
          timeoutMs: Type.Optional(Type.Number()),
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

    const passthroughToolNames = [
      "AskUserQuestion",
      "ask_user_question",
      "TodoWrite",
      "set_preview",
      "list_apps",
      "set_app_visibility",
      "get_latest_logs",
      "list_scheduled_prompts",
      "create_scheduled_prompt",
      "update_scheduled_prompt",
      "delete_scheduled_prompt",
      "run_scheduled_prompt_now",
      "list_integrations",
      "list_integration_types",
      "create_integration",
      "prompt_connection_setup",
      "capture_bug_report",
      "get_custom_domain",
      "set_custom_domain",
      "remove_custom_domain",
      "retry_custom_domain_hostnames",
      "WebSearch",
      "web_search",
      "WebFetch",
      "web_fetch",
    ];
    const passthroughByName = new Map(
      CODE_MODE_TOOL_DEFINITIONS.map((definition) => [definition.name, definition]),
    );
    for (const name of passthroughToolNames) {
      const definition = passthroughByName.get(name);
      if (!definition) continue;
      definitions.push({
        name,
        label: name,
        description: definition.description,
        parameters: codeModePiToolParameters(name),
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
    const base = await this.createPiSystemPrompt(context);
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

  private piToolResultContent(result: unknown): Array<Record<string, unknown>> {
    if (result && typeof result === "object" && !Array.isArray(result)) {
      const content = (result as Record<string, unknown>).content;
      if (Array.isArray(content)) {
        return content.flatMap((item): Array<Record<string, unknown>> => {
          if (!item || typeof item !== "object") return [];
          const part = item as Record<string, unknown>;
          if (part.type === "text" && typeof part.text === "string") {
            return [{ type: "text", text: part.text }];
          }
          return [];
        });
      }
    }
    const text = this.piToolResultText(result) || this.safeLegacyString(result);
    return text ? [{ type: "text", text }] : [];
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

  private handlePiSessionEvent(event: AgentEvent): void {
    if (event.type === "agent_start") {
      this.piAssistantText = "";
      this.piActiveItemText = "";
      this.piActiveItemId = null;
      this.piReasoningItemId = null;
      this.piToolArgs = new Map();
      this.piTurnStartedAtMs = Date.now();
      this.touchPiTurnRecovery("running");
      this.setChatIsStreaming(true);
      return;
    }

    if (event.type === "turn_start") {
      this.piTurnStartedAtMs = Date.now();
      this.touchPiTurnRecovery("running");
    }

    if (event.type === "turn_end") {
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
      if (!this.isPiAssistantMessage(event.message)) {
        return;
      }
      const text = this.extractPiMessageText(event.message);
      if (text) {
        const itemId = this.piActiveItemId || `pi_agent_${crypto.randomUUID()}`;
        const shouldSendCompleted = this.piActiveItemText.length === 0;
        if (shouldSendCompleted) {
          this.piAssistantText += text;
          this.piActiveItemText = text;
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
      this.upsertPiCoreMessages(
        this.ensurePiAssistantTextMessage([event.message], text),
      );
      return;
    }

    if (event.type === "tool_execution_start") {
      const toolCallId = event.toolCallId || `pi_tool_${crypto.randomUUID()}`;
      const toolName = event.toolName || "tool";
      const args = this.rememberPiToolArgs(toolCallId, this.piEventArgs(event.args));
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
      this.pushPiRuntimeEvent("item/completed", {
        threadId: this.piRuntimeThreadId(),
        item,
      });
      this.upsertPiCoreMessages([{
        role: "toolResult",
        toolCallId,
        toolName,
        content: this.piToolResultContent(event.result),
        details:
          event.result && typeof event.result === "object" && !Array.isArray(event.result)
            ? (event.result as Record<string, unknown>).details
            : undefined,
        isError: event.isError === true,
        timestamp: Date.now(),
      } as unknown as AgentMessage]);
      return;
    }

    if (event.type === "agent_end") {
      const newMessages = this.ensurePiAssistantTextMessage(
        event.messages,
        this.piAssistantText,
      );
      this.upsertPiCoreMessages(newMessages);
      const completedAt = Date.now();
      const threadId = this.chatContext?.threadId || "";
      let finalText = this.piAssistantText || this.extractLatestPiAssistantText(newMessages);
      if (!finalText) {
        finalText = this.getLatestPiAssistantErrorMessage(newMessages);
        if (finalText) {
          this.pushPiRuntimeEvent("item/completed", {
            threadId,
            item: {
              id: `pi_provider_error_${crypto.randomUUID()}`,
              type: "agentMessage",
              text: finalText,
            },
          });
        }
      }
      const forkEntryId = this.latestPiAssistantForkEntryId(newMessages);
      this.pushPiRuntimeEvent("turn/completed", {
        threadId,
        ...(forkEntryId ? { forkEntryId } : {}),
      });
      this.pushChatEvent({
        type: "result",
        threadId,
        result: finalText,
        sessionId: threadId,
        completedAt,
      });
      if (!finalText) {
        const errorMessage = this.getLatestPiAssistantErrorMessage(newMessages);
        if (errorMessage) {
          this.pushChatEvent({
            type: "error",
            error: errorMessage,
            source: "chat_thread_do_pi",
          });
        }
      }
      this.setChatIsStreaming(false, { markUnread: true, completedAt });
      this.setActiveTurnUserId(null);
      this.clearPiTurnRecovery();
      this.completeTodoStateForTurnEnd();
      this.resolvePendingExternalTurn({
        status: "result",
        reply: finalText || undefined,
      });
      this.piActiveItemId = null;
      this.piActiveItemText = "";
      this.piReasoningItemId = null;
      this.piToolArgs = new Map();
      this.piAssistantText = "";
      return;
    }

    this.pushChatEvent({ type: "sdk_event", event });
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

          console.log(
            `[ChatThreadDO] runner websocket closed (code=${event.code})`,
          );
          this.trace("runner_socket_closed", {
            code: event.code,
            reason: event.reason || "",
          });

          this.setChatIsStreaming(false);
          this.setActiveTurnUserId(null);
          this.clearPendingQuestions("runner_socket_close");
          this.resolvePendingExternalTurn({
            status: "error",
            error:
              event.code === RUNNER_CLOSE_CODE_BYOK_CHANGED
                ? "BYOK credentials changed during turn"
                : "Runner websocket closed",
          });
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
      this.lastRunnerSeq = seq;
      this.ctx.storage.kv.put(CHAT_RUNNER_LAST_SEQ_KEY, this.lastRunnerSeq);
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

    if (eventType === "control") return;

    if (eventType === "error") {
      console.error(
        `[ChatThreadDO] runner error: ${JSON.stringify({ error: event.error, source: event.source }).slice(0, 500)}`,
      );
      this.setChatIsStreaming(false);
      this.setActiveTurnUserId(null);
      this.completeTodoStateForTurnEnd();
      this.resolvePendingExternalTurn({
        status: "error",
        error: typeof event.error === "string" ? event.error : "Runner error",
      });
    }

    if (eventType === 'assistant_delta') {
      return;
    }

    if (eventType === 'todo_state') {
      const todos = event.todos;
      if (Array.isArray(todos)) {
        this.currentTodos = normalizeTodoItems(todos);
        if (this.currentTodos.length > 0) {
          this.ctx.storage.kv.put(CHAT_TODOS_KEY, this.currentTodos);
        } else if (typeof this.ctx.storage.kv.delete === "function") {
          this.ctx.storage.kv.delete(CHAT_TODOS_KEY);
        }
      }
    }

    if (eventType === "active_turn_identity") {
      this.setActiveTurnUserId(
        typeof event.userId === "string" ? event.userId : null,
      );
      return;
    }

    if (eventType === "ask_user_question") {
      const questionId =
        typeof event.questionId === "string" ? event.questionId : "";
      const questions = Array.isArray(event.questions) ? event.questions : [];
      if (questionId && questions.length > 0) {
        if (this.pendingQuestions.has(questionId)) {
          this.trace("runner_question_duplicate", { questionId });
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
                "[ChatThreadDO] failed to auto-answer unavailable ask_user_question",
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
        this.setChatIsStreaming(false, { markUnread: true });
        this.setActiveTurnUserId(null);
        this.completeTodoStateForTurnEnd();
        this.resolvePendingExternalTurn({ status: "result" });
      }

    }

    if (eventType === 'runtime_event') {
      const runtimeEvent = event.event;

      const method =
        runtimeEvent && typeof runtimeEvent === 'object' && 'method' in (runtimeEvent as Record<string, unknown>)
          ? (runtimeEvent as { method?: unknown }).method
          : null;

      if (method === 'turn/completed') {
        this.setChatIsStreaming(false, { markUnread: true });
        this.setActiveTurnUserId(null);
        this.completeTodoStateForTurnEnd();
      }
    }

    if (eventType === 'result') {
      this.setChatIsStreaming(false, { markUnread: true });
      this.setActiveTurnUserId(null);
      this.completeTodoStateForTurnEnd();
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
              "[ChatThreadDO] failed to retry unavailable ask_user_question auto-answers",
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
          this.ctx.waitUntil(
            (async () => {
              if (!this.piSession) return;
              await this.refreshPiSessionModel();
              if (this.piSession.state.isStreaming) {
                this.piSession.steer(userMessage);
              } else {
                this.startPiTurnRecovery(userMessage);
                await this.piSession.prompt(userMessage);
              }
            })().catch((error) => {
                console.error("[ChatThreadDO] Pi prompt failed", error);
                this.clearPiTurnRecovery();
                this.pushChatEvent({
                  type: "error",
                  error: error instanceof Error ? error.message : String(error),
                  source: "chat_thread_do_pi",
                });
                this.setChatIsStreaming(false);
                this.setActiveTurnUserId(null);
                this.resolvePendingExternalTurn({
                  status: "error",
                  error: error instanceof Error ? error.message : "Pi prompt failed",
                });
              }),
          );
          return true;
        }
        if (type === "stop") {
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

  private async refreshPiSessionModel(): Promise<void> {
    if (!this.piSession || !this.piModelResolver) {
      return;
    }
    const current = await this.piModelResolver();
    this.piSession.state.model = current.model;
  }

  private startRunnerPingLoop(): void {
    this.stopRunnerPingLoop("restart");
    this.runnerPingTimer = setInterval(() => {
      const sent = this.sendRunnerCommand({ type: "ping", ts: Date.now() });
      this.trace(sent ? "runner_ping_sent" : "runner_ping_send_failed");
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

  private pruneExpiredPendingPrompts(): void {
    const now = Date.now();

    for (const [requestId, info] of this.pendingBugReports.entries()) {
      if (now - info.createdAt >= ChatThreadDO.BUG_REPORT_TIMEOUT_MS) {
        this.pendingBugReports.delete(requestId);
        this.ctx.storage.kv.delete(`pending_bug_report:${requestId}`);
      }
    }
  }

  private sendPendingPromptsToWebSocket(ws: WebSocket): void {
    this.pruneExpiredPendingPrompts();

    const nativeConnectionPrompts = Array.from(
      this.pendingConnectionSetupWaiters.entries(),
    ).sort(([, a], [, b]) => a.info.createdAt - b.info.createdAt);
    for (const [requestId, waiter] of nativeConnectionPrompts) {
      const info = waiter.info;
      this.sendDirect(ws, {
        type: "connection_setup_prompt",
        requestId,
        integrationType: info.integrationType,
        suggestedName: info.suggestedName,
        message: info.message,
        instructions: info.instructions,
        dynamicSchema: info.dynamicSchema,
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

function normalizeCompletionTimestamp(_value: unknown): number {
  return Date.now();
}
