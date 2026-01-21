import type { Route } from './+types/workspaces.$id.fs.read';
import { requireWorkspaceAuth, getPathParam } from './workspaces.utils';

export async function loader({ request, context, params }: Route.LoaderArgs) {
  try {
    const workspaceId = params.id;
    if (!workspaceId) {
      return Response.json({ error: 'Workspace ID required' }, { status: 400 });
    }

    const { container } = await requireWorkspaceAuth(request, context, workspaceId);

    const url = new URL(request.url);
    const path = getPathParam(url);

    const result = await container.readFile(path);

    return Response.json(result);
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    console.error('Error reading workspace file:', error);
    return Response.json({ error: 'Failed to read workspace file' }, { status: 500 });
  }
}
