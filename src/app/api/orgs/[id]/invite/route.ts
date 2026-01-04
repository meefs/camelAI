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

// GET /api/orgs/[id]/invite - List pending invitations
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

    // Check if user is an admin of the org
    const isAdmin = await authDO.isOrgAdmin(session.user_id, orgId);
    if (!isAdmin) {
      return forbiddenResponse('Only admins can view invitations');
    }

    const invitations = await authDO.getOrgInvitations(orgId);
    return jsonResponse(invitations);
  } catch (error) {
    console.error('Error listing invitations:', error);
    return errorResponse('Failed to list invitations', 500);
  }
}
