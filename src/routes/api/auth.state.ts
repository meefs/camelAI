import type { Route } from './+types/auth.state';
import { getSession, getSessionId } from '@/lib/cookies.server';
import { getEnv } from '@/lib/cloudflare.server';
import { getAuthEnv } from '@/lib/auth-helpers';
import { getOrg, getUserOrgs, listUserWorkspaces, listUserWorkspacesAcrossOrgs } from '@/lib/auth-do';
import type { AuthState } from '@/types';

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
    authEnv.USER.get(authEnv.USER.idFromName(session.user_id)).getProfile(),
    getUserOrgs(authEnv, session.user_id),
  ]);

  if (!user) {
    return Response.json(null);
  }

  // Find current org membership and get full org details
  const currentOrgMembership = orgs.find(o => o.org_id === session.org_id);
  const currentOrg = currentOrgMembership
    ? await getOrg(authEnv, currentOrgMembership.org_id)
    : null;

  // Fetch workspaces for current org (for settings/management)
  const workspaces = currentOrg
    ? await listUserWorkspaces(authEnv, session.user_id, currentOrg.id)
    : [];

  // Fetch all workspaces across all orgs (for workspace switcher)
  const allWorkspaces = await listUserWorkspacesAcrossOrgs(authEnv, session.user_id, orgs);

  // Select current workspace from current org only
  // If no workspaces in current org, currentWorkspace will be null and UI shows error page
  const currentWorkspace = session.workspace_id
    ? workspaces.find(w => w.id === session.workspace_id) ?? workspaces[0] ?? null
    : workspaces[0] ?? null;

  const authState: AuthState = {
    user,
    currentOrg,
    orgs,
    currentWorkspace: currentWorkspace ?? null,
    workspaces,
    allWorkspaces,
    loading: false,
    error: null,
  };

  return Response.json(authState);
}
