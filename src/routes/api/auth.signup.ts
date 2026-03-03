import { waitUntil } from 'cloudflare:workers';
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
import { sendUserVerificationEmail } from '@/lib/email-verification.server';

function getAuthEnv(env: CloudflareEnv): AuthEnv {
  return {
    USER: env.USER as AuthEnv['USER'],
    ORG: env.ORG as AuthEnv['ORG'],
    ORG_SLUG: env.ORG_SLUG as AuthEnv['ORG_SLUG'],
    WORKSPACE: env.WORKSPACE as AuthEnv['WORKSPACE'],
    SESSIONS: env.SESSIONS,
    EMAIL_TO_USER: env.EMAIL_TO_USER,
    APP_KV: env.APP_KV,
    TOKEN_SIGNING_SECRET: env.TOKEN_SIGNING_SECRET,
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

    const { userId, user } = await createUser(authEnv, email, password, name ?? null);
    const orgName = name || email.split('@')[0];
    const { org, defaultWorkspaceId } = await createOrg(authEnv, orgName, userId);
    const { signedToken } = await createSession(authEnv, userId, org.id, defaultWorkspaceId, {
      name: user.name,
      email: user.email,
    });

    waitUntil(
      sendUserVerificationEmail({
        env,
        requestUrl: new URL(request.url),
        userId,
        email: user.email,
      })
        .then((result) => {
          if (result.status !== 'sent') {
            console.warn('Failed to send verification email on signup:', result.reason);
          }
        })
        .catch((error) => {
          console.error('Unexpected verification email error on signup:', error);
        })
    );

    return Response.json(
      { success: true },
      { headers: { 'Set-Cookie': createSessionCookieHeader(signedToken, request) } }
    );
  } catch (error) {
    console.error('Signup error:', error);
    return Response.json({ error: 'Signup failed' }, { status: 500 });
  }
}
