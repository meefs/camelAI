import { NextRequest } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { errorResponse } from '@/lib/auth';
import { requireWorkspaceSession, normalizeWorkspacePath, getPathParam } from '../fs/utils';
import * as authDO from '@/lib/auth-do';

interface RouteParams {
  params: Promise<{ id: string }>;
}

interface R2Env {
  R2_BUCKET: R2Bucket;
}

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

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { id: workspaceId } = await params;
    const auth = await requireWorkspaceSession(workspaceId);
    if (auth.response) return auth.response;

    // Get path from query params
    const rawPath = getPathParam(request, 'path');
    if (!rawPath || rawPath === '/') {
      return errorResponse('Path is required', 400);
    }

    // Normalize and validate path (must be under outputs/)
    const normalizedPath = normalizeWorkspacePath(rawPath);
    if (!normalizedPath.startsWith('/outputs/')) {
      return errorResponse('Invalid path - must be under outputs/', 400);
    }

    // Get workspace to find org_id
    const workspace = await authDO.getWorkspace(workspaceId);
    if (!workspace) {
      return errorResponse('Workspace not found', 404);
    }

    // Remove leading slash and 'outputs/' prefix to get the file path
    const filePath = normalizedPath.slice('/outputs/'.length);
    const r2Key = `${workspace.org_id}/${workspaceId}/user-outputs/${filePath}`;

    // Get R2 bucket from Cloudflare context
    const { env } = getCloudflareContext() as unknown as { env: R2Env };
    const bucket = env.R2_BUCKET;

    // Get the object from R2
    const object = await bucket.get(r2Key);
    if (!object) {
      return errorResponse('File not found', 404);
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
    console.error('Error downloading file:', error);
    return errorResponse('Failed to download file', 500);
  }
}
