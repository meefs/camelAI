import { NextRequest } from 'next/server';
import * as authDO from '@/lib/auth-do';
import {
  errorResponse,
  forbiddenResponse,
  getSessionId,
  jsonResponse,
  unauthorizedResponse,
} from '@/lib/auth';
import { updateOrgName } from '@/lib/server-actions/org';

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

    const isMember = await authDO.isOrgMember(session.user_id, orgId);
    if (!isMember) {
      return errorResponse('Organization not found', 404);
    }

    const org = await authDO.getOrg(orgId);
    if (!org) {
      return errorResponse('Organization not found', 404);
    }

    return jsonResponse(org);
  } catch (error) {
    console.error('Error fetching organization:', error);
    return errorResponse('Failed to fetch organization', 500);
  }
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { id: orgId } = await params;
    const body = await request.json() as { name?: string };
    const org = await updateOrgName(orgId, body.name ?? '');
    return jsonResponse(org);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update organization';
    return errorResponse(message, 400);
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
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
      return forbiddenResponse('Only admins can archive organizations');
    }

    await authDO.archiveOrg(orgId, session.user_id);
    return jsonResponse({ success: true });
  } catch (error) {
    console.error('Error archiving organization:', error);
    return errorResponse('Failed to archive organization', 500);
  }
}
