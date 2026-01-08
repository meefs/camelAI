import { cache } from 'react';
import { getSessionId } from '@/lib/auth';
import * as authDO from '@/lib/auth-do';
import type { Organization, OrgMembership, User, WorkspaceWithAccess } from '@/types';

type Session = NonNullable<Awaited<ReturnType<typeof authDO.getSession>>>;

export type SessionContext = {
  sessionId: string;
  session: Session;
};

export type UserContext = SessionContext & {
  user: User;
};

export type AuthContextLite = UserContext & {
  currentOrg: Organization;
  currentWorkspace: WorkspaceWithAccess | null;
  workspaces?: WorkspaceWithAccess[];
};

export type AuthContext = AuthContextLite & {
  orgs: OrgMembership[];
  workspaces: WorkspaceWithAccess[];
};

export const getSessionContext = cache(async (): Promise<SessionContext | null> => {
  const sessionId = await getSessionId();
  if (!sessionId) return null;

  const session = await authDO.getSession(sessionId);
  if (!session) return null;

  return { sessionId, session };
});

export const getUserByIdCached = cache(async (userId: string) => {
  return authDO.getUserById(userId);
});

export const getUserContext = cache(async (): Promise<UserContext | null> => {
  const sessionContext = await getSessionContext();
  if (!sessionContext) return null;

  const profile = await getUserByIdCached(sessionContext.session.user_id);
  if (!profile) return null;

  const user: User = {
    id: profile.id,
    email: profile.email,
    name: profile.name,
    created_at: profile.created_at,
    is_superuser: profile.is_superuser,
    avatar: {
      color: profile.avatar_color,
      content: profile.avatar_content,
    },
    is_orphaned: profile.is_orphaned,
  };

  return {
    ...sessionContext,
    user,
  };
});

export const getAuthContextLite = cache(async (): Promise<AuthContextLite | null> => {
  const userContext = await getUserContext();
  if (!userContext) return null;

  const currentOrg = await authDO.getOrg(userContext.session.org_id);
  if (!currentOrg) return null;

  const workspaces = await authDO.listUserWorkspaces(userContext.session.user_id, currentOrg.id);
  const currentWorkspace = userContext.session.workspace_id
    ? workspaces.find((workspace) => workspace.id === userContext.session.workspace_id) || null
    : null;

  return {
    ...userContext,
    currentOrg,
    currentWorkspace,
    workspaces,
  };
});

export const getAuthContext = cache(async (): Promise<AuthContext | null> => {
  const authContext = await getAuthContextLite();
  if (!authContext) return null;

  const orgs = await authDO.getUserOrgs(authContext.session.user_id);
  const workspaces = await authDO.listUserWorkspacesAcrossOrgs(authContext.session.user_id, orgs);

  return {
    ...authContext,
    orgs,
    workspaces,
  };
});
