import { NextRequest, NextResponse } from 'next/server';
import * as authDO from '@/lib/auth-do';
import {
  setSessionCookie,
  isValidEmail,
  isValidPassword,
  errorResponse,
} from '@/lib/auth';

export const dynamic = 'force-dynamic';

interface SignupBody {
  email: string;
  password: string;
  name?: string;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as SignupBody;
    const { email, password, name } = body;

    // Validate input
    if (!email || !password) {
      return errorResponse('Email and password are required');
    }

    if (!isValidEmail(email)) {
      return errorResponse('Invalid email address');
    }

    if (!isValidPassword(password)) {
      return errorResponse('Password must be at least 8 characters');
    }

    // Check if user already exists
    const existing = await authDO.getUserByEmail(email);
    if (existing) {
      return errorResponse('An account with this email already exists');
    }

    // Create user
    const { userId, user } = await authDO.createUser(email, password, name || null);

    // Create default organization for the user
    const org = await authDO.createOrg(`${name || email.split('@')[0]}'s Workspace`, userId);

    // Create session
    const { sessionId } = await authDO.createSession(userId, org.id);

    // Set session cookie
    await setSessionCookie(sessionId, request);

    // Get user's orgs
    const orgs = await authDO.getUserOrgs(userId);

    return NextResponse.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        created_at: user.created_at,
      },
      currentOrg: org,
      orgs,
    });
  } catch (e) {
    console.error('Signup error:', e);
    // In development, return more detailed error
    if (process.env.NODE_ENV === 'development') {
      return NextResponse.json({
        error: 'Internal server error',
        details: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? e.stack : undefined,
      }, { status: 500 });
    }
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
