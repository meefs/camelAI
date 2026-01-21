import { useLoaderData } from 'react-router';
import type { Route } from './+types/_app.chat.$id';
import { requireAuthContext } from '@/lib/auth.server';
import * as chatDO from '@/lib/chat-do.server';
import Chat from '@/components/Chat';

export function meta({ data }: Route.MetaArgs) {
  const title = data?.threadTitle || 'Chat';
  return [
    { title: `${title} - Chiridion` },
    { name: 'description', content: 'AI Chat' },
  ];
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const authContext = await requireAuthContext(request, context);

  if (!authContext.currentWorkspace?.id) {
    return {
      threadId: params.id,
      workspaceId: null,
      messages: [],
      threadTitle: null,
      initialDeployedApp: null,
      isNewThread: false,
      hostname: undefined,
    };
  }

  const workspaceId = authContext.currentWorkspace.id;
  const url = new URL(request.url);
  const isNewThread = url.searchParams.get('newThread') === '1';
  const hostname = request.headers.get('host')?.split(':')[0] || undefined;

  const [messages, thread, previewWorkers] = await Promise.all([
    isNewThread
      ? Promise.resolve([])
      : chatDO.getMessages(context, params.id, workspaceId),
    chatDO.getThread(context, params.id, workspaceId),
    isNewThread
      ? Promise.resolve([])
      : chatDO.getThreadPreview(context, params.id).catch(() => []),
  ]);

  // Use first worker as the deployed app
  const initialDeployedApp = previewWorkers[0] ?? null;

  return {
    threadId: params.id,
    workspaceId,
    messages,
    threadTitle: thread?.title ?? null,
    initialDeployedApp,
    isNewThread,
    hostname,
  };
}

export default function ChatPage() {
  const {
    threadId,
    workspaceId,
    messages,
    threadTitle,
    initialDeployedApp,
    isNewThread,
    hostname,
  } = useLoaderData<typeof loader>();

  if (!workspaceId) {
    return null;
  }

  return (
    <Chat
      threadId={threadId}
      workspaceId={workspaceId}
      initialMessages={messages}
      threadTitle={threadTitle}
      initialDeployedApp={initialDeployedApp}
      isNewThread={isNewThread}
      hostname={hostname}
    />
  );
}
