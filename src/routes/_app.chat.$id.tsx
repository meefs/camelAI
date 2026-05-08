import { Suspense, use, useCallback, useEffect, useMemo, useState } from "react";
import { redirect, useLoaderData, useNavigate, useRevalidator } from "react-router";
import type { Route } from "./+types/_app.chat.$id";
import {
  requireAuthContext,
  requireSuperuser,
  requireSessionWorkspaceAccess,
  getAuthEnv,
} from "@/lib/auth.server";
import { integrationRecordToIntegration } from "@/lib/auth-helpers";
import { getEnv } from "@/lib/cloudflare.server";
import {
  getOrgBillingOverview,
  type OrgBillingOverview,
} from "@/lib/billing.server";
import {
  applyDevBillingCreditStatusOverride,
  getDevChatInitialError,
} from "@/lib/chat-credit-status";
import {
  DEFAULT_ORG_EXPERIMENTAL_SETTINGS,
  getDefaultLlmModel,
  getDefaultThreadProvider,
  getProviderForModel,
  getVisibleLlmModelOptions,
  isLlmModel,
} from "@/lib/llm-provider-config";
import { getOrg, getWorkerScript } from "@/lib/auth-do";
import * as authDO from "@/lib/auth-do.server";
import * as chatDO from "@/lib/chat-do.server";
import {
  ensureGroupForThread,
  listGroupsForMove,
} from "@/lib/chat-groups.server";
import Chat from "@/components/Chat";
import { ChatTabBar } from "@/components/chat-tab-bar";
import { ChatLoadingSkeleton } from "@/components/chat/chat-loading";
import { NoWorkspacesError } from "@/components/no-workspaces-error";
import { useChatGroups } from "@/hooks/use-chat-groups";
import {
  useChatThreadCache,
  type ChatThreadSnapshot,
} from "@/hooks/use-chat-thread-cache";
import type {
  ChatHarness,
  Integration,
  LlmProvider,
  LlmModel,
  Message,
  PreviewTarget,
} from "@/types";

function buildBillingCreditStatus(
  overview: OrgBillingOverview | null,
  hasByokProvider: boolean,
) {
  if (!overview || overview.billing_status === "enterprise") {
    return null;
  }
  if (overview.total_credit_limit_cents <= 0) {
    return null;
  }

  const usedPercent = Math.min(
    100,
    Math.max(
      0,
      Math.round(
        (overview.chargeable_usage_cents / overview.total_credit_limit_cents) *
          100,
      ),
    ),
  );
  const isExhausted = overview.available_credits_cents <= 0;
  const isLow = !isExhausted && usedPercent >= 80;
  if (!isLow && !isExhausted) {
    return null;
  }

  return {
    availableCreditsCents: overview.available_credits_cents,
    totalCreditLimitCents: overview.total_credit_limit_cents,
    usedPercent,
    isLow,
    isExhausted,
    hasByokProvider,
  };
}

export function meta({ data }: Route.MetaArgs) {
  const title = data?.threadTitle || "Chat";
  return [
    { title: `${title} - camelAI` },
    { name: "description", content: "AI Chat" },
  ];
}

export async function action({ request, context, params }: Route.ActionArgs) {
  const url = new URL(request.url);
  if (url.searchParams.get("adminReadonly") === "1") {
    await requireSuperuser(request, context);
    return { error: "Read-only admin view" };
  }

  const { workspaceId } = await requireSessionWorkspaceAccess(
    request,
    context,
    undefined,
    {
      requireWrite: true,
    },
  );
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "updateThreadModel") {
    const model = formData.get("model");
    const existingThread = await chatDO.getThread(
      context,
      params.id,
      workspaceId,
    );
    if (!existingThread) {
      return { error: "Thread not found" };
    }
    if (!isLlmModel(model)) {
      return { error: "A valid thread model is required" };
    }

    let updated;
    try {
      updated = await chatDO.updateThreadModel(
        context,
        params.id,
        model,
        workspaceId,
      );
    } catch (error) {
      return {
        error:
          error instanceof Error
            ? error.message
            : "Failed to update thread model",
      };
    }
    if (!updated) {
      return { error: "Thread not found" };
    }
    try {
      const env = getEnv(context);
      const chatThread = env.CHAT_THREAD.get(
        env.CHAT_THREAD.idFromName(params.id),
      ) as unknown as {
        setModel(model: LlmModel, provider?: ChatHarness): Promise<void>;
        refreshRunnerConfig(): Promise<void>;
      };
      await chatThread.setModel(updated.model, updated.provider);
      await chatThread.refreshRunnerConfig();
    } catch (error) {
      console.error("Failed to broadcast thread model update:", error);
    }

    return { thread: updated };
  }

  return { error: "Unknown action" };
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

function chatDataFromSnapshot(snapshot: ChatThreadSnapshot): ChatData {
  return {
    messages: snapshot.messages,
    previewTabs: snapshot.previewTabs,
    activeTabId: snapshot.activeTabId,
    previewTarget: snapshot.previewTarget,
  };
}

function hasUsefulSnapshot(snapshot: ChatThreadSnapshot | null): snapshot is ChatThreadSnapshot {
  return Boolean(snapshot && snapshot.messages.length > 0);
}

function getPreviewTabId(target: PreviewTarget): string {
  if (target.kind === "app") return `app:${target.scriptName}`;
  return `file:${target.workspaceId}:${target.source}:${target.path}`;
}

function buildPreviewChatDataPromise(
  context: Route.LoaderArgs["context"],
  authEnv: ReturnType<typeof getAuthEnv>,
  orgId: string,
  threadId: string,
): Promise<ChatData> {
  return (async () => {
    const previewStateRaw = await chatDO
      .getThreadPreviewState(context, threadId)
      .catch(() => ({
        target: null,
        tabs: [],
        activeTabId: null,
        version: 0,
      }));

    const applyAppVisibility = async (
      target: PreviewTarget,
    ): Promise<PreviewTarget> => {
      if (target.kind !== "app") {
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

    const fallbackTabs =
      previewStateRaw.tabs.length > 0
        ? previewStateRaw.tabs
        : previewStateRaw.target
          ? [previewStateRaw.target]
          : [];
    const previewTabs = await Promise.all(fallbackTabs.map(applyAppVisibility));
    const tabIds = new Set(previewTabs.map(getPreviewTabId));

    let activeTabId = previewStateRaw.activeTabId;
    if (!activeTabId || !tabIds.has(activeTabId)) {
      activeTabId = previewTabs[0] ? getPreviewTabId(previewTabs[0]) : null;
    }

    let previewTarget = activeTabId
      ? (previewTabs.find((tab) => getPreviewTabId(tab) === activeTabId) ??
        null)
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
  const isAdminReadonly = url.searchParams.get("adminReadonly") === "1";
  const hostname = request.headers.get("host")?.split(":")[0] || undefined;
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);

  if (isAdminReadonly) {
    await requireSuperuser(request, context);

    const threadContext = await authDO.adminGetThreadContextById(
      context,
      params.id,
    );
    if (!threadContext) {
      throw redirect("/qaml-backdoor/threads");
    }

    const thread = await chatDO.getThread(
      context,
      params.id,
      threadContext.workspace_id,
    );
    const org = await getOrg(authEnv, threadContext.org_id);

    return {
      threadId: params.id,
      workspaceId: threadContext.workspace_id,
      chatDataPromise: buildPreviewChatDataPromise(
        context,
        authEnv,
        threadContext.org_id,
        params.id,
      ),
      threadTitle: thread?.title ?? threadContext.title ?? null,
      threadModel:
        thread?.model ??
        (threadContext.model as LlmModel | undefined) ??
        getDefaultLlmModel(
          thread?.provider ??
            (threadContext.provider as ChatHarness | undefined) ??
            "claude",
        ),
      threadProvider:
        thread?.provider ??
        (threadContext.provider as ChatHarness | undefined) ??
        "claude",
      llmProvider: null as LlmProvider | null,
      allowedThreadModels: null,
      effectivePickerDefaultModel: null,
      hasEffectivePickerDefault: false,
      experimentalSettings: DEFAULT_ORG_EXPERIMENTAL_SETTINGS,
      billingCreditStatus: null,
      initialChatError: null,
      isNewThread: false,
      hostname,
      orgSlug: org?.slug,
      connections: [] as Integration[],
      isOrgAdmin: false,
      recentModelScope: null,
      readOnly: true,
      activeChatGroup: null,
      moveChatGroups: [],
    };
  }

  const authContext = await requireAuthContext(request, context);

  if (!authContext.currentWorkspace?.id) {
    return {
      threadId: params.id,
      workspaceId: null,
      chatDataPromise: Promise.resolve(EMPTY_CHAT_DATA),
      threadTitle: null,
      threadModel: getDefaultLlmModel("claude"),
      threadProvider: "claude" as const,
      llmProvider: null as LlmProvider | null,
      allowedThreadModels: [],
      effectivePickerDefaultModel: null,
      hasEffectivePickerDefault: false,
      experimentalSettings: DEFAULT_ORG_EXPERIMENTAL_SETTINGS,
      billingCreditStatus: null,
      initialChatError: getDevChatInitialError(url.searchParams),
      isNewThread: false,
      hostname: undefined,
      connections: [] as Integration[],
      isOrgAdmin: false,
      recentModelScope: null,
      readOnly: false,
    };
  }

  const workspaceId = authContext.currentWorkspace.id;
  const orgId = authContext.currentOrg.id;
  const actingUserId =
    authContext.user?.id ?? authContext.session?.user_id ?? null;
  const isNewThread = url.searchParams.get("newThread") === "1";
  const orgStub = authEnv.ORG
    ? authEnv.ORG.get(authEnv.ORG.idFromName(orgId))
    : null;
  const [experimentalSettings, llmProviderConfig, billingOverview] = orgStub
    ? await Promise.all([
        orgStub
          .getExperimentalSettings()
          .catch(() => DEFAULT_ORG_EXPERIMENTAL_SETTINGS),
        orgStub.getLlmProviderConfig().catch(() => null),
        getOrgBillingOverview(env, authContext.currentOrg).catch((error) => {
          console.warn("Failed to load billing overview for chat:", error);
          return null;
        }),
      ])
    : ([DEFAULT_ORG_EXPERIMENTAL_SETTINGS, null, null] as const);

  // Even for newly created threads, load the persisted thread record so the UI
  // reflects the actual saved model instead of the Sonnet default.
  const thread = await chatDO.getThread(context, params.id, workspaceId);
  if (!isNewThread && !thread) {
    throw redirect("/chat");
  }
  const pickerState = await chatDO
    .getWorkspaceModelPickerState(context, workspaceId, thread?.provider)
    .catch((error) => {
      console.error("Failed to load model picker state:", error);
      return null;
    });
  const fallbackThreadProvider =
    thread?.provider ??
    getDefaultThreadProvider(llmProviderConfig?.provider, experimentalSettings);
  const fallbackThreadModel =
    thread?.model ??
    getDefaultLlmModel(fallbackThreadProvider, llmProviderConfig?.provider);
  const fallbackAllowedThreadModels = getVisibleLlmModelOptions(
    fallbackThreadProvider,
    experimentalSettings,
    fallbackThreadModel,
    {
      allowModelFamilySwitch: true,
      orgProvider: llmProviderConfig?.provider,
    },
  ).map((option) => option.value);

  const chatDataPromise: Promise<ChatData> = isNewThread
    ? Promise.resolve(EMPTY_CHAT_DATA)
    : buildPreviewChatDataPromise(context, authEnv, orgId, params.id);
  const [activeChatGroup, moveChatGroups] = thread && actingUserId
    ? await Promise.all([
        ensureGroupForThread(context, {
          userId: actingUserId,
          orgId,
          workspaceId,
          threadId: params.id,
          fallbackName: thread.title,
        }).catch((error) => {
          console.error("Failed to ensure chat group:", error);
          return null;
        }),
        listGroupsForMove(context, {
          userId: actingUserId,
          orgId,
          workspaceId,
        }).catch(() => []),
      ])
    : ([null, []] as const);
  const connections = await env.WORKSPACE.get(
    env.WORKSPACE.idFromName(workspaceId),
  )
    .getIntegrations()
    .then((records) => records.map(integrationRecordToIntegration))
    .catch((error) => {
      console.error("Failed to load workspace connections:", error);
      return [] as Integration[];
    });

  return {
    threadId: params.id,
    workspaceId,
    chatDataPromise,
    threadTitle: thread?.title ?? null,
    threadModel:
      thread?.model ??
      pickerState?.defaultModel ??
      fallbackThreadModel,
    threadProvider: thread?.provider ?? pickerState?.provider ?? fallbackThreadProvider,
    llmProvider:
      pickerState?.llmProvider ??
      ((llmProviderConfig?.provider ?? null) as
        | import("@/types").LlmProvider
        | null),
    allowedThreadModels:
      pickerState?.allowedThreadModels ?? fallbackAllowedThreadModels,
    effectivePickerDefaultModel:
      pickerState?.effectivePickerDefaultModel ?? null,
    hasEffectivePickerDefault:
      pickerState?.hasEffectivePickerDefault ?? false,
    experimentalSettings:
      pickerState?.experimentalSettings ?? experimentalSettings,
    billingCreditStatus: applyDevBillingCreditStatusOverride(
      buildBillingCreditStatus(billingOverview, Boolean(llmProviderConfig)),
      url.searchParams,
    ),
    initialChatError: getDevChatInitialError(url.searchParams),
    isNewThread,
    hostname,
    orgSlug: authContext.currentOrg.slug,
    connections,
    isOrgAdmin: authContext.orgs.some(
      (org) =>
        org.org_id === orgId && (org.role === "owner" || org.role === "admin"),
    ),
    recentModelScope: { orgId, workspaceId },
    readOnly: false,
    activeChatGroup,
    moveChatGroups,
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
    llmProvider,
    allowedThreadModels,
    effectivePickerDefaultModel,
    hasEffectivePickerDefault,
    experimentalSettings,
    billingCreditStatus,
    initialChatError,
    isNewThread,
    hostname,
    orgSlug,
    connections,
    isOrgAdmin,
    recentModelScope,
    readOnly,
    activeChatGroup,
    moveChatGroups,
  } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const { groups: liveChatGroups } = useChatGroups();
  const { getSnapshot, writeSnapshot, prefetchMessages } = useChatThreadCache();
  const [optimisticThreadId, setOptimisticThreadId] = useState<string | null>(
    null,
  );

  useEffect(() => {
    setOptimisticThreadId(null);
  }, [threadId]);

  const routeSnapshot = workspaceId ? getSnapshot(workspaceId, threadId) : null;
  const [resolvedChatDataState, setResolvedChatDataState] = useState<{
    threadId: string;
    data: ChatData;
  } | null>(() => (isNewThread ? { threadId, data: EMPTY_CHAT_DATA } : null));

  const resolvedChatData =
    resolvedChatDataState?.threadId === threadId
      ? resolvedChatDataState.data
      : hasUsefulSnapshot(routeSnapshot)
        ? chatDataFromSnapshot(routeSnapshot)
      : null;
  const chatData = resolvedChatData ?? EMPTY_CHAT_DATA;

  const handleResolved = useCallback(
    (resolvedThreadId: string, data: ChatData) => {
      setResolvedChatDataState({ threadId: resolvedThreadId, data });
      if (workspaceId) {
        writeSnapshot({
          workspaceId,
          threadId: resolvedThreadId,
          threadTitle,
          ...(threadModel ? { threadModel } : {}),
          ...(threadProvider ? { threadProvider } : {}),
          messages: data.messages,
          previewTabs: data.previewTabs,
          activeTabId: data.activeTabId,
          previewTarget: data.previewTarget,
        });
      }
    },
    [threadModel, threadProvider, threadTitle, workspaceId, writeSnapshot],
  );

  const liveActiveChatGroup =
    activeChatGroup && !readOnly
      ? liveChatGroups.find((group) => group.id === activeChatGroup.id) ??
        activeChatGroup
      : activeChatGroup;

  const optimisticCandidateSnapshot = optimisticThreadId
    ? getSnapshot(workspaceId, optimisticThreadId)
    : null;
  const optimisticSnapshot = hasUsefulSnapshot(optimisticCandidateSnapshot)
    ? optimisticCandidateSnapshot
    : null;
  const optimisticThread =
    optimisticThreadId && liveActiveChatGroup
      ? liveActiveChatGroup.open_threads.find(
          (thread) => thread.id === optimisticThreadId,
        ) ?? null
      : null;
  const shouldUseOptimisticThread = Boolean(
    optimisticSnapshot && optimisticThread,
  );
  const displayThreadId =
    shouldUseOptimisticThread && optimisticSnapshot
      ? optimisticSnapshot.threadId
      : threadId;
  const displayChatData =
    shouldUseOptimisticThread && optimisticSnapshot
      ? chatDataFromSnapshot(optimisticSnapshot)
      : chatData;
  const displayThreadTitle =
    shouldUseOptimisticThread && optimisticSnapshot
      ? optimisticSnapshot.threadTitle ?? optimisticThread?.title ?? null
      : threadTitle;
  const displayThreadModel =
    shouldUseOptimisticThread && optimisticSnapshot
      ? optimisticSnapshot.threadModel
      : threadModel;
  const displayThreadProvider =
    shouldUseOptimisticThread && optimisticSnapshot
      ? optimisticSnapshot.threadProvider
      : threadProvider;
  const cacheThreadModel = displayThreadModel ?? getDefaultLlmModel("claude");
  const cacheThreadProvider =
    displayThreadProvider ?? getProviderForModel(cacheThreadModel);
  const displayIsNewThread = displayThreadId === threadId ? isNewThread : false;
  const isLoadingMessages =
    !displayIsNewThread &&
    !shouldUseOptimisticThread &&
    resolvedChatData === null;

  const openTabs =
    liveActiveChatGroup?.open_threads.map((thread) => ({
      threadId: thread.id,
      title: thread.title,
      model: thread.model,
      status: thread.status,
    })) ?? [];

  const prefetchThread = useCallback(
    (targetThreadId: string) => {
      if (
        !workspaceId ||
        !liveActiveChatGroup ||
        targetThreadId === displayThreadId
      ) {
        return;
      }
      const targetThread = liveActiveChatGroup.open_threads.find(
        (thread) => thread.id === targetThreadId,
      );
      if (!targetThread) return;
      void prefetchMessages(workspaceId, targetThreadId, {
        threadTitle: targetThread.title,
        threadModel: targetThread.model,
        threadProvider: targetThread.provider,
      });
    },
    [displayThreadId, liveActiveChatGroup, prefetchMessages, workspaceId],
  );

  const openThreadPrefetchKey = useMemo(
    () =>
      liveActiveChatGroup?.open_threads
        .map((thread) => `${thread.id}:${thread.updated_at}`)
        .join("|") ?? "",
    [liveActiveChatGroup?.open_threads],
  );

  useEffect(() => {
    if (!workspaceId || !liveActiveChatGroup || readOnly) return;
    const timeout = window.setTimeout(() => {
      for (const thread of liveActiveChatGroup.open_threads) {
        if (thread.id === displayThreadId) continue;
        void prefetchMessages(workspaceId, thread.id, {
          threadTitle: thread.title,
          threadModel: thread.model,
          threadProvider: thread.provider,
        });
      }
    }, 200);
    return () => window.clearTimeout(timeout);
  }, [
    displayThreadId,
    liveActiveChatGroup,
    openThreadPrefetchKey,
    prefetchMessages,
    readOnly,
    workspaceId,
  ]);

  const selectTab = useCallback(
    (targetThreadId: string) => {
      const snapshot = workspaceId
        ? getSnapshot(workspaceId, targetThreadId)
        : null;
      if (hasUsefulSnapshot(snapshot)) {
        setOptimisticThreadId(targetThreadId);
      } else {
        prefetchThread(targetThreadId);
      }
      navigate(`/chat/${targetThreadId}`, { preventScrollReset: true });
    },
    [getSnapshot, navigate, prefetchThread, workspaceId],
  );

  const handleThreadSnapshotChange = useCallback(
    (snapshot: {
      messages: Message[];
      previewTabs: PreviewTarget[];
      activeTabId: string | null;
      previewTarget: PreviewTarget | null;
    }) => {
      if (!workspaceId) return;
      writeSnapshot({
        workspaceId,
        threadId: displayThreadId,
        threadTitle: displayThreadTitle,
        threadModel: cacheThreadModel,
        threadProvider: cacheThreadProvider,
        messages: snapshot.messages,
        previewTabs: snapshot.previewTabs,
        activeTabId: snapshot.activeTabId,
        previewTarget: snapshot.previewTarget,
      });
    },
    [
      displayThreadId,
      displayThreadTitle,
      cacheThreadModel,
      cacheThreadProvider,
      workspaceId,
      writeSnapshot,
    ],
  );
  const closedTabs =
    liveActiveChatGroup?.closed_threads.map((thread) => ({
      threadId: thread.id,
      title: thread.title,
      model: thread.model,
      status: thread.status,
    })) ?? [];

  const closeTab = async (targetThreadId: string) => {
    if (!activeChatGroup) return;
    await fetch(
      `/api/chat-groups/${encodeURIComponent(activeChatGroup.id)}/members/${encodeURIComponent(targetThreadId)}`,
      { method: "DELETE" },
    );
    const remaining = openTabs.filter((tab) => tab.threadId !== targetThreadId);
    revalidator.revalidate();
    if (targetThreadId === displayThreadId) {
      navigate(
        remaining[0]
          ? `/chat/${remaining[0].threadId}`
          : `/chat?group=${encodeURIComponent(activeChatGroup.id)}`,
      );
    }
  };

  const reopenTab = async (targetThreadId: string) => {
    if (!activeChatGroup) return;
    await fetch(
      `/api/chat-groups/${encodeURIComponent(activeChatGroup.id)}/members/${encodeURIComponent(targetThreadId)}/reopen`,
      { method: "POST" },
    );
    revalidator.revalidate();
    navigate(`/chat/${targetThreadId}`);
  };

  const renameTab = async (targetThreadId: string, name: string) => {
    await fetch(`/api/threads/${encodeURIComponent(targetThreadId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: name }),
    });
    revalidator.revalidate();
  };

  const renameGroup = async (name: string) => {
    if (!activeChatGroup) return;
    await fetch(`/api/chat-groups/${encodeURIComponent(activeChatGroup.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    revalidator.revalidate();
  };

  const reorderTabs = async (orderedThreadIds: string[]) => {
    if (!activeChatGroup) return;
    await fetch(
      `/api/chat-groups/${encodeURIComponent(activeChatGroup.id)}/reorder-tabs`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderedThreadIds }),
      },
    );
    revalidator.revalidate();
  };

  const moveTabToGroup = async (
    targetThreadId: string,
    targetGroupId: string | "new",
  ) => {
    const response = await fetch("/api/chat-groups/move-thread", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadId: targetThreadId, targetGroupId }),
    });
    if (response.ok) {
      revalidator.revalidate();
      navigate(`/chat/${targetThreadId}`);
    }
  };

  if (!workspaceId) {
    return <NoWorkspacesError />;
  }

  return (
    <>
      <div className="flex h-full min-h-0 flex-col">
        {!readOnly && activeChatGroup ? (
          <ChatTabBar
            groupId={liveActiveChatGroup?.id ?? activeChatGroup.id}
            groupName={liveActiveChatGroup?.name ?? activeChatGroup.name}
            openTabs={openTabs}
            closedTabs={closedTabs}
            activeThreadId={displayThreadId}
            moveGroups={moveChatGroups}
            onSelectTab={selectTab}
            onTabIntent={prefetchThread}
            onCloseTab={closeTab}
            onRenameTab={renameTab}
            onReorderTabs={reorderTabs}
            onNewTab={() =>
              navigate(`/chat?group=${encodeURIComponent(activeChatGroup.id)}`)
            }
            onReopenClosedTab={reopenTab}
            onRenameGroup={renameGroup}
            onMoveTabToGroup={moveTabToGroup}
          />
        ) : null}
        <div className="flex min-h-0 flex-1 flex-col">
          <Chat
            key={displayThreadId}
            threadId={displayThreadId}
            workspaceId={workspaceId}
            chatGroupId={liveActiveChatGroup?.id ?? activeChatGroup?.id ?? null}
            initialMessages={displayChatData.messages}
            threadTitle={displayThreadTitle}
            threadModel={displayThreadModel}
            threadProvider={displayThreadProvider}
            llmProvider={llmProvider}
            allowedThreadModels={allowedThreadModels}
            effectivePickerDefaultModel={effectivePickerDefaultModel}
            hasEffectivePickerDefault={hasEffectivePickerDefault}
            experimentalSettings={experimentalSettings}
            billingCreditStatus={billingCreditStatus}
            initialError={initialChatError}
            initialPreviewTarget={displayChatData.previewTarget}
            initialPreviewTabs={displayChatData.previewTabs}
            initialActiveTabId={displayChatData.activeTabId}
            isNewThread={displayIsNewThread}
            hostname={hostname}
            orgSlug={orgSlug}
            connections={connections}
            isOrgAdmin={isOrgAdmin}
            recentModelScope={recentModelScope}
            isLoadingMessages={isLoadingMessages}
            readOnly={readOnly}
            onThreadSnapshotChange={handleThreadSnapshotChange}
          />
        </div>
      </div>
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
