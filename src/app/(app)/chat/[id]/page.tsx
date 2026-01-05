import Chat from '@/components/Chat';
import * as chatDO from '@/lib/chat-do';
import { requireSession } from '@/lib/server-guards';
import { getThreadMessages } from '@/lib/server-actions/thread';

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function ChatPage({ params }: PageProps) {
  const { id } = await params;
  const session = await requireSession();

  const [messages, thread] = await Promise.all([
    getThreadMessages(id),
    chatDO.getThread(id, session.org_id),
  ]);

  return (
    <Chat
      threadId={id}
      orgId={session.org_id}
      initialMessages={messages}
      threadTitle={thread?.title ?? null}
    />
  );
}
