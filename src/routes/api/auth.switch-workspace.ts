import type { Route } from './+types/auth.switch-workspace';
import { getEnv, type CloudflareEnv } from '@/lib/cloudflare.server';
import { getSessionIdFromRequest } from '@/lib/cookies.server';
import {
  getSession,
  getWorkspaceAccess,
  switchSessionWorkspace,
  type AuthEnv,
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
    const sessionId = getSessionIdFromRequest(request);
    if (!sessionId) {
      return Response.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const env = getEnv(context);
    const authEnv = getAuthEnv(env);
    const session = await getSession(authEnv, sessionId);
    if (!session) {
      return Response.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const body = await request.json() as { workspaceId?: string };
    const { workspaceId } = body;

    if (!workspaceId) {
      return Response.json({ error: 'Workspace ID is required' }, { status: 400 });
    }

    // Verify workspace access
    const accessLevel = await getWorkspaceAccess(authEnv, workspaceId, session.user_id);
    if (accessLevel === 'none') {
      return Response.json({ error: 'No access to this workspace' }, { status: 403 });
    }

    // Switch session workspace
    await switchSessionWorkspace(authEnv, sessionId, workspaceId);

    return Response.json({ success: true });
  } catch (error) {
    console.error('Switch workspace error:', error);
    return Response.json({ error: 'Failed to switch workspace' }, { status: 500 });
  }
}
