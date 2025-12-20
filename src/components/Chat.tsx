'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import type { Thread, Message } from '@/types';
import { useAuth } from '@/contexts/AuthContext';
import { AppSidebar } from '@/components/sidebar/app-sidebar';
import { SidebarProvider, SidebarInset, SidebarTrigger } from '@/components/ui/sidebar';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from '@/components/ui/breadcrumb';

interface ChatProps {
  threadId?: string;
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
  const { user, currentOrg, loading: authLoading } = useAuth();
  const backendProxyPrefix = '';
  const [threads, setThreads] = useState<Thread[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [connected, setConnected] = useState(false);
  const [streaming, setStreaming] = useState<StreamingState>({ content: [], isStreaming: false });
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const isFirstMessage = useRef(true);
  const reconnectAttempts = useRef(0);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const intentionalClose = useRef(false);

  // Redirect to login if not authenticated
  useEffect(() => {
    if (!authLoading && !user) {
      router.push('/login');
    }
  }, [authLoading, user, router]);

  const fetchThreads = useCallback(async () => {
    const res = await fetch(`${backendProxyPrefix}/api/threads`);
    const data = await res.json() as unknown;
    setThreads(Array.isArray(data) ? (data as Thread[]) : []);
  }, [backendProxyPrefix]);

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

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function createThread() {
    const res = await fetch(`${backendProxyPrefix}/api/threads`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    const thread = await res.json() as Thread;
    setThreads([thread, ...threads]);
    router.push(`/chat/${thread.id}`);
  }

  async function deleteThread(id: string, e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    await fetch(`${backendProxyPrefix}/api/threads/${id}`, { method: 'DELETE' });
    setThreads(threads.filter(t => t.id !== id));
    if (threadId === id) {
      router.push('/');
    }
  }

  function sendMessage(e: React.FormEvent) {
    e.preventDefault();
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
      <SidebarProvider>
        <AppSidebar threadId={threadId} />
        <SidebarInset>
          {/* Header with sidebar trigger */}
          <header className="flex h-16 shrink-0 items-center gap-2 border-b border-border">
            <div className="flex items-center gap-2 px-4">
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
          </header>

          {/* Main Chat Area */}
          <div className="flex-1 flex flex-col">
            {threadId ? (
              <>
                {/* Messages */}
                <div className="flex-1 overflow-y-auto p-4 space-y-4">
                  {messages.map(msg => (
                    <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                      <div className={`max-w-2xl px-4 py-3 rounded-2xl ${msg.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}>
                        <p className="whitespace-pre-wrap">{msg.content}</p>
                      </div>
                    </div>
                  ))}

                  {/* Streaming content */}
                  {streaming.content.length > 0 && (
                    <div className="flex justify-start">
                      <div className="max-w-2xl space-y-2">
                        {streaming.content.map((block, i) => (
                          <div key={i}>
                            {block.type === 'text' && (
                              <div className="bg-muted px-4 py-3 rounded-2xl">
                                <p className="whitespace-pre-wrap">{block.text}</p>
                              </div>
                            )}
                            {block.type === 'thinking' && (
                              <div className="bg-card border border-border px-4 py-3 rounded-2xl">
                                <div className="flex items-center gap-2 text-muted-foreground text-sm mb-1">
                                  <svg className="w-4 h-4 animate-pulse" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                                  </svg>
                                  <span>Thinking...</span>
                                </div>
                                <p className="whitespace-pre-wrap text-muted-foreground text-sm">{block.thinking}</p>
                              </div>
                            )}
                            {block.type === 'tool_use' && (
                              <div className="bg-amber-950/50 border border-amber-800/50 px-4 py-3 rounded-2xl dark:bg-amber-950/50 dark:border-amber-800/50">
                                <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400 text-sm mb-1">
                                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                  </svg>
                                  <span className="font-mono">{block.name}</span>
                                </div>
                                <pre className="text-xs text-muted-foreground overflow-x-auto">{JSON.stringify(block.input, null, 2)}</pre>
                              </div>
                            )}
                            {block.type === 'tool_result' && (
                              <div className="bg-green-950/50 border border-green-800/50 px-4 py-3 rounded-2xl dark:bg-green-950/50 dark:border-green-800/50">
                                <div className="flex items-center gap-2 text-green-600 dark:text-green-400 text-sm mb-1">
                                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                  </svg>
                                  <span>Result</span>
                                </div>
                                <pre className="text-xs text-muted-foreground overflow-x-auto max-h-40">{block.content}</pre>
                              </div>
                            )}
                          </div>
                        ))}
                        {streaming.isStreaming && (
                          <div className="flex gap-1 px-4 py-2">
                            <div className="w-2 h-2 bg-muted-foreground rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                            <div className="w-2 h-2 bg-muted-foreground rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                            <div className="w-2 h-2 bg-muted-foreground rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Loading indicator (when no streaming content yet) */}
                  {loading && streaming.content.length === 0 && (
                    <div className="flex justify-start">
                      <div className="bg-muted px-4 py-3 rounded-2xl">
                        <div className="flex gap-1">
                          <div className="w-2 h-2 bg-muted-foreground rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                          <div className="w-2 h-2 bg-muted-foreground rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                          <div className="w-2 h-2 bg-muted-foreground rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                        </div>
                      </div>
                    </div>
                  )}
                  <div ref={messagesEndRef} />
                </div>

                {/* Input */}
                <form onSubmit={sendMessage} className="p-4 border-t border-border">
                  <div className="flex gap-3 items-center">
                    <div className={`w-2 h-2 rounded-full ${connected ? 'bg-green-500' : 'bg-muted-foreground animate-pulse'}`} title={connected ? 'Connected' : 'Connecting...'} />
                    <input
                      type="text"
                      value={input}
                      onChange={e => setInput(e.target.value)}
                      placeholder={connected ? 'Type a message...' : 'Connecting...'}
                      className="flex-1 bg-muted border border-input rounded-xl px-4 py-3 outline-none focus:border-ring transition"
                      disabled={loading || !connected}
                    />
                    <button
                      type="submit"
                      disabled={loading || !input.trim() || !connected}
                      className="px-6 py-3 bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl font-medium transition"
                    >
                      Send
                    </button>
                  </div>
                </form>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center text-muted-foreground">
                <div className="text-center">
                  <h2 className="text-2xl font-semibold mb-2 text-foreground">Welcome to Chiridion</h2>
                  <p>Select a conversation or start a new chat</p>
                </div>
              </div>
            )}
          </div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}
