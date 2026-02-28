import type { Route } from './+types/workspaces.$id.fs.list';
import type { WorkspaceListResponse } from '@/types';
import {
  requireWorkspaceAuth,
  getPathParam,
  parseBooleanParam,
  toContainerPath,
  normalizeWorkspacePath,
  normalizeWhitespace,
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
    const resolvedPath = await resolveContainerPath(container, path);
    const containerPath = resolvedPath ?? toContainerPath(path);
    const recursive = parseBooleanParam(url.searchParams.get('recursive'), false);
    const includeHiddenParam = url.searchParams.get('includeHidden');
    const includeHidden = includeHiddenParam === null
      ? !recursive
      : parseBooleanParam(includeHiddenParam, true);

    const listing = await container.listFiles(containerPath, { recursive, includeHidden });
    if (listing.success === false) {
      const errorMessage = listing.error || 'Failed to list workspace files';
      const lowered = errorMessage.toLowerCase();
      const status = lowered.includes('not found') || lowered.includes('enoent') ? 404 : 500;
      return Response.json({ error: errorMessage }, { status });
    }

    // Transform backend response to frontend expected format
    // Entry paths must be workspace-relative (e.g., '/.claude/projects' not just 'projects')
    const response: WorkspaceListResponse = {
      path,
      entries: (listing.files || []).flatMap((file) => {
        const name = normalizeWhitespace(file.name);
        const rawRelativePath = normalizeWhitespace(file.relativePath || name).trim();
        if (!rawRelativePath) return [];
        const normalizedRelativePath = normalizeWorkspacePath(
          rawRelativePath.startsWith('/') ? rawRelativePath : `/${rawRelativePath}`
        );
        if (normalizedRelativePath === '/') return [];
        const entryPath = path === '/'
          ? normalizedRelativePath
          : normalizeWorkspacePath(`${path}${normalizedRelativePath}`);

        return [{
          path: entryPath,
          name,
          type: file.type,
          size: file.size,
          modifiedAt: file.modifiedAt,
        }];
      }),
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
