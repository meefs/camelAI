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
  params: Promise<{ id: string }>;
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
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
      return forbiddenResponse('Only admins can view workspace access');
    }

    const [members, accessRecords] = await Promise.all([
      authDO.getOrgMembers(session.org_id),
      authDO.listWorkspaceMembers(id),
    ]);

    const accessMap = new Map(accessRecords.map((record) => [record.user_id, record]));
    const response = members.map((member) => {
      const access = accessMap.get(member.user.id);
      return {
        user: member.user,
        access_level: access?.access_level ?? 'full',
        granted_by: access?.granted_by ?? null,
        granted_at: access?.granted_at ?? null,
      };
    });

    return jsonResponse(response);
  } catch (error) {
    console.error('Error listing workspace access:', error);
    return errorResponse('Failed to list workspace access', 500);
  }
}
