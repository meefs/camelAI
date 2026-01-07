import { NextRequest } from 'next/server';
import * as authDO from '@/lib/auth-do';
import {
  errorResponse,
  forbiddenResponse,
  getSessionId,
  jsonResponse,
  unauthorizedResponse,
} from '@/lib/auth';

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const sessionId = await getSessionId();
    if (!sessionId) {
      return unauthorizedResponse();
    }

    const session = await authDO.getSession(sessionId);
    if (!session) {
      return unauthorizedResponse();
    }

    if (session.org_id !== id) {
      return forbiddenResponse('Organization mismatch');
    }

    const members = await authDO.getOrgMembers(id);
    const self = members.find((member) => member.user.id === session.user_id);
    if (self?.role !== 'owner') {
      return forbiddenResponse('Only the owner can transfer ownership');
    }

    const body = await request.json() as { new_owner_id?: string };
    if (!body.new_owner_id) {
      return errorResponse('New owner ID is required', 400);
    }

    const targetMember = members.find((member) => member.user.id === body.new_owner_id);
    if (!targetMember) {
      return errorResponse('User is not a member of this organization', 400);
    }

    await authDO.transferOrgOwnership(id, body.new_owner_id, session.user_id);
    return jsonResponse({ success: true });
  } catch (error) {
    console.error('Error transferring ownership:', error);
    return errorResponse('Failed to transfer ownership', 500);
  }
}
