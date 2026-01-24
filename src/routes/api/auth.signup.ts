import type { Route } from './+types/auth.signup';
import { getEnv, type CloudflareEnv } from '@/lib/cloudflare.server';
import { createSessionCookie, deleteLegacySessionCookie } from '@/lib/cookies.server';
import { type AuthEnv } from '@/lib/auth-helpers';
import {
  getUserByEmail,
  createUser,
  createOrg,
  createSession,
} from '@/lib/auth-do';

function getAuthEnv(env: CloudflareEnv): AuthEnv {
  return {
    USER: env.USER as AuthEnv['USER'],
    ORG: env.ORG as AuthEnv['ORG'],
    WORKSPACE: env.WORKSPACE as AuthEnv['WORKSPACE'],
    SESSIONS: env.SESSIONS,
    EMAIL_TO_USER: env.EMAIL_TO_USER,
    API_TOKENS: env.API_TOKENS,
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  try {
    const body = await request.json() as { email?: string; password?: string; name?: string };
    const { email, password, name } = body;

    if (!email || !password) {
      return Response.json({ error: 'Email and password are required' }, { status: 400 });
    }

    const env = getEnv(context);
    const authEnv = getAuthEnv(env);

    // Check if user already exists
    const existingUser = await getUserByEmail(authEnv, email);
    if (existingUser) {
      return Response.json({ error: 'User already exists' }, { status: 400 });
    }

    // Create user
    const { userId } = await createUser(authEnv, email, password, name ?? null);

    // Create org for new user (which also creates default workspace)
    const orgName = name ? `${name}'s Organization` : `${email.split('@')[0]}'s Organization`;
    const org = await createOrg(authEnv, orgName, userId);

    // Get the default workspace ID (created by createOrg)
    const workspaceId = org.id; // createOrg uses org ID as default workspace ID

    // Create session
    const { sessionId } = await createSession(
      authEnv,
      userId,
      org.id,
      workspaceId
    );

    // Create response with session cookie
    const headers = new Headers();
    headers.append('Set-Cookie', createSessionCookie(sessionId));
    headers.append('Set-Cookie', deleteLegacySessionCookie());

    return Response.json({ success: true }, { headers });
  } catch (error) {
    console.error('Signup error:', error);
    return Response.json({ error: 'Signup failed' }, { status: 500 });
  }
}
