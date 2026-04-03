import type { Route } from './+types/workspaces.$id.fs.mkdir';
import {
  blockBetaFileEdit,
  requireWorkspaceAuth,
  resolveContainerPathForWrite,
  normalizeWorkspacePath,
} from './workspaces.utils';

export async function action({ request, context, params }: Route.ActionArgs) {
  try {
    const workspaceId = params.id;
    if (!workspaceId) {
      return Response.json({ error: 'Workspace ID required' }, { status: 400 });
    }

    const { container } = await requireWorkspaceAuth(request, context, workspaceId, {
      requireWrite: true,
    });

    // Beta: file editing disabled. Remove this line to re-enable.
    return blockBetaFileEdit();

    const body = await request.json() as { path?: string };
    if (!body.path) {
      return Response.json({ error: 'Path required' }, { status: 400 });
    }

    const workspacePath = normalizeWorkspacePath(body.path);
    const containerPath = await resolveContainerPathForWrite(container, workspacePath);
    const result = await container.mkdir(containerPath, { recursive: true });

    return Response.json(result);
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    console.error('Error creating workspace directory:', error);
    return Response.json({ error: 'Failed to create directory' }, { status: 500 });
  }
}
