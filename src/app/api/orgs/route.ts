import { NextRequest } from 'next/server';
import * as authDO from '@/lib/auth-do';
import {
  getSessionId,
  jsonResponse,
  errorResponse,
  unauthorizedResponse,
} from '@/lib/auth';

export const dynamic = 'force-dynamic';

// GET /api/orgs - List user's organizations
export async function GET() {
  try {
    const sessionId = await getSessionId();
    if (!sessionId) {
      return unauthorizedResponse();
    }

    const session = await authDO.getSession(sessionId);
    if (!session) {
      return unauthorizedResponse();
    }

    const orgs = await authDO.getUserOrgs(session.user_id);
    return jsonResponse(orgs);
  } catch (error) {
    console.error('Error listing orgs:', error);
    return errorResponse('Failed to list organizations', 500);
  }
}

// POST /api/orgs - Create new organization
export async function POST(request: NextRequest) {
  try {
    const sessionId = await getSessionId();
    if (!sessionId) {
      return unauthorizedResponse();
    }

    const session = await authDO.getSession(sessionId);
    if (!session) {
      return unauthorizedResponse();
    }

    const body = await request.json() as { name: string };
    const { name } = body;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return errorResponse('Organization name is required');
    }

    if (name.length > 100) {
      return errorResponse('Organization name must be 100 characters or less');
    }

    const org = await authDO.createOrg(name.trim(), session.user_id);
    return jsonResponse(org, 201);
  } catch (error) {
    console.error('Error creating org:', error);
    return errorResponse('Failed to create organization', 500);
  }
}
