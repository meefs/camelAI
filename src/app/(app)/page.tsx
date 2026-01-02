import { redirect } from 'next/navigation';
import Chat from '@/components/Chat';
import { getSessionId } from '@/lib/auth';
import * as authDO from '@/lib/auth-do';

export default async function Home() {
  const sessionId = await getSessionId();
  if (!sessionId) {
    redirect('/login');
  }
  const session = await authDO.getSession(sessionId);
  if (!session) {
    redirect('/login');
  }
  return <Chat orgId={session.org_id} />;
}
