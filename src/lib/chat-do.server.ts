import type { AppLoadContext } from 'react-router';
import { getEnv, type CloudflareEnv } from './cloudflare.server';
import type { Thread, Message, PaginatedResult, PaginationParams, ContentBlock } from '@/types';
import { OrgDO, type OrgThread } from '../../workers/main/src/auth';
import { WorkspaceDO } from '../../workers/main/src/workspace';
import { getWorkspaceContainer } from '../../workers/main/src/workspace-container';

// Helper to convert OrgThread to Thread
function toThread(orgThread: OrgThread): Thread {
  return {
    id: orgThread.id,
    workspace_id: orgThread.workspace_id,
    title: orgThread.title,
    created_by: orgThread.created_by,
    created_at: orgThread.created_at,
    updated_at: orgThread.updated_at,
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
  createdBy?: string
): Promise<Thread> {
  const env = getEnv(context);
  const wsInfo = await getWorkspaceInfo(env, workspaceId);
  if (!wsInfo) {
    throw new Error('Workspace not found');
  }
  const orgStub = env.ORG.get(env.ORG.idFromName(wsInfo.org_id));
  const thread = await orgStub.createThread(workspaceId, title, createdBy);
  return toThread(thread);
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

export async function touchThread(
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
  await orgStub.touchThread(id);
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
        { role: 'system', content: 'Summarize the message into a simple chat thread topic title. Respond with only the title, no quotes or extra punctuation.' },
        { role: 'user', content: message },
      ],
      temperature: 1,
      max_tokens: 50,
    });

    const title = response?.response?.trim()?.slice(0, 100);
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

export async function getMessages(
  context: AppLoadContext,
  threadId: string,
  workspaceId: string
): Promise<Message[]> {
  // Messages are read from container's Claude JSONL file
  // threadId is the Claude session_id
  try {
    const env = getEnv(context);
    const wsInfo = await getWorkspaceInfo(env, workspaceId);
    if (!wsInfo) return [];

    const container = getWorkspaceContainer(env as any, workspaceId);

    // Ensure container is running (R2 restore happens in entrypoint)
    await container.startForWorkspace(workspaceId, wsInfo.org_id);

    // Claude stores conversations at ~/.claude/projects/{project-path}/{session_id}.jsonl
    const jsonlPath = `/home/claude/.claude/projects/-home-claude/${threadId}.jsonl`;

    // Check if file exists
    const exists = await container.exists(jsonlPath);
    if (!exists.exists) {
      return [];
    }

    // Read the JSONL file
    const file = await container.readFile(jsonlPath);
    if (!file.success || !file.content?.trim()) {
      return [];
    }

    const lines = file.content.split('\n').filter((line: string) => line.trim());
    const messages: Message[] = [];

    const hasTextBlocks = (content: unknown) =>
      Array.isArray(content) && content.some(block => block?.type === 'text' && block.text);

    const mergeContentBlocks = (existing: unknown, incoming: unknown): unknown => {
      if (!Array.isArray(existing) || !Array.isArray(incoming)) return incoming;

      const incomingHasText = hasTextBlocks(incoming);
      if (!incomingHasText) {
        const merged = [...existing];
        const existingKeys = new Map<string, number>();
        existing.forEach((block, index) => {
          const key = block?.type === 'tool_use'
            ? `tool_use:${block.id || block.name || index}`
            : `${block?.type}:${index}`;
          existingKeys.set(key, index);
        });
        incoming.forEach((block, index) => {
          const key = block?.type === 'tool_use'
            ? `tool_use:${block.id || block.name || index}`
            : `${block?.type}:${index}`;
          const existingIndex = existingKeys.get(key);
          if (existingIndex === undefined) {
            merged.push(block);
          } else {
            merged[existingIndex] = block;
          }
        });
        return merged;
      }

      const toolResults = existing.filter(block => block?.type === 'tool_result');
      if (toolResults.length === 0) return incoming;
      return [...toolResults, ...incoming];
    };

    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (!event || typeof event !== 'object') continue;

        // Handle user messages
        if (event.type === 'user' && event.message?.role === 'user') {
          // Extract meta info for Skill tool prompts and other injected content
          const isMeta = Boolean(
            event.isMeta ??
            event.is_meta ??
            event.message?.isMeta ??
            event.message?.is_meta
          );
          const sourceToolUseID = (
            event.sourceToolUseID ??
            event.sourceToolUseId ??
            event.source_tool_use_id ??
            event.parent_tool_use_id ??
            event.message?.sourceToolUseID ??
            event.message?.sourceToolUseId ??
            event.message?.source_tool_use_id ??
            event.message?.parent_tool_use_id
          );
          const resolvedToolUseId = typeof sourceToolUseID === 'string' ? sourceToolUseID : undefined;

          // Check if this is a tool_result message
          const firstContent = Array.isArray(event.message.content) ? event.message.content[0] : null;
          const isToolResult = firstContent?.type === 'tool_result';

          if (isToolResult) {
            // Tool results get attached to the assistant message that contains the tool_use
            const toolResults = event.message.content.filter(
              (block: ContentBlock) => block.type === 'tool_result'
            );
            for (const toolResult of toolResults) {
              // Find the assistant message with the matching tool_use
              for (let i = messages.length - 1; i >= 0; i--) {
                const msg = messages[i];
                if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
                const hasMatchingToolUse = msg.content.some(
                  (block: ContentBlock) => block.type === 'tool_use' && block.id === toolResult.tool_use_id
                );
                if (hasMatchingToolUse) {
                  messages[i] = {
                    ...msg,
                    content: [...msg.content, toolResult],
                  };
                  break;
                }
              }
            }
          } else if (isMeta || resolvedToolUseId) {
            // Meta messages (like Skill prompts) are hidden but stored for skill sheet display
            messages.push({
              id: event.uuid || `meta_${resolvedToolUseId || messages.length}`,
              thread_id: threadId,
              role: 'user',
              content: event.message.content,
              created_at: event.timestamp || Date.now(),
              isMeta: true,
              sourceToolUseID: resolvedToolUseId,
            });
          } else {
            // Regular user message
            messages.push({
              id: event.uuid || crypto.randomUUID(),
              thread_id: threadId,
              role: 'user',
              content: event.message.content,
              created_at: event.timestamp || Date.now(),
            });
          }
        }

        // Handle assistant messages
        if (event.type === 'assistant' && event.message?.role === 'assistant') {
          const existingIndex = messages.findIndex(
            (m) => m.role === 'assistant' && m.id === event.uuid
          );

          if (existingIndex >= 0) {
            // Merge with existing message
            messages[existingIndex] = {
              ...messages[existingIndex],
              content: mergeContentBlocks(
                messages[existingIndex].content,
                event.message.content
              ) as ContentBlock[],
            };
          } else {
            // Add new message
            messages.push({
              id: event.uuid || crypto.randomUUID(),
              thread_id: threadId,
              role: 'assistant',
              content: event.message.content,
              created_at: event.timestamp || Date.now(),
            });
          }
        }
      } catch {
        // Skip malformed lines
        continue;
      }
    }

    return messages;
  } catch (e) {
    console.error('[getMessages] Error:', e);
    return [];
  }
}

export async function setThreadPreview(
  context: AppLoadContext,
  threadId: string,
  workers: string[]
): Promise<string[]> {
  const env = getEnv(context);
  const stub = env.CHAT_THREAD.get(env.CHAT_THREAD.idFromName(threadId));
  await stub.setPreviewWorkers(workers);
  return stub.getPreviewWorkers();
}

export async function getThreadPreview(
  context: AppLoadContext,
  threadId: string
): Promise<string[]> {
  const env = getEnv(context);
  const stub = env.CHAT_THREAD.get(env.CHAT_THREAD.idFromName(threadId));
  return stub.getPreviewWorkers();
}
