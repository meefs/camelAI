import type { Route } from './+types/workspaces.$id.fs.list';
import type { WorkspaceListResponse } from '@/types';
import {
  requireWorkspaceAuth,
  getPathParam,
  parseBooleanParam,
  toContainerPath,
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
    const recursive = parseBooleanParam(url.searchParams.get('recursive'), false);
    const includeHidden = parseBooleanParam(url.searchParams.get('includeHidden'), true);

    const listing = await container.listFiles(containerPath, { recursive, includeHidden });

    // Transform backend response to frontend expected format
    const response: WorkspaceListResponse = {
      path,
      entries: (listing.files || []).map((file) => ({
        path: file.relativePath || file.absolutePath,
        name: file.name,
        type: file.type,
        size: file.size,
        modifiedAt: file.modifiedAt,
      })),
      count: listing.count,
      timestamp: new Date().toISOString(),
      recursive,
    };

    return Response.json(response);
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    console.error('Error listing workspace files:', error);
    return Response.json({ error: 'Failed to list workspace files' }, { status: 500 });
  }
}
