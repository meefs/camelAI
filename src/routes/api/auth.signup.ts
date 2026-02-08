import type { Route } from './+types/auth.signup';
import { getEnv, type CloudflareEnv } from '@/lib/cloudflare.server';
import { createSessionCookieHeader } from '@/lib/cookies.server';
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
    ORG_SLUG: env.ORG_SLUG as AuthEnv['ORG_SLUG'],
    WORKSPACE: env.WORKSPACE as AuthEnv['WORKSPACE'],
    SESSIONS: env.SESSIONS,
    EMAIL_TO_USER: env.EMAIL_TO_USER,
    APP_KV: env.APP_KV,
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

    const existingUser = await getUserByEmail(authEnv, email);
    if (existingUser) {
      return Response.json({ error: 'User already exists' }, { status: 400 });
    }

    const { userId } = await createUser(authEnv, email, password, name ?? null);
    const orgName = name || email.split('@')[0];
    const { org, defaultWorkspaceId } = await createOrg(authEnv, orgName, userId);
    const { sessionId } = await createSession(authEnv, userId, org.id, defaultWorkspaceId);

    return Response.json(
      { success: true },
      { headers: { 'Set-Cookie': createSessionCookieHeader(sessionId, request) } }
    );
  } catch (error) {
    console.error('Signup error:', error);
    return Response.json({ error: 'Signup failed' }, { status: 500 });
  }
}
