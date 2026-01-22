import type { Route } from './+types/workspaces.$id.fs.move';
import { requireWorkspaceAuth } from './workspaces.utils';

export async function action({ request, context, params }: Route.ActionArgs) {
  try {
    const workspaceId = params.id;
    if (!workspaceId) {
      return Response.json({ error: 'Workspace ID required' }, { status: 400 });
    }

    const { container } = await requireWorkspaceAuth(request, context, workspaceId, {
      requireWrite: true,
    });

    const body = await request.json() as { from?: string; to?: string };
    if (!body.from || !body.to) {
      return Response.json({ error: 'Both from and to paths required' }, { status: 400 });
    }

    const result = await container.moveFile(body.from, body.to);

    return Response.json(result);
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    console.error('Error moving workspace file:', error);
    return Response.json({ error: 'Failed to move file' }, { status: 500 });
  }
}
