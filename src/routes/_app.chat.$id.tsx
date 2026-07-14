import { useCallback, useEffect, useRef, useState } from "react";
import {
  redirect,
  useLoaderData,
  useLocation,
  useNavigate,
  useRevalidator,
} from "react-router";
import type { Route } from "./+types/_app.chat.$id";
import type { UIMessage } from "ai";
import {
  requireAuthContext,
  requireSuperuser,
  requireSessionWorkspaceAccess,
  getAuthEnv,
} from "@/lib/auth.server";
import { createSessionCookieHeader } from "@/lib/cookies.server";
import type { MentionableProject } from "@/lib/mentions";
import { resolveDisplayChatData } from "@/lib/chat-thread-display";
import { loadWorkspaceMentionSources } from "@/lib/mention-sources.server";
import { getEnv } from "@/lib/cloudflare.server";
import { getAppUrlContext } from "@/lib/app-url.server";
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
  getStoredCustomLlmProviderModelId,
  getStoredBedrockAwsRegion,
  getVisibleLlmModelOptions,
  isLlmModel,
} from "@/lib/llm-provider-config";
import { getEffectiveLlmProviderConfig } from "@/lib/selfhost-ai-provider";
import { isSelfhostRuntime } from "@/lib/selfhost-runtime";
import { getOrg, getWorkerScript } from "@/lib/auth-do";
import { switchSessionOrg, switchSessionWorkspace } from "@/lib/auth-do";
import {
  isProxyAuthSource,
  validateSessionIdentityMapsToOrg,
} from "../../workers/main/src/helpers/proxy-auth-providers";
import type { ProxyAuthValidationEnv } from "../../workers/main/src/helpers/proxy-auth-core";
import { getChatDebugFlags } from "@/lib/chat-debug-flags";
import { shouldRevalidateActiveChatRoute } from "@/lib/chat-route-revalidation";
import {
  saveChatGroupRename,
  type ChatGroupRenameInput,
} from "@/lib/chat-group-rename.client";
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
import { useChatThreadSnapshots } from "@/hooks/use-chat-thread-snapshots";
import type { TodoItem } from "@/components/floating-todo";
import type {
  Integration,
  LlmProvider,
  LlmModel,
  Message,
  PreviewTarget,
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

  const { orgId, workspaceId } = await requireSessionWorkspaceAccess(
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
      {
        orgId,
      },
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
        { orgId },
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
  // ai-chat-owned durable render history (commit 4). The live-user loader branch
  // fetches this via getUiMessages(); useAgentChat mounts it as its initial
  // messages. The admin-readonly branch leaves it empty (it renders pi_core).
  initialUiMessages: UIMessage[];
  todos: TodoItem[];
  previewTabs: PreviewTarget[];
  activeTabId: string | null;
}

type ChatDataValue = ChatData | Promise<ChatData>;

const EMPTY_CHAT_DATA: ChatData = {
  messages: [],
  messagesError: null,
  initialUiMessages: [],
  todos: [],
  previewTabs: [],
  activeTabId: null,
};

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as Promise<T>).then === "function";
}

// The first user message of a not-yet-started thread, rendered from the thread
// record so the page paints instantly without booting the ChatThreadDO. The real
// turn (and its persisted, attributed copy) streams/loads in afterward; the
// reconciliation effect in Chat swaps this out once the transcript arrives.
function pendingFirstUserMessage(threadId: string, content: string): Message {
  return {
    id: `pending-first:${threadId}`,
    thread_id: threadId,
    role: "user",
    content,
    created_at: Date.now(),
  };
}

function buildChatDataError(error: unknown): ChatData {
  console.error("Failed to load chat data:", error);
  return {
    ...EMPTY_CHAT_DATA,
    initialUiMessages: [],
    messagesError: "Failed to load chat messages",
  };
}

type DeferredChatDataState = {
  source: ChatDataValue;
  data: ChatData;
  loading: boolean;
  dataKey: string;
};

function getInitialDeferredChatDataState(
  source: ChatDataValue,
  dataKey: string,
): DeferredChatDataState {
  return {
    source,
    data: isPromiseLike(source) ? EMPTY_CHAT_DATA : source,
    loading: isPromiseLike(source),
    dataKey,
  };
}

function getDeferredChatDataLoadingState(
  previousState: DeferredChatDataState,
  source: Promise<ChatData>,
  dataKey: string,
): DeferredChatDataState {
  return {
    source,
    data: previousState.dataKey === dataKey ? previousState.data : EMPTY_CHAT_DATA,
    loading: true,
    dataKey,
  };
}

function useDeferredChatData(chatData: ChatDataValue, dataKey: string): {
  chatData: ChatData;
  isLoading: boolean;
} {
  const [state, setState] = useState<DeferredChatDataState>(() =>
    getInitialDeferredChatDataState(chatData, dataKey),
  );

  useEffect(() => {
    if (!isPromiseLike(chatData)) {
      setState({ source: chatData, data: chatData, loading: false, dataKey });
      return;
    }

    let active = true;
    setState((previousState) =>
      getDeferredChatDataLoadingState(previousState, chatData, dataKey),
    );
    chatData.then(
      (resolvedChatData) => {
        if (active) {
          setState({
            source: chatData,
            data: resolvedChatData,
            loading: false,
            dataKey,
          });
        }
      },
      (error) => {
        if (active) {
          setState({
            source: chatData,
            data: buildChatDataError(error),
            loading: false,
            dataKey,
          });
        }
      },
    );

    return () => {
      active = false;
    };
  }, [chatData, dataKey]);

  const currentState =
    state.source === chatData && state.dataKey === dataKey
      ? state
      : isPromiseLike(chatData) && state.dataKey === dataKey
        ? getDeferredChatDataLoadingState(state, chatData, dataKey)
        : getInitialDeferredChatDataState(chatData, dataKey);

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

async function buildChatData(
  context: Route.LoaderArgs["context"],
  authEnv: ReturnType<typeof getAuthEnv>,
  threadId: string,
  options: {
    orgId: string;
    workspaceId: string;
    // Admin-readonly branch only: fetch the legacy pi_core transcript
    // (readThreadMessages) it renders directly. The live branch leaves it off —
    // its transcript is the ai-chat render history, so a normal chat load makes
    // exactly ONE transcript RPC (Chat.tsx derives any fallback Message view
    // from initialUiMessages).
    loadLegacyMessages: boolean;
    // Live-user branch only: fetch the ai-chat render history (getUiMessages)
    // that useAgentChat mounts. Admin-readonly leaves it off (renders pi_core).
    loadUiMessages: boolean;
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

  const messagesPromise = options.loadLegacyMessages
    ? readThreadMessages(context, {
        workspaceId: options.workspaceId,
        orgId: options.orgId,
        threadId,
        skipBanCheck: options.skipBanCheck,
      })
        .then((messages) => ({ messages, messagesError: null }))
    : Promise.resolve({ messages: [], messagesError: null });
  // The live branch has no legacy transcript to fall back on, so a failed
  // render-history read must surface as messagesError instead of silently
  // rendering an empty thread.
  const uiMessagesPromise = options.loadUiMessages
    ? chatDO
        .getUiMessages(context, threadId)
        .then((uiMessages) => ({ uiMessages, uiMessagesError: null }))
        .catch((error) => {
          console.error("Failed to load ai-chat render history:", error);
          return {
            uiMessages: [] as UIMessage[],
            uiMessagesError: "Failed to load chat messages",
          };
        })
    : Promise.resolve({ uiMessages: [] as UIMessage[], uiMessagesError: null });
  const todosPromise = chatDO
    .getTodoState(context, threadId)
    .catch(() => [] as unknown[]);

  const [previewData, messageData, uiMessageData, todos] = await Promise.all([
    previewDataPromise,
    messagesPromise,
    uiMessagesPromise,
    todosPromise,
  ]);
  return {
    ...previewData,
    messages: messageData.messages,
    messagesError: messageData.messagesError ?? uiMessageData.uiMessagesError,
    initialUiMessages: uiMessageData.uiMessages,
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
  const useClientMessageCache = url.searchParams.get("chatCache") === "1";
  const env = getEnv(context);
  const hostname = getAppUrlContext(env, request);
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
      {
        orgId: threadContext.org_id,
      },
    );
    const org = await getOrg(authEnv, threadContext.org_id);

    return {
      threadId: params.id,
      workspaceId: threadContext.workspace_id,
      chatData: await buildChatData(context, authEnv, params.id, {
        orgId: threadContext.org_id,
        workspaceId: threadContext.workspace_id,
        loadLegacyMessages: true,
        loadUiMessages: false,
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
      hostname,
      orgSlug: org?.slug,
      connections: [] as Integration[],
      projects: [] as MentionableProject[],
      isOrgAdmin: false,
      recentModelScope: null,
      readOnly: true,
      activeChatGroup: null,
      activeGroupId: null,
      moveChatGroups: [],
      usedClientMessageCache: false,
      pendingFirstTurn: false,
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
      hostname: undefined,
      connections: [] as Integration[],
      projects: [] as MentionableProject[],
      isOrgAdmin: false,
      recentModelScope: null,
      readOnly: false,
      activeGroupId: null,
      usedClientMessageCache: false,
      pendingFirstTurn: false,
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
      let canSwitch = true;
      if (
        groupWorkspace.org_id !== authContext.session.org_id &&
        isProxyAuthSource(authContext.session.auth_source)
      ) {
        // A proxy-backed cookie (Cloudflare Access, Pomerium) is only accepted
        // for orgs the live identity maps to; switching to an unmapped org
        // would mint a cookie that every subsequent request rejects. Stay in
        // the current workspace instead.
        const proxyValidation = await validateSessionIdentityMapsToOrg(
          request,
          env as unknown as ProxyAuthValidationEnv,
          authContext.session,
          groupWorkspace.org_id,
        );
        if (proxyValidation !== "valid") {
          canSwitch = false;
          console.warn(
            "[proxy-auth] skipped chat group org switch for unmapped org",
            { orgId: groupWorkspace.org_id, validation: proxyValidation },
          );
        }
      }
      if (canSwitch) {
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
  }

  const selfhostRuntime = isSelfhostRuntime(env);
  const billingOverviewPromise = selfhostRuntime
    ? Promise.resolve(null)
    : getOrgBillingOverview(env, authContext.currentOrg).catch((error) => {
        console.warn("Failed to load billing overview for chat:", error);
        return null;
      });
  const threadPromise = chatDO.getThread(context, params.id, workspaceId, {
    orgId: authContext.currentOrg.id,
  });
  const pickerStatePromise = chatDO
    .getWorkspaceModelPickerState(context, workspaceId, {
      orgId: authContext.currentOrg.id,
      llmProviderConfig: authContext.currentOrgLlmProviderConfig,
      experimentalSettings: authContext.currentOrgExperimentalSettings,
    })
    .catch((error) => {
      console.error("Failed to load model picker state:", error);
      return null;
    });
  const mentionSourcesPromise = loadWorkspaceMentionSources(env, workspaceId);
  const connectionsPromise: Promise<Integration[]> = mentionSourcesPromise.then(
    ({ connections }) => connections,
  );
  const projectsPromise: Promise<MentionableProject[]> =
    mentionSourcesPromise.then(({ projects }) => projects);
  const [
    billingOverview,
    thread,
    pickerState,
  ] = await Promise.all([
    billingOverviewPromise,
    threadPromise,
    pickerStatePromise,
  ]);

  // Even for newly created threads, load the persisted thread record so the UI
  // reflects the actual saved model instead of the Sonnet default.
  if (!thread) {
    throw redirect("/chat");
  }
  const experimentalSettings = authContext.currentOrgExperimentalSettings;
  const effectiveLlmProviderConfig = getEffectiveLlmProviderConfig(
    env,
    authContext.currentOrgLlmProviderConfig,
  );
  const customApi = getStoredCustomLlmProviderApi(effectiveLlmProviderConfig);
  const customModelId = getStoredCustomLlmProviderModelId(effectiveLlmProviderConfig);
  const awsRegion = getStoredBedrockAwsRegion(effectiveLlmProviderConfig);
  const fallbackThreadModel =
    thread?.model ??
    getDefaultLlmModel(effectiveLlmProviderConfig?.provider, {
      customApi,
      customModelId,
    });
  const fallbackAllowedThreadModels = getVisibleLlmModelOptions(
    experimentalSettings,
    fallbackThreadModel,
    {
      orgProvider: effectiveLlmProviderConfig?.provider,
      customApi,
      customModelId,
      awsRegion,
    },
  ).map((option) => option.value);

  // A freshly-started new chat: render the first message straight from the (warm)
  // thread record and SKIP buildChatData, whose transcript/preview/todo reads
  // would each boot the cold ChatThreadDO (~2s). The turn streams in over the WS
  // once the DO is warm; once it records the turn (user_message_count > 0) later
  // loads read the real transcript. Gated on the new-chat action's ?newThread=1
  // signal so threads created with a stored first message but no started run
  // (e.g. the workspaces chat-threads API) are NOT treated as pending.
  const pendingFirstTurn =
    url.searchParams.get("newThread") === "1" &&
    (thread.user_message_count ?? 0) === 0 &&
    Boolean(thread.first_user_message?.trim());
  const chatDataStartedAt = Date.now();
  const chatData: ChatDataValue = pendingFirstTurn
    ? {
        ...EMPTY_CHAT_DATA,
        messages: [
          pendingFirstUserMessage(params.id, thread.first_user_message ?? ""),
        ],
      }
    : thread
    ? buildChatData(context, authEnv, params.id, {
        orgId,
        workspaceId,
        loadLegacyMessages: false,
        loadUiMessages: !useClientMessageCache,
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
              count: resolvedChatData.initialUiMessages.length,
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
      ((effectiveLlmProviderConfig?.provider ?? null) as
        | import("@/types").LlmProvider
        | null),
    customApi: pickerState?.customApi ?? customApi,
    customModelId: pickerState?.customModelId ?? customModelId,
    awsRegion: pickerState?.awsRegion ?? awsRegion,
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
        effectiveLlmProviderConfig?.provider,
        resolvedThreadModel,
      ),
      url.searchParams,
    ),
    initialChatError: getDevChatInitialError(url.searchParams),
    hostname,
    orgSlug: authContext.currentOrg.slug,
    connections: connectionsPromise,
    projects: projectsPromise,
    isOrgAdmin: authContext.orgs.some(
      (org) =>
        org.org_id === orgId && (org.role === "owner" || org.role === "admin"),
    ),
    recentModelScope: { orgId, workspaceId },
    readOnly: false,
    activeChatGroup,
    activeGroupId: url.searchParams.get("group")?.trim() || null,
    moveChatGroups,
    usedClientMessageCache: useClientMessageCache,
    pendingFirstTurn,
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
    customModelId,
    awsRegion,
    allowedThreadModels,
    effectivePickerDefaultModel,
    hasEffectivePickerDefault,
    experimentalSettings,
    billingCreditStatus,
    initialChatError,
    hostname,
    orgSlug,
    connections,
    projects,
    isOrgAdmin,
    recentModelScope,
    readOnly,
    activeChatGroup,
    activeGroupId,
    moveChatGroups = [],
    usedClientMessageCache = false,
    pendingFirstTurn = false,
  } = useLoaderData<typeof loader>();
  const {
    chatData: resolvedChatData,
    isLoading: isLoadingChatData,
  } = useDeferredChatData(chatData, threadId);
  const navigate = useNavigate();
  const location = useLocation();
  const locationPathname = location.pathname;
  const locationSearch = location.search;
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
        location: `${locationPathname}${locationSearch}`,
        threadId,
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
    locationPathname,
    locationSearch,
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
            customModelId,
            awsRegion,
          },
        ).map((option) => option.value)
      : allowedThreadModels;
  const cachedSnapshot = displayThreadId ? getSnapshot(displayThreadId) : null;
  const shouldUseCachedSnapshot = Boolean(
    cachedSnapshot &&
      (!isDisplayingLoaderThread || usedClientMessageCache || isLoadingChatData),
  );
  const displayChatData = resolveDisplayChatData(
    resolvedChatData,
    cachedSnapshot,
    shouldUseCachedSnapshot,
  );
  const isLoadingDisplayMessages =
    isLoadingChatData &&
    !shouldUseCachedSnapshot &&
    displayChatData.messages.length === 0;

  useEffect(() => {
    if (!usedClientMessageCache || !displayThreadId) return;
    const nextSearch = new URLSearchParams(locationSearch);
    nextSearch.delete("chatCache");
    const nextUrl = `/chat/${encodeURIComponent(displayThreadId)}${
      nextSearch.toString() ? `?${nextSearch.toString()}` : ""
    }`;
    navigate(nextUrl, { replace: true, preventScrollReset: true });
  }, [displayThreadId, locationSearch, navigate, usedClientMessageCache]);

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
  const liveChatGroupById = new Map(
    liveChatGroups.map((group) => [group.id, group]),
  );
  const availableMoveGroups = (moveChatGroups.length > 0
    ? moveChatGroups
    : liveChatGroups
  ).map((group) => {
    const liveGroup = liveChatGroupById.get(group.id);
    return liveGroup && liveGroup.avatar !== group.avatar
      ? { ...group, avatar: liveGroup.avatar }
      : group;
  });

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

  const renameGroup = async (next: ChatGroupRenameInput) => {
    const groupId = liveActiveChatGroup?.id ?? resolvedActiveGroupId;
    await saveChatGroupRename(groupId, next, {
      revalidate: () => revalidator.revalidate(),
    });
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

  const handleSnapshotChange = useCallback(
    (snapshot: {
      messages: Message[];
      uiMessages: UIMessage[];
      streamingMessageId: string | null;
      todos: TodoItem[];
    }) => {
      if (!displayThreadId || isLoadingDisplayMessages) return;
      setSnapshot(displayThreadId, snapshot);
    },
    [displayThreadId, isLoadingDisplayMessages, setSnapshot],
  );

  if (!workspaceId) {
    return <NoWorkspacesError />;
  }

  return (
    <>
      <div className="flex h-full min-h-0 flex-col">
        {!readOnly && liveActiveChatGroup ? (
          <ChatTabBar
            groupId={liveActiveChatGroup.id}
            groupName={liveActiveChatGroup.name}
            groupAvatar={liveActiveChatGroup.avatar}
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
            initialUiMessages={displayChatData.initialUiMessages}
            bridgedStreamingMessageId={displayChatData.bridgedStreamingMessageId}
            initialTodos={displayChatData.todos}
            threadModel={displayThreadModel}
            llmProvider={llmProvider}
            allowedThreadModels={displayAllowedThreadModels}
            effectivePickerDefaultModel={effectivePickerDefaultModel}
            hasEffectivePickerDefault={hasEffectivePickerDefault}
            experimentalSettings={experimentalSettings}
            billingCreditStatus={billingCreditStatus}
            initialError={initialChatError ?? displayChatData.messagesError}
            pendingFirstTurn={isDisplayingLoaderThread && pendingFirstTurn}
            initialPreviewTabs={displayChatData.previewTabs}
            initialActiveTabId={displayChatData.activeTabId}
            hostname={hostname}
            orgSlug={orgSlug}
            connections={connections}
            projects={projects}
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
