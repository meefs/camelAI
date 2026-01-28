import type { Route } from './+types/workspaces.$id.fs.read';
import {
  requireWorkspaceAuth,
  getPathParam,
  toContainerPath,
  resolveContainerPath,
} from './workspaces.utils';

export async function loader({ request, context, params }: Route.LoaderArgs) {
  try {
    const workspaceId = params.id;
    if (!workspaceId) {
      return Response.json({ error: 'Workspace ID required' }, { status: 400 });
    }

    const { container } = await requireWorkspaceAuth(request, context, workspaceId);

    const url = new URL(request.url);
    const path = getPathParam(url);
    const containerPath = toContainerPath(path);

    try {
      const result = await container.readFile(containerPath);
      return Response.json(result);
    } catch (readError) {
      const msg = readError instanceof Error ? readError.message : '';
      if (msg.includes('ENOENT')) {
        const resolved = await resolveContainerPath(container, path);
        if (resolved && resolved !== containerPath) {
          try {
            const result = await container.readFile(resolved);
            return Response.json(result);
          } catch {
            // Fall through to 404
          }
        }
        return Response.json({ error: 'File not found' }, { status: 404 });
      }
      throw readError;
    }
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    console.error('Error reading workspace file:', error);
    return Response.json({ error: 'Failed to read workspace file' }, { status: 500 });
  }
}
