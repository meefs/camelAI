import { getSessionId } from '@/lib/auth';
import * as authDO from '@/lib/auth-do';
import type { Organization, OrgMembership, User } from '@/types';

type Session = NonNullable<Awaited<ReturnType<typeof authDO.getSession>>>;

export type SessionContext = {
  sessionId: string;
  session: Session;
};

export type AuthContext = SessionContext & {
  user: User;
  currentOrg: Organization;
  orgs: OrgMembership[];
};

export async function getSessionContext(): Promise<SessionContext | null> {
  const sessionId = await getSessionId();
  if (!sessionId) return null;

  const session = await authDO.getSession(sessionId);
  if (!session) return null;

  return { sessionId, session };
}

export async function getAuthContext(): Promise<AuthContext | null> {
  const sessionContext = await getSessionContext();
  if (!sessionContext) return null;

  const user = await authDO.getUserById(sessionContext.session.user_id);
  if (!user) return null;

  const currentOrg = await authDO.getOrg(sessionContext.session.org_id);
  if (!currentOrg) return null;

  const orgs = await authDO.getUserOrgs(sessionContext.session.user_id);

  return {
    ...sessionContext,
    user,
    currentOrg,
    orgs,
  };
}
