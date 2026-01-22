import type { Route } from './+types/auth.switch-org';
import { getEnv, type CloudflareEnv } from '@/lib/cloudflare.server';
import { getSessionIdFromRequest } from '@/lib/cookies.server';
import {
  getSession,
  isOrgMember,
  listUserWorkspaces,
  switchSessionOrg,
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

    const body = await request.json() as { orgId?: string };
    const { orgId } = body;

    if (!orgId) {
      return Response.json({ error: 'Organization ID is required' }, { status: 400 });
    }

    // Verify user is member of the org
    const isMember = await isOrgMember(authEnv, session.user_id, orgId);
    if (!isMember) {
      return Response.json({ error: 'Not a member of this organization' }, { status: 403 });
    }

    // Get workspaces for the org
    const workspaces = await listUserWorkspaces(authEnv, session.user_id, orgId);
    const workspaceId = workspaces[0]?.id ?? null;

    // Switch session org
    await switchSessionOrg(authEnv, sessionId, orgId, workspaceId);

    return Response.json({ success: true });
  } catch (error) {
    console.error('Switch org error:', error);
    return Response.json({ error: 'Failed to switch organization' }, { status: 500 });
  }
}
