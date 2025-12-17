import { NextRequest, NextResponse } from 'next/server';
import * as authDO from '@/lib/auth-do';
import { getSessionId, unauthorizedResponse, errorResponse, forbiddenResponse } from '@/lib/auth';

interface SwitchOrgBody {
  orgId: string;
}

export async function POST(request: NextRequest) {
  try {
    const sessionId = await getSessionId();

    if (!sessionId) {
      return unauthorizedResponse('Not logged in');
    }

    // Get session data
    const session = await authDO.getSession(sessionId);
    if (!session) {
      return unauthorizedResponse('Session expired');
    }

    const body = await request.json() as SwitchOrgBody;
    const { orgId } = body;

    if (!orgId) {
      return errorResponse('Organization ID is required');
    }

    // Verify user is member of the org
    const isMember = await authDO.isOrgMember(session.user_id, orgId);
    if (!isMember) {
      return forbiddenResponse('You are not a member of this organization');
    }

    // Switch org in session
    await authDO.switchSessionOrg(sessionId, orgId);

    // Get the org details
    const currentOrg = await authDO.getOrg(orgId);
    if (!currentOrg) {
      return errorResponse('Organization not found', 404);
    }

    return NextResponse.json({ currentOrg });
  } catch (e) {
    console.error('Switch org error:', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
