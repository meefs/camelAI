import type { Route } from './+types/workspaces.$id.chat.$threadId.connection-setup-response';
import { getEnv } from '@/lib/cloudflare.server';
import * as chatDO from '@/lib/chat-do.server';
import { requireWorkspaceAccess } from './workspaces.utils';
import type { ConnectionSetupResponse } from '../../../workers/main/src/durable-objects';

interface ConnectionSetupRpc {
  receiveConnectionSetupResponse(
    response: ConnectionSetupResponse,
  ): Promise<{ accepted: boolean }> | { accepted: boolean };
}

function normalizeConnectionSetupResponse(body: unknown): ConnectionSetupResponse | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const item = body as Record<string, unknown>;
  const requestId = typeof item.requestId === 'string' ? item.requestId.trim() : '';
  if (!requestId) return null;

  const response: ConnectionSetupResponse = {
    requestId,
    cancelled: item.cancelled === true,
  };

  const integration = item.integration;
  if (integration && typeof integration === 'object' && !Array.isArray(integration)) {
    const candidate = integration as Record<string, unknown>;
    const type = typeof candidate.type === 'string' ? candidate.type.trim() : '';
    const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
    const config =
      candidate.config && typeof candidate.config === 'object' && !Array.isArray(candidate.config)
        ? candidate.config as Record<string, unknown>
        : {};
    const credentials =
      candidate.credentials &&
        typeof candidate.credentials === 'object' &&
        !Array.isArray(candidate.credentials)
        ? candidate.credentials as Record<string, unknown>
        : {};

    if (type && name) {
      response.integration = {
        type,
        name,
        config,
        credentials,
      };
    }
  }

  return response;
}

export async function action({ request, context, params }: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  const workspaceId = params.id?.trim();
  const threadId = params.threadId?.trim();
  if (!workspaceId) {
    return Response.json({ error: 'Workspace ID required' }, { status: 400 });
  }
  if (!threadId) {
    return Response.json({ error: 'Thread ID required' }, { status: 400 });
  }

  try {
    await requireWorkspaceAccess(request, context, workspaceId, {
      requireWrite: true,
    });

    const thread = await chatDO.getThread(context, threadId, workspaceId);
    if (!thread) {
      return Response.json({ error: 'Thread not found' }, { status: 404 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const response = normalizeConnectionSetupResponse(body);
    if (!response) {
      return Response.json({ error: 'Invalid connection setup response' }, { status: 400 });
    }

    const env = getEnv(context);
    const chatThread = env.CHAT_THREAD.get(
      env.CHAT_THREAD.idFromName(threadId),
    ) as unknown as ConnectionSetupRpc;
    const result = await chatThread.receiveConnectionSetupResponse(response);

    if (!result.accepted) {
      return Response.json(
        { error: 'Connection setup request is no longer pending' },
        { status: 409 },
      );
    }

    return Response.json({ success: true });
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    console.error('Error submitting connection setup response:', error);
    return Response.json(
      { error: 'Failed to submit connection setup response' },
      { status: 500 },
    );
  }
}
