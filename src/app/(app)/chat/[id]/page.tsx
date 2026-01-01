import { redirect } from 'next/navigation';
import Chat from '@/components/Chat';
import { getSessionId } from '@/lib/auth';
import * as authDO from '@/lib/auth-do';

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function ChatPage({ params }: PageProps) {
  const { id } = await params;
  const sessionId = await getSessionId();
  if (!sessionId) {
    redirect('/login');
  }
  const session = await authDO.getSession(sessionId);
  if (!session) {
    redirect('/login');
  }
  return <Chat threadId={id} orgId={session.org_id} />;
}
