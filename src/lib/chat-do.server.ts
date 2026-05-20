import type { AppLoadContext } from "react-router";
import { getEnv, type CloudflareEnv } from "./cloudflare.server";
import type {
  Thread,
  Message,
  PaginatedResult,
  PaginationParams,
  ChatHarness,
  LlmProvider,
  LlmModel,
  OrgModelPickerConfig,
  PreviewTarget,
  WorkspaceModelPickerConfig,
} from "@/types";
import {
  generateThreadTitleWithOpenAI,
} from "./thread-title-generation.server";
import { OrgDO, type OrgThread } from "../../workers/main/src/auth";
import { WorkspaceDO } from "../../workers/main/src/workspace";
import {
  WorkspaceContainer,
  type WorkspaceContainerEnv,
} from "../../workers/main/src/workspace-container";
import {
  getDefaultLlmModel,
  isLlmModelAllowedForNewThread,
  getDefaultThreadProvider,
  getProviderForModel,
  isLlmModel,
  normalizeLlmModel,
  replaceLegacyLlmModel,
} from "./llm-provider-config";
import { resolveModelPickerCatalog } from "./model-catalog";
import {
  defaultOrgModelPickerConfig,
  defaultWorkspaceModelPickerConfig,
  resolveDefaultModelForChat,
  resolveEffectivePickerConfig,
} from "./model-picker-config";
import { readMessagesFromResponse } from "./thread-messages.server";
import { retryTransientDurableObjectRead } from "./do-rpc-retry.server";

interface ParsedThreadMessage {
  id: string;
  thread_id: string;
  role: "user" | "assistant";
  content: unknown;
  created_at: number;
  forkEntryId?: string;
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

export function normalizeStoredThreadModel(
  rawModel: unknown,
  rawProvider?: ChatHarness | null,
): { model: LlmModel; provider: ChatHarness } {
  const replacement = replaceLegacyLlmModel(rawModel);
  const isLegacyReplacement = replacement !== rawModel;
  if (isLegacyReplacement && isLlmModel(replacement)) {
    return {
      provider: getProviderForModel(replacement, rawProvider ?? "claude"),
      model: replacement,
    };
  }
  const provider =
    rawProvider ??
    (isLlmModel(replacement) ? getProviderForModel(replacement) : "claude");
  return {
    provider,
    model: normalizeLlmModel(rawModel, provider),
  };
}

// Helper to convert OrgThread to Thread
function toThread(orgThread: OrgThread): Thread {
  const { model, provider } = normalizeStoredThreadModel(
    orgThread.model,
    orgThread.provider,
  );
  return {
    id: orgThread.id,
    workspace_id: orgThread.workspace_id,
    title: orgThread.title,
    provider,
    created_by: orgThread.created_by,
    model,
    created_at: orgThread.created_at,
    updated_at: orgThread.updated_at,
    user_message_count: orgThread.user_message_count ?? 0,
    first_user_message: orgThread.first_user_message ?? null,
    last_user_message: orgThread.last_user_message ?? null,
    last_assistant_completed_at: orgThread.last_assistant_completed_at ?? null,
    last_assistant_summary: orgThread.last_assistant_summary ?? null,
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
  provider: ChatHarness;
  llmProvider: LlmProvider | null;
  experimentalSettings: import("@/types").OrganizationExperimentalSettings;
  allowedThreadModels: LlmModel[];
  effectivePickerDefaultModel: LlmModel | null;
  hasEffectivePickerDefault: boolean;
  defaultModel: LlmModel | null;
}

async function getOrgModelPickerConfigCompat(
  orgStub: OrgDO,
  orgProvider?: LlmProvider | string | null,
): Promise<OrgModelPickerConfig> {
  try {
    const maybeStub = orgStub as { getModelPickerConfig?: unknown };
    if (typeof maybeStub.getModelPickerConfig !== "function") {
      return defaultOrgModelPickerConfig(orgProvider);
    }
    return await orgStub.getModelPickerConfig();
  } catch (error) {
    if (!isMissingModelPickerConfigRpcError(error)) {
      throw error;
    }
    return defaultOrgModelPickerConfig(orgProvider);
  }
}

async function getWorkspaceModelPickerConfigCompat(
  wsStub: WorkspaceDO,
): Promise<WorkspaceModelPickerConfig> {
  try {
    const maybeStub = wsStub as { getModelPickerConfig?: unknown };
    if (typeof maybeStub.getModelPickerConfig !== "function") {
      return defaultWorkspaceModelPickerConfig();
    }
    return await wsStub.getModelPickerConfig();
  } catch (error) {
    if (!isMissingModelPickerConfigRpcError(error)) {
      throw error;
    }
    return defaultWorkspaceModelPickerConfig();
  }
}

function isMissingModelPickerConfigRpcError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message.toLowerCase()
      : String(error).toLowerCase();
  return (
    message.includes("getmodelpickerconfig") &&
    (message.includes("no such rpc method") ||
      message.includes("no such method") ||
      message.includes("not a function"))
  );
}

export async function getWorkspaceModelPickerState(
  context: AppLoadContext,
  workspaceId: string,
  preferredProvider?: ChatHarness | null,
): Promise<WorkspaceModelPickerState | null> {
  const env = getEnv(context);
  const wsInfo = await getWorkspaceInfo(env, workspaceId);
  if (!wsInfo) return null;

  const orgStub = getOrgStub(env, wsInfo.org_id);
  const wsStub = env.WORKSPACE.get(
    env.WORKSPACE.idFromName(workspaceId),
  ) as unknown as WorkspaceDO;
  const [llmProviderConfig, experimentalSettings] = await Promise.all([
    orgStub.getLlmProviderConfig(),
    orgStub.getExperimentalSettings(),
  ]);
  const [orgPickerConfig, workspacePickerConfig] = await Promise.all([
    getOrgModelPickerConfigCompat(orgStub, llmProviderConfig?.provider),
    getWorkspaceModelPickerConfigCompat(wsStub),
  ]);
  const baseProvider =
    preferredProvider ??
    getDefaultThreadProvider(llmProviderConfig?.provider, experimentalSettings);
  const effectiveConfig = resolveEffectivePickerConfig(
    orgPickerConfig,
    workspacePickerConfig,
  );
  const visibleCatalog = resolveModelPickerCatalog({
    effectiveConfig,
    provider: baseProvider,
    experimentalSettings,
    orgProvider: llmProviderConfig?.provider,
  });
  const defaultModel = resolveDefaultModelForChat({
    effectiveDefaultModel: effectiveConfig.default_model,
    fallbackModel: getDefaultLlmModel(baseProvider, llmProviderConfig?.provider),
    visibleCatalog,
  });
  const provider = defaultModel
    ? getProviderForModel(defaultModel, baseProvider)
    : baseProvider;

  return {
    orgId: wsInfo.org_id,
    provider,
    llmProvider: (llmProviderConfig?.provider ?? null) as LlmProvider | null,
    experimentalSettings,
    allowedThreadModels: visibleCatalog.map((entry) => entry.id),
    effectivePickerDefaultModel: effectiveConfig.default_model,
    hasEffectivePickerDefault: effectiveConfig.default_model !== null,
    defaultModel,
  };
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
  return threads.map((t) => toThread(t));
}

export async function getThreadsPaginated(
  context: AppLoadContext,
  workspaceId: string,
  params: PaginationParams = {},
): Promise<PaginatedResult<Thread>> {
  const env = getEnv(context);
  const offset = params.offset ?? 0;
  const limit = params.limit ?? 50;
  const wsInfo = await getWorkspaceInfo(env, workspaceId);
  if (!wsInfo) {
    return { items: [], total: 0, offset, limit };
  }
  const orgStub = getOrgStub(env, wsInfo.org_id);
  const result = await orgStub.getThreadsPaginated(
    offset,
    limit,
    workspaceId,
    params.createdBy,
  );
  return {
    items: result.items.map((t) => toThread(t)),
    total: result.total,
    offset: result.offset,
    limit: result.limit,
  };
}

export async function getThreadsPaginatedAllWorkspaces(
  context: AppLoadContext,
  workspaceIds: string[],
  params: PaginationParams = {},
): Promise<PaginatedResult<Thread>> {
  const env = getEnv(context);
  const offset = params.offset ?? 0;
  const limit = params.limit ?? 50;
  if (workspaceIds.length === 0) {
    return { items: [], total: 0, offset, limit };
  }
  const wsInfo = await getWorkspaceInfo(env, workspaceIds[0]);
  if (!wsInfo) {
    return { items: [], total: 0, offset, limit };
  }
  const orgStub = getOrgStub(env, wsInfo.org_id);
  const result = await orgStub.getThreadsAllWorkspacesPaginated(
    workspaceIds,
    offset,
    limit,
    params.createdBy,
  );
  return {
    items: result.items.map((t) => toThread(t)),
    total: result.total,
    offset: result.offset,
    limit: result.limit,
  };
}

export async function getThreadCreators(
  context: AppLoadContext,
  workspaceId: string,
): Promise<RawThreadCreator[]> {
  const env = getEnv(context);
  const wsInfo = await getWorkspaceInfo(env, workspaceId);
  if (!wsInfo) {
    return [];
  }
  const orgStub = getOrgStub(env, wsInfo.org_id);
  return await orgStub.getThreadCreators(workspaceId);
}

export async function getThreadCreatorsAllWorkspaces(
  context: AppLoadContext,
  workspaceIds: string[],
): Promise<RawThreadCreator[]> {
  if (workspaceIds.length === 0) {
    return [];
  }
  const env = getEnv(context);
  const wsInfo = await getWorkspaceInfo(env, workspaceIds[0]);
  if (!wsInfo) {
    return [];
  }
  const orgStub = getOrgStub(env, wsInfo.org_id);
  return await orgStub.getThreadCreatorsAllWorkspaces(workspaceIds);
}

export async function createThread(
  context: AppLoadContext,
  workspaceId: string,
  title: string | undefined,
  createdBy?: string,
  firstUserMessage?: string,
  model?: LlmModel,
): Promise<Thread> {
  const env = getEnv(context);
  const pickerState = await getWorkspaceModelPickerState(
    context,
    workspaceId,
  );
  if (!pickerState || pickerState.allowedThreadModels.length === 0) {
    throw new Error("No models are available");
  }
  const orgStub = env.ORG.get(env.ORG.idFromName(pickerState.orgId));
  const selectedModel = model ?? pickerState.defaultModel;
  if (!selectedModel) {
    throw new Error("No models are available");
  }
  if (
    !isLlmModelAllowedForNewThread(
      selectedModel,
      pickerState.llmProvider,
      pickerState.experimentalSettings,
    ) ||
    !pickerState.allowedThreadModels.includes(selectedModel)
  ) {
    throw new Error("Invalid thread model");
  }
  const provider = getProviderForModel(selectedModel, pickerState.provider);
  const thread = await orgStub.createThread(
    workspaceId,
    title,
    createdBy,
    firstUserMessage,
    selectedModel,
    provider,
  );
  return toThread(thread);
}

export async function getRecentThreads(
  context: AppLoadContext,
  workspaceId: string,
  limit = 6,
  createdBy?: string,
): Promise<Thread[]> {
  const env = getEnv(context);
  const wsInfo = await getWorkspaceInfo(env, workspaceId);
  if (!wsInfo) return [];
  const orgStub = env.ORG.get(env.ORG.idFromName(wsInfo.org_id));
  const result = await orgStub.getThreadsPaginated(
    0,
    limit,
    workspaceId,
    createdBy,
  );
  return result.items.map((t) => toThread(t));
}

export async function getThread(
  context: AppLoadContext,
  id: string,
  workspaceId: string,
): Promise<Thread | null> {
  const env = getEnv(context);
  const wsInfo = await getWorkspaceInfo(env, workspaceId);
  if (!wsInfo) return null;
  const orgStub = env.ORG.get(env.ORG.idFromName(wsInfo.org_id));
  const thread = await retryTransientDurableObjectRead("OrgDO.getThread", () =>
    orgStub.getThread(id),
  );
  if (!thread) return null;
  // Verify the thread belongs to this workspace
  if (thread.workspace_id !== workspaceId) return null;
  return toThread(thread);
}

export async function updateThread(
  context: AppLoadContext,
  id: string,
  title: string,
  workspaceId: string,
): Promise<Thread | null> {
  const env = getEnv(context);
  const wsInfo = await getWorkspaceInfo(env, workspaceId);
  if (!wsInfo) return null;
  const orgStub = env.ORG.get(env.ORG.idFromName(wsInfo.org_id));
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
): Promise<Thread | null> {
  const env = getEnv(context);
  const wsInfo = await getWorkspaceInfo(env, workspaceId);
  if (!wsInfo) return null;
  const orgStub = env.ORG.get(env.ORG.idFromName(wsInfo.org_id));
  const existing = await orgStub.getThread(id);
  if (!existing || existing.workspace_id !== workspaceId) return null;
  const llmProviderConfig = await orgStub.getLlmProviderConfig();
  const experimentalSettings = await orgStub.getExperimentalSettings();
  const pickerState = await getWorkspaceModelPickerState(
    context,
    workspaceId,
    existing.provider ?? "claude",
  );
  if (
    !isLlmModelAllowedForNewThread(
      model,
      llmProviderConfig?.provider,
      experimentalSettings,
    ) ||
    !pickerState?.allowedThreadModels.includes(model)
  ) {
    throw new Error("Invalid thread model");
  }
  const provider = getProviderForModel(model, existing.provider ?? "claude");
  const updated = await orgStub.updateThreadModel(
    id,
    model,
    undefined,
    provider,
  );
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
): Promise<boolean> {
  const env = getEnv(context);
  const wsInfo = await getWorkspaceInfo(env, workspaceId);
  if (!wsInfo) return false;
  const orgStub = env.ORG.get(env.ORG.idFromName(wsInfo.org_id));
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

    const title = await generateThreadTitleWithOpenAI(env, message, {
      orgId: wsInfo.org_id,
      workspaceId,
      threadId,
    });
    if (!title) return;

    // Update title in OrgDO
    const orgStub = env.ORG.get(env.ORG.idFromName(wsInfo.org_id));
    await orgStub.updateThread(threadId, title);
    if (userId) {
      await env.USER.get(env.USER.idFromName(userId))
        .renameEmptySingleThreadGroupForThread(threadId, title);
    }

    // Broadcast via ChatThreadDO
    const threadStub = env.CHAT_THREAD.get(
      env.CHAT_THREAD.idFromName(threadId),
    );
    await threadStub.setTitle(title);
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
  workspaceId: string,
  options: { skipBanCheck?: boolean } = {},
): Promise<Message[]> {
  const env = getEnv(context);

  try {
    const piMessages = await getPiCoreMessages(context, threadId);
    if (piMessages.length > 0) {
      return piMessages as Message[];
    }

    const wsInfo = await getWorkspaceInfo(env, workspaceId);
    if (!wsInfo) return [];

    const container = new WorkspaceContainer(
      env as unknown as WorkspaceContainerEnv,
      workspaceId,
      wsInfo.org_id,
    );
    const legacyClaudeSessionId = await getLegacyClaudeSessionId(
      context,
      threadId,
    );
    const codexSessionId = await getCodexSessionId(context, threadId);
    const streamResult = await container.readThreadMessagesStream(threadId, {
      claudeSessionId: legacyClaudeSessionId,
      codexSessionId,
      skipBanCheck: options.skipBanCheck,
    });
    if (!streamResult.success || !streamResult.response) {
      return [];
    }

    return await readMessagesFromResponse(streamResult.response);
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
  const state = await stub.getPreviewState();
  return {
    target: state?.target ?? null,
    tabs: Array.isArray(state?.tabs) ? state.tabs : [],
    activeTabId:
      typeof state?.activeTabId === "string" ? state.activeTabId : null,
    version: typeof state?.version === "number" ? state.version : 0,
  };
}
