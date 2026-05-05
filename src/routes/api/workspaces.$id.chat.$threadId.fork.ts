import type { Route } from './+types/workspaces.$id.chat.$threadId.fork';
import { requireSessionWorkspaceAccess } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';
import { getAuthEnv } from '@/lib/auth-helpers';
import * as chatDO from '@/lib/chat-do.server';
import {
  WorkspaceContainer,
  type WorkspaceContainerEnv,
} from '../../../workers/main/src/workspace-container';

function forkThreadTitle(title: string | null | undefined): string {
  const trimmed = title?.trim();
  return trimmed ? `Fork: ${trimmed}` : 'Forked chat';
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

  let body: { messageId?: unknown };
  try {
    body = (await request.json()) as { messageId?: unknown };
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const messageId =
    typeof body.messageId === 'string' ? body.messageId.trim() : '';
  if (!messageId) {
    return Response.json({ error: 'messageId is required' }, { status: 400 });
  }

  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(orgId));
  const sourceThread = await orgStub.getThread(sourceThreadId);
  if (!sourceThread || sourceThread.workspace_id !== workspaceId) {
    return Response.json({ error: 'Thread not found' }, { status: 404 });
  }

  const targetThread = await orgStub.createThread(
    workspaceId,
    forkThreadTitle(sourceThread.title),
    userId,
    sourceThread.first_user_message ?? undefined,
    sourceThread.model,
    sourceThread.provider ?? 'claude',
  );

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
      throw new Error(forkResult.error || 'Failed to fork Pi session');
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
  } catch (error) {
    await chatDO.deleteThread(context, targetThread.id, workspaceId).catch(
      () => {},
    );
    const message =
      error instanceof Error ? error.message : 'Failed to fork chat';
    return Response.json({ error: message }, { status: 500 });
  }

  return Response.json({ thread: targetThread });
}
