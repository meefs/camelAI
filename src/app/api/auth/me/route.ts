import { NextResponse } from 'next/server';
import * as authDO from '@/lib/auth-do';
import { getSessionId, unauthorizedResponse } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET() {
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

    // Get user
    const user = await authDO.getUserById(session.user_id);
    if (!user) {
      return unauthorizedResponse('User not found');
    }

    // Get current org
    const currentOrg = await authDO.getOrg(session.org_id);
    if (!currentOrg) {
      return unauthorizedResponse('Organization not found');
    }

    // Get all user's orgs
    const orgs = await authDO.getUserOrgs(session.user_id);

    return NextResponse.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        created_at: user.created_at,
      },
      currentOrg,
      orgs,
    });
  } catch (e) {
    console.error('Get me error:', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
