'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowDown, Copy, Check } from 'lucide-react';
import type { Thread, Message } from '@/types';
import { useAuth } from '@/contexts/AuthContext';
import { SidebarTrigger } from '@/components/ui/sidebar';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from '@/components/ui/breadcrumb';
import { PromptInput } from '@/components/prompt-input';
import { Button } from '@/components/ui/button';
import { MarkdownRenderer } from '@/components/markdown-renderer';
import { cn } from '@/lib/utils';

interface ChatProps {
  threadId?: string;
}

// Format timestamp to readable time (e.g., "12:25 PM")
function formatMessageTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

// SDK event content block types
interface TextBlock {
  type: 'text';
  text: string;
}

interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
}

interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
}

type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ThinkingBlock;

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
    };
    content_block?: {
      type: string;
      text?: string;
    };
  };
}

// Streaming state for partial messages
interface StreamingState {
  content: ContentBlock[];
  isStreaming: boolean;
}

export default function Chat({ threadId }: ChatProps) {
  const router = useRouter();
  const { user, currentOrg, orgs, loading: authLoading, logout, switchOrg } = useAuth();
  const [threads, setThreads] = useState<Thread[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [connected, setConnected] = useState(false);
  const [streaming, setStreaming] = useState<StreamingState>({ content: [], isStreaming: false });
  const [welcomeInput, setWelcomeInput] = useState('');
  const [isCreatingThread, setIsCreatingThread] = useState(false);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const isFirstMessage = useRef(true);
  const reconnectAttempts = useRef(0);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const intentionalClose = useRef(false);
  const pendingMessage = useRef<string | null>(null);

  // Redirect to login if not authenticated
  useEffect(() => {
    if (!authLoading && !user) {
      router.push('/login');
    }
  }, [authLoading, user, router]);

  const fetchThreads = useCallback(async () => {
    const res = await fetch('/api/threads');
    const data = await res.json() as unknown;
    setThreads(Array.isArray(data) ? (data as Thread[]) : []);
  }, []);

  useEffect(() => {
    if (user && currentOrg) {
      fetchThreads();
    }
  }, [user, currentOrg, fetchThreads]);

  // WebSocket connection management
  const connectWebSocket = useCallback((id: string, isReconnect = false) => {
    // Clear any pending reconnect
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    // Close existing connection
    if (wsRef.current) {
      intentionalClose.current = true;
      wsRef.current.close();
      wsRef.current = null;
    }

    setConnected(false);
    if (!isReconnect) {
      setMessages([]);
      isFirstMessage.current = true;
      reconnectAttempts.current = 0;
    }
    intentionalClose.current = false;

    // WebSocket is handled by the worker at /ws/{threadId} on the same origin as the page.
    const wsHost = window.location.host;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const org = currentOrg?.id || 'default';
    const wsUrl = `${protocol}//${wsHost}/ws/${id}?org=${org}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      // Ignore if this WebSocket was replaced
      if (wsRef.current !== ws) return;
      setConnected(true);
      reconnectAttempts.current = 0;

      // Send pending message if exists (from welcome screen)
      if (pendingMessage.current) {
        const msg = pendingMessage.current;
        pendingMessage.current = null;
        setLoading(true);
        setStreaming({ content: [], isStreaming: false });
        ws.send(JSON.stringify({
          type: 'message',
          content: msg,
          threadId: id,
          org: currentOrg?.id || 'default',
          autoTitle: true,
        }));
        isFirstMessage.current = false;
        setTimeout(fetchThreads, 500);
      }
    };

    ws.onmessage = (event) => {
      // Ignore messages from stale WebSocket instances (e.g., from StrictMode double-mount)
      if (wsRef.current !== ws) return;

      const data = JSON.parse(event.data);

      if (data.type === 'history') {
        // Initial message history - merge with existing on reconnect
        if (isReconnect) {
          setMessages(prev => {
            const existingIds = new Set(prev.map(m => m.id));
            const newMessages = data.messages.filter((m: Message) => !existingIds.has(m.id));
            return [...prev, ...newMessages];
          });
        } else {
          setMessages(data.messages);
        }
        isFirstMessage.current = data.messages.length === 0;
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
            // Just mark as streaming, don't add block yet - let delta handle it
            setStreaming(prev => ({ ...prev, isStreaming: true }));
          } else if (evt?.type === 'content_block_delta' && evt.delta?.type === 'text_delta' && evt.delta.text) {
            // Append or create text block
            setStreaming(prev => {
              const newContent = [...prev.content];
              const lastBlock = newContent[newContent.length - 1];
              if (lastBlock?.type === 'text') {
                // Append to existing text block
                newContent[newContent.length - 1] = {
                  ...lastBlock,
                  text: lastBlock.text + evt.delta!.text,
                };
              } else {
                // Create new text block
                newContent.push({ type: 'text', text: evt.delta!.text! });
              }
              return { ...prev, content: newContent };
            });
          } else if (evt?.type === 'message_delta' && evt.delta?.stop_reason) {
            // Message complete
            setStreaming(prev => ({ ...prev, isStreaming: false }));
          }
        } else if (sdkEvent.type === 'assistant' && sdkEvent.message?.content) {
          // Only use assistant events when streaming is done (has stop_reason)
          // During streaming, we use deltas for smoother updates
          if (sdkEvent.message!.stop_reason) {
            setStreaming(prev => ({
              ...prev,
              content: sdkEvent.message!.content,
              isStreaming: false,
            }));
          }
        } else if (sdkEvent.type === 'user' && sdkEvent.message?.content) {
          // Append user content blocks (tool_result) to current assistant content
          setStreaming(prev => ({
            ...prev,
            content: [...prev.content, ...sdkEvent.message!.content],
          }));
        } else if (sdkEvent.type === 'result') {
          // Result event received - streaming complete but wait for final message
          // Don't clear streaming content here - wait for 'message' event
          setStreaming(prev => ({ ...prev, isStreaming: false }));
        }
      } else if (data.type === 'message') {
        // Final message - clear streaming and add to messages
        setStreaming({ content: [], isStreaming: false });
        setMessages(prev => {
          if (prev.some(m => m.id === data.message.id)) return prev;
          return [...prev, data.message];
        });
        if (data.message.role === 'assistant') {
          setLoading(false);
        }
      } else if (data.type === 'error') {
        console.error('WebSocket error:', data.error);
        setStreaming({ content: [], isStreaming: false });
        setLoading(false);
      }
    };

    ws.onclose = () => {
      setConnected(false);
      wsRef.current = null;

      // Auto-reconnect if not intentional close
      if (!intentionalClose.current && id) {
        const maxAttempts = 5;
        if (reconnectAttempts.current < maxAttempts) {
          const delay = Math.min(1000 * Math.pow(2, reconnectAttempts.current), 30000);
          reconnectAttempts.current++;
          console.log(`WebSocket closed, reconnecting in ${delay}ms (attempt ${reconnectAttempts.current})`);
          reconnectTimeoutRef.current = setTimeout(() => {
            connectWebSocket(id, true);
          }, delay);
        }
      }
    };

    ws.onerror = () => {
      // Suppress errors from stale WebSocket instances (e.g., after switching chats)
      if (wsRef.current !== ws) return;
      const state = ws.readyState;
      const stateNames = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'];
      console.error(`WebSocket error: Connection to ${ws.url} failed (state: ${stateNames[state] || state}). Check that the server is running.`);
    };

  }, [currentOrg]);

  // Connect when threadId changes
  useEffect(() => {
    if (threadId) {
      connectWebSocket(threadId);
    } else {
      intentionalClose.current = true;
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      setMessages([]);
      setConnected(false);
    }

    return () => {
      intentionalClose.current = true;
      if (wsRef.current) {
        wsRef.current.close();
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
    };
  }, [threadId, connectWebSocket]);

  // Reconnect on visibility change (tab becomes visible)
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && threadId) {
        // Check if WebSocket is closed or closing
        if (!wsRef.current || wsRef.current.readyState === WebSocket.CLOSED || wsRef.current.readyState === WebSocket.CLOSING) {
          console.log('Tab visible, reconnecting WebSocket...');
          reconnectAttempts.current = 0;
          connectWebSocket(threadId, true);
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [threadId, connectWebSocket]);

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
    if (!welcomeInput.trim() || isCreatingThread) return;

    setIsCreatingThread(true);
    pendingMessage.current = welcomeInput.trim();
    setWelcomeInput('');

    try {
      const res = await fetch(`${backendProxyPrefix}/api/threads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      const thread = await res.json() as Thread;
      setThreads([thread, ...threads]);
      router.push(`/chat/${thread.id}`);
    } catch (error) {
      console.error('Failed to create thread:', error);
      pendingMessage.current = null;
      setIsCreatingThread(false);
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
    if (!input.trim() || !threadId || loading || !wsRef.current || !connected) return;

    const userMessage = input.trim();
    setInput('');
    setLoading(true);
    setStreaming({ content: [], isStreaming: false });

    // Send via WebSocket
    wsRef.current.send(JSON.stringify({
      type: 'message',
      content: userMessage,
      threadId: threadId,
      org: currentOrg?.id || 'default',
      autoTitle: isFirstMessage.current,
    }));

    if (isFirstMessage.current) {
      isFirstMessage.current = false;
      // Refresh thread list after a moment to get auto-generated title
      setTimeout(fetchThreads, 500);
    }
  }

  return (
    <TooltipProvider>
      <>
        {/* Sticky Header */}
        <header className="sticky top-0 z-30 shrink-0">
          {/* Header content */}
          <div className="flex h-12 items-center gap-2 px-4">
            <SidebarTrigger className="-ml-1" />
            <div
              data-orientation="vertical"
              role="none"
              className="bg-border shrink-0 w-px h-4 mr-2"
            />
            <Breadcrumb>
              <BreadcrumbList>
                <BreadcrumbItem>
                  <BreadcrumbPage>{threadId ? 'Chat' : 'New Chat'}</BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
          </div>
          {/* Gradient overlay that fades into content */}
          <div
            className="absolute inset-x-0 top-full h-6 bg-gradient-to-b from-background to-transparent pointer-events-none"
            aria-hidden="true"
          />
        </header>

        {threadId ? (
          <>
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
                            <MarkdownRenderer content={msg.content} />
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
                                  onClick={() => copyMessage(msg.id, msg.content)}
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
                            <MarkdownRenderer content={msg.content} />
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
                                  onClick={() => copyMessage(msg.id, msg.content)}
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
                    disabled={!connected}
                  />
                </div>
              </div>
            </div>
          </>
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
