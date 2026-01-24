import type { Route } from './+types/workspaces.$id.download';
import { requireWorkspaceAuth, normalizeWorkspacePath, getPathParam } from './workspaces.utils';
import { getEnv } from '@/lib/cloudflare.server';
import { getWorkspace } from '@/lib/auth-do';
import type { AuthEnv } from '@/lib/auth-helpers';

// Common MIME types for downloads
const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.wav': 'audio/wav',
};

function getMimeType(filename: string): string {
  const ext = filename.includes('.') ? `.${filename.split('.').pop()?.toLowerCase()}` : '';
  return MIME_TYPES[ext] || 'application/octet-stream';
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  try {
    const workspaceId = params.id;
    if (!workspaceId) {
      return Response.json({ error: 'Workspace ID required' }, { status: 400 });
    }

    const { orgId } = await requireWorkspaceAuth(request, context, workspaceId);

    const env = getEnv(context);
    const authEnv = env as unknown as AuthEnv;

    // Get path from query params
    const url = new URL(request.url);
    const rawPath = url.searchParams.get('path');
    if (!rawPath || rawPath === '/') {
      return Response.json({ error: 'Path is required' }, { status: 400 });
    }

    // Normalize and validate path (must be under outputs/)
    const normalizedPath = normalizeWorkspacePath(rawPath);
    if (!normalizedPath.startsWith('/outputs/')) {
      return Response.json({ error: 'Invalid path - must be under outputs/' }, { status: 400 });
    }

    // Get workspace to find org_id
    const workspace = await getWorkspace(authEnv, workspaceId);
    if (!workspace) {
      return Response.json({ error: 'Workspace not found' }, { status: 404 });
    }

    // Remove leading slash and 'outputs/' prefix to get the file path
    const filePath = normalizedPath.slice('/outputs/'.length);
    const r2Key = `${orgId}/${workspaceId}/user-outputs/${filePath}`;

    // Get the object from R2
    const object = await env.R2_BUCKET.get(r2Key);
    if (!object) {
      return Response.json({ error: 'File not found' }, { status: 404 });
    }

    // Get filename from path
    const filename = filePath.split('/').pop() || 'download';
    const contentType = object.httpMetadata?.contentType || getMimeType(filename);

    // Stream the response
    return new Response(object.body, {
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': object.size.toString(),
        'Cache-Control': 'private, max-age=3600',
      },
    });
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    console.error('Error downloading file:', error);
    return Response.json({ error: 'Failed to download file' }, { status: 500 });
  }
}
