import { NextRequest } from 'next/server';
import * as authDO from '@/lib/auth-do';
import {
  getSessionId,
  isValidEmail,
  jsonResponse,
  errorResponse,
  unauthorizedResponse,
  forbiddenResponse,
} from '@/lib/auth';

interface RouteParams {
  params: Promise<{ id: string }>;
}

// GET /api/orgs/[id]/invite - List pending invitations
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

// POST /api/orgs/[id]/invite - Create invitation
export async function POST(request: NextRequest, { params }: RouteParams) {
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
      return forbiddenResponse('Only admins can invite members');
    }

    const body = await request.json() as { email: string; role?: 'admin' | 'member' };
    const { email, role = 'member' } = body;

    if (!email || !isValidEmail(email)) {
      return errorResponse('Valid email is required');
    }

    if (role !== 'admin' && role !== 'member') {
      return errorResponse('Role must be "admin" or "member"');
    }

    // Check if user is already a member
    const existingUser = await authDO.getUserByEmail(email);
    if (existingUser) {
      const isMember = await authDO.isOrgMember(existingUser.userId, orgId);
      if (isMember) {
        return errorResponse('User is already a member of this organization');
      }
    }

    const invitation = await authDO.createInvitation(orgId, email, role, session.user_id);

    // Return the invitation ID which can be used to construct the invite link
    return jsonResponse({
      id: invitation.id,
      email,
      role,
      expires_at: invitation.expires_at,
      // The frontend should construct the invite link like:
      // /invite/{orgId}/{invitationId}
    }, 201);
  } catch (error) {
    console.error('Error creating invitation:', error);
    return errorResponse('Failed to create invitation', 500);
  }
}

// DELETE /api/orgs/[id]/invite - Delete invitation
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

    // Check if user is an admin of the org
    const isAdmin = await authDO.isOrgAdmin(session.user_id, orgId);
    if (!isAdmin) {
      return forbiddenResponse('Only admins can delete invitations');
    }

    const { searchParams } = new URL(request.url);
    const invitationId = searchParams.get('invitationId');

    if (!invitationId) {
      return errorResponse('Invitation ID is required');
    }

    await authDO.deleteInvitation(orgId, invitationId);
    return jsonResponse({ success: true });
  } catch (error) {
    console.error('Error deleting invitation:', error);
    return errorResponse('Failed to delete invitation', 500);
  }
}
