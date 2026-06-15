import {
  redirect,
  useActionData,
  useLoaderData,
  useNavigate,
  useRevalidator,
} from "react-router";
import type { Route } from "./+types/_app.chat._index";
import {
  requireAuthContext,
  requireSessionWorkspaceAccess,
} from "@/lib/auth.server";
import { APP_BUILD_ID } from "@/lib/app-build-id";
import { getEnv } from "@/lib/cloudflare.server";
import { getAppUrlContext } from "@/lib/app-url.server";
import { getOrgBillingOverview } from "@/lib/billing.server";
import { loadUserProfileSummaries } from "@/lib/user-profiles.server";
import {
  applyDevBillingCreditStatusOverride,
  buildBillingCreditStatus,
  getDevChatInitialError,
} from "@/lib/chat-credit-status";
import { waitUntil } from "@/lib/wait-until";
import { getAuthEnv } from "@/lib/auth-helpers";
import type { MentionableProject } from "@/lib/mentions";
import { getWorkerScript } from "@/lib/auth-do";
import { loadWorkspaceMentionSources } from "@/lib/mention-sources.server";
import {
  getDefaultLlmModel,
  getStoredCustomLlmProviderApi,
  getStoredCustomLlmProviderModelId,
  getVisibleLlmModelOptions,
} from "@/lib/llm-provider-config";
import { getEffectiveLlmProviderConfig } from "@/lib/selfhost-ai-provider";
import { isSelfhostRuntime } from "@/lib/selfhost-runtime";
import * as chatDO from "@/lib/chat-do.server";
import {
  addThreadToExistingGroup,
  addThreadToExistingGroupLightweight,
  createGroupForNewThread,
  createGroupForNewThreadLightweight,
  getGroupForWorkspace,
  listGroupsForMove,
} from "@/lib/chat-groups.server";
import {
  consumeSalesPrompt,
  getPromptKeyFromUrl,
} from "@/lib/sales-prompt.server";
import {
  isTransientDurableObjectRpcError,
  retryTransientDurableObjectRpc,
} from "@/lib/do-rpc-retry.server";
import Chat from "@/components/Chat";
import { ChatTabBar } from "@/components/chat-tab-bar";
import { NoWorkspacesError } from "@/components/no-workspaces-error";
import { SidebarTrigger } from "@/components/ui/sidebar";
import type {
  Integration,
  LlmModel,
  Thread,
  WorkerScriptWithCreator,
} from "@/types";
import { useChatGroups } from "@/hooks/use-chat-groups";
import {
  createRequestObservabilityContext,
  normalizePathForObservability,
  recordErrorEvent,
  recordObservabilityEvent,
} from "../../workers/main/src/observability";

/**
 * Skip loader revalidation after createThread — the user is navigating away
 * immediately, so re-fetching the welcome screen data is wasted work.
 */
export function shouldRevalidate({
  formData,
  defaultShouldRevalidate,
}: {
  formData?: FormData;
  defaultShouldRevalidate: boolean;
}) {
  const intent = formData?.get("intent");
  if (intent === "createThread" || intent === "createThreadAndStart") {
    return false;
  }
  return defaultShouldRevalidate;
}

export function meta() {
  return [
    { title: "New Chat - camelAI" },
    { name: "description", content: "Start a new AI chat" },
  ];
}

function formStringValue(formData: FormData, key: string): string | null {
  const value = formData.get(key);
  return typeof value === "string" && value.trim() ? value : null;
}

type ChatCreateThreadTraceContext = {
  requestId: string;
  sampleIndex: string;
  method: string;
  path: string;
  route: string;
};

type ChatCreateThreadTraceIds = {
  orgId?: string | null;
  workspaceId?: string | null;
  userId?: string | null;
  threadId?: string | null;
};

type ChatCreateThreadTraceExtra = {
  status?: string;
  statusCode?: number;
  count?: number;
  size?: number;
  provider?: string | null;
  model?: string | null;
};

function createChatCreateThreadTraceContext(
  request: Request,
): ChatCreateThreadTraceContext {
  const requestContext = createRequestObservabilityContext(request);
  const url = new URL(request.url);
  return {
    requestId: requestContext.requestId,
    sampleIndex: requestContext.colo,
    method: request.method,
    path: normalizePathForObservability(url.pathname),
    route: "routes/_app.chat._index.action",
  };
}

function recordChatCreateThreadStage(
  env: ReturnType<typeof getEnv>,
  trace: ChatCreateThreadTraceContext,
  ids: ChatCreateThreadTraceIds,
  operation: string,
  startedAt: number,
  extra: ChatCreateThreadTraceExtra = {},
): void {
  recordObservabilityEvent(env, {
    event: "chat_create_thread_stage",
    severity: extra.status === "error" ? "error" : "info",
    component: "react_router_action",
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
    provider: extra.provider,
    model: extra.model,
    durationMs: Date.now() - startedAt,
    statusCode: extra.statusCode,
    count: extra.count,
    size: extra.size,
    sampleIndex: trace.sampleIndex,
  });
}

function recordChatCreateThreadError(
  env: ReturnType<typeof getEnv>,
  trace: ChatCreateThreadTraceContext,
  ids: ChatCreateThreadTraceIds,
  operation: string,
  startedAt: number,
  error: unknown,
  extra: ChatCreateThreadTraceExtra = {},
): void {
  recordErrorEvent(env, {
    event: "chat_create_thread_stage",
    component: "react_router_action",
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
    provider: extra.provider,
    model: extra.model,
    durationMs: Date.now() - startedAt,
    statusCode: extra.statusCode,
    count: extra.count,
    size: extra.size,
    sampleIndex: trace.sampleIndex,
    error,
  });
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const authContext = await requireAuthContext(request, context);
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const url = new URL(request.url);
  const promptKey = getPromptKeyFromUrl(url);
  const hostname = getAppUrlContext(env, request);
  const workspaceId = authContext.currentWorkspace?.id;
  const groupId = url.searchParams.get("group")?.trim() || null;
  const userId = authContext.user?.id ?? null;
  const userName = authContext.user?.name ?? null;
  const renderedAt = Date.now();
  let salesPrompt: string | null = null;

  // Only consume the KV entry if the user has completed onboarding.
  // For new users, _app.tsx redirects to /onboarding in parallel with this
  // loader — consuming here would delete the KV entry before the onboarding
  // flow can use it.
  if (promptKey && authContext.onboarding?.completed_at) {
    try {
      salesPrompt = await consumeSalesPrompt(env.APP_KV, promptKey);
    } catch (error) {
      console.error(
        "Failed to consume sales prompt for welcome screen:",
        error,
      );
    }
  }

  const allAppsPromise: Promise<WorkerScriptWithCreator[]> =
    workspaceId && authContext.currentOrg?.id
      ? (async () => {
          const scripts = await authEnv.ORG.get(
            authEnv.ORG.idFromName(authContext.currentOrg.id),
          ).listWorkerScripts();

          const filteredScripts = scripts
            .filter((script) => script.workspace_id === workspaceId)
            .sort((a, b) => b.updated_at - a.updated_at);

          const creatorMap = await loadUserProfileSummaries(
            authEnv,
            filteredScripts.map((script) => script.created_by),
            { request, preloadedUsers: [authContext.user] },
          );

          return filteredScripts.map((script) => {
            const creator = creatorMap.get(script.created_by);
            return {
              script_name: script.script_name,
              workspace_id: script.workspace_id,
              created_by: script.created_by,
              created_at: script.created_at,
              updated_at: script.updated_at,
              is_public: script.is_public,
              preview_key: script.preview_key,
              preview_updated_at: script.preview_updated_at,
              preview_status: script.preview_status,
              preview_error: script.preview_error,
              config_path: script.config_path,
              project_id: script.project_id,
              custom_domain_hostname: script.custom_domain_hostname,
              custom_domain_cf_hostname_id: script.custom_domain_cf_hostname_id,
              custom_domain_status: script.custom_domain_status,
              custom_domain_ssl_status: script.custom_domain_ssl_status,
              custom_domain_error: script.custom_domain_error,
              custom_domain_updated_at: script.custom_domain_updated_at,
              creator: creator
                ? {
                    id: creator.id,
                    name: creator.name,
                    email: creator.email,
                    avatar: creator.avatar,
                  }
                : undefined,
            };
          });
        })().catch((error) => {
          console.error("Failed to load workspace apps:", error);
          return [];
        })
      : Promise.resolve([]);

  const recentThreadsPromise: Promise<Thread[]> = workspaceId
    ? chatDO
        .getRecentThreads(context, workspaceId, 6, userId ?? undefined, {
          orgId: authContext.currentOrg.id,
        })
        .catch((error) => {
          console.error("Failed to load recent threads:", error);
          return [];
        })
    : Promise.resolve([]);

  const mentionSourcesPromise = workspaceId
    ? loadWorkspaceMentionSources(env, workspaceId)
    : Promise.resolve({ connections: [], projects: [] });
  const connectionsPromise: Promise<Integration[]> = mentionSourcesPromise.then(
    ({ connections }) => connections,
  );
  const projectsPromise: Promise<MentionableProject[]> = mentionSourcesPromise.then(
    ({ projects }) => projects,
  );

  const activeChatGroupPromise =
    workspaceId && userId && groupId
      ? getGroupForWorkspace(context, {
          userId,
          orgId: authContext.currentOrg.id,
          workspaceId,
          groupId,
        }).catch((error) => {
          console.error("Failed to load chat group for welcome screen:", error);
          return null;
        })
      : Promise.resolve(null);
  const moveChatGroupsPromise =
    workspaceId && userId
      ? listGroupsForMove(context, {
          userId,
          orgId: authContext.currentOrg.id,
          workspaceId,
        }).catch(() => [])
      : Promise.resolve([]);
  const pickerStatePromise = workspaceId
    ? chatDO.getWorkspaceModelPickerState(context, workspaceId, {
        orgId: authContext.currentOrg.id,
        llmProviderConfig: authContext.currentOrgLlmProviderConfig,
        experimentalSettings: authContext.currentOrgExperimentalSettings,
      }).catch(
        (error) => {
          console.error("Failed to load model picker state:", error);
          return null;
        },
      )
    : Promise.resolve(null);
  const [
    activeChatGroup,
    moveChatGroups,
    pickerState,
  ] = await Promise.all([
    activeChatGroupPromise,
    moveChatGroupsPromise,
    pickerStatePromise,
  ]);
  const experimentalSettings =
    pickerState?.experimentalSettings ?? authContext.currentOrgExperimentalSettings;
  const effectiveLlmProviderConfig = getEffectiveLlmProviderConfig(
    env,
    authContext.currentOrgLlmProviderConfig,
  );
  const llmProvider =
    pickerState?.llmProvider ??
    ((effectiveLlmProviderConfig?.provider ?? null) as
      | import("@/types").LlmProvider
      | null);
  const customApi = getStoredCustomLlmProviderApi(effectiveLlmProviderConfig);
  const customModelId = getStoredCustomLlmProviderModelId(effectiveLlmProviderConfig);
  const fallbackThreadModel = getDefaultLlmModel(effectiveLlmProviderConfig?.provider, {
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
    },
  ).map((option) => option.value);
  const hasModelFallback = Boolean(workspaceId);
  const billingOverview = !isSelfhostRuntime(env) && authContext.currentOrg
    ? await getOrgBillingOverview(env, authContext.currentOrg).catch((error) => {
        console.warn("Failed to load billing overview for chat:", error);
        return null;
      })
    : null;

  const threadModel =
    pickerState?.defaultModel ??
    (hasModelFallback ? fallbackThreadModel : null);

  return {
    workspaceId: workspaceId ?? null,
    threadModel,
    allowedThreadModels:
      pickerState?.allowedThreadModels ??
      (hasModelFallback ? fallbackAllowedThreadModels : []),
    effectivePickerDefaultModel:
      pickerState?.effectivePickerDefaultModel ?? null,
    hasEffectivePickerDefault:
      pickerState?.hasEffectivePickerDefault ?? false,
    billingCreditStatus: applyDevBillingCreditStatusOverride(
      buildBillingCreditStatus(billingOverview, llmProvider, threadModel),
      url.searchParams,
    ),
    initialChatError: getDevChatInitialError(url.searchParams),
    llmProvider,
    experimentalSettings,
    isOrgAdmin: authContext.orgs.some(
      (org) =>
        org.org_id === authContext.currentOrg.id &&
        (org.role === "owner" || org.role === "admin"),
    ),
    recentModelScope:
      workspaceId && authContext.currentOrg?.id
        ? { orgId: authContext.currentOrg.id, workspaceId }
        : null,
    hostname,
    userId,
    userName,
    allApps: allAppsPromise,
    connections: connectionsPromise,
    projects: projectsPromise,
    recentThreads: recentThreadsPromise,
    renderedAt,
    salesPrompt,
    activeChatGroup,
    activeGroupId: groupId,
    moveChatGroups,
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const env = getEnv(context);
  const traceContext = createChatCreateThreadTraceContext(request);
  const actionStartedAt = Date.now();
  const traceIds: ChatCreateThreadTraceIds = {};
  let selectedTraceModel: string | null = null;

  // Security-critical write path: validate current workspace membership/access
  // without loading full auth context.
  const accessStartedAt = Date.now();
  const { orgId, workspaceId, userId, session } =
    await requireSessionWorkspaceAccess(request, context, undefined, {
      requireWrite: true,
    });
  traceIds.orgId = orgId;
  traceIds.workspaceId = workspaceId;
  traceIds.userId = userId;
  recordChatCreateThreadStage(
    env,
    traceContext,
    traceIds,
    "workspace_access_validated",
    accessStartedAt,
  );

  const authEnv = getAuthEnv(env);

  const formStartedAt = Date.now();
  const formData = await request.formData();
  const intent = formData.get("intent");
  recordChatCreateThreadStage(
    env,
    traceContext,
    traceIds,
    "form_parsed",
    formStartedAt,
  );

  if (intent === "createThread" || intent === "createThreadAndStart") {
    try {
      const shouldStartAndRedirect = intent === "createThreadAndStart";
      const initialTitle = formStringValue(formData, "initialTitle");
      const firstMessage = formStringValue(formData, "firstMessage");
      const clientBuildId = formStringValue(formData, "clientBuildId");
      const previewAppsRaw = formStringValue(formData, "previewApps");
      const rawModel = formData.get("model");
      const model = typeof rawModel === "string" ? rawModel : null;
      selectedTraceModel = model;
      const rawGroupId = formData.get("groupId");
      const groupId =
        typeof rawGroupId === "string" && rawGroupId.trim()
          ? rawGroupId.trim()
          : null;

      if (!clientBuildId || clientBuildId !== APP_BUILD_ID) {
        recordChatCreateThreadStage(
          env,
          traceContext,
          traceIds,
          "client_build_validated",
          actionStartedAt,
          {
            status: "client_build_mismatch_ignored",
            model: selectedTraceModel,
            size: firstMessage?.length ?? 0,
          },
        );
      } else {
        recordChatCreateThreadStage(
          env,
          traceContext,
          traceIds,
          "client_build_validated",
          actionStartedAt,
          {
            model: selectedTraceModel,
            size: firstMessage?.length ?? 0,
          },
        );
      }

      const createThreadStartedAt = Date.now();
      const thread = shouldStartAndRedirect
        ? await chatDO.createThreadWithValidatedAccess(
            context,
            orgId,
            workspaceId,
            initialTitle || undefined,
            userId,
            firstMessage || undefined,
            model ?? undefined,
          )
        : await chatDO.createThread(
            context,
            workspaceId,
            initialTitle || undefined,
            userId,
            firstMessage || undefined,
            model ?? undefined,
          );
      traceIds.threadId = thread.id;
      selectedTraceModel = thread.model;
      recordChatCreateThreadStage(
        env,
        traceContext,
        traceIds,
        "thread_created",
        createThreadStartedAt,
        {
          model: thread.model,
          size: firstMessage?.length ?? 0,
        },
      );

      // Set preview apps if provided (for "chat with this app" flow)
      if (previewAppsRaw) {
        const previewStartedAt = Date.now();
        const previewApps = previewAppsRaw.split(",").filter(Boolean);
        if (previewApps.length > 0) {
          const scriptName = previewApps[0];
          const script = await getWorkerScript(authEnv, orgId, scriptName);
          await chatDO.setThreadPreviewTarget(context, thread.id, {
            kind: "app",
            scriptName,
            isPublic: script?.is_public ?? false,
          });
        }
        recordChatCreateThreadStage(
          env,
          traceContext,
          traceIds,
          "preview_target_set",
          previewStartedAt,
          {
            count: previewApps.length,
            model: thread.model,
          },
        );
      }

      // Generate title in background if we have a first message
      if (firstMessage) {
        waitUntil(
          chatDO.generateThreadTitle(
            context,
            thread.id,
            workspaceId,
            firstMessage,
            userId,
          ),
        );
        recordChatCreateThreadStage(
          env,
          traceContext,
          traceIds,
          "title_generation_scheduled",
          actionStartedAt,
          {
            model: thread.model,
            size: firstMessage.length,
          },
        );
      }

      const groupStartedAt = Date.now();
      const group = await (async () => {
        try {
          if (shouldStartAndRedirect) {
            return groupId
              ? await addThreadToExistingGroupLightweight(context, {
                  userId,
                  orgId,
                  workspaceId,
                  groupId,
                  threadId: thread.id,
                })
              : await createGroupForNewThreadLightweight(context, {
                  userId,
                  orgId,
                  workspaceId,
                  threadId: thread.id,
                  initialThreadTitle: initialTitle,
                });
          }
          return groupId
            ? await addThreadToExistingGroup(context, {
                userId,
                orgId,
                workspaceId,
                groupId,
                threadId: thread.id,
              })
            : await createGroupForNewThread(context, {
                userId,
                orgId,
                workspaceId,
                threadId: thread.id,
                initialThreadTitle: initialTitle,
              });
        } catch (groupError) {
          await chatDO
            .deleteThread(context, thread.id, workspaceId)
            .catch(() => {});
          const message =
            groupError instanceof Error ? groupError.message : "";
          if (
            groupId &&
            (message === "Chat group not found" ||
              message === "Thread not found")
          ) {
            throw Response.json({ error: message }, { status: 404 });
          }
          throw groupError;
        }
      })();
      recordChatCreateThreadStage(
        env,
        traceContext,
        traceIds,
        "group_linked",
        groupStartedAt,
        {
          status: groupId ? "existing_group" : "new_group",
          model: thread.model,
          count: group.member_count,
        },
      );

      if (shouldStartAndRedirect && firstMessage) {
        const initialStartScheduledAt = Date.now();
        const chatThreadStub = env.CHAT_THREAD.get(
          env.CHAT_THREAD.idFromName(thread.id),
        );
        const initialMessageRequest = {
          threadId: thread.id,
          workspaceId,
          orgId,
          userId,
          userName: session.user_name ?? null,
          userEmail: session.user_email ?? null,
          message: firstMessage,
          clientMessageId: `initial:${thread.id}`,
        };
        waitUntil(
          retryTransientDurableObjectRpc(
            "ChatThreadDO.startInitialUserMessage",
            async () => {
              const result =
                await chatThreadStub.startInitialUserMessage(
                  initialMessageRequest,
                );
              if (
                result.status === "error" &&
                isTransientDurableObjectRpcError(
                  new Error(result.error ?? "Transient Durable Object error"),
                )
              ) {
                throw new Error(result.error);
              }
              return result;
            },
            {
              attempts: 4,
              initialDelayMs: 150,
            },
          )
            .then((result) => {
              recordChatCreateThreadStage(
                env,
                traceContext,
                traceIds,
                "initial_message_start_completed",
                initialStartScheduledAt,
                {
                  model: thread.model,
                  status: result.status,
                  size: firstMessage.length,
                },
              );
              if (result.status !== "accepted") {
                console.error(
                  "Failed to start initial user message:",
                  result.error ?? result.status,
                );
              }
            })
            .catch((error) => {
              console.error("Failed to start initial user message:", error);
              recordChatCreateThreadError(
                env,
                traceContext,
                traceIds,
                "initial_message_start_completed",
                initialStartScheduledAt,
                error,
                {
                  model: thread.model,
                  size: firstMessage.length,
                },
              );
            }),
        );
        recordChatCreateThreadStage(
          env,
          traceContext,
          traceIds,
          "initial_message_start_scheduled",
          actionStartedAt,
          {
            model: thread.model,
            size: firstMessage.length,
          },
        );
      }

      if (shouldStartAndRedirect) {
        const nextUrl = new URL(
          `/chat/${thread.id}?newThread=1`,
          request.url,
        );
        if (group.id) {
          nextUrl.searchParams.set("group", group.id);
        }
        recordChatCreateThreadStage(
          env,
          traceContext,
          traceIds,
          "redirect_ready",
          actionStartedAt,
          {
            model: thread.model,
            size: firstMessage?.length ?? 0,
            statusCode: 302,
          },
        );
        return redirect(`${nextUrl.pathname}${nextUrl.search}`);
      }

      recordChatCreateThreadStage(
        env,
        traceContext,
        traceIds,
        "json_response_ready",
        actionStartedAt,
        {
          model: thread.model,
          size: firstMessage?.length ?? 0,
          statusCode: 200,
        },
      );
      return Response.json({ thread, groupId: group.id, group });
    } catch (error) {
      if (error instanceof Response) return error;
      console.error("Failed to create thread:", error);
      const message =
        error instanceof Error ? error.message : "Failed to create thread";
      const status =
        message === "Invalid thread model" || message === "No models are available"
          ? 400
          : 500;
      recordChatCreateThreadError(
        env,
        traceContext,
        traceIds,
        "create_thread_action",
        actionStartedAt,
        error,
        {
          model: selectedTraceModel,
          statusCode: status,
        },
      );
      return Response.json(
        { error: message || "Failed to create thread" },
        { status },
      );
    }
  }

  recordChatCreateThreadStage(
    env,
    traceContext,
    traceIds,
    "unknown_intent",
    actionStartedAt,
    { status: "client_error", statusCode: 400 },
  );
  return Response.json({ error: "Unknown intent" }, { status: 400 });
}

export default function NewChatPage() {
  const actionData = useActionData() as
    | { error?: string }
    | undefined;
  const {
    workspaceId,
    llmProvider,
    threadModel,
    allowedThreadModels,
    effectivePickerDefaultModel,
    hasEffectivePickerDefault,
    billingCreditStatus,
    initialChatError,
    hostname,
    userId,
    userName,
    allApps,
    connections,
    projects,
    recentThreads,
    renderedAt,
    salesPrompt,
    activeChatGroup,
    activeGroupId,
    moveChatGroups,
    experimentalSettings,
    isOrgAdmin,
    recentModelScope,
  } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const { groups: liveChatGroups } = useChatGroups();
  const actionError =
    actionData && "error" in actionData && typeof actionData.error === "string"
      ? actionData.error
      : null;

  if (!workspaceId) {
    return <NoWorkspacesError />;
  }

  const resolvedActiveGroupId = activeGroupId ?? activeChatGroup?.id ?? null;
  const liveActiveChatGroup = resolvedActiveGroupId
    ? liveChatGroups.find((group) => group.id === resolvedActiveGroupId) ??
      activeChatGroup
    : activeChatGroup;

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
  const refresh = () => revalidator.revalidate();
  const closeTab = async (threadId: string) => {
    const groupId = liveActiveChatGroup?.id ?? resolvedActiveGroupId;
    if (!groupId) return;
    await fetch(
      `/api/chat-groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(threadId)}`,
      { method: "DELETE" },
    );
    refresh();
  };
  const reopenTab = async (threadId: string) => {
    const groupId = liveActiveChatGroup?.id ?? resolvedActiveGroupId;
    if (!groupId) return;
    await fetch(
      `/api/chat-groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(threadId)}/reopen`,
      { method: "POST" },
    );
    refresh();
    navigate(`/chat/${threadId}`);
  };
  const renameTab = async (threadId: string, name: string) => {
    await fetch(`/api/threads/${encodeURIComponent(threadId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: name }),
    });
    refresh();
  };
  const renameGroup = async (name: string) => {
    const groupId = liveActiveChatGroup?.id ?? resolvedActiveGroupId;
    if (!groupId) return;
    await fetch(`/api/chat-groups/${encodeURIComponent(groupId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    refresh();
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
    refresh();
  };
  const moveTabToGroup = async (
    threadId: string,
    targetGroupId: string | "new",
  ) => {
    const response = await fetch("/api/chat-groups/move-thread", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadId, targetGroupId }),
    });
    if (response.ok) {
      refresh();
      navigate(`/chat/${threadId}`);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {liveActiveChatGroup ? (
        <ChatTabBar
          groupId={liveActiveChatGroup.id}
          groupName={liveActiveChatGroup.name}
          openTabs={openTabs}
          closedTabs={closedTabs}
          activeThreadId={null}
          moveGroups={moveChatGroups}
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
      ) : (
        <div className="flex h-11 shrink-0 items-center border-b bg-muted/20 px-2 md:hidden">
          <SidebarTrigger />
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col">
        <Chat
          workspaceId={workspaceId}
          hostname={hostname}
          chatGroupId={liveActiveChatGroup?.id ?? resolvedActiveGroupId}
          welcomeData={{
            userId,
            userName,
            allApps,
            connections,
            projects,
            recentThreads,
            renderedAt,
          }}
          experimentalSettings={experimentalSettings}
          llmProvider={llmProvider}
          threadModel={threadModel}
          allowedThreadModels={allowedThreadModels}
          effectivePickerDefaultModel={effectivePickerDefaultModel}
          hasEffectivePickerDefault={hasEffectivePickerDefault}
          isOrgAdmin={isOrgAdmin}
          recentModelScope={recentModelScope}
          billingCreditStatus={billingCreditStatus}
          initialError={actionError ?? initialChatError}
          newChatActionError={actionError}
          initialWelcomeInput={salesPrompt}
        />
      </div>
    </div>
  );
}
