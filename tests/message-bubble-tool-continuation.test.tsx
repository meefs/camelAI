import { render, screen } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { MessageBubble } from "@/components/message-bubble";
import type { Message } from "@/types";

vi.mock("@/hooks/use-auth-data", () => ({
  useAuthData: () => ({
    currentWorkspace: { id: "ws-1" },
  }),
}));

vi.mock("@/components/markdown-renderer", () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>,
}));

vi.mock("@/components/tool-call", () => ({
  ThinkingBlock: () => null,
  ToolCall: ({ agentContinued }: { agentContinued?: boolean }) => (
    <div data-testid="tool-call" data-agent-continued={agentContinued ? "true" : "false"} />
  ),
}));

vi.mock("@/components/tool-call/teammate-message", () => ({
  TeammateMessage: () => null,
}));

vi.mock("@/components/tool-call/task-notification", () => ({
  TaskNotification: () => null,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: ComponentProps<"button">) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

describe("MessageBubble tool continuation", () => {
  it("marks tool calls as continued when text follows later in the message", () => {
    const message: Message = {
      id: "assistant-message",
      thread_id: "thread-1",
      role: "assistant",
      created_at: Date.now(),
      content: [
        { type: "tool_use", id: "tool_1", name: "Read", input: {} },
        { type: "tool_use", id: "tool_2", name: "Read", input: {} },
        { type: "text", text: "Done" },
      ],
    };

    render(
      <MessageBubble message={message} onCopy={vi.fn()} copiedId={null} />,
    );

    expect(
      screen.getAllByTestId("tool-call").map((node) =>
        node.getAttribute("data-agent-continued"),
      ),
    ).toEqual(["true", "true"]);
  });
});
