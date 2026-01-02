import { NextRequest } from 'next/server';
import * as computerDO from '@/lib/computer-do';
import { errorResponse, jsonResponse } from '@/lib/auth';
import type { WorkspaceOperationResult } from '@/types';
import { normalizeWorkspacePath, parseJson, requireWorkspaceSession } from '../utils';

interface RouteParams {
  params: Promise<{ id: string }>;
}

interface MkdirPayload {
  path?: string;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const auth = await requireWorkspaceSession(id);
    if (auth.response) return auth.response;

    const payload = await parseJson<MkdirPayload>(request);
    if (!payload.path) {
      return errorResponse('Missing path', 400);
    }

    const path = normalizeWorkspacePath(payload.path);
    if (path === '/') {
      return errorResponse('Cannot create workspace root', 400);
    }

    const result = await computerDO.mkdirWorkspacePath(id, path);
    const response: WorkspaceOperationResult = {
      path,
      timestamp: result.result.timestamp ?? new Date().toISOString(),
    };
    return jsonResponse(response);
  } catch (error) {
    console.error('Error creating directory:', error);
    return errorResponse('Failed to create directory', 500);
  }
}
