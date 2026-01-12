import { NextRequest } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { errorResponse, jsonResponse } from '@/lib/auth';
import { requireWorkspaceSession } from '../fs/utils';
import * as authDO from '@/lib/auth-do';

interface RouteParams {
  params: Promise<{ id: string }>;
}

interface R2Env {
  R2_BUCKET: R2Bucket;
}

function generateUniqueFilename(originalName: string): string {
  const timestamp = Date.now();
  const randomPart = Math.random().toString(36).substring(2, 8);
  const ext = originalName.includes('.')
    ? originalName.slice(originalName.lastIndexOf('.'))
    : '';
  const baseName = originalName.includes('.')
    ? originalName.slice(0, originalName.lastIndexOf('.'))
    : originalName;
  // Sanitize base name (remove special chars, limit length)
  const sanitized = baseName
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .substring(0, 50);
  return `${sanitized}-${timestamp}-${randomPart}${ext}`;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { id: workspaceId } = await params;
    const auth = await requireWorkspaceSession(workspaceId, { requireWrite: true });
    if (auth.response) return auth.response;

    // Get workspace to find org_id
    const workspace = await authDO.getWorkspace(workspaceId);
    if (!workspace) {
      return errorResponse('Workspace not found', 404);
    }

    const formData = await request.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return errorResponse('No file provided', 400);
    }

    // Generate unique filename
    const filename = generateUniqueFilename(file.name);
    const r2Key = `${workspace.org_id}/${workspaceId}/user-uploads/${filename}`;

    // Get R2 bucket from Cloudflare context
    const { env } = getCloudflareContext() as unknown as { env: R2Env };
    const bucket = env.R2_BUCKET;

    // Upload to R2
    const arrayBuffer = await file.arrayBuffer();
    await bucket.put(r2Key, arrayBuffer, {
      httpMetadata: {
        contentType: file.type || 'application/octet-stream',
      },
      customMetadata: {
        originalName: file.name,
        uploadedAt: new Date().toISOString(),
      },
    });

    // Return the path as it appears in the container mount
    const mountPath = `/mnt/user-uploads/${filename}`;

    return jsonResponse({
      path: mountPath,
      filename,
      originalName: file.name,
      size: file.size,
      contentType: file.type || 'application/octet-stream',
    });
  } catch (error) {
    console.error('Error uploading file:', error);
    return errorResponse('Failed to upload file', 500);
  }
}
