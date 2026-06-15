import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import Chat from '@/components/Chat';
import type { AtMentionEntity, Integration } from '@/types';

const mockNavigate = vi.fn();
const mockRevalidate = vi.fn();
const mockSubmit = vi.fn();

type MockFetcher = {
  state: 'idle';
  data: unknown;
  formData: undefined;
  load: ReturnType<typeof vi.fn>;
  submit: ReturnType<typeof vi.fn>;
};

function createFetcher(): MockFetcher {
  return {
    state: 'idle',
    data: undefined,
    formData: undefined,
    load: vi.fn(),
    submit: vi.fn(),
  };
}

let fetcherCallIndex = 0;
let fetchers: MockFetcher[] = [];

function resetFetchers() {
  fetcherCallIndex = 0;
  fetchers = [createFetcher(), createFetcher(), createFetcher(), createFetcher()];
}

vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useLocation: () => ({
      pathname: '/chat/thread-1',
      search: '',
      hash: '',
      state: null,
      key: 'default',
    }),
    useNavigation: () => ({ state: 'idle', formData: undefined }),
    useRevalidator: () => ({ state: 'idle' as const, revalidate: mockRevalidate }),
    useFetcher: () => {
      const fetcher = fetchers[fetcherCallIndex % fetchers.length] ?? createFetcher();
      fetcherCallIndex += 1;
      return fetcher;
    },
    useSubmit: () => mockSubmit,
  };
});

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    message: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock('@/hooks/use-auth-data', () => ({
  useAuthData: () => ({
    user: { id: 'user-1', name: 'Illiana' },
    currentWorkspace: { id: 'ws-1', name: 'Workspace 1' },
    currentOrg: { id: 'org-1', slug: 'org-1', name: 'Org 1' },
    orgs: [{ org_id: 'org-1', role: 'owner' }],
  }),
}));

vi.mock('@/hooks/use-chat-groups', () => ({
  useOptionalChatGroups: () => null,
}));

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => false,
}));

vi.mock('@/components/prompt-input', () => ({
  PromptInput: ({
    mentionables = [],
    onMentionMenuOpenChange,
  }: {
    mentionables?: AtMentionEntity[];
    onMentionMenuOpenChange?: (open: boolean) => void;
  }) => (
    <div>
      <button
        type="button"
        onClick={() => onMentionMenuOpenChange?.(true)}
      >
        Open mentions
      </button>
      <ul>
        {mentionables.map((item) => (
          <li key={`${item.kind}:${item.id}`}>{item.name}</li>
        ))}
      </ul>
    </div>
  ),
}));

vi.mock('@/components/chat-messages-view', () => ({
  ChatMessagesView: () => <div data-testid="messages" />,
}));

vi.mock('@/components/message-bubble', () => ({
  isInterruptMessage: () => false,
  parseLocalCommandStdout: () => null,
}));

vi.mock('@/components/welcome-screen', () => ({
  WelcomeScreen: () => null,
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

vi.mock('@/components/chat-billing-credit-notice', () => ({
  BillingCreditNotice: () => null,
}));

vi.mock('@/components/billing/top-up-dialog', () => ({
  TopUpDialog: () => null,
}));

vi.mock('@/components/chat-error-notice', () => ({
  ChatErrorNotice: () => null,
}));

vi.mock('@/components/chat-share-status-button', () => ({
  ShareStatusButton: () => null,
}));

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: React.ComponentProps<'button'>) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/components/ui/resizable', () => ({
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ResizablePanel: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ResizableHandle: () => null,
}));

vi.mock('@/components/chat-preview/preview-context', () => ({
  ChatPreviewProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock('@/components/chat-preview/use-connection-setup-response', () => ({
  useConnectionSetupResponse: () => ({
    connectionSetupPrompt: null,
    handleConnectionSetupCancel: vi.fn(),
    handleConnectionSetupResponse: vi.fn(),
    setConnectionSetupPrompt: vi.fn(),
  }),
}));

vi.mock('@/components/chat-preview/use-chat-preview-render-state', () => ({
  useChatPreviewRenderState: () => ({
    tabRenderStates: {},
    previewDomains: { vanityHost: null },
    appPreviewVanityUrl: null,
    filePreviewOpenUrl: null,
    openElsewhereKind: null,
  }),
}));

vi.mock('@/components/chat-preview/chat-preview-shell', () => ({
  DEFAULT_NOTEBOOK_PREVIEW_STATE: {
    status: 'idle',
    notebook: null,
    reportHtml: null,
    error: null,
  },
  MobileViewSwitcher: () => null,
  PreviewPanelShell: () => null,
  normalizePreviewSessionState: () => ({ tabs: [], activeTabId: null }),
}));

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {}

  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  });
}

const initialProject: AtMentionEntity = {
  kind: 'project',
  id: 'project-initial',
  name: 'Initial Project',
  description: 'Initial project',
};

const fetchedProject: AtMentionEntity = {
  kind: 'project',
  id: 'project-fetched',
  name: 'Fetched Project',
  description: 'Fetched project',
};

const fetchedConnection: Integration = {
  id: 'conn-bigquery',
  integration_type: 'bigquery',
  name: 'Prod',
  category: 'databases',
  auth_method: 'api_key',
  config: {},
  created_by: 'user-1',
  created_at: 1,
  updated_at: 1,
  has_credentials: true,
};

const initialConnection: Integration = {
  ...fetchedConnection,
  id: 'conn-existing',
  name: 'Existing Connection',
};

describe('Chat mention source refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetFetchers();
    vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);
    vi.stubGlobal(
      'ResizeObserver',
      class ResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  });

  it('refreshes existing-thread composer connections and projects together', async () => {
    const { rerender } = render(
      <Chat
        threadId="thread-1"
        workspaceId="ws-1"
        initialMessages={[]}
        connections={[]}
        projects={[initialProject]}
      />,
    );

    expect(screen.getByText('Initial Project')).toBeInTheDocument();
    expect(screen.queryByText('Prod')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open mentions' }));

    const mentionFetcher = fetchers[3]!;
    expect(mentionFetcher.load).toHaveBeenCalledWith('/api/workspaces/ws-1/mentions');

    mentionFetcher.data = {
      connections: [fetchedConnection],
      projects: [fetchedProject],
    };
    fetcherCallIndex = 0;
    rerender(
      <Chat
        threadId="thread-1"
        workspaceId="ws-1"
        initialMessages={[]}
        connections={[]}
        projects={[initialProject]}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Prod')).toBeInTheDocument();
      expect(screen.getByText('Fetched Project')).toBeInTheDocument();
    });
  });

  it('preserves stale connections when a refresh omits connections after a partial failure', async () => {
    const { rerender } = render(
      <Chat
        threadId="thread-1"
        workspaceId="ws-1"
        initialMessages={[]}
        connections={[initialConnection]}
        projects={[initialProject]}
      />,
    );

    expect(screen.getByText('Existing Connection')).toBeInTheDocument();
    expect(screen.getByText('Initial Project')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open mentions' }));

    const mentionFetcher = fetchers[3]!;
    expect(mentionFetcher.load).toHaveBeenCalledWith('/api/workspaces/ws-1/mentions');

    mentionFetcher.data = {
      projects: [fetchedProject],
      error: 'Failed to load one or more workspace mention sources',
    };
    fetcherCallIndex = 0;
    rerender(
      <Chat
        threadId="thread-1"
        workspaceId="ws-1"
        initialMessages={[]}
        connections={[initialConnection]}
        projects={[initialProject]}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Existing Connection')).toBeInTheDocument();
      expect(screen.getByText('Fetched Project')).toBeInTheDocument();
    });
    expect(screen.queryByText('Initial Project')).not.toBeInTheDocument();
  });
});
