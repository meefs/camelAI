import { useEffect, useRef, useState } from "react";
import {
  redirect,
  useLoaderData,
  useLocation,
  useNavigate,
  useRevalidator,
} from "react-router";
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
  getVisibleLlmModelOptions,
  isLlmModel,
} from "@/lib/llm-provider-config";
import { getOrg, getWorkerScript } from "@/lib/auth-do";
import { getChatDebugFlags } from "@/lib/chat-debug-flags";
import * as authDO from "@/lib/auth-do.server";
import * as chatDO from "@/lib/chat-do.server";
import {
  ensureGroupForThread,
  listGroupsForMove,
} from "@/lib/chat-groups.server";
import { readThreadMessages } from "@/lib/chat-history.server";
import Chat from "@/components/Chat";
import { ChatTabBar } from "@/components/chat-tab-bar";
import { ChatLoadingSkeleton } from "@/components/chat/chat-loading";
import { NoWorkspacesError } from "@/components/no-workspaces-error";
import { useChatGroups } from "@/hooks/use-chat-groups";
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
  messagesError: string | null;
  previewTabs: PreviewTarget[];
  activeTabId: string | null;
  previewTarget: PreviewTarget | null;
}

const EMPTY_CHAT_DATA: ChatData = {
  messages: [],
  messagesError: null,
  previewTabs: [],
  activeTabId: null,
  previewTarget: null,
};

function getPreviewTabId(target: PreviewTarget): string {
  if (target.kind === "app") return `app:${target.scriptName}`;
  return `file:${target.workspaceId}:${target.source}:${target.path}`;
}

async function buildChatData(
  context: Route.LoaderArgs["context"],
  authEnv: ReturnType<typeof getAuthEnv>,
  threadId: string,
  options: {
    orgId: string;
    workspaceId: string;
    loadMessages: boolean;
    skipBanCheck?: boolean;
  },
): Promise<ChatData> {
  const previewDataPromise = (async () => {
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
      const script = await getWorkerScript(
        authEnv,
        options.orgId,
        target.scriptName,
      );
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
      previewTabs,
      activeTabId,
      previewTarget,
    };
  })();

  const messagesPromise = options.loadMessages
    ? readThreadMessages(context, {
        workspaceId: options.workspaceId,
        orgId: options.orgId,
        threadId,
        skipBanCheck: options.skipBanCheck,
      })
        .then((messages) => ({ messages, messagesError: null }))
        .catch((error) => {
          console.error("Failed to load chat route messages:", error);
          return {
            messages: [] as Message[],
            messagesError: "Failed to load message history",
          };
        })
    : Promise.resolve({ messages: [], messagesError: null });

  const [previewData, messageData] = await Promise.all([
    previewDataPromise,
    messagesPromise,
  ]);
  return {
    ...previewData,
    messages: messageData.messages,
    messagesError: messageData.messagesError,
  };
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const isAdminReadonly = url.searchParams.get("adminReadonly") === "1";
  const isNewThread = url.searchParams.get("newThread") === "1";
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
      chatData: await buildChatData(context, authEnv, params.id, {
        orgId: threadContext.org_id,
        workspaceId: threadContext.workspace_id,
        loadMessages: true,
        skipBanCheck: true,
      }),
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

  if (isNewThread) {
    const { orgId, workspaceId } = await requireSessionWorkspaceAccess(
      request,
      context,
    );
    const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(orgId));
    const [thread, org] = await Promise.all([
      orgStub.getThread(params.id),
      orgStub.getInfo().catch(() => null),
    ]);

    if (!thread || thread.workspace_id !== workspaceId) {
      throw redirect("/chat");
    }
    if ((thread.user_message_count ?? 0) > 0) {
      throw redirect(`/chat/${params.id}`);
    }

    return {
      threadId: params.id,
      workspaceId,
      chatData: EMPTY_CHAT_DATA,
      threadTitle: thread.title ?? null,
      threadModel: thread.model,
      threadProvider: thread.provider,
      llmProvider: null as LlmProvider | null,
      allowedThreadModels: [thread.model],
      effectivePickerDefaultModel: null,
      hasEffectivePickerDefault: false,
      experimentalSettings: DEFAULT_ORG_EXPERIMENTAL_SETTINGS,
      billingCreditStatus: null,
      initialChatError: getDevChatInitialError(url.searchParams),
      isNewThread: true,
      hostname,
      orgSlug: org?.slug,
      connections: [] as Integration[],
      isOrgAdmin: false,
      recentModelScope: { orgId, workspaceId },
      readOnly: false,
      activeChatGroup: null,
      moveChatGroups: [],
    };
  }

  const authContext = await requireAuthContext(request, context);

  if (!authContext.currentWorkspace?.id) {
    return {
      threadId: params.id,
      workspaceId: null,
      chatData: EMPTY_CHAT_DATA,
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

  const chatData = thread
    ? await buildChatData(context, authEnv, params.id, {
        orgId,
        workspaceId,
        loadMessages: true,
      })
    : EMPTY_CHAT_DATA;
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
    chatData,
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

export default function ChatPage() {
  const {
    threadId,
    workspaceId,
    chatData,
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
  const location = useLocation();
  const revalidator = useRevalidator();
  const { groups: liveChatGroups, markThreadIdle } = useChatGroups();
  const chatDebugFlags = getChatDebugFlags();
  const markViewedEnabled = chatDebugFlags.markViewed;
  const markThreadIdleRef = useRef(markThreadIdle);
  const revalidateRef = useRef(revalidator.revalidate);
  const [instantThreadId, setInstantThreadId] = useState<string | null>(null);
  const [chatDataByThreadId, setChatDataByThreadId] = useState<
    Record<string, ChatData>
  >(() => ({ [threadId]: chatData }));

  const liveActiveChatGroup =
    activeChatGroup && !readOnly
      ? liveChatGroups.find((group) => group.id === activeChatGroup.id) ??
        activeChatGroup
      : activeChatGroup;

  useEffect(() => {
    if (chatDebugFlags.historyLogs) {
      console.info("[chat history route]", {
        event: "loader_data_received",
        at: new Date().toISOString(),
        location: `${location.pathname}${location.search}`,
        threadId,
        isNewThread,
        routeMessageCount: chatData.messages.length,
        routeMessageIds: chatData.messages.map((message) => ({
          id: message.id,
          clientMessageId: message.clientMessageId,
          role: message.role,
          created_at: message.created_at,
        })),
        messagesError: chatData.messagesError,
        activeChatGroupId: activeChatGroup?.id ?? null,
      });
    }
    setChatDataByThreadId((prev) => ({ ...prev, [threadId]: chatData }));
    setInstantThreadId(null);
  }, [
    activeChatGroup?.id,
    chatData,
    chatDebugFlags.historyLogs,
    isNewThread,
    location.pathname,
    location.search,
    threadId,
  ]);

  const instantThread =
    instantThreadId && liveActiveChatGroup
      ? liveActiveChatGroup.open_threads.find(
          (thread) => thread.id === instantThreadId,
        ) ??
        liveActiveChatGroup.closed_threads.find(
          (thread) => thread.id === instantThreadId,
        ) ??
        null
      : null;
  const instantChatData = instantThreadId
    ? chatDataByThreadId[instantThreadId]
    : null;
  const shouldUseInstantThread = Boolean(
    instantThread &&
      instantChatData &&
      instantThreadId &&
      instantThreadId !== threadId,
  );
  const displayThreadId =
    shouldUseInstantThread && instantThread ? instantThread.id : threadId;
  const displayThreadTitle =
    shouldUseInstantThread && instantThread ? instantThread.title : threadTitle;
  const displayThreadModel =
    shouldUseInstantThread && instantThread ? instantThread.model : threadModel;
  const displayThreadProvider =
    shouldUseInstantThread && instantThread
      ? instantThread.provider
      : threadProvider;
  const displayAllowedThreadModels =
    shouldUseInstantThread && displayThreadModel && displayThreadProvider
      ? getVisibleLlmModelOptions(
          displayThreadProvider,
          experimentalSettings,
          displayThreadModel,
          {
            allowModelFamilySwitch: true,
            orgProvider: llmProvider,
          },
        ).map((option) => option.value)
      : allowedThreadModels;
  const displayChatData =
    shouldUseInstantThread && instantChatData ? instantChatData : chatData;
  const displayIsNewThread = shouldUseInstantThread ? false : isNewThread;

  useEffect(() => {
    markThreadIdleRef.current = markThreadIdle;
  }, [markThreadIdle]);

  useEffect(() => {
    revalidateRef.current = revalidator.revalidate;
  }, [revalidator.revalidate]);

  useEffect(() => {
    if (!markViewedEnabled || readOnly || !workspaceId || !displayThreadId) return;

    markThreadIdleRef.current(displayThreadId);
    const controller = new AbortController();
    void fetch(
      `/api/threads/${encodeURIComponent(displayThreadId)}/mark-viewed`,
      { method: "POST", signal: controller.signal },
    )
      .then((response) => {
        if (response.ok) revalidateRef.current();
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        console.warn("Failed to mark active chat viewed:", error);
      });
    return () => controller.abort();
  }, [
    displayThreadId,
    markViewedEnabled,
    readOnly,
    workspaceId,
  ]);

  const openTabs =
    liveActiveChatGroup?.open_threads.map((thread) => ({
      threadId: thread.id,
      title: thread.title,
      model: thread.model,
      status: thread.status,
    })) ?? [];

  const closedTabs =
    liveActiveChatGroup?.closed_threads.map((thread) => ({
      threadId: thread.id,
      title: thread.title,
      model: thread.model,
      status: thread.status,
    })) ?? [];

  const selectTab = (targetThreadId: string) => {
    if (displayThreadId) {
      markThreadIdle(displayThreadId);
    }
    if (
      targetThreadId !== threadId &&
      chatDataByThreadId[targetThreadId]
    ) {
      setInstantThreadId(targetThreadId);
    }
    navigate(`/chat/${targetThreadId}`, { preventScrollReset: true });
  };

  const closeTab = async (targetThreadId: string) => {
    if (!activeChatGroup) return;
    await fetch(
      `/api/chat-groups/${encodeURIComponent(activeChatGroup.id)}/members/${encodeURIComponent(targetThreadId)}`,
      { method: "DELETE" },
    );
    const remaining = openTabs.filter((tab) => tab.threadId !== targetThreadId);
    if (targetThreadId === displayThreadId) {
      navigate(
        remaining[0]
          ? `/chat/${remaining[0].threadId}`
          : `/chat?group=${encodeURIComponent(activeChatGroup.id)}`,
      );
      return;
    }
    revalidator.revalidate();
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
            prefetchTabs
            moveGroups={moveChatGroups}
            onSelectTab={selectTab}
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
            allowedThreadModels={displayAllowedThreadModels}
            effectivePickerDefaultModel={effectivePickerDefaultModel}
            hasEffectivePickerDefault={hasEffectivePickerDefault}
            experimentalSettings={experimentalSettings}
            billingCreditStatus={billingCreditStatus}
            initialError={initialChatError ?? displayChatData.messagesError}
            initialPreviewTarget={displayChatData.previewTarget}
            initialPreviewTabs={displayChatData.previewTabs}
            initialActiveTabId={displayChatData.activeTabId}
            isNewThread={displayIsNewThread}
            hostname={hostname}
            orgSlug={orgSlug}
            connections={connections}
            isOrgAdmin={isOrgAdmin}
            recentModelScope={recentModelScope}
            isLoadingMessages={false}
            readOnly={readOnly}
          />
        </div>
      </div>
    </>
  );
}

export function HydrateFallback() {
  return <ChatLoadingSkeleton />;
}
