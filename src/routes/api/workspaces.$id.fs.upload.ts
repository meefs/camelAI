import type { Route } from './+types/workspaces.$id.fs.upload';
import { requireWorkspaceAuth, toContainerPath, normalizeWorkspacePath } from './workspaces.utils';

/**
 * Upload a file to any path in the workspace filesystem.
 * Accepts FormData with:
 * - file: The file to upload
 * - path: Target directory path (optional, defaults to /)
 */
export async function action({ request, context, params }: Route.ActionArgs) {
  try {
    const workspaceId = params.id;
    if (!workspaceId) {
      return Response.json({ error: 'Workspace ID required' }, { status: 400 });
    }

    const { container } = await requireWorkspaceAuth(request, context, workspaceId, {
      requireWrite: true,
    });

    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const targetDir = formData.get('path') as string | null;

    if (!file) {
      return Response.json({ error: 'No file provided' }, { status: 400 });
    }

    // Normalize target directory and build full path
    const normalizedDir = normalizeWorkspacePath(targetDir || '/');
    const filename = file.name;
    const fullPath = normalizedDir === '/' ? `/${filename}` : `${normalizedDir}/${filename}`;
    const containerPath = toContainerPath(fullPath);

    // Read file as ArrayBuffer and convert to base64
    const arrayBuffer = await file.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64Content = btoa(binary);

    // Write to container using binary write
    const result = await container.writeBinaryFile(containerPath, base64Content);

    if (!result.success) {
      return Response.json({ error: result.error || 'Failed to write file' }, { status: 500 });
    }

    return Response.json({
      success: true,
      path: fullPath,
      filename,
      size: file.size,
      contentType: file.type || 'application/octet-stream',
    });
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    console.error('Error uploading file to workspace:', error);
    return Response.json({ error: 'Failed to upload file' }, { status: 500 });
  }
}
