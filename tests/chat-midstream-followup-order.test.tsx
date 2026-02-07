import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

const mockNavigate = vi.fn();
const mockRevalidate = vi.fn();

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

vi.mock('@/components/message-bubble', () => ({
  MessageBubble: ({ message }: { message: { role: string; content: unknown } }) => {
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

    return <div data-testid="chat-bubble">{`${message.role}: ${renderedContent}`}</div>;
  },
}));

vi.mock('@/components/loading-dots', () => ({
  LoadingDots: () => <div data-testid="loading-dots" />,
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
  const socket = MockWebSocket.instances.find(
    (candidate) => candidate.url.includes('/ws/ws-1') && !candidate.url.includes('/ws/thread/')
  );
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

function getTranscriptRows(): string[] {
  const region = screen.getByRole('region', { name: 'Chat messages' });
  const rows = region.querySelectorAll('[data-message-id]');
  return Array.from(rows).map((row) => row.textContent?.replace(/\s+/g, ' ').trim() ?? '');
}

const OriginalWebSocket = globalThis.WebSocket;

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
  vi.clearAllMocks();
  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
});

afterEach(() => {
  globalThis.WebSocket = OriginalWebSocket;
});

describe('Chat mid-stream follow-up ordering', () => {
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
});
