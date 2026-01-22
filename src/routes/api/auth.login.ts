import type { Route } from './+types/auth.login';
import { getEnv, type CloudflareEnv } from '@/lib/cloudflare.server';
import { createSessionCookie } from '@/lib/cookies.server';
import { type AuthEnv } from '@/lib/auth-helpers';
import {
  getUserByEmail,
  verifyUserPassword,
  checkUserOrphaned,
  handleOrphanedUserLogin,
  getUserOrgs,
  listUserWorkspaces,
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
    const body = await request.json() as { email?: string; password?: string };
    const { email, password } = body;

    if (!email || !password) {
      return Response.json({ error: 'Email and password are required' }, { status: 400 });
    }

    const env = getEnv(context);
    const authEnv = getAuthEnv(env);

    // Get user by email
    const userResult = await getUserByEmail(authEnv, email);
    if (!userResult) {
      return Response.json({ error: 'Invalid credentials' }, { status: 401 });
    }

    // Verify password
    const isValid = await verifyUserPassword(authEnv, userResult.userId, password);
    if (!isValid) {
      return Response.json({ error: 'Invalid credentials' }, { status: 401 });
    }

    // Check if user is orphaned
    const isOrphaned = await checkUserOrphaned(authEnv, userResult.userId);

    let orgId: string;
    let workspaceId: string | null = null;

    if (isOrphaned) {
      // Handle orphaned user - create new org and workspace
      const result = await handleOrphanedUserLogin(authEnv, userResult.userId);
      if (!result) {
        return Response.json({ error: 'Failed to create organization' }, { status: 500 });
      }
      orgId = result.org.id;
      workspaceId = result.workspace.id;
    } else {
      // Get user's orgs
      const orgs = await getUserOrgs(authEnv, userResult.userId);
      if (orgs.length === 0) {
        return Response.json({ error: 'User has no organizations' }, { status: 400 });
      }
      orgId = orgs[0].org_id;

      // Get workspaces for first org
      const workspaces = await listUserWorkspaces(authEnv, userResult.userId, orgId);
      workspaceId = workspaces[0]?.id ?? null;
    }

    // Create session
    const { sessionId } = await createSession(
      authEnv,
      userResult.userId,
      orgId,
      workspaceId
    );

    // Create response with session cookie
    const headers = new Headers();
    headers.append('Set-Cookie', createSessionCookie(sessionId));

    return Response.json({ success: true }, { headers });
  } catch (error) {
    console.error('Login error:', error);
    return Response.json({ error: 'Login failed' }, { status: 500 });
  }
}
