import { NextRequest } from 'next/server';
import * as computerDO from '@/lib/computer-do';
import { errorResponse, jsonResponse } from '@/lib/auth';
import type { WorkspaceOperationResult } from '@/types';
import { normalizeWorkspacePath, parseJson, requireWorkspaceSession } from '../utils';

interface RouteParams {
  params: Promise<{ id: string }>;
}

interface DeletePayload {
  path?: string;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const auth = await requireWorkspaceSession(id, { requireWrite: true });
    if (auth.response) return auth.response;

    const payload = await parseJson<DeletePayload>(request);
    if (!payload.path) {
      return errorResponse('Missing path', 400);
    }

    const path = normalizeWorkspacePath(payload.path);
    if (path === '/') {
      return errorResponse('Cannot delete workspace root', 400);
    }

    const result = await computerDO.deleteWorkspacePath(id, path);
    const response: WorkspaceOperationResult = {
      path,
      timestamp: result.result.timestamp ?? new Date().toISOString(),
    };
    return jsonResponse(response);
  } catch (error) {
    console.error('Error deleting workspace path:', error);
    return errorResponse('Failed to delete workspace path', 500);
  }
}
