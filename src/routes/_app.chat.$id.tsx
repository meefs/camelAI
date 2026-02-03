import { Suspense, use } from 'react';
import { useLoaderData } from 'react-router';
import type { Route } from './+types/_app.chat.$id';
import { requireAuthContext, getAuthEnv } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';
import { getWorkerScript } from '@/lib/auth-do';
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
  initialAppIsPublic: boolean | null;
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const authContext = await requireAuthContext(request, context);

  if (!authContext.currentWorkspace?.id) {
    return {
      threadId: params.id,
      workspaceId: null,
      chatDataPromise: Promise.resolve({ messages: [], deployedApp: null, initialAppIsPublic: null }),
      threadTitle: null,
      isNewThread: false,
      hostname: undefined,
    };
  }

  const workspaceId = authContext.currentWorkspace.id;
  const orgId = authContext.currentOrg.id;
  const url = new URL(request.url);
  const isNewThread = url.searchParams.get('newThread') === '1';
  const hostname = request.headers.get('host')?.split(':')[0] || undefined;

  // Get thread metadata synchronously (fast - from OrgDO)
  const thread = await chatDO.getThread(context, params.id, workspaceId);

  // Get auth env for looking up app visibility
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);

  // Create promise for slower data - NOT awaited, will be streamed
  const chatDataPromise: Promise<ChatData> = isNewThread
    ? Promise.resolve({ messages: [], deployedApp: null, initialAppIsPublic: null })
    : (async () => {
        const [messages, previewWorkers] = await Promise.all([
          chatDO.getMessages(context, params.id, workspaceId),
          chatDO.getThreadPreview(context, params.id).catch(() => []),
        ]);

        // Look up the app's actual visibility from the source of truth (OrgDO)
        let initialAppIsPublic: boolean | null = null;
        const deployedApp = previewWorkers[0] ?? null;
        if (deployedApp) {
          const script = await getWorkerScript(authEnv, orgId, deployedApp);
          initialAppIsPublic = script?.is_public ?? null;
        }

        return {
          messages,
          deployedApp,
          initialAppIsPublic,
        };
      })();

  return {
    threadId: params.id,
    workspaceId,
    chatDataPromise,
    threadTitle: thread?.title ?? null,
    isNewThread,
    hostname,
    orgSlug: authContext.currentOrg.slug,
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
  orgSlug,
}: {
  chatDataPromise: Promise<ChatData>;
  threadId: string;
  workspaceId: string;
  threadTitle: string | null;
  isNewThread: boolean;
  hostname: string | undefined;
  orgSlug: string;
}) {
  const chatData = use(chatDataPromise);

  return (
    <Chat
      threadId={threadId}
      workspaceId={workspaceId}
      initialMessages={chatData?.messages ?? []}
      threadTitle={threadTitle}
      initialDeployedApp={chatData?.deployedApp ?? null}
      initialAppIsPublic={chatData?.initialAppIsPublic ?? null}
      isNewThread={isNewThread}
      hostname={hostname}
      orgSlug={orgSlug}
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
    orgSlug,
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
        orgSlug={orgSlug}
      />
    </Suspense>
  );
}

export function HydrateFallback() {
  return <ChatLoadingSkeleton />;
}
