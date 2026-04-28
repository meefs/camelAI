import type { Route } from './+types/admin.threads.$id.jsonl';
import { requireSuperuser, getAuthEnv } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';
import {
  getCodexSessionId,
  getLegacyClaudeSessionId,
  getThreadJsonlPathCandidates,
} from '@/lib/chat-do.server';
import { readMessagesFromResponse } from '@/lib/thread-messages.server';
import {
  WorkspaceContainer,
  type WorkspaceContainerEnv,
} from '../../../workers/main/src/workspace-container';

function sanitizeFilename(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]/g, '_');
  return sanitized || 'thread';
}

function messagesToJsonl(messages: unknown[]): string {
  if (messages.length === 0) {
    return '';
  }
  return `${messages.map((message) => JSON.stringify(message)).join('\n')}\n`;
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  try {
    await requireSuperuser(request, context);

    const threadId = params.id?.trim();
    if (!threadId) {
      return Response.json({ error: 'Thread ID required' }, { status: 400 });
    }

    const url = new URL(request.url);
    const orgId = url.searchParams.get('orgId')?.trim();
    const workspaceId = url.searchParams.get('workspaceId')?.trim();

    if (!orgId || !workspaceId) {
      return Response.json(
        { error: 'orgId and workspaceId query params are required' },
        { status: 400 }
      );
    }

    const env = getEnv(context);
    const authEnv = getAuthEnv(env);
    const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(orgId));
    const thread = await orgStub.getThread(threadId);

    if (!thread || thread.workspace_id !== workspaceId) {
      return Response.json({ error: 'Thread not found' }, { status: 404 });
    }

    const container = new WorkspaceContainer(
      env as unknown as WorkspaceContainerEnv,
      workspaceId,
      orgId
    );

    let proxyResponse: Response | null = null;
    const legacyClaudeSessionId = await getLegacyClaudeSessionId(context, threadId);
    for (const candidatePath of getThreadJsonlPathCandidates(threadId, legacyClaudeSessionId)) {
      proxyResponse = await container.readFileStream(candidatePath, {
        skipBanCheck: true,
      });
      if (proxyResponse) {
        break;
      }
    }

    const filename = `${sanitizeFilename(threadId)}.jsonl`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    };

    if (proxyResponse) {
      const contentLength = proxyResponse.headers.get('Content-Length');
      if (contentLength) {
        headers['Content-Length'] = contentLength;
      }
      return new Response(proxyResponse.body, { headers });
    }

    const codexSessionId = await getCodexSessionId(context, threadId);
    const streamResult = await container.readThreadMessagesStream(threadId, {
      claudeSessionId: legacyClaudeSessionId,
      codexSessionId,
      skipBanCheck: true,
    });
    if (!streamResult.success || !streamResult.response) {
      const status = streamResult.code?.startsWith('HTTP_')
        ? Number.parseInt(streamResult.code.slice(5), 10) || 500
        : 500;
      return Response.json(
        { error: streamResult.error || 'Failed to load thread messages' },
        { status },
      );
    }

    const messages = await readMessagesFromResponse(streamResult.response);
    return new Response(messagesToJsonl(messages), { headers });
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    console.error('Error downloading thread JSONL:', error);
    return Response.json({ error: 'Failed to download thread JSONL' }, { status: 500 });
  }
}
