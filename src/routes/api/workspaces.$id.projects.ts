import type { Route } from './+types/workspaces.$id.projects';
import { getEnv } from '@/lib/cloudflare.server';
import { projectsToMentionables } from '@/lib/mentions';
import { WorkspaceFilesystemClient } from '../../../workers/main/src/workspace-filesystem-do';
import { requireWorkspaceAccess } from './workspaces.utils';

export async function loader({ request, context, params }: Route.LoaderArgs) {
  try {
    const workspaceId = params.id;
    if (!workspaceId) {
      return Response.json({ error: 'Workspace ID required' }, { status: 400 });
    }

    await requireWorkspaceAccess(request, context, workspaceId);

    const env = getEnv(context);
    const projects = await new WorkspaceFilesystemClient(
      env as never,
      workspaceId,
    ).listProjects();

    return Response.json(
      { projects: projectsToMentionables(projects) },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    console.error('Failed to load workspace projects:', error);
    return Response.json(
      { error: 'Failed to load workspace projects' },
      { status: 500 },
    );
  }
}
