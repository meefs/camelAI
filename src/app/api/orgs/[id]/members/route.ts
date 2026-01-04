import * as authDO from '@/lib/auth-do';
import {
  getSessionId,
  jsonResponse,
  errorResponse,
  unauthorizedResponse,
  forbiddenResponse,
} from '@/lib/auth';

interface RouteParams {
  params: Promise<{ id: string }>;
}

// GET /api/orgs/[id]/members - List organization members
export async function GET(_request: Request, { params }: RouteParams) {
  try {
    const { id: orgId } = await params;
    const sessionId = await getSessionId();
    if (!sessionId) {
      return unauthorizedResponse();
    }

    const session = await authDO.getSession(sessionId);
    if (!session) {
      return unauthorizedResponse();
    }

    // Check if user is a member of the org
    const isMember = await authDO.isOrgMember(session.user_id, orgId);
    if (!isMember) {
      return forbiddenResponse('You are not a member of this organization');
    }

    const members = await authDO.getOrgMembers(orgId);
    return jsonResponse(members);
  } catch (error) {
    console.error('Error listing members:', error);
    return errorResponse('Failed to list members', 500);
  }
}
