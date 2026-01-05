import { redirect } from 'next/navigation';
import * as authDO from '@/lib/auth-do';
import { getSessionContext, getUserContext, getAuthContextLite, type AuthContextLite } from '@/lib/auth-context';

type Session = NonNullable<Awaited<ReturnType<typeof authDO.getSession>>>;

export async function requireSession(): Promise<Session> {
  const sessionContext = await getSessionContext();
  if (!sessionContext) {
    redirect('/login');
  }

  return sessionContext.session;
}

export async function requireUser() {
  const userContext = await getUserContext();
  if (!userContext) {
    redirect('/login');
  }
  return { session: userContext.session, user: userContext.user };
}

export async function requireSuperuser(message = 'Forbidden') {
  const { session, user } = await requireUser();
  if (!user.is_superuser) {
    throw new Error(message);
  }
  return { session, user };
}

export async function requireOrgMember(
  orgId: string,
  message = 'You are not a member of this organization'
): Promise<Session> {
  const session = await requireSession();
  const isMember = await authDO.isOrgMember(session.user_id, orgId);
  if (!isMember) {
    throw new Error(message);
  }
  return session;
}

export async function requireOrgAdmin(
  orgId: string,
  message = 'Only admins can perform this action'
): Promise<Session> {
  const session = await requireSession();
  const isAdmin = await authDO.isOrgAdmin(session.user_id, orgId);
  if (!isAdmin) {
    throw new Error(message);
  }
  return session;
}

export async function requireAuthContextLite(): Promise<AuthContextLite> {
  const authContext = await getAuthContextLite();
  if (!authContext) {
    redirect('/login');
  }
  return authContext;
}
