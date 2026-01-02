import { NextRequest } from 'next/server';
import * as computerDO from '@/lib/computer-do';
import { errorResponse, jsonResponse } from '@/lib/auth';
import type { WorkspaceFileRead } from '@/types';
import { getPathParam, hashContent, requireWorkspaceSession } from '../utils';

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const auth = await requireWorkspaceSession(id);
    if (auth.response) return auth.response;

    const path = getPathParam(request);
    const readResult = await computerDO.readWorkspaceFile(id, path);
    if (!readResult) {
      return errorResponse('File not found', 404);
    }

    const version = await hashContent(readResult.result.content);

    const parentPath =
      path === '/' ? '/' : path.split('/').slice(0, -1).join('/') || '/';
    let entry: { size: number; modifiedAt: string } | null = null;
    try {
      const listing = await computerDO.listWorkspaceEntries(id, {
        path: parentPath,
        recursive: false,
        includeHidden: true,
      });
      entry = listing.entries.find((item) => item.path === path) ?? null;
    } catch (listingError) {
      console.warn('Unable to resolve mtime for file', listingError);
    }

    const response: WorkspaceFileRead = {
      path,
      content: readResult.result.content,
      version,
      size: readResult.result.size ?? entry?.size ?? null,
      mtime: entry?.modifiedAt ?? null,
      isBinary: Boolean(readResult.result.isBinary),
      encoding: readResult.result.encoding ?? 'utf-8',
      mimeType: readResult.result.mimeType ?? null,
    };

    return jsonResponse(response);
  } catch (error) {
    console.error('Error reading workspace file:', error);
    return errorResponse('Failed to read workspace file', 500);
  }
}
