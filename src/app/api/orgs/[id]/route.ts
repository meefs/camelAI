import { NextRequest } from 'next/server';
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

// GET /api/orgs/[id] - Get organization details
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    void _request;
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

    const org = await authDO.getOrg(orgId);
    if (!org) {
      return errorResponse('Organization not found', 404);
    }

    return jsonResponse(org);
  } catch (error) {
    console.error('Error getting org:', error);
    return errorResponse('Failed to get organization', 500);
  }
}

// DELETE /api/orgs/[id] - Delete organization (not implemented - too dangerous)
export async function DELETE() {
  // For safety, we don't allow deleting organizations through the API
  // This would need to be done through a more careful admin process
  return errorResponse('Organization deletion is not supported', 405);
}
