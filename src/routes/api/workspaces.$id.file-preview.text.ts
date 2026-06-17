import type { Route } from './+types/workspaces.$id.file-preview.text';
import {
  BinaryTextPreviewError,
  FullTextPreviewTooLargeError,
} from './text-preview-stream';
import { loadTextPreviewResponse } from './workspace-file-preview-text.server';

export async function loader({ request, context, params }: Route.LoaderArgs) {
  try {
    const workspaceId = params.id;
    if (!workspaceId) {
      return Response.json({ error: 'Workspace ID required' }, { status: 400 });
    }

    const response = await loadTextPreviewResponse({
      request,
      context,
      workspaceId,
    });
    return Response.json(response, {
      headers: {
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    if (error instanceof BinaryTextPreviewError) {
      return Response.json({ error: error.message }, { status: 415 });
    }
    if (error instanceof FullTextPreviewTooLargeError) {
      return Response.json(
        { error: error.message, code: 'FULL_PREVIEW_TOO_LARGE' },
        { status: 413 }
      );
    }
    console.error('Error serving text file preview:', error);
    return Response.json({ error: 'Failed to serve text file preview' }, { status: 500 });
  }
}
