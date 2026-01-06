import Chat from '@/components/Chat';
import * as chatDO from '@/lib/chat-do';
import { requireSession } from '@/lib/server-guards';
import { getThreadMessages } from '@/lib/server-actions/thread';

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ newThread?: string }>;
}

export default async function ChatPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const isNewThread = resolvedSearchParams?.newThread === '1';
  const session = await requireSession();

  const [messages, thread] = await Promise.all([
    isNewThread ? Promise.resolve([]) : getThreadMessages(id),
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
