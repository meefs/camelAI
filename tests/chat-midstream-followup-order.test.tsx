import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

const messageBubbleRenderCounts = vi.hoisted(() => new Map<string, number>());
const mockNavigate = vi.fn();
const mockRevalidate = vi.fn();
let mockLocation = { pathname: '/', search: '', hash: '', state: null as unknown, key: 'default' };

function createFetcher() {
  return {
    state: 'idle' as const,
    data: undefined,
    formData: undefined,
    submit: vi.fn(),
  };
}

vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useLocation: () => mockLocation,
    useRevalidator: () => ({ state: 'idle' as const, revalidate: mockRevalidate }),
    useFetcher: () => createFetcher(),
  };
});

vi.mock('sonner', () => ({
  toast: { error: vi.fn() },
}));

vi.mock('@/hooks/use-auth-data', () => ({
  useAuthData: () => ({
    user: { id: 'user-1', name: 'Miguel' },
    currentWorkspace: { id: 'ws-1', name: 'Workspace 1' },
    currentOrg: { id: 'org-1', name: 'Org 1' },
    orgs: [{ org_id: 'org-1', role: 'owner' }],
  }),
}));

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => false,
}));

vi.mock('@/components/page-header', () => ({
  PageHeader: () => <div data-testid="page-header" />,
}));

vi.mock('@/components/prompt-input', () => ({
  PromptInput: ({ value, onChange, onSubmit }: { value: string; onChange: (value: string) => void; onSubmit: () => void }) => (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <input
        aria-label="Prompt"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      <button type="submit">Send</button>
    </form>
  ),
}));

vi.mock('@/components/message-bubble', async () => {
  const ReactActual = await vi.importActual<typeof import('react')>('react');
  const MockMessageBubbleBase = ({
    message,
    showStreamingIndicator,
  }: {
    message: { id?: string; role: string; content: unknown };
    showStreamingIndicator?: boolean;
  }) => {
    if (message.id) {
      messageBubbleRenderCounts.set(
        message.id,
        (messageBubbleRenderCounts.get(message.id) ?? 0) + 1,
      );
    }

    const renderedContent = typeof message.content === 'string'
      ? message.content
      : Array.isArray(message.content)
        ? message.content
            .map((block) => {
              if (!block || typeof block !== 'object' || !("type" in block)) return '';
              const typedBlock = block as { type: string; text?: string };
              if (typedBlock.type === 'text') return typedBlock.text ?? '';
              return `[${typedBlock.type}]`;
            })
            .filter(Boolean)
            .join(' ')
        : '';

    return (
      <div data-testid="chat-bubble">
        {`${message.role}: ${renderedContent}`}
        {showStreamingIndicator ? <div data-testid="inline-loading-dots" /> : null}
      </div>
    );
  };

  return {
    MessageBubble: ReactActual.memo(
      MockMessageBubbleBase,
      (prev, next) =>
        prev.message === next.message &&
        prev.showStreamingIndicator === next.showStreamingIndicator,
    ),
    isInterruptMessage: () => false,
    parseSlashCommand: () => null,
    parseLocalCommandStdout: () => null,
    userFacingContentToString: (content: string | Array<{ type: string; text?: string }>) => {
      if (typeof content === 'string') return content.trim();
      return content
        .map((block) => (block.type === 'text' ? block.text?.trim() ?? '' : ''))
        .filter(Boolean)
        .join('\n\n');
    },
  };
});

vi.mock('@/components/loading-dots', () => ({
  LoadingDots: () => <div data-testid="global-loading-dots" />,
}));

vi.mock('@/components/welcome-screen', () => ({
  WelcomeScreen: () => <div data-testid="welcome-screen" />,
}));

vi.mock('@/components/floating-todo', () => ({
  FloatingTodoList: () => null,
}));

vi.mock('@/components/ask-user-question', () => ({
  AskUserQuestion: () => null,
}));

vi.mock('@/components/connection-setup-prompt', () => ({
  ConnectionSetupPrompt: () => null,
}));

vi.mock('@/components/bug-report-dialog', () => ({
  BugReportDialog: () => null,
}));

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: React.ComponentProps<'button'>) => <button {...props}>{children}</button>,
}));

vi.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/components/ui/tabs', () => ({
  Tabs: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TabsList: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TabsTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/components/ui/resizable', () => ({
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ResizablePanel: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ResizableHandle: () => null,
}));

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuRadioGroup: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuRadioItem: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import Chat from '@/components/Chat';

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  static instances: MockWebSocket[] = [];

  readonly url: string;
  readyState = MockWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  send = vi.fn();

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  close = vi.fn(() => {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent('close'));
  });

  emitOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  emitMessage(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent);
  }
}

function getMainSocket(): MockWebSocket {
  const socket = MockWebSocket.instances.find((candidate) => candidate.url.includes('/ws/runner/ws-1'));
  if (!socket) throw new Error('Main chat WebSocket was not created');
  return socket;
}

function emitStreamTextPart(socket: MockWebSocket, messageId: string, text: string) {
  socket.emitMessage({
    type: 'sdk_event',
    event: {
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: { id: messageId },
      },
    },
  });

  socket.emitMessage({
    type: 'sdk_event',
    event: {
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
    },
  });

  socket.emitMessage({
    type: 'sdk_event',
    event: {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text },
      },
    },
  });
}

function emitStreamTextDelta(socket: MockWebSocket, text: string) {
  socket.emitMessage({
    type: 'sdk_event',
    event: {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text },
      },
    },
  });
}

function emitCodexTextDelta(socket: MockWebSocket, itemId: string, text: string) {
  socket.emitMessage({
    type: 'runtime_event',
    event: {
      method: 'item/agentMessage/delta',
      params: {
        itemId,
        delta: text,
      },
    },
  });
}

function buildMixedMarkdownDelta(index: number): string {
  return [
    '',
    `## Section ${index}`,
    '',
    `Paragraph ${index} with **bold**, _italic_, inline \`code_${index}\`, and [a link](https://example.com/${index}).`,
    '',
    `- Bullet ${index}.1`,
    `- Bullet ${index}.2`,
    `  - Nested bullet ${index}.2.a`,
    '',
    `1. Ordered ${index}.1`,
    `2. Ordered ${index}.2`,
    '',
    `> Quote ${index}`,
    '',
    '| Name | Value |',
    '| --- | ---: |',
    `| alpha-${index} | ${index} |`,
    '',
    '```tsx',
    `export function Example${index}() {`,
    `  return <button data-index="${index}">Run ${index}</button>;`,
    '}',
    '```',
    '',
  ].join('\n');
}

function getTranscriptRows(): string[] {
  const region = screen.getByRole('region', { name: 'Chat messages' });
  const rows = region.querySelectorAll('[data-message-id]');
  return Array.from(rows).map((row) => row.textContent?.replace(/\s+/g, ' ').trim() ?? '');
}

const OriginalWebSocket = globalThis.WebSocket;
const OriginalFetch = globalThis.fetch;

beforeAll(() => {
  if (!HTMLElement.prototype.scrollTo) {
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      value: vi.fn(),
      writable: true,
    });
  }
  if (!HTMLElement.prototype.scrollIntoView) {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      value: vi.fn(),
      writable: true,
    });
  }
});

beforeEach(() => {
  MockWebSocket.instances = [];
  messageBubbleRenderCounts.clear();
  vi.clearAllMocks();
  mockLocation = { pathname: '/', search: '', hash: '', state: null, key: 'default' };
  localStorage.clear();
  sessionStorage.clear();
  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  globalThis.fetch = vi.fn().mockImplementation(() => Promise.resolve(
    new Response(JSON.stringify({ messages: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  )) as unknown as typeof fetch;
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.WebSocket = OriginalWebSocket;
  globalThis.fetch = OriginalFetch;
});

describe('Chat mid-stream follow-up ordering', () => {
  it('keeps streaming bursts within a deterministic render budget', async () => {
    vi.useFakeTimers();
    const initialMessages = Array.from({ length: 80 }, (_, index) => ({
      id: `history-${index}`,
      thread_id: 'thread-1',
      role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
      content: `history ${index}`,
      created_at: index + 1,
    }));

    render(
      <Chat
        threadId="thread-1"
        workspaceId="ws-1"
        initialMessages={initialMessages}
      />,
    );

    const mainSocket = getMainSocket();

    await act(async () => {
      mainSocket.emitOpen();
      mainSocket.emitMessage({ type: 'ready' });
    });

    expect(screen.getByText('user: history 0')).toBeInTheDocument();
    expect(screen.getByText('assistant: history 79')).toBeInTheDocument();
    expect(
      screen.getByRole('region', { name: 'Chat messages' }).querySelector(
        '[data-message-id="history-0"]',
      ),
    ).toHaveStyle({ contain: 'layout paint style' });

    messageBubbleRenderCounts.clear();

    await act(async () => {
      emitStreamTextPart(mainSocket, 'assistant-perf', '# Streaming report\n');
      for (let index = 0; index < 40; index += 1) {
        emitStreamTextDelta(mainSocket, buildMixedMarkdownDelta(index));
      }
    });

    expect(messageBubbleRenderCounts.get('assistant-perf')).toBe(1);
    for (const message of initialMessages) {
      expect(messageBubbleRenderCounts.get(message.id)).toBeUndefined();
    }

    await act(async () => {
      vi.advanceTimersByTime(50);
    });

    expect(messageBubbleRenderCounts.get('assistant-perf')).toBe(2);
    for (const message of initialMessages) {
      expect(messageBubbleRenderCounts.get(message.id)).toBeUndefined();
    }

    expect(screen.getByText(/assistant: # Streaming report/)).toBeInTheDocument();
    expect(screen.getByText(/export function Example39/)).toBeInTheDocument();
  });

  it('keeps the first navigation message visible while the assistant starts streaming', async () => {
    mockLocation = {
      pathname: '/chat/thread-1',
      search: '?newThread=1',
      hash: '',
      state: { initialMessageContent: 'write a long poem' },
      key: 'new-thread',
    };

    const { rerender } = render(
      <Chat
        threadId="thread-1"
        workspaceId="ws-1"
        isNewThread
        initialMessages={[]}
      />,
    );

    const mainSocket = getMainSocket();
    await act(async () => {
      mainSocket.emitOpen();
      mainSocket.emitMessage({ type: 'ready' });
    });

    await waitFor(() => {
      expect(screen.getByText('user: write a long poem')).toBeInTheDocument();
      expect(mainSocket.send).toHaveBeenCalledWith(
        expect.stringContaining('write a long poem'),
      );
    });

    rerender(
      <Chat
        threadId="thread-1"
        workspaceId="ws-1"
        isNewThread
        initialMessages={[]}
      />,
    );

    await act(async () => {
      emitStreamTextPart(mainSocket, 'assistant-1', 'Line one');
    });

    await waitFor(() => {
      expect(getTranscriptRows()).toEqual([
        'user: write a long poem',
        'assistant: Line one',
      ]);
    });

    await act(async () => {
      mainSocket.emitMessage({ type: 'streaming_state', isStreaming: false });
      mainSocket.emitMessage({ type: 'result' });
    });

    rerender(
      <Chat
        threadId="thread-1"
        workspaceId="ws-1"
        initialMessages={[
          {
            id: 'server-user-1',
            thread_id: 'thread-1',
            role: 'user',
            content: 'write a long poem',
            created_at: 1,
          },
          {
            id: 'server-assistant-1',
            thread_id: 'thread-1',
            role: 'assistant',
            content: 'Line one',
            created_at: 2,
          },
        ]}
      />,
    );

    await waitFor(() => {
      expect(screen.getAllByText('user: write a long poem')).toHaveLength(1);
      expect(screen.getAllByText('assistant: Line one')).toHaveLength(1);
    });
  });

  it('uses route history as the source of truth for new threads', async () => {
    const { rerender } = render(
      <Chat
        threadId="thread-1"
        workspaceId="ws-1"
        isNewThread
        initialMessages={[]}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText('user: first message')).not.toBeInTheDocument();
      expect(screen.queryByText('assistant: assistant response')).not.toBeInTheDocument();
    });

    rerender(
      <Chat
        threadId="thread-1"
        workspaceId="ws-1"
        initialMessages={[
          {
            id: 'server-user-1',
            thread_id: 'thread-1',
            role: 'user',
            content: 'first message',
            created_at: 1,
          },
        ]}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('user: first message')).toBeInTheDocument();
      expect(screen.queryByText('assistant: assistant response')).not.toBeInTheDocument();
    });

    rerender(
      <Chat
        threadId="thread-1"
        workspaceId="ws-1"
        initialMessages={[
          {
            id: 'server-user-1',
            thread_id: 'thread-1',
            role: 'user',
            content: 'first message',
            created_at: 1,
          },
          {
            id: 'server-assistant-1',
            thread_id: 'thread-1',
            role: 'assistant',
            content: 'assistant response',
            created_at: 2,
          },
        ]}
      />,
    );

    await waitFor(() => {
      expect(screen.getAllByText('user: first message')).toHaveLength(1);
      expect(screen.getAllByText('assistant: assistant response')).toHaveLength(1);
    });
  });

  it('syncs route-loaded history when initial messages arrive after an empty render', async () => {
    const { rerender } = render(
      <Chat
        threadId="thread-1"
        workspaceId="ws-1"
        initialMessages={[]}
      />
    );

    rerender(
      <Chat
        threadId="thread-1"
        workspaceId="ws-1"
        initialMessages={[
          {
            id: 'message-1',
            thread_id: 'thread-1',
            role: 'user',
            content: 'Loaded question',
            created_at: 1,
          },
        ]}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('user: Loaded question')).toBeInTheDocument();
    });
  });

  it('splits assistant output at the next part when user follows up mid-stream', async () => {
    const user = userEvent.setup();

    render(
      <Chat
        threadId="thread-1"
        workspaceId="ws-1"
        initialMessages={[]}
      />
    );

    const mainSocket = getMainSocket();

    await act(async () => {
      mainSocket.emitOpen();
      mainSocket.emitMessage({ type: 'ready' });
      emitStreamTextPart(mainSocket, 'assistant-part-1', 'Part one');
    });

    await waitFor(() => {
      expect(screen.queryByTestId('global-loading-dots')).toBeNull();
      expect(screen.getByTestId('inline-loading-dots')).toBeTruthy();
    });

    await user.type(screen.getByLabelText('Prompt'), 'follow-up');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await act(async () => {
      emitStreamTextPart(mainSocket, 'assistant-part-2', 'Part two');
    });

    await waitFor(() => {
      expect(getTranscriptRows()).toEqual([
        'assistant: Part one',
        'user: follow-up',
        'assistant: Part two',
      ]);
    });
  });

  it('does not drop in-flight deltas and still splits on the next part boundary', async () => {
    const user = userEvent.setup();

    render(
      <Chat
        threadId="thread-1"
        workspaceId="ws-1"
        initialMessages={[]}
      />
    );

    const mainSocket = getMainSocket();

    await act(async () => {
      mainSocket.emitOpen();
      mainSocket.emitMessage({ type: 'ready' });
      emitStreamTextPart(mainSocket, 'assistant-part-1', 'TC one');
    });

    await waitFor(() => {
      expect(screen.queryByTestId('global-loading-dots')).toBeNull();
      expect(screen.getByTestId('inline-loading-dots')).toBeTruthy();
    });

    await user.type(screen.getByLabelText('Prompt'), 'follow-up');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await act(async () => {
      emitStreamTextDelta(mainSocket, ' still running');
      emitStreamTextPart(mainSocket, 'assistant-part-2', 'TC two');
    });

    await waitFor(() => {
      expect(getTranscriptRows()).toEqual([
        'assistant: TC one still running',
        'user: follow-up',
        'assistant: TC two',
      ]);
    });
  });

  it('keeps assistant parts contiguous when there is no user interjection', async () => {
    render(
      <Chat
        threadId="thread-1"
        workspaceId="ws-1"
        initialMessages={[]}
      />
    );

    const mainSocket = getMainSocket();

    await act(async () => {
      mainSocket.emitOpen();
      mainSocket.emitMessage({ type: 'ready' });
      emitStreamTextPart(mainSocket, 'assistant-part-1', 'Part one');
      emitStreamTextPart(mainSocket, 'assistant-part-2', 'Part two');
    });

    await waitFor(() => {
      const rows = getTranscriptRows();
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => row.startsWith('assistant:'))).toBe(true);
      expect(rows.join(' ')).toContain('Part one');
      expect(rows.join(' ')).toContain('Part two');
    });
  });

  it('immediately splits Codex runtime output when user follows up mid-stream', async () => {
    const user = userEvent.setup();

    render(
      <Chat
        threadId="thread-1"
        workspaceId="ws-1"
        threadProvider="codex"
        initialMessages={[]}
      />
    );

    const mainSocket = getMainSocket();

    await act(async () => {
      mainSocket.emitOpen();
      mainSocket.emitMessage({ type: 'ready' });
      emitCodexTextDelta(mainSocket, 'assistant-part-1', 'Part one');
    });

    await waitFor(() => {
      expect(screen.queryByTestId('global-loading-dots')).toBeNull();
      expect(screen.getByTestId('inline-loading-dots')).toBeTruthy();
    });

    await user.type(screen.getByLabelText('Prompt'), 'continue');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await act(async () => {
      emitCodexTextDelta(mainSocket, 'assistant-part-2', 'Part two');
    });

    await waitFor(() => {
      expect(getTranscriptRows()).toEqual([
        'assistant: Part one',
        'user: continue',
        'assistant: Part two',
      ]);
    });
  });
});
