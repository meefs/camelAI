import type { Route } from './+types/admin.threads.$id.messages';
import { requireSuperuser, getAuthEnv } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';
import * as authDO from '@/lib/auth-do.server';
import { mergeThreadMessages, readMessagesFromResponse } from '@/lib/thread-messages.server';
import {
  WorkspaceContainer,
  type WorkspaceContainerEnv,
} from '../../../workers/main/src/workspace-container';

export async function loader({ request, context, params }: Route.LoaderArgs) {
  try {
    await requireSuperuser(request, context);

    const threadId = params.id?.trim();
    if (!threadId) {
      return Response.json({ error: 'Thread ID required' }, { status: 400 });
    }

    const threadContext = await authDO.adminGetThreadContextById(context, threadId);
    if (!threadContext) {
      return Response.json({ error: 'Thread not found' }, { status: 404 });
    }

    const env = getEnv(context);
    const authEnv = getAuthEnv(env);
    const thread = await authEnv.ORG
      .get(authEnv.ORG.idFromName(threadContext.org_id))
      .getThread(threadId);
    if (!thread || thread.workspace_id !== threadContext.workspace_id) {
      return Response.json({ error: 'Thread not found' }, { status: 404 });
    }

    const chatThread = env.CHAT_THREAD
      ? env.CHAT_THREAD.get(env.CHAT_THREAD.idFromName(threadId))
      : null;
    const persistedMessages = chatThread
      ? await chatThread.getPersistedMessages().catch(() => null)
      : null;

    const container = new WorkspaceContainer(
      env as unknown as WorkspaceContainerEnv,
      threadContext.workspace_id,
      threadContext.org_id,
    );

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
        { error: streamResult.error || 'Failed to load messages' },
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
    console.error('Error loading admin thread messages:', error);
    return Response.json({ error: 'Failed to load messages' }, { status: 500 });
  }
}
