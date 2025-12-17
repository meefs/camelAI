import { NextRequest, NextResponse } from 'next/server';
import * as authDO from '@/lib/auth-do';
import {
  setSessionCookie,
  isValidEmail,
  errorResponse,
} from '@/lib/auth';

export const dynamic = 'force-dynamic';

interface LoginBody {
  email: string;
  password: string;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as LoginBody;
    const { email, password } = body;

    // Validate input
    if (!email || !password) {
      return errorResponse('Email and password are required');
    }

    if (!isValidEmail(email)) {
      return errorResponse('Invalid email address');
    }

    // Find user by email
    const userResult = await authDO.getUserByEmail(email);
    if (!userResult) {
      return errorResponse('Invalid email or password', 401);
    }

    const { userId, user } = userResult;

    // Verify password
    const isValid = await authDO.verifyUserPassword(userId, password);
    if (!isValid) {
      return errorResponse('Invalid email or password', 401);
    }

    // Get user's organizations
    const orgs = await authDO.getUserOrgs(userId);

    if (orgs.length === 0) {
      // User has no orgs - create a default one
      const org = await authDO.createOrg(`${user.name || email.split('@')[0]}'s Workspace`, userId);
      orgs.push({
        org_id: org.id,
        org_name: org.name,
        role: 'admin',
        joined_at: org.created_at,
      });
    }

    // Use first org as current org
    const currentOrgId = orgs[0].org_id;
    const currentOrg = await authDO.getOrg(currentOrgId);

    if (!currentOrg) {
      return errorResponse('Failed to load organization', 500);
    }

    // Create session
    const { sessionId } = await authDO.createSession(userId, currentOrgId);

    // Set session cookie
    await setSessionCookie(sessionId, request);

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
    console.error('Login error:', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
