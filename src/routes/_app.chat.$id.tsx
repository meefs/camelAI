import { Suspense, use, useCallback, useEffect, useState } from 'react';
import { redirect, useLoaderData } from 'react-router';
import type { Route } from './+types/_app.chat.$id';
import { requireAuthContext, requireSuperuser, requireSessionWorkspaceAccess, getAuthEnv } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';
import { getDefaultLlmModel, isLlmModel, THREAD_MODEL_LOCK_MESSAGE } from '@/lib/llm-provider-config';
import { getOrg, getWorkerScript } from '@/lib/auth-do';
import * as authDO from '@/lib/auth-do.server';
import * as chatDO from '@/lib/chat-do.server';
import Chat from '@/components/Chat';
import { ChatLoadingSkeleton } from '@/components/chat/chat-loading';
import { NoWorkspacesError } from '@/components/no-workspaces-error';
import type { ChatHarness, LlmModel, Message, OrganizationExperimentalSettings, PreviewTarget } from '@/types';

export function meta({ data }: Route.MetaArgs) {
  const title = data?.threadTitle || 'Chat';
  return [
    { title: `${title} - camelAI` },
    { name: 'description', content: 'AI Chat' },
  ];
}

/**
 * Client loader that short-circuits the server round trip for new thread
 * navigations. When navigating from the welcome screen with ?newThread=1,
 * the pending-message sessionStorage entry already contains workspaceId and
 * orgSlug — everything the page needs. This eliminates a full
 * requireAuthContext() + getThread() server call (~400ms).
 */
export async function clientLoader({ serverLoader, params, request }: Route.ClientLoaderArgs) {
  const url = new URL(request.url);

  if (url.searchParams.get('newThread') === '1') {
    try {
      const stored = sessionStorage.getItem('pendingMessage:newThread');
      if (stored) {
        const parsed = JSON.parse(stored) as {
          threadId?: string;
          workspaceId?: string;
          orgSlug?: string;
          threadModel?: LlmModel;
          threadProvider?: ChatHarness;
        };
        if (parsed.threadId === params.id && parsed.workspaceId) {
          const threadProvider = parsed.threadProvider === 'codex' ? 'codex' : 'claude';
          return {
            threadId: params.id,
            workspaceId: parsed.workspaceId,
            chatDataPromise: Promise.resolve(EMPTY_CHAT_DATA),
            threadTitle: null,
            threadModel: isLlmModel(parsed.threadModel, threadProvider)
              ? parsed.threadModel
              : getDefaultLlmModel(threadProvider),
            threadProvider,
            experimentalSettings: { codex_gpt_models: false } satisfies OrganizationExperimentalSettings,
            isNewThread: true,
            hostname: window.location.hostname,
            orgSlug: parsed.orgSlug,
            readOnly: false,
          };
        }
      }
    } catch {
      // Fall through to server loader on any error
    }
  }

  return serverLoader();
}

export async function action({ request, context, params }: Route.ActionArgs) {
  const url = new URL(request.url);
  if (url.searchParams.get('adminReadonly') === '1') {
    await requireSuperuser(request, context);
    return { error: 'Read-only admin view' };
  }

  const { workspaceId } = await requireSessionWorkspaceAccess(request, context, undefined, {
    requireWrite: true,
  });
  const formData = await request.formData();
  const intent = formData.get('intent');

  if (intent === 'updateThreadModel') {
    const model = formData.get('model');
    const existingThread = await chatDO.getThread(context, params.id, workspaceId);
    if (!existingThread) {
      return { error: 'Thread not found' };
    }
    if (!isLlmModel(model, existingThread.provider ?? 'claude')) {
      return { error: 'A valid thread model is required' };
    }
    if (model !== existingThread.model) {
      return { error: THREAD_MODEL_LOCK_MESSAGE };
    }

    const updated = await chatDO.updateThreadModel(context, params.id, model, workspaceId);
    if (!updated) {
      return { error: 'Thread not found' };
    }

    return { thread: updated };
  }

  return { error: 'Unknown action' };
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

function buildPreviewChatDataPromise(
  context: Route.LoaderArgs['context'],
  authEnv: ReturnType<typeof getAuthEnv>,
  orgId: string,
  threadId: string
): Promise<ChatData> {
  return (async () => {
    const previewStateRaw = await chatDO.getThreadPreviewState(context, threadId).catch(() => ({
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
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const isAdminReadonly = url.searchParams.get('adminReadonly') === '1';
  const hostname = request.headers.get('host')?.split(':')[0] || undefined;
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);

  if (isAdminReadonly) {
    await requireSuperuser(request, context);

    const threadContext = await authDO.adminGetThreadContextById(context, params.id);
    if (!threadContext) {
      throw redirect('/qaml-backdoor/threads');
    }

    const thread = await chatDO.getThread(context, params.id, threadContext.workspace_id);
    const org = await getOrg(authEnv, threadContext.org_id);

    return {
      threadId: params.id,
      workspaceId: threadContext.workspace_id,
      chatDataPromise: buildPreviewChatDataPromise(
        context,
        authEnv,
        threadContext.org_id,
        params.id
      ),
      threadTitle: thread?.title ?? threadContext.title ?? null,
      threadModel: thread?.model ?? ((threadContext.model as LlmModel | undefined) ?? getDefaultLlmModel((thread?.provider ?? (threadContext.provider as ChatHarness | undefined) ?? 'claude'))),
      threadProvider: thread?.provider ?? ((threadContext.provider as ChatHarness | undefined) ?? 'claude'),
      experimentalSettings: { codex_gpt_models: false } satisfies OrganizationExperimentalSettings,
      isNewThread: false,
      hostname,
      orgSlug: org?.slug,
      readOnly: true,
    };
  }

  const authContext = await requireAuthContext(request, context);

  if (!authContext.currentWorkspace?.id) {
    return {
      threadId: params.id,
      workspaceId: null,
      chatDataPromise: Promise.resolve(EMPTY_CHAT_DATA),
      threadTitle: null,
      threadModel: getDefaultLlmModel('claude'),
      threadProvider: 'claude' as const,
      experimentalSettings: { codex_gpt_models: false } satisfies OrganizationExperimentalSettings,
      isNewThread: false,
      hostname: undefined,
      readOnly: false,
    };
  }

  const workspaceId = authContext.currentWorkspace.id;
  const orgId = authContext.currentOrg.id;
  const isNewThread = url.searchParams.get('newThread') === '1';
  const orgStub = authEnv.ORG
    ? authEnv.ORG.get(authEnv.ORG.idFromName(orgId))
    : null;
  const experimentalSettings = typeof orgStub?.getExperimentalSettings === 'function'
    ? await orgStub.getExperimentalSettings().catch(() => ({
        codex_gpt_models: false,
      }))
    : ({ codex_gpt_models: false } satisfies OrganizationExperimentalSettings);

  // Even for newly created threads, load the persisted thread record so the UI
  // reflects the actual saved model instead of the Sonnet default.
  const thread = await chatDO.getThread(context, params.id, workspaceId);
  if (!isNewThread && !thread) {
    throw redirect('/chat');
  }

  const chatDataPromise: Promise<ChatData> = isNewThread
    ? Promise.resolve(EMPTY_CHAT_DATA)
    : buildPreviewChatDataPromise(context, authEnv, orgId, params.id);

  return {
    threadId: params.id,
    workspaceId,
    chatDataPromise,
    threadTitle: thread?.title ?? null,
    threadModel: thread?.model ?? getDefaultLlmModel(thread?.provider ?? 'claude'),
    threadProvider: thread?.provider ?? 'claude',
    experimentalSettings,
    isNewThread,
    hostname,
    orgSlug: authContext.currentOrg.slug,
    readOnly: false,
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
    threadModel,
    threadProvider,
    experimentalSettings,
    isNewThread,
    hostname,
    orgSlug,
    readOnly,
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

  const handleResolved = useCallback((resolvedThreadId: string, data: ChatData) => {
    setResolvedChatDataState({ threadId: resolvedThreadId, data });
  }, []);

  return (
    <>
      <Chat
        key={threadId}
        threadId={threadId}
        workspaceId={workspaceId}
        initialMessages={chatData.messages}
        threadTitle={threadTitle}
        threadModel={threadModel}
        threadProvider={threadProvider}
        experimentalSettings={experimentalSettings}
        initialPreviewTarget={chatData.previewTarget}
        initialPreviewTabs={chatData.previewTabs}
        initialActiveTabId={chatData.activeTabId}
        isNewThread={isNewThread}
        hostname={hostname}
        orgSlug={orgSlug}
        isLoadingMessages={isLoadingMessages}
        readOnly={readOnly}
      />
      {!isNewThread && (
        <Suspense fallback={null}>
          <ResolveChatData
            key={threadId}
            threadId={threadId}
            chatDataPromise={chatDataPromise}
            onResolved={handleResolved}
          />
        </Suspense>
      )}
    </>
  );
}

export function HydrateFallback() {
  return <ChatLoadingSkeleton />;
}
