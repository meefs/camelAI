import type { Route } from './+types/workspaces.$id.upload';
import { requireWorkspaceAuth } from './workspaces.utils';
import { getEnv } from '@/lib/cloudflare.server';
import { getWorkspace } from '@/lib/auth-do';
import type { AuthEnv } from '@/lib/auth-helpers';

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

export async function action({ request, context, params }: Route.ActionArgs) {
  try {
    const workspaceId = params.id;
    if (!workspaceId) {
      return Response.json({ error: 'Workspace ID required' }, { status: 400 });
    }

    const { orgId } = await requireWorkspaceAuth(request, context, workspaceId, { requireWrite: true });

    const env = getEnv(context);
    const authEnv = env as unknown as AuthEnv;

    // Get workspace to find org_id
    const workspace = await getWorkspace(authEnv, workspaceId);
    if (!workspace) {
      return Response.json({ error: 'Workspace not found' }, { status: 404 });
    }

    const formData = await request.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return Response.json({ error: 'No file provided' }, { status: 400 });
    }

    // Generate unique filename
    const filename = generateUniqueFilename(file.name);
    const r2Key = `${orgId}/${workspaceId}/user-uploads/${filename}`;

    // Upload to R2
    const arrayBuffer = await file.arrayBuffer();
    await env.R2_BUCKET.put(r2Key, arrayBuffer, {
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

    return Response.json({
      path: mountPath,
      filename,
      originalName: file.name,
      size: file.size,
      contentType: file.type || 'application/octet-stream',
    });
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    console.error('Error uploading file:', error);
    return Response.json({ error: 'Failed to upload file' }, { status: 500 });
  }
}
