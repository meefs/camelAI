import { cache } from 'react';
import { getSessionId } from '@/lib/auth';
import * as authDO from '@/lib/auth-do';
import type { Organization, OrgMembership, User } from '@/types';

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
};

export type AuthContext = AuthContextLite & {
  currentOrg: Organization;
  orgs: OrgMembership[];
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

  const user = await getUserByIdCached(sessionContext.session.user_id);
  if (!user) return null;

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

  return {
    ...userContext,
    currentOrg,
  };
});

export const getAuthContext = cache(async (): Promise<AuthContext | null> => {
  const authContext = await getAuthContextLite();
  if (!authContext) return null;

  const orgs = await authDO.getUserOrgs(authContext.session.user_id);

  return {
    ...authContext,
    orgs,
  };
});
