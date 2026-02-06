'use client';

import { useState, useEffect, useRef, useCallback, useMemo, useLayoutEffect } from 'react';
import { useNavigate, useFetcher, useRevalidator } from 'react-router';
import { ArrowDown, RefreshCw, ExternalLink, X, Bug, ChevronDown, Globe, Lock } from 'lucide-react';
import { toast } from 'sonner';
import type {
  Message,
  ContentBlock,
  ToolResultBlock,
  ToolUseBlock,
  WorkerScriptWithCreator,
  Integration,
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
import { MessageBubble } from '@/components/message-bubble';
import { LoadingDots } from '@/components/loading-dots';
import { WelcomeScreen } from '@/components/welcome-screen';
import { cn } from '@/lib/utils';
import { buildSetAppPublicPayload } from '@/lib/app-visibility';
import {
  type SDKEvent,
  applyStreamingEventToMessage,
  attachToolResultsToMessages,
  normalizeToolResultMessages,
} from '@/lib/streaming';
import { getAppUrl, getVanityDomain, getIframeDomain } from '@/lib/app-url';

interface ChatProps {
  threadId?: string;
  workspaceId: string;
  initialMessages?: Message[];
  threadTitle?: string | null;
  initialDeployedApp?: string | null;
  /** Initial app visibility from OrgDO source of truth */
  initialAppIsPublic?: boolean | null;
  isNewThread?: boolean;
  /** Hostname from server for consistent URL generation (avoids hydration mismatch) */
  hostname?: string;
  /** Org slug for namespaced app URLs */
  orgSlug?: string;
  /** True when messages are still loading (deferred data) */
  isLoadingMessages?: boolean;
  welcomeData?: {
    userId: string | null;
    userName: string | null;
    allApps: WorkerScriptWithCreator[];
    connections: Integration[];
    renderedAt: number;
  };
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
  return type === 'text' || type === 'tool_use' || type === 'tool_result' || type === 'thinking';
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
    if (block.type === 'tool_use' && block.id) return block.id;
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
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled || isPending}
          className={cn(
            "h-6 gap-1.5 rounded-full border px-2 text-xs font-medium",
            optimisticIsPublic
              ? "border-green-200 bg-green-50 text-green-700 hover:bg-green-100/80 hover:text-green-800 dark:border-green-900/70 dark:bg-green-950/30 dark:text-green-300 dark:hover:bg-green-950/60"
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


export default function Chat({
  threadId,
  workspaceId,
  initialMessages,
  threadTitle,
  initialDeployedApp,
  initialAppIsPublic,
  isNewThread = false,
  hostname,
  orgSlug,
  isLoadingMessages = false,
  welcomeData,
}: ChatProps) {
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const createThreadFetcher = useFetcher<{
    thread?: { id: string };
    onboardingSystemMessage?: string | null;
    error?: string;
  }>();
  const touchFetcher = useFetcher();
  const { user, currentWorkspace, currentOrg, orgs } = useAuthData();
  const isMobile = useIsMobile();
  // Anchor to last message for existing threads with messages (not new threads)
  const shouldAnchorToLastMessage = !isNewThread && initialMessages && initialMessages.length > 0;

  // Parse initial messages once
  const parsedInitialMessages = useMemo(
    () => (initialMessages ?? []).map(msg => ({ ...msg, content: parseMessageContent(msg.content) })),
    [initialMessages]
  );

  // Local state for messages, streaming, and loading
  const [messages, setMessagesState] = useState<Message[]>(parsedInitialMessages);
  const [streamingMessageId, setStreamingMessageIdState] = useState<string | null>(null);
  const [loading, setLoading] = useState(isLoadingMessages);
  const [pendingMessages, setPendingMessagesState] = useState<Message[]>([]);
  const [currentTodos, setCurrentTodos] = useState<TodoItem[]>([]);
  const [pendingQuestion, setPendingQuestion] = useState<AskUserQuestionData | null>(null);
  const [connectionSetupPrompt, setConnectionSetupPrompt] = useState<ConnectionSetupPromptData | null>(null);
  const [bugReportOpen, setBugReportOpen] = useState(false);
  const [bugReportStatus, setBugReportStatus] = useState<BugReportStatus>('idle');
  const [bugReportError, setBugReportError] = useState<string | null>(null);
  // MCP-triggered bug report capture
  const [mcpBugReportPrompt, setMcpBugReportPrompt] = useState<{ requestId: string; message?: string } | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const normalizedMessages = useMemo(
    () => normalizeToolResultMessages(messages),
    [messages]
  );
  const visibleMessages = useMemo(
    () => normalizedMessages.filter(message => !message.isMeta && !message.sourceToolUseID),
    [normalizedMessages]
  );

  // Refs to track current state for use in callbacks (avoids stale closures)
  const messagesRef = useRef(messages);
  const streamingMessageIdRef = useRef(streamingMessageId);
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
  useEffect(() => {
    // Skip sync if user has interacted (sent messages) - streaming state is authoritative
    if (hasHadUserInteraction.current) {
      prevInitialMessagesRef.current = initialMessages;
      return;
    }
    // Only sync if initialMessages actually changed and we're not streaming
    if (
      initialMessages !== prevInitialMessagesRef.current &&
      !streamingMessageIdRef.current &&
      revalidator.state === 'idle'
    ) {
      prevInitialMessagesRef.current = initialMessages;
      setMessages(parsedInitialMessages);
    }
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
  // Find the last streaming message ID (for showing loading indicator only on bottom-most)
  const lastStreamingMessageId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].isStreaming) return messages[i].id;
    }
    return null;
  }, [messages]);
  const hasStreamingMessage = lastStreamingMessageId !== null;
  const skillSheetsByToolId = useMemo(() => {
    const map = new Map<string, string>();
    for (const message of messages) {
      if (!message.sourceToolUseID) continue;
      const content = typeof message.content === 'string'
        ? message.content
        : message.content
            .map(block => (block.type === 'text' ? block.text : ''))
            .filter(Boolean)
            .join('\n\n');
      if (content) {
        map.set(message.sourceToolUseID, content);
      }
    }
    return map;
  }, [messages]);

  const [input, setInput] = useState('');
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [welcomeInput, setWelcomeInput] = useState('');
  const [isCreatingThread, setIsCreatingThread] = useState(false);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [deployedApp, setDeployedApp] = useState<string | null>(initialDeployedApp ?? null);
  const [appIsPublic, setAppIsPublic] = useState(initialAppIsPublic ?? false);
  const [iframeKey, setIframeKey] = useState(0);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [mobileView, setMobileView] = useState<'chat' | 'preview'>('chat');
  const [currentTitle, setCurrentTitle] = useState(threadTitle);
  const previewVersionRef = useRef<number>(0);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const messageColumnRef = useRef<HTMLDivElement>(null);
  const lastUserMessageRef = useRef<HTMLDivElement>(null);
  const assistantMeasureRef = useRef<HTMLDivElement>(null);
  const assistantSpacerRef = useRef<HTMLDivElement>(null);
  const spacerHeightRef = useRef(0);
  const initialScrollDoneRef = useRef(false);
  const stickToBottomRef = useRef(true);
  const forceScrollOnNextUpdate = useRef(false);
  const wsRef = useRef<WebSocket | null>(null);
  const previewWsRef = useRef<WebSocket | null>(null);
  const previewReconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const iframeRefreshTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const previewReconnectAttempts = useRef(0);
  const reconnectAttempts = useRef(0);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const pingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const previewPingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const lastEventIdRef = useRef(0);
  const connectionStartedAtRef = useRef<Map<number, number>>(new Map());
  const previewConnectionStartedAtRef = useRef<number | null>(null);
  const fallbackRenderedAtRef = useRef<number>(Date.now());

  useEffect(() => {
    initialScrollDoneRef.current = false;
    stickToBottomRef.current = true;
    setCurrentTodos([]);
    setPendingQuestion(null);
    setAppIsPublic(false);
  }, [threadId]);

  useEffect(() => {
    setMobileView('chat');
  }, [threadId, deployedApp]);


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

  // Track connection ID to ignore events from stale WebSocket instances
  const connectionIdRef = useRef(0);
  // Ref to hold stable connect function for effect
  const connectWebSocketRef = useRef<((id: string, isReconnect?: boolean) => void) | null>(null);
  const resolvedWorkspaceId = currentWorkspace?.id ?? workspaceId;
  const resolvedWelcomeData = welcomeData ?? {
    userId: user?.id ?? null,
    userName: user?.name ?? null,
    allApps: [],
    connections: [],
    renderedAt: fallbackRenderedAtRef.current,
  };
  // Use static key for pending messages - threadId in payload ensures correct matching
  // This avoids issues when workspace changes between welcome screen and chat page
  const pendingMessageKey = 'pendingMessage:newThread';
  const sessionStorageKey = useCallback((id: string) => {
    const workspaceKey = resolvedWorkspaceId ?? 'unknown';
    return `ws_session_${workspaceKey}_${id}`;
  }, [resolvedWorkspaceId]);

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

  // Fetch messages by revalidating the loader
  const fetchMessages = useCallback(async (_id: string) => {
    // Revalidate the route loader to get fresh messages
    // The new messages will flow in via initialMessages prop
    revalidator.revalidate();
  }, [revalidator]);

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
    // Clear any streaming message on reconnect
    setStreamingMessageId(null);
    if (!isReconnect) {
      reconnectAttempts.current = 0;
    }

    // Fetch existing messages from REST API unless this is a new thread
    let shouldFetchMessages = !isNewThread;

    // Check sessionStorage for welcome screen pending message (survives navigation)
    const pendingPayload = sessionStorage.getItem(pendingMessageKey);
    if (pendingPayload) {
      try {
        const parsed = JSON.parse(pendingPayload) as { message?: string; threadId?: string };
        // Only verify threadId - workspace may have changed between welcome screen and chat page
        // The thread was created in the correct workspace by the server action
        if (parsed.threadId === id && typeof parsed.message === 'string') {
          shouldFetchMessages = false;
          sessionStorage.removeItem(pendingMessageKey);
          // Add to state (both messages and pending queue)
          const optimisticUserMsg: Message = {
            id: `local_${Date.now()}`,
            thread_id: id,
            role: 'user',
            content: parsed.message,
            created_at: Date.now(),
          };
          setMessages([optimisticUserMsg]);
          setPendingMessages(prev => [...prev, optimisticUserMsg]);
          setLoading(true);
        }
      } catch {
        // Ignore malformed pending payload and continue to fetch
      }
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

    // WebSocket connects at /ws/{workspace}?threadId={id} - one container per workspace handles all threads
    // threadId in URL allows worker to mint per-thread deploy token for auto-preview
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
      } else if (data.type === 'sdk_event') {
        // Handle SDK events for streaming
        const sdkEvent = data.event as SDKEvent;
        const currentStreamingId = streamingMessageIdRef.current;

        if (sdkEvent.type === 'stream_event') {
          const evt = sdkEvent.event;
          if (evt?.type === 'message_start') {
            const currentMsgs = messagesRef.current;
            const existingStreamingId = streamingMessageIdRef.current;
            const existingStreamingMsg = existingStreamingId
              ? currentMsgs.find(msg => msg.id === existingStreamingId)
              : undefined;

            if (existingStreamingMsg) {
              // Claude emits a new message_start after each tool call; append to the active turn.
              setMessages(prev => prev.map(msg =>
                msg.id === existingStreamingId ? applyStreamingEventToMessage(msg, sdkEvent) : msg
              ));
              return;
            }

            const fallbackStreamingMsg = currentMsgs.find(msg => msg.isStreaming);
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
          // System init - just reset the streaming message ID
          setStreamingMessageId(null);
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
          const contentBlocks = sdkEvent.message.content;
          const isToolResultEvent =
            Array.isArray(contentBlocks) &&
            contentBlocks.length > 0 &&
            contentBlocks.every(block => block.type === 'tool_result');
          const { sourceToolUseID } = extractMetaInfo(sdkEvent);

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
            (block): block is ToolResultBlock => block.type === 'tool_result'
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
          const msgId = streamingMessageIdRef.current;
          if (msgId) {
            setMessages(prev => prev.map(msg =>
              msg.id === msgId ? { ...msg, isStreaming: false } : msg
            ));
          }
          setStreamingMessageId(null);
          setLoading(false);
        }
      } else if (data.type === 'todo_state') {
        // Direct todo state from server - no extraction needed
        if (Array.isArray(data.todos)) {
          setCurrentTodos(data.todos);
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
      } else if (data.type === 'error') {
        console.error('WebSocket error:', data.error);
        setError(data.error || 'An unknown error occurred');
        // Finish streaming on error
        const msgId = streamingMessageIdRef.current;
        if (msgId) {
          setMessages(prev => prev.map(msg =>
            msg.id === msgId ? { ...msg, isStreaming: false } : msg
          ));
        }
        setStreamingMessageId(null);
        setLoading(false);
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
      }
    };

    ws.onerror = () => {
      // Ignore errors from superseded connections
      if (connectionIdRef.current !== thisConnectionId) {
        return;
      }
    };

  }, [fetchMessages, persistSessionState, resolvedWorkspaceId, isNewThread, setMessages, setPendingMessages, setStreamingMessageId]);

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
  }, [currentWorkspace?.id, threadId, navigate]);

  // Cleanup on unmount to avoid orphaned WebSockets or reconnect timers
  useEffect(() => {
    return () => {
      bumpConnectionId();
      connectedThreadIdRef.current = null;
      connectedWorkspaceIdRef.current = null;

      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }

      if (previewWsRef.current) {
        previewWsRef.current.close();
        previewWsRef.current = null;
      }

      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }

      if (previewReconnectTimeoutRef.current) {
        clearTimeout(previewReconnectTimeoutRef.current);
        previewReconnectTimeoutRef.current = null;
      }

      if (pingIntervalRef.current) {
        clearInterval(pingIntervalRef.current);
        pingIntervalRef.current = null;
      }

      if (previewPingIntervalRef.current) {
        clearInterval(previewPingIntervalRef.current);
        previewPingIntervalRef.current = null;
      }

      if (iframeRefreshTimeoutRef.current) {
        clearTimeout(iframeRefreshTimeoutRef.current);
        iframeRefreshTimeoutRef.current = null;
      }
    };
  }, [bumpConnectionId]);

  // Preview WebSocket - connects to /ws/thread/{threadId} for live preview state updates
  // Uses a stable connect function to handle reconnection
  const connectPreviewWebSocket = useCallback((id: string, isReconnect = false) => {
    // Clear any pending reconnect
    if (previewReconnectTimeoutRef.current) {
      clearTimeout(previewReconnectTimeoutRef.current);
      previewReconnectTimeoutRef.current = null;
    }

    // Close existing connection
    if (previewWsRef.current) {
      previewWsRef.current.close();
      previewWsRef.current = null;
    }

    // Clear any existing ping interval
    if (previewPingIntervalRef.current) {
      clearInterval(previewPingIntervalRef.current);
      previewPingIntervalRef.current = null;
    }

    if (!isReconnect) {
      previewReconnectAttempts.current = 0;
    }

    const wsHost = window.location.host;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${wsHost}/ws/thread/${id}`;
    const ws = new WebSocket(wsUrl);
    previewWsRef.current = ws;
    previewConnectionStartedAtRef.current = Date.now();

    ws.onopen = () => {
      previewReconnectAttempts.current = 0;

      // Start ping interval to detect connection issues early
      // The DO auto-responds without waking up
      if (previewPingIntervalRef.current) {
        clearInterval(previewPingIntervalRef.current);
      }
      previewPingIntervalRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, 30000); // Ping every 30 seconds
    };

    ws.onmessage = (event) => {
      if (previewWsRef.current !== ws) return; // Ignore stale connections

      try {
        const data = JSON.parse(event.data);
        if (data.type === 'preview_state' && Array.isArray(data.workers)) {
          // Use the first worker for the preview iframe
          const firstWorker = data.workers[0] || null;
          const newVersion = data.version || 0;

          // Check if this is a new deploy (version changed or first deploy)
          const isNewDeploy = newVersion > previewVersionRef.current;
          previewVersionRef.current = newVersion;

          setDeployedApp(firstWorker);
          setAppIsPublic((prev) =>
            typeof data.isPublic === 'boolean' ? data.isPublic : prev
          );

          // Add delay before showing iframe to allow worker to fully initialize
          if (firstWorker && isNewDeploy) {
            // Clear any existing pending refresh
            if (iframeRefreshTimeoutRef.current) {
              clearTimeout(iframeRefreshTimeoutRef.current);
            }
            setPreviewLoading(true);
            iframeRefreshTimeoutRef.current = setTimeout(() => {
              setPreviewLoading(false);
              setIframeKey(prev => prev + 1);
              iframeRefreshTimeoutRef.current = null;
            }, 1500); // 1.5 second delay for worker initialization
          }
        } else if (data.type === 'title_updated' && data.title) {
          // Update thread title when AI generates it
          setCurrentTitle(data.title);
        } else if (data.type === 'connection_setup_prompt' && data.requestId && data.integrationType) {
          // MCP server is prompting user to set up a connection
          setConnectionSetupPrompt({
            requestId: data.requestId as string,
            integrationType: data.integrationType as string,
            suggestedName: data.suggestedName as string | undefined,
            message: data.message as string | undefined,
            dynamicSchema: data.dynamicSchema as ConnectionSetupPromptData['dynamicSchema'],
            mcpDoId: data.mcpDoId as string | undefined,
          });
        } else if (data.type === 'bug_report_prompt' && data.requestId) {
          // MCP server is prompting user to capture a bug report - auto-capture without dialog
          const mcpRequest = {
            requestId: data.requestId as string,
            message: data.message as string | undefined,
          };
          // Store the request and trigger auto-capture
          setMcpBugReportPrompt(mcpRequest);
        }
      } catch (e) {
        console.error('Preview WebSocket message parse error:', e);
      }
    };

    ws.onclose = () => {
      if (previewWsRef.current !== ws) return; // Ignore stale connections
      previewWsRef.current = null;
      previewConnectionStartedAtRef.current = null;

      // Clear ping interval
      if (previewPingIntervalRef.current) {
        clearInterval(previewPingIntervalRef.current);
        previewPingIntervalRef.current = null;
      }

      // Auto-reconnect with exponential backoff
      const maxAttempts = 5;
      if (previewReconnectAttempts.current < maxAttempts) {
        const delay = Math.min(1000 * Math.pow(2, previewReconnectAttempts.current), 30000);
        previewReconnectAttempts.current++;
        previewReconnectTimeoutRef.current = setTimeout(() => {
          connectPreviewWebSocket(id, true);
        }, delay);
      }
    };

    ws.onerror = () => {
      // Error will trigger close, which handles reconnection
    };
  }, []);

  useEffect(() => {
    if (!threadId) {
      // No thread - cleanup preview WebSocket
      if (previewReconnectTimeoutRef.current) {
        clearTimeout(previewReconnectTimeoutRef.current);
        previewReconnectTimeoutRef.current = null;
      }
      if (previewWsRef.current) {
        previewWsRef.current.close();
        previewWsRef.current = null;
      }
      setDeployedApp(null);
      setAppIsPublic(false);
      return;
    }

    connectPreviewWebSocket(threadId);

    return () => {
      if (previewReconnectTimeoutRef.current) {
        clearTimeout(previewReconnectTimeoutRef.current);
        previewReconnectTimeoutRef.current = null;
      }
      if (previewWsRef.current) {
        previewWsRef.current.close();
        previewWsRef.current = null;
      }
    };
  }, [threadId, connectPreviewWebSocket]);

  // Check if we should show the chat UI
  const shouldShowChat = Boolean(threadId);
  const lastMessage = visibleMessages[visibleMessages.length - 1];
  const showAssistantTail = loading || isStreaming;
  const isAwaitingAssistant = showAssistantTail && lastMessage?.role === 'user';
  const lastUserMessage = useMemo(() => {
    for (let i = visibleMessages.length - 1; i >= 0; i -= 1) {
      if (visibleMessages[i].role === 'user') return visibleMessages[i];
    }
    return null;
  }, [visibleMessages]);
  const shouldRenderSpacer = Boolean(lastUserMessage) &&
    !lastUserMessage?.sentDuringStreaming &&
    (isAwaitingAssistant || lastMessage?.role === 'assistant');

  // Connect when threadId changes
  useEffect(() => {
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

    // No cleanup function - we handle cleanup explicitly when threadId changes
    // This prevents StrictMode from closing connections on remount
    // Browser closes WebSocket automatically on navigation
  }, [threadId, shouldShowChat, resolvedWorkspaceId]);

  // Reconnect on visibility change (tab becomes visible)
  useEffect(() => {
    const handleVisibilityChange = () => {
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

        // Check if preview WebSocket is dead
        const previewNeedsReconnect = !previewWsRef.current ||
          previewWsRef.current.readyState === WebSocket.CLOSED ||
          previewWsRef.current.readyState === WebSocket.CLOSING;

        if (previewNeedsReconnect && threadId) {
          if (previewReconnectTimeoutRef.current) {
            clearTimeout(previewReconnectTimeoutRef.current);
            previewReconnectTimeoutRef.current = null;
          }
          previewReconnectAttempts.current = 0;
          connectPreviewWebSocket(threadId, true);
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [threadId, shouldShowChat, resolvedWorkspaceId, connectPreviewWebSocket]);

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
    if (!container || !spacer) {
      spacerHeightRef.current = 0;
      return;
    }

    const updateSpacer = () => {
      const measureUser = lastUserMessageRef.current;
      const measureAssistant = assistantMeasureRef.current;

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

      // Add to state as uploading
      setAttachments(prev => [...prev, {
        id,
        name: file.name,
        path: '',
        size: file.size,
        contentType: file.type || undefined,
        originalName: file.name,
        status: 'uploading',
      }]);

      try {
        const formData = new FormData();
        formData.append('file', file);

        const response = await fetch(`/api/workspaces/${resolvedWorkspaceId}/upload`, {
          method: 'POST',
          body: formData,
        });

        if (!response.ok) {
          throw new Error('Upload failed');
        }

        const data = await response.json() as {
          path: string;
          size: number;
          contentType?: string;
          originalName?: string;
        };

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
            }
            : a
        ));
      } catch (err) {
        console.error('File upload failed:', err);
        // Update state to error
        setAttachments(prev => prev.map(a =>
          a.id === id
            ? { ...a, status: 'error' as const, error: 'Upload failed' }
            : a
        ));
      }
    }
  }, [resolvedWorkspaceId]);

  const handleAttachmentRemove = useCallback((id: string) => {
    setAttachments(prev => prev.filter(a => a.id !== id));
  }, []);

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
  const pendingNewChatRef = useRef<{ finalContent: string } | null>(null);

  // Handle fetcher response for thread creation
  useEffect(() => {
    if (createThreadFetcher.state === 'idle' && createThreadFetcher.data) {
      const data = createThreadFetcher.data;
      if (data.thread && pendingNewChatRef.current) {
        // Thread created successfully - store message and navigate
        const { finalContent } = pendingNewChatRef.current;
        const onboardingSystemMessage = data.onboardingSystemMessage?.trim();
        const messageWithContext = onboardingSystemMessage
          ? `<chiridion system message>${onboardingSystemMessage}</chiridion system message>\n\n${finalContent}`
          : finalContent;
        sessionStorage.setItem(pendingMessageKey, JSON.stringify({ message: messageWithContext, threadId: data.thread.id }));
        pendingNewChatRef.current = null;
        navigate(`/chat/${data.thread.id}?newThread=1`);
      } else if (data.error) {
        // Thread creation failed
        sessionStorage.removeItem(pendingMessageKey);
        setIsCreatingThread(false);
        setError('Failed to start a new chat');
        console.error('Failed to create thread:', data.error);
        pendingNewChatRef.current = null;
      }
    }
  }, [createThreadFetcher.state, createThreadFetcher.data, navigate]);

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

    // Build the chiridion system message
    const appUrl = getAppUrl(app.script_name, hostname, orgSlug);
    const sourceInfo = app.config_path
      ? ` The app's wrangler config is at "${app.config_path}".`
      : ` The project location is unknown - search for it in the home folder. The project may have a different name than the app, and look for either wrangler.toml or wrangler.jsonc files.`;
    const systemMessage = `<chiridion system message>I'd like to work on the app "${app.script_name}" at ${appUrl}.${sourceInfo}</chiridion system message>`;

    // Store pending message for the createThreadFetcher effect
    pendingNewChatRef.current = { finalContent: systemMessage };

    // Create thread with preview settings
    createThreadFetcher.submit(
      {
        intent: 'createThread',
        firstMessage: `Chat about ${app.script_name}`,
        previewApps: app.script_name,
      },
      { method: 'post', action: '/chat' }
    );
  }, [hostname, orgSlug, resolvedWorkspaceId, createThreadFetcher, isCreatingThread]);

  function startNewChat() {
    if (!welcomeInput.trim() || isCreatingThread || !resolvedWorkspaceId || createThreadFetcher.state !== 'idle') return;

    // Don't allow sending while uploads are in progress
    const hasUploadingAttachments = attachments.some(a => a.status === 'uploading');
    if (hasUploadingAttachments) return;

    setIsCreatingThread(true);
    const userMessage = welcomeInput.trim();
    setWelcomeInput('');

    // Build message content with file references appended
    const completedAttachments = attachments.filter(a => a.status === 'complete');
    let finalContent = userMessage;
    if (completedAttachments.length > 0) {
      const fileRefs = completedAttachments
        .map(a => `(user uploaded file to ${a.path})`)
        .join('\n');
      finalContent = `${userMessage}\n\n${fileRefs}`;
    }

    // Clear attachments
    setAttachments([]);

    // Store pending message info for the effect to use after thread creation
    pendingNewChatRef.current = { finalContent };

    // Submit to route action to create thread
    createThreadFetcher.submit(
      { intent: 'createThread', firstMessage: userMessage },
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
  }, [pendingQuestion]);

  // Handle connection setup response - send via thread preview WebSocket
  const handleConnectionSetupResponse = useCallback((response: ConnectionSetupResponse) => {
    if (!previewWsRef.current || previewWsRef.current.readyState !== WebSocket.OPEN) {
      console.error('[Chat] Preview WebSocket not available for connection setup response');
      return;
    }

    previewWsRef.current.send(JSON.stringify({
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
      if (previewWsRef.current?.readyState === WebSocket.OPEN) {
        previewWsRef.current.send(JSON.stringify({
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

        const screenshotFormData = new FormData();
        screenshotFormData.append('file', screenshotFile);

        const screenshotResponse = await fetch(`/api/workspaces/${resolvedWorkspaceId}/upload`, {
          method: 'POST',
          body: screenshotFormData,
        });

        if (screenshotResponse.ok) {
          const screenshotData = await screenshotResponse.json() as { path: string };
          screenshotPath = screenshotData.path;
        }
      }

      // Upload session recording as separate JSON file if available
      if (debugData?.sessionRecording && debugData.sessionRecording.events.length > 0) {
        const recordingBlob = new Blob(
          [JSON.stringify(debugData.sessionRecording, null, 2)],
          { type: 'application/json' }
        );
        const recordingFile = new File([recordingBlob], `${reportId}-session.json`, { type: 'application/json' });

        const recordingFormData = new FormData();
        recordingFormData.append('file', recordingFile);

        const recordingResponse = await fetch(`/api/workspaces/${resolvedWorkspaceId}/upload`, {
          method: 'POST',
          body: recordingFormData,
        });

        if (recordingResponse.ok) {
          const recordingData = await recordingResponse.json() as { path: string };
          sessionRecordingPath = recordingData.path;
        }
      }

      // Create bug report bundle (without large data, using file references)
      const vanityHost = orgSlug
        ? `${deployedApp}--${orgSlug}.${getVanityDomain(hostname)}`
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

      const formData = new FormData();
      formData.append('file', file);

      const uploadResponse = await fetch(`/api/workspaces/${resolvedWorkspaceId}/upload`, {
        method: 'POST',
        body: formData,
      });

      if (!uploadResponse.ok) {
        throw new Error('Failed to upload bug report');
      }

      const uploadData = await uploadResponse.json() as { path: string };

      if (!isMcpTriggered) {
        setBugReportStatus('sending');
      }

      // If this is an MCP-triggered capture, send response via preview WebSocket
      if (isMcpTriggered && mcpRequestId && previewWsRef.current?.readyState === WebSocket.OPEN) {
        previewWsRef.current.send(JSON.stringify({
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
      if (isMcpTriggered && mcpRequestId && previewWsRef.current?.readyState === WebSocket.OPEN) {
        previewWsRef.current.send(JSON.stringify({
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

  function sendMessage() {
    if (!input.trim() || !shouldShowChat || !resolvedWorkspaceId || !threadId) {
      return;
    }

    const wasSentDuringStreaming = isStreaming;

    // Mark that user has interacted - prevents loader sync from overwriting streaming state
    hasHadUserInteraction.current = true;

    const userMessage = input.trim();
    setInput('');

    // Build message content with file references appended
    const completedAttachments = attachments.filter(a => a.status === 'complete');
    let finalContent = userMessage;
    if (completedAttachments.length > 0) {
      const fileRefs = completedAttachments
        .map(a => `(user uploaded file to ${a.path})`)
        .join('\n');
      finalContent = `${userMessage}\n\n${fileRefs}`;
    }

    // Clear attachments after building message
    setAttachments([]);

    // Clear any previous error
    setError(null);

    // Update thread timestamp so it appears at top of history list
    touchFetcher.submit(
      { intent: 'touch' },
      { method: 'POST' }
    );

    // Add user message to state immediately (optimistic)
    const userMsg: Message = {
      id: `local_${Date.now()}`,
      thread_id: threadId,
      role: 'user',
      content: finalContent,
      created_at: Date.now(),
      sentDuringStreaming: wasSentDuringStreaming,
    };

    // Add user message - it naturally appears after any streaming message
    if (!wasSentDuringStreaming) {
      forceScrollOnNextUpdate.current = true;
    }
    setMessages(prev => [...prev, userMsg]);

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

  const chatBreadcrumbs = [
    { label: 'Chat' },
    { label: currentTitle?.trim() || 'Untitled Chat' },
  ];
  const previewDomains = useMemo(() => {
    if (!deployedApp) {
      return { iframeHost: '', vanityHost: '' };
    }
    if (orgSlug) {
      return {
        iframeHost: `${deployedApp}--${orgSlug}.${getIframeDomain(hostname)}`,
        vanityHost: `${deployedApp}--${orgSlug}.${getVanityDomain(hostname)}`,
      };
    }
    // Legacy format without org slug
    return {
      iframeHost: `${deployedApp}.${getIframeDomain(hostname)}`,
      vanityHost: `${deployedApp}.${getVanityDomain(hostname)}`,
    };
  }, [deployedApp, hostname, orgSlug]);
  const previewUrl = previewDomains.iframeHost ? `https://${previewDomains.iframeHost}` : '';
  const previewVanityUrl = previewDomains.vanityHost ? `https://${previewDomains.vanityHost}` : '';
  const showMobilePreview = Boolean(deployedApp) && mobileView === 'preview';
  const currentMembership = orgs.find((entry) => entry.org_id === currentOrg?.id);
  const isAdmin = currentMembership?.role === 'owner' || currentMembership?.role === 'admin';

  const previewPanelBody = deployedApp ? (
    <>
      <div className="flex items-center justify-between px-4 py-2 border-b border-border">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 bg-green-500 rounded-full" />
          <span className="text-sm font-medium">{previewDomains.vanityHost}</span>
        </div>
        <div className="flex items-center gap-2">
          <ShareStatusButton
            threadId={threadId}
            scriptName={deployedApp}
            isPublic={appIsPublic}
            isAdmin={Boolean(isAdmin)}
            onStatusChange={setAppIsPublic}
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => {
                  setBugReportOpen(true);
                  setBugReportStatus('idle');
                  setBugReportError(null);
                }}
              >
                <Bug className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Report a bug</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setIframeKey(prev => prev + 1)}
              >
                <RefreshCw className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Reload</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                asChild
              >
                <a
                  href={previewVanityUrl || 'about:blank'}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <ExternalLink className="h-4 w-4" />
                </a>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Open in new tab</TooltipContent>
          </Tooltip>
        </div>
      </div>
      <div className="flex-1 min-h-0">
        {previewLoading ? (
          <div className="w-full h-full flex items-center justify-center bg-muted/30">
            <div className="flex flex-col items-center gap-3">
              <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
              <span className="text-sm text-muted-foreground">Loading preview...</span>
            </div>
          </div>
        ) : (
          <iframe
            ref={iframeRef}
            key={iframeKey}
            src={previewUrl || 'about:blank'}
            className="w-full h-full bg-white"
            title="Deployed App Preview"
          />
        )}
      </div>
    </>
  ) : null;

  const chatPanelContent = (
    <>
      <PageHeader
        breadcrumbs={chatBreadcrumbs}
      />
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
          {visibleMessages.map(msg => {
            const isLastUserMessage = msg.id === lastUserMessage?.id;
            const isLastAssistantMessage = !isAwaitingAssistant && lastMessage?.role === 'assistant' && msg.id === lastMessage?.id;
            const messageRef = isLastUserMessage
              ? lastUserMessageRef
              : (isLastAssistantMessage ? assistantMeasureRef : undefined);
            return (
              <div
                key={msg.id}
                ref={messageRef}
                data-message-id={msg.id}
                className={cn("group", msg.role === 'user' ? "mt-6 mb-1" : "")}
              >
                <MessageBubble
                  message={msg}
                  onCopy={copyMessage}
                  copiedId={copiedMessageId}
                  showStreamingIndicator={msg.id === lastStreamingMessageId}
                  skillSheets={skillSheetsByToolId}
                  hostname={hostname}
                  orgSlug={orgSlug}
                />
              </div>
            );
          })}

          {/* Error display */}
          {error && (
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
          )}

          {/* Loading indicator when waiting for assistant response */}
          {loading && !isStreaming && !hasStreamingMessage && (
            <LoadingDots />
          )}
          {shouldRenderSpacer ? (
            <div className="flex flex-col">
              <div ref={assistantSpacerRef} aria-hidden="true" className="pointer-events-none w-full shrink-0" />
              <div ref={messagesEndRef} />
            </div>
          ) : (
            <div ref={messagesEndRef} />
          )}
        </div>
      </div>

      {/* Sticky Composer */}
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
            <div className="max-w-3xl mx-auto w-full">
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
              <PromptInput
                value={input}
                onChange={setInput}
                onSubmit={sendMessage}
                onStop={stopGeneration}
                placeholder="Type a message..."
                isAssistantRunning={loading || isStreaming}
                autoFocus
                attachments={attachments}
                onFilesSelected={handleFilesSelected}
                onAttachmentRemove={handleAttachmentRemove}
              />
            </div>
          </div>
        </div>
      </div>
    </>
  );

  return (
    <TooltipProvider>
      <>
        {shouldShowChat ? (
          <div
            className="flex-1 min-h-0 relative flex flex-col"
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
            {isMobile ? (
              <div className="flex flex-1 min-h-0 flex-col overflow-hidden">
                {deployedApp ? (
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
                  defaultSize={deployedApp ? "50%" : "100%"}
                  minSize="30%"
                  className="flex flex-col min-h-0 min-w-0"
                >
                  {chatPanelContent}
                </ResizablePanel>

                {deployedApp && (
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
                renderedAt={resolvedWelcomeData.renderedAt}
                inputValue={welcomeInput}
                onPromptChange={setWelcomeInput}
                onSubmit={startNewChat}
                onStartChatForApp={handleStartChatForApp}
                attachments={attachments}
                onFilesSelected={handleFilesSelected}
                onAttachmentRemove={handleAttachmentRemove}
                isCreatingThread={isCreatingThread || createThreadFetcher.state !== 'idle'}
              />
            </div>
          </>
        )}
      </>

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
    </TooltipProvider>
  );
}
