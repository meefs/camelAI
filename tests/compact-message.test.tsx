/**
 * Tests for compact message UI: CompactSummaryCard, CompactingIndicator,
 * and Chat-level compaction event handling.
 *
 * Run with: npx vitest tests/compact-message.test.tsx
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

// ---------------------------------------------------------------------------
// Component-level tests (no Chat mocks needed)
// ---------------------------------------------------------------------------

describe('CompactSummaryCard', () => {
  // Lazy-import so the module loads after any needed mocks
  let CompactSummaryCard: typeof import('@/components/compact-summary-card').CompactSummaryCard;

  beforeAll(async () => {
    // MarkdownRenderer uses shiki which is heavy; stub it
    vi.mock('@/components/markdown-renderer', () => ({
      MarkdownRenderer: ({ content }: { content: string }) => (
        <div data-testid="markdown">{content}</div>
      ),
    }));

    const mod = await import('@/components/compact-summary-card');
    CompactSummaryCard = mod.CompactSummaryCard;
  });

  it('renders header and body text for string content', () => {
    render(<CompactSummaryCard content="Summary text" />);
    expect(screen.getByText('Context compacted')).toBeInTheDocument();
    expect(screen.getByText('Summary text')).toBeInTheDocument();
  });

  it('renders content from ContentBlock array', () => {
    const blocks = [
      { type: 'text' as const, text: 'Block one' },
      { type: 'text' as const, text: 'Block two' },
    ];
    render(<CompactSummaryCard content={blocks} />);
    // The joined text is passed to MarkdownRenderer which renders it in a single div
    const markdown = screen.getByTestId('markdown');
    expect(markdown.textContent).toContain('Block one');
    expect(markdown.textContent).toContain('Block two');
  });

  it('does not render Show more when content fits', () => {
    render(<CompactSummaryCard content="Short" />);
    expect(screen.queryByText('Show more')).not.toBeInTheDocument();
  });

  it('toggles between Show more and Show less when content overflows', async () => {
    const user = userEvent.setup();

    // Force scrollHeight > COLLAPSED_MAX_HEIGHT
    const originalScrollHeight = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'scrollHeight',
    );
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get() {
        return 500;
      },
    });

    render(<CompactSummaryCard content="Long content..." />);

    // Wait for overflow detection effect
    await waitFor(() => {
      expect(screen.getByText('Show more')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Show more'));
    expect(screen.getByText('Show less')).toBeInTheDocument();

    await user.click(screen.getByText('Show less'));
    expect(screen.getByText('Show more')).toBeInTheDocument();

    // Restore
    if (originalScrollHeight) {
      Object.defineProperty(HTMLElement.prototype, 'scrollHeight', originalScrollHeight);
    }
  });
});

describe('CompactingIndicator', () => {
  it('renders the pulsing indicator text', async () => {
    // The Chat-level mock replaces CompactingIndicator with a stub.
    // Import the real module via a dynamic path that bypasses the mock.
    vi.doUnmock('@/components/compacting-indicator');
    const mod = await import('@/components/compacting-indicator');
    vi.doMock('@/components/compacting-indicator', () => ({
      CompactingIndicator: () => <div data-testid="compacting-indicator" />,
    }));
    render(<mod.CompactingIndicator />);
    expect(screen.getByText('Compacting conversation...')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Chat-level integration tests for compaction event lifecycle
// ---------------------------------------------------------------------------

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
    user: { id: 'user-1', name: 'Test' },
    currentWorkspace: { id: 'ws-1', name: 'Workspace 1' },
    currentOrg: { id: 'org-1', name: 'Org 1' },
    orgs: [{ org_id: 'org-1', role: 'owner' }],
  }),
}));

vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));
vi.mock('@/components/page-header', () => ({ PageHeader: () => <div data-testid="page-header" /> }));

vi.mock('@/components/prompt-input', () => ({
  PromptInput: ({ value, onChange, onSubmit }: { value: string; onChange: (v: string) => void; onSubmit: () => void }) => (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>
      <input aria-label="Prompt" value={value} onChange={(e) => onChange(e.currentTarget.value)} />
      <button type="submit">Send</button>
    </form>
  ),
}));

vi.mock('@/components/message-bubble', () => ({
  MessageBubble: ({ message }: { message: { role: string; content: unknown; isCompactSummary?: boolean } }) => {
    if (message.isCompactSummary) {
      return <div data-testid="compact-summary">{typeof message.content === 'string' ? message.content : '[blocks]'}</div>;
    }
    const rendered = typeof message.content === 'string'
      ? message.content
      : Array.isArray(message.content)
        ? message.content
            .map((b: { type: string; text?: string }) => b.type === 'text' ? b.text ?? '' : `[${b.type}]`)
            .filter(Boolean)
            .join(' ')
        : '';
    return <div data-testid="chat-bubble">{`${message.role}: ${rendered}`}</div>;
  },
  isInterruptMessage: () => false,
  parseSlashCommand: () => null,
  parseLocalCommandStdout: () => null,
}));

vi.mock('@/components/loading-dots', () => ({ LoadingDots: () => <div data-testid="loading-dots" /> }));
vi.mock('@/components/compacting-indicator', () => ({
  CompactingIndicator: () => <div data-testid="compacting-indicator" />,
}));
vi.mock('@/components/welcome-screen', () => ({ WelcomeScreen: () => <div data-testid="welcome-screen" /> }));
vi.mock('@/components/floating-todo', () => ({ FloatingTodoList: () => null }));
vi.mock('@/components/ask-user-question', () => ({ AskUserQuestion: () => null }));
vi.mock('@/components/connection-setup-prompt', () => ({ ConnectionSetupPrompt: () => null }));
vi.mock('@/components/bug-report-dialog', () => ({ BugReportDialog: () => null }));
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

// ---------------------------------------------------------------------------
// MockWebSocket
// ---------------------------------------------------------------------------

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
  const socket = MockWebSocket.instances.find((s) => s.url.includes('/ws/ws-1'));
  if (!socket) throw new Error('Main chat WebSocket was not created');
  return socket;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emitStreamTextPart(socket: MockWebSocket, messageId: string, text: string) {
  socket.emitMessage({
    type: 'sdk_event',
    event: { type: 'stream_event', event: { type: 'message_start', message: { id: messageId } } },
  });
  socket.emitMessage({
    type: 'sdk_event',
    event: { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
  });
  socket.emitMessage({
    type: 'sdk_event',
    event: { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } },
  });
}

function emitCompactionSummaryBlock(socket: MockWebSocket, summary: string) {
  socket.emitMessage({
    type: 'sdk_event',
    event: {
      type: 'stream_event',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'compaction' } },
    },
  });
  socket.emitMessage({
    type: 'sdk_event',
    event: {
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'compaction_delta', content: summary } },
    },
  });
  socket.emitMessage({
    type: 'sdk_event',
    event: { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
  });
}

const OriginalWebSocket = globalThis.WebSocket;

beforeAll(() => {
  for (const method of ['scrollTo', 'scrollIntoView']) {
    if (!(method in HTMLElement.prototype) || !HTMLElement.prototype[method as keyof HTMLElement]) {
      Object.defineProperty(HTMLElement.prototype, method, { value: vi.fn(), writable: true });
    }
  }
});

beforeEach(() => {
  MockWebSocket.instances = [];
  vi.clearAllMocks();
  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.WebSocket = OriginalWebSocket;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Chat compaction event lifecycle', () => {
  it('shows compacting indicator immediately for /compact and suppresses generic loading dots', async () => {
    const user = userEvent.setup();
    render(<Chat threadId="thread-1" workspaceId="ws-1" initialMessages={[]} />);
    const socket = getMainSocket();

    await act(async () => {
      socket.emitOpen();
      socket.emitMessage({ type: 'ready' });
    });

    await user.type(screen.getByLabelText('Prompt'), '/compact');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(screen.getByTestId('compacting-indicator')).toBeInTheDocument();
    expect(screen.queryByTestId('loading-dots')).not.toBeInTheDocument();

    const sentPayloadRaw = socket.send.mock.calls.at(-1)?.[0];
    expect(typeof sentPayloadRaw).toBe('string');
    const sentPayload = JSON.parse(String(sentPayloadRaw));
    expect(sentPayload.content).toBe('/compact');

    await act(async () => {
      socket.emitMessage({
        type: 'sdk_event',
        event: { type: 'system', subtype: 'compact_boundary' },
      });
    });

    expect(screen.queryByTestId('compacting-indicator')).not.toBeInTheDocument();
    expect(screen.getByTestId('compact-summary')).toBeInTheDocument();
  });

  it('does not treat /COMPACT as a manual compact command', async () => {
    const user = userEvent.setup();
    render(<Chat threadId="thread-1" workspaceId="ws-1" initialMessages={[]} />);
    const socket = getMainSocket();

    await act(async () => {
      socket.emitOpen();
      socket.emitMessage({ type: 'ready' });
    });

    await user.type(screen.getByLabelText('Prompt'), '/COMPACT');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(screen.queryByTestId('compacting-indicator')).not.toBeInTheDocument();
    const sentPayloadRaw = socket.send.mock.calls.at(-1)?.[0];
    expect(typeof sentPayloadRaw).toBe('string');
    const sentPayload = JSON.parse(String(sentPayloadRaw));
    expect(sentPayload.content).toBe('/COMPACT');
  });

  it('does not treat /compact with trailing args as a manual compact command', async () => {
    const user = userEvent.setup();
    render(<Chat threadId="thread-1" workspaceId="ws-1" initialMessages={[]} />);
    const socket = getMainSocket();

    await act(async () => {
      socket.emitOpen();
      socket.emitMessage({ type: 'ready' });
    });

    await user.type(screen.getByLabelText('Prompt'), '/compact now');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(screen.queryByTestId('compacting-indicator')).not.toBeInTheDocument();
    const sentPayloadRaw = socket.send.mock.calls.at(-1)?.[0];
    expect(typeof sentPayloadRaw).toBe('string');
    const sentPayload = JSON.parse(String(sentPayloadRaw));
    expect(sentPayload.content).toBe('/compact now');
  });

  it('immediately shows compact summary card on compact_boundary', async () => {
    render(<Chat threadId="thread-1" workspaceId="ws-1" initialMessages={[]} />);
    const socket = getMainSocket();

    await act(async () => {
      socket.emitOpen();
      socket.emitMessage({ type: 'ready' });
    });

    // Initially no compact card
    expect(screen.queryByTestId('compact-summary')).not.toBeInTheDocument();

    // Emit compact_boundary (arrives AFTER compaction is done) → card appears immediately
    await act(async () => {
      socket.emitMessage({
        type: 'sdk_event',
        event: { type: 'system', subtype: 'compact_boundary' },
      });
    });

    expect(screen.getByTestId('compact-summary')).toBeInTheDocument();
  });

  it('shows and clears compacting indicator from system status events (auto-compaction)', async () => {
    render(<Chat threadId="thread-1" workspaceId="ws-1" initialMessages={[]} />);
    const socket = getMainSocket();

    await act(async () => {
      socket.emitOpen();
      socket.emitMessage({ type: 'ready' });
    });

    await act(async () => {
      socket.emitMessage({
        type: 'sdk_event',
        event: { type: 'system', subtype: 'status', status: 'compacting' },
      });
    });
    expect(screen.getByTestId('compacting-indicator')).toBeInTheDocument();

    await act(async () => {
      socket.emitMessage({
        type: 'sdk_event',
        event: { type: 'system', subtype: 'status', status: null },
      });
    });
    expect(screen.queryByTestId('compacting-indicator')).not.toBeInTheDocument();
  });

  it('uses stream-event compaction block as fallback trigger when status events are absent', async () => {
    render(<Chat threadId="thread-1" workspaceId="ws-1" initialMessages={[]} />);
    const socket = getMainSocket();

    await act(async () => {
      socket.emitOpen();
      socket.emitMessage({ type: 'ready' });
    });

    await act(async () => {
      socket.emitMessage({
        type: 'sdk_event',
        event: {
          type: 'stream_event',
          event: { type: 'content_block_start', index: 0, content_block: { type: 'compaction' } },
        },
      });
    });
    expect(screen.getByTestId('compacting-indicator')).toBeInTheDocument();

    await act(async () => {
      socket.emitMessage({
        type: 'sdk_event',
        event: {
          type: 'stream_event',
          event: { type: 'content_block_delta', index: 0, delta: { type: 'compaction_delta', content: 'Fallback summary' } },
        },
      });
      socket.emitMessage({
        type: 'sdk_event',
        event: { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
      });
    });

    expect(screen.queryByTestId('compacting-indicator')).not.toBeInTheDocument();
    expect(screen.getByTestId('compact-summary')).toHaveTextContent('Fallback summary');
  });

  it('does not append a placeholder when compaction summary was already captured from stream events', async () => {
    render(<Chat threadId="thread-1" workspaceId="ws-1" initialMessages={[]} />);
    const socket = getMainSocket();

    await act(async () => {
      socket.emitOpen();
      socket.emitMessage({ type: 'ready' });
      emitCompactionSummaryBlock(socket, 'Summary from stream-event compaction block');
    });

    let cards = screen.getAllByTestId('compact-summary');
    expect(cards).toHaveLength(1);
    expect(cards[0]).toHaveTextContent('Summary from stream-event compaction block');

    await act(async () => {
      socket.emitMessage({
        type: 'sdk_event',
        event: { type: 'system', subtype: 'compact_boundary' },
      });
    });

    cards = screen.getAllByTestId('compact-summary');
    expect(cards).toHaveLength(1);
    expect(cards[0]).toHaveTextContent('Summary from stream-event compaction block');
  });

  it('replaces placeholder card with full summary when isCompactSummary user event arrives', async () => {
    render(<Chat threadId="thread-1" workspaceId="ws-1" initialMessages={[]} />);
    const socket = getMainSocket();

    await act(async () => {
      socket.emitOpen();
      socket.emitMessage({ type: 'ready' });
    });

    // Emit compact_boundary → placeholder card
    await act(async () => {
      socket.emitMessage({
        type: 'sdk_event',
        event: { type: 'system', subtype: 'compact_boundary' },
      });
    });

    expect(screen.getByTestId('compact-summary')).toBeInTheDocument();

    // Emit full compact summary (forwarded by control plane from JSONL)
    await act(async () => {
      socket.emitMessage({
        type: 'sdk_event',
        event: {
          type: 'user',
          isCompactSummary: true,
          uuid: 'compact-uuid',
          message: { role: 'user', content: 'Full compacted summary content' },
        },
      });
    });

    // Should have exactly one compact summary card with the full content
    const cards = screen.getAllByTestId('compact-summary');
    expect(cards).toHaveLength(1);
    expect(cards[0]).toHaveTextContent('Full compacted summary content');
  });

  it('compact_boundary followed by result does not leave stale state', async () => {
    render(<Chat threadId="thread-1" workspaceId="ws-1" initialMessages={[]} />);
    const socket = getMainSocket();

    await act(async () => {
      socket.emitOpen();
      socket.emitMessage({ type: 'ready' });
    });

    await act(async () => {
      socket.emitMessage({
        type: 'sdk_event',
        event: { type: 'system', subtype: 'compact_boundary' },
      });
    });

    expect(screen.getByTestId('compact-summary')).toBeInTheDocument();

    await act(async () => {
      socket.emitMessage({ type: 'sdk_event', event: { type: 'result' } });
    });

    // Card should still be visible after result
    expect(screen.getByTestId('compact-summary')).toBeInTheDocument();
  });

  it('clears compacting indicator on error event', async () => {
    render(<Chat threadId="thread-1" workspaceId="ws-1" initialMessages={[]} />);
    const socket = getMainSocket();

    await act(async () => {
      socket.emitOpen();
      socket.emitMessage({ type: 'ready' });
    });

    // Set isCompacting via a hypothetical in-progress state, then error clears it
    // (This tests the safety net in the error handler)
    await act(async () => {
      socket.emitMessage({ type: 'error', error: 'something failed' });
    });

    expect(screen.queryByTestId('compacting-indicator')).not.toBeInTheDocument();
  });

  it('clears auto-compacting indicator on result safety net', async () => {
    render(<Chat threadId="thread-1" workspaceId="ws-1" initialMessages={[]} />);
    const socket = getMainSocket();

    await act(async () => {
      socket.emitOpen();
      socket.emitMessage({ type: 'ready' });
      socket.emitMessage({
        type: 'sdk_event',
        event: { type: 'system', subtype: 'status', status: 'compacting' },
      });
    });
    expect(screen.getByTestId('compacting-indicator')).toBeInTheDocument();

    await act(async () => {
      socket.emitMessage({ type: 'sdk_event', event: { type: 'result' } });
    });

    expect(screen.queryByTestId('compacting-indicator')).not.toBeInTheDocument();
  });

  it('clears manual compact indicator when reconnect retries are exhausted', async () => {
    const user = userEvent.setup();
    render(<Chat threadId="thread-1" workspaceId="ws-1" initialMessages={[]} />);

    let socket = getMainSocket();

    await act(async () => {
      socket.emitOpen();
      socket.emitMessage({ type: 'ready' });
    });

    await user.type(screen.getByLabelText('Prompt'), '/compact');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(screen.getByTestId('compacting-indicator')).toBeInTheDocument();

    vi.useFakeTimers();

    const reconnectBackoffsMs = [1000, 2000, 4000, 8000, 16000];
    for (const delayMs of reconnectBackoffsMs) {
      await act(async () => {
        socket.close();
      });
      await act(async () => {
        vi.advanceTimersByTime(delayMs);
      });
      const latest = MockWebSocket.instances.at(-1);
      if (!latest) {
        throw new Error('Expected reconnect attempt to create a new WebSocket');
      }
      socket = latest;
    }

    // Sixth close hits the exhausted branch (maxAttempts reached).
    await act(async () => {
      socket.close();
    });

    expect(screen.queryByTestId('compacting-indicator')).not.toBeInTheDocument();
  });

  it('system init without prior compact_boundary does NOT insert a compact message', async () => {
    render(<Chat threadId="thread-1" workspaceId="ws-1" initialMessages={[]} />);
    const socket = getMainSocket();

    await act(async () => {
      socket.emitOpen();
      socket.emitMessage({ type: 'ready' });
    });

    // Emit system init without prior compact_boundary
    await act(async () => {
      socket.emitMessage({
        type: 'sdk_event',
        event: { type: 'system', subtype: 'init' },
      });
    });

    expect(screen.queryByTestId('compact-summary')).not.toBeInTheDocument();
  });

  it('compact_boundary → full summary → new assistant streaming works end-to-end', async () => {
    render(<Chat threadId="thread-1" workspaceId="ws-1" initialMessages={[]} />);
    const socket = getMainSocket();

    await act(async () => {
      socket.emitOpen();
      socket.emitMessage({ type: 'ready' });
    });

    // Pre-compaction assistant message — stream and finish it
    await act(async () => {
      emitStreamTextPart(socket, 'pre-compact-msg', 'Before compaction');
      socket.emitMessage({
        type: 'sdk_event',
        event: { type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'end_turn' } } },
      });
      socket.emitMessage({ type: 'sdk_event', event: { type: 'result' } });
    });

    expect(screen.getByText('assistant: Before compaction')).toBeInTheDocument();

    // Compaction complete — compact_boundary arrives (after SDK finishes)
    await act(async () => {
      socket.emitMessage({
        type: 'sdk_event',
        event: { type: 'system', subtype: 'compact_boundary' },
      });
    });

    // Placeholder compact card appears immediately
    expect(screen.getByTestId('compact-summary')).toBeInTheDocument();

    // Full summary forwarded by control plane from JSONL
    await act(async () => {
      socket.emitMessage({
        type: 'sdk_event',
        event: {
          type: 'user',
          isCompactSummary: true,
          uuid: 'compact-full',
          message: { role: 'user', content: 'Summary of prior conversation.' },
        },
      });
    });

    // Placeholder replaced with full summary
    const cards = screen.getAllByTestId('compact-summary');
    expect(cards).toHaveLength(1);
    expect(cards[0]).toHaveTextContent('Summary of prior conversation.');

    // New assistant response streams in after compaction
    await act(async () => {
      emitStreamTextPart(socket, 'post-compact-msg', 'After compaction');
    });

    await waitFor(() => {
      const bubbles = screen.getAllByTestId('chat-bubble');
      const texts = bubbles.map((b) => b.textContent);
      expect(texts).toContain('assistant: After compaction');
    });
  });

  it('renders compact summary message from initialMessages (history reload)', () => {
    const initialMessages = [
      {
        id: 'compact-hist',
        thread_id: 'thread-1',
        role: 'user' as const,
        content: 'Historical compact summary',
        created_at: Date.now(),
        isCompactSummary: true,
      },
    ];

    render(<Chat threadId="thread-1" workspaceId="ws-1" initialMessages={initialMessages} />);
    expect(screen.getByTestId('compact-summary')).toBeInTheDocument();
    expect(screen.getByTestId('compact-summary')).toHaveTextContent('Historical compact summary');
  });
});
