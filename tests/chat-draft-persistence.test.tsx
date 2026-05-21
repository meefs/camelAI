import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { loadDeliveryDraft, loadDraft } from '@/hooks/use-draft-persistence';

const mockNavigate = vi.fn();
const mockRevalidate = vi.fn();
const mockSubmit = vi.fn();
let mockLocationState: unknown = null;
let mockLocation = {
  pathname: '/chat/thread-1',
  search: '',
  hash: '',
  key: 'default',
};

function createFetcher() {
  return {
    state: 'idle' as const,
    data: undefined as
      | { thread?: { id: string }; error?: string }
      | undefined,
    formData: undefined,
    submit: vi.fn(),
  };
}

let mockFetcher = createFetcher();

vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useLocation: () => ({ ...mockLocation, state: mockLocationState }),
    useNavigation: () => ({ state: 'idle', formData: undefined }),
    useRevalidator: () => ({ state: 'idle' as const, revalidate: mockRevalidate }),
    useFetcher: () => mockFetcher,
    useSubmit: () => mockSubmit,
  };
});

vi.mock('sonner', () => ({
  toast: { error: vi.fn() },
}));

vi.mock('@/hooks/use-auth-data', () => ({
  useAuthData: () => ({
    user: { id: 'user-1', name: 'Miguel' },
    currentWorkspace: { id: 'ws-1', name: 'Workspace 1' },
    currentOrg: { id: 'org-1', slug: 'org-1', name: 'Org 1' },
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
  PromptInput: ({
    value,
    onChange,
    onSubmit,
    attachments = [],
  }: {
    value: string;
    onChange: (value: string) => void;
    onSubmit: () => void;
    attachments?: Array<{ id: string }>;
  }) => (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <input
        aria-label="Thread prompt"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      <div data-testid="thread-attachment-count">{attachments.length}</div>
      <button type="submit">Send</button>
    </form>
  ),
}));

vi.mock('@/components/welcome-screen', () => ({
  WelcomeScreen: ({
    inputValue,
    onPromptChange,
    onSubmit,
    attachments = [],
    model,
    recentModelScope,
  }: {
    inputValue: string;
    onPromptChange: (value: string) => void;
    onSubmit: () => void;
    attachments?: Array<{ id: string }>;
    model?: string;
    recentModelScope?: { orgId: string; workspaceId: string } | null;
  }) => (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <input
        aria-label="Welcome prompt"
        value={inputValue}
        onChange={(event) => onPromptChange(event.currentTarget.value)}
      />
      <div data-testid="welcome-model">{model}</div>
      <div data-testid="welcome-recent-model-scope">
        {recentModelScope ? 'enabled' : 'disabled'}
      </div>
      <div data-testid="welcome-attachment-count">{attachments.length}</div>
      <button type="submit">Start</button>
    </form>
  ),
}));

vi.mock('@/components/message-bubble', () => ({
  MessageBubble: ({
    message,
  }: {
    message: { role: string; content: unknown };
  }) => (
    <div data-testid="chat-bubble">
      {message.role}:{typeof message.content === 'string' ? message.content : '[content]'}
    </div>
  ),
  isInterruptMessage: () => false,
  parseSlashCommand: () => null,
  parseLocalCommandStdout: () => null,
}));

vi.mock('@/components/loading-dots', () => ({
  LoadingDots: () => <div data-testid="loading-dots" />,
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

vi.mock('@/components/onboarding-loading-modal', () => ({
  OnboardingLoadingModal: () => null,
}));

vi.mock('@/components/chat-file-preview', () => ({
  FilePreviewContent: () => null,
  isImageFile: () => false,
}));

vi.mock('@/components/chat-preview/preview-context', () => ({
  ChatPreviewProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/components/preview-panel/preview-tabs', () => ({
  PreviewTabRow: () => null,
}));

vi.mock('@/components/preview-panel/preview-toolbar', () => ({
  PreviewToolbar: () => null,
}));

vi.mock('@/components/compacting-indicator', () => ({
  CompactingIndicator: () => <div data-testid="compacting-indicator" />,
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

vi.mock('@/components/ui/skeleton', () => ({
  Skeleton: () => null,
}));

vi.mock('@/lib/workspace-upload.client', () => ({
  uploadWorkspaceFile: vi.fn(),
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
  const socket = MockWebSocket.instances.find((candidate) => candidate.url.includes('/ws/ws-1'));
  if (!socket) {
    throw new Error('Main chat WebSocket was not created');
  }
  return socket;
}

function getLatestMainSocket(): MockWebSocket {
  const socket = [...MockWebSocket.instances]
    .reverse()
    .find((candidate) => candidate.url.includes('/ws/ws-1'));
  if (!socket) {
    throw new Error('Main chat WebSocket was not created');
  }
  return socket;
}

function sentMessagePayloads(socket: MockWebSocket): Array<Record<string, unknown>> {
  return socket.send.mock.calls.flatMap(([raw]) => {
    if (typeof raw !== 'string') return [];
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return parsed.type === 'message' ? [parsed] : [];
    } catch {
      return [];
    }
  });
}

beforeAll(() => {
  vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);
  vi.stubGlobal(
    'ResizeObserver',
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value: vi.fn(),
  });
});

describe('Chat draft persistence', () => {
  const attachmentDraft = {
    id: 'attachment-1',
    name: 'pasted-text.txt',
    path: '/mnt/user-uploads/pasted-text-123.txt',
    size: 42,
    status: 'complete' as const,
  };

  beforeEach(() => {
    mockFetcher = createFetcher();
    mockLocationState = null;
    mockLocation = {
      pathname: '/chat/thread-1',
      search: '',
      hash: '',
      key: 'default',
    };
    mockNavigate.mockReset();
    mockRevalidate.mockReset();
    mockSubmit.mockReset();
    MockWebSocket.instances = [];
    localStorage.clear();
    sessionStorage.clear();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => Promise.resolve(
        new Response(JSON.stringify({ messages: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);
    vi.stubGlobal(
      'ResizeObserver',
      class ResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    document.title = '';
  });

  it('restores a thread draft, keeps it during optimistic clear, restores on error, and clears on result', async () => {
    const user = userEvent.setup();

    localStorage.setItem(
      'draft:ws-1:thread-1',
      JSON.stringify({
        text: 'Persistent draft',
        attachments: [],
        savedAt: Date.now(),
      }),
    );

    render(
      <Chat
        threadId="thread-1"
        workspaceId="ws-1"
        initialMessages={[]}
        isNewThread
      />
    );

    const input = screen.getByLabelText('Thread prompt');
    expect(input).toHaveValue('Persistent draft');

    const socket = getLatestMainSocket();
    act(() => {
      socket.emitOpen();
      socket.emitMessage({ type: 'ready' });
    });

    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(input).toHaveValue('');
    expect(loadDraft('ws-1', 'thread-1')?.text).toBe('Persistent draft');

    act(() => {
      socket.emitMessage({ type: 'error', error: 'boom' });
    });

    await waitFor(() => {
      expect(input).toHaveValue('Persistent draft');
    });

    await user.click(screen.getByRole('button', { name: 'Send' }));

    act(() => {
      socket.emitMessage({ type: 'sdk_event', event: { type: 'result' } });
    });

    await waitFor(() => {
      expect(loadDraft('ws-1', 'thread-1')).toBeNull();
    });
  });

  it('clears a sent thread draft as soon as the server accepts the message', async () => {
    const user = userEvent.setup();
    const { unmount } = render(
      <Chat
        threadId="thread-1"
        workspaceId="ws-1"
        initialMessages={[]}
      />,
    );

    const input = screen.getByLabelText('Thread prompt');
    const socket = getLatestMainSocket();
    act(() => {
      socket.emitOpen();
      socket.emitMessage({ type: 'ready' });
    });

    await user.type(input, 'Accepted while agent runs');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(input).toHaveValue('');
    expect(loadDraft('ws-1', 'thread-1')?.text).toBe('Accepted while agent runs');

    const sentPayload = sentMessagePayloads(socket)[0];
    expect(sentPayload.clientMessageId).toEqual(expect.any(String));

    act(() => {
      socket.emitMessage({
        type: 'message_accepted',
        clientMessageId: sentPayload.clientMessageId,
      });
    });

    await waitFor(() => {
      expect(loadDraft('ws-1', 'thread-1')).toBeNull();
    });
    expect(loadDeliveryDraft('ws-1', 'thread-1')).toMatchObject({
      text: 'Accepted while agent runs',
      clientMessageId: sentPayload.clientMessageId,
      acceptedAt: expect.any(Number),
    });

    unmount();

    render(
      <Chat
        threadId="thread-1"
        workspaceId="ws-1"
        initialMessages={[]}
      />,
    );

    expect(screen.getByLabelText('Thread prompt')).toHaveValue('');
  });

  it('restores the draft and idles thread status when a sent message is never accepted', async () => {
    vi.useFakeTimers();
    const statusEvents: Array<{ status?: string; threadId?: string }> = [];
    const handleStatus = (event: Event) => {
      statusEvents.push(
        (event as CustomEvent<{ status?: string; threadId?: string }>).detail,
      );
    };
    window.addEventListener('camelai:thread-status', handleStatus);

    render(
      <Chat
        threadId="thread-1"
        workspaceId="ws-1"
        initialMessages={[]}
      />,
    );

    const input = screen.getByLabelText('Thread prompt');
    const socket = getLatestMainSocket();
    act(() => {
      socket.emitOpen();
      socket.emitMessage({ type: 'ready' });
    });

    fireEvent.change(input, { target: { value: 'Lost before ack' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(input).toHaveValue('');
    expect(screen.getByText('user:Lost before ack')).toBeInTheDocument();
    expect(sentMessagePayloads(socket)[0]?.clientMessageId).toEqual(
      expect.any(String),
    );

    act(() => {
      vi.advanceTimersByTime(20_000);
    });

    expect(input).toHaveValue('Lost before ack');
    expect(screen.queryByText('user:Lost before ack')).toBeNull();
    expect(loadDraft('ws-1', 'thread-1')?.text).toBe('Lost before ack');
    expect(loadDeliveryDraft('ws-1', 'thread-1')).toBeNull();
    expect(statusEvents).toContainEqual(
      expect.objectContaining({ threadId: 'thread-1', status: 'running' }),
    );
    expect(statusEvents.at(-1)).toEqual(
      expect.objectContaining({ threadId: 'thread-1', status: 'idle' }),
    );

    window.removeEventListener('camelai:thread-status', handleStatus);
  });

  it('restores an accepted delivery backup when the turn later fails', async () => {
    const user = userEvent.setup();
    const { unmount } = render(
      <Chat
        threadId="thread-1"
        workspaceId="ws-1"
        initialMessages={[]}
      />,
    );

    const input = screen.getByLabelText('Thread prompt');
    const socket = getLatestMainSocket();
    act(() => {
      socket.emitOpen();
      socket.emitMessage({ type: 'ready' });
    });

    await user.type(input, 'Accepted then failed');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    const sentPayload = sentMessagePayloads(socket)[0];
    act(() => {
      socket.emitMessage({
        type: 'message_accepted',
        clientMessageId: sentPayload.clientMessageId,
      });
    });

    await waitFor(() => {
      expect(loadDraft('ws-1', 'thread-1')).toBeNull();
    });
    expect(loadDeliveryDraft('ws-1', 'thread-1')?.text).toBe(
      'Accepted then failed',
    );

    unmount();

    render(
      <Chat
        threadId="thread-1"
        workspaceId="ws-1"
        initialMessages={[]}
      />,
    );

    const remountedInput = screen.getByLabelText('Thread prompt');
    expect(remountedInput).toHaveValue('');

    const remountedSocket = getLatestMainSocket();
    act(() => {
      remountedSocket.emitOpen();
      remountedSocket.emitMessage({ type: 'ready' });
      remountedSocket.emitMessage({ type: 'error', error: 'provider failed' });
    });

    await waitFor(() => {
      expect(remountedInput).toHaveValue('Accepted then failed');
    });
    expect(loadDraft('ws-1', 'thread-1')?.text).toBe('Accepted then failed');
    expect(loadDeliveryDraft('ws-1', 'thread-1')).toBeNull();
  });

  it('does not delete a new unsent thread draft when an earlier send is accepted', async () => {
    const user = userEvent.setup();
    render(
      <Chat
        threadId="thread-1"
        workspaceId="ws-1"
        initialMessages={[]}
      />,
    );

    const input = screen.getByLabelText('Thread prompt');
    const socket = getLatestMainSocket();
    act(() => {
      socket.emitOpen();
      socket.emitMessage({ type: 'ready' });
    });

    await user.type(input, 'First message');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(input).toHaveValue('');

    await user.type(input, 'New unsent draft');

    const sentPayload = sentMessagePayloads(socket)[0];
    act(() => {
      socket.emitMessage({
        type: 'message_accepted',
        clientMessageId: sentPayload.clientMessageId,
      });
    });

    await waitFor(
      () => {
        expect(loadDraft('ws-1', 'thread-1')?.text).toBe('New unsent draft');
      },
      { timeout: 1500 },
    );
  });

  it('clears the welcome-screen draft when the route action takes over', async () => {
    const user = userEvent.setup();

    render(
      <Chat
        workspaceId="ws-1"
        initialMessages={[]}
      />
    );

    await user.type(screen.getByLabelText('Welcome prompt'), 'Hello from welcome');
    await user.click(screen.getByRole('button', { name: 'Start' }));

    expect(mockSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: 'createThreadAndStart',
        firstMessage: 'Hello from welcome',
      }),
      { method: 'post', action: '/chat' },
    );
    expect(loadDraft('ws-1', null)).toBeNull();
    expect(sessionStorage.getItem('pendingMessage:newThread')).toBeNull();
  });

  it('does not flush a submitted welcome prompt back into the new-chat draft on unmount', async () => {
    const user = userEvent.setup();

    const { unmount } = render(
      <Chat
        workspaceId="ws-1"
        initialMessages={[]}
      />,
    );

    await user.type(screen.getByLabelText('Welcome prompt'), 'Start and clear me');
    await user.click(screen.getByRole('button', { name: 'Start' }));

    expect(mockSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: 'createThreadAndStart',
        firstMessage: 'Start and clear me',
      }),
      { method: 'post', action: '/chat' },
    );
    expect(loadDraft('ws-1', null)).toBeNull();

    unmount();

    expect(loadDraft('ws-1', null)).toBeNull();

    render(
      <Chat
        workspaceId="ws-1"
        initialMessages={[]}
      />,
    );

    expect(screen.getByLabelText('Welcome prompt')).toHaveValue('');
  });

  it('restores the welcome draft when create-thread action returns an error', async () => {
    const user = userEvent.setup();

    const { rerender } = render(
      <Chat
        workspaceId="ws-1"
        initialMessages={[]}
      />,
    );

    await user.type(screen.getByLabelText('Welcome prompt'), 'Do not lose this');
    await user.click(screen.getByRole('button', { name: 'Start' }));

    expect(screen.getByLabelText('Welcome prompt')).toHaveValue('');
    expect(loadDraft('ws-1', null)).toBeNull();

    rerender(
      <Chat
        workspaceId="ws-1"
        initialMessages={[]}
        initialError="Invalid thread model"
        newChatActionError="Invalid thread model"
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText('Welcome prompt')).toHaveValue(
        'Do not lose this',
      );
    });
    expect(loadDraft('ws-1', null)).toMatchObject({
      text: 'Do not lose this',
      attachments: [],
    });
  });

  it('uses the saved recent model for a new chat only when no picker default is set', async () => {
    const user = userEvent.setup();

    localStorage.setItem('camelai.recentModel.org-1.ws-1', 'opus');

    const noDefaultChat = (
      <Chat
        workspaceId="ws-1"
        initialMessages={[]}
        threadModel="sonnet"
        allowedThreadModels={['sonnet', 'opus']}
        effectivePickerDefaultModel={null}
        hasEffectivePickerDefault={false}
      />
    );

    expect(renderToString(noDefaultChat)).toContain(
      'data-testid="welcome-model">sonnet',
    );

    const { rerender } = render(noDefaultChat);

    await waitFor(() => {
      expect(screen.getByTestId('welcome-model')).toHaveTextContent('opus');
    });
    expect(screen.getByTestId('welcome-recent-model-scope')).toHaveTextContent(
      'enabled',
    );

    await user.type(
      screen.getByLabelText('Welcome prompt'),
      'Use the recent model',
    );
    await user.click(screen.getByRole('button', { name: 'Start' }));

    expect(mockSubmit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        intent: 'createThreadAndStart',
        model: 'opus',
      }),
      { method: 'post', action: '/chat' },
    );

    mockFetcher = createFetcher();

    rerender(
      <Chat
        workspaceId="ws-1"
        initialMessages={[]}
        threadModel="sonnet"
        allowedThreadModels={['sonnet', 'opus']}
        effectivePickerDefaultModel="sonnet"
        hasEffectivePickerDefault
      />,
    );

    expect(screen.getByTestId('welcome-model')).toHaveTextContent('sonnet');
    expect(screen.getByTestId('welcome-recent-model-scope')).toHaveTextContent(
      'disabled',
    );
  });

  it('sends an attachment-only thread draft through the websocket', async () => {
    const user = userEvent.setup();

    localStorage.setItem(
      'draft:ws-1:thread-1',
      JSON.stringify({
        text: '',
        attachments: [attachmentDraft],
        savedAt: Date.now(),
      }),
    );

    render(
      <Chat
        threadId="thread-1"
        workspaceId="ws-1"
        initialMessages={[]}
        isNewThread
      />
    );

    expect(screen.getByTestId('thread-attachment-count')).toHaveTextContent('1');

    const socket = getMainSocket();
    act(() => {
      socket.emitOpen();
      socket.emitMessage({ type: 'ready' });
    });

    await user.click(screen.getByRole('button', { name: 'Send' }));

    const sentPayloadRaw = socket.send.mock.calls.at(-1)?.[0];
    expect(typeof sentPayloadRaw).toBe('string');
    const sentPayload = JSON.parse(String(sentPayloadRaw));
    expect(sentPayload.content).toBe(`(user uploaded file to ${attachmentDraft.path})`);
  });

  it('does not replay an immediately sent message after remounting before acknowledgement', async () => {
    const user = userEvent.setup();

    const { unmount } = render(
      <Chat
        threadId="thread-1"
        workspaceId="ws-1"
        initialMessages={[]}
      />
    );

    const socket = getMainSocket();
    act(() => {
      socket.emitOpen();
      socket.emitMessage({ type: 'ready' });
    });

    await user.type(screen.getByLabelText('Thread prompt'), 'Hello once');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(sentMessagePayloads(socket)).toHaveLength(1);
    expect(sessionStorage.getItem('pendingMessages:ws-1:thread-1')).toBeNull();

    unmount();

    render(
      <Chat
        threadId="thread-1"
        workspaceId="ws-1"
        initialMessages={[]}
      />
    );

    const remountedSocket = getLatestMainSocket();
    expect(remountedSocket).not.toBe(socket);

    act(() => {
      remountedSocket.emitOpen();
      remountedSocket.emitMessage({ type: 'ready' });
    });

    expect(sentMessagePayloads(remountedSocket)).toHaveLength(0);
  });

  it('does not replay a queued message from session storage after remounting before the socket is ready', async () => {
    const user = userEvent.setup();

    const { unmount } = render(
      <Chat
        threadId="thread-1"
        workspaceId="ws-1"
        initialMessages={[]}
      />
    );

    await user.type(screen.getByLabelText('Thread prompt'), 'Send when ready');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(sessionStorage.getItem('pendingMessages:ws-1:thread-1')).toBeNull();

    unmount();

    render(
      <Chat
        threadId="thread-1"
        workspaceId="ws-1"
        initialMessages={[]}
      />
    );

    const remountedSocket = getLatestMainSocket();
    act(() => {
      remountedSocket.emitOpen();
      remountedSocket.emitMessage({ type: 'ready' });
    });

    expect(sentMessagePayloads(remountedSocket)).toHaveLength(0);
    expect(sessionStorage.getItem('pendingMessages:ws-1:thread-1')).toBeNull();
  });

  it('creates a new thread from an attachment-only welcome draft', async () => {
    const user = userEvent.setup();

    localStorage.setItem(
      'draft:ws-1:new',
      JSON.stringify({
        text: '',
        attachments: [attachmentDraft],
        savedAt: Date.now(),
      }),
    );

    render(
      <Chat
        workspaceId="ws-1"
        initialMessages={[]}
      />
    );

    expect(screen.getByTestId('welcome-attachment-count')).toHaveTextContent('1');

    await user.click(screen.getByRole('button', { name: 'Start' }));

    expect(mockSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: 'createThreadAndStart',
        firstMessage: `(user uploaded file to ${attachmentDraft.path})`,
      }),
      { method: 'post', action: '/chat' },
    );

    expect(loadDraft('ws-1', null)).toBeNull();
    expect(sessionStorage.getItem('pendingMessage:newThread')).toBeNull();
  });

  it('submits a new-chat first prompt through the route action without a client relay', async () => {
    const user = userEvent.setup();

    render(
      <Chat
        workspaceId="ws-1"
        initialMessages={[]}
      />
    );

    await user.type(screen.getByLabelText('Welcome prompt'), 'first prompt');
    await user.click(screen.getByRole('button', { name: 'Start' }));

    expect(mockSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: 'createThreadAndStart',
        firstMessage: 'first prompt',
      }),
      { method: 'post', action: '/chat' },
    );
    expect(loadDraft('ws-1', null)).toBeNull();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('hydrates the thread composer from localStorage without a browser pending handoff', () => {
    localStorage.setItem(
      'draft:ws-1:thread-new',
      JSON.stringify({
        text: 'Saved thread draft',
        attachments: [],
        savedAt: Date.now(),
      }),
    );

    render(
      <Chat
        threadId="thread-new"
        workspaceId="ws-1"
        initialMessages={[]}
        isNewThread
      />
    );

    expect(screen.getByLabelText('Thread prompt')).toHaveValue('Saved thread draft');
  });

  it('updates the browser title from title_updated without route revalidation', async () => {
    document.title = 'Old title - camelAI';

    render(
      <Chat
        threadId="thread-1"
        workspaceId="ws-1"
        initialMessages={[]}
      />
    );

    const socket = getLatestMainSocket();
    act(() => {
      socket.emitOpen();
      socket.emitMessage({ type: 'ready' });
      socket.emitMessage({ type: 'title_updated', title: 'Generated title' });
    });

    expect(document.title).toBe('Generated title - camelAI');
    expect(mockRevalidate).not.toHaveBeenCalled();
  });

  it('does not revalidate the route or schedule delayed revalidations after completion frames', async () => {
    vi.useFakeTimers();

    render(
      <Chat
        threadId="thread-1"
        workspaceId="ws-1"
        initialMessages={[]}
      />
    );

    const socket = getLatestMainSocket();
    act(() => {
      socket.emitOpen();
      socket.emitMessage({ type: 'ready' });
    });
    mockRevalidate.mockClear();

    act(() => {
      socket.emitMessage({
        type: 'runtime_event',
        event: { method: 'turn/completed' },
      });
      socket.emitMessage({
        type: 'sdk_event',
        event: { type: 'result' },
      });
      socket.emitMessage({ type: 'result' });
    });

    await act(async () => {
      vi.advanceTimersByTime(3500);
    });

    expect(mockRevalidate).not.toHaveBeenCalled();
  });
});
