import type { Route } from './+types/workspaces.$id.chat.$threadId.messages.stream';
import { requireWorkspaceAuth } from './workspaces.utils';
import { getEnv } from '@/lib/cloudflare.server';
import { mergeThreadMessages, readMessagesFromResponse } from '@/lib/thread-messages.server';

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
    const env = getEnv(context);
    const chatThread = env.CHAT_THREAD.get(env.CHAT_THREAD.idFromName(threadId));
    const persistedMessages = await chatThread.getPersistedMessages().catch(() => null);
    const streamResult = await container.readThreadMessagesStream(threadId);
    if (!streamResult.success || !streamResult.response) {
      if (Array.isArray(persistedMessages) && persistedMessages.length > 0) {
        return Response.json({ success: true, messages: persistedMessages }, {
          headers: { 'Cache-Control': 'no-cache, no-transform' },
        });
      }
      const status = streamResult.code?.startsWith('HTTP_')
        ? Number.parseInt(streamResult.code.slice(5), 10) || 500
        : 500;
      return Response.json(
        { error: streamResult.error || 'Failed to load message stream' },
        { status },
      );
    }

    const upstream = streamResult.response;
    if (Array.isArray(persistedMessages) && persistedMessages.length > 0) {
      const legacyMessages = await readMessagesFromResponse(upstream);
      return Response.json(
        { success: true, messages: mergeThreadMessages(legacyMessages, persistedMessages) },
        { headers: { 'Cache-Control': 'no-cache, no-transform' } },
      );
    }

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
