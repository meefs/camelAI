import type { Route } from './+types/workspaces.$id.mentions';
import { getEnv } from '@/lib/cloudflare.server';
import { loadWorkspaceMentionSourcesPatch } from '@/lib/mention-sources.server';
import { requireWorkspaceAccess } from './workspaces.utils';

export async function loader({ request, context, params }: Route.LoaderArgs) {
  try {
    const workspaceId = params.id;
    if (!workspaceId) {
      return Response.json({ error: 'Workspace ID required' }, { status: 400 });
    }

    await requireWorkspaceAccess(request, context, workspaceId);

    const mentionSources = await loadWorkspaceMentionSourcesPatch(
      getEnv(context),
      workspaceId,
    );

    return Response.json(
      mentionSources,
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    console.error('Failed to load workspace mention sources:', error);
    return Response.json(
      { error: 'Failed to load workspace mention sources' },
      { status: 500 },
    );
  }
}
