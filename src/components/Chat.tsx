"use client";

import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  useLayoutEffect,
} from "react";
import type { CSSProperties } from "react";
import { useAgent } from "agents/react";
import {
  useNavigate,
  useFetcher,
  useLocation,
  useNavigation,
  useRevalidator,
  useSubmit,
} from "react-router";
import {
  ArrowDown,
} from "lucide-react";
import { toast } from "sonner";
import type {
  AtMentionEntity,
  Message,
  LlmModel,
  LlmProvider,
  Thread,
  ToolResultBlock,
  WorkerScriptWithCreator,
  Integration,
  PreviewTarget,
  PreviewTab,
  OrganizationExperimentalSettings,
  ChatGroupView,
  CondensedTranscript,
  GroupNewChatAttachmentCard,
  GroupNewChatPayload,
  GroupNewChatTranscriptCard,
  ChatGroupAvatar,
  ChatGroupAvatarStatus,
} from "@/types";
import { useAuthData } from "@/hooks/use-auth-data";
import { useOptionalChatGroups } from "@/hooks/use-chat-groups";
import { useIsMobile } from "@/hooks/use-mobile";
import { APP_BUILD_ID } from "@/lib/app-build-id";
import {
  TooltipProvider,
} from "@/components/ui/tooltip";
import { PromptInput } from "@/components/prompt-input";
import {
  FloatingTodoList,
  type TodoItem,
} from "@/components/floating-todo";
import {
  AskUserQuestion,
  type AskUserQuestionData,
} from "@/components/ask-user-question";
import {
  ConnectionSetupPrompt,
  type ConnectionSetupPromptData,
} from "@/components/connection-setup-prompt";
import type { Attachment } from "@/components/attachment-list";
import { Button } from "@/components/ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import {
  isInterruptMessage,
  parseLocalCommandStdout,
} from "@/components/message-bubble";
import { WelcomeScreen } from "@/components/welcome-screen";
import { BillingCreditNotice } from "@/components/chat-billing-credit-notice";
import {
  TopUpDialog,
  type TopUpDialogPack,
} from "@/components/billing/top-up-dialog";
import { ChatErrorNotice } from "@/components/chat-error-notice";
import { ChatMessagesView } from "@/components/chat-messages-view";
import { ShareStatusButton } from "@/components/chat-share-status-button";
import { isImageFile, type NotebookPreviewLoadState } from "@/components/chat-file-preview";
import { ChatPreviewProvider } from "@/components/chat-preview/preview-context";
import {
  DEFAULT_NOTEBOOK_PREVIEW_STATE,
  MobileViewSwitcher,
  PreviewPanelShell,
  normalizePreviewSessionState,
} from "@/components/chat-preview/chat-preview-shell";
import { useConnectionSetupResponse } from "@/components/chat-preview/use-connection-setup-response";
import { useChatPreviewRenderState } from "@/components/chat-preview/use-chat-preview-render-state";
import {
  arePreviewSessionsExactlyEqual,
  arePreviewSessionsSemanticallyEqual,
} from "@/components/chat-preview/preview-session-compare";
import {
  getPreviewTabId,
  shouldAutoRefreshFilePreview,
} from "@/components/preview-panel/preview-utils";
import { cn } from "@/lib/utils";
import { buildSlugMap, type MentionableProject } from "@/lib/mentions";
import { isFileDrag } from "@/lib/file-drag";
import {
  mergeTaskNotifications,
  normalizeToolResultMessages,
  mergeTeammateMessages,
} from "@/lib/streaming";
import { parseMessageContent } from "@/lib/chat-message-content";
import {
  deriveIsAwaitingAssistant,
  isAssistantLikeMessage,
} from "@/lib/chat-working-indicator";
import { mergeOverlay } from "@/lib/runtime-message-state";
import {
  type AppUrlInput,
  getAppUrl,
  getAppIframeUrl,
} from "@/lib/app-url";
import {
  collectVmProjectReferencesFromMessages,
  collectVmProjectReferencesFromPreviewTabs,
  formatCopyFilePath,
  normalizeProjectCopyLookupKey,
  resolveProjectMentionSlug,
  type CopyFilePathTarget,
} from "@/lib/file-path-copy";
import { uploadWorkspaceFile } from "@/lib/workspace-upload.client";
import { isManualCompactCommand } from "@/lib/slash-commands";
import { buildAppThreadFallbackTitle } from "@/lib/thread-title";
import { normalizeThreadPreviewUserMessage } from "@/lib/thread-preview";
import {
  getDefaultLlmModel,
  getVisibleLlmModelOptions,
  isLlmModel,
} from "@/lib/llm-provider-config";
import {
  type ChatApiErrorContext,
  type ChatApiErrorPresentation,
  getChatApiErrorPresentation,
  isChatBillingOrCreditError,
} from "@/lib/chat-api-errors";
import { parseByokProvider } from "@/lib/byok-providers";
import {
  modelCatalogEntriesForIds,
  type ModelCatalogEntry,
} from "@/lib/model-catalog";
import { resolveDefaultModelForChat } from "@/lib/model-picker-config";
import {
  getRecentModel,
  type RecentModelScope,
} from "@/lib/recent-model";
import type { BillingCreditStatus } from "@/lib/chat-credit-status";
import {
  loadDeliveryDraft,
  loadDraft,
  markDeliveryDraftAccepted,
  removeDeliveryDraft,
  removeDraft,
  serializeAttachments,
  useDraftPersistence,
  writeDeliveryDraft,
  writeDraft,
  type DeliveryDraftData,
} from "@/hooks/use-draft-persistence";
import { useBufferedState } from "@/hooks/use-buffered-state";
import {
  appendAttachmentReferences,
  isUserUploadMountPath,
} from "@/lib/chat-attachment-refs";
import { condensedTranscriptToMarkdown } from "@/lib/condensed-transcript";

export { ChatErrorNotice } from "@/components/chat-error-notice";
export { BillingCreditNotice } from "@/components/chat-billing-credit-notice";

type ChatAgentState = {
  isStreaming?: boolean;
  previewTabs?: PreviewTarget[];
  previewActiveTabId?: string | null;
  previewVersion?: number;
  previewRefreshTabId?: string | null;
  currentTodos?: unknown[];
  contextUsedPercent?: number | null;
  pendingQuestion?: AskUserQuestionData | null;
  connectionSetupPrompt?: ConnectionSetupPromptData | null;
  title?: string | null;
  titleUpdatedAt?: number | null;
  model?: LlmModel | null;
  modelUpdatedAt?: number | null;
  lastCompletedTurn?: {
    id: string;
    durationMs: number;
    completedAtMs: number;
  } | null;
  lastError?: {
    id: string;
    error: string;
    billingSource: string | null;
    provider: string | null;
    status: number | string | null;
    errorType: string | null;
  } | null;
};

type ChatAgentClient = {
  readyState: number;
  send(data: string): void;
  reconnect(): void;
  call<T = unknown>(method: string, args?: unknown[]): Promise<T>;
};

type SendMessageResult = {
  status: "accepted" | "busy" | "error";
  error?: string;
};

function sameJson(left: unknown, right: unknown): boolean {
  return left === right || JSON.stringify(left) === JSON.stringify(right);
}

// Only animate the "just completed" turn highlight for completions this recent;
// older completions replayed on load/reconnect still get their duration badge.
const FRESHLY_COMPLETED_TURN_WINDOW_MS = 10_000;

function getThreadRunningState(
  groups: readonly ChatGroupView[] | undefined,
  threadId: string | null,
): { isRunning: boolean; startedAt: number | null } {
  if (!threadId) return { isRunning: false, startedAt: null };

  for (const group of groups ?? []) {
    for (const thread of group.open_threads) {
      if (thread.id === threadId) {
        return {
          isRunning: thread.status === "running",
          startedAt: thread.running_started_at,
        };
      }
    }
    for (const thread of group.closed_threads) {
      if (thread.id === threadId) {
        return {
          isRunning: thread.status === "running",
          startedAt: thread.running_started_at,
        };
      }
    }
  }

  return { isRunning: false, startedAt: null };
}

interface ChatProps {
  threadId?: string;
  workspaceId: string;
  initialMessages?: Message[];
  initialTodos?: TodoItem[];
  threadModel?: LlmModel | null;
  llmProvider?: LlmProvider | null;
  allowedThreadModels?: LlmModel[] | null;
  effectivePickerDefaultModel?: LlmModel | null;
  hasEffectivePickerDefault?: boolean;
  isOrgAdmin?: boolean;
  recentModelScope?: RecentModelScope | null;
  billingCreditStatus?: BillingCreditStatus | null;
  initialError?: string | null;
  newChatActionError?: string | null;
  experimentalSettings?: OrganizationExperimentalSettings | null;
  initialPreviewTabs?: PreviewTarget[];
  initialActiveTabId?: string | null;
  /**
   * A freshly-started new chat whose first turn is running in the background
   * (set by the new-chat action via ?newThread=1). Shows the working indicator
   * from first paint until the assistant reply appears.
   */
  pendingFirstTurn?: boolean;
  /** Hostname from server for consistent URL generation (avoids hydration mismatch) */
  hostname?: AppUrlInput;
  /** Org slug for namespaced app URLs */
  orgSlug?: string;
  /** True when messages are still loading (deferred data) */
  isLoadingMessages?: boolean;
  /** Superuser admin read-only viewer */
  readOnly?: boolean;
  chatGroupId?: string | null;
  initialWelcomeInput?: string | null;
  connections?: Integration[] | Promise<Integration[]>;
  projects?: MentionableProject[] | Promise<MentionableProject[]>;
  onSnapshotChange?: (snapshot: {
    messages: Message[];
    todos: TodoItem[];
  }) => void;
  welcomeData?: {
    userId: string | null;
    userName: string | null;
    allApps: WorkerScriptWithCreator[] | Promise<WorkerScriptWithCreator[]>;
    connections: Integration[] | Promise<Integration[]>;
    projects: MentionableProject[] | Promise<MentionableProject[]>;
    recentThreads: Thread[] | Promise<Thread[]>;
    renderedAt: number;
    group?: GroupNewChatPayload;
  };
}

type CompletedTurnMetadata = {
  durationMs: number;
  completedAtMs: number;
};

interface CreditPacksResourceData {
  packs: TopUpDialogPack[];
  canTopUp: boolean;
  unavailableReason?: string | null;
}

type BillingCreditStatusResourceData =
  | {
      ok: true;
      billingCreditStatus: BillingCreditStatus | null;
    }
  | {
      ok: false;
      error?: string;
    };

function isPromiseLike<T>(value: T | Promise<T> | undefined): value is Promise<T> {
  return typeof (value as Promise<T> | undefined)?.then === "function";
}

const EMPTY_WORKER_APPS: WorkerScriptWithCreator[] = [];
const EMPTY_INTEGRATIONS: Integration[] = [];
const EMPTY_MENTION_PROJECTS: MentionableProject[] = [];
const EMPTY_RECENT_THREADS: Thread[] = [];

function resolveSelectedThreadModel(args: {
  threadId?: string;
  threadModel?: LlmModel | null;
  allowedThreadModels?: LlmModel[] | null;
  llmProvider?: LlmProvider | null;
  availableThreadModels: ReadonlyArray<ModelCatalogEntry>;
  effectivePickerDefaultModel: LlmModel | null;
  hasEffectivePickerDefault: boolean;
  recentModel?: LlmModel | null;
}): LlmModel {
  const availableModelIds = new Set(
    args.availableThreadModels.map((entry) => entry.id),
  );
  const threadModelIsAvailable =
    Boolean(args.threadModel) && availableModelIds.has(args.threadModel!);

  if (args.threadId && args.threadModel && threadModelIsAvailable) {
    return args.threadModel;
  }

  const resolvedModel = resolveDefaultModelForChat({
    effectiveDefaultModel: args.hasEffectivePickerDefault
      ? args.effectivePickerDefaultModel
      : null,
    recentModel: args.recentModel,
    fallbackModel: getDefaultLlmModel(args.llmProvider),
    visibleCatalog: args.availableThreadModels,
  });

  return (
    resolvedModel ??
    (threadModelIsAvailable ? args.threadModel : null) ??
    args.allowedThreadModels?.[0] ??
    getDefaultLlmModel(args.llmProvider)
  );
}

function dispatchLocalThreadStatus(
  threadId: string | null | undefined,
  status: "idle" | "running",
  options: {
    latestUserMessage?: string | null;
    latestUserMessageAt?: number | null;
    firstUserMessage?: string | null;
    runningActivityText?: string | null;
    runningActivityAt?: number | null;
    runningStartedAt?: number | null;
  } = {},
): void {
  if (typeof window === "undefined" || !threadId) return;
  window.dispatchEvent(
    new CustomEvent("camelai:thread-status", {
      detail: { threadId, status, ...options },
    }),
  );
}

function dispatchLocalThreadSummaryUpdate(
  threadId: string | null | undefined,
  patch: {
    title?: string;
    model?: LlmModel;
    updatedAt?: number;
  },
): void {
  if (typeof window === "undefined" || !threadId) return;
  const updatedAt =
    typeof patch.updatedAt === "number" && Number.isFinite(patch.updatedAt)
      ? patch.updatedAt
      : Date.now();
  window.dispatchEvent(
    new CustomEvent("camelai:thread-status", {
      detail: { threadId, ...patch, updatedAt },
    }),
  );
}

function isChatGroupAvatarStatus(value: unknown): value is ChatGroupAvatarStatus {
  return (
    value === "pending" ||
    value === "generated" ||
    value === "user" ||
    value === "fallback"
  );
}

function isChatGroupAvatar(value: unknown): value is ChatGroupAvatar {
  if (!value || typeof value !== "object") return false;
  const avatar = value as { color?: unknown; content?: unknown; status?: unknown };
  return (
    typeof avatar.color === "string" &&
    typeof avatar.content === "string" &&
    (avatar.status === undefined || isChatGroupAvatarStatus(avatar.status))
  );
}

function dispatchLocalChatGroupAvatarUpdate(
  threadId: string | null | undefined,
  groupId: string | null | undefined,
  avatar: ChatGroupAvatar | null | undefined,
): void {
  if (typeof window === "undefined" || !threadId || !groupId || !avatar) return;
  window.dispatchEvent(
    new CustomEvent("camelai:chat-group-avatar", {
      detail: {
        threadId,
        groupId,
        avatar,
        updatedAt: Date.now(),
      },
    }),
  );
}

function messagesHaveSameContent(left: Message[], right: Message[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const leftMessage = left[index];
    const rightMessage = right[index];
    if (
      leftMessage.id !== rightMessage.id ||
      leftMessage.role !== rightMessage.role ||
      leftMessage.created_at !== rightMessage.created_at ||
      leftMessage.isStreaming !== rightMessage.isStreaming ||
      leftMessage.isMeta !== rightMessage.isMeta ||
      leftMessage.sourceToolUseID !== rightMessage.sourceToolUseID ||
      leftMessage.isCompactSummary !== rightMessage.isCompactSummary ||
      JSON.stringify(leftMessage.content) !== JSON.stringify(rightMessage.content)
    ) {
      return false;
    }
  }
  return true;
}

function hasUserOrAssistantMessage(messages: Message[]): boolean {
  return messages.some(
    (message) =>
      (message.role === "user" || message.role === "assistant") &&
      !message.isMeta,
  );
}

function isComposerVisiblyEmpty(
  text: string,
  attachments: Attachment[],
): boolean {
  return text.trim().length === 0 && attachments.length === 0;
}

function areDraftAttachmentsEqual(
  left: Attachment[],
  right: Attachment[],
): boolean {
  const leftSerialized = serializeAttachments(left);
  const rightSerialized = serializeAttachments(right);

  if (leftSerialized.length !== rightSerialized.length) {
    return false;
  }

  return leftSerialized.every((attachment, index) => {
    const other = rightSerialized[index];
    return (
      attachment.id === other.id &&
      attachment.name === other.name &&
      attachment.path === other.path &&
      attachment.size === other.size &&
      attachment.contentType === other.contentType &&
      attachment.originalName === other.originalName &&
      attachment.kind === other.kind &&
      attachment.sourceThreadId === other.sourceThreadId &&
      attachment.sourceTitle === other.sourceTitle &&
      attachment.snippet === other.snippet
    );
  });
}

function isSubmittedDraftStillVisible(
  currentText: string,
  currentAttachments: Attachment[],
  submittedText: string,
  submittedAttachments: Attachment[],
): boolean {
  return (
    currentText === submittedText &&
    areDraftAttachmentsEqual(currentAttachments, submittedAttachments)
  );
}

interface PendingDeliveryDraft {
  workspaceId: string;
  threadId: string | null;
  clientMessageId: string;
  text: string;
  attachments: Attachment[];
  acceptedAt: number | null;
}

function pendingDeliveryDraftFromStored(
  workspaceId: string,
  threadId: string | null,
  draft: DeliveryDraftData,
): PendingDeliveryDraft {
  return {
    workspaceId,
    threadId,
    clientMessageId: draft.clientMessageId,
    text: draft.text,
    attachments: draft.attachments,
    acceptedAt: draft.acceptedAt,
  };
}

function getCompletedAttachments(attachments: Attachment[]): Attachment[] {
  return attachments.filter((attachment) => attachment.status === "complete");
}

function buildMessageContent(text: string, attachments: Attachment[]): string {
  return appendAttachmentReferences(
    text,
    getCompletedAttachments(attachments).map((attachment) => ({
      path: attachment.path,
      kind:
        attachment.kind === "transcript"
          ? "generated_transcript"
          : "user_upload",
      sourceThreadId: attachment.sourceThreadId,
      sourceTitle: attachment.sourceTitle,
    })),
  );
}

function sanitizeGeneratedFilename(value: string): string {
  const basename = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return basename || "chat";
}

/**
 * User-authored messages that should anchor the page-style spacer animation.
 * Slash commands count; compact summaries and synthetic stdout/interrupt rows do not.
 */
function isUserTurnAnchorMessage(msg: Message): boolean {
  if (msg.role !== "user" || msg.isCompactSummary) return false;
  if (isInterruptMessage(msg.content)) return false;
  if (parseLocalCommandStdout(msg.content)) return false;
  return true;
}

const STREAM_MESSAGE_RENDER_THROTTLE_MS = 50;

const CHAT_SCROLL_CONTAINER_STYLE = {
  overflowAnchor: "none",
} as CSSProperties;

export default function Chat({
  threadId,
  workspaceId,
  initialMessages,
  initialTodos = [],
  threadModel,
  llmProvider,
  allowedThreadModels,
  effectivePickerDefaultModel = null,
  hasEffectivePickerDefault = false,
  isOrgAdmin = false,
  recentModelScope,
  billingCreditStatus,
  initialError,
  newChatActionError,
  experimentalSettings,
  initialPreviewTabs,
  initialActiveTabId,
  pendingFirstTurn = false,
  hostname,
  orgSlug,
  isLoadingMessages = false,
  readOnly = false,
  chatGroupId = null,
  initialWelcomeInput,
  connections,
  projects,
  onSnapshotChange,
  welcomeData,
}: ChatProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const locationPathname = location.pathname;
  const locationSearch = location.search;
  const locationHash = location.hash;
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const submit = useSubmit();
  const chatGroupsContext = useOptionalChatGroups();
  const updateThreadModelFetcher = useFetcher<{
    thread?: {
      id: string;
      model: LlmModel;
      updated_at: number;
    };
    error?: string;
  }>();
  const creditPacksFetcher = useFetcher<CreditPacksResourceData>();
  const billingStatusFetcher = useFetcher<BillingCreditStatusResourceData>();
  const mentionSourcesFetcher = useFetcher<{
    connections?: Integration[];
    projects?: MentionableProject[];
    error?: string;
  }>();
  const { user, currentWorkspace, currentOrg, orgs } = useAuthData();
  const isMobile = useIsMobile();
  const resolvedWorkspaceId = readOnly
    ? workspaceId
    : (currentWorkspace?.id ?? workspaceId);
  const isSubmittingNewThread =
    navigation.state !== "idle" &&
    navigation.formData?.get("intent") === "createThreadAndStart";
  // Anchor to the last message when opening a thread that already has messages
  // (the welcome composer clears its own draft on submit; see startNewChat).
  const shouldAnchorToLastMessage =
    initialMessages && initialMessages.length > 0;

  // Parse initial messages once. The first user message of a new thread is part
  // of the persisted transcript (the new-chat action awaits the DO accepting and
  // persisting it before navigating here), so there is no optimistic placeholder.
  const parsedInitialMessages = useMemo(
    () =>
      (initialMessages ?? []).map((msg) => ({
        ...msg,
        content: parseMessageContent(msg.content),
      })),
    [initialMessages],
  );
  const initialPreviewSession = useMemo(
    () =>
      normalizePreviewSessionState(
        initialPreviewTabs,
        initialActiveTabId,
        null,
      ),
    [initialPreviewTabs, initialActiveTabId],
  );

  // Local state for messages, streaming, and loading. `messages` holds only
  // committed (finalized) history and is set immediately; the throttling now
  // lives on the live overlay below.
  const {
    state: messages,
    stateRef: messagesRef,
    setImmediate: setMessages,
  } = useBufferedState(parsedInitialMessages, STREAM_MESSAGE_RENDER_THROTTLE_MS);
  const [completedTurns, setCompletedTurns] = useState<
    Map<string, CompletedTurnMetadata>
  >(() => new Map());
  const [freshlyCompletedTurnId, setFreshlyCompletedTurnId] = useState<
    string | null
  >(null);
  const [loading, setLoading] = useState(false);
  const [agentIsStreaming, setAgentIsStreamingState] = useState(false);
  const [topUpOpen, setTopUpOpen] = useState(false);
  const [currentBillingCreditStatus, setCurrentBillingCreditStatus] =
    useState<BillingCreditStatus | null>(() => billingCreditStatus ?? null);
  const [pendingMessages, setPendingMessagesState] = useState<Message[]>([]);
  // The current turn's assistant/tool messages, pushed whole from the server
  // and replaced wholesale on every Agent-state update; overlaid on `messages`
  // at render time. Buffered so the per-token stream throttles re-renders, with
  // an immediate flush at turn boundaries. The ref always tracks the latest
  // snapshot (both setters update it) so folding stays exact.
  const {
    state: liveOverlay,
    stateRef: liveOverlayRef,
    setImmediate: setLiveOverlayImmediate,
    setBuffered: setLiveOverlayBuffered,
    flush: flushLiveOverlay,
  } = useBufferedState<Message[]>([], STREAM_MESSAGE_RENDER_THROTTLE_MS);
  const [currentTodos, setCurrentTodos] = useState<TodoItem[]>(initialTodos);

  useEffect(() => {
    if (!threadId || readOnly) return;
    onSnapshotChange?.({
      messages,
      todos: currentTodos,
    });
  }, [currentTodos, messages, onSnapshotChange, readOnly, threadId]);
  const [pendingQuestion, setPendingQuestion] =
    useState<AskUserQuestionData | null>(null);
  const optimisticallyAnsweredQuestionIdRef = useRef<string | null>(null);
  const currentChatPath = useMemo(
    () => `${locationPathname}${locationSearch}${locationHash}`,
    [locationHash, locationPathname, locationSearch],
  );
  const lastHandledCheckoutKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const searchParams = new URLSearchParams(locationSearch);
    const checkoutStatus = searchParams.get("checkout");
    if (!checkoutStatus) return;
    const checkoutKey = `${locationPathname}${locationSearch}${locationHash}`;
    if (lastHandledCheckoutKeyRef.current === checkoutKey) return;
    lastHandledCheckoutKeyRef.current = checkoutKey;

    if (checkoutStatus === "success") {
      toast.success("Credits added");
    } else if (checkoutStatus === "cancelled") {
      toast.message("Credit checkout cancelled");
    }

    const nextParams = new URLSearchParams(searchParams);
    nextParams.delete("checkout");
    const nextSearch = nextParams.toString();
    navigate(
      `${locationPathname}${nextSearch ? `?${nextSearch}` : ""}${locationHash}`,
      { replace: true },
    );
  }, [locationHash, locationPathname, locationSearch, navigate]);

  useEffect(() => {
    if (!initialWelcomeInput) {
      return;
    }

    setWelcomeInput((current) => {
      const shouldApply =
        current.trim().length === 0 ||
        current === lastAppliedWelcomeInputRef.current;

      if (!shouldApply) {
        return current;
      }

      lastAppliedWelcomeInputRef.current = initialWelcomeInput;
      return initialWelcomeInput;
    });
  }, [initialWelcomeInput]);

  useEffect(() => {
    if (threadId) {
      return;
    }
    if (!locationSearch.includes("prompt_key=")) {
      return;
    }

    const url = new URL(window.location.href);
    if (!url.searchParams.has("prompt_key")) {
      return;
    }

    url.searchParams.delete("prompt_key");
    window.history.replaceState(
      null,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  }, [locationSearch, threadId]);

  const previousWelcomeWorkspaceIdRef = useRef<string | null>(
    resolvedWorkspaceId ?? null,
  );

  useEffect(() => {
    if (threadId || readOnly) {
      previousWelcomeWorkspaceIdRef.current = resolvedWorkspaceId ?? null;
      return;
    }

    const nextWorkspaceId = resolvedWorkspaceId ?? null;
    if (previousWelcomeWorkspaceIdRef.current === nextWorkspaceId) {
      return;
    }

    previousWelcomeWorkspaceIdRef.current = nextWorkspaceId;
    pendingDeliveryDraftRef.current = null;
    skipNextEmptyDraftSaveRef.current = false;

    const nextDraft = initialWelcomeInput
      ? null
      : loadDraft(nextWorkspaceId, null);
    setWelcomeInput(initialWelcomeInput ?? nextDraft?.text ?? "");
    setAttachments(nextDraft?.attachments ?? []);
  }, [initialWelcomeInput, readOnly, resolvedWorkspaceId, threadId]);

  // Compaction in-progress indicator
  const [isCompacting, setIsCompacting] = useState(false);
  // Track compaction content block streaming (compaction summary arrives as a
  // content block of type 'compaction' with 'compaction_delta' deltas)
  const isInCompactionBlockRef = useRef(false);
  const compactionContentRef = useRef("");
  const hasCapturedCompactionSummaryRef = useRef(false);
  const pendingCompactionPlaceholderIdRef = useRef<string | null>(null);
  const queuedManualCompactionsRef = useRef(0);
  const activeManualCompactionTurnRef = useRef(false);
  const isAutoCompactingRef = useRef(false);
  // ID of the assistant message that was active when compaction started.
  // Used to suppress finalized visuals until compaction is complete.
  const compactingPriorMessageIdRef = useRef<string | null>(null);
  const [compactingPriorMessageId, setCompactingPriorMessageId] = useState<
    string | null
  >(null);
  const syncCompactionIndicator = useCallback(() => {
    const shouldShowIndicator =
      activeManualCompactionTurnRef.current ||
      queuedManualCompactionsRef.current > 0 ||
      isAutoCompactingRef.current;
    setIsCompacting(shouldShowIndicator);
  }, [setIsCompacting]);
  const queueManualCompaction = useCallback(() => {
    queuedManualCompactionsRef.current += 1;
    syncCompactionIndicator();
  }, [syncCompactionIndicator]);
  const startQueuedManualCompactionIfNeeded = useCallback(() => {
    if (
      activeManualCompactionTurnRef.current ||
      queuedManualCompactionsRef.current <= 0
    ) {
      return;
    }
    queuedManualCompactionsRef.current -= 1;
    activeManualCompactionTurnRef.current = true;
    syncCompactionIndicator();
  }, [syncCompactionIndicator]);
  const completeActiveManualCompaction = useCallback(() => {
    if (activeManualCompactionTurnRef.current) {
      activeManualCompactionTurnRef.current = false;
    } else if (queuedManualCompactionsRef.current > 0) {
      // Some reconnect/replay paths can miss `system/init` for the compact turn.
      // If completion arrives without an active turn, consume one queued entry.
      queuedManualCompactionsRef.current -= 1;
    }
    syncCompactionIndicator();
  }, [syncCompactionIndicator]);
  const clearManualCompactionQueue = useCallback(() => {
    activeManualCompactionTurnRef.current = false;
    queuedManualCompactionsRef.current = 0;
    syncCompactionIndicator();
  }, [syncCompactionIndicator]);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // Committed history overlaid with the live turn for rendering. `messages`
  // itself stays finalized-only so the streaming entry lives solely in the
  // overlay until it is folded in on completion.
  const displayMessages = useMemo(
    () => mergeOverlay(messages, liveOverlay),
    [messages, liveOverlay],
  );
  const normalizedMessages = useMemo(
    () =>
      mergeTaskNotifications(
        mergeTeammateMessages(normalizeToolResultMessages(displayMessages)),
      ),
    [displayMessages],
  );
  const visibleMessages = useMemo(
    () =>
      normalizedMessages.filter(
        (message) => !message.isMeta && !message.sourceToolUseID,
      ),
    [normalizedMessages],
  );

  // Refs to track current state for use in callbacks (avoids stale closures)
  const agentIsStreamingRef = useRef(false);
  const completedTurnsRef = useRef<Map<string, CompletedTurnMetadata>>(
    new Map(),
  );
  // The most recent completed turn already applied to completedTurns, so a
  // reconnect carrying the same lastCompletedTurn doesn't replay it.
  const lastAppliedCompletedTurnIdRef = useRef<string | null>(null);
  // The most recent terminal error already surfaced, so the state-driven error
  // is shown exactly once even across re-renders/reconnects.
  const lastAppliedErrorIdRef = useRef<string | null>(null);
  const pendingMessagesRef = useRef(pendingMessages);
  const acceptedPendingMessageIdsRef = useRef<Set<string>>(new Set());
  // False until the Agent socket has opened once for this thread. A later open is a
  // reconnect, after which we revalidate committed history so a turn that finished
  // while we were disconnected reloads its final messages (the live overlay only
  // carries the in-flight turn, so an idle reconnect would otherwise show the frozen
  // pre-disconnect tail). Reset when the thread changes.
  const hasAgentConnectedRef = useRef(false);
  const pendingThreadContextRef = useRef({
    workspaceId: resolvedWorkspaceId,
    threadId,
    readOnly,
  });
  pendingThreadContextRef.current = {
    workspaceId: resolvedWorkspaceId,
    threadId,
    readOnly,
  };

  const prevInitialMessagesRef = useRef(initialMessages);
  const prevInitialTodosRef = useRef(initialTodos);
  const hasSyncedInitialPreviewRef = useRef(false);
  const previousPreviewThreadIdRef = useRef(threadId);

  const setAgentIsStreaming = useCallback((value: boolean) => {
    agentIsStreamingRef.current = value;
    setAgentIsStreamingState(value);
  }, []);

  const setPendingMessages = useCallback(
    (updater: Message[] | ((prev: Message[]) => Message[])) => {
      const next =
        typeof updater === "function"
          ? updater(pendingMessagesRef.current)
          : updater;
      pendingMessagesRef.current = next;
      setPendingMessagesState(next);
    },
    [],
  );

  useLayoutEffect(() => {
    const initialMessagesChanged =
      initialMessages !== prevInitialMessagesRef.current;
    if (
      !initialMessagesChanged ||
      agentIsStreamingRef.current ||
      pendingMessagesRef.current.length > 0
    ) {
      return;
    }
    prevInitialMessagesRef.current = initialMessages;

    // Don't let an empty loader result (e.g. a revalidation that raced ahead of
    // persistence) clobber a conversation we already have locally.
    if (
      parsedInitialMessages.length === 0 &&
      hasUserOrAssistantMessage(messagesRef.current)
    ) {
      return;
    }
    setPendingMessages([]);
    if (messagesHaveSameContent(messagesRef.current, parsedInitialMessages)) {
      return;
    }
    setMessages(parsedInitialMessages);
  }, [
    initialMessages,
    parsedInitialMessages,
    readOnly,
    setMessages,
    setPendingMessages,
  ]);

  const isStreaming = agentIsStreaming;
  useLayoutEffect(() => {
    const initialTodosChanged = initialTodos !== prevInitialTodosRef.current;
    if (!initialTodosChanged) {
      return;
    }

    if (
      initialTodos.length === 0 ||
      currentTodos.length > 0 ||
      loading ||
      isStreaming ||
      pendingMessagesRef.current.length > 0
    ) {
      return;
    }
    prevInitialTodosRef.current = initialTodos;
    setCurrentTodos(initialTodos);
  }, [agentIsStreaming, currentTodos.length, initialTodos, isStreaming, loading]);

  const activeAssistantMessageId = useMemo(() => {
    // The streaming message lives in the overlay carrying isStreaming; scan for
    // it rather than tracking a separate id.
    for (let i = displayMessages.length - 1; i >= 0; i--) {
      const msg = displayMessages[i];
      if (msg.role === "assistant" && msg.isStreaming) return msg.id;
    }
    return null;
  }, [displayMessages]);
  const activeThreadRunningState = useMemo(
    () => getThreadRunningState(chatGroupsContext?.groups, threadId ?? null),
    [chatGroupsContext?.groups, threadId],
  );
  // assistantTurnActive / showGlobalAssistantIndicator are defined below, after
  // isAwaitingAssistant, so a freshly-started new chat (pendingFirstTurn) counts
  // as an active turn during the cold-start gap too.
  const runningStartedAt = activeThreadRunningState.isRunning
    ? activeThreadRunningState.startedAt
    : null;
  const skillSheetsByToolId = useMemo(() => {
    const map = new Map<string, string>();
    for (const message of messages) {
      if (!message.sourceToolUseID) continue;
      const content =
        typeof message.content === "string"
          ? message.content
          : message.content
              .map((block) => (block?.type === "text" ? block.text : ""))
              .filter(Boolean)
              .join("\n\n");
      if (content) {
        map.set(message.sourceToolUseID, content);
      }
    }
    return map;
  }, [messages]);
  const [input, setInput] = useState("");
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<ChatApiErrorPresentation | null>(() =>
    initialError
      ? getChatApiErrorPresentation(initialError, {
          llmProvider,
          threadModel,
        })
      : null,
  );
  const [welcomeInput, setWelcomeInput] = useState(
    () => initialWelcomeInput ?? "",
  );
  const appliedRecentModelScopeRef = useRef<string | null>(null);
  const optimisticThreadModelRef = useRef<{
    threadId: string;
    model: LlmModel;
  } | null>(null);
  const availableThreadModels = useMemo<ModelCatalogEntry[]>(() => {
    if (Array.isArray(allowedThreadModels)) {
      return modelCatalogEntriesForIds(allowedThreadModels);
    }

    const options = getVisibleLlmModelOptions(
      experimentalSettings,
      threadModel ?? getDefaultLlmModel(llmProvider),
      { orgProvider: llmProvider },
    );
    return modelCatalogEntriesForIds(options.map((option) => option.value));
  }, [
    allowedThreadModels,
    experimentalSettings,
    llmProvider,
    threadModel,
  ]);
  const availableThreadModelIds = useMemo(
    () => new Set(availableThreadModels.map((entry) => entry.id)),
    [availableThreadModels],
  );
  const shouldUseRecentModelFallback = !hasEffectivePickerDefault;
  const modelRecentScope = useMemo<RecentModelScope | null>(() => {
    if (readOnly) return null;
    if (!shouldUseRecentModelFallback) return null;
    if (recentModelScope) return recentModelScope;
    if (!currentOrg?.id || !resolvedWorkspaceId) return null;
    return { orgId: currentOrg.id, workspaceId: resolvedWorkspaceId };
  }, [
    currentOrg?.id,
    readOnly,
    recentModelScope,
    resolvedWorkspaceId,
    shouldUseRecentModelFallback,
  ]);
  const [selectedThreadModel, setSelectedThreadModel] = useState<LlmModel>(() =>
    resolveSelectedThreadModel({
      threadId,
      threadModel,
      allowedThreadModels,
      llmProvider,
      availableThreadModels,
      effectivePickerDefaultModel,
      hasEffectivePickerDefault,
    }),
  );
  const selectedThreadModelRef = useRef<LlmModel>(selectedThreadModel);
  const locationSearchRef = useRef(locationSearch);
  const lastBillingRefreshCompletionKeyRef = useRef<string | null>(null);
  const noModelsMessage =
    availableThreadModels.length === 0
      ? "No models are available. Ask an admin to add a model in Settings > Models."
      : null;

  useEffect(() => {
    setCurrentBillingCreditStatus(billingCreditStatus ?? null);
    lastBillingRefreshCompletionKeyRef.current = null;
  }, [billingCreditStatus]);

  useEffect(() => {
    selectedThreadModelRef.current = selectedThreadModel;
  }, [selectedThreadModel]);

  useEffect(() => {
    locationSearchRef.current = locationSearch;
  }, [locationSearch]);

  useEffect(() => {
    if (!billingStatusFetcher.data) return;
    if (!billingStatusFetcher.data.ok) return;
    setCurrentBillingCreditStatus(billingStatusFetcher.data.billingCreditStatus);
  }, [billingStatusFetcher.data]);

  const refreshBillingCreditStatusAfterTurn = useCallback(
    (completionKey: string | null | undefined) => {
      const normalizedCompletionKey = completionKey?.trim();
      if (!normalizedCompletionKey) return;
      if (
        lastBillingRefreshCompletionKeyRef.current === normalizedCompletionKey
      ) {
        return;
      }
      lastBillingRefreshCompletionKeyRef.current = normalizedCompletionKey;

      const params = new URLSearchParams();
      params.set("model", selectedThreadModelRef.current);
      const currentSearchParams = new URLSearchParams(
        locationSearchRef.current,
      );
      for (const key of ["devCreditState", "devChatError"]) {
        const value = currentSearchParams.get(key);
        if (value) params.set(key, value);
      }
      if (typeof billingStatusFetcher.load !== "function") return;
      billingStatusFetcher.load(
        `/api/billing/chat-credit-status?${params.toString()}`,
      );
    },
    [billingStatusFetcher],
  );

  const lastAppliedWelcomeInputRef = useRef(initialWelcomeInput ?? "");
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [forkingMessageId, setForkingMessageId] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>(
    () => [],
  );
  const [contextUsedPercent, setContextUsedPercent] = useState<number | null>(
    null,
  );
  const attachmentPreviewUrlsRef = useRef<Set<string>>(new Set());
  const inputRef = useRef(input);
  const welcomeInputRef = useRef(welcomeInput);
  const attachmentsRef = useRef(attachments);
  inputRef.current = input;
  welcomeInputRef.current = welcomeInput;
  attachmentsRef.current = attachments;
  const prevErrorRef = useRef<ChatApiErrorPresentation | null>(null);
  const skipNextEmptyDraftSaveRef = useRef(false);
  const pendingDeliveryDraftRef = useRef<PendingDeliveryDraft | null>(null);
  const pendingNewThreadSubmissionRef = useRef<{
    text: string;
    attachments: Attachment[];
  } | null>(null);
  const handledNewChatActionErrorRef = useRef<string | null>(null);
  const pendingDraftCountRef = useRef(0);
  const restoredDraftKeyRef = useRef<string | null>(null);
  const { saveDraft, flushDraft, clearDraft } = useDraftPersistence(
    resolvedWorkspaceId,
    threadId ?? null,
  );
  const [isDragOver, setIsDragOver] = useState(false);

  useEffect(() => {
    if (readOnly || !resolvedWorkspaceId) {
      return;
    }

    const restoreKey = `${resolvedWorkspaceId}:${threadId ?? "new"}:${initialWelcomeInput ?? ""}`;
    if (restoredDraftKeyRef.current === restoreKey) {
      return;
    }
    restoredDraftKeyRef.current = restoreKey;

    const draft = threadId
      ? loadDraft(resolvedWorkspaceId, threadId)
      : initialWelcomeInput
        ? null
        : loadDraft(resolvedWorkspaceId, null);
    if (!draft) {
      return;
    }

    if (threadId) {
      if (!isComposerVisiblyEmpty(inputRef.current, attachmentsRef.current)) {
        return;
      }
      skipNextEmptyDraftSaveRef.current = true;
      inputRef.current = draft.text;
      attachmentsRef.current = draft.attachments;
      setInput(draft.text);
      setAttachments(draft.attachments);
      return;
    }

    if (!isComposerVisiblyEmpty(welcomeInputRef.current, attachmentsRef.current)) {
      return;
    }
    skipNextEmptyDraftSaveRef.current = true;
    welcomeInputRef.current = draft.text;
    attachmentsRef.current = draft.attachments;
    setWelcomeInput(draft.text);
    setAttachments(draft.attachments);
  }, [initialWelcomeInput, readOnly, resolvedWorkspaceId, threadId]);

  useLayoutEffect(() => {
    setError(
      initialError
        ? getChatApiErrorPresentation(initialError, {
            llmProvider,
            threadModel,
          })
        : null,
    );
  }, [initialError, llmProvider, threadModel]);

  useLayoutEffect(() => {
    if (
      !newChatActionError ||
      handledNewChatActionErrorRef.current === newChatActionError
    ) {
      return;
    }
    handledNewChatActionErrorRef.current = newChatActionError;

    const pendingSubmission = pendingNewThreadSubmissionRef.current;
    pendingNewThreadSubmissionRef.current = null;
    if (!pendingSubmission || threadId || readOnly) {
      return;
    }

    if (
      isComposerVisiblyEmpty(welcomeInputRef.current, attachmentsRef.current)
    ) {
      setWelcomeInput(pendingSubmission.text);
      setAttachments(pendingSubmission.attachments);
    }
    writeDraft(
      resolvedWorkspaceId,
      null,
      pendingSubmission.text,
      pendingSubmission.attachments,
    );
  }, [
    newChatActionError,
    readOnly,
    resolvedWorkspaceId,
    threadId,
  ]);

  const [previewTabs, setPreviewTabs] = useState<PreviewTab[]>(
    () => initialPreviewSession.tabs,
  );
  const [activeTabId, setActiveTabId] = useState<string | null>(
    () => initialPreviewSession.activeTabId,
  );
  const previewTabsRef = useRef<PreviewTab[]>(previewTabs);
  const activeTabIdRef = useRef<string | null>(activeTabId);
  previewTabsRef.current = previewTabs;
  activeTabIdRef.current = activeTabId;
  const activeTab = useMemo(
    () => previewTabs.find((tab) => tab.id === activeTabId) ?? null,
    [previewTabs, activeTabId],
  );
  const previewTarget = activeTab?.target ?? null;
  const [tabIframeKeys, setTabIframeKeys] = useState<Record<string, number>>(
    {},
  );
  const [tabFilePreviewKeys, setTabFilePreviewKeys] = useState<
    Record<string, number>
  >({});
  const [tabNotebookViewModes, setTabNotebookViewModes] = useState<
    Record<string, "report" | "notebook">
  >({});
  const [tabFileViewModes, setTabFileViewModes] = useState<
    Record<string, "preview" | "source">
  >({});
  const tabFileViewModesRef = useRef<Record<string, "preview" | "source">>(
    tabFileViewModes,
  );
  tabFileViewModesRef.current = tabFileViewModes;
  const [tabNotebookStates, setTabNotebookStates] = useState<
    Record<string, NotebookPreviewLoadState>
  >({});
  const [tabNotebookPdfExporting, setTabNotebookPdfExporting] = useState<
    Record<string, boolean>
  >({});
  const [tabAppLoading, setTabAppLoading] = useState<Record<string, boolean>>(
    {},
  );
  const notebookViewMode = activeTabId
    ? (tabNotebookViewModes[activeTabId] ?? "report")
    : "report";
  const fileViewMode = activeTabId
    ? (tabFileViewModes[activeTabId] ?? "preview")
    : "preview";
  const activeNotebookState = activeTabId
    ? (tabNotebookStates[activeTabId] ?? DEFAULT_NOTEBOOK_PREVIEW_STATE)
    : DEFAULT_NOTEBOOK_PREVIEW_STATE;
  const isNotebookPdfExporting = activeTabId
    ? Boolean(tabNotebookPdfExporting[activeTabId])
    : false;
  const [mobileView, setMobileView] = useState<"chat" | "preview">("chat");
  const previewVersionRef = useRef<number>(0);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const messageColumnRef = useRef<HTMLDivElement>(null);
  const lastUserMessageRef = useRef<HTMLDivElement>(null);
  const assistantMeasureRef = useRef<HTMLDivElement>(null);
  const assistantPendingMeasureRef = useRef<HTMLDivElement>(null);
  const assistantSpacerRef = useRef<HTMLDivElement>(null);
  const spacerHeightRef = useRef(0);
  const spacerMeasureFrameRef = useRef<number | null>(null);
  const initialScrollDoneRef = useRef(false);
  const stickToBottomRef = useRef(true);
  const forceScrollOnNextUpdate = useRef(false);
  const chatAgentRef = useRef<ChatAgentClient | null>(null);
  const optimisticallyClearedConnectionSetupRequestIdRef = useRef<string | null>(
    null,
  );
  const {
    connectionSetupPrompt,
    handleConnectionSetupCancel: handleConnectionSetupCancelBase,
    handleConnectionSetupResponse,
    setConnectionSetupPrompt,
  } = useConnectionSetupResponse({
    chatAgentRef,
  });
  const handleConnectionSetupCancel = useCallback(() => {
    if (connectionSetupPrompt?.requestId) {
      optimisticallyClearedConnectionSetupRequestIdRef.current =
        connectionSetupPrompt.requestId;
    }
    handleConnectionSetupCancelBase();
  }, [connectionSetupPrompt?.requestId, handleConnectionSetupCancelBase]);
  const lastRunnerModelSelectionRef = useRef<string | null>(null);
  const iframeRefreshTimeoutsRef = useRef<
    Record<string, ReturnType<typeof setTimeout>>
  >({});
  const iframeRetryCountsRef = useRef<Record<string, number>>({});
  const iframeRetryTimeoutsRef = useRef<
    Record<string, ReturnType<typeof setTimeout>>
  >({});
  const composerTextareaRef = useRef<HTMLTextAreaElement>(null);
  const fallbackRenderedAtRef = useRef<number>(Date.now());

  useLayoutEffect(() => {
    initialScrollDoneRef.current = false;
    stickToBottomRef.current = true;
    setCurrentTodos(initialTodos);
    setPendingQuestion(null);
    setContextUsedPercent(null);
    setAgentIsStreaming(false);
    lastAppliedCompletedTurnIdRef.current = null;
    lastAppliedErrorIdRef.current = null;
    completedTurnsRef.current = new Map();
    setCompletedTurns(new Map());
    setFreshlyCompletedTurnId(null);
    compactingPriorMessageIdRef.current = null;
    setCompactingPriorMessageId(null);
  }, [threadId]);

  const clearAllIframeRefreshTimeouts = useCallback(() => {
    for (const timeout of Object.values(iframeRefreshTimeoutsRef.current)) {
      clearTimeout(timeout);
    }
    iframeRefreshTimeoutsRef.current = {};
    for (const timeout of Object.values(iframeRetryTimeoutsRef.current)) {
      clearTimeout(timeout);
    }
    iframeRetryTimeoutsRef.current = {};
    iframeRetryCountsRef.current = {};
  }, []);

  const setLocalPreviewSessionState = useCallback(
    (nextTabs: PreviewTab[], nextActiveTabId: string | null) => {
      previewTabsRef.current = nextTabs;
      setPreviewTabs(nextTabs);
      activeTabIdRef.current = nextActiveTabId;
      setActiveTabId(nextActiveTabId);
    },
    [],
  );

  useLayoutEffect(() => {
    const nextTabs = threadId ? initialPreviewSession.tabs : [];
    const nextActiveTabId = threadId ? initialPreviewSession.activeTabId : null;
    const didThreadChange = previousPreviewThreadIdRef.current !== threadId;
    previousPreviewThreadIdRef.current = threadId;

    if (
      !didThreadChange &&
      arePreviewSessionsSemanticallyEqual(
        previewTabsRef.current,
        activeTabIdRef.current,
        nextTabs,
        nextActiveTabId,
      )
    ) {
      if (
        !arePreviewSessionsExactlyEqual(
          previewTabsRef.current,
          activeTabIdRef.current,
          nextTabs,
          nextActiveTabId,
        )
      ) {
        setLocalPreviewSessionState(nextTabs, nextActiveTabId);
      }
      return;
    }

    previewTabsRef.current = nextTabs;
    setPreviewTabs(nextTabs);
    activeTabIdRef.current = nextActiveTabId;
    setActiveTabId(nextActiveTabId);

    setTabIframeKeys({});
    setTabFilePreviewKeys({});
    setTabNotebookViewModes({});
    setTabFileViewModes({});
    setTabNotebookStates({});
    setTabNotebookPdfExporting({});
    setTabAppLoading({});
    previewVersionRef.current = 0;
    clearAllIframeRefreshTimeouts();
    setMobileView("chat");
  }, [
    threadId,
    initialPreviewSession.tabs,
    initialPreviewSession.activeTabId,
    clearAllIframeRefreshTimeouts,
    setLocalPreviewSessionState,
  ]);

  // Retry iframe on transient errors (404/500/503) during deploy.
  // Dispatcher error pages postMessage({ type: 'chiridion-preview-error', status }) to parent.
  const IFRAME_MAX_RETRIES = 3;
  const IFRAME_RETRY_DELAY_MS = 2000;
  useEffect(() => {
    const canMatchAppOrigin = Boolean(hostname);

    function handlePreviewError(event: MessageEvent) {
      if (
        !event.data ||
        event.data.type !== "chiridion-preview-error" ||
        typeof event.data.status !== "number"
      )
        return;
      const status = event.data.status as number;
      if (status !== 404 && status !== 500 && status !== 503) return;

      // Match the message origin to an app tab
      const tabs = previewTabsRef.current;
      const matchedTab = canMatchAppOrigin
        ? tabs.find((tab) => {
            if (tab.target.kind !== "app") return false;
            const s = tab.target.scriptName;
            const expectedOrigin = new URL(
              getAppIframeUrl(s, hostname, orgSlug),
            ).origin;
            return event.origin === expectedOrigin;
          })
        : null;
      const tabId = matchedTab?.id ?? activeTabIdRef.current;
      if (!tabId) return;
      if (tabId !== activeTabIdRef.current) return;

      const retries = iframeRetryCountsRef.current[tabId] ?? 0;
      if (retries >= IFRAME_MAX_RETRIES) return;
      if (iframeRetryTimeoutsRef.current[tabId]) return;

      iframeRetryCountsRef.current[tabId] = retries + 1;
      iframeRetryTimeoutsRef.current[tabId] = setTimeout(() => {
        delete iframeRetryTimeoutsRef.current[tabId];
        setTabIframeKeys((prev) => ({
          ...prev,
          [tabId]: (prev[tabId] ?? 0) + 1,
        }));
      }, IFRAME_RETRY_DELAY_MS);
    }

    window.addEventListener("message", handlePreviewError);
    return () => window.removeEventListener("message", handlePreviewError);
  }, [hostname, orgSlug]);

  const clearIframeTimersForTab = useCallback((tabId: string) => {
    const refreshTimeout = iframeRefreshTimeoutsRef.current[tabId];
    if (refreshTimeout) {
      clearTimeout(refreshTimeout);
      delete iframeRefreshTimeoutsRef.current[tabId];
    }
    const retryTimeout = iframeRetryTimeoutsRef.current[tabId];
    if (retryTimeout) {
      clearTimeout(retryTimeout);
      delete iframeRetryTimeoutsRef.current[tabId];
    }
    delete iframeRetryCountsRef.current[tabId];
    setTabAppLoading((prev) => {
      if (!(tabId in prev)) return prev;
      const next = { ...prev };
      delete next[tabId];
      return next;
    });
  }, []);

  useLayoutEffect(() => {
    for (const tabId of Object.keys(iframeRefreshTimeoutsRef.current)) {
      if (tabId !== activeTabId) clearIframeTimersForTab(tabId);
    }
    for (const tabId of Object.keys(iframeRetryTimeoutsRef.current)) {
      if (tabId !== activeTabId) clearIframeTimersForTab(tabId);
    }
  }, [activeTabId, clearIframeTimersForTab]);

  const revokeAttachmentPreviewUrl = useCallback((url?: string) => {
    if (!url) return;
    attachmentPreviewUrlsRef.current.delete(url);
    URL.revokeObjectURL(url);
  }, []);

  const appIsPublic =
    previewTarget?.kind === "app" ? previewTarget.isPublic : false;
  const setAppIsPublic = useCallback(
    (isPublic: boolean) => {
      if (!activeTabId) return;
      setPreviewTabs((prev) =>
        prev.map((tab) => {
          if (tab.id !== activeTabId || tab.target.kind !== "app") return tab;
          return {
            ...tab,
            target: {
              ...tab.target,
              isPublic,
            },
          };
        }),
      );
    },
    [activeTabId],
  );

  useEffect(() => {
    if (!currentTodos.length || isStreaming) return;
    const allComplete = currentTodos.every(
      (todo) => todo.status === "completed",
    );
    const timeout = setTimeout(
      () => {
        setCurrentTodos([]);
      },
      allComplete ? 1500 : 2000,
    );
    return () => clearTimeout(timeout);
  }, [currentTodos, isStreaming]);

  useEffect(() => {
    const optimistic = optimisticThreadModelRef.current;
    if (
      threadId &&
      optimistic?.threadId === threadId &&
      threadModel !== optimistic.model
    ) {
      return;
    }
    if (
      threadId &&
      optimistic?.threadId === threadId &&
      threadModel === optimistic.model
    ) {
      optimisticThreadModelRef.current = null;
    }
    const recentModel =
      !threadId && modelRecentScope ? getRecentModel(modelRecentScope) : null;
    setSelectedThreadModel(
      resolveSelectedThreadModel({
        threadId,
        threadModel,
        allowedThreadModels,
        llmProvider,
        availableThreadModels,
        effectivePickerDefaultModel,
        hasEffectivePickerDefault,
        recentModel,
      }),
    );
  }, [
    allowedThreadModels,
    availableThreadModels,
    effectivePickerDefaultModel,
    hasEffectivePickerDefault,
    llmProvider,
    modelRecentScope,
    threadId,
    threadModel,
  ]);

  // Track connection ID to ignore events from stale WebSocket instances
  // Ref to hold stable connect function for effect
  const resolvedWelcomeData = welcomeData ?? {
    userId: user?.id ?? null,
    userName: user?.name ?? null,
    allApps: EMPTY_WORKER_APPS,
    connections: EMPTY_INTEGRATIONS,
    projects: EMPTY_MENTION_PROJECTS,
    recentThreads: EMPTY_RECENT_THREADS,
    renderedAt: fallbackRenderedAtRef.current,
    group: undefined,
  };
  const rawMentionConnections = connections ?? resolvedWelcomeData.connections;
  const rawMentionProjects = projects ?? resolvedWelcomeData.projects;
  const [resolvedMentionConnections, setResolvedMentionConnections] = useState<
    Integration[]
  >(() => (Array.isArray(rawMentionConnections) ? rawMentionConnections : []));
  const [resolvedMentionProjects, setResolvedMentionProjects] = useState<
    MentionableProject[]
  >(() => (Array.isArray(rawMentionProjects) ? rawMentionProjects : []));
  useEffect(() => {
    if (Array.isArray(rawMentionConnections)) {
      setResolvedMentionConnections(rawMentionConnections);
      return;
    }
    if (!isPromiseLike(rawMentionConnections)) {
      setResolvedMentionConnections([]);
      return;
    }

    let cancelled = false;
    rawMentionConnections
      .then((nextConnections) => {
        if (!cancelled) setResolvedMentionConnections(nextConnections);
      })
      .catch(() => {
        if (!cancelled) setResolvedMentionConnections([]);
      });

    return () => {
      cancelled = true;
    };
  }, [rawMentionConnections]);
  useEffect(() => {
    if (Array.isArray(rawMentionProjects)) {
      setResolvedMentionProjects(rawMentionProjects);
      return;
    }
    if (!isPromiseLike(rawMentionProjects)) {
      setResolvedMentionProjects([]);
      return;
    }

    let cancelled = false;
    rawMentionProjects
      .then((nextProjects) => {
        if (!cancelled) setResolvedMentionProjects(nextProjects);
      })
      .catch(() => {
        if (!cancelled) setResolvedMentionProjects([]);
      });

    return () => {
      cancelled = true;
    };
  }, [rawMentionProjects]);
  const mentionEntities = useMemo<AtMentionEntity[]>(() => [
    ...resolvedMentionConnections.map((connection) => ({
      ...connection,
      kind: "connection" as const,
    })),
    ...resolvedMentionProjects,
  ], [resolvedMentionConnections, resolvedMentionProjects]);
  const mentionSlugMap = useMemo(
    () => buildSlugMap(mentionEntities),
    [mentionEntities],
  );
  const formatFilePathForCopy = useCallback(
    (target: CopyFilePathTarget) =>
      formatCopyFilePath(target, { mentionSlugMap }),
    [mentionSlugMap],
  );
  const visibleVmProjectReferences = useMemo(
    () => [
      ...collectVmProjectReferencesFromPreviewTabs(previewTabs),
      ...collectVmProjectReferencesFromMessages(visibleMessages),
    ],
    [previewTabs, visibleMessages],
  );
  const attemptedProjectMentionRefreshesRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    attemptedProjectMentionRefreshesRef.current.clear();
  }, [resolvedWorkspaceId, threadId]);
  useEffect(() => {
    if (!resolvedWorkspaceId) return;
    if (mentionSourcesFetcher.state !== "idle") return;

    for (const reference of visibleVmProjectReferences) {
      if (
        resolveProjectMentionSlug(reference.project, mentionSlugMap, {
          projectId: reference.projectId,
        })
      ) {
        continue;
      }

      const projectKey = normalizeProjectCopyLookupKey(reference.project);
      if (!projectKey) continue;
      if (attemptedProjectMentionRefreshesRef.current.has(projectKey)) {
        continue;
      }
      attemptedProjectMentionRefreshesRef.current.add(projectKey);
      mentionSourcesFetcher.load(
        `/api/workspaces/${encodeURIComponent(resolvedWorkspaceId)}/mentions`,
      );
      return;
    }
  }, [
    mentionSlugMap,
    mentionSourcesFetcher,
    resolvedWorkspaceId,
    threadId,
    visibleVmProjectReferences,
  ]);
  const lastMentionSourcesFetchAtRef = useRef(0);
  const handleMentionMenuOpenChange = useCallback((open: boolean) => {
    if (!open || !resolvedWorkspaceId) return;
    if (mentionSourcesFetcher.state !== "idle") return;
    const now = Date.now();
    if (now - lastMentionSourcesFetchAtRef.current < 15_000) return;
    lastMentionSourcesFetchAtRef.current = now;
    mentionSourcesFetcher.load(
      `/api/workspaces/${encodeURIComponent(resolvedWorkspaceId)}/mentions`,
    );
  }, [mentionSourcesFetcher, resolvedWorkspaceId]);
  useEffect(() => {
    const data = mentionSourcesFetcher.data;
    if (data && Array.isArray(data.connections)) {
      setResolvedMentionConnections(data.connections);
    }
    if (data && Array.isArray(data.projects)) {
      setResolvedMentionProjects(data.projects);
    }
  }, [mentionSourcesFetcher.data]);
  const preserveDraftBeforeOptimisticClear = useCallback(
    (
      clientMessageId: string,
      draftThreadId: string | null,
      text: string,
      nextAttachments: Attachment[],
    ) => {
      if (!resolvedWorkspaceId) {
        return;
      }

      if (draftThreadId === (threadId ?? null)) {
        flushDraft(text, nextAttachments);
      } else {
        writeDraft(resolvedWorkspaceId, draftThreadId, text, nextAttachments);
      }

      pendingDraftCountRef.current++;
      pendingDeliveryDraftRef.current = {
        workspaceId: resolvedWorkspaceId,
        threadId: draftThreadId,
        clientMessageId,
        text,
        attachments: nextAttachments,
        acceptedAt: null,
      };
      writeDeliveryDraft(
        resolvedWorkspaceId,
        draftThreadId,
        clientMessageId,
        text,
        nextAttachments,
      );
      skipNextEmptyDraftSaveRef.current = true;
    },
    [flushDraft, resolvedWorkspaceId, threadId],
  );

  const getStoredPendingDeliveryDraft = useCallback(() => {
    const context = pendingThreadContextRef.current;
    const workspaceId = context.workspaceId;
    const deliveryThreadId = context.threadId ?? null;
    if (!workspaceId) {
      return null;
    }

    const storedDraft = loadDeliveryDraft(workspaceId, deliveryThreadId);
    return storedDraft
      ? pendingDeliveryDraftFromStored(workspaceId, deliveryThreadId, storedDraft)
      : null;
  }, []);

  const syncNormalDraftAfterSubmitted = useCallback(
    (pendingDraft: PendingDeliveryDraft) => {
      const currentInput = inputRef.current;
      const currentAttachments = attachmentsRef.current;
      const canRemoveNormalDraft =
        isComposerVisiblyEmpty(currentInput, currentAttachments) ||
        isSubmittedDraftStillVisible(
          currentInput,
          currentAttachments,
          pendingDraft.text,
          pendingDraft.attachments,
        );

      if (canRemoveNormalDraft) {
        removeDraft(pendingDraft.workspaceId, pendingDraft.threadId);
        return;
      }

      writeDraft(
        pendingDraft.workspaceId,
        pendingDraft.threadId,
        currentInput,
        currentAttachments,
      );
    },
    [],
  );

  const markPendingDeliveryDraftAccepted = useCallback(
    (clientMessageId: string) => {
      acceptedPendingMessageIdsRef.current.add(clientMessageId);
      const pendingDraft = pendingDeliveryDraftRef.current;

      if (pendingDraft?.clientMessageId === clientMessageId) {
        const acceptedAt = Date.now();
        pendingDeliveryDraftRef.current = { ...pendingDraft, acceptedAt };
        writeDeliveryDraft(
          pendingDraft.workspaceId,
          pendingDraft.threadId,
          clientMessageId,
          pendingDraft.text,
          pendingDraft.attachments,
          acceptedAt,
        );
        syncNormalDraftAfterSubmitted(pendingDraft);
        return;
      }

      const context = pendingThreadContextRef.current;
      const workspaceId = context.workspaceId;
      const deliveryThreadId = context.threadId ?? null;
      if (!workspaceId) {
        return;
      }

      const storedDraft = markDeliveryDraftAccepted(
        workspaceId,
        deliveryThreadId,
        clientMessageId,
      );
      if (!storedDraft) {
        return;
      }

      syncNormalDraftAfterSubmitted(
        pendingDeliveryDraftFromStored(
          workspaceId,
          deliveryThreadId,
          storedDraft,
        ),
      );
    },
    [syncNormalDraftAfterSubmitted],
  );

  const clearPendingDeliveryDraft = useCallback(() => {
    const pendingDraft =
      pendingDeliveryDraftRef.current ?? getStoredPendingDeliveryDraft();
    if (!pendingDraft) {
      return;
    }

    if (pendingDeliveryDraftRef.current) {
      // If multiple sends are in flight (sentDuringStreaming), only clear the
      // draft backup once the last turn completes — otherwise an earlier result
      // would delete the backup that a later, still-in-flight turn needs.
      pendingDraftCountRef.current = Math.max(
        0,
        pendingDraftCountRef.current - 1,
      );
      if (pendingDraftCountRef.current > 0) {
        return;
      }
    }

    pendingDeliveryDraftRef.current = null;
    syncNormalDraftAfterSubmitted(pendingDraft);
    removeDeliveryDraft(pendingDraft.workspaceId, pendingDraft.threadId);
  }, [getStoredPendingDeliveryDraft, syncNormalDraftAfterSubmitted]);

  const restorePendingDeliveryDraft = useCallback(() => {
    const pendingDraft =
      pendingDeliveryDraftRef.current ?? getStoredPendingDeliveryDraft();
    pendingDeliveryDraftRef.current = null;
    pendingDraftCountRef.current = 0;

    if (!pendingDraft) {
      return;
    }

    if (
      !isComposerVisiblyEmpty(inputRef.current, attachmentsRef.current) &&
      !isSubmittedDraftStillVisible(
        inputRef.current,
        attachmentsRef.current,
        pendingDraft.text,
        pendingDraft.attachments,
      )
    ) {
      removeDeliveryDraft(pendingDraft.workspaceId, pendingDraft.threadId);
      return;
    }

    inputRef.current = pendingDraft.text;
    attachmentsRef.current = pendingDraft.attachments;
    setInput(pendingDraft.text);
    setAttachments(pendingDraft.attachments);
    writeDraft(
      pendingDraft.workspaceId,
      pendingDraft.threadId,
      pendingDraft.text,
      pendingDraft.attachments,
    );
    removeDeliveryDraft(pendingDraft.workspaceId, pendingDraft.threadId);
  }, [getStoredPendingDeliveryDraft]);

  const normalizeChatError = useCallback(
    (
      value: unknown,
      context: Partial<ChatApiErrorContext> = {},
    ): ChatApiErrorPresentation =>
      getChatApiErrorPresentation(value, {
        llmProvider,
        threadModel: selectedThreadModel,
        ...context,
      }),
    [llmProvider, selectedThreadModel],
  );

  const showChatError = useCallback(
    (value: unknown, context: Partial<ChatApiErrorContext> = {}) => {
      setError(normalizeChatError(value, context));
    },
    [normalizeChatError],
  );

  const isPendingMessageAccepted = useCallback((clientMessageId: string) => {
    if (acceptedPendingMessageIdsRef.current.has(clientMessageId)) {
      return true;
    }

    const pendingDraft = pendingDeliveryDraftRef.current;
    if (
      pendingDraft?.clientMessageId === clientMessageId &&
      pendingDraft.acceptedAt
    ) {
      return true;
    }

    const storedDraft = getStoredPendingDeliveryDraft();
    return Boolean(
      storedDraft?.clientMessageId === clientMessageId &&
        storedDraft.acceptedAt,
    );
  }, [getStoredPendingDeliveryDraft]);

  const getUnacceptedPendingUserMessages = useCallback(
    () =>
      pendingMessagesRef.current.filter((message) => {
        if (message.role !== "user") return false;
        const deliveryKey = message.clientMessageId ?? message.id;
        return !isPendingMessageAccepted(deliveryKey);
      }),
    [isPendingMessageAccepted],
  );

  const failPendingMessageDelivery = useCallback(
    (message: string, options?: { preserveReady?: boolean }): boolean => {
      const failedMessages = getUnacceptedPendingUserMessages();
      if (failedMessages.length === 0) {
        return false;
      }

      const failedIds = new Set(failedMessages.map((msg) => msg.id));
      const failedDeliveryKeys = new Set(
        failedMessages.map((msg) => msg.clientMessageId ?? msg.id),
      );
      setMessages((prev) => prev.filter((msg) => !failedIds.has(msg.id)));
      for (const deliveryKey of failedDeliveryKeys) {
        acceptedPendingMessageIdsRef.current.delete(deliveryKey);
      }
      const remainingPendingMessages = pendingMessagesRef.current.filter(
        (msg) => !failedIds.has(msg.id),
      );
      setPendingMessages(remainingPendingMessages);
      setLoading(
        remainingPendingMessages.length > 0 || agentIsStreamingRef.current,
      );
      if (!options?.preserveReady) {
        setReady(false);
      }
      if (remainingPendingMessages.length === 0) {
        dispatchLocalThreadStatus(
          pendingThreadContextRef.current.threadId,
          "idle",
        );
      }
      restorePendingDeliveryDraft();
      showChatError(message);
      return true;
    },
    [
      getUnacceptedPendingUserMessages,
      restorePendingDeliveryDraft,
      showChatError,
      setMessages,
      setPendingMessages,
    ],
  );

  useEffect(() => {
    if (!threadId) return;
    pendingNewThreadSubmissionRef.current = null;
  }, [threadId]);

  useEffect(() => {
    if (!threadId || readOnly) {
      return;
    }

    if (skipNextEmptyDraftSaveRef.current) {
      const shouldSkip = isComposerVisiblyEmpty(input, attachments);
      skipNextEmptyDraftSaveRef.current = false;
      if (shouldSkip) {
        return;
      }
    }

    saveDraft(input, attachments);
  }, [attachments, input, readOnly, saveDraft, threadId]);

  useEffect(() => {
    if (threadId || readOnly) {
      return;
    }

    if (skipNextEmptyDraftSaveRef.current) {
      const shouldSkip = isComposerVisiblyEmpty(welcomeInput, attachments);
      skipNextEmptyDraftSaveRef.current = false;
      if (shouldSkip) {
        return;
      }
    }

    saveDraft(welcomeInput, attachments);
  }, [attachments, readOnly, saveDraft, threadId, welcomeInput]);

  const bumpIframeKey = useCallback((tabId: string) => {
    iframeRetryCountsRef.current[tabId] = 0;
    const retryTimeout = iframeRetryTimeoutsRef.current[tabId];
    if (retryTimeout) {
      clearTimeout(retryTimeout);
      delete iframeRetryTimeoutsRef.current[tabId];
    }
    setTabIframeKeys((prev) => ({
      ...prev,
      [tabId]: (prev[tabId] ?? 0) + 1,
    }));
  }, []);

  const bumpFilePreviewKey = useCallback((tabId: string) => {
    setTabFilePreviewKeys((prev) => ({
      ...prev,
      [tabId]: (prev[tabId] ?? 0) + 1,
    }));
  }, []);

  const refreshActiveIframe = useCallback(() => {
    if (!activeTabId) return;
    bumpIframeKey(activeTabId);
  }, [activeTabId, bumpIframeKey]);

  const refreshActiveFilePreview = useCallback(() => {
    if (!activeTabId) return;
    bumpFilePreviewKey(activeTabId);
  }, [activeTabId, bumpFilePreviewKey]);

  const setActiveNotebookViewMode = useCallback(
    (mode: "report" | "notebook") => {
      if (!activeTabId) return;
      setTabNotebookViewModes((prev) => ({
        ...prev,
        [activeTabId]: mode,
      }));
    },
    [activeTabId],
  );

  const setActiveFileViewMode = useCallback(
    (mode: "preview" | "source") => {
      if (!activeTabId) return;
      setTabFileViewModes((prev) => ({
        ...prev,
        [activeTabId]: mode,
      }));
    },
    [activeTabId],
  );

  const syncPreviewTabsStateBestEffort = useCallback(
    (nextTabs: PreviewTab[], nextActiveTabId: string | null) => {
      if (!threadId) return;
      const agent = chatAgentRef.current;
      if (!agent || agent.readyState !== WebSocket.OPEN) return;

      void agent
        .call("setPreviewTabsState", [
          nextTabs.map((tab) => tab.target),
          nextActiveTabId,
        ])
        .catch(() => {});
    },
    [threadId],
  );

  useEffect(() => {
    if (!threadId || hasSyncedInitialPreviewRef.current) return;
    if (previewTabsRef.current.length > 0) {
      hasSyncedInitialPreviewRef.current = true;
      return;
    }
    if (initialPreviewSession.tabs.length === 0) return;

    setLocalPreviewSessionState(
      initialPreviewSession.tabs,
      initialPreviewSession.activeTabId,
    );
    hasSyncedInitialPreviewRef.current = true;
  }, [
    threadId,
    initialPreviewSession.tabs,
    initialPreviewSession.activeTabId,
    setLocalPreviewSessionState,
  ]);

  const cleanupClosedTabState = useCallback((tabId: string) => {
    setTabIframeKeys((prev) => {
      if (!(tabId in prev)) return prev;
      const next = { ...prev };
      delete next[tabId];
      return next;
    });
    setTabFilePreviewKeys((prev) => {
      if (!(tabId in prev)) return prev;
      const next = { ...prev };
      delete next[tabId];
      return next;
    });
    setTabNotebookViewModes((prev) => {
      if (!(tabId in prev)) return prev;
      const next = { ...prev };
      delete next[tabId];
      return next;
    });
    setTabFileViewModes((prev) => {
      if (!(tabId in prev)) return prev;
      const next = { ...prev };
      delete next[tabId];
      return next;
    });
    setTabNotebookStates((prev) => {
      if (!(tabId in prev)) return prev;
      const next = { ...prev };
      delete next[tabId];
      return next;
    });
    setTabNotebookPdfExporting((prev) => {
      if (!(tabId in prev)) return prev;
      const next = { ...prev };
      delete next[tabId];
      return next;
    });
    setTabAppLoading((prev) => {
      if (!(tabId in prev)) return prev;
      const next = { ...prev };
      delete next[tabId];
      return next;
    });

    clearIframeTimersForTab(tabId);
  }, [clearIframeTimersForTab]);

  const openTabForTarget = useCallback(
    (target: PreviewTarget, options?: { sync?: boolean }) => {
      const id = getPreviewTabId(target);
      const prevTabs = previewTabsRef.current;
      const existing = prevTabs.find((tab) => tab.id === id);
      const nextTabs = existing
        ? prevTabs.map((tab) => (tab.id === id ? { ...tab, target } : tab))
        : [...prevTabs, { id, target }];
      setLocalPreviewSessionState(nextTabs, id);
      if (options?.sync) {
        syncPreviewTabsStateBestEffort(nextTabs, id);
      }
    },
    [setLocalPreviewSessionState, syncPreviewTabsStateBestEffort],
  );

  const selectTab = useCallback(
    (tabId: string) => {
      const nextActiveTab = previewTabsRef.current.find(
        (tab) => tab.id === tabId,
      );
      if (!nextActiveTab) return;
      setLocalPreviewSessionState(previewTabsRef.current, tabId);
      syncPreviewTabsStateBestEffort(previewTabsRef.current, tabId);
    },
    [setLocalPreviewSessionState, syncPreviewTabsStateBestEffort],
  );

  const closeTab = useCallback(
    (tabId: string) => {
      const prevTabs = previewTabsRef.current;
      const closingTabIndex = prevTabs.findIndex((tab) => tab.id === tabId);
      if (closingTabIndex === -1) return;

      const nextTabs = prevTabs.filter((tab) => tab.id !== tabId);
      let nextActiveTabId = activeTabIdRef.current;

      if (tabId === activeTabIdRef.current) {
        if (!nextTabs.length) {
          nextActiveTabId = null;
          setMobileView("chat");
        } else {
          const nextIndex = Math.min(closingTabIndex, nextTabs.length - 1);
          const nextActiveTab = nextTabs[nextIndex];
          nextActiveTabId = nextActiveTab.id;
        }
      }

      setLocalPreviewSessionState(nextTabs, nextActiveTabId);
      syncPreviewTabsStateBestEffort(nextTabs, nextActiveTabId);
      cleanupClosedTabState(tabId);
    },
    [
      setLocalPreviewSessionState,
      syncPreviewTabsStateBestEffort,
      cleanupClosedTabState,
    ],
  );

  const handleTabNotebookStateChange = useCallback(
    (tabId: string, state: NotebookPreviewLoadState) => {
      setTabNotebookStates((prev) => {
        const current = prev[tabId];
        if (
          current?.status === state.status &&
          current?.notebook === state.notebook
        ) {
          return prev;
        }
        return {
          ...prev,
          [tabId]: state,
        };
      });
    },
    [],
  );

  const handleNotebookReportPdfDownload = useCallback(async () => {
    if (!activeTabId || previewTarget?.kind !== "file") return;
    if (tabNotebookPdfExporting[activeTabId]) return;

    const notebookState =
      tabNotebookStates[activeTabId] ?? DEFAULT_NOTEBOOK_PREVIEW_STATE;
    if (notebookState.status !== "ready" || !notebookState.notebook) {
      return;
    }

    const tabId = activeTabId;
    const fallbackName =
      previewTarget.path.split("/").filter(Boolean).pop() || "notebook.ipynb";
    const filename = previewTarget.filename || fallbackName;

    setTabNotebookPdfExporting((prev) => ({
      ...prev,
      [tabId]: true,
    }));

    try {
      const { exportNotebookReportAsPdf } =
        await import("@/components/chat-file-preview/notebook-preview/pdf-export");
      await exportNotebookReportAsPdf({
        notebook: notebookState.notebook,
        filename,
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to export notebook report as PDF.";
      toast.error(message);
    } finally {
      setTabNotebookPdfExporting((prev) => {
        if (!(tabId in prev)) return prev;
        const next = { ...prev };
        delete next[tabId];
        return next;
      });
    }
  }, [activeTabId, previewTarget, tabNotebookPdfExporting, tabNotebookStates]);

  const applyAgentPreviewState = useCallback(
    (state: ChatAgentState) => {
      const newVersion =
        typeof state.previewVersion === "number" ? state.previewVersion : 0;
      previewVersionRef.current = newVersion;

      const nextSession = normalizePreviewSessionState(
        state.previewTabs,
        state.previewActiveTabId,
        null,
      );
      setLocalPreviewSessionState(nextSession.tabs, nextSession.activeTabId);

      if (!nextSession.target || !nextSession.activeTabId) return;
      if (nextSession.target.kind === "runtime_artifact") return;

      const nextActiveId = nextSession.activeTabId;
      if (state.previewRefreshTabId !== nextActiveId) return;
      if (nextSession.target.kind === "app") {
        const existingTimeout = iframeRefreshTimeoutsRef.current[nextActiveId];
        if (existingTimeout) clearTimeout(existingTimeout);
        setTabAppLoading((prev) => ({ ...prev, [nextActiveId]: true }));
        iframeRefreshTimeoutsRef.current[nextActiveId] = setTimeout(() => {
          delete iframeRefreshTimeoutsRef.current[nextActiveId];
          if (activeTabIdRef.current !== nextActiveId) {
            setTabAppLoading((prev) => {
              if (!(nextActiveId in prev)) return prev;
              const next = { ...prev };
              delete next[nextActiveId];
              return next;
            });
            return;
          }
          setTabAppLoading((prev) => ({ ...prev, [nextActiveId]: false }));
          bumpIframeKey(nextActiveId);
        }, 1500);
      } else if (nextSession.target.kind === "file") {
        const fileViewMode = tabFileViewModesRef.current[nextActiveId] ?? "preview";
        if (shouldAutoRefreshFilePreview(nextSession.target, fileViewMode)) {
          bumpFilePreviewKey(nextActiveId);
        }
      }
    },
    [bumpFilePreviewKey, bumpIframeKey, setLocalPreviewSessionState],
  );

  const sendPendingMessageToAgent = useCallback(
    (message: Message, activeThreadId: string) => {
      const agent = chatAgentRef.current;
      const content =
        typeof message.content === "string"
          ? message.content
          : JSON.stringify(message.content);
      const clientMessageId = message.clientMessageId ?? message.id;

      if (!agent || agent.readyState !== WebSocket.OPEN) {
        return;
      }

      void agent
        .call<SendMessageResult>("sendMessage", [content, clientMessageId])
        .then((result) => {
          if (activeThreadId !== pendingThreadContextRef.current.threadId) {
            return;
          }
          if (result.status === "accepted") {
            markPendingDeliveryDraftAccepted(clientMessageId);
            return;
          }

          failPendingMessageDelivery(
            result.error ||
              (result.status === "busy"
                ? "The agent is busy. I restored your message as a draft so you can try again."
                : "Failed to send message"),
            { preserveReady: agent.readyState === WebSocket.OPEN },
          );
        })
        .catch((error) => {
          if (activeThreadId !== pendingThreadContextRef.current.threadId) {
            return;
          }
          failPendingMessageDelivery(
            error instanceof Error
              ? error.message
              : "The message did not reach the server. I restored it as a draft so you can try again.",
          );
        });
    },
    [failPendingMessageDelivery, markPendingDeliveryDraftAccepted],
  );

  // Agent connection
  const agentEnabled = !readOnly && Boolean(threadId && resolvedWorkspaceId);

  const handleAgentOpen = useCallback(() => {
    const id = threadId;
    if (!id) return;
    setReady(true);

    // Reconnect (not the first open for this thread): a turn may have started,
    // streamed, and finished entirely while we were disconnected. Revalidate so
    // committed history reloads its final messages; the initial-messages effect
    // ignores the result while a turn is still streaming or sends are pending, so
    // this never clobbers an in-progress turn.
    if (hasAgentConnectedRef.current) {
      revalidator.revalidate();
    }
    hasAgentConnectedRef.current = true;

    const queuedMessages = pendingMessagesRef.current.filter((message) => {
      if (message.role !== "user") return false;
      const deliveryKey = message.clientMessageId ?? message.id;
      return !isPendingMessageAccepted(deliveryKey);
    });
    if (queuedMessages.length === 0) return;

    setLoading(true);
    const currentMessages = messagesRef.current;
    const existingIds = new Set(currentMessages.map((message) => message.id));
    const missing = queuedMessages.filter((message) => !existingIds.has(message.id));
    if (missing.length > 0) {
      setMessages([...currentMessages, ...missing]);
    }
    for (const message of queuedMessages) {
      sendPendingMessageToAgent(message, id);
    }
    setPendingMessages((prev) => prev);
  }, [isPendingMessageAccepted, revalidator, sendPendingMessageToAgent, setMessages, setPendingMessages, threadId]);

  // Apply a terminal error (delivered through Agent state, not the websocket, so
  // it survives a reconnect after a disconnected/early failure).
  const handleTerminalError = useCallback(
    (payload: NonNullable<ChatAgentState["lastError"]>) => {
      const id = threadId;
      flushLiveOverlay();
      console.error("Chat terminal error:", payload.error);
      const billingSource =
        payload.billingSource === "byok" || payload.billingSource === "hosted"
          ? payload.billingSource
          : null;
      const eventProvider = parseByokProvider(payload.provider);
      const errorPayload =
        typeof payload.status === "number" ||
        typeof payload.status === "string" ||
        typeof payload.errorType === "string"
          ? {
              error: payload.error,
              status: payload.status,
              type: payload.errorType,
            }
          : payload.error;
      const errorContext: Partial<ChatApiErrorContext> = { billingSource };
      if (eventProvider) {
        errorContext.llmProvider = eventProvider;
      }
      const shouldRefreshBillingAfterError =
        billingSource === "hosted" || isChatBillingOrCreditError(errorPayload);
      showChatError(errorPayload, errorContext);
      // Finish streaming on error. The overlay's streaming entry is finalized
      // server-side and folded into committed history via state sync.
      setAgentIsStreaming(false);
      setLoading(false);
      acceptedPendingMessageIdsRef.current.clear();
      setPendingMessages([]);
      if (id) dispatchLocalThreadStatus(id, "idle");
      if (id && shouldRefreshBillingAfterError) {
        refreshBillingCreditStatusAfterTurn(`${id}:billing-error:${Date.now()}`);
      }
      restorePendingDeliveryDraft();
      isAutoCompactingRef.current = false;
      compactingPriorMessageIdRef.current = null;
      setCompactingPriorMessageId(null);
      clearManualCompactionQueue();
      hasCapturedCompactionSummaryRef.current = false;
    },
    [
      threadId,
      flushLiveOverlay,
      showChatError,
      setAgentIsStreaming,
      setPendingMessages,
      refreshBillingCreditStatusAfterTurn,
      restorePendingDeliveryDraft,
      clearManualCompactionQueue,
    ],
  );

  const handleAgentMessage = useCallback(
    (event: MessageEvent) => {
      const id = threadId;
      if (!id) return;
      const data = JSON.parse(event.data);

      // Reject messages stamped for a different thread (a late broadcast that
      // arrives after switching threads must never apply to the new one).
      if (typeof data?.threadId === "string" && data.threadId !== id) return;

      // Errors and code-mode artifacts ride Agent state; the websocket carries
      // the result signal and the live overlay (the current turn's streaming
      // tail, off the durable state channel).
      if (data.type === "live_overlay") {
        const overlay = (Array.isArray(data.messages) ? data.messages : []).map(
          (message: Message) => ({
            ...message,
            content: parseMessageContent(message.content),
          }),
        );
        // Fold finalized (non-streaming) entries into committed history so they
        // survive the overlay clearing at turn end. Idempotent — mergeOverlay
        // keys on id/clientMessageId; the streaming entry stays overlay-only so
        // a later re-id can't duplicate it.
        const finalized = [...liveOverlayRef.current, ...overlay].filter(
          (message) => !message.isStreaming,
        );
        // If the overlay just cleared (turn end) but our last snapshot still had
        // a streaming tail, finalize and fold it so the message isn't dropped.
        if (overlay.length === 0) {
          for (const message of liveOverlayRef.current) {
            if (message.isStreaming) {
              finalized.push({ ...message, isStreaming: false });
            }
          }
        }
        if (finalized.length > 0) {
          setMessages((previous) => mergeOverlay(previous, finalized));
        }
        liveOverlayRef.current = overlay;
        if (overlay.length === 0) {
          setLiveOverlayImmediate([]);
        } else {
          setLiveOverlayBuffered(overlay);
        }
      } else if (data.type === "result") {
        flushLiveOverlay();
        acceptedPendingMessageIdsRef.current.clear();
        setPendingMessages([]);
        dispatchLocalThreadStatus(id, "idle");
        completeActiveManualCompaction();
        clearPendingDeliveryDraft();
        refreshBillingCreditStatusAfterTurn(id);
      } else if (
        data.type === "chat_group_avatar_updated" &&
        typeof data.groupId === "string" &&
        isChatGroupAvatar(data.avatar)
      ) {
        dispatchLocalChatGroupAvatarUpdate(id, data.groupId, data.avatar);
      }
    },
    [
      clearPendingDeliveryDraft,
      completeActiveManualCompaction,
      refreshBillingCreditStatusAfterTurn,
      flushLiveOverlay,
      setMessages,
      setPendingMessages,
      threadId,
    ],
  );

  const handleAgentClose = useCallback(() => {
    setReady(false);
  }, []);

  const handleAgentStateUpdate = useCallback(
    (state: ChatAgentState) => {
      setAgentIsStreaming(Boolean(state?.isStreaming));
      // The live overlay now arrives over the broadcast channel
      // (handleAgentMessage); Agent state carries only coarse fields. Keep
      // loading true while streaming or while a queued send is still in flight
      // (on reconnect the first state can be isStreaming:false before the queued
      // send's turn has started — clearing then would re-enable the composer).
      if (state?.isStreaming) {
        setLoading(true);
      } else if (getUnacceptedPendingUserMessages().length === 0) {
        setLoading(false);
      }
      // Record completed-turn metadata for the duration/turn badges. Dedup by id
      // so a reconnect carrying the same lastCompletedTurn doesn't re-apply it,
      // and only fire the "freshly completed" animation for genuinely recent
      // completions (not historical ones replayed on load).
      const completed = state.lastCompletedTurn;
      if (completed?.id && lastAppliedCompletedTurnIdRef.current !== completed.id) {
        lastAppliedCompletedTurnIdRef.current = completed.id;
        completedTurnsRef.current.set(completed.id, {
          durationMs: completed.durationMs,
          completedAtMs: completed.completedAtMs,
        });
        setCompletedTurns(new Map(completedTurnsRef.current));
        if (completed.completedAtMs > Date.now() - FRESHLY_COMPLETED_TURN_WINDOW_MS) {
          setFreshlyCompletedTurnId(completed.id);
        }
      }
      // Terminal errors ride Agent state now; show each once (recovers a failure
      // missed while disconnected).
      const lastError = state.lastError;
      if (lastError?.id && lastError.id !== lastAppliedErrorIdRef.current) {
        lastAppliedErrorIdRef.current = lastError.id;
        handleTerminalError(lastError);
      }
      applyAgentPreviewState(state);
      if (Array.isArray(state.currentTodos)) {
        setCurrentTodos(state.currentTodos as TodoItem[]);
      }
      setPendingQuestion((previous) => {
        const next = state.pendingQuestion ?? null;
        const suppressedId = optimisticallyAnsweredQuestionIdRef.current;
        if (!next) {
          if (suppressedId) optimisticallyAnsweredQuestionIdRef.current = null;
          return previous === null ? previous : null;
        }
        if (suppressedId === next.questionId) return previous;
        if (suppressedId) optimisticallyAnsweredQuestionIdRef.current = null;
        return sameJson(previous, next) ? previous : next;
      });
      setConnectionSetupPrompt((previous) => {
        const next = state.connectionSetupPrompt ?? null;
        const suppressedId =
          optimisticallyClearedConnectionSetupRequestIdRef.current;
        if (!next) {
          if (suppressedId) {
            optimisticallyClearedConnectionSetupRequestIdRef.current = null;
          }
          return previous === null ? previous : null;
        }
        if (suppressedId === next.requestId) return previous;
        if (suppressedId) {
          optimisticallyClearedConnectionSetupRequestIdRef.current = null;
        }
        return sameJson(previous, next) ? previous : next;
      });
      if (typeof state.title === "string") {
        if (typeof document !== "undefined") {
          document.title = `${state.title || "Chat"} - camelAI`;
        }
        dispatchLocalThreadSummaryUpdate(threadId, {
          title: state.title,
          updatedAt:
            typeof state.titleUpdatedAt === "number" &&
            Number.isFinite(state.titleUpdatedAt)
              ? state.titleUpdatedAt
              : Date.now(),
        });
      }
      if (isLlmModel(state.model)) {
        const updatedAt =
          typeof state.modelUpdatedAt === "number" &&
          Number.isFinite(state.modelUpdatedAt)
            ? state.modelUpdatedAt
            : Date.now();
        setSelectedThreadModel(state.model);
        dispatchLocalThreadSummaryUpdate(threadId, {
          model: state.model,
          updatedAt,
        });
      }
      const usedPercent = state.contextUsedPercent;
      setContextUsedPercent(
        typeof usedPercent === "number" && Number.isFinite(usedPercent)
          ? Math.max(0, Math.min(100, Math.round(usedPercent)))
          : null,
      );
    },
    [applyAgentPreviewState, setConnectionSetupPrompt, setAgentIsStreaming, getUnacceptedPendingUserMessages, handleTerminalError, threadId],
  );

  const agentSocket = useAgent<ChatAgentState>({
    agent: "chat-thread",
    name: threadId ?? "disabled",
    enabled: agentEnabled,
    query: {
      threadId: threadId ?? null,
      workspaceId: resolvedWorkspaceId ?? null,
    },
    onOpen: handleAgentOpen,
    onMessage: handleAgentMessage,
    onClose: handleAgentClose,
    onStateUpdate: handleAgentStateUpdate,
  });

  useEffect(() => {
    chatAgentRef.current = agentEnabled ? agentSocket : null;
    return () => {
      if (chatAgentRef.current === agentSocket) chatAgentRef.current = null;
    };
  }, [agentEnabled, agentSocket]);

  useLayoutEffect(() => {
    setReady(false);
    setAgentIsStreaming(false);
    // New thread context: the next socket open is a first connect, not a reconnect.
    hasAgentConnectedRef.current = false;
    // Drop the previous context's live tail. Rendered = mergeOverlay(messages,
    // liveOverlay), so leaving it here would append the old thread's streaming
    // assistant/tool tail onto the new thread until a fresh overlay arrives.
    // setImmediate also clears liveOverlayRef.
    setLiveOverlayImmediate([]);
    compactingPriorMessageIdRef.current = null;
    setCompactingPriorMessageId(null);
    setLoading(false);
    isAutoCompactingRef.current = false;
    syncCompactionIndicator();
  }, [threadId, resolvedWorkspaceId, readOnly, setAgentIsStreaming, setLiveOverlayImmediate, syncCompactionIndicator]);

  useEffect(() => {
    return () => {
      for (const previewUrl of attachmentPreviewUrlsRef.current) {
        URL.revokeObjectURL(previewUrl);
      }
      attachmentPreviewUrlsRef.current.clear();
      acceptedPendingMessageIdsRef.current.clear();
      clearAllIframeRefreshTimeouts();
    };
  }, [clearAllIframeRefreshTimeouts]);

  // Check if we should show the chat UI
  const shouldShowChat = Boolean(threadId);
  const [hasHydratedChatTranscript, setHasHydratedChatTranscript] =
    useState(false);
  useEffect(() => {
    setHasHydratedChatTranscript(true);
  }, []);
  const lastMessage = visibleMessages[visibleMessages.length - 1];
  const visibleMessageCount = visibleMessages.length;
  const lastVisibleMessageId = lastMessage?.id ?? null;
  const isLastMessageAssistantLike = isAssistantLikeMessage(lastMessage);
  // See deriveIsAwaitingAssistant: shows the working indicator while a turn is
  // pending (streaming / queued send / freshly-started new chat) and the
  // transcript ends on a non-assistant message. pendingFirstTurn is a loader
  // prop that stays true for this mount's lifetime, so we drop it once a
  // terminal error lands — otherwise a failed background first turn (which
  // clears loading/isStreaming but leaves the synthesized user message last)
  // would keep the composer stuck in running/stop mode and treat the next
  // submission as a steer instead of a fresh prompt.
  const isAwaitingAssistant = deriveIsAwaitingAssistant({
    loading,
    isStreaming,
    pendingFirstTurn,
    lastMessage,
    hasTerminalError: Boolean(error),
  });
  // A turn is active while streaming/queued/running OR while a freshly-started
  // new chat is awaiting its first reply (isAwaitingAssistant covers the cold
  // pendingFirstTurn gap and clears once the reply lands, so the composer shows
  // the running/stop state and a second submit is treated as a steer).
  const assistantTurnActive =
    loading ||
    isStreaming ||
    isAwaitingAssistant ||
    activeAssistantMessageId !== null ||
    activeThreadRunningState.isRunning;
  const showGlobalAssistantIndicator = assistantTurnActive && !isCompacting;
  const lastUserMessage = useMemo(() => {
    for (let i = visibleMessages.length - 1; i >= 0; i -= 1) {
      if (isUserTurnAnchorMessage(visibleMessages[i])) {
        return visibleMessages[i];
      }
    }
    return null;
  }, [visibleMessages]);
  const shouldRenderSpacer =
    Boolean(lastUserMessage) &&
    !lastUserMessage?.sentDuringStreaming &&
    !error &&
    (isAwaitingAssistant || isLastMessageAssistantLike);
  const handleFreshlyCompletedTurnAnimationScheduled = useCallback(() => {
    setFreshlyCompletedTurnId(null);
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const container = scrollContainerRef.current;
    if (container) {
      if (behavior === "auto") {
        container.scrollTop = container.scrollHeight;
        return;
      }
      container.scrollTo({ top: container.scrollHeight, behavior });
      return;
    }
    messagesEndRef.current?.scrollIntoView({ behavior });
  }, []);

  useEffect(() => {
    if (error && !prevErrorRef.current) {
      const container = scrollContainerRef.current;
      if (container) {
        container.scrollTop = container.scrollHeight;
      } else {
        messagesEndRef.current?.scrollIntoView({
          behavior: "auto",
          block: "end",
        });
      }
    }

    prevErrorRef.current = error;
  }, [error]);

  useLayoutEffect(() => {
    if (!shouldShowChat || !threadId) return;
    if (!hasHydratedChatTranscript) return;
    if (initialScrollDoneRef.current) return;
    if (visibleMessages.length === 0) return;

    if (shouldAnchorToLastMessage && lastMessage) {
      const container = scrollContainerRef.current;
      const target = container?.querySelector(
        `[data-message-id="${lastMessage.id}"]`,
      ) as HTMLElement | null;
      if (target) {
        target.scrollIntoView({ behavior: "auto", block: "end" });
      } else {
        scrollToBottom("auto");
      }
    } else {
      scrollToBottom("auto");
    }
    setShowScrollButton(false);
    initialScrollDoneRef.current = true;
  }, [
    shouldShowChat,
    threadId,
    hasHydratedChatTranscript,
    visibleMessages.length,
    scrollToBottom,
    shouldAnchorToLastMessage,
    lastMessage,
    lastMessage?.id,
  ]);

  useLayoutEffect(() => {
    if (spacerMeasureFrameRef.current !== null) {
      cancelAnimationFrame(spacerMeasureFrameRef.current);
      spacerMeasureFrameRef.current = null;
    }

    if (!shouldRenderSpacer) {
      spacerHeightRef.current = 0;
      return;
    }

    const container = scrollContainerRef.current;
    const spacer = assistantSpacerRef.current;
    const userEl = lastUserMessageRef.current;
    const assistantEl = assistantMeasureRef.current;
    const pendingAssistantEl = assistantPendingMeasureRef.current;
    if (!container || !spacer) {
      spacerHeightRef.current = 0;
      return;
    }

    const updateSpacer = () => {
      const measureUser = lastUserMessageRef.current;
      const measureAssistant = assistantMeasureRef.current;
      const measurePendingAssistant = assistantPendingMeasureRef.current;

      if (!measureUser) {
        spacer.style.height = "0px";
        return;
      }

      const containerRect = container.getBoundingClientRect();
      const userRect = measureUser.getBoundingClientRect();
      const userStyle = getComputedStyle(measureUser);
      const userMarginTopValue = parseFloat(userStyle.marginTop || "0");
      const userMarginTop = Number.isNaN(userMarginTopValue)
        ? 0
        : userMarginTopValue;

      let exchangeHeight: number;

      if (measureAssistant) {
        const assistantRect = measureAssistant.getBoundingClientRect();
        const assistantStyle = getComputedStyle(measureAssistant);
        const assistantMarginBottomValue = parseFloat(
          assistantStyle.marginBottom || "0",
        );
        const assistantMarginBottom = Number.isNaN(assistantMarginBottomValue)
          ? 0
          : assistantMarginBottomValue;
        const exchangeTop = userRect.top - userMarginTop;
        const exchangeBottom = assistantRect.bottom + assistantMarginBottom;
        exchangeHeight = Math.max(exchangeBottom - exchangeTop, 0);
      } else if (measurePendingAssistant) {
        const pendingRect = measurePendingAssistant.getBoundingClientRect();
        const pendingStyle = getComputedStyle(measurePendingAssistant);
        const pendingMarginBottomValue = parseFloat(
          pendingStyle.marginBottom || "0",
        );
        const pendingMarginBottom = Number.isNaN(pendingMarginBottomValue)
          ? 0
          : pendingMarginBottomValue;
        const exchangeTop = userRect.top - userMarginTop;
        const exchangeBottom = pendingRect.bottom + pendingMarginBottom;
        exchangeHeight = Math.max(exchangeBottom - exchangeTop, 0);
      } else {
        const userMarginBottomValue = parseFloat(userStyle.marginBottom || "0");
        const userMarginBottom = Number.isNaN(userMarginBottomValue)
          ? 0
          : userMarginBottomValue;
        exchangeHeight = userRect.height + userMarginTop + userMarginBottom;
      }

      const column = messageColumnRef.current;
      const columnStyle = column ? getComputedStyle(column) : null;
      const gapValue = columnStyle ? parseFloat(columnStyle.rowGap || "0") : 0;
      const rowGap = Number.isNaN(gapValue) ? 0 : gapValue;
      const paddingBottomValue = columnStyle
        ? parseFloat(columnStyle.paddingBottom || "0")
        : 0;
      const paddingBottom = Number.isNaN(paddingBottomValue)
        ? 0
        : paddingBottomValue;

      const header = document.querySelector("header");
      const headerRect = header ? header.getBoundingClientRect() : null;
      const overlap = headerRect
        ? Math.max(0, headerRect.bottom - containerRect.top)
        : 0;
      const availableHeight = container.clientHeight - overlap;

      const height = Math.max(
        availableHeight - exchangeHeight - rowGap - paddingBottom,
        0,
      );
      const nextHeight = Math.max(Math.round(height), 0);
      if (spacerHeightRef.current !== nextHeight) {
        spacer.style.height = `${nextHeight}px`;
        spacerHeightRef.current = nextHeight;
      }
    };

    updateSpacer();

    if (typeof ResizeObserver === "undefined") return;

    const scheduleSpacerUpdate = () => {
      if (spacerMeasureFrameRef.current !== null) return;
      spacerMeasureFrameRef.current = requestAnimationFrame(() => {
        spacerMeasureFrameRef.current = null;
        updateSpacer();
      });
    };

    const observer = new ResizeObserver(() => {
      scheduleSpacerUpdate();
    });

    observer.observe(container);
    if (userEl) {
      observer.observe(userEl);
    }
    if (assistantEl) {
      observer.observe(assistantEl);
    }
    if (pendingAssistantEl) {
      observer.observe(pendingAssistantEl);
    }

    return () => {
      if (spacerMeasureFrameRef.current !== null) {
        cancelAnimationFrame(spacerMeasureFrameRef.current);
        spacerMeasureFrameRef.current = null;
      }
      observer.disconnect();
    };
  }, [
    shouldRenderSpacer,
    isAwaitingAssistant,
    lastMessage?.id,
    lastUserMessage?.id,
    visibleMessages.length,
    isStreaming,
    loading,
  ]);

  // Handle scroll position tracking
  const handleScroll = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const { scrollTop, scrollHeight, clientHeight } = container;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    stickToBottomRef.current = distanceFromBottom < 150;
    setShowScrollButton(distanceFromBottom > 100);
  }, []);

  useEffect(() => {
    if (!shouldShowChat || !threadId) return;

    const column = messageColumnRef.current;
    if (!column || typeof ResizeObserver === "undefined") return;

    let frameId: number | null = null;
    const observer = new ResizeObserver(() => {
      if (!stickToBottomRef.current) return;
      if (shouldRenderSpacer) return;
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
      }
      frameId = requestAnimationFrame(() => {
        scrollToBottom("auto");
      });
    });

    observer.observe(column);

    return () => {
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
      }
      observer.disconnect();
    };
  }, [scrollToBottom, shouldShowChat, threadId, shouldRenderSpacer]);

  // Auto-scroll on new messages (only if near bottom, or forced after user sends)
  useLayoutEffect(() => {
    if (!shouldShowChat || !threadId) return;
    if (!hasHydratedChatTranscript) return;

    if (!initialScrollDoneRef.current && visibleMessageCount > 0) {
      initialScrollDoneRef.current = true;
      scrollToBottom("auto");
      setShowScrollButton(false);
      return;
    }

    const shouldForce = forceScrollOnNextUpdate.current;
    forceScrollOnNextUpdate.current = false;

    const container = scrollContainerRef.current;
    if (!container) {
      scrollToBottom("auto");
      return;
    }

    const { scrollTop, scrollHeight, clientHeight } = container;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;

    if (shouldForce) {
      scrollToBottom(shouldRenderSpacer ? "auto" : "smooth");
      return;
    }

    if (shouldRenderSpacer) return;

    if (stickToBottomRef.current || distanceFromBottom < 150) {
      scrollToBottom("auto");
    }
  }, [
    visibleMessageCount,
    lastVisibleMessageId,
    scrollToBottom,
    shouldShowChat,
    shouldRenderSpacer,
    threadId,
    hasHydratedChatTranscript,
  ]);

  const copyMessage = useCallback(
    async (messageId: string, content: string) => {
      try {
        await navigator.clipboard.writeText(content);
        setCopiedMessageId(messageId);
        setTimeout(() => setCopiedMessageId(null), 2000);
      } catch (err) {
        console.error("Failed to copy message:", err);
      }
    },
    [],
  );

  const forkMessage = useCallback(
    async (messageId: string, renderedMessageId?: string) => {
      if (!threadId || !resolvedWorkspaceId || readOnly) return;
      setForkingMessageId(messageId);
      setError(null);
      try {
        const response = await fetch(
          `/api/workspaces/${encodeURIComponent(resolvedWorkspaceId)}/chat/${encodeURIComponent(threadId)}/fork`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ messageId, renderedMessageId, groupId: chatGroupId }),
          },
        );
        const data = (await response.json().catch(() => ({}))) as {
          thread?: { id?: string };
          groupId?: string | null;
          error?: string;
        };
        if (!response.ok || !data.thread?.id) {
          throw new Error(data.error || "Failed to fork chat");
        }
        toast.success("Forked chat");
        revalidator.revalidate();
        navigate(`/chat/${data.thread.id}`, { preventScrollReset: true });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to fork chat";
        showChatError(message);
        toast.error(message);
      } finally {
        setForkingMessageId(null);
      }
    },
    [
      chatGroupId,
      navigate,
      readOnly,
      resolvedWorkspaceId,
      revalidator,
      showChatError,
      threadId,
    ],
  );

  const handleFilesSelected = useCallback(
    async (files: File[]) => {
      if (!resolvedWorkspaceId) return;

      for (const file of files) {
        const id = `upload_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

        // Create a blob URL for browser-renderable image preview in the input field
        const previewUrl = isImageFile(file.name, file.type || undefined)
          ? URL.createObjectURL(file)
          : undefined;
        if (previewUrl) {
          attachmentPreviewUrlsRef.current.add(previewUrl);
        }

        // Add to state as uploading
        setAttachments((prev) => [
          ...prev,
          {
            id,
            name: file.name,
            path: "",
            size: file.size,
            contentType: file.type || undefined,
            originalName: file.name,
            status: "uploading",
            progress: 0,
            previewUrl,
          },
        ]);

        try {
          const data = await uploadWorkspaceFile(resolvedWorkspaceId, file, {
            onProgress: (progressPercent) => {
              setAttachments((prev) =>
                prev.map((a) =>
                  a.id === id ? { ...a, progress: progressPercent } : a,
                ),
              );
            },
          });
          if (!isUserUploadMountPath(data.path)) {
            throw new Error(
              `Upload completed without a readable uploads/ path`,
            );
          }

          // Update state to complete
          setAttachments((prev) =>
            prev.map((a) =>
              a.id === id
                ? {
                    ...a,
                    path: data.path,
                    size: data.size,
                    contentType: data.contentType ?? a.contentType,
                    originalName: data.originalName ?? a.originalName,
                    status: "complete" as const,
                    progress: 100,
                  }
                : a,
            ),
          );
        } catch (err) {
          console.error("File upload failed:", err);
          const errorMessage =
            err instanceof Error ? err.message : "Upload failed";
          // Update state to error
          setAttachments((prev) =>
            prev.map((a) =>
              a.id === id
                ? {
                    ...a,
                    status: "error" as const,
                    error: errorMessage,
                    progress: undefined,
                  }
                : a,
            ),
          );
        }
      }
    },
    [resolvedWorkspaceId],
  );

  const handleGeneratedTranscriptAttachment = useCallback(
    async (
      transcript: CondensedTranscript,
      card: GroupNewChatTranscriptCard,
    ) => {
      if (!resolvedWorkspaceId) return;
      if (transcript.turns.length === 0) {
        throw new Error("This chat does not have a completed transcript yet.");
      }

      const markdown = condensedTranscriptToMarkdown(transcript);
      const filename = `${sanitizeGeneratedFilename(card.title)}-transcript.md`;
      const file = new File([markdown], filename, { type: "text/markdown" });
      const id = `transcript_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
      const snippet = card.openingLine || transcript.turns[0]?.user || filename;

      setAttachments((prev) => [
        ...prev,
        {
          id,
          name: file.name,
          path: "",
          size: file.size,
          contentType: file.type || "text/markdown",
          originalName: file.name,
          status: "uploading",
          progress: 0,
          kind: "transcript",
          sourceThreadId: card.threadId,
          sourceTitle: card.title,
          snippet,
        },
      ]);

      try {
        const data = await uploadWorkspaceFile(resolvedWorkspaceId, file, {
          onProgress: (progressPercent) => {
            setAttachments((prev) =>
              prev.map((attachment) =>
                attachment.id === id
                  ? { ...attachment, progress: progressPercent }
                  : attachment,
              ),
            );
          },
        });
        if (!isUserUploadMountPath(data.path)) {
          throw new Error("Upload completed without a readable uploads/ path");
        }

        setAttachments((prev) =>
          prev.map((attachment) =>
            attachment.id === id
              ? {
                  ...attachment,
                  path: data.path,
                  size: data.size,
                  contentType: data.contentType ?? attachment.contentType,
                  originalName: data.originalName ?? attachment.originalName,
                  status: "complete" as const,
                  progress: 100,
                }
              : attachment,
          ),
        );
      } catch (err) {
        console.error("Transcript upload failed:", err);
        const errorMessage =
          err instanceof Error ? err.message : "Upload failed";
        setAttachments((prev) =>
          prev.map((attachment) =>
            attachment.id === id
              ? {
                  ...attachment,
                  status: "error" as const,
                  error: errorMessage,
                  progress: undefined,
                }
              : attachment,
          ),
        );
      }
    },
    [resolvedWorkspaceId],
  );

  const handleRecentAttachmentSelect = useCallback(
    (card: GroupNewChatAttachmentCard) => {
      setAttachments((prev) => {
        if (prev.some((attachment) => attachment.path === card.path)) {
          return prev;
        }
        return [
          ...prev,
          {
            id: `recent_attachment_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
            name: card.originalName || card.filename,
            path: card.path,
            size: card.size,
            contentType: card.contentType,
            originalName: card.originalName,
            status: "complete",
          },
        ];
      });
    },
    [],
  );

  const handleAttachmentRemove = useCallback(
    (id: string) => {
      setAttachments((prev) => {
        const removed = prev.find((a) => a.id === id);
        revokeAttachmentPreviewUrl(removed?.previewUrl);
        return prev.filter((a) => a.id !== id);
      });
    },
    [revokeAttachmentPreviewUrl],
  );

  // Drag-drop handlers for the whole chat area
  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!isFileDrag(e.dataTransfer)) return;
      e.preventDefault();
      e.stopPropagation();
      if (resolvedWorkspaceId) {
        setIsDragOver(true);
      }
    },
    [resolvedWorkspaceId],
  );

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (!isFileDrag(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    // Only set drag over to false if we're leaving the container entirely
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX;
    const y = e.clientY;
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
      setIsDragOver(false);
    }
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      if (!isFileDrag(e.dataTransfer)) return;
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);

      if (!resolvedWorkspaceId) return;

      const files = e.dataTransfer.files;
      if (files && files.length > 0) {
        handleFilesSelected(Array.from(files));
      }
    },
    [resolvedWorkspaceId, handleFilesSelected],
  );

  useEffect(() => {
    if (
      updateThreadModelFetcher.state !== "idle" ||
      !updateThreadModelFetcher.data
    )
      return;
    if (updateThreadModelFetcher.data.error) {
      optimisticThreadModelRef.current = null;
      setSelectedThreadModel(
        resolveSelectedThreadModel({
          threadId,
          threadModel,
          allowedThreadModels,
          llmProvider,
          availableThreadModels,
          effectivePickerDefaultModel,
          hasEffectivePickerDefault,
        }),
      );
      toast.error(updateThreadModelFetcher.data.error);
      return;
    }
    if (updateThreadModelFetcher.data.thread?.model) {
      const nextModel = updateThreadModelFetcher.data.thread.model;
      const updatedAt = updateThreadModelFetcher.data.thread.updated_at;
      const nextSelectionKey = nextModel;
      optimisticThreadModelRef.current = null;
      setSelectedThreadModel(nextModel);
      dispatchLocalThreadSummaryUpdate(threadId, {
        model: nextModel,
        updatedAt,
      });
      const agent = chatAgentRef.current;
      if (
        lastRunnerModelSelectionRef.current !== nextSelectionKey &&
        agent?.readyState === WebSocket.OPEN &&
        ready
      ) {
        lastRunnerModelSelectionRef.current = nextSelectionKey;
        void agent.call("refreshModel").catch(() => {});
      }
    }
  }, [
    llmProvider,
    threadId,
    ready,
    threadModel,
    updateThreadModelFetcher.state,
    updateThreadModelFetcher.data,
    allowedThreadModels,
  ]);

  const handleThreadModelChange = useCallback(
    (nextModel: LlmModel) => {
      if (!availableThreadModelIds.has(nextModel)) {
        return;
      }
      if (!threadId) {
        setSelectedThreadModel(nextModel);
        return;
      }
      if (
        nextModel === selectedThreadModel ||
        updateThreadModelFetcher.state !== "idle"
      ) {
        return;
      }
      setSelectedThreadModel(nextModel);
      optimisticThreadModelRef.current = { threadId, model: nextModel };
      updateThreadModelFetcher.submit(
        { intent: "updateThreadModel", model: nextModel },
        { method: "post" },
      );
    },
    [
      availableThreadModelIds,
      selectedThreadModel,
      threadId,
      updateThreadModelFetcher,
    ],
  );

  useEffect(() => {
    if (threadId || readOnly || !modelRecentScope || noModelsMessage) {
      return;
    }

    const scopeKey = `${modelRecentScope.orgId}:${modelRecentScope.workspaceId}`;
    if (appliedRecentModelScopeRef.current === scopeKey) {
      return;
    }
    appliedRecentModelScopeRef.current = scopeKey;

    const recentModel = getRecentModel(modelRecentScope);
    const nextModel = resolveDefaultModelForChat({
      effectiveDefaultModel: null,
      recentModel,
      fallbackModel: getDefaultLlmModel(llmProvider),
      visibleCatalog: availableThreadModels,
    });
    if (nextModel && nextModel !== selectedThreadModel) {
      handleThreadModelChange(nextModel);
    }
  }, [
    availableThreadModels,
    handleThreadModelChange,
    llmProvider,
    modelRecentScope,
    noModelsMessage,
    readOnly,
    selectedThreadModel,
    threadId,
  ]);

  useEffect(() => {
    if (
      !threadId ||
      readOnly ||
      noModelsMessage ||
      loading ||
      isStreaming ||
      updateThreadModelFetcher.state !== "idle" ||
      availableThreadModelIds.has(selectedThreadModel)
    ) {
      return;
    }

    const nextModel = resolveDefaultModelForChat({
      effectiveDefaultModel: hasEffectivePickerDefault
        ? effectivePickerDefaultModel
        : null,
      fallbackModel: getDefaultLlmModel(llmProvider),
      visibleCatalog: availableThreadModels,
    });
    if (nextModel && nextModel !== selectedThreadModel) {
      handleThreadModelChange(nextModel);
    }
  }, [
    availableThreadModelIds,
    availableThreadModels,
    effectivePickerDefaultModel,
    hasEffectivePickerDefault,
    handleThreadModelChange,
    isStreaming,
    llmProvider,
    loading,
    noModelsMessage,
    readOnly,
    selectedThreadModel,
    threadId,
    updateThreadModelFetcher.state,
  ]);

  const handleStartChatForApp = useCallback(
    (app: WorkerScriptWithCreator) => {
      if (!resolvedWorkspaceId) {
        toast.error("No workspace selected");
        return;
      }
      if (noModelsMessage) {
        toast.error(noModelsMessage);
        return;
      }

      if (app.workspace_id !== resolvedWorkspaceId) {
        toast.error(
          "App is in a different workspace. Please switch workspaces first.",
        );
        return;
      }

      if (isSubmittingNewThread) return;

      // Build the camelai system message
      const appUrl = getAppUrl(app.script_name, hostname, orgSlug);
      const sourceInfo = app.config_path
        ? ` The app's wrangler config is at "${app.config_path}".`
        : ` The project location is unknown - use list_projects to find it, then look in its VM checkout at /workspace. The project may have a different name than the app, and look for either wrangler.toml or wrangler.jsonc files.`;
      const systemMessage = `<camelai system message>I'd like to work on the app "${app.script_name}" at ${appUrl}.${sourceInfo}</camelai system message>`;
      const threadTitle = buildAppThreadFallbackTitle(app.script_name);

      submit(
        {
          intent: "createThreadAndStart",
          clientBuildId: APP_BUILD_ID,
          initialTitle: threadTitle,
          previewApps: app.script_name,
          firstMessage: systemMessage,
          model: selectedThreadModel,
          ...(chatGroupId ? { groupId: chatGroupId } : {}),
        },
        { method: "post", action: "/chat" },
      );
    },
    [
      hostname,
      orgSlug,
      resolvedWorkspaceId,
      submit,
      isSubmittingNewThread,
      noModelsMessage,
      selectedThreadModel,
      chatGroupId,
    ],
  );

  function startNewChat() {
    const currentWelcomeInput = welcomeInputRef.current;
    const currentAttachments = attachmentsRef.current;
    const hasCompletedAttachments =
      getCompletedAttachments(currentAttachments).length > 0;

    if (
      (!currentWelcomeInput.trim() && !hasCompletedAttachments) ||
      isSubmittingNewThread ||
      !resolvedWorkspaceId ||
      noModelsMessage
    )
      return;

    // Don't allow sending while uploads are in progress
    const hasUploadingAttachments = currentAttachments.some(
      (a) => a.status === "uploading",
    );
    if (hasUploadingAttachments) return;

    const userMessage = currentWelcomeInput.trim();
    let finalContent: string;
    try {
      finalContent = buildMessageContent(userMessage, currentAttachments);
    } catch (error) {
      showChatError(error);
      return;
    }

    pendingNewThreadSubmissionRef.current = {
      text: currentWelcomeInput,
      attachments: currentAttachments,
    };
    handledNewChatActionErrorRef.current = null;
    clearDraft();
    welcomeInputRef.current = "";
    attachmentsRef.current = [];
    setWelcomeInput("");
    skipNextEmptyDraftSaveRef.current = true;

    // Keep blob URLs alive until redirect/unmount so an action error can restore
    // image previews without rebuilding local object URLs.
    setAttachments([]);

    // Submit as a navigational route action. The action creates the thread,
    // starts the first turn in the ChatThreadDO, then redirects to the thread.
    const createThreadPayload: Record<string, string> = {
      intent: "createThreadAndStart",
      clientBuildId: APP_BUILD_ID,
      model: selectedThreadModel,
    };
    if (chatGroupId) {
      createThreadPayload.groupId = chatGroupId;
    }
    if (finalContent) {
      createThreadPayload.firstMessage = finalContent;
    }


    submit(createThreadPayload, {
      method: "post",
      action: "/chat",
    });
  }

  function stopGeneration() {
    if (chatAgentRef.current?.readyState !== WebSocket.OPEN) return;
    void chatAgentRef.current.call("requestStop").catch(() => {});
  }

  const handleQuestionResponse = useCallback(
    (answers: Record<string, string>) => {
      const agent = chatAgentRef.current;
      if (!pendingQuestion || !agent || agent.readyState !== WebSocket.OPEN) {
        return;
      }

      optimisticallyAnsweredQuestionIdRef.current = pendingQuestion.questionId;
      void agent.call("answerQuestion", [pendingQuestion.questionId, answers]);

      // Optimistically clear the question
      setPendingQuestion(null);

      window.setTimeout(() => composerTextareaRef.current?.focus(), 0);
    },
    [pendingQuestion],
  );

  const resetPreviewTabsState = useCallback(() => {
    setLocalPreviewSessionState([], null);
    setTabIframeKeys({});
    setTabFilePreviewKeys({});
    setTabNotebookViewModes({});
    setTabFileViewModes({});
    setTabAppLoading({});
    clearAllIframeRefreshTimeouts();
  }, [setLocalPreviewSessionState, clearAllIframeRefreshTimeouts]);

  const setPreviewTargetForThread = useCallback(
    (target: PreviewTarget | null) => {
      if (!threadId) return;

      if (readOnly) {
        if (target === null) {
          resetPreviewTabsState();
          setMobileView("chat");
          return;
        }
        openTabForTarget(target, { sync: false });
        return;
      }

      const agent = chatAgentRef.current;
      if (!agent || agent.readyState !== WebSocket.OPEN) {
        if (target === null) {
          resetPreviewTabsState();
          setMobileView("chat");
          return;
        }
        toast.error("Preview is unavailable while reconnecting.");
        return;
      }

      if (target === null) {
        resetPreviewTabsState();
        syncPreviewTabsStateBestEffort([], null);
        setMobileView("chat");
        return;
      }

      openTabForTarget(target, { sync: true });
    },
    [
      threadId,
      readOnly,
      resetPreviewTabsState,
      openTabForTarget,
      syncPreviewTabsStateBestEffort,
    ],
  );

  const openPreviewTarget = useCallback(
    (target: PreviewTarget) => {
      setPreviewTargetForThread(target);
      setMobileView("preview");
    },
    [setPreviewTargetForThread],
  );

  const clearPreviewTarget = useCallback(() => {
    setPreviewTargetForThread(null);
  }, [setPreviewTargetForThread]);

  const resolveAppVisibility = useCallback(
    async (scriptName: string): Promise<boolean | null> => {
      if (!resolvedWorkspaceId) return null;
      try {
        const response = await fetch(
          `/api/workspaces/${encodeURIComponent(resolvedWorkspaceId)}/apps/${encodeURIComponent(scriptName)}/visibility`
        );
        if (!response.ok) return null;
        const payload = await response.json() as { is_public?: unknown };
        return typeof payload.is_public === "boolean" ? payload.is_public : null;
      } catch {
        return null;
      }
    },
    [resolvedWorkspaceId],
  );

type SendOptions = {
  contentOverride?: string;
  preserveDraft?: boolean;
  skipAttachmentRefs?: boolean;
};

  function sendMessage(opts?: SendOptions): boolean {
    if (readOnly) {
      return false;
    }
    const currentInput = inputRef.current;
    const currentAttachments = attachmentsRef.current;
    const hasUploadingAttachments = currentAttachments.some(
      (a) => a.status === "uploading",
    );
    const hasCompletedAttachments =
      getCompletedAttachments(currentAttachments).length > 0;
    const rawContent = (opts?.contentOverride ?? currentInput).trim();
    if (
      isLoadingMessages ||
      hasUploadingAttachments ||
      (!rawContent && !hasCompletedAttachments) ||
      !shouldShowChat ||
      !resolvedWorkspaceId ||
      !threadId ||
      noModelsMessage
    ) {
      return false;
    }

    const wasSentDuringStreaming = assistantTurnActive;
    const clientMessageId = `client_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2, 10)}`;

    if (!opts?.preserveDraft && !opts?.contentOverride) {
      preserveDraftBeforeOptimisticClear(
        clientMessageId,
        threadId,
        currentInput,
        currentAttachments,
      );
      inputRef.current = "";
      setInput("");
    }

    const shouldIncludeAttachmentRefs =
      !opts?.skipAttachmentRefs && !opts?.contentOverride;
    let finalContent: string;
    try {
      finalContent = shouldIncludeAttachmentRefs
        ? buildMessageContent(rawContent, currentAttachments)
        : rawContent;
    } catch (error) {
      showChatError(error);
      return false;
    }

    const shouldShowCompactingIndicator = isManualCompactCommand(finalContent);

    if (shouldShowCompactingIndicator) {
      queueManualCompaction();
    }

    if (shouldIncludeAttachmentRefs) {
      // Clear attachments after building message (revoke any blob URLs to avoid memory leaks)
      attachmentsRef.current = [];
      setAttachments((prev) => {
        for (const a of prev) {
          revokeAttachmentPreviewUrl(a.previewUrl);
        }
        return [];
      });
    }

    // Clear any previous error
    setError(null);

    // Add user message to state immediately (optimistic)
    const userMsg: Message = {
      id: clientMessageId,
      clientMessageId,
      thread_id: threadId,
      role: "user",
      content: finalContent,
      created_at: Date.now(),
      sentDuringStreaming: wasSentDuringStreaming,
    };

    if (wasSentDuringStreaming) {
      // Steering: the assistant keeps streaming in the live overlay. Echo the
      // user's message into committed history optimistically; it reconciles with
      // the server copy by clientMessageId, and Pi's real ordering arrives via
      // the overlay / next reload.
      setMessages((prev) =>
        prev.some(
          (message) =>
            message.id === userMsg.id ||
            (userMsg.clientMessageId &&
              message.clientMessageId === userMsg.clientMessageId),
        )
          ? prev
          : [...prev, userMsg],
      );
    } else {
      // /compact is operational and can happen while users read older messages.
      // Avoid forcing a jump to bottom in that case.
      forceScrollOnNextUpdate.current = !shouldShowCompactingIndicator;
      setMessages((prev) => [...prev, userMsg]);
    }
    setPendingMessages((prev) => {
      if (
        prev.some(
          (message) =>
            message.id === clientMessageId ||
            message.clientMessageId === clientMessageId,
        )
      ) {
        return prev;
      }
      return [...prev, userMsg];
    });

    // If WebSocket is connected and ready, send immediately
    const previewUserMessage = normalizeThreadPreviewUserMessage(rawContent);
    const userMessageAt = Date.now();
    const isFirstUserTurn = !messagesRef.current.some(
      (message) =>
        message.role === "user" &&
        !message.isMeta &&
        !message.isCompactSummary,
    );
    dispatchLocalThreadStatus(threadId, "running", {
      latestUserMessage: previewUserMessage,
      latestUserMessageAt: userMessageAt,
      ...(isFirstUserTurn ? { firstUserMessage: previewUserMessage } : {}),
      runningActivityText: previewUserMessage,
      runningActivityAt: userMessageAt,
      runningStartedAt: userMessageAt,
    });
    if (chatAgentRef.current?.readyState === WebSocket.OPEN && ready) {
      setLoading(true);
      sendPendingMessageToAgent(userMsg, threadId);
      setPendingMessages((prev) => prev);
    } else {
      // Queue the full message object for later delivery (with file refs in content).
      // useAgent reconnects automatically; the ready handler flushes the queue.
      setLoading(true);
    }
    return true;
  }

  const sendMessageRef = useRef(sendMessage);
  sendMessageRef.current = sendMessage;
  const handleCompactFromIndicator = useCallback(() => {
    if (loading || isStreaming || isCompacting || readOnly) return;
    sendMessageRef.current({
      contentOverride: "/compact",
      preserveDraft: true,
      skipAttachmentRefs: true,
    });
  }, [loading, isStreaming, isCompacting, readOnly]);

  const {
    tabRenderStates,
    previewDomains,
    appPreviewVanityUrl,
    filePreviewOpenUrl,
    openElsewhereKind,
  } = useChatPreviewRenderState({
    previewTabs,
    previewTarget,
    tabIframeKeys,
    tabAppLoading,
    tabFilePreviewKeys,
    tabNotebookViewModes,
    tabFileViewModes,
    hostname,
    orgSlug,
  });

  const handlePreviewRefresh = useCallback(() => {
    if (!previewTarget || previewTarget.kind === "runtime_artifact") return;
    if (previewTarget.kind === "app") {
      refreshActiveIframe();
      return;
    }
    refreshActiveFilePreview();
  }, [previewTarget, refreshActiveIframe, refreshActiveFilePreview]);

  const handlePreviewOpenElsewhere = useCallback(() => {
    if (!previewTarget || previewTarget.kind === "runtime_artifact") return;
    if (previewTarget.kind === "app") {
      if (!appPreviewVanityUrl) return;
      window.open(appPreviewVanityUrl, "_blank", "noopener,noreferrer");
      return;
    }
  }, [previewTarget, appPreviewVanityUrl]);

  const showMobilePreview = previewTabs.length > 0 && mobileView === "preview";
  const currentMembership = orgs.find(
    (entry) => entry.org_id === currentOrg?.id,
  );
  const isAdmin =
    currentMembership?.role === "owner" || currentMembership?.role === "admin";
  function handleBillingTopUp() {
    setTopUpOpen(true);
    if (
      !creditPacksFetcher.data &&
      creditPacksFetcher.state === "idle" &&
      typeof creditPacksFetcher.load === "function"
    ) {
      creditPacksFetcher.load("/api/billing/credit-packs");
    }
  }
  const previewShareButton = useMemo(() => {
    if (readOnly) return undefined;
    if (previewTarget?.kind !== "app") return undefined;
    return (
      <ShareStatusButton
        threadId={threadId}
        scriptName={previewTarget.scriptName}
        isPublic={appIsPublic}
        isAdmin={Boolean(isAdmin)}
        onStatusChange={setAppIsPublic}
      />
    );
  }, [readOnly, previewTarget, threadId, appIsPublic, isAdmin, setAppIsPublic]);
  const previewPanelBody = (
    <PreviewPanelShell
      previewTabs={previewTabs}
      activeTabId={activeTabId}
      previewTarget={previewTarget}
      onTabSelect={selectTab}
      onTabClose={closeTab}
      onRefresh={handlePreviewRefresh}
      openElsewhereKind={openElsewhereKind}
      onOpenElsewhere={handlePreviewOpenElsewhere}
      appShareButton={previewShareButton}
      notebookViewMode={notebookViewMode}
      onNotebookViewModeChange={setActiveNotebookViewMode}
      fileViewMode={fileViewMode}
      onFileViewModeChange={setActiveFileViewMode}
      filePreviewOpenUrl={filePreviewOpenUrl}
      activeNotebookState={activeNotebookState}
      isNotebookPdfExporting={isNotebookPdfExporting}
      onNotebookStateChange={handleTabNotebookStateChange}
      onNotebookReportPdfDownload={handleNotebookReportPdfDownload}
      iframeRef={iframeRef}
      tabRenderStates={tabRenderStates}
      vanityUrl={appPreviewVanityUrl}
      vanityHost={previewDomains.vanityHost}
    />
  );

  const chatPanelContent = (
    <>
      {readOnly && (
        <div className="mx-auto w-full max-w-3xl px-4 md:px-6 pt-3">
          <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            Read-only admin view. Messaging is disabled for this thread.
          </div>
        </div>
      )}
      {/* Chat Body - Single Scroll Container */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        tabIndex={0}
        role="region"
        aria-label="Chat messages"
        style={CHAT_SCROLL_CONTAINER_STYLE}
        className="flex flex-col flex-1 overflow-y-auto overflow-x-hidden"
      >
        {/* Centered message column */}
        <div
          ref={messageColumnRef}
          className="max-w-3xl mx-auto w-full px-4 md:px-6 pt-2 pb-6 flex flex-col"
        >
          <ChatMessagesView
            visibleMessages={visibleMessages}
            lastUserMessageId={lastUserMessage?.id ?? null}
            lastMessageId={lastMessage?.id ?? null}
            isAwaitingAssistant={isAwaitingAssistant}
            isLastMessageAssistantLike={isLastMessageAssistantLike}
            copyMessage={copyMessage}
            copiedMessageId={copiedMessageId}
            forkMessage={readOnly ? undefined : forkMessage}
            forkingMessageId={forkingMessageId}
            runningStartedAt={runningStartedAt}
            activeTurnActionMessageId={activeAssistantMessageId}
            isAssistantTurnActive={assistantTurnActive}
            completedTurns={completedTurns}
            freshlyCompletedTurnId={freshlyCompletedTurnId}
            onFreshlyCompletedTurnAnimationScheduled={
              handleFreshlyCompletedTurnAnimationScheduled
            }
            skillSheetsByToolId={skillSheetsByToolId}
            error={error}
            setError={setError}
            llmProvider={llmProvider}
            threadModel={selectedThreadModel}
            isCompacting={isCompacting}
            compactingPriorMessageId={compactingPriorMessageId}
            isLoadingMessages={isLoadingMessages}
            deferRendering={!hasHydratedChatTranscript}
            showGlobalAssistantIndicator={showGlobalAssistantIndicator}
            shouldRenderSpacer={shouldRenderSpacer}
            lastUserMessageRef={lastUserMessageRef}
            assistantMeasureRef={assistantMeasureRef}
            assistantPendingMeasureRef={assistantPendingMeasureRef}
            assistantSpacerRef={assistantSpacerRef}
            messagesEndRef={messagesEndRef}
            mentionSlugMap={mentionSlugMap}
          />
        </div>
      </div>

      {!readOnly && (
        <div className="sticky bottom-0 z-20 shrink-0">
          {/* Scroll to bottom button */}
          <div className="relative">
            <Button
              variant="outline"
              size="icon"
              className={cn(
                "absolute -top-12 left-1/2 -translate-x-1/2 rounded-full shadow-md transition-all duration-200",
                "bg-background/80 backdrop-blur-sm border-border/50",
                showScrollButton
                  ? "opacity-100 translate-y-0"
                  : "opacity-0 translate-y-2 pointer-events-none",
              )}
              onClick={() => scrollToBottom("smooth")}
            >
              <ArrowDown className="h-4 w-4" />
            </Button>
          </div>
          {/* Gradient fade above composer */}
          <div
            className="absolute inset-x-0 bottom-full h-8 bg-gradient-to-t from-background to-transparent pointer-events-none"
            aria-hidden="true"
          />
          {/* Composer container */}
          <div className="bg-background">
            <div className="pt-2 px-4 [--safe-area-padding-bottom:1rem] pb-safe">
              <div className="max-w-3xl mx-auto w-full flex flex-col max-h-[calc(100dvh-2rem)]">
                {(pendingQuestion || currentTodos.length > 0) && (
                  <div className="min-h-0 shrink overflow-y-auto">
                    {pendingQuestion && (
                      <AskUserQuestion
                        data={pendingQuestion}
                        onSubmit={handleQuestionResponse}
                        className="mb-3"
                      />
                    )}
                    {currentTodos.length > 0 && (
                      <FloatingTodoList
                        todos={currentTodos}
                        isStreaming={isStreaming}
                        className="mb-3"
                      />
                    )}
                  </div>
                )}
                {noModelsMessage && (
                  <p className="mb-3 text-sm text-muted-foreground">
                    {noModelsMessage}
                  </p>
                )}
                {currentBillingCreditStatus ? (
                  <BillingCreditNotice
                    status={currentBillingCreditStatus}
                    onOpenUsage={() => navigate("/settings/organization/usage")}
                    onTopUp={handleBillingTopUp}
                    canTopUp={Boolean(isAdmin)}
                    userId={user?.id ?? null}
                    orgId={currentOrg?.id ?? null}
                    className="mb-2 shrink-0"
                  />
                ) : null}
                <PromptInput
                  className="shrink-0"
                  value={input}
                  onChange={setInput}
                  onSubmit={sendMessage}
                  onStop={stopGeneration}
                  placeholder="Type a message..."
                  isLoading={isLoadingMessages}
                  isAssistantRunning={loading || isStreaming || isAwaitingAssistant}
                  autoFocus
                  attachments={attachments}
                  onFilesSelected={handleFilesSelected}
                  onAttachmentRemove={handleAttachmentRemove}
                  disabled={Boolean(noModelsMessage)}
                  contextUsedPercent={contextUsedPercent}
                  onCompact={handleCompactFromIndicator}
                  model={selectedThreadModel}
                  onModelChange={handleThreadModelChange}
                  modelOptions={availableThreadModels}
                  modelDisabled={
                    loading ||
                    isStreaming ||
                    updateThreadModelFetcher.state !== "idle"
                  }
                  isOrgAdmin={isOrgAdmin}
                  recentModelScope={modelRecentScope}
                  textareaRef={composerTextareaRef}
                  mentionables={mentionEntities}
                  onMentionAddNewClick={() => navigate("/connections")}
                  onMentionMenuOpenChange={handleMentionMenuOpenChange}
                />
                <TopUpDialog
                  open={topUpOpen}
                  onOpenChange={setTopUpOpen}
                  packs={creditPacksFetcher.data?.packs ?? []}
                  action="/api/billing/credit-packs"
                  returnTo={currentChatPath}
                  loading={
                    topUpOpen && !creditPacksFetcher.data
                      ? true
                      : creditPacksFetcher.state !== "idle"
                  }
                  canTopUp={creditPacksFetcher.data?.canTopUp ?? Boolean(isAdmin)}
                  unavailableReason={
                    creditPacksFetcher.data?.unavailableReason ?? null
                  }
                />
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );

  return (
    <TooltipProvider>
      <ChatPreviewProvider
        value={{
          openPreviewTarget,
          clearPreviewTarget,
          resolveAppVisibility,
          workspaceId: resolvedWorkspaceId,
          formatFilePathForCopy,
        }}
      >
        <>
          {shouldShowChat ? (
            <div
              className="flex-1 min-h-0 relative flex flex-col"
              onDragOver={readOnly ? undefined : handleDragOver}
              onDragLeave={readOnly ? undefined : handleDragLeave}
              onDrop={readOnly ? undefined : handleDrop}
            >
              {/* Drag overlay */}
              {!readOnly && isDragOver && (
                <div className="absolute inset-0 z-50 flex items-center justify-center bg-primary/10 border-2 border-dashed border-primary rounded-lg m-2">
                  <div className="bg-background/90 backdrop-blur-sm px-6 py-4 rounded-xl shadow-lg">
                    <span className="text-lg font-medium text-primary">
                      Drop files here to upload
                    </span>
                  </div>
                </div>
              )}
              {isMobile ? (
                <div className="flex flex-1 min-h-0 flex-col overflow-hidden">
                  {previewTabs.length > 0 ? (
                    <>
                      <div className="relative flex-1 min-h-0 overflow-hidden">
                        <div
                          className={cn(
                            "flex h-full w-[200%] will-change-transform motion-safe:transition-transform motion-safe:duration-300 motion-safe:ease-out",
                            showMobilePreview
                              ? "-translate-x-1/2"
                              : "translate-x-0",
                          )}
                        >
                          <div className="flex w-1/2 shrink-0 flex-col min-h-0">
                            {chatPanelContent}
                          </div>
                          <div className="flex w-1/2 shrink-0 flex-col min-h-0 bg-background">
                            {previewPanelBody}
                          </div>
                        </div>
                      </div>
                      <div className="shrink-0 border-t border-border bg-background">
                        <MobileViewSwitcher
                          value={mobileView}
                          onChange={setMobileView}
                        />
                      </div>
                    </>
                  ) : (
                    <div className="flex flex-1 min-h-0 flex-col">
                      {chatPanelContent}
                    </div>
                  )}
                </div>
              ) : (
                <ResizablePanelGroup
                  direction="horizontal"
                  className="flex-1 min-h-0"
                >
                  <ResizablePanel
                    defaultSize={previewTabs.length > 0 ? "50%" : "100%"}
                    minSize="30%"
                    className="flex flex-col min-h-0 min-w-0"
                  >
                    {chatPanelContent}
                  </ResizablePanel>

                  {previewTabs.length > 0 && (
                    <>
                      <ResizableHandle withHandle />
                      <ResizablePanel
                        defaultSize="50%"
                        minSize="25%"
                        maxSize="70%"
                        className="flex flex-col min-h-0 min-w-0 bg-background"
                      >
                        {previewPanelBody}
                      </ResizablePanel>
                    </>
                  )}
                </ResizablePanelGroup>
              )}
            </div>
          ) : (
            <>
              {/* Welcome Screen */}
              <div
                className="flex-1 flex flex-col items-center px-4 py-8 relative overflow-y-auto"
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
              >
                {/* Drag overlay */}
                {isDragOver && (
                  <div className="absolute inset-0 z-50 flex items-center justify-center bg-primary/10 border-2 border-dashed border-primary rounded-lg m-2">
                    <div className="bg-background/90 backdrop-blur-sm px-6 py-4 rounded-xl shadow-lg">
                      <span className="text-lg font-medium text-primary">
                        Drop files here to upload
                      </span>
                    </div>
                  </div>
                )}
                {error ? (
                  <div className="mb-4 w-full max-w-3xl">
                    <ChatErrorNotice
                      error={error}
                      onDismiss={() => setError(null)}
                    />
                  </div>
                ) : null}
                <WelcomeScreen
                  userId={resolvedWelcomeData.userId}
                  userName={resolvedWelcomeData.userName}
                  allApps={resolvedWelcomeData.allApps}
                  connections={resolvedWelcomeData.connections}
                  projects={resolvedWelcomeData.projects}
                  recentThreads={resolvedWelcomeData.recentThreads}
                  renderedAt={resolvedWelcomeData.renderedAt}
                  group={resolvedWelcomeData.group}
                  inputValue={welcomeInput}
                  onPromptChange={setWelcomeInput}
                  onSubmit={startNewChat}
                  onStartChatForApp={handleStartChatForApp}
                  attachments={attachments}
                  onFilesSelected={handleFilesSelected}
                  onRecentAttachmentSelect={handleRecentAttachmentSelect}
                  onTranscriptAttach={handleGeneratedTranscriptAttachment}
                  onAttachmentRemove={handleAttachmentRemove}
                  isCreatingThread={isSubmittingNewThread}
                  model={selectedThreadModel}
                  onModelChange={handleThreadModelChange}
                  modelOptions={availableThreadModels}
                  isOrgAdmin={isOrgAdmin}
                  recentModelScope={modelRecentScope}
                  noModelsMessage={noModelsMessage}
                />
              </div>
            </>
          )}
        </>
      </ChatPreviewProvider>

      {/* Connection Setup Prompt Modal */}
      {connectionSetupPrompt && (
        <ConnectionSetupPrompt
          data={connectionSetupPrompt}
          onSubmit={handleConnectionSetupResponse}
          onCancel={handleConnectionSetupCancel}
        />
      )}

    </TooltipProvider>
  );
}
