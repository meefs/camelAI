import { NextRequest } from 'next/server';
import * as authDO from '@/lib/auth-do';
import {
  getSessionId,
  jsonResponse,
  errorResponse,
  unauthorizedResponse,
} from '@/lib/auth';

export const dynamic = 'force-dynamic';

interface RouteParams {
  params: Promise<{ orgId: string; invitationId: string }>;
}

// GET /api/invitations/[orgId]/[invitationId] - Get invitation details
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, invitationId } = await params;

    const invitation = await authDO.getInvitation(orgId, invitationId);
    if (!invitation) {
      return errorResponse('Invitation not found or expired', 404);
    }

    return jsonResponse({
      email: invitation.email,
      role: invitation.role,
      org: invitation.org,
    });
  } catch (error) {
    console.error('Error getting invitation:', error);
    return errorResponse('Failed to get invitation', 500);
  }
}

// POST /api/invitations/[orgId]/[invitationId] - Accept invitation
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, invitationId } = await params;
    const sessionId = await getSessionId();
    if (!sessionId) {
      return unauthorizedResponse('You must be logged in to accept an invitation');
    }

    const session = await authDO.getSession(sessionId);
    if (!session) {
      return unauthorizedResponse('You must be logged in to accept an invitation');
    }

    // Get invitation to verify it exists and check email
    const invitation = await authDO.getInvitation(orgId, invitationId);
    if (!invitation) {
      return errorResponse('Invitation not found or expired', 404);
    }

    // Get user's email to verify it matches the invitation
    const user = await authDO.getUserById(session.user_id);
    if (!user) {
      return unauthorizedResponse();
    }

    if (user.email.toLowerCase() !== invitation.email.toLowerCase()) {
      return errorResponse(
        `This invitation was sent to ${invitation.email}. Please log in with that email address.`,
        403
      );
    }

    // Check if user is already a member
    const isMember = await authDO.isOrgMember(session.user_id, orgId);
    if (isMember) {
      return errorResponse('You are already a member of this organization');
    }

    // Accept the invitation
    const accepted = await authDO.acceptInvitation(orgId, invitationId, session.user_id);
    if (!accepted) {
      return errorResponse('Failed to accept invitation', 500);
    }

    return jsonResponse({
      success: true,
      org: invitation.org,
    });
  } catch (error) {
    console.error('Error accepting invitation:', error);
    return errorResponse('Failed to accept invitation', 500);
  }
}
