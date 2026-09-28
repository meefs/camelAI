import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { latestRuntimeTodos, piRender, type PiRenderMemo } from "@/lib/pi-render";
import type { ContentBlock, ToolResultBlock, ToolUseBlock } from "@/types";

const usage = { input: 1000, output: 10, cacheRead: 500, cacheWrite: 0, totalTokens: 1510, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function user(text: string, timestamp: number, from?: { id: string; name?: string }): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp, ...(from ? { from } : {}) } as unknown as AgentMessage;
}

function assistant(content: unknown[], timestamp: number, extra: Record<string, unknown> = {}): AgentMessage {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-5",
    usage,
    stopReason: "stop",
    timestamp,
    ...extra,
  } as unknown as AgentMessage;
}

function toolResult(toolCallId: string, toolName: string, text: string, timestamp: number, extra: Record<string, unknown> = {}): AgentMessage {
  return { role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError: false, timestamp, ...extra } as unknown as AgentMessage;
}

function render(messages: AgentMessage[], extra: Partial<Parameters<typeof piRender>[0]> = {}) {
  return piRender({ threadId: "t1", messages, indexes: messages.map((_, index) => index), partial: null, running: false, ...extra });
}

const blocks = (content: unknown) => content as ContentBlock[];

describe("piRender", () => {
  it("makes a turn one assistant message, each tool result after its call, with chiridion's tool names", () => {
    const { messages, streamingMessageId } = render([
      user("Build it", 1000, { id: "u1", name: "Ada" }),
      assistant([{ type: "thinking", thinking: "plan" }, { type: "toolCall", id: "c1", name: "camel__read", arguments: { path: "a.ts" } }], 2000),
      toolResult("c1", "camel__read", "file text", 2500, { details: { truncated: false } }),
      assistant([{ type: "toolCall", id: "c2", name: "js_exec", arguments: { code: "1+1" } }], 3000),
      toolResult("c2", "js_exec", "2", 3500),
      assistant([{ type: "text", text: "Done." }], 4000),
    ]);
    expect(streamingMessageId).toBeNull();
    expect(messages.map((message) => [message.id, message.role])).toEqual([["rt:0", "user"], ["rt:1", "assistant"]]);
    expect(messages[0]).toMatchObject({ content: "Build it", authorDisplayName: "Ada", created_at: 1000 });
    const turn = blocks(messages[1].content);
    expect(turn.map((block) => block.type)).toEqual(["thinking", "tool_use", "tool_result", "tool_use", "tool_result", "text"]);
    const read = turn[1] as ToolUseBlock;
    expect(read).toMatchObject({ id: "c1", name: "Read", input: { path: "a.ts", rawToolName: "read" } });
    expect(turn[2] as ToolResultBlock).toMatchObject({ tool_use_id: "c1", content: "file text", status: "succeeded", details: { truncated: false } });
    expect((turn[3] as ToolUseBlock).name).toBe("JavaScript");
    expect(messages[1]).toMatchObject({ completedAtMs: 4000, turnDurationMs: 3000 });
  });

  it("ends an aborted response with the stop notice and a failed one with a readable error", () => {
    const aborted = render([user("hi", 1), assistant([{ type: "text", text: "partial" }], 2, { stopReason: "aborted" })]);
    expect(blocks(aborted.messages[1].content).at(-1)).toMatchObject({ type: "text", text: "Stopped by user", itemKind: "userStop" });
    const failed = render([
      user("hi", 1),
      assistant([], 2, { stopReason: "error", errorMessage: 'openrouter API error (429): {"error":{"message":"Slow down."}}' }),
    ]);
    expect(blocks(failed.messages[1].content)).toEqual([{ type: "error", error: "Slow down." }]);
  });

  it("shows the streaming turn, its partial response and live tool output", () => {
    const partial = { role: "assistant", content: [{ type: "text", text: "Work" }, { type: "toolCall", id: "c9", name: "camel__deploy_project", arguments: { name: "app" } }], stopReason: "stop", timestamp: 5 } as unknown as AssistantMessage;
    const { messages, streamingMessageId } = render([user("go", 1)], {
      partial,
      running: true,
      progress: new Map([["c9", { content: [{ type: "text", text: "building…" }] }]]),
    });
    expect(streamingMessageId).toBe("rt:1");
    expect(messages[1]).toMatchObject({ id: "rt:1", isStreaming: true });
    const turn = blocks(messages[1].content);
    expect(turn.map((block) => block.type)).toEqual(["text", "tool_use", "tool_result"]);
    expect(turn[2]).toMatchObject({ tool_use_id: "c9", content: "building…" });
  });

  it("keeps a call waiting on a person running until its real result", () => {
    const waiting = render([
      user("delete it", 1),
      assistant([{ type: "toolCall", id: "c1", name: "ask_user", arguments: {} }], 2),
      toolResult("c1", "ask_user", "waiting", 3, { details: { inputRequired: true } }),
    ]);
    expect(blocks(waiting.messages[1].content).map((block) => block.type)).toEqual(["tool_use"]);
  });

  it("tags this tab's sends with their client message ids, by history index", () => {
    const { messages } = render([user("one", 1), assistant([{ type: "text", text: "a" }], 2), user("two", 3)], {
      indexes: [10, 11, 12],
      clientMessageIds: new Map([[12, "cm_2"]]),
    });
    // A user message this tab sent keeps the id of its optimistic bubble.
    expect(messages.map((message) => message.id)).toEqual(["rt:10", "rt:11", "cm_2"]);
    expect(messages[2].clientMessageId).toBe("cm_2");
    expect(messages[0].clientMessageId).toBeUndefined();
  });
});

describe("piRender and the runtime's message metadata", () => {
  it("gives a user message its echoed requestId as the client id, and its source", () => {
    const message = { role: "user", content: "Deploy", timestamp: 1, requestId: "client_1_ab", metadata: { source: "slack", thread: "t1" } } as unknown as AgentMessage;
    const { messages } = render([message]);
    expect(messages[0]).toMatchObject({ clientMessageId: "client_1_ab", messageSource: "slack" });
  });
});

describe("piRender while a message is sent", () => {
  const history = [user("q1", 1), assistant([{ type: "text", text: "a1" }], 2)];

  it("does not make the previous answer the streaming turn when a run starts before its message", () => {
    const waiting = render(history, { running: true, pendingSends: 1 });
    expect(waiting.streamingMessageId).toBeNull();
    expect(waiting.messages.map((message) => message.id)).toEqual(["rt:0", "rt:1"]);
    expect(waiting.messages[1].isStreaming).toBeUndefined();
    // Another run (not ours) after a finished answer is a new turn.
    expect(render(history, { running: true }).streamingMessageId).toBe("rt:2");
  });

  it("keeps a turn that goes on (it called tools) as the streaming one", () => {
    const midTurn = [
      user("q", 1),
      assistant([{ type: "toolCall", id: "c1", name: "js_exec", arguments: {} }], 2, { stopReason: "toolUse" }),
      toolResult("c1", "js_exec", "ok", 3),
    ];
    expect(render(midTurn, { running: true }).streamingMessageId).toBe("rt:1");
    const partial = { role: "assistant", content: [{ type: "text", text: "more" }], stopReason: "stop", timestamp: 4 } as unknown as AssistantMessage;
    // A steer on its way does not move the response streaming now.
    expect(render(midTurn, { running: true, partial, pendingSends: 1 }).streamingMessageId).toBe("rt:1");
  });

  it("returns the same objects for rows whose messages did not change", () => {
    const memo: PiRenderMemo = new Map();
    const call = assistant([{ type: "toolCall", id: "c1", name: "js_exec", arguments: {} }], 2, { stopReason: "toolUse" });
    const messages = [...history, call];
    const a = piRender({ threadId: "t1", messages, indexes: [0, 1, 2], partial: null, running: false }, memo);
    const b = piRender({ threadId: "t1", messages, indexes: [0, 1, 2], partial: null, running: false }, memo);
    expect(b.messages[0]).toBe(a.messages[0]);
    expect(b.messages[1]).toBe(a.messages[1]);
    // A tool result arriving rebuilds only its turn.
    const withResult = [...messages, toolResult("c1", "js_exec", "2", 4)];
    const c = piRender({ threadId: "t1", messages: withResult, indexes: [0, 1, 2, 3], partial: null, running: false }, memo);
    expect(c.messages[0]).toBe(a.messages[0]);
    expect(c.messages[1]).not.toBe(a.messages[1]);
  });
});

describe("runtime thread derivations", () => {
  it("reads the latest todo list from the transcript", () => {
    expect(latestRuntimeTodos([user("x", 1)])).toBeNull();
    const todos = latestRuntimeTodos([
      assistant([{ type: "toolCall", id: "t1", name: "camel__TodoWrite", arguments: { todos: [{ content: "old", status: "pending" }] } }], 1),
      assistant([{ type: "toolCall", id: "t2", name: "camel__TodoWrite", arguments: { todos: [{ content: "Ship", status: "inProgress", activeForm: "Shipping" }, { content: "" }] } }], 2),
    ]);
    expect(todos).toEqual([{ content: "Ship", status: "in_progress", activeForm: "Shipping" }]);
  });
});
