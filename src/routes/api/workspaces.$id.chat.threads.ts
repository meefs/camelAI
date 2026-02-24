import { waitUntil } from 'cloudflare:workers';
import type { Route } from './+types/workspaces.$id.chat.threads';
import { requireSessionWorkspaceAccess } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';
import { getAuthEnv } from '@/lib/auth-helpers';
import { getWorkerScript } from '@/lib/auth-do';
import * as chatDO from '@/lib/chat-do.server';

/**
 * Lightweight thread creation endpoint that validates workspace access
 * without loading full auth context.
 */
export async function action({ request, context, params }: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  const { session, orgId, workspaceId, userId } = await requireSessionWorkspaceAccess(
    request,
    context,
    params.id,
    { requireWrite: true }
  );

  if (session.workspace_id !== params.id) {
    return Response.json({ error: 'Workspace mismatch' }, { status: 403 });
  }

  const body = await request.json() as {
    firstMessage?: string;
    previewApps?: string;
  };

  const thread = await chatDO.createThread(
    context,
    workspaceId,
    undefined,
    userId,
    body.firstMessage || undefined
  );

  // Set preview apps if provided
  if (body.previewApps) {
    const env = getEnv(context);
    const authEnv = getAuthEnv(env);
    const previewApps = body.previewApps.split(',').filter(Boolean);
    if (previewApps.length > 0) {
      const scriptName = previewApps[0];
      const script = await getWorkerScript(authEnv, orgId, scriptName);
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
        workspaceId,
        body.firstMessage
      )
    );
  }

  return Response.json({ thread });
}
