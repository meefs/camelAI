import { NextRequest } from 'next/server';
import * as authDO from '@/lib/auth-do';
import {
  errorResponse,
  forbiddenResponse,
  getSessionId,
  jsonResponse,
  unauthorizedResponse,
} from '@/lib/auth';
import { createInvitation, deleteInvitation } from '@/lib/server-actions/org';

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
      return forbiddenResponse('Only admins can view invitations');
    }

    const invitations = await authDO.getOrgInvitations(orgId);
    return jsonResponse(invitations);
  } catch (error) {
    console.error('Error listing invitations:', error);
    return errorResponse('Failed to list invitations', 500);
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { id: orgId } = await params;
    const body = await request.json() as { email?: string; role?: string };
    const invitation = await createInvitation(orgId, body.email ?? '', body.role as 'admin' | 'member' | 'viewer');
    return jsonResponse(invitation);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create invitation';
    return errorResponse(message, 400);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { id: orgId } = await params;
    const body = await request.json() as { invitation_id?: string; invitationId?: string };
    const invitationId = body.invitation_id ?? body.invitationId;
    if (!invitationId) {
      return errorResponse('Invitation ID is required', 400);
    }
    await deleteInvitation(orgId, invitationId);
    return jsonResponse({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to delete invitation';
    return errorResponse(message, 400);
  }
}
