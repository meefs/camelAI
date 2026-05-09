import { waitUntil } from '@/lib/wait-until';
import type { Route } from './+types/workspaces.$id.chat.$threadId.first-user-message';
import { requireWorkspaceAccess } from './workspaces.utils';
import * as chatDO from '@/lib/chat-do.server';
import { isPlaceholderThreadTitle } from '@/lib/thread-title';

export async function action({ request, context, params }: Route.ActionArgs) {
  try {
    const workspaceId = params.id;
    const threadId = params.threadId;
    if (!workspaceId) {
      return Response.json({ error: 'Workspace ID required' }, { status: 400 });
    }
    if (!threadId) {
      return Response.json({ error: 'Thread ID required' }, { status: 400 });
    }

    const { userId } = await requireWorkspaceAccess(request, context, workspaceId, { requireWrite: true });

    let payload: { firstUserMessage?: unknown };
    try {
      payload = await request.json() as { firstUserMessage?: unknown };
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }
    const firstUserMessage = typeof payload.firstUserMessage === 'string'
      ? payload.firstUserMessage.trim()
      : '';
    if (!firstUserMessage) {
      return Response.json({ error: 'firstUserMessage is required' }, { status: 400 });
    }

    const thread = await chatDO.setThreadFirstUserMessage(
      context,
      threadId,
      firstUserMessage,
      workspaceId,
    );
    if (!thread) {
      return Response.json({ error: 'Thread not found' }, { status: 404 });
    }

    if (isPlaceholderThreadTitle(thread.title)) {
      waitUntil(
        chatDO.generateThreadTitle(
          context,
          threadId,
          workspaceId,
          firstUserMessage,
          userId,
        ),
      );
    }

    return Response.json({ success: true });
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    console.error('Error setting thread first user message:', error);
    return Response.json({ error: 'Failed to update thread first user message' }, { status: 500 });
  }
}
