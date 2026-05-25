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
} from "@/types";
import { useAuthData } from "@/hooks/use-auth-data";
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
import { OnboardingLoadingModal } from "@/components/onboarding-loading-modal";
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
import { buildSlugMap } from "@/lib/connection-mentions";
import { isFileDrag } from "@/lib/file-drag";
import {
  type SDKEvent,
  applyStreamingEventToMessage,
  attachToolResultsToMessages,
  extractToolEventMetaInfo,
  finalizeStreamingMessage,
  mergeTaskNotifications,
  normalizeToolResultMessages,
  mergeTeammateMessages,
} from "@/lib/streaming";
import {
  applyRuntimeEventToMessages,
  splitStreamingMessageForSteer,
} from "@/lib/runtime-message-state";
import { parseMessageContent } from "@/lib/chat-message-content";
import {
  getAppUrl,
  getIframeDomain,
  buildAppLabel,
} from "@/lib/app-url";
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
  type DraftData,
} from "@/hooks/use-draft-persistence";
import { useBufferedState } from "@/hooks/use-buffered-state";
import {
  appendUserUploadReferences,
  isUserUploadMountPath,
} from "@/lib/chat-attachment-refs";

export { ChatErrorNotice } from "@/components/chat-error-notice";
export { BillingCreditNotice } from "@/components/chat-billing-credit-notice";

const CHAT_PING_MESSAGE = JSON.stringify({ type: "ping" });
// The backend acknowledges receipt before slow runner enqueue work, so this
// timeout only covers messages that never make it to ChatThreadDO.
const MESSAGE_ACCEPTANCE_TIMEOUT_MS = 8_000;

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
  isNewThread?: boolean;
  /** Hostname from server for consistent URL generation (avoids hydration mismatch) */
  hostname?: string;
  /** Org slug for namespaced app URLs */
  orgSlug?: string;
  /** True when messages are still loading (deferred data) */
  isLoadingMessages?: boolean;
  /** Superuser admin read-only viewer */
  readOnly?: boolean;
  chatGroupId?: string | null;
  initialWelcomeInput?: string | null;
  connections?: Integration[];
  onSnapshotChange?: (snapshot: {
    messages: Message[];
    todos: TodoItem[];
  }) => void;
  welcomeData?: {
    userId: string | null;
    userName: string | null;
    allApps: WorkerScriptWithCreator[] | Promise<WorkerScriptWithCreator[]>;
    connections: Integration[];
    recentThreads: Thread[] | Promise<Thread[]>;
    renderedAt: number;
  };
}

type CompletedTurnMetadata = {
  durationMs: number;
  completedAtMs: number;
};

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
  if (args.threadId && args.threadModel) {
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
    args.threadModel ??
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
    runningActivityText?: string | null;
    runningActivityAt?: number | null;
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

function shouldShowBootModalFromStorage(isNewThread: boolean): boolean {
  if (typeof window === "undefined" || !isNewThread) return false;

  try {
    return Boolean(sessionStorage.getItem("showBootModal"));
  } catch {
    return false;
  }
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
      attachment.originalName === other.originalName
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
  return appendUserUploadReferences(
    text,
    getCompletedAttachments(attachments).map((attachment) => attachment.path),
  );
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

function isAssistantLikeMessage(msg: Message | null | undefined): boolean {
  return Boolean(msg && (msg.role === "assistant" || msg.isCompactSummary));
}

const STREAM_MESSAGE_RENDER_THROTTLE_MS = 50;

const CHAT_SCROLL_CONTAINER_STYLE = {
  overflowAnchor: "none",
} as CSSProperties;

function getLastToolUseId(message?: Message): string | undefined {
  if (!message || !Array.isArray(message.content)) return undefined;
  for (let i = message.content.length - 1; i >= 0; i -= 1) {
    const block = message.content[i];
    if (block && block.type === "tool_use" && block.id) return block.id;
  }
  return undefined;
}

function getLastToolUseIdFromMessages(messages: Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const id = getLastToolUseId(messages[i]);
    if (id) return id;
  }
  return undefined;
}

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
  isNewThread = false,
  hostname,
  orgSlug,
  isLoadingMessages = false,
  readOnly = false,
  chatGroupId = null,
  initialWelcomeInput,
  connections,
  onSnapshotChange,
  welcomeData,
}: ChatProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const submit = useSubmit();
  const updateThreadModelFetcher = useFetcher<{
    thread?: {
      id: string;
      model: LlmModel;
      updated_at: number;
    };
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
  // Compute initial drafts once per mount (Chat is keyed by threadId) to avoid
  // synchronous localStorage reads on every streaming re-render.
  const initialDraftsRef = useRef<
    { thread: DraftData | null; welcome: DraftData | null } | undefined
  >(undefined);
  if (initialDraftsRef.current === undefined) {
    const shouldRestore = !readOnly;
    initialDraftsRef.current = {
      thread: shouldRestore
        ? loadDraft(resolvedWorkspaceId, threadId ?? null)
        : null,
      welcome:
        !readOnly && !threadId && !initialWelcomeInput
          ? loadDraft(resolvedWorkspaceId, null)
          : null,
    };
  }
  const initialThreadDraft = initialDraftsRef.current.thread;
  const initialWelcomeDraft = initialDraftsRef.current.welcome;
  // Anchor to last message for existing threads with messages (not new threads)
  const shouldAnchorToLastMessage =
    !isNewThread && initialMessages && initialMessages.length > 0;

  // Parse initial messages once
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

  // Local state for messages, streaming, and loading
  const {
    state: messages,
    stateRef: messagesRef,
    setImmediate: setMessages,
    setBuffered: setMessagesDeferred,
    flush: flushDeferredMessagesRender,
  } = useBufferedState(parsedInitialMessages, STREAM_MESSAGE_RENDER_THROTTLE_MS);
  const [streamingMessageId, setStreamingMessageIdState] = useState<
    string | null
  >(null);
  const [completedTurns, setCompletedTurns] = useState<
    Map<string, CompletedTurnMetadata>
  >(() => new Map());
  const [freshlyCompletedTurnId, setFreshlyCompletedTurnId] = useState<
    string | null
  >(null);
  const [loading, setLoading] = useState(false);
  const [pendingMessages, setPendingMessagesState] = useState<Message[]>([]);
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
  const [bootModalOpen, setBootModalOpen] = useState(() =>
    shouldShowBootModalFromStorage(isNewThread),
  );

  useEffect(() => {
    if (!bootModalOpen) return;
    try {
      sessionStorage.removeItem("showBootModal");
    } catch {
      // Ignore storage failures; modal behavior should stay resilient.
    }
  }, [bootModalOpen]);

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
    if (!location.search.includes("prompt_key=")) {
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
  }, [location.search, threadId]);

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
  const normalizedMessages = useMemo(
    () =>
      mergeTaskNotifications(
        mergeTeammateMessages(normalizeToolResultMessages(messages)),
      ),
    [messages],
  );
  const visibleMessages = useMemo(
    () =>
      normalizedMessages.filter(
        (message) => !message.isMeta && !message.sourceToolUseID,
      ),
    [normalizedMessages],
  );

  // Refs to track current state for use in callbacks (avoids stale closures)
  const streamingMessageIdRef = useRef(streamingMessageId);
  const runtimeStreamingMessageIdsRef = useRef<Record<string, string | null>>(
    {},
  );
  const lastCompletedAssistantMessageIdRef = useRef<string | null>(null);
  const completedTurnsRef = useRef<Map<string, CompletedTurnMetadata>>(
    new Map(),
  );
  const pendingMessagesRef = useRef(pendingMessages);
  const sentPendingMessageIdsRef = useRef<Set<string>>(new Set());
  const pendingMessageAcceptanceTimeoutsRef = useRef<
    Map<string, ReturnType<typeof setTimeout>>
  >(new Map());
  const pendingThreadContextRef = useRef({
    workspaceId: resolvedWorkspaceId,
    threadId,
    isNewThread,
    readOnly,
  });
  pendingThreadContextRef.current = {
    workspaceId: resolvedWorkspaceId,
    threadId,
    isNewThread,
    readOnly,
  };

  const prevInitialMessagesRef = useRef(initialMessages);
  const hasSyncedInitialPreviewRef = useRef(false);
  const previousPreviewThreadIdRef = useRef(threadId);

  const setStreamingMessageId = useCallback((id: string | null) => {
    streamingMessageIdRef.current = id;
    setStreamingMessageIdState(id);
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

  useEffect(() => {
    const initialMessagesChanged =
      initialMessages !== prevInitialMessagesRef.current;
    if (
      !initialMessagesChanged ||
      streamingMessageIdRef.current ||
      pendingMessagesRef.current.length > 0
    ) {
      return;
    }
    prevInitialMessagesRef.current = initialMessages;

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

  const isStreaming = streamingMessageId !== null;
  const activeAssistantMessageId = useMemo(() => {
    if (streamingMessageId) {
      const trackedMessageExists = messages.some(
        (msg) => msg.id === streamingMessageId && msg.role === "assistant",
      );
      if (trackedMessageExists) return streamingMessageId;
    }

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "assistant" && msg.isStreaming) return msg.id;
    }

    return null;
  }, [messages, streamingMessageId]);
  const assistantTurnActive =
    loading || isStreaming || activeAssistantMessageId !== null;
  const hasActiveAssistantMessage = activeAssistantMessageId !== null;
  const showGlobalAssistantIndicator =
    assistantTurnActive && !hasActiveAssistantMessage && !isCompacting;
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
  const [input, setInput] = useState(() => initialThreadDraft?.text ?? "");
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
    () => initialWelcomeInput ?? initialWelcomeDraft?.text ?? "",
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
  const noModelsMessage =
    availableThreadModels.length === 0
      ? "No models are available. Ask an admin to add a model in Settings > Models."
      : null;
  const lastAppliedWelcomeInputRef = useRef(initialWelcomeInput ?? "");
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [forkingMessageId, setForkingMessageId] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>(
    () =>
      initialThreadDraft?.attachments ?? initialWelcomeDraft?.attachments ?? [],
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
  const { saveDraft, flushDraft, clearDraft } = useDraftPersistence(
    resolvedWorkspaceId,
    threadId ?? null,
  );
  const [isDragOver, setIsDragOver] = useState(false);

  useEffect(() => {
    setError(
      initialError
        ? getChatApiErrorPresentation(initialError, {
            llmProvider,
            threadModel,
          })
        : null,
    );
  }, [initialError, llmProvider, threadModel]);

  useEffect(() => {
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
  }, [newChatActionError, readOnly, resolvedWorkspaceId, threadId]);

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
  const splitStreamingMessageOnNextPartRef = useRef(false);
  const wsRef = useRef<WebSocket | null>(null);
  const {
    connectionSetupPrompt,
    handleConnectionSetupCancel,
    handleConnectionSetupResponse,
    setConnectionSetupPrompt,
  } = useConnectionSetupResponse({
    wsRef,
  });
  const lastRunnerModelSelectionRef = useRef<string | null>(null);
  const iframeRefreshTimeoutsRef = useRef<
    Record<string, ReturnType<typeof setTimeout>>
  >({});
  const iframeRetryCountsRef = useRef<Record<string, number>>({});
  const iframeRetryTimeoutsRef = useRef<
    Record<string, ReturnType<typeof setTimeout>>
  >({});
  const reconnectAttempts = useRef(0);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const queuedSendReadyTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const pingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement>(null);
  const sessionIdRef = useRef<string | null>(null);
  const lastEventIdRef = useRef(0);
  const connectionStartedAtRef = useRef<Map<number, number>>(new Map());
  const fallbackRenderedAtRef = useRef<number>(Date.now());

  useEffect(() => {
    initialScrollDoneRef.current = false;
    stickToBottomRef.current = true;
    splitStreamingMessageOnNextPartRef.current = false;
    setCurrentTodos(initialTodos);
    setPendingQuestion(null);
    setContextUsedPercent(null);
    lastCompletedAssistantMessageIdRef.current = null;
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

  useEffect(() => {
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
    const iframeDomain = hostname ? getIframeDomain(hostname) : null;

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
      const matchedTab = iframeDomain
        ? tabs.find((tab) => {
            if (tab.target.kind !== "app") return false;
            const s = tab.target.scriptName;
            const host = orgSlug
              ? `${buildAppLabel(s, orgSlug)}.${iframeDomain}`
              : `${s}.${iframeDomain}`;
            return event.origin === `https://${host}`;
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

  useEffect(() => {
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
  const connectionIdRef = useRef(0);
  // Ref to hold stable connect function for effect
  const connectWebSocketRef = useRef<
    ((id: string, isReconnect?: boolean) => void) | null
  >(null);
  const resolvedWelcomeData = welcomeData ?? {
    userId: user?.id ?? null,
    userName: user?.name ?? null,
    allApps: [],
    connections: [],
    recentThreads: [],
    renderedAt: fallbackRenderedAtRef.current,
  };
  const mentionConnections = connections ?? resolvedWelcomeData.connections;
  const mentionSlugMap = useMemo(
    () => buildSlugMap(mentionConnections) as Map<string, Integration>,
    [mentionConnections],
  );
  const sessionStorageKey = useCallback(
    (id: string) => {
      const workspaceKey = resolvedWorkspaceId ?? "unknown";
      return `ws_session_${workspaceKey}_${id}`;
    },
    [resolvedWorkspaceId],
  );

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

  const logRunnerClient = useCallback(
    (event: string, fields: Record<string, unknown> = {}) => {
      if (import.meta.env.MODE === "test") return;
      console.info("[chat runner client]", {
        event,
        threadId,
        workspaceId: resolvedWorkspaceId,
        ready,
        pendingMessages: pendingMessagesRef.current.length,
        wsReadyState: wsRef.current?.readyState ?? null,
        ...fields,
      });
    },
    [ready, resolvedWorkspaceId, threadId],
  );

  const clearQueuedSendReadyTimeout = useCallback(() => {
    if (queuedSendReadyTimeoutRef.current) {
      clearTimeout(queuedSendReadyTimeoutRef.current);
      queuedSendReadyTimeoutRef.current = null;
    }
  }, []);

  const clearPendingMessageAcceptanceTimeout = useCallback(
    (clientMessageId: string) => {
      const timeout = pendingMessageAcceptanceTimeoutsRef.current.get(
        clientMessageId,
      );
      if (!timeout) {
        return;
      }
      clearTimeout(timeout);
      pendingMessageAcceptanceTimeoutsRef.current.delete(clientMessageId);
    },
    [],
  );

  const clearAllPendingMessageAcceptanceTimeouts = useCallback(() => {
    for (const timeout of pendingMessageAcceptanceTimeoutsRef.current.values()) {
      clearTimeout(timeout);
    }
    pendingMessageAcceptanceTimeoutsRef.current.clear();
  }, []);

  const isPendingMessageAccepted = useCallback((clientMessageId: string) => {
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

  const failPendingMessageDelivery = useCallback(
    (message: string) => {
      logRunnerClient("pending_delivery_failed", { message });
      clearAllPendingMessageAcceptanceTimeouts();
      const unsentIds = new Set(pendingMessagesRef.current.map((msg) => msg.id));
      if (unsentIds.size > 0) {
        setMessages((prev) => prev.filter((msg) => !unsentIds.has(msg.id)));
      }
      sentPendingMessageIdsRef.current.clear();
      setPendingMessages([]);
      clearQueuedSendReadyTimeout();
      setLoading(false);
      setReady(false);
      setStreamingMessageId(null);
      dispatchLocalThreadStatus(pendingThreadContextRef.current.threadId, "idle");
      restorePendingDeliveryDraft();
      showChatError(message);
    },
    [
      clearAllPendingMessageAcceptanceTimeouts,
      clearQueuedSendReadyTimeout,
      logRunnerClient,
      restorePendingDeliveryDraft,
      showChatError,
      setMessages,
      setPendingMessages,
      setStreamingMessageId,
    ],
  );

  const startPendingMessageAcceptanceTimeout = useCallback(
    (clientMessageId: string) => {
      clearPendingMessageAcceptanceTimeout(clientMessageId);
      const timeout = setTimeout(() => {
        pendingMessageAcceptanceTimeoutsRef.current.delete(clientMessageId);
        if (isPendingMessageAccepted(clientMessageId)) {
          return;
        }

        const stillPending = pendingMessagesRef.current.some(
          (message) =>
            message.id === clientMessageId ||
            message.clientMessageId === clientMessageId,
        );
        if (!stillPending) {
          return;
        }

        logRunnerClient("message_acceptance_timeout", { clientMessageId });
        failPendingMessageDelivery(
          "The message did not reach the server. I restored it as a draft so you can try again.",
        );
      }, MESSAGE_ACCEPTANCE_TIMEOUT_MS);
      pendingMessageAcceptanceTimeoutsRef.current.set(clientMessageId, timeout);
    },
    [
      clearPendingMessageAcceptanceTimeout,
      failPendingMessageDelivery,
      isPendingMessageAccepted,
      logRunnerClient,
    ],
  );

  const loadSessionState = useCallback(
    (id: string) => {
      try {
        const stored = sessionStorage.getItem(sessionStorageKey(id));
        if (stored) {
          const parsed = JSON.parse(stored) as {
            sessionId?: string;
            lastEventId?: number;
            lastSideChannelEventId?: number;
            lastRunnerSeq?: number;
          };
          const legacyLastEventId =
            typeof parsed.lastEventId === "number" ? parsed.lastEventId : 0;
          sessionIdRef.current =
            typeof parsed.sessionId === "string" ? parsed.sessionId : null;
          lastEventIdRef.current = Math.max(
            legacyLastEventId,
            typeof parsed.lastSideChannelEventId === "number"
              ? parsed.lastSideChannelEventId
              : 0,
            typeof parsed.lastRunnerSeq === "number" ? parsed.lastRunnerSeq : 0,
          );
          return;
        }
      } catch (e) {
        console.warn("Failed to load session state:", e);
      }
      sessionIdRef.current = null;
      lastEventIdRef.current = 0;
    },
    [sessionStorageKey],
  );

  const persistSessionState = useCallback(
    (id: string) => {
      try {
        const payload = {
          sessionId: sessionIdRef.current,
          lastEventId: lastEventIdRef.current,
        };
        sessionStorage.setItem(sessionStorageKey(id), JSON.stringify(payload));
      } catch (e) {
        console.warn("Failed to persist session state:", e);
      }
    },
    [sessionStorageKey],
  );

  useEffect(() => {
    if (!threadId) {
      sessionIdRef.current = null;
      lastEventIdRef.current = 0;
      return;
    }
    loadSessionState(threadId);
  }, [threadId, loadSessionState, resolvedWorkspaceId]);

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
      const socket = wsRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;

      socket.send(
        JSON.stringify({
          type: "set_preview_tabs_state",
          tabs: nextTabs.map((tab) => tab.target),
          activeTabId: nextActiveTabId,
          threadId,
        }),
      );
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

  const handleRealtimeSideChannelEvent = useCallback(
    (data: any) => {
      if (data.type === "preview_state") {
        const newVersion = typeof data.version === "number" ? data.version : 0;
        const hasVersionBump = newVersion > previewVersionRef.current;
        previewVersionRef.current = newVersion;
        const hasRefreshHint = data.refreshTabId !== undefined;
        const refreshTabId =
          typeof data.refreshTabId === "string" ? data.refreshTabId : null;

        const nextSession = normalizePreviewSessionState(
          data.tabs,
          data.activeTabId,
          null,
        );
        setLocalPreviewSessionState(nextSession.tabs, nextSession.activeTabId);

        if (!nextSession.target || !nextSession.activeTabId) {
          return;
        }

        const nextActiveId = nextSession.activeTabId;
        const shouldRefreshActiveTab = refreshTabId
          ? refreshTabId === nextActiveId
          : !hasRefreshHint && hasVersionBump;

        if (nextSession.target.kind === "app" && shouldRefreshActiveTab) {
          const existingTimeout = iframeRefreshTimeoutsRef.current[nextActiveId];
          if (existingTimeout) {
            clearTimeout(existingTimeout);
          }
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
        } else if (
          nextSession.target.kind === "file" &&
          shouldRefreshActiveTab
        ) {
          const fileViewMode =
            tabFileViewModesRef.current[nextActiveId] ?? "preview";
          if (shouldAutoRefreshFilePreview(nextSession.target, fileViewMode)) {
            bumpFilePreviewKey(nextActiveId);
          }
        }

        return;
      }

      if (data.type === "title_updated" && typeof data.title === "string") {
        if (typeof document !== "undefined") {
          document.title = `${data.title || "Chat"} - camelAI`;
        }
        const updatedAt =
          typeof data.updatedAt === "number" && Number.isFinite(data.updatedAt)
            ? data.updatedAt
            : Date.now();
        dispatchLocalThreadSummaryUpdate(threadId, {
          title: data.title,
          updatedAt,
        });
        return;
      }

      if (data.type === "thread_model_updated" && isLlmModel(data.model)) {
        const updatedAt =
          typeof data.updatedAt === "number" && Number.isFinite(data.updatedAt)
            ? data.updatedAt
            : Date.now();
        setSelectedThreadModel(data.model);
        dispatchLocalThreadSummaryUpdate(threadId, {
          model: data.model,
          updatedAt,
        });
        return;
      }

      if (
        data.type === "connection_setup_prompt" &&
        data.requestId &&
        data.integrationType
      ) {
        setConnectionSetupPrompt({
          requestId: data.requestId as string,
          integrationType: data.integrationType as string,
          suggestedName: data.suggestedName as string | undefined,
          message: data.message as string | undefined,
          instructions: data.instructions as string | undefined,
          dynamicSchema:
            data.dynamicSchema as ConnectionSetupPromptData["dynamicSchema"],
        });
        return;
      }

      if (data.type === "connection_setup_answered" && data.requestId) {
        setConnectionSetupPrompt((prev) =>
          prev?.requestId === data.requestId ? null : prev,
        );
        return;
      }

      if (data.type === "connection_setup_error" && data.requestId) {
        setConnectionSetupPrompt((prev) =>
          prev?.requestId === data.requestId ? null : prev,
        );
        showChatError(
          typeof data.error === "string"
            ? data.error
            : "Connection setup failed. Please ask the agent to start connection setup again.",
        );
        return;
      }

      return;
    },
    [
      threadId,
      setLocalPreviewSessionState,
      bumpIframeKey,
      bumpFilePreviewKey,
      showChatError,
    ],
  );

  // WebSocket connection management
  const connectWebSocket = useCallback(
    (id: string, isReconnect = false) => {
      if (!id) {
        return;
      }
      // Clear any pending reconnect
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      clearQueuedSendReadyTimeout();

      // Increment connection ID to invalidate any pending callbacks from old connections
      const thisConnectionId = ++connectionIdRef.current;
      connectionStartedAtRef.current.set(thisConnectionId, Date.now());

      // Close existing connection regardless of state
      // This prevents orphaned WebSockets from React StrictMode double-mounting
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }

      // Clear any existing ping interval
      if (pingIntervalRef.current) {
        clearInterval(pingIntervalRef.current);
        pingIntervalRef.current = null;
      }

      setReady(false);
      // Clear stale streaming state on reconnect; server sends the
      // authoritative streaming_state immediately after ready.
      setStreamingMessageId(null);
      lastCompletedAssistantMessageIdRef.current = null;
      compactingPriorMessageIdRef.current = null;
      setCompactingPriorMessageId(null);
      setLoading(false);
      isAutoCompactingRef.current = false;
      syncCompactionIndicator();
      if (!isReconnect) {
        reconnectAttempts.current = 0;
      }

      const wsHost = window.location.host;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const workspaceIdForConnection = resolvedWorkspaceId;
      // One browser WebSocket connects to ChatThreadDO for agent streaming,
      // replay, preview state, prompts, and other realtime chat state.
      const wsUrl = `${protocol}//${wsHost}/ws/${workspaceIdForConnection}?threadId=${encodeURIComponent(id)}`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        // Ignore if this connection was superseded
        if (connectionIdRef.current !== thisConnectionId) {
          return;
        }
        logRunnerClient("ws_open", {
          connectionId: thisConnectionId,
          isReconnect,
        });
        reconnectAttempts.current = 0;

        // Start ping interval to detect connection issues early
        if (pingIntervalRef.current) {
          clearInterval(pingIntervalRef.current);
        }
        pingIntervalRef.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(CHAT_PING_MESSAGE);
          }
        }, 30000); // Ping every 30 seconds

        // Send init message to container
        ws.send(
          JSON.stringify({
            type: "init",
            threadId: id,
            sessionId: sessionIdRef.current,
            lastEventId: lastEventIdRef.current,
          }),
        );
      };

      ws.onmessage = (event) => {
        // Ignore messages from stale WebSocket instances (e.g., from StrictMode double-mount)
        if (wsRef.current !== ws) {
          return;
        }

        const data = JSON.parse(event.data);

        if (typeof data?.eventId === "number") {
          lastEventIdRef.current = Math.max(lastEventIdRef.current, data.eventId);
          if (id) {
            persistSessionState(id);
          }
        }

        if (data.type === "ready") {
          // Container is ready to receive messages
          clearQueuedSendReadyTimeout();
          logRunnerClient("runner_ready", {
            queuedMessages: pendingMessagesRef.current.length,
          });
          setReady(true);

          const queuedMessages = pendingMessagesRef.current.filter((message) => {
            if (message.role !== "user") return false;
            const deliveryKey = message.clientMessageId ?? message.id;
            return !sentPendingMessageIdsRef.current.has(deliveryKey);
          });
          if (queuedMessages.length > 0) {
            setLoading(true);

            // Restore to state if a route revalidation already accepted them.
            const currentMessages = messagesRef.current;
            const existingIds = new Set(currentMessages.map((m) => m.id));
            const missing = queuedMessages.filter(
              (m) => !existingIds.has(m.id),
            );
            if (missing.length > 0) {
              setMessages([...currentMessages, ...missing]);
            }

            // Send all queued messages
            for (const msg of queuedMessages) {
              const content =
                typeof msg.content === "string"
                  ? msg.content
                  : JSON.stringify(msg.content);
              logRunnerClient("queued_message_sent", {
                messageId: msg.id,
                contentLength: content.length,
              });
              const clientMessageId = msg.clientMessageId ?? msg.id;
              sentPendingMessageIdsRef.current.add(clientMessageId);
              startPendingMessageAcceptanceTimeout(clientMessageId);
              ws.send(
                JSON.stringify({
                  type: "message",
                  content,
                  clientMessageId,
                  sessionId: sessionIdRef.current,
                  threadId: id,
                }),
              );
            }
            setPendingMessages((prev) => prev);
          }
        } else if (
          data.type === "session" &&
          typeof data.sessionId === "string"
        ) {
          const newSessionId = data.sessionId;
          if (sessionIdRef.current && sessionIdRef.current !== newSessionId) {
            lastEventIdRef.current = 0;
          }
          sessionIdRef.current = newSessionId;
          if (id) {
            persistSessionState(id);
          }
        } else if (data.type === "runtime_event") {
          if (!id) {
            return;
          }
          const runtimeEvent = data.event;
          const isTurnCompleted =
            runtimeEvent &&
            typeof runtimeEvent === "object" &&
            (runtimeEvent as { method?: unknown }).method === "turn/completed";
          const completedParams: {
            forkEntryId?: unknown;
            completedAtMs?: unknown;
            turnDurationMs?: unknown;
          } = isTurnCompleted
            ? ((runtimeEvent as {
                params?: {
                  forkEntryId?: unknown;
                  completedAtMs?: unknown;
                  turnDurationMs?: unknown;
                };
              }).params ?? {})
            : {};
          const completingStreamingId = isTurnCompleted
            ? runtimeStreamingMessageIdsRef.current[id] ??
              streamingMessageIdRef.current
            : null;
          setMessagesDeferred((prev) => {
            const next = applyRuntimeEventToMessages(
              prev,
              id,
              "codex",
              runtimeEvent,
              runtimeStreamingMessageIdsRef.current,
            );
            return next;
          });
          const nextStreamingId =
            runtimeStreamingMessageIdsRef.current[id] ?? null;
          setStreamingMessageId(nextStreamingId);

          if (isTurnCompleted) {
            const forkEntryId =
              typeof completedParams.forkEntryId === "string" &&
              completedParams.forkEntryId.trim()
                ? completedParams.forkEntryId.trim()
                : null;
            const completedTurnId = forkEntryId || completingStreamingId;
            const completedAtMs =
              typeof completedParams.completedAtMs === "number" &&
              Number.isFinite(completedParams.completedAtMs)
                ? completedParams.completedAtMs
                : Date.now();
            const durationMs =
              typeof completedParams.turnDurationMs === "number" &&
              Number.isFinite(completedParams.turnDurationMs)
                ? Math.max(0, completedParams.turnDurationMs)
                : 0;
            if (completedTurnId) {
              completedTurnsRef.current.set(completedTurnId, {
                durationMs,
                completedAtMs,
              });
              setCompletedTurns(new Map(completedTurnsRef.current));
              setFreshlyCompletedTurnId(completedTurnId);
            }
            flushDeferredMessagesRender();
            lastCompletedAssistantMessageIdRef.current =
              completedTurnId ?? nextStreamingId;
            setStreamingMessageId(null);
            setLoading(false);
            setPendingMessages([]);
            dispatchLocalThreadStatus(id, "idle");
            clearPendingDeliveryDraft();
          }
        } else if (data.type === "sdk_event") {
          // Handle SDK events for streaming
          const sdkEvent = data.event as SDKEvent;
          const currentStreamingId = streamingMessageIdRef.current;

          if (sdkEvent.type === "stream_event") {
            const evt = sdkEvent.event;

            // ── Compaction content block interception ──
            // The API streams the compaction summary as a content block of type
            // 'compaction' with a single 'compaction_delta' containing the full
            // summary text. Intercept these events before they reach the normal
            // streaming pipeline so the summary is rendered as a standalone
            // CompactSummaryCard instead of being appended to the assistant message.
            if (
              evt?.type === "content_block_start" &&
              evt?.content_block?.type === "compaction"
            ) {
              isInCompactionBlockRef.current = true;
              compactionContentRef.current = "";
              hasCapturedCompactionSummaryRef.current = false;
              // Fallback trigger when system/status events are unavailable.
              isAutoCompactingRef.current = true;
              syncCompactionIndicator();
              // Only capture once: status events are the primary source and this is
              // a fallback path when those events are missing.
              if (compactingPriorMessageIdRef.current === null) {
                const priorId =
                  streamingMessageIdRef.current ??
                  lastCompletedAssistantMessageIdRef.current ??
                  null;
                compactingPriorMessageIdRef.current = priorId;
                setCompactingPriorMessageId(priorId);
              }
              if (streamingMessageIdRef.current) {
                setStreamingMessageId(null);
              }
              return;
            }
            if (isInCompactionBlockRef.current) {
              if (
                evt?.type === "content_block_delta" &&
                evt?.delta?.type === "compaction_delta"
              ) {
                compactionContentRef.current += evt.delta.content || "";
                return;
              }
              if (evt?.type === "content_block_stop") {
                const summary = compactionContentRef.current;
                isInCompactionBlockRef.current = false;
                compactionContentRef.current = "";
                compactingPriorMessageIdRef.current = null;
                setCompactingPriorMessageId(null);
                if (summary) {
                  hasCapturedCompactionSummaryRef.current = true;
                  completeActiveManualCompaction();
                  isAutoCompactingRef.current = false;
                  syncCompactionIndicator();
                  const existingPlaceholderId =
                    pendingCompactionPlaceholderIdRef.current;
                  const compactMsg: Message = {
                    id: existingPlaceholderId || `compact_${Date.now()}`,
                    thread_id: id,
                    role: "user",
                    content: summary,
                    created_at: Date.now(),
                    isCompactSummary: true,
                  };
                  pendingCompactionPlaceholderIdRef.current = compactMsg.id;
                  setMessages((prev) => {
                    if (existingPlaceholderId) {
                      const placeholderIndex = prev.findIndex(
                        (m) => m.id === existingPlaceholderId,
                      );
                      if (placeholderIndex !== -1) {
                        const next = [...prev];
                        next[placeholderIndex] = compactMsg;
                        return next;
                      }
                    }
                    const existingSummaryIndex = prev.findIndex(
                      (m) => m.id === compactMsg.id,
                    );
                    if (existingSummaryIndex !== -1) {
                      const next = [...prev];
                      next[existingSummaryIndex] = compactMsg;
                      return next;
                    }
                    return [...prev, compactMsg];
                  });
                }
                return;
              }
            }

            if (evt?.type === "message_start") {
              const currentMsgs = messagesRef.current;
              const existingStreamingId = streamingMessageIdRef.current;
              const existingStreamingMsg = existingStreamingId
                ? currentMsgs.find((msg) => msg.id === existingStreamingId)
                : undefined;
              const fallbackStreamingMsg = existingStreamingMsg
                ? undefined
                : currentMsgs.find((msg) => msg.isStreaming);
              const activeStreamingMsg =
                existingStreamingMsg ?? fallbackStreamingMsg;

              if (
                splitStreamingMessageOnNextPartRef.current &&
                activeStreamingMsg
              ) {
                splitStreamingMessageOnNextPartRef.current = false;
                const nextMsgIdBase =
                  evt.message?.id ||
                  (sdkEvent as { uuid?: string }).uuid ||
                  `stream_${Date.now()}`;
                const nextMsgId = currentMsgs.some(
                  (msg) => msg.id === nextMsgIdBase,
                )
                  ? `${nextMsgIdBase}_${Date.now()}`
                  : nextMsgIdBase;

                setStreamingMessageId(nextMsgId);
                setMessages((prev) => {
                  const finalized = prev.map((msg) =>
                    msg.id === activeStreamingMsg.id
                      ? finalizeStreamingMessage(msg)
                      : msg,
                  );
                  const newMsg: Message = {
                    id: nextMsgId,
                    thread_id: id,
                    role: "assistant",
                    content: [],
                    created_at: Date.now(),
                    isStreaming: true,
                  };
                  if (finalized.some((msg) => msg.id === nextMsgId)) {
                    return finalized.map((msg) =>
                      msg.id === nextMsgId
                        ? applyStreamingEventToMessage(msg, sdkEvent)
                        : msg,
                    );
                  }
                  const withNew = [...finalized, newMsg];
                  return withNew.map((msg) =>
                    msg.id === nextMsgId
                      ? applyStreamingEventToMessage(msg, sdkEvent)
                      : msg,
                  );
                });
                return;
              }

              if (existingStreamingMsg) {
                // Claude emits a new message_start after each tool call; append to the active turn.
                setMessages((prev) =>
                  prev.map((msg) =>
                    msg.id === existingStreamingId
                      ? applyStreamingEventToMessage(msg, sdkEvent)
                      : msg,
                  ),
                );
                return;
              }

              if (fallbackStreamingMsg) {
                setStreamingMessageId(fallbackStreamingMsg.id);
                setMessages((prev) =>
                  prev.map((msg) =>
                    msg.id === fallbackStreamingMsg.id
                      ? applyStreamingEventToMessage(msg, sdkEvent)
                      : msg,
                  ),
                );
                return;
              }

              // Add new assistant message with isStreaming: true
              const msgId =
                evt.message?.id ||
                (sdkEvent as { uuid?: string }).uuid ||
                `stream_${Date.now()}`;
              setStreamingMessageId(msgId);
              const newMsg: Message = {
                id: msgId,
                thread_id: id,
                role: "assistant",
                content: [],
                created_at: Date.now(),
                isStreaming: true,
              };
              // Use functional update to avoid race conditions with rapid events
              setMessages((prev) => {
                if (prev.some((m) => m.id === msgId)) {
                  return prev;
                }
                return [...prev, newMsg];
              });
            } else if (currentStreamingId) {
              // Apply streaming delta to the current message
              setMessagesDeferred((prev) =>
                prev.map((msg) =>
                  msg.id === currentStreamingId
                    ? applyStreamingEventToMessage(msg, sdkEvent)
                    : msg,
                ),
              );
            } else {
              // No streamingMessageId - try to restore from streaming message (reconnect scenario)
              const currentMessages = messagesRef.current;
              const streamingMsg = currentMessages.find((m) => m.isStreaming);
              if (streamingMsg) {
                setStreamingMessageId(streamingMsg.id);
                setMessagesDeferred((prev) =>
                  prev.map((msg) =>
                    msg.id === streamingMsg.id
                      ? applyStreamingEventToMessage(msg, sdkEvent)
                      : msg,
                  ),
                );
              }
            }
          } else if (
            sdkEvent.type === "system" &&
            sdkEvent.subtype === "init"
          ) {
            // System init - reset the streaming message ID
            splitStreamingMessageOnNextPartRef.current = false;
            setStreamingMessageId(null);
            startQueuedManualCompactionIfNeeded();
          } else if (
            sdkEvent.type === "system" &&
            sdkEvent.subtype === "status"
          ) {
            const status = (sdkEvent as unknown as Record<string, unknown>)
              .status;
            if (status === "compacting") {
              isAutoCompactingRef.current = true;
              syncCompactionIndicator();
              const priorId =
                streamingMessageIdRef.current ??
                lastCompletedAssistantMessageIdRef.current ??
                null;
              compactingPriorMessageIdRef.current = priorId;
              setCompactingPriorMessageId(priorId);
              if (streamingMessageIdRef.current) {
                setStreamingMessageId(null);
              }
            } else if (status === null) {
              isAutoCompactingRef.current = false;
              syncCompactionIndicator();
              compactingPriorMessageIdRef.current = null;
              setCompactingPriorMessageId(null);
            }
          } else if (
            sdkEvent.type === "system" &&
            sdkEvent.subtype === "compact_boundary"
          ) {
            // Compaction is complete — the compact_boundary event arrives AFTER the
            // SDK finishes generating the summary (not before). Insert a compact
            // summary card immediately. If the control plane later forwards the full
            // summary (isCompactSummary user event), it will replace this placeholder.
            completeActiveManualCompaction();
            isAutoCompactingRef.current = false;
            syncCompactionIndicator();
            compactingPriorMessageIdRef.current = null;
            setCompactingPriorMessageId(null);
            if (hasCapturedCompactionSummaryRef.current) {
              hasCapturedCompactionSummaryRef.current = false;
              return;
            }
            const compactMsg: Message = {
              id: `compact_${Date.now()}`,
              thread_id: id,
              role: "user",
              content:
                "The conversation context was compacted to continue this session.",
              created_at: Date.now(),
              isCompactSummary: true,
            };
            pendingCompactionPlaceholderIdRef.current = compactMsg.id;
            setMessages((prev) => [...prev, compactMsg]);
          } else if (
            sdkEvent.type === "assistant" &&
            sdkEvent.message?.content
          ) {
            // Track message ID as fallback
            if (!currentStreamingId) {
              const sdkUuid = (sdkEvent as { uuid?: string }).uuid;
              const sdkMsgId = (sdkEvent.message as { id?: string }).id;
              if (sdkUuid || sdkMsgId) {
                setStreamingMessageId(sdkUuid || sdkMsgId || null);
              }
            }
          } else if (sdkEvent.type === "user" && sdkEvent.message?.content) {
            // Compact summary — system-generated context recap
            const isCompactSummary = Boolean(
              (sdkEvent as unknown as Record<string, unknown>).isCompactSummary,
            );
            if (isCompactSummary) {
              completeActiveManualCompaction();
              isAutoCompactingRef.current = false;
              syncCompactionIndicator();
              compactingPriorMessageIdRef.current = null;
              setCompactingPriorMessageId(null);
              hasCapturedCompactionSummaryRef.current = false;
              const placeholderId = pendingCompactionPlaceholderIdRef.current;
              pendingCompactionPlaceholderIdRef.current = null;
              const content = sdkEvent.message.content;
              const compactMsg: Message = {
                id:
                  (sdkEvent as { uuid?: string }).uuid ||
                  `compact_${Date.now()}`,
                thread_id: id,
                role: "user",
                content,
                created_at: Date.now(),
                isCompactSummary: true,
              };
              // Replace only the currently tracked provisional compact card
              // with the forwarded full summary.
              setMessages((prev) => {
                const existingSummaryIndex = prev.findIndex(
                  (m) => m.id === compactMsg.id,
                );
                const upsertBySummaryId = () => {
                  if (existingSummaryIndex === -1) {
                    return [...prev, compactMsg];
                  }
                  const next = [...prev];
                  next[existingSummaryIndex] = compactMsg;
                  return next;
                };
                if (!placeholderId) {
                  return upsertBySummaryId();
                }
                const placeholderIndex = prev.findIndex(
                  (m) => m.id === placeholderId,
                );
                if (placeholderIndex === -1) {
                  return upsertBySummaryId();
                }
                const next = [...prev];
                next[placeholderIndex] = compactMsg;
                return next;
              });
              return;
            }

            const contentBlocks = sdkEvent.message.content;
            const isToolResultEvent =
              Array.isArray(contentBlocks) &&
              contentBlocks.length > 0 &&
              contentBlocks.every((block) => block?.type === "tool_result");
            const { sourceToolUseID } = extractToolEventMetaInfo(sdkEvent);

            if (!isToolResultEvent) {
              const shouldBeMeta = true;
              const streamingMessage = streamingMessageIdRef.current
                ? messagesRef.current.find(
                    (msg) => msg.id === streamingMessageIdRef.current,
                  )
                : undefined;
              const fallbackToolUseId =
                shouldBeMeta && !sourceToolUseID
                  ? getLastToolUseId(streamingMessage) ||
                    getLastToolUseIdFromMessages(messagesRef.current)
                  : undefined;
              const resolvedToolUseId = sourceToolUseID || fallbackToolUseId;
              const metaMsg: Message = {
                id: `meta_${resolvedToolUseId ?? Date.now()}_${Date.now()}`,
                thread_id: id,
                role: "user",
                content: contentBlocks,
                created_at: Date.now(),
                isMeta: shouldBeMeta,
                sourceToolUseID: resolvedToolUseId,
              };
              setMessages((prev) => [...prev, metaMsg]);
              return;
            }

            const toolResults = contentBlocks.filter(
              (block): block is ToolResultBlock =>
                block?.type === "tool_result",
            );
            if (toolResults.length === 0) return;
            const toolUseResultPrompt = (() => {
              const toolUseResult =
                sdkEvent.toolUseResult ?? sdkEvent.tool_use_result;
              return typeof toolUseResult?.prompt === "string"
                ? toolUseResult.prompt
                : undefined;
            })();
            setMessages((prev) =>
              attachToolResultsToMessages(prev, toolResults, {
                threadId: id,
                parentToolUseId: sourceToolUseID,
                parentToolPrompt: toolUseResultPrompt,
              }),
            );
          } else if (sdkEvent.type === "result") {
            flushDeferredMessagesRender();
            // Query complete - mark message as not streaming
            // Finish streaming
            splitStreamingMessageOnNextPartRef.current = false;
            const msgId = streamingMessageIdRef.current;
            lastCompletedAssistantMessageIdRef.current = msgId;
            if (msgId) {
              const parsedResultTimestamp =
                typeof sdkEvent.timestamp === "string"
                  ? new Date(sdkEvent.timestamp).getTime()
                  : NaN;
              const completedAt = Number.isFinite(parsedResultTimestamp)
                ? parsedResultTimestamp
                : Date.now();
              setMessages((prev) =>
                prev.map((msg) =>
                  msg.id === msgId
                    ? {
                        ...finalizeStreamingMessage(msg),
                        created_at: completedAt,
                      }
                    : msg,
                ),
              );
            }
            setStreamingMessageId(null);
            setLoading(false);
            setPendingMessages([]);
            dispatchLocalThreadStatus(id, "idle");
            clearPendingDeliveryDraft();
            isAutoCompactingRef.current = false;
            syncCompactionIndicator();
            compactingPriorMessageIdRef.current = null;
            setCompactingPriorMessageId(null);
            if (activeManualCompactionTurnRef.current) {
              completeActiveManualCompaction();
            }
            hasCapturedCompactionSummaryRef.current = false;
          }
        } else if (data.type === "todo_state") {
          // Direct todo state from server - no extraction needed
          if (Array.isArray(data.todos)) {
            setCurrentTodos(data.todos);
          }
        } else if (data.type === "context_usage_state") {
          if (data.usedPercent === null) {
            setContextUsedPercent(null);
          } else if (
            typeof data.usedPercent === "number" &&
            Number.isFinite(data.usedPercent)
          ) {
            setContextUsedPercent(
              Math.max(0, Math.min(100, Math.round(data.usedPercent))),
            );
          }
        } else if (data.type === "ask_user_question") {
          // Claude is asking the user a question
          if (data.questionId && Array.isArray(data.questions)) {
            setPendingQuestion({
              questionId: data.questionId,
              toolUseId: data.toolUseId,
              questions: data.questions,
            });
          }
        } else if (data.type === "question_answered") {
          // Clear the pending question
          setPendingQuestion((prev) => {
            if (prev?.questionId === data.questionId) {
              return null;
            }
            return prev;
          });
        } else if (data.type === "streaming_state") {
          const nextIsStreaming = Boolean(data.isStreaming);
          if (!nextIsStreaming) {
            flushDeferredMessagesRender();
            splitStreamingMessageOnNextPartRef.current = false;
            const msgId = streamingMessageIdRef.current;
            if (msgId) {
              lastCompletedAssistantMessageIdRef.current = msgId;
              setMessages((prev) =>
                prev.map((msg) =>
                  msg.id === msgId ? finalizeStreamingMessage(msg) : msg,
                ),
              );
            }
            setStreamingMessageId(null);
          }
          if (nextIsStreaming || pendingMessagesRef.current.length === 0) {
            setLoading(nextIsStreaming);
          }
        } else if (data.type === "message_accepted") {
          const clientMessageId =
            typeof data.clientMessageId === "string" ? data.clientMessageId : "";
          if (clientMessageId) {
            sentPendingMessageIdsRef.current.add(clientMessageId);
            clearPendingMessageAcceptanceTimeout(clientMessageId);
            clearQueuedSendReadyTimeout();
            markPendingDeliveryDraftAccepted(clientMessageId);
          }
        } else if (data.type === "result") {
          if (id) {
            flushDeferredMessagesRender();
            clearAllPendingMessageAcceptanceTimeouts();
            setPendingMessages([]);
            dispatchLocalThreadStatus(id, "idle");
            clearPendingDeliveryDraft();
          }
        } else if (data.type === "error") {
          flushDeferredMessagesRender();
          console.error("WebSocket error:", data.error);
          const billingSource =
            data.billingSource === "byok" || data.billingSource === "hosted"
              ? data.billingSource
              : null;
          const eventProvider = parseByokProvider(data.provider);
          const errorPayload =
            typeof data.status === "number" ||
            typeof data.status === "string" ||
            typeof data.errorType === "string"
              ? {
                  error: data.error,
                  status: data.status,
                  type: data.errorType,
              }
              : data.error;
          const errorContext: Partial<ChatApiErrorContext> = {
            billingSource,
          };
          if (eventProvider) {
            errorContext.llmProvider = eventProvider;
          }
          showChatError(errorPayload, errorContext);
          // Finish streaming on error
          splitStreamingMessageOnNextPartRef.current = false;
          const msgId = streamingMessageIdRef.current;
          lastCompletedAssistantMessageIdRef.current = msgId;
          if (msgId) {
            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === msgId ? finalizeStreamingMessage(msg) : msg,
              ),
            );
          }
          setStreamingMessageId(null);
          setLoading(false);
          setPendingMessages([]);
          dispatchLocalThreadStatus(id, "idle");
          restorePendingDeliveryDraft();
          isAutoCompactingRef.current = false;
          compactingPriorMessageIdRef.current = null;
          setCompactingPriorMessageId(null);
          clearManualCompactionQueue();
          hasCapturedCompactionSummaryRef.current = false;
        } else if (
          data.type === "preview_state" ||
          data.type === "title_updated" ||
          data.type === "thread_model_updated" ||
          data.type === "connection_setup_prompt" ||
          data.type === "connection_setup_answered" ||
          data.type === "connection_setup_error"
        ) {
          handleRealtimeSideChannelEvent(data);
        }
      };

      ws.onclose = (event: CloseEvent) => {
        // Ignore if this connection was superseded by a new one
        if (connectionIdRef.current !== thisConnectionId) {
          return;
        }

        // Clear ping interval
        if (pingIntervalRef.current) {
          clearInterval(pingIntervalRef.current);
          pingIntervalRef.current = null;
        }

        connectionStartedAtRef.current.delete(thisConnectionId);
        setReady(false);
        wsRef.current = null;
        logRunnerClient("ws_closed", {
          connectionId: thisConnectionId,
          code: event.code || 1000,
          reason: event.reason || "closed",
          reconnectAttempts: reconnectAttempts.current,
        });

        // Auto-reconnect with exponential backoff
        const maxAttempts = 5;
        if (reconnectAttempts.current < maxAttempts) {
          const delay = Math.min(
            1000 * Math.pow(2, reconnectAttempts.current),
            30000,
          );
          reconnectAttempts.current++;
          reconnectTimeoutRef.current = setTimeout(() => {
            // Check again that we haven't been superseded
            if (connectionIdRef.current === thisConnectionId) {
              logRunnerClient("ws_reconnect_attempt", {
                connectionId: thisConnectionId,
                attempt: reconnectAttempts.current,
              });
              connectWebSocket(id, true);
            }
          }, delay);
        } else {
          // Reconnect exhausted — clear stale compaction indicator.
          failPendingMessageDelivery(
            "Connection was lost before your message was sent. I restored it as a draft.",
          );
          isAutoCompactingRef.current = false;
          compactingPriorMessageIdRef.current = null;
          setCompactingPriorMessageId(null);
          lastCompletedAssistantMessageIdRef.current = null;
          clearManualCompactionQueue();
        }
      };

      ws.onerror = () => {
        // Ignore errors from superseded connections
        if (connectionIdRef.current !== thisConnectionId) {
          return;
        }
      };
    },
    [
      clearPendingDeliveryDraft,
      clearPendingMessageAcceptanceTimeout,
      clearAllPendingMessageAcceptanceTimeouts,
      clearQueuedSendReadyTimeout,
      failPendingMessageDelivery,
      isNewThread,
      logRunnerClient,
      markPendingDeliveryDraftAccepted,
      persistSessionState,
      resolvedWorkspaceId,
      restorePendingDeliveryDraft,
      flushDeferredMessagesRender,
      setMessages,
      setMessagesDeferred,
      setPendingMessages,
      setStreamingMessageId,
      startPendingMessageAcceptanceTimeout,
      handleRealtimeSideChannelEvent,
      showChatError,
    ],
  );

  // Keep the ref updated with the latest function
  connectWebSocketRef.current = connectWebSocket;

  // Track which threadId we're connected to
  const connectedThreadIdRef = useRef<string | null>(null);
  const connectedWorkspaceIdRef = useRef<string | null>(null);
  const bumpConnectionId = useCallback(() => {
    connectionIdRef.current += 1;
  }, []);

  // Cleanup on unmount to avoid orphaned WebSockets or reconnect timers
  useEffect(() => {
    return () => {
      bumpConnectionId();
      connectedThreadIdRef.current = null;
      connectedWorkspaceIdRef.current = null;

      // Revoke any remaining attachment blob URLs that were not removed/sent.
      for (const previewUrl of attachmentPreviewUrlsRef.current) {
        URL.revokeObjectURL(previewUrl);
      }
      attachmentPreviewUrlsRef.current.clear();

      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }

      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }

      if (pingIntervalRef.current) {
        clearInterval(pingIntervalRef.current);
        pingIntervalRef.current = null;
      }

      clearAllPendingMessageAcceptanceTimeouts();
      clearAllIframeRefreshTimeouts();
    };
  }, [
    bumpConnectionId,
    clearAllIframeRefreshTimeouts,
    clearAllPendingMessageAcceptanceTimeouts,
  ]);

  // Check if we should show the chat UI
  const shouldShowChat = Boolean(threadId);
  const lastMessage = visibleMessages[visibleMessages.length - 1];
  const visibleMessageCount = visibleMessages.length;
  const lastVisibleMessageId = lastMessage?.id ?? null;
  const isLastMessageAssistantLike = isAssistantLikeMessage(lastMessage);
  const showAssistantTail = loading || isStreaming;
  const isAwaitingAssistant =
    showAssistantTail && Boolean(lastMessage) && !isLastMessageAssistantLike;
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

  // Connect when threadId changes
  useEffect(() => {
    if (readOnly) {
      connectionIdRef.current++;
      connectedThreadIdRef.current = null;
      connectedWorkspaceIdRef.current = null;
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      clearQueuedSendReadyTimeout();
      if (pingIntervalRef.current) {
        clearInterval(pingIntervalRef.current);
        pingIntervalRef.current = null;
      }
      setReady(false);
      return;
    }

    if (!shouldShowChat || !resolvedWorkspaceId) {
      // No threadId or workspace - cleanup any existing connection
      if (connectedThreadIdRef.current) {
        connectionIdRef.current++;
        connectedThreadIdRef.current = null;
        connectedWorkspaceIdRef.current = null;
        if (wsRef.current) {
          wsRef.current.close();
          wsRef.current = null;
        }
        if (reconnectTimeoutRef.current) {
          clearTimeout(reconnectTimeoutRef.current);
          reconnectTimeoutRef.current = null;
        }
        // Messages are stored by threadId - no need to clear here.
        // useMessages(threadId) automatically returns [] when threadId is undefined.
        setReady(false);
      }
      return;
    }

    const nextWorkspaceId = resolvedWorkspaceId;
    const threadChanged =
      connectedThreadIdRef.current && connectedThreadIdRef.current !== threadId;
    const workspaceChanged =
      connectedWorkspaceIdRef.current &&
      connectedWorkspaceIdRef.current !== nextWorkspaceId;

    // Already connected to this thread+workspace? Nothing to do.
    if (
      connectedThreadIdRef.current === threadId &&
      connectedWorkspaceIdRef.current === nextWorkspaceId
    ) {
      return;
    }

    // Switching threads or workspaces - close old connection first
    if (connectedThreadIdRef.current || connectedWorkspaceIdRef.current) {
      if (threadChanged || workspaceChanged) {
        connectionIdRef.current++;
        if (wsRef.current) {
          wsRef.current.close();
          wsRef.current = null;
        }
        if (reconnectTimeoutRef.current) {
          clearTimeout(reconnectTimeoutRef.current);
          reconnectTimeoutRef.current = null;
        }
      }
    }

    // Connect to the new thread/workspace
    connectedThreadIdRef.current = threadId ?? null;
    connectedWorkspaceIdRef.current = nextWorkspaceId;
    if (threadId) {
      connectWebSocketRef.current?.(threadId);
    }

    // Cleanup on unmount or dep change: close the WebSocket to prevent orphaned
    // connections. Browsers only auto-close WebSockets on full page navigations,
    // NOT on SPA client-side route changes. Without this, navigating from
    // /chat/threadA → /new leaves the old WS alive (code 1006 after ~15s),
    // and the lingering connection slows down new WS establishment.
    return () => {
      connectionIdRef.current++;
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      if (pingIntervalRef.current) {
        clearInterval(pingIntervalRef.current);
        pingIntervalRef.current = null;
      }
      connectedThreadIdRef.current = null;
      connectedWorkspaceIdRef.current = null;
    };
  }, [
    threadId,
    shouldShowChat,
    resolvedWorkspaceId,
    readOnly,
    clearQueuedSendReadyTimeout,
  ]);

  // On tab return, poke live-looking sockets and reconnect sockets the browser
  // already knows are gone.
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (readOnly) return;
      if (
        document.visibilityState === "visible" &&
        shouldShowChat &&
        resolvedWorkspaceId &&
        threadId
      ) {
        const socketState = wsRef.current?.readyState;
        if (socketState === WebSocket.CONNECTING) {
          return;
        }

        const reconnect = () => {
          if (reconnectTimeoutRef.current) {
            clearTimeout(reconnectTimeoutRef.current);
            reconnectTimeoutRef.current = null;
          }
          reconnectAttempts.current = 0;
          logRunnerClient("tab_return_reconnect", {
            socketState,
          });
          connectWebSocketRef.current?.(threadId, true);
        };

        if (socketState === WebSocket.OPEN) {
          try {
            wsRef.current?.send(CHAT_PING_MESSAGE);
          } catch {
            reconnect();
          }
          return;
        }

        reconnect();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [
    threadId,
    shouldShowChat,
    resolvedWorkspaceId,
    readOnly,
    logRunnerClient,
  ]);

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
              `Upload completed without a readable /mnt/user-uploads/ path`,
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
      if (
        lastRunnerModelSelectionRef.current !== nextSelectionKey &&
        wsRef.current?.readyState === WebSocket.OPEN &&
        ready
      ) {
        lastRunnerModelSelectionRef.current = nextSelectionKey;
        wsRef.current.send(
          JSON.stringify({
            type: "set_model",
            model: nextModel,
            threadId,
            sessionId: sessionIdRef.current,
          }),
        );
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
        : ` The project location is unknown - search for it in the home folder. The project may have a different name than the app, and look for either wrangler.toml or wrangler.jsonc files.`;
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
    welcomeInputRef.current = "";
    attachmentsRef.current = [];
    setWelcomeInput("");
    clearDraft();
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
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      return;
    }
    wsRef.current.send(JSON.stringify({ type: "stop" }));
  }

  const handleQuestionResponse = useCallback(
    (answers: Record<string, string>) => {
      const socket = wsRef.current;
      if (!pendingQuestion || !socket || socket.readyState !== WebSocket.OPEN) {
        return;
      }

      socket.send(
        JSON.stringify({
          type: "question_response",
          questionId: pendingQuestion.questionId,
          answers,
        }),
      );

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

      const socket = wsRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
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

    // If user sends mid-stream, keep current part streaming and split at next message_start.
    if (wasSentDuringStreaming) {
      const previousStreamingMessageId = streamingMessageIdRef.current;
      const nextStreamingMessageId = `stream_steer_${Date.now()}`;
      splitStreamingMessageOnNextPartRef.current = false;
      runtimeStreamingMessageIdsRef.current[threadId] = nextStreamingMessageId;
      setStreamingMessageId(nextStreamingMessageId);
      setMessages((prev) =>
        splitStreamingMessageForSteer(
          prev,
          threadId,
          runtimeStreamingMessageIdsRef.current,
          userMsg,
          nextStreamingMessageId,
          previousStreamingMessageId,
        ),
      );
    } else {
      lastCompletedAssistantMessageIdRef.current = null;
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
    dispatchLocalThreadStatus(threadId, "running", {
      latestUserMessage: previewUserMessage,
      latestUserMessageAt: userMessageAt,
      runningActivityText: previewUserMessage,
      runningActivityAt: userMessageAt,
    });
    if (wsRef.current?.readyState === WebSocket.OPEN && ready) {
      setLoading(true);
      logRunnerClient("message_sent_immediate", {
        contentLength: finalContent.length,
      });
      sentPendingMessageIdsRef.current.add(clientMessageId);
      startPendingMessageAcceptanceTimeout(clientMessageId);
      wsRef.current.send(
        JSON.stringify({
          type: "message",
          content: finalContent,
          clientMessageId,
          sessionId: sessionIdRef.current,
          threadId,
        }),
      );
      setPendingMessages((prev) => prev);
    } else {
      // Queue the full message object for later delivery (with file refs in content)
      setLoading(true);
      logRunnerClient("message_queued_waiting_ready", {
        messageId: userMsg.id,
        contentLength: finalContent.length,
      });
      if (!ready) {
        clearQueuedSendReadyTimeout();
        queuedSendReadyTimeoutRef.current = setTimeout(() => {
          const unsentMessages = pendingMessagesRef.current.filter((message) => {
            if (message.role !== "user") return false;
            return !sentPendingMessageIdsRef.current.has(
              message.clientMessageId ?? message.id,
            );
          });
          if (unsentMessages.length > 0 && threadId) {
            logRunnerClient("queued_ready_timeout_reconnect", {
              queuedMessages: unsentMessages.length,
            });
            connectWebSocketRef.current?.(threadId, true);
          }
        }, 5000);
      }

      const socketState = wsRef.current?.readyState;
      if (
        socketState == null ||
        socketState === WebSocket.CLOSING ||
        socketState === WebSocket.CLOSED
      ) {
        connectWebSocketRef.current?.(threadId, true);
      }
      // If connected but not ready, the message will be sent when ready event arrives
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
    fileExternalOpenUrl,
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
    readOnly,
  });

  const handlePreviewRefresh = useCallback(() => {
    if (!previewTarget) return;
    if (previewTarget.kind === "app") {
      refreshActiveIframe();
      return;
    }
    refreshActiveFilePreview();
  }, [previewTarget, refreshActiveIframe, refreshActiveFilePreview]);

  const handlePreviewOpenElsewhere = useCallback(() => {
    if (!previewTarget) return;
    if (previewTarget.kind === "app") {
      if (!appPreviewVanityUrl) return;
      window.open(appPreviewVanityUrl, "_blank", "noopener,noreferrer");
      return;
    }
    if (previewTarget.source !== "workspace") return;
    if (!fileExternalOpenUrl) return;
    window.open(fileExternalOpenUrl, "_blank", "noopener,noreferrer");
  }, [previewTarget, appPreviewVanityUrl, fileExternalOpenUrl]);

  const showMobilePreview = previewTabs.length > 0 && mobileView === "preview";
  const currentMembership = orgs.find(
    (entry) => entry.org_id === currentOrg?.id,
  );
  const isAdmin =
    currentMembership?.role === "owner" || currentMembership?.role === "admin";
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
      {!readOnly && billingCreditStatus ? (
        <BillingCreditNotice
          status={billingCreditStatus}
          onOpenUsage={() => navigate("/settings/organization/usage")}
          onTopUp={() => navigate("/settings/organization/usage?action=topup")}
          canTopUp={Boolean(isAdmin)}
        />
      ) : null}
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
            assistantTurnActive={assistantTurnActive}
            activeAssistantMessageId={activeAssistantMessageId}
            activeTurnActionMessageId={activeAssistantMessageId}
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
                <PromptInput
                  className="shrink-0"
                  value={input}
                  onChange={setInput}
                  onSubmit={sendMessage}
                  onStop={stopGeneration}
                  placeholder="Type a message..."
                  isLoading={isLoadingMessages}
                  isAssistantRunning={loading || isStreaming}
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
                  mentionableConnections={mentionConnections}
                  onMentionAddNewClick={() => navigate("/connections")}
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
      <ChatPreviewProvider value={{ openPreviewTarget, clearPreviewTarget }}>
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
                <WelcomeScreen
                  userId={resolvedWelcomeData.userId}
                  userName={resolvedWelcomeData.userName}
                  allApps={resolvedWelcomeData.allApps}
                  connections={resolvedWelcomeData.connections}
                  recentThreads={resolvedWelcomeData.recentThreads}
                  renderedAt={resolvedWelcomeData.renderedAt}
                  inputValue={welcomeInput}
                  onPromptChange={setWelcomeInput}
                  onSubmit={startNewChat}
                  onStartChatForApp={handleStartChatForApp}
                  attachments={attachments}
                  onFilesSelected={handleFilesSelected}
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

      {/* Post-onboarding boot sequence modal */}
      {bootModalOpen && (
        <OnboardingLoadingModal
          open={bootModalOpen}
          onDismiss={() => setBootModalOpen(false)}
        />
      )}
    </TooltipProvider>
  );
}
