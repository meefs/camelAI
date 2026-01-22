import type { Route } from './+types/auth.state';
import { getSession, getSessionId } from '@/lib/cookies.server';
import * as authDO from '@/lib/auth-do.server';
import { getEnv, type CloudflareEnv } from '@/lib/cloudflare.server';
import { type AuthEnv } from '@/lib/auth-helpers';
import { getOrg } from '@/lib/auth-do';
import type { AuthState } from '@/types';

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

export async function loader({ request, context }: Route.LoaderArgs) {
  const sessionId = getSessionId(request);
  if (!sessionId) {
    return Response.json(null);
  }

  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const session = await getSession(env, sessionId);
  if (!session) {
    return Response.json(null);
  }

  // Fetch user and org data in parallel
  const [user, orgs] = await Promise.all([
    authDO.getUserById(context, session.user_id),
    authDO.getUserOrgs(context, session.user_id),
  ]);

  if (!user) {
    return Response.json(null);
  }

  // Find current org membership and get full org details
  const currentOrgMembership = orgs.find(o => o.org_id === session.org_id);
  const currentOrg = currentOrgMembership
    ? await getOrg(authEnv, currentOrgMembership.org_id)
    : null;
  const workspaces = currentOrgMembership
    ? await authDO.listUserWorkspaces(context, session.user_id, currentOrgMembership.org_id)
    : [];
  const currentWorkspace = session.workspace_id
    ? workspaces.find(w => w.id === session.workspace_id)
    : workspaces[0];

  const authState: AuthState = {
    user,
    currentOrg,
    orgs,
    currentWorkspace: currentWorkspace ?? null,
    workspaces,
    loading: false,
    error: null,
  };

  return Response.json(authState);
}
