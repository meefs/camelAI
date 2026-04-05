'use client';

import { useState, useEffect, useRef, useCallback, useMemo, useLayoutEffect, memo } from 'react';
import type { Dispatch, ReactNode, RefObject, SetStateAction } from 'react';
import { useNavigate, useFetcher, useLocation, useRevalidator } from 'react-router';
import { ArrowDown, RefreshCw, X, ChevronDown, Globe, Lock } from 'lucide-react';
import { toast } from 'sonner';
import type {
  ChatHarness,
  Message,
  ContentBlock,
  LlmModel,
  Thread,
  ToolResultBlock,
  ToolUseBlock,
  WorkerScriptWithCreator,
  Integration,
  PreviewTarget,
  PreviewTab,
  OrganizationExperimentalSettings,
} from '@/types';
import { useAuthData } from '@/hooks/use-auth-data';
import { useIsMobile } from '@/hooks/use-mobile';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { PageHeader } from '@/components/page-header';
import { PromptInput } from '@/components/prompt-input';
import { FloatingTodoList, type TodoItem, type TodoStatus } from '@/components/floating-todo';
import { AskUserQuestion, type AskUserQuestionData } from '@/components/ask-user-question';
import {
  ConnectionSetupPrompt,
  type ConnectionSetupPromptData,
  type ConnectionSetupResponse,
} from '@/components/connection-setup-prompt';
import { BugReportDialog, type BugReportStatus } from '@/components/bug-report-dialog';
import { FreeTierModal } from '@/components/free-tier-modal';
import { OnboardingLoadingModal } from '@/components/onboarding-loading-modal';
import type { Attachment } from '@/components/attachment-list';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { MessageBubble, isInterruptMessage, parseSlashCommand, parseLocalCommandStdout } from '@/components/message-bubble';
import { LoadingDots } from '@/components/loading-dots';
import { Skeleton } from '@/components/ui/skeleton';
import { CompactingIndicator } from '@/components/compacting-indicator';
import { UsageLimitError } from '@/components/usage-limit-error';
import { WelcomeScreen } from '@/components/welcome-screen';
import { FilePreviewContent, isImageFile, type NotebookPreviewLoadState } from '@/components/chat-file-preview';
import { ChatPreviewProvider } from '@/components/chat-preview/preview-context';
import { PreviewTabRow } from '@/components/preview-panel/preview-tabs';
import { PreviewToolbar } from '@/components/preview-panel/preview-toolbar';
import { getPreviewTabId } from '@/components/preview-panel/preview-utils';
import { cn } from '@/lib/utils';
import { buildSetAppPublicPayload } from '@/lib/app-visibility';
import {
  type SDKEvent,
  applyStreamingEventToMessage,
  attachToolResultsToMessages,
  extractToolEventMetaInfo,
  finalizeStreamingMessage,
  mergeTaskNotifications,
  normalizeToolResultMessages,
  mergeTeammateMessages,
} from '@/lib/streaming';
import { applyRuntimeEventToMessages } from '../../desktop/shared/message-state';
import { getAppUrl, getVanityDomain, getIframeDomain, buildAppLabel } from '@/lib/app-url';
import { uploadWorkspaceFile } from '@/lib/workspace-upload.client';
import { isManualCompactCommand } from '@/lib/slash-commands';
import { getFirstThreadPreviewUserMessage } from '@/lib/thread-preview';
import { buildAppThreadFallbackTitle } from '@/lib/thread-title';
import {
  getDefaultLlmModel,
  getVisibleLlmModelOptions,
  isLlmModel,
  THREAD_MODEL_LOCK_MESSAGE,
} from '@/lib/llm-provider-config';
import {
  loadDraft,
  removeDraft,
  useDraftPersistence,
  writeDraft,
  type DraftData,
} from '@/hooks/use-draft-persistence';

interface ChatProps {
  threadId?: string;
  workspaceId: string;
  initialMessages?: Message[];
  threadTitle?: string | null;
  threadModel?: LlmModel | null;
  threadProvider?: ChatHarness | null;
  experimentalSettings?: OrganizationExperimentalSettings | null;
  initialPreviewTarget?: PreviewTarget | null;
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
  initialWelcomeInput?: string | null;
  welcomeData?: {
    userId: string | null;
    userName: string | null;
    allApps: WorkerScriptWithCreator[] | Promise<WorkerScriptWithCreator[]>;
    connections: Integration[];
    recentThreads: Thread[] | Promise<Thread[]>;
    renderedAt: number;
  };
}

interface PendingNewThreadMessagePayload {
  message?: string;
  threadId?: string;
  threadTitle?: string;
  threadModel?: LlmModel;
  threadProvider?: ChatHarness;
  workspaceId?: string;
  orgSlug?: string;
}

function shouldShowBootModalFromStorage(isNewThread: boolean): boolean {
  if (typeof window === 'undefined' || !isNewThread) return false;

  try {
    return Boolean(sessionStorage.getItem('showBootModal'));
  } catch {
    return false;
  }
}

function readPendingNewThreadMessage(): PendingNewThreadMessagePayload | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const stored = sessionStorage.getItem('pendingMessage:newThread');
    if (!stored) {
      return null;
    }

    const parsed = JSON.parse(stored) as PendingNewThreadMessagePayload;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function shouldHydrateThreadDraft(threadId?: string): boolean {
  if (!threadId) {
    return true;
  }

  return readPendingNewThreadMessage()?.threadId !== threadId;
}

function isComposerVisiblyEmpty(text: string, attachments: Attachment[]): boolean {
  return text.trim().length === 0 && attachments.length === 0;
}

const FREE_TIER_MODAL_SEEN_PREFIX = 'freeTierModalSeen:';
const FREE_TIER_MSG_COUNT_PREFIX = 'freeTierMsgCount:';

function shouldShowFreeTierModal(userId: string | undefined): boolean {
  if (!userId || typeof window === 'undefined') {
    return false;
  }

  try {
    if (window.localStorage.getItem(`${FREE_TIER_MODAL_SEEN_PREFIX}${userId}`) === 'true') {
      return false;
    }
    const count = Number(window.localStorage.getItem(`${FREE_TIER_MSG_COUNT_PREFIX}${userId}`) || '0');
    return count >= 3;
  } catch {
    return false;
  }
}

function incrementFreeTierCount(userId: string | undefined): number {
  try {
    if (!userId || typeof window === 'undefined') {
      return 0;
    }
    const key = `${FREE_TIER_MSG_COUNT_PREFIX}${userId}`;
    const next = Number(window.localStorage.getItem(key) || '0') + 1;
    window.localStorage.setItem(key, String(next));
    return next;
  } catch {
    return 0;
  }
}

function markFreeTierModalSeen(userId: string | undefined): void {
  try {
    if (!userId || typeof window === 'undefined') {
      return;
    }
    window.localStorage.setItem(`${FREE_TIER_MODAL_SEEN_PREFIX}${userId}`, 'true');
  } catch {
    // Ignore storage failures; the modal remains dismissible in-memory.
  }
}

function safeJsonStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function isContentBlock(value: unknown): value is ContentBlock {
  if (!value || typeof value !== 'object' || !('type' in value)) return false;
  const type = (value as { type?: string }).type;
  return (
    type === 'text' ||
    type === 'tool_use' ||
    type === 'tool_result' ||
    type === 'thinking' ||
    type === 'redacted_thinking' ||
    type === 'teammate_message' ||
    type === 'task_notification'
  );
}

function coerceContentBlocks(value: unknown): ContentBlock[] | null {
  if (Array.isArray(value) && value.every(isContentBlock)) return value;
  if (isContentBlock(value)) return [value];
  return null;
}

// Parse message content - handles both plain string and JSON-encoded ContentBlock[]
function parseMessageContent(content: string | ContentBlock[]): string | ContentBlock[] {
  const directBlocks = coerceContentBlocks(content);
  if (directBlocks) return directBlocks;

  if (typeof content !== 'string') return safeJsonStringify(content);

  // Try to parse as JSON array of content blocks
  const trimmed = content.trim();
  if (
    (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
    (trimmed.startsWith('{') && trimmed.endsWith('}'))
  ) {
    try {
      const parsed = JSON.parse(trimmed);
      const parsedBlocks = coerceContentBlocks(parsed);
      if (parsedBlocks) return parsedBlocks;
    } catch {
      // Not valid JSON - fall through to return as string
    }
  }

  // Plain string content
  return content;
}

interface ParsedUsageLimitError {
  spentUSD: string;
  limitUSD: string;
  windowLabel: string;
}

const USAGE_LIMIT_ERROR_REGEX = /Usage limit exceeded: \$([0-9][0-9,]*(?:\.[0-9]+)?) spent in the last (\S+) \(limit \$([0-9][0-9,]*(?:\.[0-9]+)?)\)/;

function parseUsageLimitError(error: string): ParsedUsageLimitError | null {
  const match = error.match(USAGE_LIMIT_ERROR_REGEX);
  if (!match) {
    return null;
  }

  const [, spentUSD, windowLabel, limitUSD] = match;
  return { spentUSD, limitUSD, windowLabel };
}

function mergeServerAndLocalMessages(
  serverMessages: Message[],
  localMessages: Message[]
): Message[] {
  const serverIds = new Set(serverMessages.map((msg) => msg.id));
  const unsyncedLocalMessages = localMessages.filter((msg) => !serverIds.has(msg.id));
  if (unsyncedLocalMessages.length === 0) {
    return serverMessages;
  }
  return [...serverMessages, ...unsyncedLocalMessages]
    .sort((a, b) => a.created_at - b.created_at);
}

/**
 * True when the message was directly authored by the user — not a
 * system-generated message that happens to carry `role: 'user'`
 * (e.g. compact summaries, meta/skill-sheet messages, interrupts,
 * slash commands, local-command-stdout).
 */
function isDirectUserMessage(msg: Message): boolean {
  if (msg.role !== 'user' || msg.isCompactSummary) return false;
  if (isInterruptMessage(msg.content)) return false;
  if (parseSlashCommand(msg.content)) return false;
  if (parseLocalCommandStdout(msg.content)) return false;
  return true;
}

/**
 * User-authored messages that should anchor the page-style spacer animation.
 * Slash commands count; compact summaries and synthetic stdout/interrupt rows do not.
 */
function isUserTurnAnchorMessage(msg: Message): boolean {
  if (msg.role !== 'user' || msg.isCompactSummary) return false;
  if (isInterruptMessage(msg.content)) return false;
  if (parseLocalCommandStdout(msg.content)) return false;
  return true;
}

function isAssistantLikeMessage(msg: Message | null | undefined): boolean {
  return Boolean(msg && (msg.role === 'assistant' || msg.isCompactSummary));
}

const DEFAULT_NOTEBOOK_PREVIEW_STATE: NotebookPreviewLoadState = {
  notebook: null,
  status: 'idle',
};

function extractMetaInfo(event: SDKEvent): { isMeta: boolean; sourceToolUseID?: string } {
  const record = event as unknown as Record<string, unknown>;
  const messageRecord = (event.message ?? {}) as unknown as Record<string, unknown>;
  const isMeta = Boolean(
    record.isMeta ??
    record.is_meta ??
    messageRecord.isMeta ??
    messageRecord.is_meta
  );
  const sourceToolUseID = (
    record.sourceToolUseID ??
    record.sourceToolUseId ??
    record.source_tool_use_id ??
    record.parent_tool_use_id ??
    messageRecord.sourceToolUseID ??
    messageRecord.sourceToolUseId ??
    messageRecord.source_tool_use_id ??
    messageRecord.parent_tool_use_id
  );
  return { isMeta, sourceToolUseID: typeof sourceToolUseID === 'string' ? sourceToolUseID : undefined };
}

function getLastToolUseId(message?: Message): string | undefined {
  if (!message || !Array.isArray(message.content)) return undefined;
  for (let i = message.content.length - 1; i >= 0; i -= 1) {
    const block = message.content[i];
    if (block && block.type === 'tool_use' && block.id) return block.id;
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

function coercePreviewTarget(value: unknown): PreviewTarget | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (record.kind === 'app') {
    if (typeof record.scriptName !== 'string') return null;
    return {
      kind: 'app',
      scriptName: record.scriptName,
      isPublic: Boolean(record.isPublic),
    };
  }

  if (record.kind === 'file') {
    if (
      typeof record.workspaceId !== 'string' ||
      typeof record.path !== 'string' ||
      (record.source !== 'workspace' && record.source !== 'upload' && record.source !== 'output')
    ) {
      return null;
    }
    return {
      kind: 'file',
      source: record.source,
      workspaceId: record.workspaceId,
      path: record.path,
      filename: typeof record.filename === 'string' ? record.filename : undefined,
      contentType: typeof record.contentType === 'string' ? record.contentType : undefined,
    };
  }

  return null;
}

interface PreviewSessionState {
  tabs: PreviewTab[];
  activeTabId: string | null;
  target: PreviewTarget | null;
}

function normalizePreviewSessionState(
  tabsInput: unknown,
  activeTabIdInput: unknown,
  fallbackTarget: unknown
): PreviewSessionState {
  const tabs: PreviewTab[] = [];
  const tabIndexById = new Map<string, number>();

  const upsert = (rawTarget: unknown) => {
    const target = coercePreviewTarget(rawTarget);
    if (!target) return;

    const id = getPreviewTabId(target);
    const tab: PreviewTab = { id, target };
    const existingIndex = tabIndexById.get(id);
    if (existingIndex === undefined) {
      tabIndexById.set(id, tabs.length);
      tabs.push(tab);
      return;
    }
    tabs[existingIndex] = tab;
  };

  if (Array.isArray(tabsInput)) {
    for (const tabTarget of tabsInput) {
      upsert(tabTarget);
    }
  }

  if (tabs.length === 0) {
    upsert(fallbackTarget);
  }

  const activeTabId = (
    typeof activeTabIdInput === 'string' && tabIndexById.has(activeTabIdInput)
  )
    ? activeTabIdInput
    : (tabs[0]?.id ?? null);
  const target = activeTabId
    ? (tabs.find((tab) => tab.id === activeTabId)?.target ?? null)
    : null;

  return { tabs, activeTabId, target };
}

function MobileViewSwitcher({
  value,
  onChange,
}: {
  value: 'chat' | 'preview';
  onChange: (value: 'chat' | 'preview') => void;
}) {
  return (
    <div className="w-full bg-background px-4 py-3">
      <Tabs
        value={value}
        onValueChange={(nextValue) => onChange(nextValue as 'chat' | 'preview')}
        className="w-full"
      >
        <TabsList className="grid w-full grid-cols-2 overflow-hidden rounded-lg bg-muted/80 p-1 shadow-inner !h-11">
          <TabsTrigger value="chat" className="rounded-md text-sm font-semibold data-[state=active]:shadow-sm !h-9">
            Chat
          </TabsTrigger>
          <TabsTrigger value="preview" className="rounded-md text-sm font-semibold data-[state=active]:shadow-sm !h-9">
            Preview
          </TabsTrigger>
        </TabsList>
      </Tabs>
    </div>
  );
}

interface ShareStatusButtonProps {
  threadId?: string;
  scriptName: string;
  isPublic: boolean;
  isAdmin: boolean;
  disabled?: boolean;
  onStatusChange?: (isPublic: boolean) => void;
}

function ShareStatusButton({
  threadId,
  scriptName,
  isPublic,
  isAdmin,
  disabled,
  onStatusChange,
}: ShareStatusButtonProps) {
  const fetcher = useFetcher<{ success?: boolean; error?: string }>();
  const pendingValueRef = useRef<boolean | null>(null);
  const isPending = fetcher.state !== 'idle';
  const optimisticIsPublic = isPending && fetcher.formData
    ? fetcher.formData.get('isPublic') === 'true'
    : (fetcher.data?.success && pendingValueRef.current !== null
        ? pendingValueRef.current
        : isPublic);

  useEffect(() => {
    if (fetcher.state !== 'idle' || !fetcher.data) return;

    if (fetcher.data.success && pendingValueRef.current !== null) {
      onStatusChange?.(pendingValueRef.current);
    } else if (fetcher.data.error) {
      toast.error(fetcher.data.error);
    }

    pendingValueRef.current = null;
  }, [fetcher.state, fetcher.data, onStatusChange]);

  useEffect(() => {
    pendingValueRef.current = null;
  }, [scriptName, threadId]);

  const handleChange = (value: string) => {
    if (!isAdmin || disabled || isPending) return;
    if (!scriptName) return;

    const nextIsPublic = value === 'true';
    if (nextIsPublic === isPublic) return;

    pendingValueRef.current = nextIsPublic;
    fetcher.submit(
      buildSetAppPublicPayload({
        scriptName,
        isPublic: nextIsPublic,
        threadId,
      }),
      { method: 'POST', action: '/apps' }
    );
  };

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled || isPending}
              className={cn(
                "h-6 gap-1.5 rounded-md border px-2 text-xs font-medium",
                optimisticIsPublic
                  ? "border-primary/20 bg-primary/5 text-primary hover:bg-primary/10 dark:border-primary/30 dark:bg-primary/10 dark:text-primary dark:hover:bg-primary/20"
                  : "border-border text-muted-foreground hover:bg-muted/50 hover:text-foreground"
              )}
            >
              {optimisticIsPublic ? (
                <Globe className="h-3.5 w-3.5" />
              ) : (
                <Lock className="h-3.5 w-3.5" />
              )}
              {optimisticIsPublic ? 'Public' : 'Private'}
              <ChevronDown className="h-3 w-3 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Update visibility</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>Visibility</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={optimisticIsPublic ? 'true' : 'false'}
          onValueChange={handleChange}
        >
          <DropdownMenuRadioItem
            value="false"
            disabled={!isAdmin || disabled || isPending}
            className="items-start"
          >
            <div className="flex flex-col gap-0.5">
              <span className="font-medium">Private</span>
              <span className="text-muted-foreground text-[10px]">
                Only workspace members can view
              </span>
            </div>
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem
            value="true"
            disabled={!isAdmin || disabled || isPending}
            className="items-start"
          >
            <div className="flex flex-col gap-0.5">
              <span className="font-medium">Public</span>
              <span className="text-muted-foreground text-[10px]">
                Anyone with the link can view
              </span>
            </div>
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface ChatMessagesViewProps {
  visibleMessages: Message[];
  lastUserMessageId: string | null;
  lastMessageId: string | null;
  isAwaitingAssistant: boolean;
  isLastMessageAssistantLike: boolean;
  copyMessage: (messageId: string, content: string) => void;
  copiedMessageId: string | null;
  assistantTurnActive: boolean;
  activeAssistantMessageId: string | null;
  skillSheetsByToolId: Map<string, string>;
  hostname?: string;
  orgSlug?: string;
  error: string | null;
  setError: Dispatch<SetStateAction<string | null>>;
  isCompacting: boolean;
  compactingPriorMessageId: string | null;
  isLoadingMessages: boolean;
  showGlobalAssistantIndicator: boolean;
  shouldRenderSpacer: boolean;
  lastUserMessageRef: RefObject<HTMLDivElement | null>;
  assistantMeasureRef: RefObject<HTMLDivElement | null>;
  assistantPendingMeasureRef: RefObject<HTMLDivElement | null>;
  assistantSpacerRef: RefObject<HTMLDivElement | null>;
  messagesEndRef: RefObject<HTMLDivElement | null>;
}

const ChatMessagesView = memo(function ChatMessagesView({
  visibleMessages,
  lastUserMessageId,
  lastMessageId,
  isAwaitingAssistant,
  isLastMessageAssistantLike,
  copyMessage,
  copiedMessageId,
  assistantTurnActive,
  activeAssistantMessageId,
  skillSheetsByToolId,
  hostname,
  orgSlug,
  error,
  setError,
  isCompacting,
  compactingPriorMessageId,
  isLoadingMessages,
  showGlobalAssistantIndicator,
  shouldRenderSpacer,
  lastUserMessageRef,
  assistantMeasureRef,
  assistantPendingMeasureRef,
  assistantSpacerRef,
  messagesEndRef,
}: ChatMessagesViewProps) {
  const usageLimitError = error ? parseUsageLimitError(error) : null;

  return (
    <>
      {/* Message loading skeletons (deferred data still resolving) */}
      {isLoadingMessages && visibleMessages.length === 0 && (
        <>
          <div className="flex flex-col items-end gap-1 mt-6">
            <Skeleton className="h-16 w-3/4 rounded-3xl" />
          </div>
          <div className="flex flex-col gap-2 mt-4">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-4 w-2/3" />
          </div>
          <div className="flex flex-col items-end gap-1 mt-6">
            <Skeleton className="h-12 w-1/2 rounded-3xl" />
          </div>
          <div className="flex flex-col gap-2 mt-4">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-11/12" />
            <Skeleton className="h-4 w-3/4" />
          </div>
        </>
      )}

      {visibleMessages.map(msg => {
        const isLastUserMessage = msg.id === lastUserMessageId;
        const isLastAssistantMessage = !isAwaitingAssistant && isLastMessageAssistantLike && msg.id === lastMessageId;
        const messageRef = isLastUserMessage
          ? lastUserMessageRef
          : (isLastAssistantMessage ? assistantMeasureRef : undefined);
        return (
          <div
            key={msg.id}
            ref={messageRef}
            data-message-id={msg.id}
            className={cn("group", isDirectUserMessage(msg) ? "mt-6 mb-1" : "")}
          >
            <MessageBubble
              message={msg}
              onCopy={copyMessage}
              copiedId={copiedMessageId}
              showStreamingIndicator={assistantTurnActive && msg.id === activeAssistantMessageId}
              suppressFinalizedState={isCompacting && msg.id === compactingPriorMessageId}
              skillSheets={skillSheetsByToolId}
              hostname={hostname}
              orgSlug={orgSlug}
            />
          </div>
        );
      })}

      {/* Error display */}
      {error && (
        usageLimitError ? (
          <UsageLimitError
            spentUSD={usageLimitError.spentUSD}
            limitUSD={usageLimitError.limitUSD}
            windowLabel={usageLimitError.windowLabel}
            onDismiss={() => setError(null)}
          />
        ) : (
          <div className="bg-destructive/10 border border-destructive/20 px-4 py-3 rounded-xl">
            <div className="flex items-start gap-3">
              <svg className="w-5 h-5 text-destructive shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <div className="flex-1">
                <p className="text-sm font-medium text-destructive mb-1">Something went wrong</p>
                <p className="text-sm text-muted-foreground">{error}</p>
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                className="shrink-0 text-muted-foreground hover:text-foreground"
                onClick={() => setError(null)}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )
      )}

      {/* Compaction in-progress indicator */}
      {isCompacting && (
        <div ref={assistantPendingMeasureRef}>
          <CompactingIndicator />
        </div>
      )}

      {/* Loading indicator when assistant is running but no message shows its own streaming dots */}
      {showGlobalAssistantIndicator && !isCompacting && (
        <div ref={assistantPendingMeasureRef}>
          <LoadingDots />
        </div>
      )}
      {shouldRenderSpacer ? (
        <div className="flex flex-col">
          <div ref={assistantSpacerRef} aria-hidden="true" className="pointer-events-none w-full shrink-0" />
          <div ref={messagesEndRef} />
        </div>
      ) : (
        <div ref={messagesEndRef} />
      )}
    </>
  );
});

type TabRenderState = {
  tabId: string;
  target: PreviewTarget;
  // App tab
  appPreviewUrl: string;
  vanityHost: string;
  iframeKey: number;
  isLoading: boolean;
  // File tab
  filePreviewUrl: string;
  filePreviewOpenUrl: string;
  previewFileName: string;
  notebookViewMode: 'report' | 'notebook';
  markdownViewMode: 'rendered' | 'source';
  isNotebookPreview: boolean;
  isMarkdownPreview: boolean;
};

interface PreviewPanelShellProps {
  previewTabs: PreviewTab[];
  activeTabId: string | null;
  previewTarget: PreviewTarget | null;
  onTabSelect: (tabId: string) => void;
  onTabClose: (tabId: string) => void;
  onRefresh: () => void;
  onOpenExternal: () => void;
  onBugReportOpen: () => void;
  appShareButton?: ReactNode;
  notebookViewMode: 'report' | 'notebook';
  onNotebookViewModeChange: (mode: 'report' | 'notebook') => void;
  markdownViewMode: 'rendered' | 'source';
  onMarkdownViewModeChange: (mode: 'rendered' | 'source') => void;
  filePreviewOpenUrl: string;
  activeNotebookState: NotebookPreviewLoadState;
  isNotebookPdfExporting: boolean;
  onNotebookStateChange: (tabId: string, state: NotebookPreviewLoadState) => void;
  onNotebookReportPdfDownload: () => void | Promise<void>;
  iframeRef: RefObject<HTMLIFrameElement | null>;
  tabRenderStates: TabRenderState[];
  vanityUrl: string;
  vanityHost: string;
}

const PreviewPanelShell = memo(function PreviewPanelShell({
  previewTabs,
  activeTabId,
  previewTarget,
  onTabSelect,
  onTabClose,
  onRefresh,
  onOpenExternal,
  onBugReportOpen,
  appShareButton,
  notebookViewMode,
  onNotebookViewModeChange,
  markdownViewMode,
  onMarkdownViewModeChange,
  filePreviewOpenUrl,
  activeNotebookState,
  isNotebookPdfExporting,
  onNotebookStateChange,
  onNotebookReportPdfDownload,
  iframeRef,
  tabRenderStates,
  vanityUrl,
  vanityHost,
}: PreviewPanelShellProps) {
  if (previewTabs.length === 0 || !previewTarget || !activeTabId) {
    return null;
  }

  const activeTabState = tabRenderStates.find((s) => s.tabId === activeTabId);
  const isNotebookPreview = activeTabState?.isNotebookPreview ?? false;
  const isMarkdownPreview = activeTabState?.isMarkdownPreview ?? false;

  return (
    <>
      <PreviewTabRow
        tabs={previewTabs}
        activeTabId={activeTabId}
        onTabSelect={onTabSelect}
        onTabClose={onTabClose}
      />

      <PreviewToolbar
        activeTarget={previewTarget}
        vanityUrl={vanityUrl}
        vanityHost={vanityHost}
        onRefresh={onRefresh}
        onOpenExternal={onOpenExternal}
        onBugReport={onBugReportOpen}
        appShareButton={appShareButton}
        notebookViewMode={isNotebookPreview ? notebookViewMode : undefined}
        onNotebookViewModeChange={onNotebookViewModeChange}
        markdownViewMode={isMarkdownPreview ? markdownViewMode : undefined}
        onMarkdownViewModeChange={onMarkdownViewModeChange}
        filePreviewOpenUrl={filePreviewOpenUrl}
        notebookState={isNotebookPreview ? activeNotebookState : undefined}
        isNotebookPdfExporting={isNotebookPreview ? isNotebookPdfExporting : undefined}
        onNotebookReportPdfDownload={isNotebookPreview ? onNotebookReportPdfDownload : undefined}
      />

      {tabRenderStates.map((state) => {
        const isActive = state.tabId === activeTabId;
        return (
          <div
            key={state.tabId}
            className={cn('flex-1 min-h-0 overflow-hidden', !isActive && 'hidden')}
          >
            {state.target.kind === 'app' ? (
              state.isLoading ? (
                <div className="flex h-full w-full items-center justify-center bg-muted/30">
                  <div className="flex flex-col items-center gap-3">
                    <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
                    <span className="text-sm text-muted-foreground">Loading preview...</span>
                  </div>
                </div>
              ) : (
                <iframe
                  ref={isActive ? iframeRef : null}
                  key={state.iframeKey}
                  src={state.appPreviewUrl || 'about:blank'}
                  className="h-full w-full bg-white"
                  title="Deployed App Preview"
                />
              )
            ) : (
              <div className="h-full">
                <FilePreviewContent
                  filename={state.previewFileName}
                  previewUrl={state.filePreviewUrl}
                  contentType={state.target.contentType}
                  layout="panel"
                  notebookViewMode={state.isNotebookPreview ? state.notebookViewMode : undefined}
                  markdownViewMode={state.isMarkdownPreview ? state.markdownViewMode : undefined}
                  onNotebookStateChange={state.isNotebookPreview
                    ? (nextState) => onNotebookStateChange(state.tabId, nextState)
                    : undefined}
                />
              </div>
            )}
          </div>
        );
      })}
    </>
  );
});



export default function Chat({
  threadId,
  workspaceId,
  initialMessages,
  threadTitle,
  threadModel,
  threadProvider,
  experimentalSettings,
  initialPreviewTarget,
  initialPreviewTabs,
  initialActiveTabId,
  isNewThread = false,
  hostname,
  orgSlug,
  isLoadingMessages = false,
  readOnly = false,
  initialWelcomeInput,
  welcomeData,
}: ChatProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const revalidator = useRevalidator();
  const createThreadFetcher = useFetcher<{
    thread?: { id: string; title?: string; model: LlmModel; provider: ChatHarness };
    error?: string;
  }>();
  const updateThreadModelFetcher = useFetcher<{
    thread?: { id: string; model: LlmModel };
    error?: string;
  }>();
  const { user, currentWorkspace, currentOrg, orgs } = useAuthData();
  const isMobile = useIsMobile();
  const resolvedThreadProvider = threadProvider ?? 'claude';
  const resolvedWorkspaceId = readOnly ? workspaceId : (currentWorkspace?.id ?? workspaceId);
  // Compute initial drafts once per mount (Chat is keyed by threadId) to avoid
  // synchronous localStorage reads on every streaming re-render.
  const initialDraftsRef = useRef<{ thread: DraftData | null; welcome: DraftData | null } | undefined>(undefined);
  if (initialDraftsRef.current === undefined) {
    const shouldRestore = !readOnly && shouldHydrateThreadDraft(threadId);
    initialDraftsRef.current = {
      thread: shouldRestore ? loadDraft(resolvedWorkspaceId, threadId ?? null) : null,
      welcome: !readOnly && !threadId && !initialWelcomeInput
        ? loadDraft(resolvedWorkspaceId, null)
        : null,
    };
  }
  const initialThreadDraft = initialDraftsRef.current.thread;
  const initialWelcomeDraft = initialDraftsRef.current.welcome;
  // Anchor to last message for existing threads with messages (not new threads)
  const shouldAnchorToLastMessage = !isNewThread && initialMessages && initialMessages.length > 0;

  // Parse initial messages once
  const parsedInitialMessages = useMemo(
    () => (initialMessages ?? []).map(msg => ({ ...msg, content: parseMessageContent(msg.content) })),
    [initialMessages]
  );
  const initialPreviewSession = useMemo(
    () => normalizePreviewSessionState(
      initialPreviewTabs,
      initialActiveTabId,
      initialPreviewTarget
    ),
    [initialPreviewTabs, initialActiveTabId, initialPreviewTarget]
  );

  // Local state for messages, streaming, and loading
  const [messages, setMessagesState] = useState<Message[]>(parsedInitialMessages);
  const [streamingMessageId, setStreamingMessageIdState] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pendingMessages, setPendingMessagesState] = useState<Message[]>([]);
  const [currentTodos, setCurrentTodos] = useState<TodoItem[]>([]);
  const [pendingQuestion, setPendingQuestion] = useState<AskUserQuestionData | null>(null);
  const [connectionSetupPrompt, setConnectionSetupPrompt] = useState<ConnectionSetupPromptData | null>(null);
  const [bugReportOpen, setBugReportOpen] = useState(false);
  const [bugReportStatus, setBugReportStatus] = useState<BugReportStatus>('idle');
  const [bootModalOpen, setBootModalOpen] = useState(() => shouldShowBootModalFromStorage(isNewThread));
  const [showFreeTierModal, setShowFreeTierModal] = useState(() => shouldShowFreeTierModal(user?.id ?? undefined));
  const [bugReportError, setBugReportError] = useState<string | null>(null);

  const handleFreeTierModalClose = useCallback(() => {
    markFreeTierModalSeen(user?.id ?? undefined);
    setShowFreeTierModal(false);
  }, [user?.id]);

  useEffect(() => {
    if (!bootModalOpen) return;
    try {
      sessionStorage.removeItem('showBootModal');
    } catch {
      // Ignore storage failures; modal behavior should stay resilient.
    }
  }, [bootModalOpen]);

  useEffect(() => {
    if (!shouldShowFreeTierModal(user?.id ?? undefined)) {
      return;
    }
    setShowFreeTierModal(true);
  }, [user?.id]);

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
    if (!location.search.includes('prompt_key=')) {
      return;
    }

    const url = new URL(window.location.href);
    if (!url.searchParams.has('prompt_key')) {
      return;
    }

    url.searchParams.delete('prompt_key');
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  }, [location.search, threadId]);

  const previousWelcomeWorkspaceIdRef = useRef<string | null>(resolvedWorkspaceId ?? null);

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

    const nextDraft = initialWelcomeInput ? null : loadDraft(nextWorkspaceId, null);
    setWelcomeInput(initialWelcomeInput ?? nextDraft?.text ?? '');
    setAttachments(nextDraft?.attachments ?? []);
  }, [initialWelcomeInput, readOnly, resolvedWorkspaceId, threadId]);

  // Compaction in-progress indicator
  const [isCompacting, setIsCompactingState] = useState(false);
  const setIsCompacting = useCallback((value: boolean) => {
    setIsCompactingState(value);
  }, []);
  // Track compaction content block streaming (compaction summary arrives as a
  // content block of type 'compaction' with 'compaction_delta' deltas)
  const isInCompactionBlockRef = useRef(false);
  const compactionContentRef = useRef('');
  const hasCapturedCompactionSummaryRef = useRef(false);
  const pendingCompactionPlaceholderIdRef = useRef<string | null>(null);
  const queuedManualCompactionsRef = useRef(0);
  const activeManualCompactionTurnRef = useRef(false);
  const isAutoCompactingRef = useRef(false);
  // ID of the assistant message that was active when compaction started.
  // Used to suppress finalized visuals until compaction is complete.
  const compactingPriorMessageIdRef = useRef<string | null>(null);
  const [compactingPriorMessageId, setCompactingPriorMessageId] = useState<string | null>(null);
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
    if (activeManualCompactionTurnRef.current || queuedManualCompactionsRef.current <= 0) {
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
  // MCP-triggered bug report capture
  const [mcpBugReportPrompt, setMcpBugReportPrompt] = useState<{ requestId: string; message?: string } | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const normalizedMessages = useMemo(
    () => mergeTaskNotifications(mergeTeammateMessages(normalizeToolResultMessages(messages))),
    [messages]
  );
  const visibleMessages = useMemo(
    () => normalizedMessages.filter(message => !message.isMeta && !message.sourceToolUseID),
    [normalizedMessages]
  );

  // Refs to track current state for use in callbacks (avoids stale closures)
  const messagesRef = useRef(messages);
  const streamingMessageIdRef = useRef(streamingMessageId);
  const runtimeStreamingMessageIdsRef = useRef<Record<string, string | null>>({});
  const lastCompletedAssistantMessageIdRef = useRef<string | null>(null);
  const pendingMessagesRef = useRef(pendingMessages);

  // Wrapper setters that update both state and ref
  const setMessages = useCallback((updater: Message[] | ((prev: Message[]) => Message[])) => {
    setMessagesState(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      messagesRef.current = next;
      return next;
    });
  }, []);

  // Sync messages from loader revalidation when not streaming
  // Only sync on initial mount or explicit refresh, not during active chat
  const prevInitialMessagesRef = useRef(initialMessages);
  const hasHadUserInteraction = useRef(false);
  const hasSyncedInitialLoaderMessagesRef = useRef(false);
  const hasSyncedInitialPreviewRef = useRef(false);
  useEffect(() => {
    const previousInitialMessages = prevInitialMessagesRef.current;
    const initialMessagesChanged = initialMessages !== previousInitialMessages;
    if (!initialMessagesChanged) {
      return;
    }
    if (streamingMessageIdRef.current || revalidator.state !== 'idle') {
      return;
    }
    prevInitialMessagesRef.current = initialMessages;

    // History is loaded via client-side fetch; ignore empty loader updates so
    // they do not clear already-loaded messages.
    if (parsedInitialMessages.length === 0 && messagesRef.current.length > 0) {
      hasSyncedInitialLoaderMessagesRef.current = true;
      return;
    }

    // If users send before deferred history resolves, merge history with local optimistic turns.
    const wasAwaitingInitialHistory =
      !hasSyncedInitialLoaderMessagesRef.current &&
      (previousInitialMessages?.length ?? 0) === 0;

    if (hasHadUserInteraction.current && !wasAwaitingInitialHistory) {
      return;
    }

    const nextMessages = (hasHadUserInteraction.current && wasAwaitingInitialHistory)
      ? mergeServerAndLocalMessages(parsedInitialMessages, messagesRef.current)
      : parsedInitialMessages;

    hasSyncedInitialLoaderMessagesRef.current = true;
    setMessages(nextMessages);
  }, [initialMessages, parsedInitialMessages, setMessages, revalidator.state]);

  const setStreamingMessageId = useCallback((id: string | null) => {
    streamingMessageIdRef.current = id;
    setStreamingMessageIdState(id);
  }, []);

  const setPendingMessages = useCallback((updater: Message[] | ((prev: Message[]) => Message[])) => {
    setPendingMessagesState(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      pendingMessagesRef.current = next;
      return next;
    });
  }, []);

  const isStreaming = streamingMessageId !== null;
  const wasStreamingRef = useRef(isStreaming);
  const activeAssistantMessageId = useMemo(() => {
    if (streamingMessageId) {
      const trackedMessageExists = messages.some(
        msg => msg.id === streamingMessageId && msg.role === 'assistant'
      );
      if (trackedMessageExists) return streamingMessageId;
    }

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === 'assistant' && msg.isStreaming) return msg.id;
    }

    return null;
  }, [messages, streamingMessageId]);
  const assistantTurnActive = loading || isStreaming;
  const hasActiveAssistantMessage = activeAssistantMessageId !== null;
  const showGlobalAssistantIndicator =
    assistantTurnActive && !hasActiveAssistantMessage && !isCompacting;
  const skillSheetsByToolId = useMemo(() => {
    const map = new Map<string, string>();
    for (const message of messages) {
      if (!message.sourceToolUseID) continue;
      const content = typeof message.content === 'string'
        ? message.content
        : message.content
            .map(block => (block?.type === 'text' ? block.text : ''))
            .filter(Boolean)
            .join('\n\n');
      if (content) {
        map.set(message.sourceToolUseID, content);
      }
    }
    return map;
  }, [messages]);
  const availableThreadModels = useMemo(
    () => getVisibleLlmModelOptions(
      resolvedThreadProvider,
      experimentalSettings,
      threadModel ?? getDefaultLlmModel(resolvedThreadProvider),
      { allowModelFamilySwitch: !threadId },
    ),
    [resolvedThreadProvider, experimentalSettings, threadId, threadModel]
  );

  const [input, setInput] = useState(() => initialThreadDraft?.text ?? '');
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [welcomeInput, setWelcomeInput] = useState(() => (
    initialWelcomeInput ?? initialWelcomeDraft?.text ?? ''
  ));
  const [selectedThreadModel, setSelectedThreadModel] = useState<LlmModel>(
    threadModel ?? getDefaultLlmModel(resolvedThreadProvider)
  );
  const lastAppliedWelcomeInputRef = useRef(initialWelcomeInput ?? '');
  const [isCreatingThread, setIsCreatingThread] = useState(false);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>(() => (
    initialThreadDraft?.attachments ?? initialWelcomeDraft?.attachments ?? []
  ));
  const [contextUsedPercent, setContextUsedPercent] = useState<number | null>(null);
  const attachmentPreviewUrlsRef = useRef<Set<string>>(new Set());
  const inputRef = useRef(input);
  const welcomeInputRef = useRef(welcomeInput);
  const attachmentsRef = useRef(attachments);
  const prevErrorRef = useRef<string | null>(null);
  const skipNextEmptyDraftSaveRef = useRef(false);
  const pendingDeliveryDraftRef = useRef<{ workspaceId: string; threadId: string | null } | null>(null);
  const pendingDraftCountRef = useRef(0);
  const { saveDraft, flushDraft } = useDraftPersistence(resolvedWorkspaceId, threadId ?? null);
  const [isDragOver, setIsDragOver] = useState(false);

  useEffect(() => {
    inputRef.current = input;
  }, [input]);

  useEffect(() => {
    welcomeInputRef.current = welcomeInput;
  }, [welcomeInput]);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  const [previewTabs, setPreviewTabs] = useState<PreviewTab[]>(() => initialPreviewSession.tabs);
  const [activeTabId, setActiveTabId] = useState<string | null>(() => initialPreviewSession.activeTabId);
  const previewTabsRef = useRef<PreviewTab[]>(previewTabs);
  const activeTabIdRef = useRef<string | null>(activeTabId);
  const activeTab = useMemo(
    () => previewTabs.find((tab) => tab.id === activeTabId) ?? null,
    [previewTabs, activeTabId]
  );
  const previewTarget = activeTab?.target ?? null;
  const [tabIframeKeys, setTabIframeKeys] = useState<Record<string, number>>({});
  const [tabFilePreviewKeys, setTabFilePreviewKeys] = useState<Record<string, number>>({});
  const [tabNotebookViewModes, setTabNotebookViewModes] = useState<Record<string, 'report' | 'notebook'>>({});
  const [tabMarkdownViewModes, setTabMarkdownViewModes] = useState<Record<string, 'rendered' | 'source'>>({});
  const [tabNotebookStates, setTabNotebookStates] = useState<Record<string, NotebookPreviewLoadState>>({});
  const [tabNotebookPdfExporting, setTabNotebookPdfExporting] = useState<Record<string, boolean>>({});
  const [tabAppLoading, setTabAppLoading] = useState<Record<string, boolean>>({});
  const notebookViewMode = activeTabId ? (tabNotebookViewModes[activeTabId] ?? 'report') : 'report';
  const markdownViewMode = activeTabId ? (tabMarkdownViewModes[activeTabId] ?? 'rendered') : 'rendered';
  const activeNotebookState = activeTabId
    ? (tabNotebookStates[activeTabId] ?? DEFAULT_NOTEBOOK_PREVIEW_STATE)
    : DEFAULT_NOTEBOOK_PREVIEW_STATE;
  const isNotebookPdfExporting = activeTabId
    ? Boolean(tabNotebookPdfExporting[activeTabId])
    : false;
  const [mobileView, setMobileView] = useState<'chat' | 'preview'>('chat');
  const [currentTitle, setCurrentTitle] = useState(threadTitle);
  const previewVersionRef = useRef<number>(0);
  const supportsPreviewTabsStateRef = useRef<boolean>(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const messageColumnRef = useRef<HTMLDivElement>(null);
  const lastUserMessageRef = useRef<HTMLDivElement>(null);
  const assistantMeasureRef = useRef<HTMLDivElement>(null);
  const assistantPendingMeasureRef = useRef<HTMLDivElement>(null);
  const assistantSpacerRef = useRef<HTMLDivElement>(null);
  const spacerHeightRef = useRef(0);
  const initialScrollDoneRef = useRef(false);
  const stickToBottomRef = useRef(true);
  const forceScrollOnNextUpdate = useRef(false);
  const splitStreamingMessageOnNextPartRef = useRef(false);
  const wsRef = useRef<WebSocket | null>(null);
  const iframeRefreshTimeoutsRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const iframeRetryCountsRef = useRef<Record<string, number>>({});
  const iframeRetryTimeoutsRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const reconnectAttempts = useRef(0);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const pingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const historyFetchAbortRef = useRef<AbortController | null>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement>(null);
  const firstUserMessageBackfillAttemptedRef = useRef<Set<string>>(new Set());
  const sessionIdRef = useRef<string | null>(null);
  const lastEventIdRef = useRef(0);
  const connectionStartedAtRef = useRef<Map<number, number>>(new Map());
  const fallbackRenderedAtRef = useRef<number>(Date.now());

  useEffect(() => {
    initialScrollDoneRef.current = false;
    stickToBottomRef.current = true;
    splitStreamingMessageOnNextPartRef.current = false;
    setCurrentTodos([]);
    setPendingQuestion(null);
    setContextUsedPercent(null);
    lastCompletedAssistantMessageIdRef.current = null;
    compactingPriorMessageIdRef.current = null;
    setCompactingPriorMessageId(null);
  }, [threadId]);

  useEffect(() => {
    previewTabsRef.current = previewTabs;
  }, [previewTabs]);

  useEffect(() => {
    activeTabIdRef.current = activeTabId;
  }, [activeTabId]);

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

  useEffect(() => {
    previewTabsRef.current = initialPreviewSession.tabs;
    setPreviewTabs(initialPreviewSession.tabs);
    activeTabIdRef.current = initialPreviewSession.activeTabId;
    setActiveTabId(initialPreviewSession.activeTabId);

    setTabIframeKeys({});
    setTabFilePreviewKeys({});
    setTabNotebookViewModes({});
    setTabMarkdownViewModes({});
    setTabNotebookStates({});
    setTabNotebookPdfExporting({});
    setTabAppLoading({});
    previewVersionRef.current = 0;
    supportsPreviewTabsStateRef.current = false;
    clearAllIframeRefreshTimeouts();
    setMobileView('chat');
  }, [threadId, clearAllIframeRefreshTimeouts]);

  useEffect(() => {
    if (!threadId) {
      previewTabsRef.current = [];
      setPreviewTabs([]);
      activeTabIdRef.current = null;
      setActiveTabId(null);
      setTabIframeKeys({});
      setTabFilePreviewKeys({});
      setTabNotebookViewModes({});
      setTabMarkdownViewModes({});
      setTabAppLoading({});
      supportsPreviewTabsStateRef.current = false;
      clearAllIframeRefreshTimeouts();
    }
  }, [threadId, clearAllIframeRefreshTimeouts]);

  // Retry iframe on transient errors (404/500/503) during deploy.
  // Dispatcher error pages postMessage({ type: 'chiridion-preview-error', status }) to parent.
  const IFRAME_MAX_RETRIES = 3;
  const IFRAME_RETRY_DELAY_MS = 2000;
  useEffect(() => {
    const iframeDomain = hostname ? getIframeDomain(hostname) : null;

    function handlePreviewError(event: MessageEvent) {
      if (
        !event.data ||
        event.data.type !== 'chiridion-preview-error' ||
        typeof event.data.status !== 'number'
      ) return;
      const status = event.data.status as number;
      if (status !== 404 && status !== 500 && status !== 503) return;

      // Match the message origin to an app tab
      const tabs = previewTabsRef.current;
      const matchedTab = iframeDomain
        ? tabs.find((tab) => {
            if (tab.target.kind !== 'app') return false;
            const s = tab.target.scriptName;
            const host = orgSlug
              ? `${buildAppLabel(s, orgSlug)}.${iframeDomain}`
              : `${s}.${iframeDomain}`;
            return event.origin === `https://${host}`;
          })
        : null;
      const tabId = matchedTab?.id ?? activeTabIdRef.current;
      if (!tabId) return;

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

    window.addEventListener('message', handlePreviewError);
    return () => window.removeEventListener('message', handlePreviewError);
  }, [hostname, orgSlug]);

  const revokeAttachmentPreviewUrl = useCallback((url?: string) => {
    if (!url) return;
    attachmentPreviewUrlsRef.current.delete(url);
    URL.revokeObjectURL(url);
  }, []);

  const deployedApp = previewTarget?.kind === 'app' ? previewTarget.scriptName : null;
  const appIsPublic = previewTarget?.kind === 'app' ? previewTarget.isPublic : false;
  const setAppIsPublic = useCallback((isPublic: boolean) => {
    if (!activeTabId) return;
    setPreviewTabs((prev) => (
      prev.map((tab) => {
        if (tab.id !== activeTabId || tab.target.kind !== 'app') return tab;
        return {
          ...tab,
          target: {
            ...tab.target,
            isPublic,
          },
        };
      })
    ));
  }, [activeTabId]);


  // Todo state comes directly from server via todo_state events
  // Clear todos when streaming starts (new message turn)
  useEffect(() => {
    if (!wasStreamingRef.current && isStreaming) {
      setCurrentTodos([]);
    }
    wasStreamingRef.current = isStreaming;
  }, [isStreaming]);

  useEffect(() => {
    if (!currentTodos.length || isStreaming) return;
    const allComplete = currentTodos.every(todo => todo.status === 'completed');
    const timeout = setTimeout(() => {
      setCurrentTodos([]);
    }, allComplete ? 1500 : 2000);
    return () => clearTimeout(timeout);
  }, [currentTodos, isStreaming]);

  // Sync current title from prop (e.g., when SSR data arrives)
  useEffect(() => {
    setCurrentTitle(threadTitle);
  }, [threadTitle]);

  useEffect(() => {
    setSelectedThreadModel(threadModel ?? getDefaultLlmModel(resolvedThreadProvider));
  }, [resolvedThreadProvider, threadId, threadModel]);

  // Track connection ID to ignore events from stale WebSocket instances
  const connectionIdRef = useRef(0);
  // Ref to hold stable connect function for effect
  const connectWebSocketRef = useRef<((id: string, isReconnect?: boolean) => void) | null>(null);
  const resolvedWelcomeData = welcomeData ?? {
    userId: user?.id ?? null,
    userName: user?.name ?? null,
    allApps: [],
    connections: [],
    recentThreads: [],
    renderedAt: fallbackRenderedAtRef.current,
  };
  // Use static key for pending messages - threadId in payload ensures correct matching
  // This avoids issues when workspace changes between welcome screen and chat page
  const pendingMessageKey = 'pendingMessage:newThread';
  const sessionStorageKey = useCallback((id: string) => {
    const workspaceKey = resolvedWorkspaceId ?? 'unknown';
    return `ws_session_${workspaceKey}_${id}`;
  }, [resolvedWorkspaceId]);

  const preserveDraftBeforeOptimisticClear = useCallback((
    draftThreadId: string | null,
    text: string,
    nextAttachments: Attachment[]
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
    };
    skipNextEmptyDraftSaveRef.current = true;
  }, [flushDraft, resolvedWorkspaceId, threadId]);

  const clearPendingDeliveryDraft = useCallback(() => {
    const pendingDraft = pendingDeliveryDraftRef.current;

    if (!pendingDraft) {
      return;
    }

    // If multiple sends are in flight (sentDuringStreaming), only clear the
    // draft backup once the last turn completes — otherwise an earlier result
    // would delete the backup that a later, still-in-flight turn needs.
    pendingDraftCountRef.current = Math.max(0, pendingDraftCountRef.current - 1);
    if (pendingDraftCountRef.current > 0) {
      return;
    }

    pendingDeliveryDraftRef.current = null;

    if (!isComposerVisiblyEmpty(inputRef.current, attachmentsRef.current)) {
      return;
    }

    removeDraft(pendingDraft.workspaceId, pendingDraft.threadId);
  }, []);

  const restorePendingDeliveryDraft = useCallback(() => {
    const pendingDraft = pendingDeliveryDraftRef.current;
    pendingDeliveryDraftRef.current = null;
    pendingDraftCountRef.current = 0;

    if (!pendingDraft) {
      return;
    }

    if (!isComposerVisiblyEmpty(inputRef.current, attachmentsRef.current)) {
      return;
    }

    const savedDraft = loadDraft(pendingDraft.workspaceId, pendingDraft.threadId);
    if (!savedDraft) {
      return;
    }

    setInput(savedDraft.text);
    setAttachments(savedDraft.attachments);
  }, []);

  const loadSessionState = useCallback((id: string) => {
    try {
      const stored = sessionStorage.getItem(sessionStorageKey(id));
      if (stored) {
        const parsed = JSON.parse(stored) as { sessionId?: string; lastEventId?: number };
        sessionIdRef.current = typeof parsed.sessionId === 'string' ? parsed.sessionId : null;
        lastEventIdRef.current = typeof parsed.lastEventId === 'number' ? parsed.lastEventId : 0;
        return;
      }
    } catch (e) {
      console.warn('Failed to load session state:', e);
    }
    sessionIdRef.current = null;
    lastEventIdRef.current = 0;
  }, [sessionStorageKey]);

  const persistSessionState = useCallback((id: string) => {
    try {
      const payload = {
        sessionId: sessionIdRef.current,
        lastEventId: lastEventIdRef.current,
      };
      sessionStorage.setItem(sessionStorageKey(id), JSON.stringify(payload));
    } catch (e) {
      console.warn('Failed to persist session state:', e);
    }
  }, [sessionStorageKey]);

  useEffect(() => {
    if (!threadId) {
      sessionIdRef.current = null;
      lastEventIdRef.current = 0;
      return;
    }
    loadSessionState(threadId);
  }, [threadId, loadSessionState, resolvedWorkspaceId]);

  useEffect(() => {
    if (!isNewThread || !threadId) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get('newThread') !== '1') return;
    url.searchParams.delete('newThread');
    window.history.replaceState(null, '', url.toString());
  }, [isNewThread, threadId]);

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

  // Fetch message history as a single JSON payload.
  // The worker route streams response bytes through from sandbox-host so the
  // worker itself does not need to buffer the whole payload.
  const backfillThreadFirstUserMessage = useCallback(async (id: string, loadedMessages: Message[]) => {
    if (readOnly) return;
    if (!resolvedWorkspaceId) return;
    if (firstUserMessageBackfillAttemptedRef.current.has(id)) return;

    const firstUserMessage = getFirstThreadPreviewUserMessage(loadedMessages);
    if (!firstUserMessage) return;

    firstUserMessageBackfillAttemptedRef.current.add(id);
    try {
      const response = await fetch(
        `/api/workspaces/${encodeURIComponent(resolvedWorkspaceId)}/chat/${encodeURIComponent(id)}/first-user-message`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ firstUserMessage }),
        }
      );
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
    } catch (error) {
      console.warn('Failed to backfill first user message:', error);
      firstUserMessageBackfillAttemptedRef.current.delete(id);
    }
  }, [readOnly, resolvedWorkspaceId]);

  const fetchMessages = useCallback(async (id: string) => {
    if (!readOnly && !resolvedWorkspaceId) return;

    historyFetchAbortRef.current?.abort();
    const abortController = new AbortController();
    historyFetchAbortRef.current = abortController;

    setError(null);

    try {
      const url = readOnly
        ? `/api/admin/threads/${encodeURIComponent(id)}/messages`
        : `/api/workspaces/${encodeURIComponent(resolvedWorkspaceId)}/chat/${encodeURIComponent(id)}/messages/stream`;
      const response = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: abortController.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText || `Failed to fetch messages (${response.status})`);
      }

      const payload = await response.json() as {
        success?: unknown;
        messages?: unknown;
        error?: unknown;
      };
      if (abortController.signal.aborted) return;

      const rawMessages = Array.isArray(payload.messages) ? payload.messages : [];
      const loadedMessages: Message[] = rawMessages.flatMap((raw) => {
        if (!raw || typeof raw !== 'object') return [];
        const item = raw as Record<string, unknown>;
        const messageId = typeof item.id === 'string' ? item.id : null;
        const role = item.role === 'assistant' ? 'assistant' : item.role === 'user' ? 'user' : null;
        const createdAt = typeof item.created_at === 'number' ? item.created_at : null;
        if (!messageId || !role || createdAt === null) return [];

        const message: Message = {
          id: messageId,
          thread_id: typeof item.thread_id === 'string' ? item.thread_id : id,
          role,
          content: parseMessageContent((item.content ?? '') as string | ContentBlock[]),
          created_at: createdAt,
          isMeta: item.isMeta === true,
          sourceToolUseID: typeof item.sourceToolUseID === 'string' ? item.sourceToolUseID : undefined,
          isCompactSummary: item.isCompactSummary === true,
        };
        return [message];
      });

      const mergedMessages = mergeServerAndLocalMessages(loadedMessages, messagesRef.current);
      setMessages(mergedMessages);
      void backfillThreadFirstUserMessage(id, mergedMessages);
    } catch (error) {
      if (abortController.signal.aborted) return;
      console.error('Failed to fetch message history stream:', error);
      setError('Failed to load message history');
    } finally {
      if (historyFetchAbortRef.current === abortController) {
        historyFetchAbortRef.current = null;
      }
    }
  }, [backfillThreadFirstUserMessage, readOnly, resolvedWorkspaceId, setError, setMessages]);

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

  const setActiveNotebookViewMode = useCallback((mode: 'report' | 'notebook') => {
    if (!activeTabId) return;
    setTabNotebookViewModes((prev) => ({
      ...prev,
      [activeTabId]: mode,
    }));
  }, [activeTabId]);

  const setActiveMarkdownViewMode = useCallback((mode: 'rendered' | 'source') => {
    if (!activeTabId) return;
    setTabMarkdownViewModes((prev) => ({
      ...prev,
      [activeTabId]: mode,
    }));
  }, [activeTabId]);

  const syncPreviewTargetBestEffort = useCallback((target: PreviewTarget | null) => {
    if (!threadId) return;
    const socket = wsRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({
      type: 'set_preview_target',
      target,
      threadId,
    }));
  }, [threadId]);

  const syncPreviewTabsStateBestEffort = useCallback((
    nextTabs: PreviewTab[],
    nextActiveTabId: string | null
  ) => {
    if (!threadId) return;
    const socket = wsRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;

    const nextActiveTarget = nextActiveTabId
      ? (nextTabs.find((tab) => tab.id === nextActiveTabId)?.target ?? null)
      : null;

    if (supportsPreviewTabsStateRef.current) {
      socket.send(JSON.stringify({
        type: 'set_preview_tabs_state',
        tabs: nextTabs.map((tab) => tab.target),
        activeTabId: nextActiveTabId,
        threadId,
      }));
    } else {
      syncPreviewTargetBestEffort(nextActiveTarget);
    }
  }, [threadId, syncPreviewTargetBestEffort]);

  const setLocalPreviewSessionState = useCallback((
    nextTabs: PreviewTab[],
    nextActiveTabId: string | null
  ) => {
    previewTabsRef.current = nextTabs;
    setPreviewTabs(nextTabs);
    activeTabIdRef.current = nextActiveTabId;
    setActiveTabId(nextActiveTabId);
  }, []);

  useEffect(() => {
    if (!threadId || hasSyncedInitialPreviewRef.current) return;
    if (previewTabsRef.current.length > 0) {
      hasSyncedInitialPreviewRef.current = true;
      return;
    }
    if (initialPreviewSession.tabs.length === 0) return;

    setLocalPreviewSessionState(initialPreviewSession.tabs, initialPreviewSession.activeTabId);
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
    setTabMarkdownViewModes((prev) => {
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

    const timeout = iframeRefreshTimeoutsRef.current[tabId];
    if (timeout) {
      clearTimeout(timeout);
      delete iframeRefreshTimeoutsRef.current[tabId];
    }
    const retryTimeout = iframeRetryTimeoutsRef.current[tabId];
    if (retryTimeout) {
      clearTimeout(retryTimeout);
      delete iframeRetryTimeoutsRef.current[tabId];
    }
    delete iframeRetryCountsRef.current[tabId];
  }, []);

  const openTabForTarget = useCallback((target: PreviewTarget, options?: { sync?: boolean }) => {
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
  }, [setLocalPreviewSessionState, syncPreviewTabsStateBestEffort]);

  const selectTab = useCallback((tabId: string) => {
    const nextActiveTab = previewTabsRef.current.find((tab) => tab.id === tabId);
    if (!nextActiveTab) return;
    setLocalPreviewSessionState(previewTabsRef.current, tabId);
    syncPreviewTabsStateBestEffort(previewTabsRef.current, tabId);
  }, [setLocalPreviewSessionState, syncPreviewTabsStateBestEffort]);

  const closeTab = useCallback((tabId: string) => {
    const prevTabs = previewTabsRef.current;
    const closingTabIndex = prevTabs.findIndex((tab) => tab.id === tabId);
    if (closingTabIndex === -1) return;

    const nextTabs = prevTabs.filter((tab) => tab.id !== tabId);
    let nextActiveTabId = activeTabIdRef.current;

    if (tabId === activeTabIdRef.current) {
      if (!nextTabs.length) {
        nextActiveTabId = null;
        setMobileView('chat');
      } else {
        const nextIndex = Math.min(closingTabIndex, nextTabs.length - 1);
        const nextActiveTab = nextTabs[nextIndex];
        nextActiveTabId = nextActiveTab.id;
      }
    }

    setLocalPreviewSessionState(nextTabs, nextActiveTabId);
    syncPreviewTabsStateBestEffort(nextTabs, nextActiveTabId);
    cleanupClosedTabState(tabId);
  }, [setLocalPreviewSessionState, syncPreviewTabsStateBestEffort, cleanupClosedTabState]);

  const handleTabNotebookStateChange = useCallback((
    tabId: string,
    state: NotebookPreviewLoadState
  ) => {
    setTabNotebookStates((prev) => {
      const current = prev[tabId];
      if (current?.status === state.status && current?.notebook === state.notebook) {
        return prev;
      }
      return {
        ...prev,
        [tabId]: state,
      };
    });
  }, []);

  const handleNotebookReportPdfDownload = useCallback(async () => {
    if (!activeTabId || previewTarget?.kind !== 'file') return;
    if (tabNotebookPdfExporting[activeTabId]) return;

    const notebookState = tabNotebookStates[activeTabId] ?? DEFAULT_NOTEBOOK_PREVIEW_STATE;
    if (notebookState.status !== 'ready' || !notebookState.notebook) {
      return;
    }

    const tabId = activeTabId;
    const fallbackName = previewTarget.path.split('/').filter(Boolean).pop() || 'notebook.ipynb';
    const filename = previewTarget.filename || fallbackName;

    setTabNotebookPdfExporting((prev) => ({
      ...prev,
      [tabId]: true,
    }));

    try {
      const { exportNotebookReportAsPdf } = await import(
        '@/components/chat-file-preview/notebook-preview/pdf-export'
      );
      await exportNotebookReportAsPdf({
        notebook: notebookState.notebook,
        filename,
      });
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : 'Failed to export notebook report as PDF.';
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

  const handleRealtimeSideChannelEvent = useCallback((data: any) => {
    if (data.type === 'preview_state') {
      const newVersion = typeof data.version === 'number' ? data.version : 0;
      const hasVersionBump = newVersion > previewVersionRef.current;
      previewVersionRef.current = newVersion;
      const hasRefreshHint = data.refreshTabId !== undefined;
      const refreshTabId = typeof data.refreshTabId === 'string' ? data.refreshTabId : null;

      const hasTabsPayload = Array.isArray(data.tabs) || data.activeTabId !== undefined;
      supportsPreviewTabsStateRef.current = hasTabsPayload;
      if (hasTabsPayload) {
        const nextSession = normalizePreviewSessionState(data.tabs, data.activeTabId, data.target);
        setLocalPreviewSessionState(nextSession.tabs, nextSession.activeTabId);

        if (!nextSession.target || !nextSession.activeTabId) {
          return;
        }

        const nextActiveId = nextSession.activeTabId;
        const shouldRefreshActiveTab = refreshTabId
          ? refreshTabId === nextActiveId
          : (!hasRefreshHint && hasVersionBump);

        if (nextSession.target.kind === 'app' && shouldRefreshActiveTab) {
          const existingTimeout = iframeRefreshTimeoutsRef.current[nextActiveId];
          if (existingTimeout) {
            clearTimeout(existingTimeout);
          }
          setTabAppLoading((prev) => ({ ...prev, [nextActiveId]: true }));
          iframeRefreshTimeoutsRef.current[nextActiveId] = setTimeout(() => {
            setTabAppLoading((prev) => ({ ...prev, [nextActiveId]: false }));
            bumpIframeKey(nextActiveId);
            delete iframeRefreshTimeoutsRef.current[nextActiveId];
          }, 1500);
        } else if (nextSession.target.kind === 'file' && shouldRefreshActiveTab) {
          bumpFilePreviewKey(nextActiveId);
        }
        return;
      }

      const nextTarget = coercePreviewTarget(data.target);
      if (!nextTarget) {
        // Keep client tab state even if the server has no active target.
        return;
      }

      openTabForTarget(nextTarget);
      const nextTabId = getPreviewTabId(nextTarget);
      const shouldRefreshTab = refreshTabId
        ? refreshTabId === nextTabId
        : (!hasRefreshHint && hasVersionBump);

      if (nextTarget.kind === 'app' && shouldRefreshTab) {
        const existingTimeout = iframeRefreshTimeoutsRef.current[nextTabId];
        if (existingTimeout) {
          clearTimeout(existingTimeout);
        }
        setTabAppLoading((prev) => ({ ...prev, [nextTabId]: true }));
        iframeRefreshTimeoutsRef.current[nextTabId] = setTimeout(() => {
          setTabAppLoading((prev) => ({ ...prev, [nextTabId]: false }));
          bumpIframeKey(nextTabId);
          delete iframeRefreshTimeoutsRef.current[nextTabId];
        }, 1500);
      } else if (nextTarget.kind === 'file' && shouldRefreshTab) {
        bumpFilePreviewKey(nextTabId);
      }

      return;
    }

    if (data.type === 'title_updated' && data.title) {
      setCurrentTitle(data.title);
      return;
    }

    if (data.type === 'thread_model_updated' && isLlmModel(data.model, resolvedThreadProvider)) {
      setSelectedThreadModel(data.model);
      return;
    }

    if (data.type === 'connection_setup_prompt' && data.requestId && data.integrationType) {
      setConnectionSetupPrompt({
        requestId: data.requestId as string,
        integrationType: data.integrationType as string,
        suggestedName: data.suggestedName as string | undefined,
        message: data.message as string | undefined,
        dynamicSchema: data.dynamicSchema as ConnectionSetupPromptData['dynamicSchema'],
        mcpDoId: data.mcpDoId as string | undefined,
      });
      return;
    }

    if (data.type === 'bug_report_prompt' && data.requestId) {
      setMcpBugReportPrompt({
        requestId: data.requestId as string,
        message: data.message as string | undefined,
      });
    }
  }, [
    openTabForTarget,
    resolvedThreadProvider,
    setLocalPreviewSessionState,
    bumpIframeKey,
    bumpFilePreviewKey,
  ]);

  // WebSocket connection management
  const connectWebSocket = useCallback((id: string, isReconnect = false) => {
    if (!id) {
      return;
    }
    // Clear any pending reconnect
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

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

    // Fetch existing messages from REST API unless this is a new thread
    let shouldFetchMessages = !isNewThread && !isLoadingMessages;

    // Check sessionStorage for welcome screen pending message (survives navigation)
    const pendingPayload = readPendingNewThreadMessage();
    if (pendingPayload?.threadId === id && typeof pendingPayload.message === 'string') {
      shouldFetchMessages = false;
      sessionStorage.removeItem(pendingMessageKey);
      if (pendingPayload.threadTitle) {
        setCurrentTitle(pendingPayload.threadTitle);
      }
      if (pendingPayload.threadModel) {
        setSelectedThreadModel(pendingPayload.threadModel);
      }
      if (resolvedWorkspaceId) {
        pendingDeliveryDraftRef.current = {
          workspaceId: resolvedWorkspaceId,
          threadId: id,
        };
      }

      // Add to state (both messages and pending queue)
      const optimisticUserMsg: Message = {
        id: `local_${Date.now()}`,
        thread_id: id,
        role: 'user',
        content: pendingPayload.message,
        created_at: Date.now(),
      };
      setMessages([optimisticUserMsg]);
      setPendingMessages(prev => [...prev, optimisticUserMsg]);
      setLoading(true);
    }

    // Skip fetch if we have pending messages (use ref to avoid stale closure)
    if (shouldFetchMessages && pendingMessagesRef.current.length > 0) {
      shouldFetchMessages = false;
    }

    // Skip fetch if we already have messages (use ref to avoid stale closure)
    if (shouldFetchMessages && messagesRef.current.length > 0) {
      shouldFetchMessages = false;
    }

    if (shouldFetchMessages) {
      fetchMessages(id);
    }

    // WebSocket connects at /ws/{workspace}?threadId={id}
    // Worker validates thread scope and forwards to ChatThreadDO for sandbox chat transport.
    const wsHost = window.location.host;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const workspaceIdForConnection = resolvedWorkspaceId;
    const wsUrl = `${protocol}//${wsHost}/ws/${workspaceIdForConnection}?threadId=${encodeURIComponent(id)}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      // Ignore if this connection was superseded
      if (connectionIdRef.current !== thisConnectionId) {
        return;
      }
      reconnectAttempts.current = 0;

      // Start ping interval to detect connection issues early
      if (pingIntervalRef.current) {
        clearInterval(pingIntervalRef.current);
      }
      pingIntervalRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, 30000); // Ping every 30 seconds

      // Send init message to container
      ws.send(JSON.stringify({
        type: 'init',
        threadId: id,
        sessionId: sessionIdRef.current,
        lastEventId: lastEventIdRef.current,
      }));
    };

    ws.onmessage = (event) => {
      // Ignore messages from stale WebSocket instances (e.g., from StrictMode double-mount)
      if (wsRef.current !== ws) {
        return;
      }

      const data = JSON.parse(event.data);

      if (typeof data?.eventId === 'number') {
        lastEventIdRef.current = Math.max(lastEventIdRef.current, data.eventId);
        if (id) {
          persistSessionState(id);
        }
      }

      if (data.type === 'ready') {
        // Container is ready to receive messages
        setReady(true);

        // Get and clear queued messages
        const queuedMessages = pendingMessagesRef.current;
        if (queuedMessages.length > 0) {
          setPendingMessages([]);
          setLoading(true);

          // Restore to state if missing (fetchMessages may have cleared them during reconnect)
          const currentMessages = messagesRef.current;
          const existingIds = new Set(currentMessages.map(m => m.id));
          const missing = queuedMessages.filter(m => !existingIds.has(m.id));
          if (missing.length > 0) {
            setMessages([...currentMessages, ...missing]);
          }

          // Send all queued messages
          for (const msg of queuedMessages) {
            const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
            ws.send(JSON.stringify({
              type: 'message',
              content,
              sessionId: sessionIdRef.current,
              threadId: id,
            }));
          }
        }
      } else if (data.type === 'session' && typeof data.sessionId === 'string') {
        const newSessionId = data.sessionId;
        if (sessionIdRef.current && sessionIdRef.current !== newSessionId) {
          lastEventIdRef.current = 0;
        }
        sessionIdRef.current = newSessionId;
        if (id) {
          persistSessionState(id);
        }
      } else if (data.type === 'runtime_event') {
        if (!id) {
          return;
        }
        const runtimeEvent = data.event;
        setMessages((prev) => {
          const next = applyRuntimeEventToMessages(
            prev,
            id,
            'codex',
            runtimeEvent,
            runtimeStreamingMessageIdsRef.current,
          );
          return next;
        });
        const nextStreamingId = runtimeStreamingMessageIdsRef.current[id] ?? null;
        setStreamingMessageId(nextStreamingId);

        if (
          runtimeEvent &&
          typeof runtimeEvent === 'object' &&
          (runtimeEvent as { method?: unknown }).method === 'turn/completed'
        ) {
          lastCompletedAssistantMessageIdRef.current = nextStreamingId;
          setStreamingMessageId(null);
          setLoading(false);
          clearPendingDeliveryDraft();
        }
      } else if (data.type === 'sdk_event') {
        // Handle SDK events for streaming
        const sdkEvent = data.event as SDKEvent;
        const currentStreamingId = streamingMessageIdRef.current;

        if (sdkEvent.type === 'stream_event') {
          const evt = sdkEvent.event;

          // ── Compaction content block interception ──
          // The API streams the compaction summary as a content block of type
          // 'compaction' with a single 'compaction_delta' containing the full
          // summary text. Intercept these events before they reach the normal
          // streaming pipeline so the summary is rendered as a standalone
          // CompactSummaryCard instead of being appended to the assistant message.
          if (evt?.type === 'content_block_start' && evt?.content_block?.type === 'compaction') {
            isInCompactionBlockRef.current = true;
            compactionContentRef.current = '';
            hasCapturedCompactionSummaryRef.current = false;
            // Fallback trigger when system/status events are unavailable.
            isAutoCompactingRef.current = true;
            syncCompactionIndicator();
            // Only capture once: status events are the primary source and this is
            // a fallback path when those events are missing.
            if (compactingPriorMessageIdRef.current === null) {
              const priorId = streamingMessageIdRef.current
                ?? lastCompletedAssistantMessageIdRef.current
                ?? null;
              compactingPriorMessageIdRef.current = priorId;
              setCompactingPriorMessageId(priorId);
            }
            if (streamingMessageIdRef.current) {
              setStreamingMessageId(null);
            }
            return;
          }
          if (isInCompactionBlockRef.current) {
            if (evt?.type === 'content_block_delta' && evt?.delta?.type === 'compaction_delta') {
              compactionContentRef.current += evt.delta.content || '';
              return;
            }
            if (evt?.type === 'content_block_stop') {
              const summary = compactionContentRef.current;
              isInCompactionBlockRef.current = false;
              compactionContentRef.current = '';
              compactingPriorMessageIdRef.current = null;
              setCompactingPriorMessageId(null);
              if (summary) {
                hasCapturedCompactionSummaryRef.current = true;
                completeActiveManualCompaction();
                isAutoCompactingRef.current = false;
                syncCompactionIndicator();
                const existingPlaceholderId = pendingCompactionPlaceholderIdRef.current;
                const compactMsg: Message = {
                  id: existingPlaceholderId || `compact_${Date.now()}`,
                  thread_id: id,
                  role: 'user',
                  content: summary,
                  created_at: Date.now(),
                  isCompactSummary: true,
                };
                pendingCompactionPlaceholderIdRef.current = compactMsg.id;
                setMessages(prev => {
                  if (existingPlaceholderId) {
                    const placeholderIndex = prev.findIndex(m => m.id === existingPlaceholderId);
                    if (placeholderIndex !== -1) {
                      const next = [...prev];
                      next[placeholderIndex] = compactMsg;
                      return next;
                    }
                  }
                  const existingSummaryIndex = prev.findIndex(m => m.id === compactMsg.id);
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

          if (evt?.type === 'message_start') {
            const currentMsgs = messagesRef.current;
            const existingStreamingId = streamingMessageIdRef.current;
            const existingStreamingMsg = existingStreamingId
              ? currentMsgs.find(msg => msg.id === existingStreamingId)
              : undefined;
            const fallbackStreamingMsg = existingStreamingMsg
              ? undefined
              : currentMsgs.find(msg => msg.isStreaming);
            const activeStreamingMsg = existingStreamingMsg ?? fallbackStreamingMsg;

            if (splitStreamingMessageOnNextPartRef.current && activeStreamingMsg) {
              splitStreamingMessageOnNextPartRef.current = false;
              const nextMsgIdBase = evt.message?.id || (sdkEvent as { uuid?: string }).uuid || `stream_${Date.now()}`;
              const nextMsgId = currentMsgs.some(msg => msg.id === nextMsgIdBase)
                ? `${nextMsgIdBase}_${Date.now()}`
                : nextMsgIdBase;

              setStreamingMessageId(nextMsgId);
              setMessages(prev => {
                const finalized = prev.map(msg =>
                  msg.id === activeStreamingMsg.id ? finalizeStreamingMessage(msg) : msg
                );
                const newMsg: Message = {
                  id: nextMsgId,
                  thread_id: id,
                  role: 'assistant',
                  content: [],
                  created_at: Date.now(),
                  isStreaming: true,
                };
                if (finalized.some(msg => msg.id === nextMsgId)) {
                  return finalized.map(msg =>
                    msg.id === nextMsgId ? applyStreamingEventToMessage(msg, sdkEvent) : msg
                  );
                }
                const withNew = [...finalized, newMsg];
                return withNew.map(msg =>
                  msg.id === nextMsgId ? applyStreamingEventToMessage(msg, sdkEvent) : msg
                );
              });
              return;
            }

            if (existingStreamingMsg) {
              // Claude emits a new message_start after each tool call; append to the active turn.
              setMessages(prev => prev.map(msg =>
                msg.id === existingStreamingId ? applyStreamingEventToMessage(msg, sdkEvent) : msg
              ));
              return;
            }

            if (fallbackStreamingMsg) {
              setStreamingMessageId(fallbackStreamingMsg.id);
              setMessages(prev => prev.map(msg =>
                msg.id === fallbackStreamingMsg.id ? applyStreamingEventToMessage(msg, sdkEvent) : msg
              ));
              return;
            }

            // Add new assistant message with isStreaming: true
            const msgId = evt.message?.id || (sdkEvent as { uuid?: string }).uuid || `stream_${Date.now()}`;
            setStreamingMessageId(msgId);
            const newMsg: Message = {
              id: msgId,
              thread_id: id,
              role: 'assistant',
              content: [],
              created_at: Date.now(),
              isStreaming: true,
            };
            // Use functional update to avoid race conditions with rapid events
            setMessages(prev => {
              if (prev.some(m => m.id === msgId)) {
                return prev;
              }
              return [...prev, newMsg];
            });
          } else if (currentStreamingId) {
            // Apply streaming delta to the current message
            setMessages(prev => prev.map(msg =>
              msg.id === currentStreamingId ? applyStreamingEventToMessage(msg, sdkEvent) : msg
            ));
          } else {
            // No streamingMessageId - try to restore from streaming message (reconnect scenario)
            const currentMessages = messagesRef.current;
            const streamingMsg = currentMessages.find(m => m.isStreaming);
            if (streamingMsg) {
              setStreamingMessageId(streamingMsg.id);
              setMessages(prev => prev.map(msg =>
                msg.id === streamingMsg.id ? applyStreamingEventToMessage(msg, sdkEvent) : msg
              ));
            }
          }
        } else if (sdkEvent.type === 'system' && sdkEvent.subtype === 'init') {
          // System init - reset the streaming message ID
          splitStreamingMessageOnNextPartRef.current = false;
          setStreamingMessageId(null);
          startQueuedManualCompactionIfNeeded();
        } else if (sdkEvent.type === 'system' && sdkEvent.subtype === 'status') {
          const status = (sdkEvent as unknown as Record<string, unknown>).status;
          if (status === 'compacting') {
            isAutoCompactingRef.current = true;
            syncCompactionIndicator();
            const priorId = streamingMessageIdRef.current
              ?? lastCompletedAssistantMessageIdRef.current
              ?? null;
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
        } else if (sdkEvent.type === 'system' && sdkEvent.subtype === 'compact_boundary') {
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
            role: 'user',
            content: 'The conversation context was compacted to continue this session.',
            created_at: Date.now(),
            isCompactSummary: true,
          };
          pendingCompactionPlaceholderIdRef.current = compactMsg.id;
          setMessages(prev => [...prev, compactMsg]);
        } else if (sdkEvent.type === 'assistant' && sdkEvent.message?.content) {
          // Track message ID as fallback
          if (!currentStreamingId) {
            const sdkUuid = (sdkEvent as { uuid?: string }).uuid;
            const sdkMsgId = (sdkEvent.message as { id?: string }).id;
            if (sdkUuid || sdkMsgId) {
              setStreamingMessageId(sdkUuid || sdkMsgId || null);
            }
          }
        } else if (sdkEvent.type === 'user' && sdkEvent.message?.content) {
          // Compact summary — system-generated context recap
          const isCompactSummary = Boolean(
            (sdkEvent as unknown as Record<string, unknown>).isCompactSummary
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
              id: (sdkEvent as { uuid?: string }).uuid || `compact_${Date.now()}`,
              thread_id: id,
              role: 'user',
              content,
              created_at: Date.now(),
              isCompactSummary: true,
            };
            // Replace only the currently tracked provisional compact card
            // with the forwarded full summary.
            setMessages(prev => {
              const existingSummaryIndex = prev.findIndex(m => m.id === compactMsg.id);
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
              const placeholderIndex = prev.findIndex(m => m.id === placeholderId);
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
            contentBlocks.every(block => block?.type === 'tool_result');
          const { sourceToolUseID } = extractToolEventMetaInfo(sdkEvent);

          if (!isToolResultEvent) {
            const shouldBeMeta = true;
            const streamingMessage = streamingMessageIdRef.current
              ? messagesRef.current.find(msg => msg.id === streamingMessageIdRef.current)
              : undefined;
            const fallbackToolUseId = shouldBeMeta && !sourceToolUseID
              ? (getLastToolUseId(streamingMessage) || getLastToolUseIdFromMessages(messagesRef.current))
              : undefined;
            const resolvedToolUseId = sourceToolUseID || fallbackToolUseId;
            const metaMsg: Message = {
              id: `meta_${resolvedToolUseId ?? Date.now()}_${Date.now()}`,
              thread_id: id,
              role: 'user',
              content: contentBlocks,
              created_at: Date.now(),
              isMeta: shouldBeMeta,
              sourceToolUseID: resolvedToolUseId,
            };
            setMessages(prev => [...prev, metaMsg]);
            return;
          }

          const toolResults = contentBlocks.filter(
            (block): block is ToolResultBlock => block?.type === 'tool_result'
          );
          if (toolResults.length === 0) return;
          const toolUseResultPrompt = (() => {
            const toolUseResult = sdkEvent.toolUseResult ?? sdkEvent.tool_use_result;
            return typeof toolUseResult?.prompt === 'string' ? toolUseResult.prompt : undefined;
          })();
          setMessages(prev => attachToolResultsToMessages(prev, toolResults, {
            threadId: id,
            parentToolUseId: sourceToolUseID,
            parentToolPrompt: toolUseResultPrompt,
          }));
        } else if (sdkEvent.type === 'result') {
          // Query complete - mark message as not streaming
          // Finish streaming
          splitStreamingMessageOnNextPartRef.current = false;
          const msgId = streamingMessageIdRef.current;
          lastCompletedAssistantMessageIdRef.current = msgId;
          if (msgId) {
            const parsedResultTimestamp = typeof sdkEvent.timestamp === 'string'
              ? new Date(sdkEvent.timestamp).getTime()
              : NaN;
            const completedAt = Number.isFinite(parsedResultTimestamp)
              ? parsedResultTimestamp
              : Date.now();
            setMessages(prev => prev.map(msg =>
              msg.id === msgId ? { ...finalizeStreamingMessage(msg), created_at: completedAt } : msg
            ));
          }
          setStreamingMessageId(null);
          setLoading(false);
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
      } else if (data.type === 'todo_state') {
        // Direct todo state from server - no extraction needed
        if (Array.isArray(data.todos)) {
          setCurrentTodos(data.todos);
        }
      } else if (data.type === 'context_usage_state') {
        if (data.usedPercent === null) {
          setContextUsedPercent(null);
        } else if (typeof data.usedPercent === 'number' && Number.isFinite(data.usedPercent)) {
          setContextUsedPercent(Math.max(0, Math.min(100, Math.round(data.usedPercent))));
        }
      } else if (data.type === 'ask_user_question') {
        // Claude is asking the user a question
        if (data.questionId && Array.isArray(data.questions)) {
          setPendingQuestion({
            questionId: data.questionId,
            toolUseId: data.toolUseId,
            questions: data.questions,
          });
        }
      } else if (data.type === 'question_answered') {
        // Clear the pending question
        setPendingQuestion((prev) => {
          if (prev?.questionId === data.questionId) {
            return null;
          }
          return prev;
        });
      } else if (data.type === 'streaming_state') {
        setLoading(Boolean(data.isStreaming));
      } else if (data.type === 'error') {
        console.error('WebSocket error:', data.error);
        setError(data.error || 'An unknown error occurred');
        // Finish streaming on error
        splitStreamingMessageOnNextPartRef.current = false;
        const msgId = streamingMessageIdRef.current;
        lastCompletedAssistantMessageIdRef.current = msgId;
        if (msgId) {
          setMessages(prev => prev.map(msg =>
            msg.id === msgId ? finalizeStreamingMessage(msg) : msg
          ));
        }
        setStreamingMessageId(null);
        setLoading(false);
        restorePendingDeliveryDraft();
        isAutoCompactingRef.current = false;
        compactingPriorMessageIdRef.current = null;
        setCompactingPriorMessageId(null);
        clearManualCompactionQueue();
        hasCapturedCompactionSummaryRef.current = false;
      } else if (
        data.type === 'preview_state' ||
        data.type === 'title_updated' ||
        data.type === 'thread_model_updated' ||
        data.type === 'connection_setup_prompt' ||
        data.type === 'bug_report_prompt'
      ) {
        handleRealtimeSideChannelEvent(data);
      }
    };

    ws.onclose = () => {
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

      // Auto-reconnect with exponential backoff
      const maxAttempts = 5;
      if (reconnectAttempts.current < maxAttempts) {
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts.current), 30000);
        reconnectAttempts.current++;
        reconnectTimeoutRef.current = setTimeout(() => {
          // Check again that we haven't been superseded
          if (connectionIdRef.current === thisConnectionId) {
            connectWebSocket(id, true);
          }
        }, delay);
      } else {
        // Reconnect exhausted — clear stale compaction indicator.
        restorePendingDeliveryDraft();
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

  }, [
    clearPendingDeliveryDraft,
    fetchMessages,
    isNewThread,
    persistSessionState,
    resolvedWorkspaceId,
    restorePendingDeliveryDraft,
    setMessages,
    setPendingMessages,
    setStreamingMessageId,
    handleRealtimeSideChannelEvent,
  ]);

  // Keep the ref updated with the latest function
  connectWebSocketRef.current = connectWebSocket;

  // Track which threadId we're connected to
  const connectedThreadIdRef = useRef<string | null>(null);
  const connectedWorkspaceIdRef = useRef<string | null>(null);
  const bumpConnectionId = useCallback(() => {
    connectionIdRef.current += 1;
  }, []);

  // Track previous workspace to detect switches for navigation
  const prevWorkspaceIdRef = useRef<string | undefined>(currentWorkspace?.id);

  // Navigate to /chat when workspace switches while viewing a thread
  // This ensures the user doesn't stay on a thread from a different workspace
  useEffect(() => {
    if (readOnly) return;

    const prevWorkspaceId = prevWorkspaceIdRef.current;
    const nextWorkspaceId = currentWorkspace?.id;

    // Update ref for next comparison
    prevWorkspaceIdRef.current = nextWorkspaceId;

    // Only navigate if:
    // 1. We had a previous workspace (not initial render)
    // 2. Workspace actually changed
    // 3. We're currently viewing a thread
    if (prevWorkspaceId && nextWorkspaceId && prevWorkspaceId !== nextWorkspaceId && threadId) {
      navigate('/chat');
    }
  }, [currentWorkspace?.id, threadId, navigate, readOnly]);

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

      if (historyFetchAbortRef.current) {
        historyFetchAbortRef.current.abort();
        historyFetchAbortRef.current = null;
      }

      clearAllIframeRefreshTimeouts();
    };
  }, [bumpConnectionId, clearAllIframeRefreshTimeouts]);

  // Check if we should show the chat UI
  const shouldShowChat = Boolean(threadId);
  const lastMessage = visibleMessages[visibleMessages.length - 1];
  const isLastMessageAssistantLike = isAssistantLikeMessage(lastMessage);
  const showAssistantTail = loading || isStreaming;
  const isAwaitingAssistant = showAssistantTail && Boolean(lastMessage) && !isLastMessageAssistantLike;
  const lastUserMessage = useMemo(() => {
    for (let i = visibleMessages.length - 1; i >= 0; i -= 1) {
      if (isUserTurnAnchorMessage(visibleMessages[i])) return visibleMessages[i];
    }
    return null;
  }, [visibleMessages]);
  const shouldRenderSpacer = Boolean(lastUserMessage) &&
    !lastUserMessage?.sentDuringStreaming &&
    !error &&
    (isAwaitingAssistant || isLastMessageAssistantLike);

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
    const threadChanged = connectedThreadIdRef.current && connectedThreadIdRef.current !== threadId;
    const workspaceChanged = connectedWorkspaceIdRef.current && connectedWorkspaceIdRef.current !== nextWorkspaceId;

    // Already connected to this thread+workspace? Nothing to do.
    if (connectedThreadIdRef.current === threadId && connectedWorkspaceIdRef.current === nextWorkspaceId) {
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
  }, [threadId, shouldShowChat, resolvedWorkspaceId, readOnly]);

  // Ensure existing threads hydrate full history once initial route loading
  // settles. Without this fallback, the connect path can skip fetch while
  // `isLoadingMessages` is true and never retry.
  useEffect(() => {
    if (!threadId || !resolvedWorkspaceId || isNewThread || isLoadingMessages) {
      return;
    }
    if (historyFetchAbortRef.current) {
      return;
    }
    if (pendingMessagesRef.current.length > 0) {
      return;
    }
    if (messagesRef.current.length > 0) {
      return;
    }
    void fetchMessages(threadId);
  }, [
    fetchMessages,
    isLoadingMessages,
    isNewThread,
    resolvedWorkspaceId,
    threadId,
  ]);

  // Reconnect on visibility change (tab becomes visible)
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (readOnly) return;
      if (document.visibilityState === 'visible' && shouldShowChat && resolvedWorkspaceId) {
        // Check if main WebSocket is dead
        const needsReconnect = !wsRef.current ||
          wsRef.current.readyState === WebSocket.CLOSED ||
          wsRef.current.readyState === WebSocket.CLOSING;

        if (needsReconnect && threadId) {
          // Clear any stale reconnect timeout from before tab suspension
          // (Safari suspends JS in background tabs, so pending timeouts are stale)
          if (reconnectTimeoutRef.current) {
            clearTimeout(reconnectTimeoutRef.current);
            reconnectTimeoutRef.current = null;
          }
          reconnectAttempts.current = 0; // Fresh start when user returns to tab
          connectWebSocketRef.current?.(threadId, true);
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [threadId, shouldShowChat, resolvedWorkspaceId, readOnly]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const container = scrollContainerRef.current;
    if (container) {
      if (behavior === 'auto') {
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
        messagesEndRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
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
      const target = container?.querySelector(`[data-message-id="${lastMessage.id}"]`) as HTMLElement | null;
      if (target) {
        target.scrollIntoView({ behavior: 'auto', block: 'end' });
      } else {
        scrollToBottom('auto');
      }
    } else {
      scrollToBottom('auto');
    }
    setShowScrollButton(false);
    initialScrollDoneRef.current = true;
  }, [shouldShowChat, threadId, visibleMessages.length, scrollToBottom, shouldAnchorToLastMessage, lastMessage, lastMessage?.id]);

  useLayoutEffect(() => {
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

      // Need at least a user message to calculate spacer
      if (!measureUser) {
        spacer.style.height = '0px';
        return;
      }

      const containerRect = container.getBoundingClientRect();
      const userRect = measureUser.getBoundingClientRect();
      const userStyle = getComputedStyle(measureUser);
      const userMarginTopValue = parseFloat(userStyle.marginTop || '0');
      const userMarginTop = Number.isNaN(userMarginTopValue) ? 0 : userMarginTopValue;

      let exchangeHeight: number;

      if (measureAssistant) {
        // Assistant message exists - calculate exchange height including both messages
        const assistantRect = measureAssistant.getBoundingClientRect();
        const assistantStyle = getComputedStyle(measureAssistant);
        const assistantMarginBottomValue = parseFloat(assistantStyle.marginBottom || '0');
        const assistantMarginBottom = Number.isNaN(assistantMarginBottomValue) ? 0 : assistantMarginBottomValue;
        const exchangeTop = userRect.top - userMarginTop;
        const exchangeBottom = assistantRect.bottom + assistantMarginBottom;
        exchangeHeight = Math.max(exchangeBottom - exchangeTop, 0);
      } else if (measurePendingAssistant) {
        // No assistant message yet; include pending assistant placeholder
        // (e.g. loading dots / compacting indicator) in the measured exchange.
        const pendingRect = measurePendingAssistant.getBoundingClientRect();
        const pendingStyle = getComputedStyle(measurePendingAssistant);
        const pendingMarginBottomValue = parseFloat(pendingStyle.marginBottom || '0');
        const pendingMarginBottom = Number.isNaN(pendingMarginBottomValue) ? 0 : pendingMarginBottomValue;
        const exchangeTop = userRect.top - userMarginTop;
        const exchangeBottom = pendingRect.bottom + pendingMarginBottom;
        exchangeHeight = Math.max(exchangeBottom - exchangeTop, 0);
      } else {
        // No assistant message yet (awaiting response) - just use user message height
        const userMarginBottomValue = parseFloat(userStyle.marginBottom || '0');
        const userMarginBottom = Number.isNaN(userMarginBottomValue) ? 0 : userMarginBottomValue;
        exchangeHeight = userRect.height + userMarginTop + userMarginBottom;
      }

      const column = messageColumnRef.current;
      const columnStyle = column ? getComputedStyle(column) : null;
      const gapValue = columnStyle ? parseFloat(columnStyle.rowGap || '0') : 0;
      const rowGap = Number.isNaN(gapValue) ? 0 : gapValue;
      const paddingBottomValue = columnStyle ? parseFloat(columnStyle.paddingBottom || '0') : 0;
      const paddingBottom = Number.isNaN(paddingBottomValue) ? 0 : paddingBottomValue;

      const header = document.querySelector('header');
      const headerRect = header ? header.getBoundingClientRect() : null;
      const overlap = headerRect ? Math.max(0, headerRect.bottom - containerRect.top) : 0;
      const availableHeight = container.clientHeight - overlap;

      const height = Math.max(availableHeight - exchangeHeight - rowGap - paddingBottom, 0);
      const nextHeight = Math.max(Math.round(height), 0);
      if (spacerHeightRef.current !== nextHeight) {
        spacer.style.height = `${nextHeight}px`;
        spacerHeightRef.current = nextHeight;
      }
    };

    updateSpacer();

    if (typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(() => {
      updateSpacer();
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
      observer.disconnect();
    };
  }, [shouldRenderSpacer, isAwaitingAssistant, lastMessage?.id, lastUserMessage?.id, visibleMessages.length, isStreaming, loading]);

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
    if (!column || typeof ResizeObserver === 'undefined') return;

    let frameId: number | null = null;
    const observer = new ResizeObserver(() => {
      if (!stickToBottomRef.current) return;
      if (shouldRenderSpacer && spacerHeightRef.current > 0) return;
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
      }
      frameId = requestAnimationFrame(() => {
        scrollToBottom('auto');
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

    if (!initialScrollDoneRef.current && visibleMessages.length > 0) {
      initialScrollDoneRef.current = true;
      scrollToBottom('auto');
      setShowScrollButton(false);
      return;
    }

    const shouldForce = forceScrollOnNextUpdate.current;
    forceScrollOnNextUpdate.current = false;

    const container = scrollContainerRef.current;
    if (!container) {
      scrollToBottom('smooth');
      return;
    }

    const { scrollTop, scrollHeight, clientHeight } = container;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;

    // Always scroll when user sends a message, or if near bottom during streaming
    if (shouldForce || stickToBottomRef.current || distanceFromBottom < 150) {
      scrollToBottom('smooth');
    }
  }, [visibleMessages, scrollToBottom, shouldShowChat, threadId]);

  const copyMessage = useCallback(async (messageId: string, content: string) => {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedMessageId(messageId);
      setTimeout(() => setCopiedMessageId(null), 2000);
    } catch (err) {
      console.error('Failed to copy message:', err);
    }
  }, []);

  const handleFilesSelected = useCallback(async (files: File[]) => {
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
      setAttachments(prev => [...prev, {
        id,
        name: file.name,
        path: '',
        size: file.size,
        contentType: file.type || undefined,
        originalName: file.name,
        status: 'uploading',
        progress: 0,
        previewUrl,
      }]);

      try {
        const data = await uploadWorkspaceFile(resolvedWorkspaceId, file, {
          onProgress: (progressPercent) => {
            setAttachments(prev => prev.map(a =>
              a.id === id
                ? { ...a, progress: progressPercent }
                : a
            ));
          },
        });

        // Update state to complete
        setAttachments(prev => prev.map(a =>
          a.id === id
            ? {
              ...a,
              path: data.path,
              size: data.size,
              contentType: data.contentType ?? a.contentType,
              originalName: data.originalName ?? a.originalName,
              status: 'complete' as const,
              progress: 100,
            }
            : a
        ));
      } catch (err) {
        console.error('File upload failed:', err);
        const errorMessage = err instanceof Error ? err.message : 'Upload failed';
        // Update state to error
        setAttachments(prev => prev.map(a =>
          a.id === id
            ? { ...a, status: 'error' as const, error: errorMessage, progress: undefined }
            : a
        ));
      }
    }
  }, [resolvedWorkspaceId]);

  const handleAttachmentRemove = useCallback((id: string) => {
    setAttachments(prev => {
      const removed = prev.find(a => a.id === id);
      revokeAttachmentPreviewUrl(removed?.previewUrl);
      return prev.filter(a => a.id !== id);
    });
  }, [revokeAttachmentPreviewUrl]);

  // Drag-drop handlers for the whole chat area
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (resolvedWorkspaceId) {
      setIsDragOver(true);
    }
  }, [resolvedWorkspaceId]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
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

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);

    if (!resolvedWorkspaceId) return;

    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      handleFilesSelected(Array.from(files));
    }
  }, [resolvedWorkspaceId, handleFilesSelected]);

  // Track pending message for new thread creation (used by effect that handles fetcher response)
  const pendingNewChatRef = useRef<{
    finalContent: string;
    threadTitle?: string;
    threadModel: LlmModel;
    draftText?: string;
    draftAttachments?: Attachment[];
  } | null>(null);

  // Handle fetcher response for thread creation
  useEffect(() => {
    if (createThreadFetcher.state === 'idle' && createThreadFetcher.data) {
      const data = createThreadFetcher.data;
      if (data.thread && pendingNewChatRef.current) {
        // Thread created successfully - store message and navigate
        const { finalContent, threadTitle, draftText, draftAttachments } = pendingNewChatRef.current;
        const messageWithContext = finalContent;

        pendingDeliveryDraftRef.current = null;
        pendingDraftCountRef.current = 0;
        if (resolvedWorkspaceId && draftText !== undefined && draftAttachments) {
          writeDraft(resolvedWorkspaceId, data.thread.id, draftText, draftAttachments);
          pendingDraftCountRef.current = 1;
          pendingDeliveryDraftRef.current = {
            workspaceId: resolvedWorkspaceId,
            threadId: data.thread.id,
          };
          if (isComposerVisiblyEmpty(welcomeInputRef.current, attachmentsRef.current)) {
            removeDraft(resolvedWorkspaceId, null);
          }
        }

        if (messageWithContext.trim().length > 0) {
          sessionStorage.setItem(
            pendingMessageKey,
            JSON.stringify({
              message: messageWithContext,
              threadId: data.thread.id,
              threadTitle,
              threadModel: data.thread.model,
              threadProvider: data.thread.provider,
              workspaceId: resolvedWorkspaceId,
              orgSlug: currentOrg?.slug,
            })
          );
          navigate(`/chat/${data.thread.id}?newThread=1`);
        } else {
          navigate(`/chat/${data.thread.id}`);
        }
        pendingNewChatRef.current = null;
      } else if (data.error) {
        // Thread creation failed
        sessionStorage.removeItem(pendingMessageKey);
        setIsCreatingThread(false);
        setError('Failed to start a new chat');
        const pendingDraft = pendingDeliveryDraftRef.current;
        pendingDeliveryDraftRef.current = null;
        pendingDraftCountRef.current = 0;
        if (
          pendingDraft &&
          isComposerVisiblyEmpty(welcomeInputRef.current, attachmentsRef.current)
        ) {
          const savedDraft = loadDraft(pendingDraft.workspaceId, pendingDraft.threadId);
          if (savedDraft) {
            setWelcomeInput(savedDraft.text);
            setAttachments(savedDraft.attachments);
          }
        }
        console.error('Failed to create thread:', data.error);
        pendingNewChatRef.current = null;
      }
    }
  }, [createThreadFetcher.state, createThreadFetcher.data, navigate, resolvedWorkspaceId, currentOrg]);

  useEffect(() => {
    if (updateThreadModelFetcher.state !== 'idle' || !updateThreadModelFetcher.data) return;
    if (updateThreadModelFetcher.data.error) {
      setSelectedThreadModel(threadModel ?? getDefaultLlmModel(resolvedThreadProvider));
      toast.error(updateThreadModelFetcher.data.error);
      return;
    }
    if (updateThreadModelFetcher.data.thread?.model) {
      setSelectedThreadModel(updateThreadModelFetcher.data.thread.model);
      revalidator.revalidate();
    }
  }, [revalidator, resolvedThreadProvider, threadModel, updateThreadModelFetcher.state, updateThreadModelFetcher.data]);

  const handleThreadModelChange = useCallback((nextModel: LlmModel) => {
    if (!threadId) {
      setSelectedThreadModel(nextModel);
      return;
    }
    if (nextModel !== selectedThreadModel) {
      toast.error(THREAD_MODEL_LOCK_MESSAGE);
    }
    setSelectedThreadModel(threadModel ?? getDefaultLlmModel(resolvedThreadProvider));
  }, [resolvedThreadProvider, selectedThreadModel, threadId, threadModel]);

  const handleStartChatForApp = useCallback((app: WorkerScriptWithCreator) => {
    if (!resolvedWorkspaceId) {
      toast.error('No workspace selected');
      return;
    }

    if (app.workspace_id !== resolvedWorkspaceId) {
      toast.error('App is in a different workspace. Please switch workspaces first.');
      return;
    }

    if (createThreadFetcher.state !== 'idle' || isCreatingThread) return;

    setIsCreatingThread(true);

    // Build the camelai system message
    const appUrl = getAppUrl(app.script_name, hostname, orgSlug);
    const sourceInfo = app.config_path
      ? ` The app's wrangler config is at "${app.config_path}".`
      : ` The project location is unknown - search for it in the home folder. The project may have a different name than the app, and look for either wrangler.toml or wrangler.jsonc files.`;
    const systemMessage = `<camelai system message>I'd like to work on the app "${app.script_name}" at ${appUrl}.${sourceInfo}</camelai system message>`;
    const threadTitle = buildAppThreadFallbackTitle(app.script_name);

    // Store pending message for the createThreadFetcher effect
    pendingNewChatRef.current = {
      finalContent: systemMessage,
      threadTitle,
      threadModel: selectedThreadModel,
    };

    // Create thread with preview settings
    createThreadFetcher.submit(
      {
        intent: 'createThread',
        initialTitle: threadTitle,
        previewApps: app.script_name,
        model: selectedThreadModel,
      },
      { method: 'post', action: '/chat' }
    );
  }, [hostname, orgSlug, resolvedWorkspaceId, createThreadFetcher, isCreatingThread, selectedThreadModel]);

  function startNewChat() {
    const currentWelcomeInput = welcomeInputRef.current;
    const currentAttachments = attachmentsRef.current;

    if (
      !currentWelcomeInput.trim() ||
      isCreatingThread ||
      !resolvedWorkspaceId ||
      createThreadFetcher.state !== 'idle'
    ) return;

    // Don't allow sending while uploads are in progress
    const hasUploadingAttachments = currentAttachments.some(a => a.status === 'uploading');
    if (hasUploadingAttachments) return;

    const messageCount = incrementFreeTierCount(user?.id ?? undefined);
    if (messageCount === 3 && !showFreeTierModal) {
      setShowFreeTierModal(true);
    }

    preserveDraftBeforeOptimisticClear(null, currentWelcomeInput, currentAttachments);
    setIsCreatingThread(true);
    const userMessage = currentWelcomeInput.trim();
    setWelcomeInput('');

    // Build message content with file references appended
    const completedAttachments = currentAttachments.filter(a => a.status === 'complete');
    let finalContent = userMessage;
    if (completedAttachments.length > 0) {
      const fileRefs = completedAttachments
        .map(a => `(user uploaded file to ${a.path})`)
        .join('\n');
      finalContent = `${userMessage}\n\n${fileRefs}`;
    }

    // Clear attachments (revoke any blob URLs to avoid memory leaks)
    setAttachments(prev => {
      for (const a of prev) {
        revokeAttachmentPreviewUrl(a.previewUrl);
      }
      return [];
    });

    // Store pending message info for the effect to use after thread creation
    pendingNewChatRef.current = {
      finalContent,
      threadModel: selectedThreadModel,
      draftText: currentWelcomeInput,
      draftAttachments: currentAttachments,
    };

    // Submit to route action to create thread
    createThreadFetcher.submit(
      { intent: 'createThread', firstMessage: userMessage, model: selectedThreadModel },
      { method: 'post', action: '/chat' }
    );
  }

  function stopGeneration() {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      return;
    }
    wsRef.current.send(JSON.stringify({ type: 'stop' }));
  }

  const handleQuestionResponse = useCallback((answers: Record<string, string>) => {
    if (!pendingQuestion || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      return;
    }

    wsRef.current.send(JSON.stringify({
      type: 'question_response',
      questionId: pendingQuestion.questionId,
      answers,
    }));

    // Optimistically clear the question
    setPendingQuestion(null);

    window.setTimeout(() => composerTextareaRef.current?.focus(), 0);
  }, [pendingQuestion]);

  // Handle connection setup response - send via chat WebSocket
  const handleConnectionSetupResponse = useCallback((response: ConnectionSetupResponse) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      console.error('[Chat] WebSocket not available for connection setup response');
      return;
    }

    wsRef.current.send(JSON.stringify({
      type: 'connection_setup_response',
      ...response,
    }));

    // Clear the prompt
    setConnectionSetupPrompt(null);
  }, []);

  const handleConnectionSetupCancel = useCallback(() => {
    setConnectionSetupPrompt(null);
  }, []);

  // Handle bug report dialog open/close - sends cancellation if MCP-triggered
  const handleBugReportOpenChange = useCallback((open: boolean) => {
    if (!open && mcpBugReportPrompt) {
      // User closed the dialog while MCP capture was pending - send cancellation
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          type: 'bug_report_response',
          requestId: mcpBugReportPrompt.requestId,
          cancelled: true,
        }));
      }
      setMcpBugReportPrompt(null);
    }
    setBugReportOpen(open);
  }, [mcpBugReportPrompt]);

  // Bug report submission
  const submitBugReport = useCallback(async (report: { description: string }) => {
    if (!deployedApp || !resolvedWorkspaceId || !threadId) return;

    // Check if this is an MCP-triggered capture
    const isMcpTriggered = !!mcpBugReportPrompt;
    const mcpRequestId = mcpBugReportPrompt?.requestId;

    // Only update UI status for manual (non-MCP) captures
    if (!isMcpTriggered) {
      setBugReportStatus('capturing');
      setBugReportError(null);
    }

    // Generate unique request ID
    const requestId = `bug_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

    // Set up response listener with timeout (10s to allow for screenshot capture)
    const debugDataPromise = new Promise<{
      domSnapshot: string;
      pageState: { url: string; scrollX: number; scrollY: number; viewportWidth?: number; viewportHeight?: number; documentTitle?: string };
      consoleLogs: Array<{ level: string; timestamp: number; deltaMs: number; sinceStartMs: number; args: string[] }>;
      networkRequests: Array<{ type: string; method: string; url: string; status: number; statusText: string; ok: boolean; failed?: boolean; error?: string; timestamp: number; durationMs: number }>;
      storage: { localStorage: Record<string, string | null>; sessionStorage: Record<string, string | null> };
      screenshot: string | null;
      sessionRecording: { events: unknown[]; durationMs: number; eventCount: number } | null;
      capturedAt: number;
      sessionDurationMs: number;
    } | null>((resolve) => {
      const timeout = setTimeout(() => {
        window.removeEventListener('message', handler);
        resolve(null);
      }, 10000);

      function handler(event: MessageEvent) {
        if (
          event.data?.type === 'chiridion:bug-report-response' &&
          event.data?.requestId === requestId
        ) {
          clearTimeout(timeout);
          window.removeEventListener('message', handler);
          if (event.data.success) {
            resolve(event.data.data);
          } else {
            resolve(null);
          }
        }
      }

      window.addEventListener('message', handler);
    });

    // Send request to iframe
    if (iframeRef.current?.contentWindow) {
      iframeRef.current.contentWindow.postMessage(
        { type: 'chiridion:bug-report-request', requestId },
        '*'
      );
    }

    // Wait for response
    const debugData = await debugDataPromise;

    // Upload to R2
    if (!isMcpTriggered) {
      setBugReportStatus('uploading');
    }
    try {
      const reportId = `bug-report-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
      let screenshotPath: string | null = null;
      let sessionRecordingPath: string | null = null;

      // Upload screenshot as separate image file if available
      if (debugData?.screenshot) {
        const base64Data = debugData.screenshot.split(',')[1];
        const binaryData = atob(base64Data);
        const bytes = new Uint8Array(binaryData.length);
        for (let i = 0; i < binaryData.length; i++) {
          bytes[i] = binaryData.charCodeAt(i);
        }
        const screenshotBlob = new Blob([bytes], { type: 'image/jpeg' });
        const screenshotFile = new File([screenshotBlob], `${reportId}-screenshot.jpg`, { type: 'image/jpeg' });
        try {
          const screenshotData = await uploadWorkspaceFile(resolvedWorkspaceId, screenshotFile);
          screenshotPath = screenshotData.path;
        } catch (uploadError) {
          console.error('Failed to upload bug report screenshot:', uploadError);
        }
      }

      // Upload session recording as separate JSON file if available
      if (debugData?.sessionRecording && debugData.sessionRecording.events.length > 0) {
        const recordingBlob = new Blob(
          [JSON.stringify(debugData.sessionRecording, null, 2)],
          { type: 'application/json' }
        );
        const recordingFile = new File([recordingBlob], `${reportId}-session.json`, { type: 'application/json' });
        try {
          const recordingData = await uploadWorkspaceFile(resolvedWorkspaceId, recordingFile);
          sessionRecordingPath = recordingData.path;
        } catch (uploadError) {
          console.error('Failed to upload bug report recording:', uploadError);
        }
      }

      // Create bug report bundle (without large data, using file references)
      const vanityHost = orgSlug
        ? `${buildAppLabel(deployedApp, orgSlug)}.${getVanityDomain(hostname)}`
        : `${deployedApp}.${getVanityDomain(hostname)}`;
      const vanityUrl = `https://${vanityHost}`;
      const debugDataClean = debugData ? {
        ...debugData,
        screenshot: undefined, // Remove base64 from JSON
        screenshotPath, // Add file path reference
        sessionRecording: debugData.sessionRecording ? {
          durationMs: debugData.sessionRecording.durationMs,
          eventCount: debugData.sessionRecording.eventCount,
          events: undefined, // Remove events array from main JSON
        } : null,
        sessionRecordingPath, // Add file path reference
      } : null;

      const bugReport = {
        version: 1,
        createdAt: new Date().toISOString(),
        appName: deployedApp,
        appUrl: vanityUrl,
        userReport: {
          description: report.description,
        },
        debugData: debugDataClean,
      };

      const fileName = `${reportId}.json`;
      const blob = new Blob([JSON.stringify(bugReport, null, 2)], { type: 'application/json' });
      const file = new File([blob], fileName, { type: 'application/json' });
      const uploadData = await uploadWorkspaceFile(resolvedWorkspaceId, file);

      if (!isMcpTriggered) {
        setBugReportStatus('sending');
      }

      // If this is an MCP-triggered capture, send response via chat WebSocket
      if (isMcpTriggered && mcpRequestId && wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          type: 'bug_report_response',
          requestId: mcpRequestId,
          cancelled: false,
          bugReport: {
            reportPath: uploadData.path,
            screenshotPath,
            sessionRecordingPath,
            appName: deployedApp,
            appUrl: vanityUrl,
            userDescription: report.description.trim() || undefined,
          },
        }));

        // Clear the MCP prompt (no dialog to close)
        setMcpBugReportPrompt(null);
      } else {
        // Manual bug report - send message to agent
        const description = report.description.trim();
        const agentMessage = description
          ? `I found a bug in the deployed app "${deployedApp}".

**Description:** ${description}

I've captured a debug report with the DOM snapshot and console logs. Please investigate and fix this bug.

(bug report: ${uploadData.path})`
          : `I found a bug in the deployed app "${deployedApp}".

I've captured a debug report with the DOM snapshot and console logs. Please investigate and fix this bug.

(bug report: ${uploadData.path})`;

        const userMsg: Message = {
          id: `local_${Date.now()}`,
          thread_id: threadId,
          role: 'user',
          content: agentMessage,
          created_at: Date.now(),
        };
        forceScrollOnNextUpdate.current = true;
        setMessages(prev => [...prev, userMsg]);

        // Send via WebSocket if connected
        if (wsRef.current?.readyState === WebSocket.OPEN && ready) {
          wsRef.current.send(JSON.stringify({
            type: 'message',
            content: agentMessage,
            sessionId: sessionIdRef.current,
            threadId,
          }));
          setLoading(true);
        } else {
          // Queue the message
          setPendingMessages(prev => [...prev, userMsg]);
          setLoading(true);

          // Trigger reconnect if needed
          if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
            connectWebSocketRef.current?.(threadId, true);
          }
        }

        setBugReportStatus('done');
        setTimeout(() => {
          setBugReportOpen(false);
          setBugReportStatus('idle');
        }, 1000);
      }
    } catch (e) {
      console.error('Bug report submission failed:', e);

      // If MCP-triggered, send cancellation response
      if (isMcpTriggered && mcpRequestId && wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          type: 'bug_report_response',
          requestId: mcpRequestId,
          cancelled: true,
        }));
        setMcpBugReportPrompt(null);
      } else {
        // Only update UI status for manual captures
        setBugReportStatus('error');
        setBugReportError(e instanceof Error ? e.message : 'Failed to submit bug report');
      }
    }
  }, [deployedApp, resolvedWorkspaceId, threadId, hostname, ready, setLoading, setPendingMessages, setMessages, mcpBugReportPrompt]);

  // Auto-capture when MCP triggers bug report (no dialog needed)
  useEffect(() => {
    if (mcpBugReportPrompt && deployedApp && resolvedWorkspaceId && threadId) {
      // Trigger the capture automatically without showing dialog
      submitBugReport({ description: '' });
    }
  }, [mcpBugReportPrompt, deployedApp, resolvedWorkspaceId, threadId, submitBugReport]);

  const resetPreviewTabsState = useCallback(() => {
    setLocalPreviewSessionState([], null);
    setTabIframeKeys({});
    setTabFilePreviewKeys({});
    setTabNotebookViewModes({});
    setTabMarkdownViewModes({});
    setTabAppLoading({});
    clearAllIframeRefreshTimeouts();
  }, [setLocalPreviewSessionState, clearAllIframeRefreshTimeouts]);

  const setPreviewTargetForThread = useCallback((target: PreviewTarget | null) => {
    if (!threadId) return;

    if (readOnly) {
      if (target === null) {
        resetPreviewTabsState();
        setMobileView('chat');
        return;
      }
      openTabForTarget(target, { sync: false });
      return;
    }

    const socket = wsRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      if (target === null) {
        resetPreviewTabsState();
        setMobileView('chat');
        return;
      }
      toast.error('Preview is unavailable while reconnecting.');
      return;
    }

    if (target === null) {
      resetPreviewTabsState();
      syncPreviewTabsStateBestEffort([], null);
      setMobileView('chat');
      return;
    }

    openTabForTarget(target, { sync: true });
  }, [
    threadId,
    readOnly,
    resetPreviewTabsState,
    openTabForTarget,
    syncPreviewTabsStateBestEffort,
  ]);

  const openPreviewTarget = useCallback((target: PreviewTarget) => {
    setPreviewTargetForThread(target);
    setMobileView('preview');
  }, [setPreviewTargetForThread]);

  const clearPreviewTarget = useCallback(() => {
    setPreviewTargetForThread(null);
  }, [setPreviewTargetForThread]);

  type SendOptions = {
    contentOverride?: string;
    preserveDraft?: boolean;
    skipAttachmentRefs?: boolean;
  };

  function sendMessage(opts?: SendOptions) {
    if (readOnly) {
      return;
    }
    const currentInput = inputRef.current;
    const currentAttachments = attachmentsRef.current;
    const rawContent = (opts?.contentOverride ?? currentInput).trim();
    if (
      isLoadingMessages ||
      !rawContent ||
      !shouldShowChat ||
      !resolvedWorkspaceId ||
      !threadId
    ) {
      return;
    }

    const wasSentDuringStreaming = isStreaming;

    // Mark that user has interacted - prevents loader sync from overwriting streaming state
    hasHadUserInteraction.current = true;

    if (!opts?.contentOverride) {
      const messageCount = incrementFreeTierCount(user?.id ?? undefined);
      if (messageCount === 3 && !showFreeTierModal) {
        setShowFreeTierModal(true);
      }
    }

    if (!opts?.preserveDraft && !opts?.contentOverride) {
      preserveDraftBeforeOptimisticClear(threadId, currentInput, currentAttachments);
      setInput('');
    }

    const shouldIncludeAttachmentRefs = !opts?.skipAttachmentRefs && !opts?.contentOverride;
    let finalContent = rawContent;
    if (shouldIncludeAttachmentRefs) {
      const completedAttachments = currentAttachments.filter(a => a.status === 'complete');
      if (completedAttachments.length > 0) {
        const fileRefs = completedAttachments
          .map(a => `(user uploaded file to ${a.path})`)
          .join('\n');
        finalContent = `${rawContent}\n\n${fileRefs}`;
      }
    }

    const shouldShowCompactingIndicator = isManualCompactCommand(finalContent);

    if (shouldShowCompactingIndicator) {
      queueManualCompaction();
    }

    if (shouldIncludeAttachmentRefs) {
      // Clear attachments after building message (revoke any blob URLs to avoid memory leaks)
      setAttachments(prev => {
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
      id: `local_${Date.now()}`,
      thread_id: threadId,
      role: 'user',
      content: finalContent,
      created_at: Date.now(),
      sentDuringStreaming: wasSentDuringStreaming,
    };

    // If user sends mid-stream, keep current part streaming and split at next message_start.
    if (wasSentDuringStreaming) {
      splitStreamingMessageOnNextPartRef.current = true;
      setMessages(prev => [...prev, userMsg]);
    } else {
      lastCompletedAssistantMessageIdRef.current = null;
      // /compact is operational and can happen while users read older messages.
      // Avoid forcing a jump to bottom in that case.
      forceScrollOnNextUpdate.current = !shouldShowCompactingIndicator;
      setMessages(prev => [...prev, userMsg]);
    }

    // If WebSocket is connected and ready, send immediately
    if (wsRef.current?.readyState === WebSocket.OPEN && ready) {
      setLoading(true);
      wsRef.current.send(JSON.stringify({
        type: 'message',
        content: finalContent,
        sessionId: sessionIdRef.current,
        threadId,
      }));
    } else {
      // Queue the full message object for later delivery (with file refs in content)
      const queuedMsg: Message = { ...userMsg, content: finalContent };
      setPendingMessages(prev => [...prev, queuedMsg]);
      setLoading(true);

      // If not connected at all, trigger reconnect
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        connectWebSocketRef.current?.(threadId, true);
      }
      // If connected but not ready, the message will be sent when ready event arrives
    }
  }

  const sendMessageRef = useRef(sendMessage);
  sendMessageRef.current = sendMessage;

  const handleCompactFromIndicator = useCallback(() => {
    if (loading || isStreaming || isCompacting || readOnly) return;
    sendMessageRef.current({
      contentOverride: '/compact',
      preserveDraft: true,
      skipAttachmentRefs: true,
    });
  }, [loading, isStreaming, isCompacting, readOnly]);

  const chatBreadcrumbs = [
    { label: 'Chat' },
    { label: currentTitle?.trim() || 'Untitled Chat' },
  ];

  const encodePathSegments = useCallback((path: string) => {
    return path
      .split('/')
      .map(segment => encodeURIComponent(segment))
      .join('/');
  }, []);

  // Per-tab render state for all open tabs. Kept in the DOM simultaneously so
  // switching between tabs never reloads iframes or file previews.
  const tabRenderStates = useMemo((): TabRenderState[] => {
    return previewTabs.map((tab) => {
      const target = tab.target;
      const tabId = tab.id;

      if (target.kind === 'app') {
        const scriptName = target.scriptName;
        const iframeHost = orgSlug
          ? `${buildAppLabel(scriptName, orgSlug)}.${getIframeDomain(hostname)}`
          : `${scriptName}.${getIframeDomain(hostname)}`;
        const vHost = orgSlug
          ? `${buildAppLabel(scriptName, orgSlug)}.${getVanityDomain(hostname)}`
          : `${scriptName}.${getVanityDomain(hostname)}`;
        return {
          tabId,
          target,
          appPreviewUrl: `https://${iframeHost}`,
          vanityHost: vHost,
          iframeKey: tabIframeKeys[tabId] ?? 0,
          isLoading: tabAppLoading[tabId] ?? false,
          filePreviewUrl: '',
          filePreviewOpenUrl: '',
          previewFileName: '',
          notebookViewMode: 'report',
          markdownViewMode: 'rendered',
          isNotebookPreview: false,
          isMarkdownPreview: false,
        };
      }

      // File tab
      const normalizedPath = target.path.replace(/^\/+/, '');
      const encodedPath = encodePathSegments(normalizedPath);
      const route = target.source === 'workspace'
        ? `fs/content/${encodedPath}`
        : `${target.source === 'upload' ? 'uploads' : 'outputs'}/${encodedPath}`;
      const fileKey = tabFilePreviewKeys[tabId] ?? 0;
      const filename = target.filename || target.path.split('/').filter(Boolean).pop() || 'file';
      const isNotebook = filename.toLowerCase().endsWith('.ipynb');
      const isMarkdown = filename.toLowerCase().endsWith('.md');
      return {
        tabId,
        target,
        appPreviewUrl: '',
        vanityHost: '',
        iframeKey: 0,
        isLoading: false,
        filePreviewUrl: `/api/workspaces/${target.workspaceId}/${route}?v=${fileKey}`,
        filePreviewOpenUrl: `/api/workspaces/${target.workspaceId}/${route}`,
        previewFileName: filename,
        notebookViewMode: tabNotebookViewModes[tabId] ?? 'report',
        markdownViewMode: tabMarkdownViewModes[tabId] ?? 'rendered',
        isNotebookPreview: isNotebook,
        isMarkdownPreview: isMarkdown,
      };
    });
  }, [
    previewTabs,
    tabIframeKeys,
    tabAppLoading,
    tabFilePreviewKeys,
    tabNotebookViewModes,
    tabMarkdownViewModes,
    hostname,
    orgSlug,
    encodePathSegments,
  ]);

  const previewDomains = useMemo(() => {
    if (previewTarget?.kind !== 'app') {
      return { iframeHost: '', vanityHost: '' };
    }
    const scriptName = previewTarget.scriptName;
    if (orgSlug) {
      return {
        iframeHost: `${buildAppLabel(scriptName, orgSlug)}.${getIframeDomain(hostname)}`,
        vanityHost: `${buildAppLabel(scriptName, orgSlug)}.${getVanityDomain(hostname)}`,
      };
    }
    // Legacy format without org slug
    return {
      iframeHost: `${scriptName}.${getIframeDomain(hostname)}`,
      vanityHost: `${scriptName}.${getVanityDomain(hostname)}`,
    };
  }, [previewTarget, hostname, orgSlug]);
  const appPreviewVanityUrl = previewDomains.vanityHost ? `https://${previewDomains.vanityHost}` : '';

  const filePreviewOpenUrl = useMemo(() => {
    if (previewTarget?.kind !== 'file') return '';
    const normalizedPath = previewTarget.path.replace(/^\/+/, '');
    const encodedPath = encodePathSegments(normalizedPath);
    const route = previewTarget.source === 'workspace'
      ? `fs/content/${encodedPath}`
      : `${previewTarget.source === 'upload' ? 'uploads' : 'outputs'}/${encodedPath}`;
    return `/api/workspaces/${previewTarget.workspaceId}/${route}`;
  }, [previewTarget, encodePathSegments]);

  const fileExternalOpenUrl = useMemo(() => {
    if (previewTarget?.kind !== 'file') return '';
    if (previewTarget.source === 'workspace') {
      const query = new URLSearchParams();
      query.set('file', previewTarget.path);
      if (readOnly) {
        query.set('adminReadonly', '1');
      }
      return `/computer/${previewTarget.workspaceId}?${query.toString()}`;
    }
    const normalizedPath = previewTarget.path.replace(/^\/+/, '');
    const encodedPath = encodePathSegments(normalizedPath);
    const route = previewTarget.source === 'upload' ? 'uploads' : 'outputs';
    return `/api/workspaces/${previewTarget.workspaceId}/${route}/${encodedPath}`;
  }, [previewTarget, encodePathSegments, readOnly]);

  const handlePreviewRefresh = useCallback(() => {
    if (!previewTarget) return;
    if (previewTarget.kind === 'app') {
      refreshActiveIframe();
      return;
    }
    refreshActiveFilePreview();
  }, [previewTarget, refreshActiveIframe, refreshActiveFilePreview]);

  const handlePreviewOpenExternal = useCallback(() => {
    if (!previewTarget) return;
    if (previewTarget.kind === 'app') {
      if (!appPreviewVanityUrl) return;
      window.open(appPreviewVanityUrl, '_blank', 'noopener,noreferrer');
      return;
    }
    if (!fileExternalOpenUrl) return;
    window.open(fileExternalOpenUrl, '_blank', 'noopener,noreferrer');
  }, [previewTarget, appPreviewVanityUrl, fileExternalOpenUrl]);

  const handlePreviewBugReportOpen = useCallback(() => {
    if (readOnly) return;
    setBugReportOpen(true);
    setBugReportStatus('idle');
    setBugReportError(null);
  }, [readOnly]);

  const showMobilePreview = previewTabs.length > 0 && mobileView === 'preview';
  const currentMembership = orgs.find((entry) => entry.org_id === currentOrg?.id);
  const isAdmin = currentMembership?.role === 'owner' || currentMembership?.role === 'admin';
  const previewShareButton = useMemo(() => {
    if (readOnly) return undefined;
    if (previewTarget?.kind !== 'app') return undefined;
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
      onOpenExternal={handlePreviewOpenExternal}
      onBugReportOpen={handlePreviewBugReportOpen}
      appShareButton={previewShareButton}
      notebookViewMode={notebookViewMode}
      onNotebookViewModeChange={setActiveNotebookViewMode}
      markdownViewMode={markdownViewMode}
      onMarkdownViewModeChange={setActiveMarkdownViewMode}
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
      <PageHeader
        breadcrumbs={chatBreadcrumbs}
      />
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
        className="flex flex-col flex-1 overflow-y-auto overflow-x-hidden"
      >
        {/* Centered message column */}
        <div ref={messageColumnRef} className="max-w-3xl mx-auto w-full px-4 md:px-6 pt-2 pb-6 flex flex-col">
          <ChatMessagesView
            visibleMessages={visibleMessages}
            lastUserMessageId={lastUserMessage?.id ?? null}
            lastMessageId={lastMessage?.id ?? null}
            isAwaitingAssistant={isAwaitingAssistant}
            isLastMessageAssistantLike={isLastMessageAssistantLike}
            copyMessage={copyMessage}
            copiedMessageId={copiedMessageId}
            assistantTurnActive={assistantTurnActive}
            activeAssistantMessageId={activeAssistantMessageId}
            skillSheetsByToolId={skillSheetsByToolId}
            hostname={hostname}
            orgSlug={orgSlug}
            error={error}
            setError={setError}
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
                showScrollButton ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2 pointer-events-none"
              )}
              onClick={() => scrollToBottom('smooth')}
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
            <div className="pt-2 pb-4 px-4">
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
                  contextUsedPercent={contextUsedPercent}
                  onCompact={handleCompactFromIndicator}
                  model={selectedThreadModel}
                  onModelChange={handleThreadModelChange}
                  modelOptions={availableThreadModels}
                  modelDisabled={loading || isStreaming || updateThreadModelFetcher.state !== 'idle'}
                  textareaRef={composerTextareaRef}
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
                    <span className="text-lg font-medium text-primary">Drop files here to upload</span>
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
                            showMobilePreview ? "-translate-x-1/2" : "translate-x-0"
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
                        <MobileViewSwitcher value={mobileView} onChange={setMobileView} />
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
              <PageHeader breadcrumbs={[{ label: 'Home' }]} />
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
                      <span className="text-lg font-medium text-primary">Drop files here to upload</span>
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
                  isCreatingThread={isCreatingThread || createThreadFetcher.state !== 'idle'}
                  model={selectedThreadModel}
                  onModelChange={handleThreadModelChange}
                  modelOptions={availableThreadModels}
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

      {/* Bug Report Dialog (for manual user-initiated reports) */}
      <BugReportDialog
        open={bugReportOpen}
        onOpenChange={handleBugReportOpenChange}
        onSubmit={submitBugReport}
        status={bugReportStatus}
        error={bugReportError}
      />

      <FreeTierModal
        open={showFreeTierModal}
        onClose={handleFreeTierModalClose}
      />

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
