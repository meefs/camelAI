'use client';

import { useState, useEffect, useRef, useCallback, useMemo, useLayoutEffect } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowDown, RefreshCw, ExternalLink, X } from 'lucide-react';
import type { Message, ContentBlock } from '@/types';
import { useAuth } from '@/contexts/AuthContext';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { PageHeader } from '@/components/page-header';
import { PromptInput } from '@/components/prompt-input';
import { Button } from '@/components/ui/button';
import { MessageBubble } from '@/components/message-bubble';
import { LoadingDots } from '@/components/loading-dots';
import { cn } from '@/lib/utils';
import { type SDKEvent, applyStreamingEventToMessage } from '@/lib/streaming';
import {
  createThread as createThreadAction,
  getThreadMessages,
} from '@/lib/server-actions/thread';

interface ChatProps {
  threadId?: string;
  orgId: string;
  initialMessages?: Message[];
  threadTitle?: string | null;
  initialDeployedApp?: string | null;
  isNewThread?: boolean;
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


export default function Chat({ threadId, orgId, initialMessages, threadTitle, initialDeployedApp, isNewThread = false }: ChatProps) {
  const router = useRouter();
  const { user, currentOrg, loading: authLoading } = useAuth();

  // Parse initial messages once
  const parsedInitialMessages = useMemo(
    () => (initialMessages ?? []).map(msg => ({ ...msg, content: parseMessageContent(msg.content) })),
    [initialMessages]
  );

  // Local state for messages, streaming, and loading
  const [messages, setMessagesState] = useState<Message[]>(parsedInitialMessages);
  const [streamingMessageId, setStreamingMessageIdState] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pendingMessages, setPendingMessagesState] = useState<Message[]>([]);

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

  const [input, setInput] = useState('');
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [welcomeInput, setWelcomeInput] = useState('');
  const [isCreatingThread, setIsCreatingThread] = useState(false);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [deployedApp, setDeployedApp] = useState<string | null>(initialDeployedApp ?? null);
  const [iframeKey, setIframeKey] = useState(0);
  const [currentTitle, setCurrentTitle] = useState(threadTitle);
  const previewVersionRef = useRef<number>(0);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const messageColumnRef = useRef<HTMLDivElement>(null);
  const lastUserMessageRef = useRef<HTMLDivElement>(null);
  const assistantMeasureRef = useRef<HTMLDivElement>(null);
  const assistantSpacerRef = useRef<HTMLDivElement>(null);
  const initialScrollDoneRef = useRef(false);
  const stickToBottomRef = useRef(true);
  const forceScrollOnNextUpdate = useRef(false);
  const wsRef = useRef<WebSocket | null>(null);
  const previewWsRef = useRef<WebSocket | null>(null);
  const previewReconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const previewReconnectAttempts = useRef(0);
  const reconnectAttempts = useRef(0);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const pingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const previewPingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const lastEventIdRef = useRef(0);
  const connectionStartedAtRef = useRef<Map<number, number>>(new Map());
  const previewConnectionStartedAtRef = useRef<number | null>(null);

  useEffect(() => {
    initialScrollDoneRef.current = false;
    stickToBottomRef.current = true;
  }, [threadId]);

  // Sync current title from prop (e.g., when SSR data arrives)
  useEffect(() => {
    setCurrentTitle(threadTitle);
  }, [threadTitle]);

  // Track connection ID to ignore events from stale WebSocket instances
  const connectionIdRef = useRef(0);
  // Ref to hold stable connect function for effect
  const connectWebSocketRef = useRef<((id: string, isReconnect?: boolean) => void) | null>(null);
  const sessionStorageKey = useCallback((id: string) => `ws_session_${id}`, []);

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

  const resolvedOrgId = currentOrg?.id ?? orgId;

  // Redirect to login if not authenticated
  useEffect(() => {
    if (!authLoading && !user) {
      router.push('/login');
    }
  }, [authLoading, user, router]);

  useEffect(() => {
    if (!threadId) {
      sessionIdRef.current = null;
      lastEventIdRef.current = 0;
      return;
    }
    loadSessionState(threadId);
  }, [threadId, loadSessionState]);

  useEffect(() => {
    if (!isNewThread || !threadId) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get('newThread') !== '1') return;
    url.searchParams.delete('newThread');
    window.history.replaceState(null, '', url.toString());
  }, [isNewThread, threadId]);

  // Fetch messages from REST API
  const fetchMessages = useCallback(async (id: string) => {
    try {
      const data = await getThreadMessages(id);
      const fetchedMsgs = Array.isArray(data) ? (data as Message[]) : [];

      // Parse content for each message (handles JSON-encoded ContentBlock[])
      const parsedMsgs = fetchedMsgs.map(msg => ({
        ...msg,
        content: parseMessageContent(msg.content),
      }));

      // Always replace with server state - local-only messages (local_*, turn_*)
      // that weren't persisted are stale. Pending messages will be re-added
      // when the ready event fires.
      setMessages(parsedMsgs);
    } catch (e) {
      console.error('Failed to fetch messages:', e);
    }
  }, []);

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
    const pendingPayload = sessionStorage.getItem('pendingMessage');
    if (pendingPayload) {
      try {
        const parsed = JSON.parse(pendingPayload) as { message?: string; threadId?: string };
        if (parsed.threadId === id && typeof parsed.message === 'string') {
          shouldFetchMessages = false;
          sessionStorage.removeItem('pendingMessage');
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

    // WebSocket connects at /ws/{org}?threadId={id} - one container per org handles all threads
    // threadId in URL allows worker to mint per-thread deploy token for auto-preview
    const wsHost = window.location.host;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const orgIdForConnection = resolvedOrgId;
    const wsUrl = `${protocol}//${wsHost}/ws/${orgIdForConnection}?threadId=${encodeURIComponent(id)}`;
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
        org: orgIdForConnection,
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
        if (threadId) {
          persistSessionState(threadId);
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
        if (threadId) {
          persistSessionState(threadId);
        }
      } else if (data.type === 'sdk_event') {
        // Handle SDK events for streaming
        const sdkEvent = data.event as SDKEvent;
        const currentStreamingId = streamingMessageIdRef.current;

        if (sdkEvent.type === 'stream_event') {
          const evt = sdkEvent.event;
          if (evt?.type === 'message_start') {
            // Add new assistant message with isStreaming: true
            const msgId = evt.message?.id || (sdkEvent as { uuid?: string }).uuid || `stream_${Date.now()}`;
            // Start streaming message
            setStreamingMessageId(msgId);
            const newMsg: Message = {
              id: msgId,
              thread_id: id,
              role: 'assistant',
              content: [],
              created_at: Date.now(),
              isStreaming: true,
            };
            const currentMsgs = messagesRef.current;
            if (!currentMsgs.some(m => m.id === msgId)) {
              setMessages([...currentMsgs, newMsg]);
            }
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
          // Append user content blocks (tool_result) to current streaming message
          const msgId = streamingMessageIdRef.current;
          if (msgId) {
            setMessages(prev => prev.map(msg => {
              if (msg.id !== msgId) return msg;
              const content = Array.isArray(msg.content) ? msg.content : [];
              return { ...msg, content: [...content, ...sdkEvent.message!.content] };
            }));
          }
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

    ws.onclose = (event) => {
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

  }, [fetchMessages, resolvedOrgId, persistSessionState, threadId, isNewThread]);

  // Keep the ref updated with the latest function
  connectWebSocketRef.current = connectWebSocket;

  // Track which threadId we're connected to
  const connectedThreadIdRef = useRef<string | null>(null);
  const connectedOrgIdRef = useRef<string | null>(null);

  // Cleanup on unmount to avoid orphaned WebSockets or reconnect timers
  useEffect(() => {
    return () => {
      connectionIdRef.current++;
      connectedThreadIdRef.current = null;
      connectedOrgIdRef.current = null;

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
    };
  }, []);

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

          // Check if this is a new deploy (version changed)
          const isNewDeploy = newVersion > previewVersionRef.current && previewVersionRef.current > 0;
          previewVersionRef.current = newVersion;

          setDeployedApp(firstWorker);
          // Force iframe refresh on new deploy by changing key
          if (firstWorker && isNewDeploy) {
            setIframeKey(prev => prev + 1);
          }
        } else if (data.type === 'title_updated' && data.title) {
          // Update thread title when AI generates it
          setCurrentTitle(data.title);
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
  const lastMessage = messages[messages.length - 1];
  const showAssistantTail = loading || isStreaming;
  const isAwaitingAssistant = showAssistantTail && lastMessage?.role === 'user';
  const lastUserMessage = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === 'user') return messages[i];
    }
    return null;
  }, [messages]);
  const shouldRenderSpacer = Boolean(lastUserMessage) && (isAwaitingAssistant || lastMessage?.role === 'assistant');

  // Connect when threadId changes
  useEffect(() => {
    if (!shouldShowChat || !resolvedOrgId) {
      // No threadId or org - cleanup any existing connection
      if (connectedThreadIdRef.current) {
        connectionIdRef.current++;
        connectedThreadIdRef.current = null;
        connectedOrgIdRef.current = null;
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

    const nextOrgId = resolvedOrgId;
    const threadChanged = connectedThreadIdRef.current && connectedThreadIdRef.current !== threadId;
    const orgChanged = connectedOrgIdRef.current && connectedOrgIdRef.current !== nextOrgId;

    // Already connected to this thread+org? Nothing to do.
    if (connectedThreadIdRef.current === threadId && connectedOrgIdRef.current === nextOrgId) {
      return;
    }

    // Switching threads or orgs - close old connection first
    if (connectedThreadIdRef.current || connectedOrgIdRef.current) {
      if (threadChanged || orgChanged) {
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

    // Connect to the new thread/org
    connectedThreadIdRef.current = threadId ?? null;
    connectedOrgIdRef.current = nextOrgId;
    if (threadId) {
      connectWebSocketRef.current?.(threadId);
    }

    // No cleanup function - we handle cleanup explicitly when threadId changes
    // This prevents StrictMode from closing connections on remount
    // Browser closes WebSocket automatically on navigation
  }, [threadId, shouldShowChat, resolvedOrgId]);

  // Reconnect on visibility change (tab becomes visible)
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && shouldShowChat && resolvedOrgId) {
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
  }, [threadId, shouldShowChat, resolvedOrgId, connectPreviewWebSocket]);

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
    if (!shouldRenderSpacer) return;

    const container = scrollContainerRef.current;
    const spacer = assistantSpacerRef.current;
    const userEl = lastUserMessageRef.current;
    const assistantEl = assistantMeasureRef.current;
    if (!container || !spacer) return;

    let frameId: number | null = null;

    const updateSpacer = () => {
      const measureUser = lastUserMessageRef.current;
      const measureAssistant = assistantMeasureRef.current;
      if (!measureUser || !measureAssistant) {
        spacer.style.height = '0px';
        return;
      }

      const containerRect = container.getBoundingClientRect();
      const userRect = measureUser.getBoundingClientRect();
      const assistantRect = measureAssistant.getBoundingClientRect();
      const userStyle = getComputedStyle(measureUser);
      const assistantStyle = getComputedStyle(measureAssistant);
      const userMarginTopValue = parseFloat(userStyle.marginTop || '0');
      const assistantMarginBottomValue = parseFloat(assistantStyle.marginBottom || '0');
      const userMarginTop = Number.isNaN(userMarginTopValue) ? 0 : userMarginTopValue;
      const assistantMarginBottom = Number.isNaN(assistantMarginBottomValue) ? 0 : assistantMarginBottomValue;
      const exchangeTop = userRect.top - userMarginTop;
      const exchangeBottom = assistantRect.bottom + assistantMarginBottom;
      const exchangeHeight = Math.max(exchangeBottom - exchangeTop, 0);

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
      spacer.style.height = `${height}px`;
    };

    updateSpacer();

    if (typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(() => {
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
      }
      frameId = requestAnimationFrame(updateSpacer);
    });

    observer.observe(container);
    if (messageColumnRef.current) {
      observer.observe(messageColumnRef.current);
    }
    if (userEl) {
      observer.observe(userEl);
    }
    if (assistantEl) {
      observer.observe(assistantEl);
    }

    return () => {
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
      }
      observer.disconnect();
    };
  }, [shouldRenderSpacer, isAwaitingAssistant, lastMessage?.id, lastUserMessage?.id, messages.length, isStreaming, loading]);

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
  }, [scrollToBottom, shouldShowChat, threadId]);

  // Auto-scroll on new messages (only if near bottom, or forced after user sends)
  useLayoutEffect(() => {
    if (!shouldShowChat || !threadId) return;

    if (!initialScrollDoneRef.current && messages.length > 0) {
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
  }, [messages, scrollToBottom, shouldShowChat, threadId]);

  const copyMessage = useCallback(async (messageId: string, content: string) => {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedMessageId(messageId);
      setTimeout(() => setCopiedMessageId(null), 2000);
    } catch (err) {
      console.error('Failed to copy message:', err);
    }
  }, []);

  async function startNewChat() {
    if (!welcomeInput.trim() || isCreatingThread || !resolvedOrgId) return;

    setIsCreatingThread(true);
    const msg = welcomeInput.trim();
    setWelcomeInput('');

    try {
      const thread = await createThreadAction({ firstMessage: msg });
      // Store in sessionStorage to survive component remount during navigation
      sessionStorage.setItem('pendingMessage', JSON.stringify({ message: msg, orgId: resolvedOrgId, threadId: thread.id }));
      router.push(`/chat/${thread.id}?newThread=1`);
    } catch (err) {
      setIsCreatingThread(false);
      setError('Failed to start a new chat');
      console.error('Failed to create thread:', err);
    }
  }

  function stopGeneration() {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      return;
    }
    wsRef.current.send(JSON.stringify({ type: 'stop' }));
  }

  function sendMessage() {
    if (!input.trim() || !shouldShowChat || !resolvedOrgId || !threadId) {
      return;
    }

    const userMessage = input.trim();
    setInput('');

    // Clear any previous error
    setError(null);

    // Add user message to state immediately (optimistic)
    const userMsg: Message = {
      id: `local_${Date.now()}`,
      thread_id: threadId,
      role: 'user',
      content: userMessage,
      created_at: Date.now(),
    };

    // Add user message - it naturally appears after any streaming message
    forceScrollOnNextUpdate.current = true;
    setMessages(prev => [...prev, userMsg]);

    // If WebSocket is connected and ready, send immediately
    if (wsRef.current?.readyState === WebSocket.OPEN && ready) {
      setLoading(true);
      wsRef.current.send(JSON.stringify({
        type: 'message',
        content: userMessage,
        sessionId: sessionIdRef.current,
        threadId,
      }));
    } else {
      // Queue the full message object for later delivery
      setPendingMessages(prev => [...prev, userMsg]);
      setLoading(true);

      // If not connected at all, trigger reconnect
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        connectWebSocketRef.current?.(threadId, true);
      }
      // If connected but not ready, the message will be sent when ready event arrives
    }
  }

  return (
    <TooltipProvider>
      <>
        <PageHeader
          breadcrumbs={
            shouldShowChat
              ? [
                  { label: 'Chat' },
                  { label: currentTitle?.trim() || 'Untitled Chat' },
                ]
              : [{ label: 'Home' }]
          }
        />

        {shouldShowChat ? (
          <div className="flex-1 flex min-h-0">
            {/* Chat Panel */}
            <div className={cn("flex flex-col min-h-0", deployedApp ? "w-1/2" : "flex-1")}>
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
                  {messages.map(msg => {
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
                  {loading && !isStreaming && (
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
              <div className="bg-background pt-2 pb-4 px-4">
                <div className="max-w-3xl mx-auto w-full">
                  <PromptInput
                    value={input}
                    onChange={setInput}
                    onSubmit={sendMessage}
                    onStop={stopGeneration}
                    placeholder="Type a message..."
                    isAssistantRunning={loading || isStreaming}
                    autoFocus
                  />
                </div>
              </div>
            </div>
            </div>

            {/* Deployed App Preview */}
            {deployedApp && (
              <div className="w-1/2 border-l border-border flex flex-col bg-background">
                <div className="flex items-center justify-between px-4 py-2 border-b border-border">
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 bg-green-500 rounded-full" />
                    <span className="text-sm font-medium">{deployedApp}.chiridion.ai</span>
                  </div>
                  <div className="flex items-center gap-1">
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
                            href={`https://${deployedApp}.chiridion.ai`}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            <ExternalLink className="h-4 w-4" />
                          </a>
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Open in new tab</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => setDeployedApp(null)}
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Close preview</TooltipContent>
                    </Tooltip>
                  </div>
                </div>
                <div className="flex-1">
                  <iframe
                    key={iframeKey}
                    src={`https://${deployedApp}.chiridion.ai`}
                    className="w-full h-full bg-white"
                    title="Deployed App Preview"
                  />
                </div>
              </div>
            )}
          </div>
        ) : (
          /* Welcome Screen */
          <div className="flex-1 flex flex-col items-center justify-center px-4">
            <div className="w-full max-w-3xl space-y-8">
              <div className="text-center">
                <h2 className="text-2xl font-semibold mb-2 text-foreground">Welcome to Chiridion</h2>
                <p className="text-muted-foreground">What would you like to explore today?</p>
              </div>

              <PromptInput
                value={welcomeInput}
                onChange={setWelcomeInput}
                onSubmit={startNewChat}
                placeholder="Ask anything..."
                isLoading={isCreatingThread}
                minHeight="80px"
                autoFocus
              />
            </div>
          </div>
        )}
      </>
    </TooltipProvider>
  );
}
