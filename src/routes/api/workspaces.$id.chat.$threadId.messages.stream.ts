import type { Route } from './+types/workspaces.$id.chat.$threadId.messages.stream';
import * as chatDO from '@/lib/chat-do.server';
import { requireWorkspaceAuth } from './workspaces.utils';

export async function loader({ request, context, params }: Route.LoaderArgs) {
  try {
    const workspaceId = params.id;
    const threadId = params.threadId;
    if (!workspaceId) {
      return Response.json({ error: 'Workspace ID required' }, { status: 400 });
    }
    if (!threadId) {
      return Response.json({ error: 'Thread ID required' }, { status: 400 });
    }

    const { container } = await requireWorkspaceAuth(request, context, workspaceId);
    const legacyClaudeSessionId = await chatDO.getLegacyClaudeSessionId(context, threadId);
    const streamResult = await container.readThreadMessagesStream(threadId, {
      claudeSessionId: legacyClaudeSessionId,
    });
    if (!streamResult.success || !streamResult.response) {
      const status = streamResult.code?.startsWith('HTTP_')
        ? Number.parseInt(streamResult.code.slice(5), 10) || 500
        : 500;
      return Response.json(
        { error: streamResult.error || 'Failed to load message stream' },
        { status },
      );
    }

    const upstream = streamResult.response;
    const headers = new Headers(upstream.headers);
    if (!headers.get('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    headers.set('Cache-Control', 'no-cache, no-transform');

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    console.error('Error streaming workspace chat messages:', error);
    return Response.json({ error: 'Failed to stream chat messages' }, { status: 500 });
  }
}
