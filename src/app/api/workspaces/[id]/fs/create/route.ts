import { NextRequest } from 'next/server';
import * as computerDO from '@/lib/computer-do';
import { errorResponse, jsonResponse } from '@/lib/auth';
import type { WorkspaceFileWrite } from '@/types';
import { hashContent, normalizeWorkspacePath, parseJson, requireWorkspaceSession } from '../utils';

interface RouteParams {
  params: Promise<{ id: string }>;
}

interface CreatePayload {
  path?: string;
  content?: string;
}

const encoder = new TextEncoder();

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const auth = await requireWorkspaceSession(id);
    if (auth.response) return auth.response;

    const payload = await parseJson<CreatePayload>(request);
    if (!payload.path) {
      return errorResponse('Missing path', 400);
    }

    const path = normalizeWorkspacePath(payload.path);
    if (path === '/') {
      return errorResponse('Cannot create workspace root', 400);
    }

    const content = typeof payload.content === 'string' ? payload.content : '';
    try {
      await computerDO.createWorkspaceFile(id, path, content);
    } catch (error) {
      if (error instanceof Error && error.message.includes('Workspace path already exists')) {
        return errorResponse('File already exists', 409);
      }
      throw error;
    }
    const newVersion = await hashContent(content);

    const parentPath =
      path === '/' ? '/' : path.split('/').slice(0, -1).join('/') || '/';
    const listing = await computerDO.listWorkspaceEntries(id, {
      path: parentPath,
      recursive: false,
      includeHidden: true,
    });
    const entry = listing.entries.find((item) => item.path === path);

    const response: WorkspaceFileWrite = {
      path,
      newVersion,
      size: entry?.size ?? encoder.encode(content).length,
      mtime: entry?.modifiedAt ?? null,
    };
    return jsonResponse(response);
  } catch (error) {
    console.error('Error creating file:', error);
    return errorResponse('Failed to create file', 500);
  }
}
