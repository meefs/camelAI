import { NextRequest } from 'next/server';
import * as computerDO from '@/lib/computer-do';
import { errorResponse, jsonResponse } from '@/lib/auth';
import type { WorkspaceOperationResult } from '@/types';
import { normalizeWorkspacePath, parseJson, requireWorkspaceSession } from '../utils';

interface RouteParams {
  params: Promise<{ id: string }>;
}

interface MovePayload {
  from?: string;
  to?: string;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const auth = await requireWorkspaceSession(id);
    if (auth.response) return auth.response;

    const payload = await parseJson<MovePayload>(request);
    if (!payload.from || !payload.to) {
      return errorResponse('Missing move paths', 400);
    }

    const fromPath = normalizeWorkspacePath(payload.from);
    const toPath = normalizeWorkspacePath(payload.to);

    if (fromPath === '/' || toPath === '/') {
      return errorResponse('Cannot move workspace root', 400);
    }

    if (toPath === fromPath || toPath.startsWith(`${fromPath}/`)) {
      return errorResponse('Invalid destination path', 400);
    }

    const result = await computerDO.moveWorkspacePath(id, fromPath, toPath);
    const response: WorkspaceOperationResult = {
      path: toPath,
      timestamp: result.result.timestamp ?? new Date().toISOString(),
    };
    return jsonResponse(response);
  } catch (error) {
    console.error('Error moving workspace path:', error);
    return errorResponse('Failed to move workspace path', 500);
  }
}
