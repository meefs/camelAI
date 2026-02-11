import { waitUntil } from 'cloudflare:workers';
import { Suspense, use } from 'react';
import { useLoaderData } from 'react-router';
import type { Route } from './+types/_app.chat.$id';
import { requireAuthContext, getAuthEnv } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';
import { getWorkerScript } from '@/lib/auth-do';
import { getFirstThreadPreviewUserMessage } from '@/lib/thread-preview';
import * as chatDO from '@/lib/chat-do.server';
import Chat from '@/components/Chat';
import { ChatLoadingSkeleton } from '@/components/chat/chat-loading';
import { NoWorkspacesError } from '@/components/no-workspaces-error';
import type { Message, PreviewTarget } from '@/types';

export function meta({ data }: Route.MetaArgs) {
  const title = data?.threadTitle || 'Chat';
  return [
    { title: `${title} - Chiridion` },
    { name: 'description', content: 'AI Chat' },
  ];
}

// Type for the combined data promise
interface ChatData {
  messages: Message[];
  previewTarget: PreviewTarget | null;
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const authContext = await requireAuthContext(request, context);

  if (!authContext.currentWorkspace?.id) {
    return {
      threadId: params.id,
      workspaceId: null,
      chatDataPromise: Promise.resolve({ messages: [], previewTarget: null }),
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
    ? Promise.resolve({ messages: [], previewTarget: null })
    : (async () => {
        const [messages, previewTargetRaw] = await Promise.all([
          chatDO.getMessages(context, params.id, workspaceId),
          chatDO.getThreadPreviewTarget(context, params.id).catch(() => null),
        ]);

        if (!thread?.first_user_message) {
          const firstUserMessage = getFirstThreadPreviewUserMessage(messages);
          if (firstUserMessage) {
            waitUntil(
              chatDO
                .setThreadFirstUserMessage(context, params.id, firstUserMessage, workspaceId)
                .catch((error) => {
                  console.warn('[chat loader] Failed to lazy-populate first_user_message:', error);
                })
            );
          }
        }

        let previewTarget = previewTargetRaw;
        if (previewTarget?.kind === 'app') {
          const script = await getWorkerScript(authEnv, orgId, previewTarget.scriptName);
          if (script) {
            previewTarget = {
              ...previewTarget,
              isPublic: script.is_public,
            };
          }
        }

        return {
          messages,
          previewTarget,
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
      initialPreviewTarget={chatData?.previewTarget ?? null}
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
