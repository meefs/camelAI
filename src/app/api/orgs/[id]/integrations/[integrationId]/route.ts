import * as authDO from '@/lib/auth-do';
import {
  getSessionId,
  jsonResponse,
  errorResponse,
  unauthorizedResponse,
  forbiddenResponse,
} from '@/lib/auth';

interface RouteParams {
  params: Promise<{ id: string; integrationId: string }>;
}

// GET /api/orgs/[id]/integrations/[integrationId] - Get single integration
export async function GET(_request: Request, { params }: RouteParams) {
  try {
    const { id: orgId, integrationId } = await params;
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

    const integration = await authDO.getOrgIntegration(orgId, integrationId);
    if (!integration) {
      return errorResponse('Integration not found', 404);
    }

    return jsonResponse(integration);
  } catch (error) {
    console.error('Error getting integration:', error);
    return errorResponse('Failed to get integration', 500);
  }
}
