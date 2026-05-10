import type { Route } from './+types/workspaces.$id.chat.$threadId.fork';
import { requireSessionWorkspaceAccess } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';
import { getAuthEnv } from '@/lib/auth-helpers';
import * as chatDO from '@/lib/chat-do.server';
import { addThreadToExistingGroup } from '@/lib/chat-groups.server';
import { readMessagesFromResponse } from '@/lib/thread-messages.server';
import type { Message } from '@/types';
import {
  WorkspaceContainer,
  type WorkspaceContainerEnv,
} from '../../../workers/main/src/workspace-container';

function forkThreadTitle(title: string | null | undefined): string {
  const trimmed = title?.trim();
  return trimmed ? `Fork: ${trimmed}` : 'Forked chat';
}

function normalizeForkError(error: unknown): string {
  const message =
    error instanceof Error ? error.message : String(error || 'Failed to fork chat');
  if (message.trim().toLowerCase() === 'not found') {
    return 'Sandbox fork endpoint returned Not found';
  }
  return message;
}

function formatSandboxForkFailure(forkResult: {
  error?: string;
  code?: string;
  status?: number;
}): string {
  const error = forkResult.error?.trim();
  if (forkResult.code === 'SANDBOX_FORK_ENDPOINT_NOT_FOUND' && error) {
    return error;
  }
  if (forkResult.status === 404 && error?.toLowerCase() === 'not found') {
    return (
      'Sandbox fork endpoint returned 404 Not Found. ' +
      'Restart or deploy sandbox-host with chat fork support, and for local dev make sure ' +
      'SANDBOX_HOST_URL points at the control listener (:4400), not the proxy listener (:4401).'
    );
  }
  return `Sandbox fork failed: ${error || forkResult.code || 'unknown error'}`;
}

function shouldFallbackToRenderableHistory(forkResult: {
  error?: string;
  code?: string;
  status?: number;
}): boolean {
  const error = forkResult.error?.trim().toLowerCase() ?? '';
  return (
    forkResult.code === 'SANDBOX_FORK_ENDPOINT_NOT_FOUND' ||
    (forkResult.status === 404 && error === 'not found') ||
    error === 'source pi session not found' ||
    /^entry ".+" not found in source pi session$/.test(error)
  );
}

function safeThreadHistoryPath(threadId: string): string {
  if (!threadId || /[/\\]/.test(threadId)) {
    throw new Error('Invalid target thread id');
  }
  return `/home/claude/.claude/projects/-home-claude/${threadId}.jsonl`;
}

function timestampFromMillis(value: number): string {
  if (Number.isFinite(value) && value > 0) {
    return new Date(value).toISOString();
  }
  return new Date().toISOString();
}

function normalizeClaudeContent(content: Message['content']): unknown[] {
  if (typeof content === 'string') {
    return content.trim() ? [{ type: 'text', text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  try {
    return JSON.parse(JSON.stringify(content)) as unknown[];
  } catch {
    return [];
  }
}

function selectMessagesForFork(
  messages: Message[],
  forkEntryId: string,
  renderedMessageId: string,
): Message[] {
  const targets = [forkEntryId, renderedMessageId]
    .map((value) => value.trim())
    .filter(Boolean);
  const index = messages.findIndex((message) =>
    targets.some(
      (target) => message.id === target || message.forkEntryId === target,
    ),
  );
  if (index < 0) {
    throw new Error('Fork target not found in renderable history');
  }
  return messages.slice(0, index + 1);
}

function buildClaudeFallbackHistory(threadId: string, messages: Message[]): string {
  const lines = messages.flatMap((message) => {
    if (message.role !== 'user' && message.role !== 'assistant') return [];
    const content = normalizeClaudeContent(message.content);
    if (content.length === 0) return [];
    const timestamp = timestampFromMillis(message.created_at);
    if (message.role === 'assistant') {
      return [
        JSON.stringify({
          type: 'assistant',
          uuid: message.id,
          timestamp,
          message: {
            id: message.forkEntryId || message.id,
            content,
          },
        }),
      ];
    }
    const event: Record<string, unknown> = {
      type: 'user',
      uuid: message.id,
      timestamp,
      message: {
        content,
      },
    };
    if (message.isMeta) {
      event.isMeta = true;
    }
    if (message.sourceToolUseID) {
      event.sourceToolUseID = message.sourceToolUseID;
    }
    if (message.isCompactSummary) {
      event.isCompactSummary = true;
    }
    return [JSON.stringify(event)];
  });

  if (lines.length === 0) {
    throw new Error('No readable messages available to fork');
  }

  return lines.join('\n') + '\n';
}

async function forkViaRenderableHistory(
  container: WorkspaceContainer,
  options: {
    sourceThreadId: string;
    targetThreadId: string;
    forkEntryId: string;
    renderedMessageId: string;
    legacyClaudeSessionId: string | null;
    codexSessionId: string | null;
  },
): Promise<{ success: true; messageCount: number } | { success: false; error: string }> {
  const streamResult = await container.readThreadMessagesStream(
    options.sourceThreadId,
    {
      claudeSessionId: options.legacyClaudeSessionId ?? undefined,
      codexSessionId: options.codexSessionId ?? undefined,
      skipBanCheck: true,
    },
  );
  if (!streamResult.success || !streamResult.response) {
    return {
      success: false,
      error: streamResult.error || 'Failed to read source message history',
    };
  }

  let messages: Message[];
  try {
    messages = selectMessagesForFork(
      await readMessagesFromResponse(streamResult.response),
      options.forkEntryId,
      options.renderedMessageId,
    );
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : 'Fork target not found in renderable history',
    };
  }
  let history: string;
  try {
    history = buildClaudeFallbackHistory(options.targetThreadId, messages);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to build fork history',
    };
  }

  const directory = '/home/claude/.claude/projects/-home-claude';
  const mkdirResult = await container.mkdir(directory);
  if (!mkdirResult.success) {
    return {
      success: false,
      error: mkdirResult.error || 'Failed to create fallback history directory',
    };
  }

  let path: string;
  try {
    path = safeThreadHistoryPath(options.targetThreadId);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Invalid target thread id',
    };
  }
  const writeResult = await container.writeFile(path, history);
  if (!writeResult.success) {
    return {
      success: false,
      error: writeResult.error || 'Failed to write fallback fork history',
    };
  }

  return { success: true, messageCount: messages.length };
}

export async function action({ request, context, params }: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  const sourceThreadId = params.threadId?.trim();
  if (!sourceThreadId) {
    return Response.json({ error: 'Thread ID required' }, { status: 400 });
  }

  const { session, orgId, workspaceId, userId } =
    await requireSessionWorkspaceAccess(request, context, params.id, {
      requireWrite: true,
    });

  if (session.workspace_id !== params.id) {
    return Response.json({ error: 'Workspace mismatch' }, { status: 403 });
  }

  let body: {
    messageId?: unknown;
    renderedMessageId?: unknown;
    groupId?: unknown;
  };
  try {
    body = (await request.json()) as {
      messageId?: unknown;
      renderedMessageId?: unknown;
      groupId?: unknown;
    };
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const messageId =
    typeof body.messageId === 'string' ? body.messageId.trim() : '';
  const renderedMessageId =
    typeof body.renderedMessageId === 'string'
      ? body.renderedMessageId.trim()
      : '';
  if (!messageId) {
    return Response.json({ error: 'messageId is required' }, { status: 400 });
  }
  const groupId = typeof body.groupId === 'string' ? body.groupId.trim() : '';

  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(orgId));
  const userStub = authEnv.USER.get(authEnv.USER.idFromName(userId));
  const sourceThread = await orgStub.getThread(sourceThreadId);
  if (!sourceThread || sourceThread.workspace_id !== workspaceId) {
    return Response.json({ error: 'Thread not found' }, { status: 404 });
  }

  let targetGroupId: string | null = null;
  if (groupId) {
    const group = await userStub.getChatGroupSummary(groupId);
    if (
      !group ||
      group.org_id !== orgId ||
      group.workspace_id !== workspaceId ||
      ![...group.open_thread_ids, ...group.closed_thread_ids].includes(
        sourceThreadId,
      )
    ) {
      return Response.json(
        { error: 'Source thread is not in the requested group' },
        { status: 400 },
      );
    }
    targetGroupId = group.id;
  } else {
    const sourceGroup = await userStub.getChatGroupForThread(sourceThreadId);
    if (
      sourceGroup &&
      sourceGroup.org_id === orgId &&
      sourceGroup.workspace_id === workspaceId
    ) {
      targetGroupId = sourceGroup.id;
    }
  }

  let targetThread: Awaited<ReturnType<typeof chatDO.createThread>>;
  try {
    try {
      targetThread = await chatDO.createThread(
        context,
        workspaceId,
        forkThreadTitle(sourceThread.title),
        userId,
        sourceThread.first_user_message ?? undefined,
        sourceThread.model,
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to create fork';
      if (
        message !== 'Invalid thread model' &&
        message !== 'No models are available'
      ) {
        throw error;
      }
      targetThread = await chatDO.createThread(
        context,
        workspaceId,
        forkThreadTitle(sourceThread.title),
        userId,
        sourceThread.first_user_message ?? undefined,
      );
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to create fork';
    const status =
      message === 'Invalid thread model' || message === 'No models are available'
        ? 400
        : 500;
    return Response.json({ error: message }, { status });
  }

  try {
    const container = new WorkspaceContainer(
      env as unknown as WorkspaceContainerEnv,
      workspaceId,
      orgId,
    );
    const forkResult = await container.forkThreadSession({
      sourceThreadId,
      targetThreadId: targetThread.id,
      entryId: messageId,
    });
    if (!forkResult.success) {
      console.error('Sandbox fork failed', {
        sourceThreadId,
        targetThreadId: targetThread.id,
        status: forkResult.status,
        code: forkResult.code,
        error: forkResult.error,
      });
      if (!shouldFallbackToRenderableHistory(forkResult)) {
        throw new Error(formatSandboxForkFailure(forkResult));
      }

      const legacyClaudeSessionId = await chatDO.getLegacyClaudeSessionId(
        context,
        sourceThreadId,
      );
      const codexSessionId = await chatDO.getCodexSessionId(
        context,
        sourceThreadId,
      );
      const fallback = await forkViaRenderableHistory(container, {
        sourceThreadId,
        targetThreadId: targetThread.id,
        forkEntryId: messageId,
        renderedMessageId,
        legacyClaudeSessionId,
        codexSessionId,
      });
      if (!fallback.success) {
        throw new Error(
          `${formatSandboxForkFailure(forkResult)}; fallback history fork failed: ${fallback.error}`,
        );
      }
      console.warn('Sandbox fork endpoint unavailable; wrote fallback fork history', {
        sourceThreadId,
        targetThreadId: targetThread.id,
        messageCount: fallback.messageCount,
        status: forkResult.status,
        code: forkResult.code,
      });
    }

    const sourceChatStub = env.CHAT_THREAD.get(
      env.CHAT_THREAD.idFromName(sourceThreadId),
    );
    const targetChatStub = env.CHAT_THREAD.get(
      env.CHAT_THREAD.idFromName(targetThread.id),
    );
    const snapshot = await sourceChatStub.getForkStateSnapshot();
    await targetChatStub.applyForkStateSnapshot(snapshot, {
      threadId: targetThread.id,
      workspaceId,
      orgId,
      userId,
    });
    if (targetGroupId) {
      await addThreadToExistingGroup(context, {
        userId,
        orgId,
        workspaceId,
        groupId: targetGroupId,
        threadId: targetThread.id,
      });
    }
  } catch (error) {
    await chatDO.deleteThread(context, targetThread.id, workspaceId).catch(
      () => {},
    );
    const message = normalizeForkError(error);
    return Response.json({ error: message }, { status: 500 });
  }

  return Response.json({ thread: targetThread, groupId: targetGroupId });
}
