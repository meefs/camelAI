import type { Route } from './+types/workspaces.$id.uploads.$';
import { getSession } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';
import { getWorkspace, getWorkspaceAccess } from '@/lib/auth-do';
import type { AuthEnv } from '@/lib/auth-helpers';
import { buildWorkspaceScopedR2Key } from '@/lib/workspace-r2-paths';

// Common MIME types for file serving
const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.ipynb': 'application/x-ipynb+json',
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
  '.ogg': 'audio/ogg',
  '.webm': 'video/webm',
};

// MIME types that should display inline (not trigger download)
const INLINE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'image/x-icon',
  'image/bmp',
  'application/pdf',
  'text/plain',
  'text/html',
  'text/css',
  'application/json',
  'application/x-ipynb+json',
  'application/javascript',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'video/mp4',
  'video/webm',
]);

function getMimeType(filename: string): string {
  const ext = filename.includes('.') ? `.${filename.split('.').pop()?.toLowerCase()}` : '';
  return MIME_TYPES[ext] || 'application/octet-stream';
}

function shouldDisplayInline(mimeType: string): boolean {
  return INLINE_MIME_TYPES.has(mimeType);
}

/**
 * Normalize and validate the file path, preventing directory traversal.
 * Returns null if the path is invalid.
 */
function validateFilePath(rawPath: string): string | null {
  if (!rawPath || rawPath === '/') return null;

  // Decode URI component to handle %20, etc.
  let path: string;
  try {
    path = decodeURIComponent(rawPath);
  } catch {
    return null;
  }

  // Ensure path starts with /
  if (!path.startsWith('/')) path = `/${path}`;

  // Prevent directory traversal
  if (path.includes('..')) return null;

  // Normalize path segments
  const segments = path.split('/').filter(s => s && s !== '.');
  if (segments.length === 0) return null;

  return segments.join('/');
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  try {
    const workspaceId = params.id;
    const rawFilePath = params['*'];

    if (!workspaceId) {
      return Response.json({ error: 'Workspace ID required' }, { status: 400 });
    }

    if (!rawFilePath) {
      return Response.json({ error: 'File path required' }, { status: 400 });
    }

    // Validate and normalize the file path
    const filePath = validateFilePath(rawFilePath);
    if (!filePath) {
      return Response.json({ error: 'Invalid file path' }, { status: 400 });
    }

    // Authenticate user
    const sessionContext = await getSession(request, context);
    if (!sessionContext) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const env = getEnv(context);
    const authEnv = env as unknown as AuthEnv;

    // Verify workspace access
    const workspace = await getWorkspace(authEnv, workspaceId);
    if (!workspace || workspace.org_id !== sessionContext.session.org_id) {
      return Response.json({ error: 'Workspace not found' }, { status: 404 });
    }

    const access = await getWorkspaceAccess(authEnv, workspaceId, sessionContext.session.user_id);
    if (access === 'none') {
      return Response.json({ error: 'Workspace not found' }, { status: 404 });
    }

    // Construct R2 key
    const orgId = sessionContext.session.org_id;
    const r2Key = buildWorkspaceScopedR2Key(
      orgId,
      workspaceId,
      `user-uploads/${filePath}`
    );
    const object = await env.R2_BUCKET.get(r2Key);
    if (!object) {
      return Response.json({ error: 'File not found' }, { status: 404 });
    }

    // Get filename from path
    const filename = filePath.split('/').pop() || 'file';
    const contentType = object.httpMetadata?.contentType || getMimeType(filename);
    const displayInline = shouldDisplayInline(contentType);

    // Build response headers
    const headers: Record<string, string> = {
      'Content-Type': contentType,
      'Content-Length': object.size.toString(),
      'Cache-Control': 'private, max-age=3600',
    };

    // Set Content-Disposition based on content type
    if (displayInline) {
      headers['Content-Disposition'] = `inline; filename="${filename}"`;
    } else {
      headers['Content-Disposition'] = `attachment; filename="${filename}"`;
    }

    // Stream the response
    return new Response(object.body, { headers });
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    console.error('Error serving upload file:', error);
    return Response.json({ error: 'Failed to serve file' }, { status: 500 });
  }
}
