import type { AppLoadContext } from 'react-router';
import { getEnv, type CloudflareEnv } from './cloudflare.server';
import type { Thread, Message, PaginatedResult, PaginationParams, ChatHarness } from '@/types';
import type { PreviewTarget } from '@/types';
import {
  sanitizeGeneratedThreadTitle,
  THREAD_TITLE_GENERATION_SYSTEM_PROMPT,
} from './thread-title';
import { OrgDO, type OrgThread } from '../../workers/main/src/auth';
import { WorkspaceDO } from '../../workers/main/src/workspace';
import { WorkspaceContainer, type WorkspaceContainerEnv } from '../../workers/main/src/workspace-container';
import type { LlmModel } from '@/types';
import {
  getDefaultThreadProvider,
  getProviderForModel,
  normalizeLlmModel,
  THREAD_MODEL_LOCK_MESSAGE,
} from './llm-provider-config';
import { mergeThreadMessages, readMessagesFromResponse } from './thread-messages.server';

export interface ThreadPreviewState {
  target: PreviewTarget | null;
  tabs: PreviewTarget[];
  activeTabId: string | null;
  version: number;
}

// Helper to convert OrgThread to Thread
function toThread(orgThread: OrgThread): Thread {
  return {
    id: orgThread.id,
    workspace_id: orgThread.workspace_id,
    title: orgThread.title,
    provider: orgThread.provider ?? 'claude',
    created_by: orgThread.created_by,
    model: orgThread.model,
    created_at: orgThread.created_at,
    updated_at: orgThread.updated_at,
    user_message_count: orgThread.user_message_count ?? 0,
    first_user_message: orgThread.first_user_message ?? null,
  };
}

// Helper to get workspace info and org ID
async function getWorkspaceInfo(
  env: CloudflareEnv,
  workspaceId: string
): Promise<{ org_id: string } | null> {
  const wsStub = env.WORKSPACE.get(
    env.WORKSPACE.idFromName(workspaceId)
  ) as unknown as WorkspaceDO;
  const info = await wsStub.getInfo();
  if (!info) return null;
  return { org_id: info.org_id };
}

// Helper to get OrgDO stub
function getOrgStub(env: CloudflareEnv, orgId: string): OrgDO {
  return env.ORG.get(env.ORG.idFromName(orgId)) as unknown as OrgDO;
}

export async function getThreads(
  context: AppLoadContext,
  workspaceId: string
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
  params: PaginationParams = {}
): Promise<PaginatedResult<Thread>> {
  const env = getEnv(context);
  const offset = params.offset ?? 0;
  const limit = params.limit ?? 50;
  const wsInfo = await getWorkspaceInfo(env, workspaceId);
  if (!wsInfo) {
    return { items: [], total: 0, offset, limit };
  }
  const orgStub = env.ORG.get(env.ORG.idFromName(wsInfo.org_id));
  const result = await orgStub.getThreadsPaginated(offset, limit, workspaceId);
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
  params: PaginationParams = {}
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
  const orgStub = env.ORG.get(env.ORG.idFromName(wsInfo.org_id));
  const result = await orgStub.getThreadsAllWorkspacesPaginated(workspaceIds, offset, limit);
  return {
    items: result.items.map((t) => toThread(t)),
    total: result.total,
    offset: result.offset,
    limit: result.limit,
  };
}

export async function createThread(
  context: AppLoadContext,
  workspaceId: string,
  title: string | undefined,
  createdBy?: string,
  firstUserMessage?: string,
  model?: LlmModel
): Promise<Thread> {
  const env = getEnv(context);
  const wsInfo = await getWorkspaceInfo(env, workspaceId);
  if (!wsInfo) {
    throw new Error('Workspace not found');
  }
  const orgStub = env.ORG.get(env.ORG.idFromName(wsInfo.org_id));
  const llmProviderConfig = await orgStub.getLlmProviderConfig();
  const defaultProvider = getDefaultThreadProvider(
    llmProviderConfig?.provider,
    await orgStub.getExperimentalSettings(),
  );
  const provider = getProviderForModel(model, defaultProvider);
  const normalizedModel = normalizeLlmModel(model, provider);
  const thread = await orgStub.createThread(
    workspaceId,
    title,
    createdBy,
    firstUserMessage,
    normalizedModel,
    provider
  );
  return toThread(thread);
}

export async function getRecentThreads(
  context: AppLoadContext,
  workspaceId: string,
  limit = 6,
  createdBy?: string
): Promise<Thread[]> {
  const env = getEnv(context);
  const wsInfo = await getWorkspaceInfo(env, workspaceId);
  if (!wsInfo) return [];
  const orgStub = env.ORG.get(env.ORG.idFromName(wsInfo.org_id));
  const result = await orgStub.getThreadsPaginated(0, limit, workspaceId, createdBy);
  return result.items.map((t) => toThread(t));
}

export async function getThread(
  context: AppLoadContext,
  id: string,
  workspaceId: string
): Promise<Thread | null> {
  const env = getEnv(context);
  const wsInfo = await getWorkspaceInfo(env, workspaceId);
  if (!wsInfo) return null;
  const orgStub = env.ORG.get(env.ORG.idFromName(wsInfo.org_id));
  const thread = await orgStub.getThread(id);
  if (!thread) return null;
  // Verify the thread belongs to this workspace
  if (thread.workspace_id !== workspaceId) return null;
  return toThread(thread);
}

export async function updateThread(
  context: AppLoadContext,
  id: string,
  title: string,
  workspaceId: string
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
  workspaceId: string
): Promise<Thread | null> {
  const env = getEnv(context);
  const wsInfo = await getWorkspaceInfo(env, workspaceId);
  if (!wsInfo) return null;
  const orgStub = env.ORG.get(env.ORG.idFromName(wsInfo.org_id));
  const existing = await orgStub.getThread(id);
  if (!existing || existing.workspace_id !== workspaceId) return null;
  const normalizedModel = normalizeLlmModel(model, existing.provider ?? 'claude');
  if (existing.model === normalizedModel) return toThread(existing);
  throw new Error(THREAD_MODEL_LOCK_MESSAGE);
}

export async function setThreadFirstUserMessage(
  context: AppLoadContext,
  id: string,
  firstUserMessage: string,
  workspaceId: string
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
  workspaceId: string
): Promise<void> {
  const env = getEnv(context);
  const wsInfo = await getWorkspaceInfo(env, workspaceId);
  if (!wsInfo) return;
  const orgStub = env.ORG.get(env.ORG.idFromName(wsInfo.org_id));
  // Verify the thread belongs to this workspace first
  const existing = await orgStub.getThread(id);
  if (!existing || existing.workspace_id !== workspaceId) return;
  await orgStub.deleteThread(id);
}

export async function generateThreadTitle(
  context: AppLoadContext,
  threadId: string,
  workspaceId: string,
  message: string
): Promise<void> {
  try {
    const env = getEnv(context);

    // Use AI binding to generate title
    const ai = env.AI as {
      run: (model: string, options: { messages: { role: string; content: string }[]; temperature?: number; max_tokens?: number }) => Promise<{ response?: string }>;
    };

    const response = await ai.run('@cf/google/gemma-3-12b-it', {
      messages: [
        { role: 'system', content: THREAD_TITLE_GENERATION_SYSTEM_PROMPT },
        { role: 'user', content: message },
      ],
      temperature: 1,
      max_tokens: 50,
    });

    const title = sanitizeGeneratedThreadTitle(response?.response);
    if (!title) return;

    // Update title in OrgDO
    const wsInfo = await getWorkspaceInfo(env, workspaceId);
    if (!wsInfo) return;

    const orgStub = env.ORG.get(env.ORG.idFromName(wsInfo.org_id));
    await orgStub.updateThread(threadId, title);

    // Broadcast via ChatThreadDO
    const threadStub = env.CHAT_THREAD.get(env.CHAT_THREAD.idFromName(threadId));
    await threadStub.setTitle(title);
  } catch (e) {
    console.error('[generateThreadTitle] Error:', e);
  }
}

export function getThreadJsonlPathCandidates(threadId: string): string[] {
  // Claude stores sessions at ~/.claude/projects/{project-path}/{session_id}.jsonl.
  // Current sandbox project path resolves to -home-claude.
  return [
    `/home/claude/.claude/projects/-home-claude/${threadId}.jsonl`,
  ];
}

export async function getMessages(
  context: AppLoadContext,
  threadId: string,
  workspaceId: string
): Promise<Message[]> {
  const env = getEnv(context);
  const threadStub = env.CHAT_THREAD.get(env.CHAT_THREAD.idFromName(threadId));
  const persistedMessages = await threadStub.getPersistedMessages().catch(() => null);

  // Messages are parsed on sandbox-host from the container's Claude JSONL file.
  // threadId is the Claude session_id.
  try {
    const wsInfo = await getWorkspaceInfo(env, workspaceId);
    if (!wsInfo) return Array.isArray(persistedMessages) ? persistedMessages as Message[] : [];

    const container = new WorkspaceContainer(env as unknown as WorkspaceContainerEnv, workspaceId, wsInfo.org_id);
    const streamResult = await container.readThreadMessagesStream(threadId);
    if (!streamResult.success || !streamResult.response) {
      return Array.isArray(persistedMessages) ? persistedMessages as Message[] : [];
    }

    const legacyMessages = await readMessagesFromResponse(streamResult.response);
    if (Array.isArray(persistedMessages) && persistedMessages.length > 0) {
      return mergeThreadMessages(legacyMessages, persistedMessages as Message[]);
    }
    return legacyMessages;
  } catch (e) {
    console.error('[getMessages] Error:', e);
    return Array.isArray(persistedMessages) ? persistedMessages as Message[] : [];
  }
}

export async function setThreadPreviewTarget(
  context: AppLoadContext,
  threadId: string,
  target: PreviewTarget | null
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
  isPublic: boolean
): Promise<void> {
  const env = getEnv(context);
  const stub = env.CHAT_THREAD.get(env.CHAT_THREAD.idFromName(threadId));
  await stub.setPreviewAppVisibility(scriptName, isPublic);
}

export async function getThreadPreviewTarget(
  context: AppLoadContext,
  threadId: string
): Promise<PreviewTarget | null> {
  const state = await getThreadPreviewState(context, threadId);
  return state.target;
}

export async function getThreadPreviewState(
  context: AppLoadContext,
  threadId: string
): Promise<ThreadPreviewState> {
  const env = getEnv(context);
  const stub = env.CHAT_THREAD.get(env.CHAT_THREAD.idFromName(threadId));
  const state = await stub.getPreviewState();
  return {
    target: state?.target ?? null,
    tabs: Array.isArray(state?.tabs) ? state.tabs : [],
    activeTabId: typeof state?.activeTabId === 'string' ? state.activeTabId : null,
    version: typeof state?.version === 'number' ? state.version : 0,
  };
}
