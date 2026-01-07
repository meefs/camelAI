import { NextRequest } from 'next/server';
import * as authDO from '@/lib/auth-do';
import * as computerDO from '@/lib/computer-do';
import {
  getSessionId,
  jsonResponse,
  errorResponse,
  unauthorizedResponse,
  forbiddenResponse,
} from '@/lib/auth';

interface RouteParams {
  params: Promise<{ orgId: string }>;
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    void _request;
    const { orgId: workspaceId } = await params;
    const sessionId = await getSessionId();
    if (!sessionId) {
      return unauthorizedResponse();
    }

    const session = await authDO.getSession(sessionId);
    if (!session) {
      return unauthorizedResponse();
    }

    const workspace = await authDO.getWorkspace(workspaceId);
    if (!workspace || workspace.org_id !== session.org_id) {
      return forbiddenResponse('Workspace not found');
    }

    const access = await authDO.getWorkspaceAccess(workspaceId, session.user_id);
    if (access === 'none') {
      return forbiddenResponse('Workspace not found');
    }

    const listing = await computerDO.listWorkspaceFiles(workspaceId);
    return jsonResponse(listing);
  } catch (error) {
    console.error('Error listing workspace files:', error);
    return errorResponse('Failed to list workspace files', 500);
  }
}
