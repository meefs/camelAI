import { NextRequest } from 'next/server';
import * as authDO from '@/lib/auth-do';
import {
  errorResponse,
  forbiddenResponse,
  getSessionId,
  jsonResponse,
  unauthorizedResponse,
} from '@/lib/auth';

interface RouteParams {
  params: Promise<{ id: string; userId: string }>;
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { id, userId } = await params;
    const sessionId = await getSessionId();
    if (!sessionId) {
      return unauthorizedResponse();
    }

    const session = await authDO.getSession(sessionId);
    if (!session) {
      return unauthorizedResponse();
    }

    const workspace = await authDO.getWorkspace(id);
    if (!workspace || workspace.org_id !== session.org_id) {
      return errorResponse('Workspace not found', 404);
    }

    const isAdmin = await authDO.isOrgAdmin(session.user_id, session.org_id);
    if (!isAdmin) {
      return forbiddenResponse('Only admins can update workspace access');
    }

    const isMember = await authDO.isOrgMember(userId, session.org_id);
    if (!isMember) {
      return errorResponse('User is not a member of this organization', 400);
    }

    const body = await request.json() as { access_level?: string };
    const accessLevel = body.access_level;
    if (!accessLevel || !['full', 'read_only', 'none'].includes(accessLevel)) {
      return errorResponse('Invalid access level', 400);
    }

    await authDO.setWorkspaceAccess(id, userId, accessLevel as 'full' | 'read_only' | 'none', session.user_id);
    return jsonResponse({ success: true });
  } catch (error) {
    console.error('Error updating workspace access:', error);
    return errorResponse('Failed to update workspace access', 500);
  }
}
