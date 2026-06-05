import type { Route } from './+types/admin.threads.$id.messages';
import { requireSuperuser, getAuthEnv } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';
import * as authDO from '@/lib/auth-do.server';
import * as chatDO from '@/lib/chat-do.server';

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

    return Response.json(
      { success: true, messages: [] },
      {
        headers: {
          'Cache-Control': 'no-cache, no-transform',
        },
      },
    );
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    console.error('Error loading admin thread messages:', error);
    return Response.json({ error: 'Failed to load messages' }, { status: 500 });
  }
}
