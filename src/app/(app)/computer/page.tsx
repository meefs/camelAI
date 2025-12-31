import { redirect } from 'next/navigation';
import { getSessionId } from '@/lib/auth';
import * as authDO from '@/lib/auth-do';

export default async function ComputerRootPage() {
  const sessionId = await getSessionId();
  if (!sessionId) {
    redirect('/login');
  }

  const session = await authDO.getSession(sessionId);
  if (!session) {
    redirect('/login');
  }

  redirect(`/computer/${session.org_id}`);
}
