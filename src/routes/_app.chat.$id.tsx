import { Suspense } from 'react';
import { useLoaderData, Await, defer } from 'react-router';
import type { Route } from './+types/_app.chat.$id';
import { requireAuthContext } from '@/lib/auth.server';
import * as chatDO from '@/lib/chat-do.server';
import Chat from '@/components/Chat';
import { ChatLoadingSkeleton } from '@/components/chat/chat-loading';
import type { Message } from '@/types';

export function meta({ data }: Route.MetaArgs) {
  // Handle both regular and deferred data
  const resolvedData = data as { threadTitle?: string | null } | undefined;
  const title = resolvedData?.threadTitle || 'Chat';
  return [
    { title: `${title} - Chiridion` },
    { name: 'description', content: 'AI Chat' },
  ];
}

export async function action({ request, context, params }: Route.ActionArgs) {
  const authContext = await requireAuthContext(request, context);

  if (!authContext.currentWorkspace?.id) {
    return { success: false };
  }

  const formData = await request.formData();
  const intent = formData.get('intent');

  if (intent === 'touch') {
    await chatDO.touchThread(context, params.id, authContext.currentWorkspace.id);
    return { success: true };
  }

  return { success: false };
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const authContext = await requireAuthContext(request, context);

  if (!authContext.currentWorkspace?.id) {
    return {
      threadId: params.id,
      workspaceId: null,
      messagesPromise: Promise.resolve([]),
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

  // Get thread metadata immediately (fast - from OrgDO)
  const thread = await chatDO.getThread(context, params.id, workspaceId);

  // Defer slow data that requires container boot
  const messagesPromise = isNewThread
    ? Promise.resolve([])
    : chatDO.getMessages(context, params.id, workspaceId);

  const previewPromise = isNewThread
    ? Promise.resolve([])
    : chatDO.getThreadPreview(context, params.id).catch(() => []);

  // Return immediately with deferred data
  return defer({
    threadId: params.id,
    workspaceId,
    messagesPromise,
    previewPromise,
    threadTitle: thread?.title ?? null,
    isNewThread,
    hostname,
  });
}

// Loading state shown while messages load
function ChatLoading({ threadId, workspaceId, threadTitle, isNewThread, hostname }: {
  threadId: string;
  workspaceId: string;
  threadTitle: string | null;
  isNewThread: boolean;
  hostname: string | undefined;
}) {
  return (
    <Chat
      threadId={threadId}
      workspaceId={workspaceId}
      initialMessages={[]}
      threadTitle={threadTitle}
      initialDeployedApp={null}
      isNewThread={isNewThread}
      hostname={hostname}
      isLoadingMessages
    />
  );
}

export default function ChatPage() {
  const {
    threadId,
    workspaceId,
    messagesPromise,
    previewPromise,
    threadTitle,
    isNewThread,
    hostname,
  } = useLoaderData<typeof loader>();

  if (!workspaceId) {
    return null;
  }

  return (
    <Suspense
      fallback={
        <ChatLoading
          threadId={threadId}
          workspaceId={workspaceId}
          threadTitle={threadTitle}
          isNewThread={isNewThread}
          hostname={hostname}
        />
      }
    >
      <Await resolve={Promise.all([messagesPromise, previewPromise])}>
        {([messages, previewWorkers]: [Message[], string[]]) => (
          <Chat
            threadId={threadId}
            workspaceId={workspaceId}
            initialMessages={messages}
            threadTitle={threadTitle}
            initialDeployedApp={previewWorkers[0] ?? null}
            isNewThread={isNewThread}
            hostname={hostname}
          />
        )}
      </Await>
    </Suspense>
  );
}

export function HydrateFallback() {
  return <ChatLoadingSkeleton />;
}
