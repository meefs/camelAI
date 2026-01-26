import { Suspense, use } from 'react';
import { useLoaderData } from 'react-router';
import type { Route } from './+types/_app.chat.$id';
import { requireAuthContext } from '@/lib/auth.server';
import * as chatDO from '@/lib/chat-do.server';
import Chat from '@/components/Chat';
import { ChatLoadingSkeleton } from '@/components/chat/chat-loading';
import { NoWorkspacesError } from '@/components/no-workspaces-error';
import type { Message } from '@/types';

export function meta({ data }: Route.MetaArgs) {
  const title = data?.threadTitle || 'Chat';
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

// Type for the combined data promise
interface ChatData {
  messages: Message[];
  deployedApp: string | null;
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const authContext = await requireAuthContext(request, context);

  if (!authContext.currentWorkspace?.id) {
    return {
      threadId: params.id,
      workspaceId: null,
      chatDataPromise: Promise.resolve({ messages: [], deployedApp: null }),
      threadTitle: null,
      isNewThread: false,
      hostname: undefined,
    };
  }

  const workspaceId = authContext.currentWorkspace.id;
  const url = new URL(request.url);
  const isNewThread = url.searchParams.get('newThread') === '1';
  const hostname = request.headers.get('host')?.split(':')[0] || undefined;

  // Get thread metadata synchronously (fast - from OrgDO)
  const thread = await chatDO.getThread(context, params.id, workspaceId);

  // Create promise for slower data - NOT awaited, will be streamed
  const chatDataPromise: Promise<ChatData> = isNewThread
    ? Promise.resolve({ messages: [], deployedApp: null })
    : (async () => {
        const [messages, previewWorkers] = await Promise.all([
          chatDO.getMessages(context, params.id, workspaceId),
          chatDO.getThreadPreview(context, params.id).catch(() => []),
        ]);
        return {
          messages,
          deployedApp: previewWorkers[0] ?? null,
        };
      })();

  return {
    threadId: params.id,
    workspaceId,
    chatDataPromise,
    threadTitle: thread?.title ?? null,
    isNewThread,
    hostname,
  };
}

// Component that uses React 19's use() hook to consume the promise
// Must be a child component to trigger Suspense properly
function ChatWithData({
  chatDataPromise,
  threadId,
  workspaceId,
  threadTitle,
  isNewThread,
  hostname,
}: {
  chatDataPromise: Promise<ChatData>;
  threadId: string;
  workspaceId: string;
  threadTitle: string | null;
  isNewThread: boolean;
  hostname: string | undefined;
}) {
  const chatData = use(chatDataPromise);

  return (
    <Chat
      threadId={threadId}
      workspaceId={workspaceId}
      initialMessages={chatData?.messages ?? []}
      threadTitle={threadTitle}
      initialDeployedApp={chatData?.deployedApp ?? null}
      isNewThread={isNewThread}
      hostname={hostname}
    />
  );
}

export default function ChatPage() {
  const {
    threadId,
    workspaceId,
    chatDataPromise,
    threadTitle,
    isNewThread,
    hostname,
  } = useLoaderData<typeof loader>();

  if (!workspaceId) {
    return <NoWorkspacesError />;
  }

  return (
    <Suspense fallback={<ChatLoadingSkeleton />}>
      <ChatWithData
        chatDataPromise={chatDataPromise}
        threadId={threadId}
        workspaceId={workspaceId}
        threadTitle={threadTitle}
        isNewThread={isNewThread}
        hostname={hostname}
      />
    </Suspense>
  );
}

export function HydrateFallback() {
  return <ChatLoadingSkeleton />;
}
