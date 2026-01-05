import Chat from '@/components/Chat';
import { requireSession } from '@/lib/server-guards';
import { getThreadMessages } from '@/lib/server-actions/thread';

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function ChatPage({ params }: PageProps) {
  const { id } = await params;
  const session = await requireSession();

  const messages = await getThreadMessages(id);

  return (
    <Chat
      threadId={id}
      orgId={session.org_id}
      initialMessages={messages}
    />
  );
}
