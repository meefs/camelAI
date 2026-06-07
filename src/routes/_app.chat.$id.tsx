import { useCallback, useEffect, useRef, useState } from "react";
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
import { createSessionCookieHeader } from "@/lib/cookies.server";
import { integrationRecordToIntegration } from "@/lib/auth-helpers";
import { getEnv } from "@/lib/cloudflare.server";
import { getOrgBillingOverview } from "@/lib/billing.server";
import {
  applyDevBillingCreditStatusOverride,
  buildBillingCreditStatus,
  getDevChatInitialError,
} from "@/lib/chat-credit-status";
import {
  DEFAULT_ORG_EXPERIMENTAL_SETTINGS,
  getDefaultLlmModel,
  getStoredCustomLlmProviderApi,
  getVisibleLlmModelOptions,
  isLlmModel,
} from "@/lib/llm-provider-config";
import { getOrg, getWorkerScript } from "@/lib/auth-do";
import { switchSessionOrg, switchSessionWorkspace } from "@/lib/auth-do";
import { getChatDebugFlags } from "@/lib/chat-debug-flags";
import { shouldRevalidateActiveChatRoute } from "@/lib/chat-route-revalidation";
import { parseChannelIndicatorKindsJson } from "@/lib/channel-kinds";
import * as authDO from "@/lib/auth-do.server";
import * as chatDO from "@/lib/chat-do.server";
import {
  ensureGroupForThread,
  getGroupForWorkspace,
  listGroupsForMove,
} from "@/lib/chat-groups.server";
import { readThreadMessages } from "@/lib/chat-history.server";
import Chat from "@/components/Chat";
import { ChatTabBar } from "@/components/chat-tab-bar";
import { ChatLoadingSkeleton } from "@/components/chat/chat-loading";
import { NoWorkspacesError } from "@/components/no-workspaces-error";
import { useChatGroups } from "@/hooks/use-chat-groups";
import { useChatThreadSnapshots } from "@/hooks/use-chat-thread-snapshots";
import type { TodoItem } from "@/components/floating-todo";
import type {
  ChatGroupView,
  Integration,
  LlmProvider,
  LlmModel,
  Message,
  PreviewTarget,
  Thread,
  WorkspaceWithAccess,
} from "@/types";
import {
  createRequestObservabilityContext,
  normalizePathForObservability,
  recordErrorEvent,
  recordObservabilityEvent,
} from "../../workers/main/src/observability";

export function meta({ data }: Route.MetaArgs) {
  const title = data?.threadTitle || "Chat";
  return [
    { title: `${title} - camelAI` },
    { name: "description", content: "AI Chat" },
  ];
}

export function shouldRevalidate(
  args: Parameters<typeof shouldRevalidateActiveChatRoute>[0],
) {
  return shouldRevalidateActiveChatRoute(args);
}

type ChatThreadRouteLoaderTraceContext = {
  requestId: string;
  sampleIndex: string;
  method: string;
  path: string;
  route: string;
};

type ChatThreadRouteLoaderTraceIds = {
  orgId?: string | null;
  workspaceId?: string | null;
  userId?: string | null;
  threadId?: string | null;
};

type ChatThreadRouteLoaderTraceExtra = {
  status?: string;
  statusCode?: number;
  count?: number;
  size?: number;
  model?: string | null;
};

function createChatThreadRouteLoaderTraceContext(
  request: Request,
): ChatThreadRouteLoaderTraceContext {
  const requestContext = createRequestObservabilityContext(request);
  const url = new URL(request.url);
  return {
    requestId: requestContext.requestId,
    sampleIndex: requestContext.colo,
    method: request.method,
    path: normalizePathForObservability(url.pathname),
    route: "routes/_app.chat.$id.loader",
  };
}

function recordChatThreadRouteLoaderStage(
  env: ReturnType<typeof getEnv>,
  trace: ChatThreadRouteLoaderTraceContext,
  ids: ChatThreadRouteLoaderTraceIds,
  operation: string,
  startedAt: number,
  extra: ChatThreadRouteLoaderTraceExtra = {},
): void {
  recordObservabilityEvent(env, {
    event: "chat_thread_route_loader_stage",
    severity: extra.status === "error" ? "error" : "info",
    component: "react_router_loader",
    operation,
    status: extra.status ?? "ok",
    route: trace.route,
    method: trace.method,
    path: trace.path,
    orgId: ids.orgId,
    workspaceId: ids.workspaceId,
    userId: ids.userId,
    threadId: ids.threadId,
    requestId: trace.requestId,
    model: extra.model,
    durationMs: Date.now() - startedAt,
    statusCode: extra.statusCode,
    count: extra.count,
    size: extra.size,
    sampleIndex: trace.sampleIndex,
  });
}

function recordChatThreadRouteLoaderError(
  env: ReturnType<typeof getEnv>,
  trace: ChatThreadRouteLoaderTraceContext,
  ids: ChatThreadRouteLoaderTraceIds,
  operation: string,
  startedAt: number,
  error: unknown,
  extra: ChatThreadRouteLoaderTraceExtra = {},
): void {
  recordErrorEvent(env, {
    event: "chat_thread_route_loader_stage",
    component: "react_router_loader",
    operation,
    status: extra.status ?? "exception",
    route: trace.route,
    method: trace.method,
    path: trace.path,
    orgId: ids.orgId,
    workspaceId: ids.workspaceId,
    userId: ids.userId,
    threadId: ids.threadId,
    requestId: trace.requestId,
    model: extra.model,
    durationMs: Date.now() - startedAt,
    statusCode: extra.statusCode,
    count: extra.count,
    size: extra.size,
    sampleIndex: trace.sampleIndex,
    error,
  });
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
        setModel(model: LlmModel, updatedAt?: number): Promise<void>;
        refreshRunnerConfig(): Promise<void>;
      };
      await chatThread.setModel(updated.model, updated.updated_at);
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
  todos: TodoItem[];
  previewTabs: PreviewTarget[];
  activeTabId: string | null;
}

type ChatDataValue = ChatData | Promise<ChatData>;

const EMPTY_CHAT_DATA: ChatData = {
  messages: [],
  messagesError: null,
  todos: [],
  previewTabs: [],
  activeTabId: null,
};

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as Promise<T>).then === "function";
}

function buildChatDataError(error: unknown): ChatData {
  console.error("Failed to load chat data:", error);
  return {
    ...EMPTY_CHAT_DATA,
    messagesError: "Failed to load chat messages",
  };
}

type DeferredChatDataState = {
  source: ChatDataValue;
  data: ChatData;
  loading: boolean;
};

function getInitialDeferredChatDataState(
  source: ChatDataValue,
): DeferredChatDataState {
  return {
    source,
    data: isPromiseLike(source) ? EMPTY_CHAT_DATA : source,
    loading: isPromiseLike(source),
  };
}

function useDeferredChatData(chatData: ChatDataValue): {
  chatData: ChatData;
  isLoading: boolean;
} {
  const [state, setState] = useState<DeferredChatDataState>(() =>
    getInitialDeferredChatDataState(chatData),
  );

  useEffect(() => {
    if (!isPromiseLike(chatData)) {
      setState({ source: chatData, data: chatData, loading: false });
      return;
    }

    let active = true;
    setState({ source: chatData, data: EMPTY_CHAT_DATA, loading: true });
    chatData.then(
      (resolvedChatData) => {
        if (active) {
          setState({
            source: chatData,
            data: resolvedChatData,
            loading: false,
          });
        }
      },
      (error) => {
        if (active) {
          setState({
            source: chatData,
            data: buildChatDataError(error),
            loading: false,
          });
        }
      },
    );

    return () => {
      active = false;
    };
  }, [chatData]);

  const currentState =
    state.source === chatData
      ? state
      : getInitialDeferredChatDataState(chatData);

  return {
    chatData: currentState.data,
    isLoading: currentState.loading,
  };
}

function getPreviewTabId(target: PreviewTarget): string {
  if (target.kind === "app") return `app:${target.scriptName}`;
  if (target.kind === "runtime_artifact") return `artifact:${target.artifact.id}`;
  return `file:${target.workspaceId}:${target.source}:${target.project ?? ""}:${target.path}`;
}

function buildFallbackActiveChatGroup(params: {
  groupId: string | null;
  orgId: string;
  workspaceId: string;
  thread: Thread;
}): ChatGroupView | null {
  if (!params.groupId) return null;
  const now = Date.now();
  const threadUpdatedAt = params.thread.updated_at || now;
  const threadSummary = {
    id: params.thread.id,
    title: params.thread.title || "New Chat",
    model: params.thread.model,
    updated_at: threadUpdatedAt,
    channel_kind: params.thread.channel_kind ?? null,
    channel_kinds: params.thread.channel_kinds ?? null,
    is_unread: false,
    status: "running" as const,
    membership: "open" as const,
    last_active_at: threadUpdatedAt,
    latest_user_message: params.thread.first_user_message ?? null,
    latest_user_message_at: params.thread.first_user_message
      ? threadUpdatedAt
      : null,
    running_activity_text: params.thread.first_user_message ?? null,
    running_activity_at: now,
    last_assistant_completed_at: null,
    last_assistant_summary: null,
    last_assistant_summary_status: null,
    running_started_at: now,
  };

  return {
    id: params.groupId,
    org_id: params.orgId,
    workspace_id: params.workspaceId,
    name: params.thread.title || "New Chat",
    last_active_thread_id: params.thread.id,
    created_at: params.thread.created_at || now,
    updated_at: threadUpdatedAt,
    open_thread_ids: [params.thread.id],
    closed_thread_ids: [],
    open_threads: [threadSummary],
    closed_threads: [],
    member_count: 1,
    status: "running",
  };
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

    const previewTabs = await Promise.all(
      previewStateRaw.tabs.map(applyAppVisibility),
    );
    const tabIds = new Set(previewTabs.map(getPreviewTabId));

    let activeTabId = previewStateRaw.activeTabId;
    if (!activeTabId || !tabIds.has(activeTabId)) {
      activeTabId = previewTabs[0] ? getPreviewTabId(previewTabs[0]) : null;
    }

    return {
      previewTabs,
      activeTabId,
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
    : Promise.resolve({ messages: [], messagesError: null });
  const todosPromise = chatDO
    .getTodoState(context, threadId)
    .catch(() => [] as unknown[]);

  const [previewData, messageData, todos] = await Promise.all([
    previewDataPromise,
    messagesPromise,
    todosPromise,
  ]);
  return {
    ...previewData,
    messages: messageData.messages,
    messagesError: messageData.messagesError,
    todos: Array.isArray(todos) ? (todos as TodoItem[]) : [],
  };
}

async function findAccessibleGroupWorkspace(
  context: Route.LoaderArgs["context"],
  userId: string,
  groupId: string,
  workspaces: WorkspaceWithAccess[],
): Promise<WorkspaceWithAccess | null> {
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const userStub = authEnv.USER.get(authEnv.USER.idFromName(userId));
  const group = await userStub.getChatGroup(groupId);
  if (!group) return null;
  return (
    workspaces.find(
      (workspace) =>
        workspace.id === group.workspace_id && workspace.org_id === group.org_id,
    ) ?? null
  );
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const loaderStartedAt = Date.now();
  const url = new URL(request.url);
  const isAdminReadonly = url.searchParams.get("adminReadonly") === "1";
  const isNewThread = url.searchParams.get("newThread") === "1";
  const useClientMessageCache = url.searchParams.get("chatCache") === "1";
  const hostname = request.headers.get("host")?.split(":")[0] || undefined;
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const traceContext = createChatThreadRouteLoaderTraceContext(request);
  const traceIds: ChatThreadRouteLoaderTraceIds = {
    threadId: params.id,
  };

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
        getDefaultLlmModel(),
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
      usedClientMessageCache: false,
      deferredInitialMessage: null,
    };
  }

  if (isNewThread) {
    const accessStartedAt = Date.now();
    const { orgId, workspaceId, userId } = await requireSessionWorkspaceAccess(
      request,
      context,
    );
    traceIds.orgId = orgId;
    traceIds.workspaceId = workspaceId;
    traceIds.userId = userId;
    recordChatThreadRouteLoaderStage(
      env,
      traceContext,
      traceIds,
      "new_thread_access_validated",
      accessStartedAt,
      { status: "new_thread" },
    );
    const groupId = url.searchParams.get("group")?.trim() || null;
    const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(orgId));
    const threadLoadStartedAt = Date.now();
    const [thread, orgInfo] = await Promise.all([
      orgStub.getThread(params.id),
      orgStub.getInfo().catch(() => null),
    ]);
    recordChatThreadRouteLoaderStage(
      env,
      traceContext,
      traceIds,
      "new_thread_record_loaded",
      threadLoadStartedAt,
      {
        status: thread ? "found" : "missing",
        model: thread?.model ?? null,
        size: thread?.first_user_message?.length ?? 0,
      },
    );

    if (!thread || thread.workspace_id !== workspaceId) {
      recordChatThreadRouteLoaderStage(
        env,
        traceContext,
        traceIds,
        "new_thread_redirect_missing",
        loaderStartedAt,
        { status: "redirect", statusCode: 302 },
      );
      throw redirect("/chat");
    }
    if ((thread.user_message_count ?? 0) > 0) {
      recordChatThreadRouteLoaderStage(
        env,
        traceContext,
        traceIds,
        "new_thread_redirect_started",
        loaderStartedAt,
        {
          status: "redirect",
          statusCode: 302,
          count: thread.user_message_count ?? 0,
          model: thread.model,
        },
      );
      throw redirect(`/chat/${params.id}`);
    }
    const deferredInitialMessage =
      (thread.user_message_count ?? 0) === 0
        ? (thread.first_user_message ?? null)
        : null;
    const chatDataStartedAt = Date.now();
    const chatData = deferredInitialMessage?.trim()
      ? (() => {
          recordChatThreadRouteLoaderStage(
            env,
            traceContext,
            traceIds,
            "new_thread_chat_data_resolved",
            chatDataStartedAt,
            {
              status: "deferred_initial_message",
              model: thread.model,
              size: deferredInitialMessage.length,
            },
          );
          return EMPTY_CHAT_DATA;
        })()
      : await buildChatData(context, authEnv, params.id, {
          orgId,
          workspaceId,
          loadMessages: true,
        }).catch((error) => {
          console.error("Failed to load new thread chat data:", error);
          recordChatThreadRouteLoaderError(
            env,
            traceContext,
            traceIds,
            "new_thread_chat_data_resolved",
            chatDataStartedAt,
            error,
            { status: "fallback_empty", model: thread.model },
          );
          return EMPTY_CHAT_DATA;
        });
    if (!deferredInitialMessage?.trim()) {
      recordChatThreadRouteLoaderStage(
        env,
        traceContext,
        traceIds,
        "new_thread_chat_data_resolved",
        chatDataStartedAt,
        {
          status: "loaded",
          model: thread.model,
          count: chatData.messages.length,
        },
      );
    }
    const activeGroupStartedAt = Date.now();
    const fallbackThread: Thread = {
      ...thread,
      channel_kinds: parseChannelIndicatorKindsJson(thread.channel_kinds),
    };
    const activeChatGroup = buildFallbackActiveChatGroup({
      groupId,
      orgId,
      workspaceId,
      thread: fallbackThread,
    });
    recordChatThreadRouteLoaderStage(
      env,
      traceContext,
      traceIds,
      "new_thread_group_resolved",
      activeGroupStartedAt,
      {
        status: activeChatGroup ? "local_fallback" : "missing",
        model: thread.model,
      },
    );
    recordChatThreadRouteLoaderStage(
      env,
      traceContext,
      traceIds,
      "new_thread_response_ready",
      loaderStartedAt,
      {
        status: "ok",
        statusCode: 200,
        model: thread.model,
        size: deferredInitialMessage?.length ?? 0,
      },
    );

    return {
      threadId: params.id,
      workspaceId,
      chatData,
      threadTitle: thread.title ?? null,
      threadModel: thread.model,
      llmProvider: null as LlmProvider | null,
      allowedThreadModels: [thread.model],
      effectivePickerDefaultModel: null,
      hasEffectivePickerDefault: false,
      experimentalSettings: DEFAULT_ORG_EXPERIMENTAL_SETTINGS,
      billingCreditStatus: null,
      initialChatError: getDevChatInitialError(url.searchParams),
      isNewThread: true,
      hostname,
      orgSlug: orgInfo?.slug,
      connections: [] as Integration[],
      isOrgAdmin: false,
      recentModelScope: { orgId, workspaceId },
      readOnly: false,
      activeChatGroup,
      activeGroupId: groupId,
      moveChatGroups: [],
      usedClientMessageCache: false,
      deferredInitialMessage,
    };
  }

  const authContext = await requireAuthContext(request, context);

  if (!authContext.currentWorkspace?.id) {
    return {
      threadId: params.id,
      workspaceId: null,
      chatData: EMPTY_CHAT_DATA,
      threadTitle: null,
      threadModel: getDefaultLlmModel(),
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
      usedClientMessageCache: false,
      deferredInitialMessage: null,
    };
  }

  const workspaceId = authContext.currentWorkspace.id;
  const orgId = authContext.currentOrg.id;
  const actingUserId =
    authContext.user?.id ?? authContext.session?.user_id ?? null;
  const requestedGroupId = url.searchParams.get("group")?.trim() || null;

  if (requestedGroupId && actingUserId) {
    const groupWorkspace = await findAccessibleGroupWorkspace(
      context,
      actingUserId,
      requestedGroupId,
      authContext.allWorkspaces,
    ).catch((error) => {
      console.error("Failed to resolve chat group workspace:", error);
      return null;
    });
    if (groupWorkspace && groupWorkspace.id !== workspaceId) {
      const signedToken =
        groupWorkspace.org_id !== authContext.session.org_id
          ? await switchSessionOrg(
              authEnv,
              authContext.session,
              groupWorkspace.org_id,
              groupWorkspace.id,
            )
          : await switchSessionWorkspace(
              authEnv,
              authContext.session,
              groupWorkspace.id,
            );
      throw redirect(`${url.pathname}${url.search}`, {
        headers: {
          "Set-Cookie": createSessionCookieHeader(signedToken, request),
        },
      });
    }
  }

  const orgStub = authEnv.ORG
    ? authEnv.ORG.get(authEnv.ORG.idFromName(orgId))
    : null;
  const orgMetadataPromise = orgStub
    ? Promise.all([
        orgStub
          .getExperimentalSettings()
          .catch(() => DEFAULT_ORG_EXPERIMENTAL_SETTINGS),
        orgStub.getLlmProviderConfig().catch(() => null),
        getOrgBillingOverview(env, authContext.currentOrg).catch((error) => {
          console.warn("Failed to load billing overview for chat:", error);
          return null;
        }),
      ])
    : Promise.resolve([DEFAULT_ORG_EXPERIMENTAL_SETTINGS, null, null] as const);
  const threadPromise = chatDO.getThread(context, params.id, workspaceId);
  const pickerStatePromise = chatDO
    .getWorkspaceModelPickerState(context, workspaceId)
    .catch((error) => {
      console.error("Failed to load model picker state:", error);
      return null;
    });
  const connectionsPromise = env.WORKSPACE.get(
    env.WORKSPACE.idFromName(workspaceId),
  )
    .getIntegrations()
    .then((records) => records.map(integrationRecordToIntegration))
    .catch((error) => {
      console.error("Failed to load workspace connections:", error);
      return [] as Integration[];
    });
  const [
    [experimentalSettings, llmProviderConfig, billingOverview],
    thread,
    pickerState,
  ] = await Promise.all([
    orgMetadataPromise,
    threadPromise,
    pickerStatePromise,
  ]);

  // Even for newly created threads, load the persisted thread record so the UI
  // reflects the actual saved model instead of the Sonnet default.
  if (!isNewThread && !thread) {
    throw redirect("/chat");
  }
  const customApi = getStoredCustomLlmProviderApi(llmProviderConfig);
  const fallbackThreadModel =
    thread?.model ??
    getDefaultLlmModel(llmProviderConfig?.provider, { customApi });
  const fallbackAllowedThreadModels = getVisibleLlmModelOptions(
    experimentalSettings,
    fallbackThreadModel,
    {
      orgProvider: llmProviderConfig?.provider,
      customApi,
    },
  ).map((option) => option.value);

  const chatDataStartedAt = Date.now();
  const chatData: ChatDataValue = thread
    ? buildChatData(context, authEnv, params.id, {
        orgId,
        workspaceId,
        loadMessages: !useClientMessageCache,
      })
        .then((resolvedChatData) => {
          recordChatThreadRouteLoaderStage(
            env,
            traceContext,
            traceIds,
            "chat_data_resolved",
            chatDataStartedAt,
            {
              status: useClientMessageCache
                ? "loaded_without_messages"
                : "loaded",
              model: thread.model,
              count: resolvedChatData.messages.length,
              size: resolvedChatData.previewTabs.length,
            },
          );
          return resolvedChatData;
        })
        .catch((error) => {
          recordChatThreadRouteLoaderError(
            env,
            traceContext,
            traceIds,
            "chat_data_resolved",
            chatDataStartedAt,
            error,
            { status: "fallback_empty", model: thread.model },
          );
          return buildChatDataError(error);
        })
    : EMPTY_CHAT_DATA;
  const activeChatGroupPromise = thread && actingUserId
    ? Promise.all([
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
    : Promise.resolve([null, []] as const);
  const [activeChatGroup, moveChatGroups] = await activeChatGroupPromise;
  const resolvedThreadModel =
    thread?.model ??
    pickerState?.defaultModel ??
    fallbackThreadModel;
  recordChatThreadRouteLoaderStage(
    env,
    traceContext,
    traceIds,
    "response_ready",
    loaderStartedAt,
    {
      status: thread ? "chat_data_deferred" : "empty",
      statusCode: 200,
      model: resolvedThreadModel,
    },
  );

  return {
    threadId: params.id,
    workspaceId,
    chatData,
    threadTitle: thread?.title ?? null,
    threadModel: resolvedThreadModel,
    llmProvider:
      pickerState?.llmProvider ??
      ((llmProviderConfig?.provider ?? null) as
        | import("@/types").LlmProvider
        | null),
    customApi: pickerState?.customApi ?? customApi,
    allowedThreadModels:
      pickerState?.allowedThreadModels ?? fallbackAllowedThreadModels,
    effectivePickerDefaultModel:
      pickerState?.effectivePickerDefaultModel ?? null,
    hasEffectivePickerDefault:
      pickerState?.hasEffectivePickerDefault ?? false,
    experimentalSettings:
      pickerState?.experimentalSettings ?? experimentalSettings,
    billingCreditStatus: applyDevBillingCreditStatusOverride(
      buildBillingCreditStatus(
        billingOverview,
        llmProviderConfig?.provider,
        resolvedThreadModel,
      ),
      url.searchParams,
    ),
    initialChatError: getDevChatInitialError(url.searchParams),
    isNewThread,
    hostname,
    orgSlug: authContext.currentOrg.slug,
    connections: connectionsPromise,
    isOrgAdmin: authContext.orgs.some(
      (org) =>
        org.org_id === orgId && (org.role === "owner" || org.role === "admin"),
    ),
    recentModelScope: { orgId, workspaceId },
    readOnly: false,
    activeChatGroup,
    moveChatGroups,
    usedClientMessageCache: useClientMessageCache,
    deferredInitialMessage:
      isNewThread && thread && (thread.user_message_count ?? 0) === 0
        ? (thread.first_user_message ?? null)
        : null,
  };
}

export default function ChatPage() {
  const {
    threadId,
    workspaceId,
    chatData,
    threadModel,
    llmProvider,
    customApi,
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
    activeGroupId,
    moveChatGroups = [],
    usedClientMessageCache = false,
    deferredInitialMessage,
  } = useLoaderData<typeof loader>();
  const {
    chatData: resolvedChatData,
    isLoading: isLoadingChatData,
  } = useDeferredChatData(chatData);
  const navigate = useNavigate();
  const location = useLocation();
  const revalidator = useRevalidator();
  const { groups: liveChatGroups, markThreadIdle } = useChatGroups();
  const { getSnapshot, setSnapshot } = useChatThreadSnapshots();
  const [clientActiveThreadId, setClientActiveThreadId] = useState(threadId);
  const chatDebugFlags = getChatDebugFlags();
  const markViewedEnabled = chatDebugFlags.markViewed;
  const markThreadIdleRef = useRef(markThreadIdle);
  const resolvedActiveGroupId = activeGroupId ?? activeChatGroup?.id ?? null;
  const liveActiveChatGroup =
    resolvedActiveGroupId && !readOnly
      ? liveChatGroups.find((group) => group.id === resolvedActiveGroupId) ??
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
        routeMessageCount: resolvedChatData.messages.length,
        routeMessageIds: resolvedChatData.messages.map((message) => ({
          id: message.id,
          clientMessageId: message.clientMessageId,
          role: message.role,
          created_at: message.created_at,
        })),
        messagesError: resolvedChatData.messagesError,
        isLoadingChatData,
        activeChatGroupId: activeChatGroup?.id ?? null,
      });
    }
  }, [
    activeChatGroup?.id,
    chatDebugFlags.historyLogs,
    isLoadingChatData,
    isNewThread,
    location.pathname,
    location.search,
    resolvedChatData,
    threadId,
  ]);

  useEffect(() => {
    setClientActiveThreadId(threadId);
  }, [threadId]);

  const displayThreadId = clientActiveThreadId;
  const activeThreadSummary =
    liveActiveChatGroup?.open_threads.find(
      (thread) => thread.id === displayThreadId,
    ) ??
    activeChatGroup?.open_threads.find(
      (thread) => thread.id === displayThreadId,
    ) ??
    null;
  const isDisplayingLoaderThread = displayThreadId === threadId;
  const displayThreadModel = isDisplayingLoaderThread
    ? threadModel
    : (activeThreadSummary?.model ?? threadModel);
  const displayAllowedThreadModels =
    displayThreadModel
      ? getVisibleLlmModelOptions(
          experimentalSettings,
          displayThreadModel,
          {
            orgProvider: llmProvider,
            customApi,
          },
        ).map((option) => option.value)
      : allowedThreadModels;
  const cachedSnapshot = displayThreadId ? getSnapshot(displayThreadId) : null;
  const shouldUseCachedSnapshot = Boolean(
    cachedSnapshot &&
      (!isDisplayingLoaderThread || usedClientMessageCache || isLoadingChatData),
  );
  const displayChatData = shouldUseCachedSnapshot
    ? {
        ...resolvedChatData,
        messages: cachedSnapshot?.messages ?? resolvedChatData.messages,
        todos: cachedSnapshot?.todos ?? resolvedChatData.todos,
      }
    : resolvedChatData;
  const isLoadingDisplayMessages =
    isLoadingChatData && !shouldUseCachedSnapshot;
  const displayIsNewThread = isNewThread;

  useEffect(() => {
    if (!usedClientMessageCache || !displayThreadId) return;
    const nextSearch = new URLSearchParams(location.search);
    nextSearch.delete("chatCache");
    const nextUrl = `/chat/${encodeURIComponent(displayThreadId)}${
      nextSearch.toString() ? `?${nextSearch.toString()}` : ""
    }`;
    navigate(nextUrl, { replace: true, preventScrollReset: true });
  }, [displayThreadId, location.search, navigate, usedClientMessageCache]);

  useEffect(() => {
    markThreadIdleRef.current = markThreadIdle;
  }, [markThreadIdle]);

  useEffect(() => {
    if (!markViewedEnabled || readOnly || !workspaceId || !displayThreadId) return;

    markThreadIdleRef.current(displayThreadId);
    const controller = new AbortController();
    void fetch(
      `/api/threads/${encodeURIComponent(displayThreadId)}/mark-viewed`,
      { method: "POST", signal: controller.signal },
    )
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
  const availableMoveGroups =
    moveChatGroups.length > 0 ? moveChatGroups : liveChatGroups;

  const selectTab = (targetThreadId: string) => {
    const snapshot = getSnapshot(targetThreadId);
    if (displayThreadId) {
      markThreadIdle(displayThreadId);
    }
    if (snapshot) {
      setClientActiveThreadId(targetThreadId);
    }
    const params = new URLSearchParams();
    const groupId = liveActiveChatGroup?.id ?? resolvedActiveGroupId;
    if (groupId) {
      params.set("group", groupId);
    }
    if (snapshot) {
      params.set("chatCache", "1");
    }
    navigate(
      `/chat/${targetThreadId}${params.toString() ? `?${params.toString()}` : ""}`,
      { preventScrollReset: true },
    );
  };

  const closeTab = async (targetThreadId: string) => {
    const groupId = liveActiveChatGroup?.id ?? resolvedActiveGroupId;
    if (!groupId) return;
    await fetch(
      `/api/chat-groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(targetThreadId)}`,
      { method: "DELETE" },
    );
    const remaining = openTabs.filter((tab) => tab.threadId !== targetThreadId);
    if (targetThreadId === displayThreadId) {
      navigate(
        remaining[0]
          ? `/chat/${remaining[0].threadId}`
          : `/chat?group=${encodeURIComponent(groupId)}`,
      );
      return;
    }
    revalidator.revalidate();
  };

  const reopenTab = async (targetThreadId: string) => {
    const groupId = liveActiveChatGroup?.id ?? resolvedActiveGroupId;
    if (!groupId) return;
    await fetch(
      `/api/chat-groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(targetThreadId)}/reopen`,
      { method: "POST" },
    );
    revalidator.revalidate();
    navigate(`/chat/${targetThreadId}`);
  };

  const renameTab = async (targetThreadId: string, name: string) => {
    const response = await fetch(
      `/api/threads/${encodeURIComponent(targetThreadId)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: name }),
      },
    );
    if (response.ok) {
      const body = (await response.json().catch(() => null)) as
        | { thread?: { updated_at?: unknown } }
        | null;
      const updatedAt =
        typeof body?.thread?.updated_at === "number" &&
        Number.isFinite(body.thread.updated_at)
          ? body.thread.updated_at
          : Date.now();
      if (targetThreadId === displayThreadId) {
        document.title = `${name || "Chat"} - camelAI`;
      }
      window.dispatchEvent(
        new CustomEvent("camelai:thread-status", {
          detail: { threadId: targetThreadId, title: name, updatedAt },
        }),
      );
    }
    revalidator.revalidate();
  };

  const renameGroup = async (name: string) => {
    const groupId = liveActiveChatGroup?.id ?? resolvedActiveGroupId;
    if (!groupId) return;
    await fetch(`/api/chat-groups/${encodeURIComponent(groupId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    revalidator.revalidate();
  };

  const reorderTabs = async (orderedThreadIds: string[]) => {
    const groupId = liveActiveChatGroup?.id ?? resolvedActiveGroupId;
    if (!groupId) return;
    await fetch(
      `/api/chat-groups/${encodeURIComponent(groupId)}/reorder-tabs`,
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

  const handleSnapshotChange = useCallback(
    (snapshot: { messages: Message[]; todos: TodoItem[] }) => {
      if (!displayThreadId || isLoadingDisplayMessages) return;
      setSnapshot(displayThreadId, snapshot);
    },
    [displayThreadId, isLoadingDisplayMessages, setSnapshot],
  );

  return (
    <>
      <div className="flex h-full min-h-0 flex-col">
        {!readOnly && liveActiveChatGroup ? (
          <ChatTabBar
            groupId={liveActiveChatGroup.id}
            groupName={liveActiveChatGroup.name}
            openTabs={openTabs}
            closedTabs={closedTabs}
            activeThreadId={displayThreadId}
            moveGroups={availableMoveGroups}
            onSelectTab={selectTab}
            onCloseTab={closeTab}
            onRenameTab={renameTab}
            onReorderTabs={reorderTabs}
            onNewTab={() =>
              navigate(`/chat?group=${encodeURIComponent(liveActiveChatGroup.id)}`)
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
            chatGroupId={liveActiveChatGroup?.id ?? resolvedActiveGroupId}
            initialMessages={displayChatData.messages}
            initialTodos={displayChatData.todos}
            threadModel={displayThreadModel}
            llmProvider={llmProvider}
            allowedThreadModels={displayAllowedThreadModels}
            effectivePickerDefaultModel={effectivePickerDefaultModel}
            hasEffectivePickerDefault={hasEffectivePickerDefault}
            experimentalSettings={experimentalSettings}
            billingCreditStatus={billingCreditStatus}
            initialError={initialChatError ?? displayChatData.messagesError}
            deferredInitialMessage={deferredInitialMessage}
            initialPreviewTabs={displayChatData.previewTabs}
            initialActiveTabId={displayChatData.activeTabId}
            isNewThread={displayIsNewThread}
            hostname={hostname}
            orgSlug={orgSlug}
            connections={connections}
            onSnapshotChange={handleSnapshotChange}
            isOrgAdmin={isOrgAdmin}
            recentModelScope={recentModelScope}
            isLoadingMessages={isLoadingDisplayMessages}
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
