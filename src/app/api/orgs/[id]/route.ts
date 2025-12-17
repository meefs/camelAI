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
export async function GET(request: NextRequest, { params }: RouteParams) {
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

// PUT /api/orgs/[id] - Update organization
export async function PUT(request: NextRequest, { params }: RouteParams) {
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
      return forbiddenResponse('Only admins can update the organization');
    }

    const body = await request.json() as { name?: string };
    const { name } = body;

    if (name !== undefined) {
      if (typeof name !== 'string' || name.trim().length === 0) {
        return errorResponse('Invalid organization name');
      }
      if (name.length > 100) {
        return errorResponse('Organization name must be 100 characters or less');
      }
      await authDO.updateOrgName(orgId, name.trim());
    }

    const org = await authDO.getOrg(orgId);
    return jsonResponse(org);
  } catch (error) {
    console.error('Error updating org:', error);
    return errorResponse('Failed to update organization', 500);
  }
}

// DELETE /api/orgs/[id] - Delete organization (not implemented - too dangerous)
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  // For safety, we don't allow deleting organizations through the API
  // This would need to be done through a more careful admin process
  return errorResponse('Organization deletion is not supported', 405);
}
