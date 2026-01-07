import { NextRequest } from 'next/server';
import * as authDO from '@/lib/auth-do';
import {
  errorResponse,
  forbiddenResponse,
  getSessionId,
  jsonResponse,
  unauthorizedResponse,
} from '@/lib/auth';
import { removeOrgMember, updateOrgMemberRole } from '@/lib/server-actions/org';

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
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

    const isAdmin = await authDO.isOrgAdmin(session.user_id, orgId);
    if (!isAdmin) {
      return forbiddenResponse('Only admins can view members');
    }

    const members = await authDO.getOrgMembers(orgId);
    return jsonResponse(members);
  } catch (error) {
    console.error('Error listing members:', error);
    return errorResponse('Failed to list members', 500);
  }
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { id: orgId } = await params;
    const body = await request.json() as { user_id?: string; role?: string };
    if (!body.user_id || !body.role) {
      return errorResponse('User ID and role are required', 400);
    }

    const result = await updateOrgMemberRole(orgId, body.user_id, body.role as 'admin' | 'member' | 'viewer');
    return jsonResponse(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update member role';
    return errorResponse(message, 400);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { id: orgId } = await params;
    const body = await request.json() as { user_id?: string };
    if (!body.user_id) {
      return errorResponse('User ID is required', 400);
    }

    const result = await removeOrgMember(orgId, body.user_id);
    return jsonResponse(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to remove member';
    return errorResponse(message, 400);
  }
}
