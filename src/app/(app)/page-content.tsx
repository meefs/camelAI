import { redirect } from 'next/navigation';
import Chat from '@/components/Chat';
import { getSessionId } from '@/lib/auth';
import * as authDO from '@/lib/auth-do';
import * as chatDO from '@/lib/chat-do';

export default async function HomeContent() {
  const sessionId = await getSessionId();
  if (!sessionId) {
    redirect('/login');
  }
  const session = await authDO.getSession(sessionId);
  if (!session) {
    redirect('/login');
  }

  const threads = await chatDO.getThreads(session.org_id);

  return <Chat orgId={session.org_id} initialThreads={threads} />;
}
