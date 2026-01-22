import type { Route } from './+types/workspaces.$id.fs.create';
import { requireWorkspaceAuth, toContainerPath, normalizeWorkspacePath } from './workspaces.utils';

export async function action({ request, context, params }: Route.ActionArgs) {
  try {
    const workspaceId = params.id;
    if (!workspaceId) {
      return Response.json({ error: 'Workspace ID required' }, { status: 400 });
    }

    const { container } = await requireWorkspaceAuth(request, context, workspaceId, {
      requireWrite: true,
    });

    const body = await request.json() as { path?: string; content?: string };
    if (!body.path) {
      return Response.json({ error: 'Path required' }, { status: 400 });
    }

    // Create file with optional content (defaults to empty)
    const containerPath = toContainerPath(normalizeWorkspacePath(body.path));
    const result = await container.writeFile(containerPath, body.content ?? '');

    return Response.json(result);
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    console.error('Error creating workspace file:', error);
    return Response.json({ error: 'Failed to create file' }, { status: 500 });
  }
}
