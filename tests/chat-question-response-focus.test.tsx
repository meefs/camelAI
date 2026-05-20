import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { BYOK_PROVIDERS } from "@/lib/byok-providers";

const mockNavigate = vi.fn();
const mockRevalidate = vi.fn();
const mockSubmit = vi.fn();

function createFetcher() {
  return {
    state: "idle" as const,
    data: undefined,
    formData: undefined,
    submit: vi.fn(),
  };
}

vi.mock("react-router", async () => {
  const actual =
    await vi.importActual<typeof import("react-router")>("react-router");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useLocation: () => ({
      pathname: "/chat/thread-1",
      search: "",
      hash: "",
      state: null,
      key: "default",
    }),
    useRevalidator: () => ({
      state: "idle" as const,
      revalidate: mockRevalidate,
    }),
    useNavigation: () => ({ state: "idle", formData: undefined }),
    useFetcher: () => createFetcher(),
    useSubmit: () => mockSubmit,
  };
});

vi.mock("sonner", () => ({
  toast: { error: vi.fn() },
}));

vi.mock("@/hooks/use-auth-data", () => ({
  useAuthData: () => ({
    user: { id: "user-1", name: "Illiana" },
    currentWorkspace: { id: "ws-1", name: "Workspace 1" },
    currentOrg: { id: "org-1", name: "Org 1" },
    orgs: [{ org_id: "org-1", role: "owner" }],
  }),
}));

vi.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => false,
}));

vi.mock("@/components/page-header", () => ({
  PageHeader: () => null,
}));

vi.mock("@/components/prompt-input", () => ({
  PromptInput: ({
    value,
    onChange,
    textareaRef,
  }: {
    value: string;
    onChange: (value: string) => void;
    textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
  }) => (
    <textarea
      aria-label="Prompt"
      ref={textareaRef}
      value={value}
      onChange={(event) => onChange(event.currentTarget.value)}
    />
  ),
}));

vi.mock("@/components/ask-user-question", () => ({
  AskUserQuestion: ({
    onSubmit,
  }: {
    onSubmit: (answers: Record<string, string>) => void;
  }) => (
    <button
      type="button"
      onClick={() => onSubmit({ "Which framework do you want?": "Remix" })}
    >
      Answer question
    </button>
  ),
}));

vi.mock("@/components/message-bubble", () => ({
  MessageBubble: () => null,
  isInterruptMessage: () => false,
  parseSlashCommand: () => null,
  parseLocalCommandStdout: () => null,
}));

vi.mock("@/components/loading-dots", () => ({
  LoadingDots: () => null,
}));

vi.mock("@/components/welcome-screen", () => ({
  WelcomeScreen: () => null,
}));

vi.mock("@/components/floating-todo", () => ({
  FloatingTodoList: () => null,
}));

vi.mock("@/components/connection-setup-prompt", () => ({
  ConnectionSetupPrompt: () => null,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: React.ComponentProps<"button">) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TabsList: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TabsTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  ResizablePanel: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  ResizableHandle: () => null,
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuRadioGroup: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuRadioItem: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

import Chat from "@/components/Chat";

const RATE_LIMIT_ERROR =
  '429 {"error":{"type":"rate_limit_error","message":"Type 2b rate limited. Please try again later."}}';

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
    this.onclose?.(new CloseEvent("close"));
  });

  emitOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  emitMessage(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent);
  }
}

function getMainSocket(): MockWebSocket {
  const socket = MockWebSocket.instances.find((candidate) =>
    candidate.url.includes("/ws/ws-1"),
  );
  if (!socket) {
    throw new Error("Main chat WebSocket was not created");
  }

  return socket;
}

describe("Chat AskUserQuestion composer focus", () => {
  beforeAll(() => {
    if (!HTMLElement.prototype.scrollTo) {
      Object.defineProperty(HTMLElement.prototype, "scrollTo", {
        value: vi.fn(),
        writable: true,
      });
    }

    if (!HTMLElement.prototype.scrollIntoView) {
      Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
        value: vi.fn(),
        writable: true,
      });
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket as unknown as typeof WebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("returns focus to the composer after sending a question response", async () => {
    const user = userEvent.setup();

    render(
      <Chat
        threadId="thread-1"
        workspaceId="ws-1"
        initialMessages={[]}
        isLoadingMessages
      />,
    );

    const socket = getMainSocket();
    act(() => {
      socket.emitOpen();
    });

    const prompt = screen.getByLabelText("Prompt");
    prompt.focus();
    expect(prompt).toHaveFocus();

    act(() => {
      socket.emitMessage({
        type: "ask_user_question",
        questionId: "question-1",
        questions: [
          {
            header: "Framework",
            question: "Which framework do you want?",
            multiSelect: false,
            options: [
              { label: "Next.js", description: "" },
              { label: "Remix", description: "" },
            ],
          },
        ],
      });
    });

    await user.click(screen.getByRole("button", { name: "Answer question" }));

    expect(socket.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "question_response",
        questionId: "question-1",
        answers: { "Which framework do you want?": "Remix" },
      }),
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Prompt")).toHaveFocus();
    });
  });

  it("uses worker provider metadata for BYOK rate-limit websocket errors", async () => {
    render(
      <Chat
        threadId="thread-1"
        workspaceId="ws-1"
        initialMessages={[]}
        llmProvider={null}
      />,
    );

    const socket = getMainSocket();
    act(() => {
      socket.emitOpen();
      socket.emitMessage({
        type: "error",
        error: RATE_LIMIT_ERROR,
        billingSource: "byok",
        provider: "bedrock",
      });
    });

    expect(
      await screen.findByText("Your Bedrock API key is rate limited"),
    ).toBeInTheDocument();
    const link = screen.getByRole("link", {
      name: /Open the AWS Bedrock console/,
    });
    expect(link).toHaveAttribute("href", BYOK_PROVIDERS.bedrock.getKeyUrl);
  });

  it("falls back to the current provider when websocket provider metadata is absent", async () => {
    render(
      <Chat
        threadId="thread-1"
        workspaceId="ws-1"
        initialMessages={[]}
        llmProvider="anthropic"
        threadProvider="claude"
      />,
    );

    const socket = getMainSocket();
    act(() => {
      socket.emitOpen();
      socket.emitMessage({
        type: "error",
        error: RATE_LIMIT_ERROR,
        billingSource: "byok",
      });
    });

    expect(
      await screen.findByText("Your Anthropic API key is rate limited"),
    ).toBeInTheDocument();
    const link = screen.getByRole("link", {
      name: /Open Anthropic API settings/,
    });
    expect(link).toHaveAttribute("href", BYOK_PROVIDERS.anthropic.getKeyUrl);
  });
});
