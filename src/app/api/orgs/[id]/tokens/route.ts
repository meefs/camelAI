import { NextRequest } from 'next/server';
import * as authDO from '@/lib/auth-do';
import {
  getSessionId,
  jsonResponse,
  errorResponse,
  unauthorizedResponse,
  forbiddenResponse,
} from '@/lib/auth';
import type { CreateApiTokenInput } from '@/types';

interface RouteParams {
  params: Promise<{ id: string }>;
}

// POST /api/orgs/[id]/tokens - Create a new API token
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

    // Only admins can create tokens
    const isAdmin = await authDO.isOrgAdmin(session.user_id, orgId);
    if (!isAdmin) {
      return forbiddenResponse('Only admins can create API tokens');
    }

    const body = (await request.json()) as CreateApiTokenInput;

    if (!body.name || body.name.trim().length === 0) {
      return errorResponse('Token name is required');
    }

    // Validate integration_id if provided
    if (body.integration_id) {
      const integration = await authDO.getOrgIntegration(orgId, body.integration_id);
      if (!integration) {
        return errorResponse('Integration not found');
      }
    }

    const result = await authDO.createOrgApiToken(orgId, session.user_id, {
      name: body.name.trim(),
      integration_id: body.integration_id,
      scopes: body.scopes,
      expires_in_days: body.expires_in_days,
    });

    // Return the full token - this is the ONLY time it's shown
    return jsonResponse(
      {
        token: result.tokenId,
        name: result.tokenData.name,
        integration_id: result.tokenData.integration_id,
        scopes: result.tokenData.scopes,
        expires_at: result.tokenData.expires_at,
        warning: 'Save this token now. It will not be shown again.',
      },
      201
    );
  } catch (error) {
    console.error('Error creating API token:', error);
    return errorResponse(
      error instanceof Error ? error.message : 'Failed to create API token',
      500
    );
  }
}
