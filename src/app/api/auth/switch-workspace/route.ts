import { NextRequest } from 'next/server';
import * as authDO from '@/lib/auth-do';
import {
  errorResponse,
  getSessionId,
  jsonResponse,
  unauthorizedResponse,
} from '@/lib/auth';

export async function POST(request: NextRequest) {
  try {
    const sessionId = await getSessionId();
    if (!sessionId) {
      return unauthorizedResponse();
    }

    const session = await authDO.getSession(sessionId);
    if (!session) {
      return unauthorizedResponse();
    }

    const body = await request.json() as { workspace_id?: string | null };
    const workspaceId = body.workspace_id ?? null;
    if (!workspaceId) {
      await authDO.switchSessionWorkspace(sessionId, null);
      return jsonResponse({ workspace: null });
    }

    const workspace = await authDO.getWorkspace(workspaceId);
    if (!workspace || workspace.org_id !== session.org_id) {
      return errorResponse('Workspace not found', 404);
    }

    const access = await authDO.getWorkspaceAccess(workspaceId, session.user_id);
    if (access === 'none') {
      return errorResponse('Workspace not found', 404);
    }

    await authDO.switchSessionWorkspace(sessionId, workspaceId);
    return jsonResponse({ workspace: { ...workspace, access_level: access } });
  } catch (error) {
    console.error('Error switching workspace:', error);
    return errorResponse('Failed to switch workspace', 500);
  }
}
