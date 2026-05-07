import { waitUntil } from 'cloudflare:workers';
import type { Route } from './+types/workspaces.$id.chat.threads';
import { requireSessionWorkspaceAccess } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';
import { getAuthEnv } from '@/lib/auth-helpers';
import { getWorkerScript } from '@/lib/auth-do';
import * as chatDO from '@/lib/chat-do.server';
import type { LlmModel } from '@/types';

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
    initialTitle?: string;
    firstMessage?: string;
    previewApps?: string;
    model?: LlmModel;
  };

  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  let thread: Awaited<ReturnType<typeof chatDO.createThread>>;
  try {
    thread = await chatDO.createThread(
      context,
      workspaceId,
      body.initialTitle || undefined,
      userId,
      body.firstMessage || undefined,
      body.model
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create thread';
    const status =
      message === 'Invalid thread model' || message === 'No models are available'
        ? 400
        : 500;
    return Response.json({ error: message || 'Failed to create thread' }, { status });
  }

  // Set preview apps if provided
  if (body.previewApps) {
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
