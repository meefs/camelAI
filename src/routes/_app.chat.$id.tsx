import { Suspense, use, useEffect, useState } from 'react';
import { useLoaderData } from 'react-router';
import type { Route } from './+types/_app.chat.$id';
import { requireAuthContext, getAuthEnv } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';
import { getWorkerScript } from '@/lib/auth-do';
import * as chatDO from '@/lib/chat-do.server';
import Chat from '@/components/Chat';
import { ChatLoadingSkeleton } from '@/components/chat/chat-loading';
import { NoWorkspacesError } from '@/components/no-workspaces-error';
import type { Message, PreviewTarget } from '@/types';

export function meta({ data }: Route.MetaArgs) {
  const title = data?.threadTitle || 'Chat';
  return [
    { title: `${title} - camelAI` },
    { name: 'description', content: 'AI Chat' },
  ];
}

interface ChatData {
  messages: Message[];
  previewTabs: PreviewTarget[];
  activeTabId: string | null;
  previewTarget: PreviewTarget | null;
}

const EMPTY_CHAT_DATA: ChatData = {
  messages: [],
  previewTabs: [],
  activeTabId: null,
  previewTarget: null,
};

function getPreviewTabId(target: PreviewTarget): string {
  if (target.kind === 'app') return `app:${target.scriptName}`;
  return `file:${target.workspaceId}:${target.source}:${target.path}`;
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const authContext = await requireAuthContext(request, context);

  if (!authContext.currentWorkspace?.id) {
    return {
      threadId: params.id,
      workspaceId: null,
      chatDataPromise: Promise.resolve(EMPTY_CHAT_DATA),
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

  const thread = await chatDO.getThread(context, params.id, workspaceId);

  const env = getEnv(context);
  const authEnv = getAuthEnv(env);

  const chatDataPromise: Promise<ChatData> = isNewThread
    ? Promise.resolve(EMPTY_CHAT_DATA)
    : (async () => {
        const previewStateRaw = await chatDO.getThreadPreviewState(context, params.id).catch(() => ({
          target: null,
          tabs: [],
          activeTabId: null,
          version: 0,
        }));

        const applyAppVisibility = async (target: PreviewTarget): Promise<PreviewTarget> => {
          if (target.kind !== 'app') {
            return target;
          }
          const script = await getWorkerScript(authEnv, orgId, target.scriptName);
          if (!script) {
            return target;
          }
          return {
            ...target,
            isPublic: script.is_public,
          };
        };

        const fallbackTabs = previewStateRaw.tabs.length > 0
          ? previewStateRaw.tabs
          : (previewStateRaw.target ? [previewStateRaw.target] : []);
        const previewTabs = await Promise.all(fallbackTabs.map(applyAppVisibility));
        const tabIds = new Set(previewTabs.map(getPreviewTabId));

        let activeTabId = previewStateRaw.activeTabId;
        if (!activeTabId || !tabIds.has(activeTabId)) {
          activeTabId = previewTabs[0] ? getPreviewTabId(previewTabs[0]) : null;
        }

        let previewTarget = activeTabId
          ? (previewTabs.find((tab) => getPreviewTabId(tab) === activeTabId) ?? null)
          : null;
        if (!previewTarget && previewStateRaw.target) {
          previewTarget = await applyAppVisibility(previewStateRaw.target);
        }

        return {
          messages: [],
          previewTabs,
          activeTabId,
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

function ResolveChatData({
  threadId,
  chatDataPromise,
  onResolved,
}: {
  threadId: string;
  chatDataPromise: Promise<ChatData>;
  onResolved: (threadId: string, data: ChatData) => void;
}) {
  const chatData = use(chatDataPromise);
  useEffect(() => {
    onResolved(threadId, chatData);
  }, [threadId, chatData, onResolved]);

  return null;
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

  const [resolvedChatDataState, setResolvedChatDataState] = useState<{
    threadId: string;
    data: ChatData;
  } | null>(() => (
    isNewThread
      ? { threadId, data: EMPTY_CHAT_DATA }
      : null
  ));

  const resolvedChatData = resolvedChatDataState?.threadId === threadId
    ? resolvedChatDataState.data
    : null;
  const chatData = resolvedChatData ?? EMPTY_CHAT_DATA;
  const isLoadingMessages = !isNewThread && resolvedChatData === null;

  return (
    <>
      <Chat
        key={threadId}
        threadId={threadId}
        workspaceId={workspaceId}
        initialMessages={chatData.messages}
        threadTitle={threadTitle}
        initialPreviewTarget={chatData.previewTarget}
        initialPreviewTabs={chatData.previewTabs}
        initialActiveTabId={chatData.activeTabId}
        isNewThread={isNewThread}
        hostname={hostname}
        orgSlug={orgSlug}
        isLoadingMessages={isLoadingMessages}
      />
      {!isNewThread && (
        <Suspense fallback={null}>
          <ResolveChatData
            key={threadId}
            threadId={threadId}
            chatDataPromise={chatDataPromise}
            onResolved={(resolvedThreadId, data) => {
              setResolvedChatDataState({ threadId: resolvedThreadId, data });
            }}
          />
        </Suspense>
      )}
    </>
  );
}

export function HydrateFallback() {
  return <ChatLoadingSkeleton />;
}
