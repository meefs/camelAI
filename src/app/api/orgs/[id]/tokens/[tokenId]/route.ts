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
  params: Promise<{ id: string; tokenId: string }>;
}

// DELETE /api/orgs/[id]/tokens/[tokenId] - Revoke an API token
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { id: orgId, tokenId } = await params;

    const sessionId = await getSessionId();
    if (!sessionId) {
      return unauthorizedResponse();
    }

    const session = await authDO.getSession(sessionId);
    if (!session) {
      return unauthorizedResponse();
    }

    // Only admins can delete tokens
    const isAdmin = await authDO.isOrgAdmin(session.user_id, orgId);
    if (!isAdmin) {
      return forbiddenResponse('Only admins can revoke API tokens');
    }

    await authDO.deleteApiToken(tokenId);

    return jsonResponse({ success: true });
  } catch (error) {
    console.error('Error deleting API token:', error);
    return errorResponse(
      error instanceof Error ? error.message : 'Failed to delete API token',
      500
    );
  }
}
