import { Suspense, use, useCallback, useEffect, useState } from "react";
import { redirect, useLoaderData } from "react-router";
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
import * as authDO from "@/lib/auth-do.server";
import * as chatDO from "@/lib/chat-do.server";
import Chat from "@/components/Chat";
import { ChatLoadingSkeleton } from "@/components/chat/chat-loading";
import { NoWorkspacesError } from "@/components/no-workspaces-error";
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
  } = useLoaderData<typeof loader>();

  if (!workspaceId) {
    return <NoWorkspacesError />;
  }

  const [resolvedChatDataState, setResolvedChatDataState] = useState<{
    threadId: string;
    data: ChatData;
  } | null>(() => (isNewThread ? { threadId, data: EMPTY_CHAT_DATA } : null));

  const resolvedChatData =
    resolvedChatDataState?.threadId === threadId
      ? resolvedChatDataState.data
      : null;
  const chatData = resolvedChatData ?? EMPTY_CHAT_DATA;
  const isLoadingMessages = !isNewThread && resolvedChatData === null;

  const handleResolved = useCallback(
    (resolvedThreadId: string, data: ChatData) => {
      setResolvedChatDataState({ threadId: resolvedThreadId, data });
    },
    [],
  );

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
        llmProvider={llmProvider}
        allowedThreadModels={allowedThreadModels}
        effectivePickerDefaultModel={effectivePickerDefaultModel}
        hasEffectivePickerDefault={hasEffectivePickerDefault}
        experimentalSettings={experimentalSettings}
        billingCreditStatus={billingCreditStatus}
        initialError={initialChatError}
        initialPreviewTarget={chatData.previewTarget}
        initialPreviewTabs={chatData.previewTabs}
        initialActiveTabId={chatData.activeTabId}
        isNewThread={isNewThread}
        hostname={hostname}
        orgSlug={orgSlug}
        connections={connections}
        isOrgAdmin={isOrgAdmin}
        recentModelScope={recentModelScope}
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
