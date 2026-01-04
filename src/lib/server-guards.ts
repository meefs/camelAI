import { redirect } from 'next/navigation';
import { getSessionId } from '@/lib/auth';
import * as authDO from '@/lib/auth-do';

type Session = NonNullable<Awaited<ReturnType<typeof authDO.getSession>>>;

export async function requireSession(): Promise<Session> {
  const sessionId = await getSessionId();
  if (!sessionId) {
    redirect('/login');
  }

  const session = await authDO.getSession(sessionId);
  if (!session) {
    redirect('/login');
  }

  return session;
}

export async function requireUser() {
  const session = await requireSession();
  const user = await authDO.getUserById(session.user_id);
  if (!user) {
    redirect('/login');
  }
  return { session, user };
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
