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
  if (!session.workspace_id) {
    return null;
  }

  const [messages, thread, previewWorkers] = await Promise.all([
    isNewThread ? Promise.resolve([]) : getThreadMessages(id),
    chatDO.getThread(id, session.workspace_id),
    isNewThread ? Promise.resolve([]) : chatDO.getThreadPreview(id).catch(() => []),
  ]);

  // Use first worker as the deployed app
  const initialDeployedApp = previewWorkers[0] ?? null;

  return (
    <Chat
      threadId={id}
      workspaceId={session.workspace_id}
      initialMessages={messages}
      threadTitle={thread?.title ?? null}
      initialDeployedApp={initialDeployedApp}
      isNewThread={isNewThread}
    />
  );
}
