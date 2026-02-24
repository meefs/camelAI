import { waitUntil } from 'cloudflare:workers';
import type { Route } from './+types/workspaces.$id.chat.threads';
import { requireSession } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';
import { getAuthEnv } from '@/lib/auth-helpers';
import { getWorkerScript } from '@/lib/auth-do';
import * as chatDO from '@/lib/chat-do.server';

/**
 * Lightweight thread creation endpoint that uses session-only auth
 * instead of the full requireAuthContext() waterfall.
 */
export async function action({ request, context, params }: Route.ActionArgs) {
  const { session } = await requireSession(request, context);

  if (session.workspace_id !== params.id) {
    return Response.json({ error: 'Workspace mismatch' }, { status: 403 });
  }

  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  const body = await request.json() as {
    firstMessage?: string;
    previewApps?: string;
  };

  const thread = await chatDO.createThread(
    context,
    session.workspace_id,
    undefined,
    session.user_id,
    body.firstMessage || undefined
  );

  // Set preview apps if provided
  if (body.previewApps) {
    const env = getEnv(context);
    const authEnv = getAuthEnv(env);
    const previewApps = body.previewApps.split(',').filter(Boolean);
    if (previewApps.length > 0) {
      const scriptName = previewApps[0];
      const script = await getWorkerScript(authEnv, session.org_id, scriptName);
      await chatDO.setThreadPreviewTarget(context, thread.id, {
        kind: 'app',
        scriptName,
        isPublic: script?.is_public ?? false,
      });
    }
  }

  // Generate title in background
  if (body.firstMessage) {
    waitUntil(
      chatDO.generateThreadTitle(
        context,
        thread.id,
        session.workspace_id,
        body.firstMessage
      )
    );
  }

  return Response.json({ thread });
}
