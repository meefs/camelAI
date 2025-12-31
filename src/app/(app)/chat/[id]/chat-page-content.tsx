import { notFound, redirect } from 'next/navigation';
import Chat from '@/components/Chat';
import { getSessionId } from '@/lib/auth';
import * as authDO from '@/lib/auth-do';
import * as chatDO from '@/lib/chat-do';

interface ChatPageContentProps {
  threadId: string;
}

export default async function ChatPageContent({ threadId }: ChatPageContentProps) {
  const sessionId = await getSessionId();
  if (!sessionId) {
    redirect('/login');
  }
  const session = await authDO.getSession(sessionId);
  if (!session) {
    redirect('/login');
  }

  const thread = await chatDO.getThread(threadId, session.org_id);
  if (!thread) {
    notFound();
  }

  const [threads, messages] = await Promise.all([
    chatDO.getThreads(session.org_id),
    chatDO.getMessages(threadId),
  ]);

  return (
    <Chat
      threadId={threadId}
      orgId={session.org_id}
      initialThreads={threads}
      initialMessages={messages}
    />
  );
}
