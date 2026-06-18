import type { AppLoadContext } from "react-router";
import { getEnv, type CloudflareEnv } from "./cloudflare.server";
import type {
  Thread,
  Message,
  PaginatedResult,
  PaginationParams,
  LlmProvider,
  LlmModel,
  OrgModelPickerConfig,
  OrganizationExperimentalSettings,
  PreviewTarget,
  WorkspaceModelPickerConfig,
} from "@/types";
import {
  generateThreadTitleWithOpenAI,
} from "./thread-title-generation.server";
import { OrgDO, type OrgThread } from "../../workers/main/src/auth";
import { WorkspaceDO } from "../../workers/main/src/workspace";
import {
  type CustomLlmProviderApi,
  type LlmProviderConfigRecord,
  getDefaultLlmModel,
  getStoredCustomLlmProviderApi,
  getStoredCustomLlmProviderModelId,
  getStoredBedrockAwsRegion,
  isLlmModelAllowedForNewThread,
  isLlmModel,
  normalizeLlmModel,
  replaceLegacyLlmModel,
} from "./llm-provider-config";
import { getEffectiveLlmProviderConfig } from "./selfhost-ai-provider";
import { resolveModelPickerCatalog } from "./model-catalog";
import { parseChannelIndicatorKindsJson } from "./channel-kinds";
import {
  resolveDefaultModelForChat,
  resolveEffectivePickerConfig,
} from "./model-picker-config";
import { retryTransientDurableObjectRead } from "./do-rpc-retry.server";
import { truncateThreadPreviewText } from "./thread-preview";
import { getThreadTitleSourceMessage } from "./thread-title";

interface ParsedThreadMessage {
  id: string;
  thread_id: string;
  role: "user" | "assistant";
  content: unknown;
  created_at: number;
  forkEntryId?: string;
  sentDuringStreaming?: boolean;
  isMeta?: boolean;
  sourceToolUseID?: string;
  isCompactSummary?: boolean;
}

export interface ThreadPreviewState {
  target: PreviewTarget | null;
  tabs: PreviewTarget[];
  activeTabId: string | null;
  version: number;
}

export interface RawThreadCreator {
  created_by: string;
  thread_count: number;
  latest_updated_at: number;
}

interface KnownOrgOptions {
  orgId?: string;
}

interface ModelPickerStateOptions extends KnownOrgOptions {
  llmProviderConfig?: LlmProviderConfigRecord | null;
  experimentalSettings?: OrganizationExperimentalSettings;
}

export function normalizeStoredThreadModel(
  rawModel: unknown,
): { model: LlmModel } {
  const replacement = replaceLegacyLlmModel(rawModel);
  return {
    model: isLlmModel(replacement) ? replacement : normalizeLlmModel(rawModel),
  };
}

// Full thread records are used by single-thread loaders and new-thread
// transcript hydration, so canonical message metadata must remain unbounded.
function toThread(orgThread: OrgThread): Thread {
  const { model } = normalizeStoredThreadModel(orgThread.model);
  return {
    id: orgThread.id,
    workspace_id: orgThread.workspace_id,
    title: orgThread.title,
    created_by: orgThread.created_by,
    model,
    created_at: orgThread.created_at,
    updated_at: orgThread.updated_at,
    user_message_count: orgThread.user_message_count ?? 0,
    first_user_message: orgThread.first_user_message ?? null,
    last_user_message: orgThread.last_user_message ?? null,
    last_user_message_at: orgThread.last_user_message_at ?? null,
    last_assistant_completed_at: orgThread.last_assistant_completed_at ?? null,
    last_assistant_summary: orgThread.last_assistant_summary ?? null,
    last_assistant_summary_status:
      orgThread.last_assistant_summary_status ?? null,
    source: orgThread.source ?? "web",
    channel_kind: orgThread.channel_kind ?? null,
    channel_kinds: parseChannelIndicatorKindsJson(orgThread.channel_kinds),
    channel_connection_id: orgThread.channel_connection_id ?? null,
    channel_conversation_id: orgThread.channel_conversation_id ?? null,
    channel_message_id: orgThread.channel_message_id ?? null,
  };
}

// List and history surfaces should not serialize full prompt text. Keep this
// mapper separate from toThread so transcript hydration keeps full metadata.
function toThreadListPreview(orgThread: OrgThread): Thread {
  const thread = toThread(orgThread);
  return {
    ...thread,
    first_user_message: truncateThreadPreviewText(thread.first_user_message, 500),
    last_user_message: truncateThreadPreviewText(thread.last_user_message, 500),
  };
}

// Helper to get workspace info and org ID
async function getWorkspaceInfo(
  env: CloudflareEnv,
  workspaceId: string,
): Promise<{ org_id: string } | null> {
  const wsStub = env.WORKSPACE.get(
    env.WORKSPACE.idFromName(workspaceId),
  ) as unknown as WorkspaceDO;
  const info = await retryTransientDurableObjectRead("WorkspaceDO.getInfo", () =>
    wsStub.getInfo(),
  );
  if (!info) return null;
  return { org_id: info.org_id };
}

export interface WorkspaceModelPickerState {
  orgId: string;
  llmProvider: LlmProvider | null;
  customApi: CustomLlmProviderApi | null;
  customModelId: string | null;
  awsRegion: string | null;
  experimentalSettings: import("@/types").OrganizationExperimentalSettings;
  allowedThreadModels: LlmModel[];
  effectivePickerDefaultModel: LlmModel | null;
  hasEffectivePickerDefault: boolean;
  defaultModel: LlmModel | null;
}

async function getOrgModelPickerConfigCompat(
  orgStub: OrgDO,
): Promise<OrgModelPickerConfig> {
  return retryTransientDurableObjectRead("OrgDO.getModelPickerConfig", () =>
    Promise.resolve(orgStub.getModelPickerConfig()),
  );
}

async function getWorkspaceModelPickerConfigCompat(
  wsStub: WorkspaceDO,
): Promise<WorkspaceModelPickerConfig> {
  return retryTransientDurableObjectRead(
    "WorkspaceDO.getModelPickerConfig",
    () => Promise.resolve(wsStub.getModelPickerConfig()),
  );
}

export async function getWorkspaceModelPickerState(
  context: AppLoadContext,
  workspaceId: string,
  options: ModelPickerStateOptions = {},
): Promise<WorkspaceModelPickerState | null> {
  const env = getEnv(context);
  let orgId = options.orgId;
  if (!orgId) {
    const wsInfo = await getWorkspaceInfo(env, workspaceId);
    if (!wsInfo) return null;
    orgId = wsInfo.org_id;
  }

  return getWorkspaceModelPickerStateForOrg(context, orgId, workspaceId, options);
}

async function getWorkspaceModelPickerStateForOrg(
  context: AppLoadContext,
  orgId: string,
  workspaceId: string,
  options: ModelPickerStateOptions = {},
): Promise<WorkspaceModelPickerState> {
  const env = getEnv(context);
  const orgStub = getOrgStub(env, orgId);
  const wsStub = env.WORKSPACE.get(
    env.WORKSPACE.idFromName(workspaceId),
  ) as unknown as WorkspaceDO;
  const [llmProviderConfig, experimentalSettings] = await Promise.all([
    options.llmProviderConfig !== undefined
      ? Promise.resolve(options.llmProviderConfig)
      : retryTransientDurableObjectRead("OrgDO.getLlmProviderConfig", () =>
          Promise.resolve(orgStub.getLlmProviderConfig()),
        ),
    options.experimentalSettings !== undefined
      ? Promise.resolve(options.experimentalSettings)
      : retryTransientDurableObjectRead("OrgDO.getExperimentalSettings", () =>
          Promise.resolve(orgStub.getExperimentalSettings()),
        ),
  ]);
  const effectiveLlmProviderConfig = getEffectiveLlmProviderConfig(
    env,
    llmProviderConfig,
  );
  const customApi = getStoredCustomLlmProviderApi(effectiveLlmProviderConfig);
  const customModelId = getStoredCustomLlmProviderModelId(effectiveLlmProviderConfig);
  const awsRegion = getStoredBedrockAwsRegion(effectiveLlmProviderConfig);
  const [orgPickerConfig, workspacePickerConfig] = await Promise.all([
    getOrgModelPickerConfigCompat(orgStub),
    getWorkspaceModelPickerConfigCompat(wsStub),
  ]);
  const effectiveConfig = resolveEffectivePickerConfig(
    orgPickerConfig,
    workspacePickerConfig,
  );
  const visibleCatalog = resolveModelPickerCatalog({
    effectiveConfig,
    experimentalSettings,
    orgProvider: effectiveLlmProviderConfig?.provider,
    customApi,
    customModelId,
    awsRegion,
  });
  const defaultModel = resolveDefaultModelForChat({
    effectiveDefaultModel: effectiveConfig.default_model,
    fallbackModel: getDefaultLlmModel(effectiveLlmProviderConfig?.provider, {
      customApi,
      customModelId,
    }),
    visibleCatalog,
  });

  return {
    orgId,
    llmProvider: (effectiveLlmProviderConfig?.provider ?? null) as LlmProvider | null,
    customApi,
    customModelId,
    awsRegion,
    experimentalSettings,
    allowedThreadModels: visibleCatalog.map((entry) => entry.id),
    effectivePickerDefaultModel: effectiveConfig.default_model,
    hasEffectivePickerDefault: effectiveConfig.default_model !== null,
    defaultModel,
  };
}

async function resolveCreateThreadModel(
  context: AppLoadContext,
  workspaceId: string,
  requestedModel?: unknown,
  knownOrgId?: string,
): Promise<{ orgId: string; model: LlmModel }> {
  const pickerState = knownOrgId
    ? await getWorkspaceModelPickerStateForOrg(context, knownOrgId, workspaceId)
    : await getWorkspaceModelPickerState(context, workspaceId);
  if (!pickerState || pickerState.allowedThreadModels.length === 0) {
    throw new Error("No models are available");
  }

  const selectedModel =
    requestedModel == null
      ? pickerState.defaultModel
      : replaceLegacyLlmModel(requestedModel);
  if (!selectedModel) {
    throw new Error("No models are available");
  }
  if (
    !isLlmModel(selectedModel) ||
    !isLlmModelAllowedForNewThread(
      selectedModel,
      pickerState.llmProvider,
      pickerState.experimentalSettings,
      {
        customApi: pickerState.customApi,
        customModelId: pickerState.customModelId,
        awsRegion: pickerState.awsRegion,
      },
    ) ||
    !pickerState.allowedThreadModels.includes(selectedModel)
  ) {
    throw new Error("Invalid thread model");
  }

  return { orgId: pickerState.orgId, model: selectedModel };
}

// Helper to get OrgDO stub
function getOrgStub(env: CloudflareEnv, orgId: string): OrgDO {
  return env.ORG.get(env.ORG.idFromName(orgId)) as unknown as OrgDO;
}

export async function getThreads(
  context: AppLoadContext,
  workspaceId: string,
): Promise<Thread[]> {
  const env = getEnv(context);
  const wsInfo = await getWorkspaceInfo(env, workspaceId);
  if (!wsInfo) return [];
  const orgStub = env.ORG.get(env.ORG.idFromName(wsInfo.org_id));
  const threads = await orgStub.getThreadsByWorkspace(workspaceId);
  return threads.map((t) => toThreadListPreview(t));
}

export async function getThreadsPaginated(
  context: AppLoadContext,
  workspaceId: string,
  params: PaginationParams = {},
  options: KnownOrgOptions = {},
): Promise<PaginatedResult<Thread>> {
  const env = getEnv(context);
  const offset = params.offset ?? 0;
  const limit = params.limit ?? 50;
  let orgId = options.orgId;
  if (!orgId) {
    const wsInfo = await getWorkspaceInfo(env, workspaceId);
    if (!wsInfo) {
      return { items: [], total: 0, offset, limit };
    }
    orgId = wsInfo.org_id;
  }
  const orgStub = getOrgStub(env, orgId);
  const result = await orgStub.getThreadsPaginated(
    offset,
    limit,
    workspaceId,
    params.createdBy,
  );
  return {
    items: result.items.map((t) => toThreadListPreview(t)),
    total: result.total,
    offset: result.offset,
    limit: result.limit,
  };
}

export async function getThreadsPaginatedAllWorkspaces(
  context: AppLoadContext,
  workspaceIds: string[],
  params: PaginationParams = {},
  options: KnownOrgOptions = {},
): Promise<PaginatedResult<Thread>> {
  const env = getEnv(context);
  const offset = params.offset ?? 0;
  const limit = params.limit ?? 50;
  if (workspaceIds.length === 0) {
    return { items: [], total: 0, offset, limit };
  }
  let orgId = options.orgId;
  if (!orgId) {
    const wsInfo = await getWorkspaceInfo(env, workspaceIds[0]);
    if (!wsInfo) {
      return { items: [], total: 0, offset, limit };
    }
    orgId = wsInfo.org_id;
  }
  const orgStub = getOrgStub(env, orgId);
  const result = await orgStub.getThreadsAllWorkspacesPaginated(
    workspaceIds,
    offset,
    limit,
    params.createdBy,
  );
  return {
    items: result.items.map((t) => toThreadListPreview(t)),
    total: result.total,
    offset: result.offset,
    limit: result.limit,
  };
}

export async function getThreadCreators(
  context: AppLoadContext,
  workspaceId: string,
  options: KnownOrgOptions = {},
): Promise<RawThreadCreator[]> {
  const env = getEnv(context);
  let orgId = options.orgId;
  if (!orgId) {
    const wsInfo = await getWorkspaceInfo(env, workspaceId);
    if (!wsInfo) {
      return [];
    }
    orgId = wsInfo.org_id;
  }
  const orgStub = getOrgStub(env, orgId);
  return await orgStub.getThreadCreators(workspaceId);
}

export async function getThreadCreatorsAllWorkspaces(
  context: AppLoadContext,
  workspaceIds: string[],
  options: KnownOrgOptions = {},
): Promise<RawThreadCreator[]> {
  if (workspaceIds.length === 0) {
    return [];
  }
  const env = getEnv(context);
  let orgId = options.orgId;
  if (!orgId) {
    const wsInfo = await getWorkspaceInfo(env, workspaceIds[0]);
    if (!wsInfo) {
      return [];
    }
    orgId = wsInfo.org_id;
  }
  const orgStub = getOrgStub(env, orgId);
  return await orgStub.getThreadCreatorsAllWorkspaces(workspaceIds);
}

export async function createThread(
  context: AppLoadContext,
  workspaceId: string,
  title: string | undefined,
  createdBy?: string,
  firstUserMessage?: string,
  model?: unknown,
): Promise<Thread> {
  const env = getEnv(context);
  const { orgId, model: selectedModel } = await resolveCreateThreadModel(
    context,
    workspaceId,
    model,
  );
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  const thread = await orgStub.createThread(
    workspaceId,
    title,
    createdBy,
    firstUserMessage,
    selectedModel,
  );
  return toThread(thread);
}

export async function createThreadWithValidatedAccess(
  context: AppLoadContext,
  orgId: string,
  workspaceId: string,
  title: string | undefined,
  createdBy: string | undefined,
  firstUserMessage: string | undefined,
  model?: unknown,
): Promise<Thread> {
  const env = getEnv(context);
  const { model: selectedModel } = await resolveCreateThreadModel(
    context,
    workspaceId,
    model,
    orgId,
  );
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  const thread = await orgStub.createThread(
    workspaceId,
    title,
    createdBy,
    firstUserMessage,
    selectedModel,
  );
  return toThread(thread);
}

export async function getRecentThreads(
  context: AppLoadContext,
  workspaceId: string,
  limit = 6,
  createdBy?: string,
  options: KnownOrgOptions = {},
): Promise<Thread[]> {
  const env = getEnv(context);
  let orgId = options.orgId;
  if (!orgId) {
    const wsInfo = await getWorkspaceInfo(env, workspaceId);
    if (!wsInfo) return [];
    orgId = wsInfo.org_id;
  }
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  const result = await orgStub.getThreadsPaginated(
    0,
    limit,
    workspaceId,
    createdBy,
  );
  return result.items.map((t) => toThreadListPreview(t));
}

export async function getThread(
  context: AppLoadContext,
  id: string,
  workspaceId: string,
  options: KnownOrgOptions = {},
): Promise<Thread | null> {
  const env = getEnv(context);
  let orgId = options.orgId;
  if (!orgId) {
    const wsInfo = await getWorkspaceInfo(env, workspaceId);
    if (!wsInfo) return null;
    orgId = wsInfo.org_id;
  }
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  const thread = await retryTransientDurableObjectRead("OrgDO.getThread", () =>
    orgStub.getThread(id),
  );
  if (!thread) return null;
  // Verify the thread belongs to this workspace
  if (thread.workspace_id !== workspaceId) return null;
  return toThread(thread);
}

export async function getThreadsByIds(
  context: AppLoadContext,
  workspaceId: string,
  threadIds: string[],
): Promise<Thread[]> {
  const env = getEnv(context);
  const wsInfo = await getWorkspaceInfo(env, workspaceId);
  if (!wsInfo) return [];
  const uniqueThreadIds = Array.from(
    new Set(threadIds.map((threadId) => threadId.trim()).filter(Boolean)),
  );
  if (uniqueThreadIds.length === 0) return [];
  const orgStub = env.ORG.get(env.ORG.idFromName(wsInfo.org_id));
  const threads = await retryTransientDurableObjectRead(
    "OrgDO.getThreadsByIds",
    () => orgStub.getThreadsByIds(workspaceId, uniqueThreadIds),
  );
  return threads.map((thread) => toThreadListPreview(thread));
}

export async function updateThread(
  context: AppLoadContext,
  id: string,
  title: string,
  workspaceId: string,
  options: KnownOrgOptions = {},
): Promise<Thread | null> {
  const env = getEnv(context);
  let orgId = options.orgId;
  if (!orgId) {
    const wsInfo = await getWorkspaceInfo(env, workspaceId);
    if (!wsInfo) return null;
    orgId = wsInfo.org_id;
  }
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  // Verify the thread belongs to this workspace first
  const existing = await orgStub.getThread(id);
  if (!existing || existing.workspace_id !== workspaceId) return null;
  const thread = await orgStub.updateThread(id, title);
  if (!thread) return null;
  return toThread(thread);
}

export async function updateThreadModel(
  context: AppLoadContext,
  id: string,
  model: LlmModel,
  workspaceId: string,
  options: ModelPickerStateOptions = {},
): Promise<Thread | null> {
  const env = getEnv(context);
  let orgId = options.orgId;
  if (!orgId) {
    const wsInfo = await getWorkspaceInfo(env, workspaceId);
    if (!wsInfo) return null;
    orgId = wsInfo.org_id;
  }
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  const existing = await orgStub.getThread(id);
  if (!existing || existing.workspace_id !== workspaceId) return null;
  const pickerState = await getWorkspaceModelPickerState(
    context,
    workspaceId,
    { ...options, orgId },
  );
  if (
    !pickerState ||
    !isLlmModelAllowedForNewThread(
      model,
      pickerState.llmProvider,
      pickerState.experimentalSettings,
      {
        customApi: pickerState.customApi,
        customModelId: pickerState.customModelId,
        awsRegion: pickerState.awsRegion,
      },
    ) ||
    !pickerState.allowedThreadModels.includes(model)
  ) {
    throw new Error("Invalid thread model");
  }
  const updated = await orgStub.updateThreadModel(id, model);
  return updated ? toThread(updated) : null;
}

export async function setThreadFirstUserMessage(
  context: AppLoadContext,
  id: string,
  firstUserMessage: string,
  workspaceId: string,
): Promise<Thread | null> {
  const env = getEnv(context);
  const wsInfo = await getWorkspaceInfo(env, workspaceId);
  if (!wsInfo) return null;
  const orgStub = env.ORG.get(env.ORG.idFromName(wsInfo.org_id));
  // Verify the thread belongs to this workspace first
  const existing = await orgStub.getThread(id);
  if (!existing || existing.workspace_id !== workspaceId) return null;
  const thread = await orgStub.setThreadFirstUserMessage(id, firstUserMessage);
  if (!thread) return null;
  return toThread(thread);
}

export async function deleteThread(
  context: AppLoadContext,
  id: string,
  workspaceId: string,
  options: KnownOrgOptions = {},
): Promise<boolean> {
  const env = getEnv(context);
  let orgId = options.orgId;
  if (!orgId) {
    const wsInfo = await getWorkspaceInfo(env, workspaceId);
    if (!wsInfo) return false;
    orgId = wsInfo.org_id;
  }
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  // Verify the thread belongs to this workspace first
  const existing = await orgStub.getThread(id);
  if (!existing || existing.workspace_id !== workspaceId) return false;
  await orgStub.deleteThread(id);
  return true;
}

export async function generateThreadTitle(
  context: AppLoadContext,
  threadId: string,
  workspaceId: string,
  message: string,
  userId?: string | null,
): Promise<void> {
  try {
    const env = getEnv(context);

    const wsInfo = await getWorkspaceInfo(env, workspaceId);
    if (!wsInfo) return;

    const titleSourceMessage = getThreadTitleSourceMessage(message);
    if (!titleSourceMessage) return;

    const title = await generateThreadTitleWithOpenAI(
      env.AI as never,
      titleSourceMessage,
      {
        orgId: wsInfo.org_id,
        workspaceId,
        threadId,
      },
      { gatewayName: env.CF_GATEWAY_NAME },
    );
    if (!title) return;

    const orgStub = env.ORG.get(env.ORG.idFromName(wsInfo.org_id));
    const updated = await orgStub.updateThread(threadId, title);
    if (userId) {
      await env.USER.get(env.USER.idFromName(userId))
        .renameEmptySingleThreadGroupForThread(threadId, title);
    }

    const threadStub = env.CHAT_THREAD.get(
      env.CHAT_THREAD.idFromName(threadId),
    );
    await threadStub.setTitle(title, updated?.updated_at);
  } catch (e) {
    console.error("[generateThreadTitle] Error:", e);
  }
}

export async function getLegacyClaudeSessionId(
  context: AppLoadContext,
  threadId: string,
): Promise<string | null> {
  const env = getEnv(context);
  if (
    !env ||
    typeof env !== "object" ||
    !("CHAT_THREAD" in env) ||
    !env.CHAT_THREAD
  ) {
    return null;
  }
  const threadStub = env.CHAT_THREAD.get(env.CHAT_THREAD.idFromName(threadId));
  const sessionId = await threadStub
    .getLegacyClaudeSessionId()
    .catch(() => null);
  return typeof sessionId === "string" && sessionId.trim()
    ? sessionId.trim()
    : null;
}

export async function getCodexSessionId(
  context: AppLoadContext,
  threadId: string,
): Promise<string | null> {
  const env = getEnv(context);
  if (
    !env ||
    typeof env !== "object" ||
    !("CHAT_THREAD" in env) ||
    !env.CHAT_THREAD
  ) {
    return null;
  }
  const threadStub = env.CHAT_THREAD.get(env.CHAT_THREAD.idFromName(threadId));
  const sessionId = await threadStub.getCodexSessionId().catch(() => null);
  return typeof sessionId === "string" && sessionId.trim()
    ? sessionId.trim()
    : null;
}

export async function getPiCoreMessages(
  context: AppLoadContext,
  threadId: string,
): Promise<ParsedThreadMessage[]> {
  const env = getEnv(context);
  if (
    !env ||
    typeof env !== "object" ||
    !("CHAT_THREAD" in env) ||
    !env.CHAT_THREAD
  ) {
    throw new Error("CHAT_THREAD binding is not available");
  }
  const threadStub = env.CHAT_THREAD.get(env.CHAT_THREAD.idFromName(threadId));
  const messages = await Promise.resolve(
    (
      threadStub as unknown as {
        getPiCoreParsedMessages(threadId: string): Promise<ParsedThreadMessage[]> | ParsedThreadMessage[];
      }
    ).getPiCoreParsedMessages(threadId),
  );
  return Array.isArray(messages) ? messages : [];
}

export async function hydratePiCoreFromParsedMessages(
  context: AppLoadContext,
  threadId: string,
  messages: ParsedThreadMessage[],
): Promise<{ hydrated: boolean; count: number; existingCount: number; deferred?: boolean } | null> {
  if (messages.length === 0) return null;
  const env = getEnv(context);
  if (
    !env ||
    typeof env !== "object" ||
    !("CHAT_THREAD" in env) ||
    !env.CHAT_THREAD
  ) {
    return null;
  }
  const threadStub = env.CHAT_THREAD.get(env.CHAT_THREAD.idFromName(threadId));
  const result = await Promise.resolve(
    (
      threadStub as unknown as {
        hydratePiCoreFromParsedMessages(
          threadId: string,
          messages: ParsedThreadMessage[],
        ): Promise<{ hydrated: boolean; count: number; existingCount: number; deferred?: boolean }> | { hydrated: boolean; count: number; existingCount: number; deferred?: boolean };
      }
    ).hydratePiCoreFromParsedMessages(threadId, messages),
  );
  return result && typeof result === "object" ? result : null;
}

export async function getTodoState(
  context: AppLoadContext,
  threadId: string,
): Promise<unknown[]> {
  const env = getEnv(context);
  if (
    !env ||
    typeof env !== "object" ||
    !("CHAT_THREAD" in env) ||
    !env.CHAT_THREAD
  ) {
    return [];
  }
  const threadStub = env.CHAT_THREAD.get(env.CHAT_THREAD.idFromName(threadId));
  const todos = await Promise.resolve(
    (
      threadStub as unknown as {
        getTodoState(): Promise<unknown[]> | unknown[];
      }
    ).getTodoState(),
  ).catch(() => []);
  return Array.isArray(todos) ? todos : [];
}

export async function getMessages(
  context: AppLoadContext,
  threadId: string,
  _workspaceId: string,
  options: { skipBanCheck?: boolean } = {},
): Promise<Message[]> {
  try {
    void options;
    const piMessages = await getPiCoreMessages(context, threadId);
    if (piMessages.length > 0) {
      return piMessages as Message[];
    }

    return [];
  } catch (e) {
    console.error("[getMessages] Error:", e);
    return [];
  }
}

export async function setThreadPreviewTarget(
  context: AppLoadContext,
  threadId: string,
  target: PreviewTarget | null,
): Promise<PreviewTarget | null> {
  const env = getEnv(context);
  const stub = env.CHAT_THREAD.get(env.CHAT_THREAD.idFromName(threadId));
  await stub.setPreviewTarget(target);
  return stub.getPreviewTarget();
}

export async function setThreadPreviewAppVisibility(
  context: AppLoadContext,
  threadId: string,
  scriptName: string,
  isPublic: boolean,
): Promise<void> {
  const env = getEnv(context);
  const stub = env.CHAT_THREAD.get(env.CHAT_THREAD.idFromName(threadId));
  await stub.setPreviewAppVisibility(scriptName, isPublic);
}

export async function getThreadPreviewTarget(
  context: AppLoadContext,
  threadId: string,
): Promise<PreviewTarget | null> {
  const state = await getThreadPreviewState(context, threadId);
  return state.target;
}

export async function getThreadPreviewState(
  context: AppLoadContext,
  threadId: string,
): Promise<ThreadPreviewState> {
  const env = getEnv(context);
  const stub = env.CHAT_THREAD.get(env.CHAT_THREAD.idFromName(threadId));
  const state = await stub.getPreviewState() as ThreadPreviewState | null | undefined;
  return {
    target: state?.target ?? null,
    tabs: Array.isArray(state?.tabs) ? state.tabs : [],
    activeTabId:
      typeof state?.activeTabId === "string" ? state.activeTabId : null,
    version: typeof state?.version === "number" ? state.version : 0,
  };
}
