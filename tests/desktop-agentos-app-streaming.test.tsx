import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DesktopServerEvent,
  DesktopSnapshot,
} from "../desktop/shared/protocol";
import type { ContentBlock } from "@/types";

vi.mock("@/components/message-bubble", () => ({
  ContentBlockRenderer: ({
    content,
  }: {
    content: string | ContentBlock[];
  }) => {
    const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content;
    return (
      <div data-testid="content-blocks">
        {blocks.map((block, index) => {
          if (block.type === "text") {
            return (
              <div key={index} data-kind="text" data-testid="text-block">
                {block.text}
              </div>
            );
          }
          if (block.type === "thinking") {
            return (
              <div key={index} data-kind="thinking" data-testid="thinking-block">
                {block.thinking}
              </div>
            );
          }
          if (block.type === "tool_use") {
            return (
              <div key={index} data-kind="tool_use" data-testid="tool-use-block">
                {block.name}:{JSON.stringify(block.input)}
              </div>
            );
          }
          if (block.type === "tool_result") {
            const resultContent =
              typeof block.content === "string"
                ? block.content
                : JSON.stringify(block.content);
            return (
              <div key={index} data-kind="tool_result" data-testid="tool-result-block">
                {resultContent}
              </div>
            );
          }
          return (
            <div key={index} data-kind={block.type} data-testid="other-block">
              {JSON.stringify(block)}
            </div>
          );
        })}
      </div>
    );
  },
}));

vi.mock("@/components/markdown-renderer", () => ({
  MarkdownRenderer: ({
    content,
  }: {
    content: string;
  }) => <div data-testid="markdown">{content}</div>,
}));

vi.mock("@/components/loading-dots", () => ({
  LoadingDots: () => <div data-testid="loading-dots">loading</div>,
}));

vi.mock("@/components/page-header", () => ({
  PageHeader: ({ breadcrumbs }: { breadcrumbs?: Array<{ label: string }> }) => (
    <div data-testid="page-header">
      {breadcrumbs?.map((crumb) => crumb.label).join(" / ")}
    </div>
  ),
}));

vi.mock("@/components/prompt-input", () => ({
  PromptInput: ({
    value,
    onChange,
    onSubmit,
    placeholder,
  }: {
    value: string;
    onChange: (value: string) => void;
    onSubmit: () => void;
    placeholder?: string;
  }) => (
    <div>
      <textarea
        aria-label="Prompt input"
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      <button onClick={onSubmit} type="button">
        Send
      </button>
    </div>
  ),
}));

vi.mock("@/components/ui/alert", () => ({
  Alert: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDescription: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
  }: {
    children: ReactNode;
    onClick?: () => void;
  }) => (
    <button onClick={onClick} type="button">
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/progress", () => ({
  Progress: ({ value }: { value: number }) => <div data-testid="progress">{value}</div>,
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
  SelectValue: ({ placeholder }: { placeholder?: string }) => <span>{placeholder}</span>,
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/ui/avatar", () => ({
  Avatar: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AvatarFallback: ({
    children,
    content,
  }: {
    children?: ReactNode;
    content?: string;
  }) => <div>{children ?? content}</div>,
}));

vi.mock("@/components/ui/sidebar", () => ({
  SidebarProvider: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SidebarInset: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Sidebar: ({ children }: { children: ReactNode }) => <aside>{children}</aside>,
  SidebarContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SidebarFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SidebarGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SidebarGroupAction: ({
    children,
    onClick,
  }: {
    children: ReactNode;
    onClick?: () => void;
  }) => (
    <button onClick={onClick} type="button">
      {children}
    </button>
  ),
  SidebarGroupContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SidebarGroupLabel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SidebarHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SidebarMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SidebarMenuButton: ({
    children,
    onClick,
  }: {
    children: ReactNode;
    onClick?: () => void;
  }) => (
    <button onClick={onClick} type="button">
      {children}
    </button>
  ),
  SidebarMenuItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SidebarRail: () => null,
  SidebarSeparator: () => <hr />,
  useSidebar: () => ({ state: "expanded" }),
}));

type DesktopShellListener = (event: DesktopServerEvent) => void;

type MockDesktopShell = {
  platform: string;
  versions: {
    chrome: string;
    electron: string;
    node: string;
  };
  getSnapshot: ReturnType<typeof vi.fn>;
  sendEvent: ReturnType<typeof vi.fn>;
  reportReady: ReturnType<typeof vi.fn>;
  onEvent: ReturnType<typeof vi.fn>;
};

function createSnapshot(): DesktopSnapshot {
  const now = Date.now();
  return {
    threads: [
      {
        id: "thread-1",
        provider: "agentos",
        title: "AgentOS test thread",
        createdAt: now,
        updatedAt: now,
        lastMessagePreview: null,
      },
    ],
    messagesByThread: {
      "thread-1": [],
    },
    activeThreadId: "thread-1",
    provider: "agentos",
    availableProviders: [{ id: "agentos", label: "AgentOS" }],
    model: "claude-sonnet-4-20250514",
    availableModels: [
      {
        id: "claude-sonnet-4-20250514",
        label: "Claude Sonnet 4",
        provider: "agentos",
      },
    ],
    auth: {
      provider: "agentos",
      available: true,
      source: "provider-account",
      label: "Claude Code OAuth",
    },
    runtimeStatus: {
      state: "running",
      detail: "Runtime ready",
      helperPath: null,
    },
  };
}

function createAgentOsRuntimeEvent(update: Record<string, unknown>): DesktopServerEvent {
  return {
    type: "runtime_event",
    threadId: "thread-1",
    provider: "agentos",
    event: {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        update,
      },
    },
  };
}

function installDesktopShell(snapshot: DesktopSnapshot) {
  let listener: DesktopShellListener | null = null;
  const shell: MockDesktopShell = {
    platform: "darwin",
    versions: {
      chrome: "1",
      electron: "1",
      node: "1",
    },
    getSnapshot: vi.fn(async () => snapshot),
    sendEvent: vi.fn(),
    reportReady: vi.fn(),
    onEvent: vi.fn((nextListener: DesktopShellListener) => {
      listener = nextListener;
      return () => {
        if (listener === nextListener) {
          listener = null;
        }
      };
    }),
  };

  Object.defineProperty(window, "desktopShell", {
    configurable: true,
    writable: true,
    value: shell,
  });

  return {
    shell,
    emit: async (event: DesktopServerEvent) => {
      if (!listener) {
        throw new Error("desktopShell listener is not registered");
      }
      await act(async () => {
        listener?.(event);
        await Promise.resolve();
      });
    },
  };
}

async function renderAppWithShell(snapshot: DesktopSnapshot) {
  vi.resetModules();
  const { shell, emit } = installDesktopShell(snapshot);
  const { App } = await import("../desktop/renderer/src/App");

  render(<App />);

  await waitFor(() => {
    expect(shell.getSnapshot).toHaveBeenCalledTimes(1);
    expect(shell.onEvent).toHaveBeenCalledTimes(1);
  });

  await emit({
    type: "snapshot",
    snapshot,
  });

  await waitFor(() => {
    expect(shell.reportReady).toHaveBeenCalled();
    expect(
      screen.getByRole("region", { name: "Chat messages" }),
    ).toBeInTheDocument();
  });

  return { shell, emit };
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, "requestAnimationFrame", {
    configurable: true,
    writable: true,
    value: (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0),
  });
  Object.defineProperty(window, "cancelAnimationFrame", {
    configurable: true,
    writable: true,
    value: (handle: number) => window.clearTimeout(handle),
  });
});

afterEach(() => {
  delete window.desktopShell;
});

describe("desktop AgentOS renderer streaming", () => {
  it("renders streamed ACP text chunks before the turn finishes", async () => {
    const { emit } = await renderAppWithShell(createSnapshot());

    expect(screen.queryByTestId("text-block")).toBeNull();

    await emit(
      createAgentOsRuntimeEvent({
        sessionUpdate: "agent_message_chunk",
        content: "Checking now.",
      }),
    );

    await waitFor(() => {
      expect(screen.getByText("Checking now.")).toBeInTheDocument();
      expect(screen.getByTestId("loading-dots")).toBeInTheDocument();
    });

    const textBlocks = screen.getAllByTestId("text-block");
    expect(textBlocks).toHaveLength(1);
    expect(textBlocks[0]).toHaveTextContent("Checking now.");
  });

  it("keeps later text in a new section after tool activity", async () => {
    const { emit } = await renderAppWithShell(createSnapshot());

    await emit(
      createAgentOsRuntimeEvent({
        sessionUpdate: "agent_message_chunk",
        content: "Checking now.",
      }),
    );

    await emit(
      createAgentOsRuntimeEvent({
        sessionUpdate: "tool_call",
        toolCallId: "call-1",
        title: "ls",
        rawInput: { path: "." },
      }),
    );

    await emit(
      createAgentOsRuntimeEvent({
        sessionUpdate: "tool_call_update",
        toolCallId: "call-1",
        rawOutput: "alpha\nbeta",
        status: "completed",
      }),
    );

    await emit(
      createAgentOsRuntimeEvent({
        sessionUpdate: "agent_message_chunk",
        content: "Done checking.",
      }),
    );

    await waitFor(() => {
      expect(screen.getByText("Done checking.")).toBeInTheDocument();
    });

    const contentBlocks = Array.from(
      screen.getByTestId("content-blocks").children,
    ).map((element) => ({
      kind: element.getAttribute("data-kind"),
      text: element.textContent,
    }));

    expect(contentBlocks).toEqual([
      { kind: "text", text: "Checking now." },
      { kind: "tool_use", text: 'ls:{"path":"."}' },
      { kind: "tool_result", text: "alpha\nbeta" },
      { kind: "text", text: "Done checking." },
    ]);

    const textBlocks = screen.getAllByTestId("text-block");
    expect(textBlocks).toHaveLength(2);
    expect(textBlocks[0]).toHaveTextContent("Checking now.");
    expect(textBlocks[1]).toHaveTextContent("Done checking.");
  });
});
