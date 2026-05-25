import { createRef, type ComponentProps } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatMessagesView } from "@/components/chat-messages-view";
import type { ContentBlock, Message } from "@/types";

type MessageBubbleCall = {
  renderMode: string;
  message: Message;
  suppressFinalizedState: boolean;
};

const bubbleHarness = vi.hoisted(() => ({
  calls: [] as MessageBubbleCall[],
}));

vi.mock("@/components/message-bubble", () => {
  function textFromContent(content: string | ContentBlock[]): string {
    if (typeof content === "string") return content;
    return content
      .map((block) => {
        if (block.type === "text") return block.text;
        if (block.type === "tool_use") return `[tool:${block.name}]`;
        if (block.type === "error") return block.error;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  return {
    MessageBubble: ({
      message,
      renderMode = "full",
      suppressFinalizedState = false,
    }: {
      message: Message;
      renderMode?: string;
      suppressFinalizedState?: boolean;
    }) => {
      bubbleHarness.calls.push({
        renderMode,
        message,
        suppressFinalizedState,
      });
      return (
        <div data-testid={`message-bubble-${renderMode}`}>
          {textFromContent(message.content)}
        </div>
      );
    },
    isInterruptMessage: () => false,
    parseLocalCommandStdout: () => null,
    parseSlashCommand: () => null,
    userFacingContentToString: textFromContent,
  };
});

type ChatMessagesViewProps = ComponentProps<typeof ChatMessagesView>;

function message(
  id: string,
  role: Message["role"],
  content: string | ContentBlock[],
  createdAt: number,
): Message {
  return {
    id,
    thread_id: "thread-1",
    role,
    content,
    created_at: createdAt,
  };
}

function createViewProps(
  overrides: Partial<ChatMessagesViewProps> = {},
): ChatMessagesViewProps {
  const divRef = createRef<HTMLDivElement>();
  return {
    visibleMessages: [],
    lastUserMessageId: null,
    lastMessageId: null,
    isAwaitingAssistant: false,
    isLastMessageAssistantLike: false,
    copyMessage: vi.fn(),
    copiedMessageId: null,
    runningStartedAt: null,
    activeTurnActionMessageId: null,
    completedTurns: new Map(),
    freshlyCompletedTurnId: null,
    onFreshlyCompletedTurnAnimationScheduled: vi.fn(),
    skillSheetsByToolId: new Map(),
    error: null,
    setError: vi.fn(),
    threadModel: null,
    isCompacting: false,
    compactingPriorMessageId: null,
    isLoadingMessages: false,
    showGlobalAssistantIndicator: false,
    shouldRenderSpacer: false,
    lastUserMessageRef: divRef,
    assistantMeasureRef: divRef,
    assistantPendingMeasureRef: divRef,
    assistantSpacerRef: divRef,
    messagesEndRef: divRef,
    ...overrides,
  };
}

function renderView(overrides: Partial<ChatMessagesViewProps> = {}) {
  return render(<ChatMessagesView {...createViewProps(overrides)} />);
}

function latestFinalOutputMessage(): Message | undefined {
  return bubbleHarness.calls
    .filter((call) => call.renderMode === "final-text-only")
    .at(-1)?.message;
}

describe("ChatMessagesView collapsed assistant turns", () => {
  beforeEach(() => {
    bubbleHarness.calls.length = 0;
  });

  it("collapses a finished assistant turn with work rows and keeps final text visible", () => {
    renderView({
      visibleMessages: [
        message("u1", "user", "read package.json", 1_000),
        message(
          "a1",
          "assistant",
          [
            { type: "tool_use", id: "tool-1", name: "Read", input: {} },
            { type: "tool_use", id: "tool-2", name: "Read", input: {} },
            { type: "text", text: "Done" },
          ],
          2_000,
        ),
      ],
      lastMessageId: "a1",
      isLastMessageAssistantLike: true,
      completedTurns: new Map([
        ["a1", { durationMs: 138_000, completedAtMs: 3_000 }],
      ]),
    });

    expect(screen.getByText("worked for")).toBeInTheDocument();
    expect(screen.getByText("2:18")).toBeInTheDocument();
    expect(screen.getByText("2 steps")).toBeInTheDocument();
    expect(screen.getByTestId("message-bubble-final-text-only")).toHaveTextContent(
      "Done",
    );
  });

  it("does not add a summary line to zero-step assistant replies", () => {
    renderView({
      visibleMessages: [
        message("u1", "user", "what is 2+2", 1_000),
        message("a1", "assistant", [{ type: "text", text: "4" }], 2_000),
      ],
    });

    expect(screen.queryByText("worked for")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("message-bubble-full")[1]).toHaveTextContent("4");
  });

  it("renders collapsed trace as one turn-wide message for split tool results", async () => {
    const user = userEvent.setup();
    const toolUse: ContentBlock = {
      type: "tool_use",
      id: "tool-1",
      name: "Read",
      input: {},
    };
    const toolResult: ContentBlock = {
      type: "tool_result",
      tool_use_id: "tool-1",
      content: "ok",
    };

    renderView({
      visibleMessages: [
        message("u1", "user", "read package.json", 1_000),
        message("a1", "assistant", [toolUse], 2_000),
        message(
          "a2",
          "assistant",
          [toolResult, { type: "text", text: "Done" }],
          3_000,
        ),
      ],
    });

    expect(screen.getByText("1 step")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /show work/i }));
    const traceCalls = bubbleHarness.calls.filter(
      (call) => call.renderMode === "trace-only",
    );
    expect(traceCalls).toHaveLength(1);
    expect(traceCalls[0]?.message.content).toEqual([toolUse, toolResult]);
  });

  it("keeps the synthetic final output message stable across unrelated rerenders", () => {
    const visibleMessages = [
      message("u1", "user", "read package.json", 1_000),
      message(
        "a1",
        "assistant",
        [
          { type: "tool_use", id: "tool-1", name: "Read", input: {} },
          { type: "text", text: "Done" },
        ],
        2_000,
      ),
    ];
    const props = createViewProps({
      visibleMessages,
      lastMessageId: "a1",
      isLastMessageAssistantLike: true,
    });
    const { rerender } = render(<ChatMessagesView {...props} />);
    const firstFinalOutputMessage = latestFinalOutputMessage();

    bubbleHarness.calls.length = 0;
    rerender(<ChatMessagesView {...props} copiedMessageId="unrelated-copy" />);
    const secondFinalOutputMessage = latestFinalOutputMessage();

    expect(firstFinalOutputMessage).toBeDefined();
    expect(secondFinalOutputMessage).toBe(firstFinalOutputMessage);
  });

  it("suppresses finalized actions on collapsed final output while compacting", () => {
    renderView({
      visibleMessages: [
        message("u1", "user", "read package.json", 1_000),
        message(
          "a1",
          "assistant",
          [
            { type: "tool_use", id: "tool-1", name: "Read", input: {} },
            { type: "text", text: "Done" },
          ],
          2_000,
        ),
      ],
      isCompacting: true,
      compactingPriorMessageId: "a1",
    });

    const finalOutputCall = bubbleHarness.calls.find(
      (call) => call.renderMode === "final-text-only",
    );
    expect(finalOutputCall?.message.id).toBe("a1");
    expect(finalOutputCall?.suppressFinalizedState).toBe(true);
  });
});
