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
    const thread = await chatDO.getThread(context, threadId, workspaceId);
    if (!thread) {
      return Response.json({ error: 'Thread not found' }, { status: 404 });
    }

    const piMessages = await chatDO.getPiCoreMessages(context, threadId);
    if (piMessages.length > 0) {
      return Response.json(
        { success: true, messages: piMessages },
        {
          headers: {
            'Cache-Control': 'no-cache, no-transform',
          },
        },
      );
    }

    const legacyClaudeSessionId = await chatDO.getLegacyClaudeSessionId(context, threadId);
    const codexSessionId = await chatDO.getCodexSessionId(context, threadId);
    const streamResult = await container.readThreadMessagesStream(threadId, {
      claudeSessionId: legacyClaudeSessionId,
      codexSessionId,
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
