import type { Route } from './+types/workspaces.$id.fs.move';
import {
  blockBetaFileEdit,
  requireWorkspaceAuth,
  resolveContainerPath,
  resolveContainerPathForWrite,
  toContainerPath,
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

    const body = await request.json() as { from?: string; to?: string };
    if (!body.from || !body.to) {
      return Response.json({ error: 'Both from and to paths required' }, { status: 400 });
    }

    const fromWorkspacePath = normalizeWorkspacePath(body.from);
    const toWorkspacePath = normalizeWorkspacePath(body.to);
    const resolvedFrom = await resolveContainerPath(container, fromWorkspacePath);
    const fromPath = resolvedFrom ?? toContainerPath(fromWorkspacePath);
    const toPath = await resolveContainerPathForWrite(container, toWorkspacePath, {
      allowExisting: false,
    });
    const result = await container.moveFile(fromPath, toPath);

    return Response.json(result);
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    console.error('Error moving workspace file:', error);
    return Response.json({ error: 'Failed to move file' }, { status: 500 });
  }
}
