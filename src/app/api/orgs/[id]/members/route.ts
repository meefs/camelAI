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

// GET /api/orgs/[id]/members - List organization members
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

    const members = await authDO.getOrgMembers(orgId);
    return jsonResponse(members);
  } catch (error) {
    console.error('Error listing members:', error);
    return errorResponse('Failed to list members', 500);
  }
}

// PUT /api/orgs/[id]/members - Update member role
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
      return forbiddenResponse('Only admins can update member roles');
    }

    const body = await request.json() as { userId: string; role: 'admin' | 'member' };
    const { userId, role } = body;

    if (!userId || typeof userId !== 'string') {
      return errorResponse('User ID is required');
    }

    if (role !== 'admin' && role !== 'member') {
      return errorResponse('Role must be "admin" or "member"');
    }

    // Don't allow changing your own role (to prevent lock-out)
    if (userId === session.user_id) {
      return errorResponse('You cannot change your own role');
    }

    // Check if target user is a member
    const isMember = await authDO.isOrgMember(userId, orgId);
    if (!isMember) {
      return errorResponse('User is not a member of this organization', 404);
    }

    // Prevent demoting the last admin
    if (role === 'member') {
      const members = await authDO.getOrgMembers(orgId);
      const admins = members.filter((m) => m.role === 'admin');
      const isTargetCurrentlyAdmin = admins.some((m) => m.user.id === userId);

      if (isTargetCurrentlyAdmin && admins.length === 1) {
        return errorResponse('Cannot demote the last admin. Promote another member to admin first.');
      }
    }

    await authDO.updateOrgMemberRole(orgId, userId, role);
    return jsonResponse({ success: true });
  } catch (error) {
    console.error('Error updating member role:', error);
    return errorResponse('Failed to update member role', 500);
  }
}

// DELETE /api/orgs/[id]/members - Remove member from organization
export async function DELETE(request: NextRequest, { params }: RouteParams) {
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

    const { searchParams } = new URL(request.url);
    const userId = searchParams.get('userId');

    if (!userId) {
      return errorResponse('User ID is required');
    }

    // Check if target user is a member
    const isMember = await authDO.isOrgMember(userId, orgId);
    if (!isMember) {
      return errorResponse('User is not a member of this organization', 404);
    }

    // Prevent removing the last member (would orphan the org)
    const members = await authDO.getOrgMembers(orgId);
    if (members.length === 1) {
      return errorResponse('Cannot remove the last member of an organization');
    }

    // If removing an admin, ensure at least one admin remains
    const targetMember = members.find((m) => m.user.id === userId);
    if (targetMember?.role === 'admin') {
      const admins = members.filter((m) => m.role === 'admin');
      if (admins.length === 1) {
        return errorResponse('Cannot remove the last admin. Promote another member to admin first.');
      }
    }

    // Users can leave an org themselves
    if (userId === session.user_id) {
      await authDO.removeOrgMember(orgId, userId);
      return jsonResponse({ success: true });
    }

    // Otherwise, need to be admin to remove others
    const isAdmin = await authDO.isOrgAdmin(session.user_id, orgId);
    if (!isAdmin) {
      return forbiddenResponse('Only admins can remove members');
    }

    await authDO.removeOrgMember(orgId, userId);
    return jsonResponse({ success: true });
  } catch (error) {
    console.error('Error removing member:', error);
    return errorResponse('Failed to remove member', 500);
  }
}
