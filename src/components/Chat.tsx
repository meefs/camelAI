'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowDown, Copy, Check, RefreshCw, ExternalLink, X } from 'lucide-react';
import type { Thread, Message, ContentBlock } from '@/types';
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
import { MarkdownRenderer } from '@/components/markdown-renderer';
import { cn } from '@/lib/utils';

interface ChatProps {
  threadId?: string;
  orgId: string;
  initialThreads?: Thread[];
  initialMessages?: Message[];
}

// Format timestamp to readable time (e.g., "12:25 PM")
function formatMessageTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

// Convert content to string for copy functionality
function contentToString(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .map(block => {
      if (block.type === 'text') return block.text;
      if (block.type === 'tool_use') return `[Tool: ${block.name}]\n${JSON.stringify(block.input, null, 2)}`;
      if (block.type === 'tool_result') return `[Result]\n${block.content}`;
      if (block.type === 'thinking') return `[Thinking]\n${block.thinking}`;
      return '';
    })
    .join('\n\n');
}

// Parse message content - handles both plain string and JSON-encoded ContentBlock[]
function parseMessageContent(content: string | ContentBlock[]): string | ContentBlock[] {
  // Already an array - return as-is
  if (Array.isArray(content)) return content;

  // Not a string - return as-is
  if (typeof content !== 'string') return content;

  // Try to parse as JSON array of content blocks
  const trimmed = content.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].type) {
        return parsed as ContentBlock[];
      }
    } catch {
      // Not valid JSON - fall through to return as string
    }
  }

  // Plain string content
  return content;
}

// Render content blocks with proper styling
function ContentBlockRenderer({ content, isStreaming = false }: { content: string | ContentBlock[]; isStreaming?: boolean }) {
  // String content - render as markdown
  if (typeof content === 'string') {
    return <MarkdownRenderer content={content} isStreaming={isStreaming} />;
  }

  // Array of content blocks - render each with proper styling
  return (
    <div className="space-y-4">
      {content.map((block, i) => (
        <div key={i}>
          {block.type === 'text' && (
            <div className="max-w-none">
              <MarkdownRenderer content={block.text} isStreaming={isStreaming} />
            </div>
          )}
          {block.type === 'thinking' && (
            <div className="bg-muted/50 border border-border px-4 py-3 rounded-xl">
              <div className="flex items-center gap-2 text-muted-foreground text-sm mb-2">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                </svg>
                <span className="font-medium">Thinking</span>
              </div>
              <p className="whitespace-pre-wrap text-muted-foreground text-sm">{block.thinking}</p>
            </div>
          )}
          {block.type === 'tool_use' && (
            <div className="bg-amber-500/10 border border-amber-500/20 px-4 py-3 rounded-xl">
              <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400 text-sm mb-2">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                <span className="font-mono font-medium">{block.name}</span>
              </div>
              <pre className="text-xs text-muted-foreground overflow-x-auto">{JSON.stringify(block.input, null, 2)}</pre>
            </div>
          )}
          {block.type === 'tool_result' && (
            <div className="bg-green-500/10 border border-green-500/20 px-4 py-3 rounded-xl">
              <div className="flex items-center gap-2 text-green-600 dark:text-green-400 text-sm mb-2">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                <span className="font-medium">Result</span>
              </div>
              <pre className="text-xs text-muted-foreground overflow-x-auto max-h-40">{block.content}</pre>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// SDK event types (ContentBlock imported from @/types)
interface SDKEvent {
  type: string;
  subtype?: string;
  message?: {
    content: ContentBlock[];
    stop_reason?: string | null;
  };
  result?: string;
  tool?: {
    name: string;
    input?: Record<string, unknown>;
  };
  // For stream_event types
  event?: {
    type: string;
    index?: number;
    delta?: {
      type?: string;
      text?: string;
      stop_reason?: string;
      partial_json?: string;
    };
    content_block?: {
      type: string;
      text?: string;
      id?: string;
      name?: string;
    };
  };
}

// Streaming state for partial messages
interface StreamingState {
  content: ContentBlock[];
  isStreaming: boolean;
}

export default function Chat({ threadId, orgId, initialThreads, initialMessages }: ChatProps) {
  const router = useRouter();
  const { user, currentOrg, orgs, loading: authLoading, logout, switchOrg } = useAuth();
  const parsedInitialMessages = useMemo(
    () => (initialMessages ?? []).map(msg => ({ ...msg, content: parseMessageContent(msg.content) })),
    [initialMessages]
  );
  const [threads, setThreads] = useState<Thread[]>(initialThreads ?? []);
  const [messages, setMessages] = useState<Message[]>(parsedInitialMessages);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false); // Container is ready to receive messages
  const [streaming, setStreaming] = useState<StreamingState>({ content: [], isStreaming: false });
  const [error, setError] = useState<string | null>(null);
  const [welcomeInput, setWelcomeInput] = useState('');
  const [isCreatingThread, setIsCreatingThread] = useState(false);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [deployedApp, setDeployedApp] = useState<string | null>(null);
  const [iframeKey, setIframeKey] = useState(0);
  const [iframeLoading, setIframeLoading] = useState(true);
  const previewVersionRef = useRef<number>(0);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const iframeRetryRef = useRef<NodeJS.Timeout | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const previewWsRef = useRef<WebSocket | null>(null);
  const previewReconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const previewReconnectAttempts = useRef(0);
  const isFirstMessage = useRef(true);
  const reconnectAttempts = useRef(0);
  const currentMessageUuidRef = useRef<string | null>(null); // Track SDK uuid for stable deduplication
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const lastEventIdRef = useRef(0);
  const initialMessagesRef = useRef<{ threadId?: string; messages: Message[] } | null>(
    initialMessages ? { threadId, messages: parsedInitialMessages } : null
  );
  const initialThreadsRef = useRef<Thread[] | null>(initialThreads ?? null);
  const initialThreadsOrgRef = useRef<string | null>(initialThreads ? orgId : null);

  useEffect(() => {
    if (initialMessages) {
      initialMessagesRef.current = { threadId, messages: parsedInitialMessages };
    }
  }, [initialMessages, parsedInitialMessages, threadId]);

  useEffect(() => {
    if (initialThreads) {
      initialThreadsRef.current = initialThreads;
      initialThreadsOrgRef.current = orgId;
    }
  }, [initialThreads, orgId]);
  // Track connection ID to ignore events from stale WebSocket instances
  const connectionIdRef = useRef(0);
  // Ref to hold stable connect function for effect
  const connectWebSocketRef = useRef<((id: string, isReconnect?: boolean) => void) | null>(null);
  // Queue message to send when connection becomes ready
  const pendingMessageRef = useRef<string | null>(null);
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

  const fetchThreads = useCallback(async () => {
    const res = await fetch('/api/threads');
    const data = await res.json() as unknown;
    setThreads(Array.isArray(data) ? (data as Thread[]) : []);
  }, []);

  useEffect(() => {
    if (user && resolvedOrgId) {
      if (initialThreadsRef.current && initialThreadsOrgRef.current === resolvedOrgId) {
        initialThreadsRef.current = null;
        return;
      }
      fetchThreads();
    }
  }, [user, resolvedOrgId, fetchThreads]);

  // Fetch messages from REST API
  const fetchMessages = useCallback(async (threadId: string, isReconnect = false) => {
    if (!isReconnect && initialMessagesRef.current?.threadId === threadId) {
      setMessages(initialMessagesRef.current.messages);
      isFirstMessage.current = initialMessagesRef.current.messages.length === 0;
      initialMessagesRef.current = null;
      return;
    }
    try {
      const res = await fetch(`/api/threads/${threadId}/messages`);
      if (res.ok) {
        const data = await res.json() as unknown;
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

        if (!isReconnect) {
          isFirstMessage.current = parsedMsgs.length === 0;
        }
      }
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

    // Close existing connection regardless of state
    // This prevents orphaned WebSockets from React StrictMode double-mounting
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    setReady(false);
    // Clear streaming state on any connection to prevent stale content
    setStreaming({ content: [], isStreaming: false });
    currentMessageUuidRef.current = null;
    if (!isReconnect) {
      isFirstMessage.current = true;
      reconnectAttempts.current = 0;
    }

    // Fetch existing messages from REST API unless we have a pending first message for this thread
    let shouldFetchMessages = true;
    const pendingPayload = sessionStorage.getItem('pendingMessage');
    if (pendingPayload) {
      try {
        const parsed = JSON.parse(pendingPayload) as { threadId?: string };
        if (parsed.threadId === id) {
          shouldFetchMessages = false;
        }
      } catch {
        // Ignore malformed pending payload and continue to fetch
      }
    }
    if (shouldFetchMessages) {
      fetchMessages(id, isReconnect);
    }

    // WebSocket connects at /ws/{org} - one container per org handles all threads
    const wsHost = window.location.host;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const orgIdForConnection = resolvedOrgId;
    const wsUrl = `${protocol}//${wsHost}/ws/${orgIdForConnection}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      // Ignore if this connection was superseded
      if (connectionIdRef.current !== thisConnectionId) {
        return;
      }
      reconnectAttempts.current = 0;

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

        // Send pending message if exists (from welcome screen or queued while disconnected)
        let storedMessage = pendingMessageRef.current;
        const storedPayload = sessionStorage.getItem('pendingMessage');
        if (storedPayload) {
          try {
            const parsed = JSON.parse(storedPayload) as { message?: string; orgId?: string; threadId?: string };
            if (parsed.orgId === resolvedOrgId && parsed.threadId === id && typeof parsed.message === 'string') {
              sessionStorage.removeItem('pendingMessage');
              storedMessage = parsed.message;
            }
          } catch (e) {
            console.warn('Failed to parse pending message:', e);
          }
        }
        pendingMessageRef.current = null;
        if (storedMessage) {

          // Add user message to local state immediately
          const userMsg: Message = {
            id: `local_${Date.now()}`,
            thread_id: id,
            role: 'user',
            content: storedMessage,
            created_at: Date.now(),
          };
          setMessages(prev => [...prev, userMsg]);

          setLoading(true);
          setStreaming({ content: [], isStreaming: false });
          ws.send(JSON.stringify({
            type: 'message',
            content: storedMessage,
            sessionId: sessionIdRef.current,
            threadId: id,
          }));
          isFirstMessage.current = false;
          setTimeout(fetchThreads, 500);
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

        if (sdkEvent.type === 'system' && sdkEvent.subtype === 'init') {
          // Session started - clear streaming state
          setStreaming({ content: [], isStreaming: true });
        } else if (sdkEvent.type === 'stream_event') {
          // Handle streaming deltas
          const evt = sdkEvent.event;
          if (evt?.type === 'content_block_start') {
            const block = evt.content_block;
            if (block?.type === 'tool_use') {
              // Add tool_use block immediately
              setStreaming(prev => ({
                ...prev,
                isStreaming: true,
                content: [...prev.content, {
                  type: 'tool_use' as const,
                  id: block.id || '',
                  name: block.name || '',
                  input: {},
                }],
              }));
            } else {
              // For text blocks, just mark as streaming - delta will add content
              setStreaming(prev => ({ ...prev, isStreaming: true }));
            }
          } else if (evt?.type === 'content_block_delta') {
            if (evt.delta?.type === 'text_delta' && evt.delta.text) {
              // Append text to current text block or create new one
              setStreaming(prev => {
                const newContent = [...prev.content];
                const lastBlock = newContent[newContent.length - 1];
                if (lastBlock?.type === 'text') {
                  newContent[newContent.length - 1] = {
                    ...lastBlock,
                    text: lastBlock.text + evt.delta!.text,
                  };
                } else {
                  newContent.push({ type: 'text', text: evt.delta!.text! });
                }
                return { ...prev, content: newContent };
              });
            } else if (evt.delta?.type === 'input_json_delta' && evt.delta.partial_json) {
              // Append to tool_use input (accumulate JSON string)
              setStreaming(prev => {
                const newContent = [...prev.content];
                const lastToolUse = [...newContent].reverse().find(b => b.type === 'tool_use');
                if (lastToolUse && lastToolUse.type === 'tool_use') {
                  const idx = newContent.indexOf(lastToolUse);
                  const currentInput = (lastToolUse as any)._inputJson || '';
                  newContent[idx] = {
                    ...lastToolUse,
                    _inputJson: currentInput + evt.delta!.partial_json,
                  } as any;
                }
                return { ...prev, content: newContent };
              });
            }
          } else if (evt?.type === 'content_block_stop') {
            // Finalize tool_use input JSON
            setStreaming(prev => {
              const newContent = prev.content.map(block => {
                if (block.type === 'tool_use' && (block as any)._inputJson) {
                  try {
                    const input = JSON.parse((block as any)._inputJson);
                    const { _inputJson, ...rest } = block as any;
                    return { ...rest, input };
                  } catch {
                    return block;
                  }
                }
                return block;
              });
              return { ...prev, content: newContent };
            });
          } else if (evt?.type === 'message_delta' && evt.delta?.stop_reason) {
            // Message streaming complete - just mark as not streaming
            // Keep content for the 'assistant' handler to merge tool_result blocks
            // The actual message will be added by the 'assistant' event handler
            // to avoid duplicate messages (race condition with timestamp-based IDs)
            setStreaming(prev => ({ ...prev, isStreaming: false }));
          }
        } else if (sdkEvent.type === 'assistant' && sdkEvent.message?.content) {
          // Track the SDK uuid for this message (stable across partial updates)
          const sdkUuid = (sdkEvent as { uuid?: string }).uuid;
          const sdkMsgId = (sdkEvent.message as { id?: string }).id;
          if (sdkUuid || sdkMsgId) {
            currentMessageUuidRef.current = sdkUuid || sdkMsgId || null;
          }

          // Use full assistant message content when complete
          if (sdkEvent.message!.stop_reason) {
            const msgId = currentMessageUuidRef.current;
            if (!msgId) {
              console.error('No stable message ID available');
              return;
            }
            const finalContent = [...sdkEvent.message!.content];

            setStreaming(prev => {
              // Include any tool_result blocks from streaming
              const content = [...prev.content.filter(b => b.type === 'tool_result'), ...finalContent];
              if (content.length > 0) {
                setMessages(msgs => {
                  // Check for duplicate using stable SDK ID
                  if (msgs.some(m => m.id === msgId)) return msgs;
                  return [...msgs, {
                    id: msgId,
                    thread_id: threadId || '',
                    role: 'assistant' as const,
                    content,
                    created_at: Date.now(),
                  }];
                });
              }
              return { content: [], isStreaming: false };
            });
            setLoading(false);
          }
        } else if (sdkEvent.type === 'user' && sdkEvent.message?.content) {
          // Append user content blocks (tool_result) to current content
          setStreaming(prev => ({
            ...prev,
            content: [...prev.content, ...sdkEvent.message!.content],
          }));
        } else if (sdkEvent.type === 'result') {
          // Query complete - add any remaining streaming content as fallback
          // (in case 'assistant' handler didn't fire or stop_reason wasn't set)
          const fallbackMsgId = currentMessageUuidRef.current;
          setStreaming(prev => {
            if (prev.content.length > 0 && fallbackMsgId) {
              // There's still content - assistant handler didn't add it
              setMessages(msgs => {
                // Use the tracked SDK uuid for deduplication
                if (msgs.some(m => m.id === fallbackMsgId)) return msgs;
                return [...msgs, {
                  id: fallbackMsgId,
                  thread_id: threadId || '',
                  role: 'assistant' as const,
                  content: prev.content,
                  created_at: Date.now(),
                }];
              });
            }
            return { content: [], isStreaming: false };
          });
          // Reset the uuid ref for next message
          currentMessageUuidRef.current = null;
          setLoading(false);
        }
      } else if (data.type === 'error') {
        console.error('WebSocket error:', data.error);
        setError(data.error || 'An unknown error occurred');
        setStreaming({ content: [], isStreaming: false });
        setLoading(false);
      }
    };

    ws.onclose = () => {
      // Ignore if this connection was superseded by a new one
      if (connectionIdRef.current !== thisConnectionId) {
        return;
      }

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

  }, [currentOrg, fetchMessages, fetchThreads]);

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

      if (iframeRetryRef.current) {
        clearTimeout(iframeRetryRef.current);
        iframeRetryRef.current = null;
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

    if (!isReconnect) {
      previewReconnectAttempts.current = 0;
    }

    const wsHost = window.location.host;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${wsHost}/ws/thread/${id}`;
    const ws = new WebSocket(wsUrl);
    previewWsRef.current = ws;

    ws.onopen = () => {
      previewReconnectAttempts.current = 0;
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
          if (firstWorker) {
            setIframeLoading(true);
            // Force iframe refresh on new deploy by changing key
            if (isNewDeploy) {
              setIframeKey(prev => prev + 1);
            }
          }
        }
      } catch (e) {
        console.error('Preview WebSocket message parse error:', e);
      }
    };

    ws.onclose = () => {
      if (previewWsRef.current !== ws) return; // Ignore stale connections
      previewWsRef.current = null;

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
        setMessages([]);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Handle scroll position tracking
  const handleScroll = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const { scrollTop, scrollHeight, clientHeight } = container;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    setShowScrollButton(distanceFromBottom > 100);
  }, []);

  // Auto-scroll on new messages (only if near bottom)
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      return;
    }

    const { scrollTop, scrollHeight, clientHeight } = container;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;

    // Only auto-scroll if user is near bottom (within 150px)
    if (distanceFromBottom < 150) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, streaming.content]);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  const copyMessage = useCallback(async (messageId: string, content: string) => {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedMessageId(messageId);
      setTimeout(() => setCopiedMessageId(null), 2000);
    } catch (err) {
      console.error('Failed to copy message:', err);
    }
  }, []);

  async function createThread() {
    const res = await fetch('/api/threads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    const thread = await res.json() as Thread;
    setThreads([thread, ...threads]);
    router.push(`/chat/${thread.id}`);
  }

  async function startNewChat() {
    if (!welcomeInput.trim() || isCreatingThread || !resolvedOrgId) return;

    setIsCreatingThread(true);
    const msg = welcomeInput.trim();
    const newThreadId = crypto.randomUUID();
    // Store in sessionStorage to survive component remount during navigation
    sessionStorage.setItem('pendingMessage', JSON.stringify({ message: msg, orgId: resolvedOrgId, threadId: newThreadId }));
    setWelcomeInput('');

    try {
      const res = await fetch('/api/threads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: newThreadId }),
      });
      if (!res.ok) {
        throw new Error(`Failed to create thread (${res.status})`);
      }
      const thread = await res.json() as Thread;
      router.push(`/chat/${thread?.id || newThreadId}`);
    } catch (err) {
      sessionStorage.removeItem('pendingMessage');
      setIsCreatingThread(false);
      setError('Failed to start a new chat');
      console.error('Failed to create thread:', err);
    }
  }

  async function deleteThread(id: string, e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    await fetch(`/api/threads/${id}`, { method: 'DELETE' });
    setThreads(threads.filter(t => t.id !== id));
    if (threadId === id) {
      router.push('/');
    }
  }

  function sendMessage() {
    if (!input.trim() || !shouldShowChat || loading || !resolvedOrgId) {
      return;
    }

    const userMessage = input.trim();
    setInput('');

    // Clear any previous error
    setError(null);

    // Add user message to local state immediately
    const userMsg: Message = {
      id: `local_${Date.now()}`,
      thread_id: threadId || '',
      role: 'user',
      content: userMessage,
      created_at: Date.now(),
    };
    setMessages(prev => [...prev, userMsg]);

    // If WebSocket is connected and ready, send immediately
    if (wsRef.current?.readyState === WebSocket.OPEN && ready) {
      setLoading(true);
      setStreaming({ content: [], isStreaming: false });
      wsRef.current.send(JSON.stringify({
        type: 'message',
        content: userMessage,
        sessionId: sessionIdRef.current,
        threadId,
      }));

      if (isFirstMessage.current) {
        isFirstMessage.current = false;
        setTimeout(fetchThreads, 500);
      }
    } else {
      // Queue the message and trigger reconnect
      pendingMessageRef.current = userMessage;
      setLoading(true);

      // If not connected at all, trigger reconnect
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        if (threadId) {
          connectWebSocketRef.current?.(threadId, true);
        }
      }
      // If connected but not ready, the message will be sent when ready event arrives
    }
  }

  return (
    <TooltipProvider>
      <>
        <PageHeader breadcrumbs={[{ label: shouldShowChat ? 'Chat' : 'Home' }]} />

        {shouldShowChat ? (
          <div className="flex-1 flex min-h-0">
            {/* Chat Panel */}
            <div className={cn("flex flex-col min-h-0", deployedApp ? "w-1/2" : "flex-1")}>
            {/* Chat Body - Single Scroll Container */}
            <div
              ref={scrollContainerRef}
              onScroll={handleScroll}
              className="flex-1 overflow-y-auto overflow-x-hidden"
            >
              {/* Centered message column */}
              <div className="max-w-3xl mx-auto w-full px-4 md:px-6 pt-2 pb-6 space-y-6">
                  {messages.map(msg => (
                    <div key={msg.id} className={cn("group", msg.role === 'user' ? "mt-6 mb-1" : "")}>
                      {msg.role === 'user' ? (
                        /* User message - right aligned with bubble and hover actions */
                        <div className="flex flex-col items-end gap-1">
                          <div className="max-w-[85%] px-4 py-3 rounded-3xl border border-border bg-muted/30 text-foreground">
                            <ContentBlockRenderer content={msg.content} />
                          </div>
                          {/* Hover action row */}
                          <div
                            className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity"
                            role="group"
                            aria-label="Message actions"
                          >
                            <span className="text-muted-foreground text-xs mr-1">
                              {formatMessageTime(msg.created_at)}
                            </span>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  className="text-muted-foreground"
                                  onClick={() => copyMessage(msg.id, contentToString(msg.content))}
                                >
                                  {copiedMessageId === msg.id ? <Check /> : <Copy />}
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent side="bottom">
                                {copiedMessageId === msg.id ? 'Copied!' : 'Copy message'}
                              </TooltipContent>
                            </Tooltip>
                          </div>
                        </div>
                      ) : (
                        /* Assistant message - full width, no bubble, with hover actions */
                        <div className="flex flex-col gap-1">
                          <div className="max-w-none">
                            <ContentBlockRenderer content={msg.content} />
                          </div>
                          {/* Hover action row */}
                          <div
                            className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity"
                            role="group"
                            aria-label="Message actions"
                          >
                            <span className="text-muted-foreground text-xs mr-1">
                              {formatMessageTime(msg.created_at)}
                            </span>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  className="text-muted-foreground"
                                  onClick={() => copyMessage(msg.id, contentToString(msg.content))}
                                >
                                  {copiedMessageId === msg.id ? <Check /> : <Copy />}
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent side="bottom">
                                {copiedMessageId === msg.id ? 'Copied!' : 'Copy message'}
                              </TooltipContent>
                            </Tooltip>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}

                  {/* Streaming content */}
                  {streaming.content.length > 0 && (
                    <div className="space-y-4">
                      {streaming.content.map((block, i) => (
                        <div key={i}>
                          {block.type === 'text' && (
                            <div className="max-w-none">
                              <MarkdownRenderer content={block.text} isStreaming={streaming.isStreaming} />
                            </div>
                          )}
                          {block.type === 'thinking' && (
                            <div className="bg-muted/50 border border-border px-4 py-3 rounded-xl">
                              <div className="flex items-center gap-2 text-muted-foreground text-sm mb-2">
                                <svg className="w-4 h-4 animate-pulse" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                                </svg>
                                <span className="font-medium">Thinking...</span>
                              </div>
                              <p className="whitespace-pre-wrap text-muted-foreground text-sm">{block.thinking}</p>
                            </div>
                          )}
                          {block.type === 'tool_use' && (
                            <div className="bg-amber-500/10 border border-amber-500/20 px-4 py-3 rounded-xl">
                              <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400 text-sm mb-2">
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                </svg>
                                <span className="font-mono font-medium">{block.name}</span>
                              </div>
                              <pre className="text-xs text-muted-foreground overflow-x-auto">{JSON.stringify(block.input, null, 2)}</pre>
                            </div>
                          )}
                          {block.type === 'tool_result' && (
                            <div className="bg-green-500/10 border border-green-500/20 px-4 py-3 rounded-xl">
                              <div className="flex items-center gap-2 text-green-600 dark:text-green-400 text-sm mb-2">
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                </svg>
                                <span className="font-medium">Result</span>
                              </div>
                              <pre className="text-xs text-muted-foreground overflow-x-auto max-h-40">{block.content}</pre>
                            </div>
                          )}
                        </div>
                      ))}
                      {streaming.isStreaming && (
                        <div className="flex gap-1 py-2">
                          <div className="w-2 h-2 bg-muted-foreground/50 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                          <div className="w-2 h-2 bg-muted-foreground/50 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                          <div className="w-2 h-2 bg-muted-foreground/50 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                        </div>
                      )}
                    </div>
                  )}

                  {/* Loading indicator (when no streaming content yet) */}
                  {loading && streaming.content.length === 0 && (
                    <div className="flex gap-1 py-2">
                      <div className="w-2 h-2 bg-muted-foreground/50 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                      <div className="w-2 h-2 bg-muted-foreground/50 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                      <div className="w-2 h-2 bg-muted-foreground/50 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                    </div>
                  )}

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
                  <div ref={messagesEndRef} />
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
                  onClick={scrollToBottom}
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
                    placeholder="Type a message..."
                    isLoading={loading}
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
                    {iframeLoading ? (
                      <div className="w-2 h-2 bg-yellow-500 rounded-full animate-pulse" />
                    ) : (
                      <div className="w-2 h-2 bg-green-500 rounded-full" />
                    )}
                    <span className="text-sm font-medium">{deployedApp}.chiridion.ai</span>
                    {iframeLoading && <span className="text-xs text-muted-foreground">Loading...</span>}
                  </div>
                  <div className="flex items-center gap-1">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => {
                            setIframeLoading(true);
                            setIframeKey(prev => prev + 1);
                          }}
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
                          onClick={() => {
                            if (iframeRetryRef.current) {
                              clearTimeout(iframeRetryRef.current);
                              iframeRetryRef.current = null;
                            }
                            setDeployedApp(null);
                            setIframeLoading(true);
                          }}
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Close preview</TooltipContent>
                    </Tooltip>
                  </div>
                </div>
                <div className="flex-1 relative">
                  {iframeLoading && (
                    <div className="absolute inset-0 flex items-center justify-center bg-background">
                      <div className="text-center">
                        <div className="flex gap-1 justify-center mb-2">
                          <div className="w-2 h-2 bg-muted-foreground/50 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                          <div className="w-2 h-2 bg-muted-foreground/50 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                          <div className="w-2 h-2 bg-muted-foreground/50 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                        </div>
                        <p className="text-sm text-muted-foreground">Waiting for worker to be ready...</p>
                      </div>
                    </div>
                  )}
                  <iframe
                    key={iframeKey}
                    src={`https://${deployedApp}.chiridion.ai`}
                    className="w-full h-full bg-white"
                    title="Deployed App Preview"
                    onLoad={() => setIframeLoading(false)}
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
              />
            </div>
          </div>
        )}
      </>
    </TooltipProvider>
  );
}
