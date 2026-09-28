import type { Route } from './+types/workspaces.$id.fs.content.$';
import {
  requireWorkspaceAuth,
  normalizeWorkspacePath,
  resolveContainerPath,
  toContainerPath,
} from './workspaces.utils';
import { getMimeType, shouldDisplayInline } from '@/lib/file-content-headers';

function decodeWorkspacePath(rawPath: string): string {
  const decoded = decodeURIComponent(rawPath);
  const withLeadingSlash = decoded.startsWith('/') ? decoded : `/${decoded}`;
  return normalizeWorkspacePath(withLeadingSlash);
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  try {
    const workspaceId = params.id;
    if (!workspaceId) {
      return Response.json({ error: 'Workspace ID required' }, { status: 400 });
    }

    const rawFilePath = params['*'];
    if (!rawFilePath) {
      return Response.json({ error: 'File path required' }, { status: 400 });
    }

    const workspacePath = decodeWorkspacePath(rawFilePath);
    const { container } = await requireWorkspaceAuth(request, context, workspaceId);

    const containerPath = toContainerPath(workspacePath);

    // Stream raw bytes directly from the sandbox host — no buffering or re-encoding
    let proxyResponse = await container.readFileStream(containerPath);
    if (!proxyResponse) {
      const resolvedPath = await resolveContainerPath(container, workspacePath);
      if (resolvedPath && resolvedPath !== containerPath) {
        proxyResponse = await container.readFileStream(resolvedPath);
      }
    }

    if (!proxyResponse) {
      return Response.json({ error: 'File not found' }, { status: 404 });
    }

    const filename = workspacePath.split('/').filter(Boolean).pop() || 'file';
    const contentType = getMimeType(filename);
    const displayInline = shouldDisplayInline(contentType);
    const contentLength = proxyResponse.headers.get('Content-Length');

    const headers: Record<string, string> = {
      'Content-Type': contentType,
      'Cache-Control': 'private, no-store',
      'Content-Disposition': `${displayInline ? 'inline' : 'attachment'}; filename="${filename}"`,
    };
    if (contentLength) {
      headers['Content-Length'] = contentLength;
    }

    return new Response(proxyResponse.body, { headers });
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    console.error('Error serving workspace content file:', error);
    return Response.json({ error: 'Failed to serve workspace content file' }, { status: 500 });
  }
}
