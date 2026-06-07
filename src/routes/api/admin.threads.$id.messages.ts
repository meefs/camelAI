import type { Route } from './+types/admin.threads.$id.messages';
import { requireSuperuser, getAuthEnv } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';
import * as authDO from '@/lib/auth-do.server';
import { readThreadMessages } from '@/lib/chat-history.server';

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

    const messages = await readThreadMessages(context, {
      orgId: threadContext.org_id,
      workspaceId: threadContext.workspace_id,
      threadId,
      skipBanCheck: true,
    });
    return Response.json(
      { success: true, messages },
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
