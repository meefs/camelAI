/**
 * The view of a runtime thread (plans/runtime-threads-direct.md §5.3): the
 * agent's Pi messages, as the runtime keeps them, projected onto the `Message`
 * view model the chat renderer draws. Pure and recomputed per render; nothing
 * here is stored or sent.
 *
 * - A user message is a user bubble; its sender (`from.name`) is the author.
 * - Everything the agent did between two user messages (its assistant
 *   messages and their tool results) is one assistant message, as a turn is
 *   one message on ChatThreadDO's path; each tool result follows its call.
 * - Tool calls are shaped as the DO's live path shapes them (the same tool
 *   names and inputs, through pi-tool-builders), so every tool view works.
 * - An aborted response ends with "Stopped by user"; a failed one with an
 *   error block.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ContentBlock, ErrorBlock, Message, ToolResultBlock } from "@/types";
import { localToolName, readableProviderError } from "@/lib/agent-runtime-shared";
import {
  buildToolResultFromPiItem,
  buildToolUseFromPiItem,
  type PiThreadItem,
} from "@/lib/pi-tool-builders";
import { mergeLiveToolOutput } from "@/lib/use-pi-chat-stream";

const STOPPED_BY_USER_TEXT = "Stopped by user";

type Part = { type?: string; text?: string; thinking?: string; redacted?: boolean; thinkingSignature?: string; id?: string; name?: string; arguments?: unknown };
type PiUser = { role: "user"; content: string | Part[]; timestamp?: number; from?: { id?: string; name?: string; username?: string } };
type PiToolResult = {
  role: "toolResult";
  toolCallId: string;
  toolName?: string;
  content?: Part[];
  details?: unknown;
  isError?: boolean;
  timestamp?: number;
};

export interface PiRenderInput {
  threadId: string;
  /** The agent's messages, oldest first, and each one's index in its history. */
  messages: readonly AgentMessage[];
  indexes: readonly number[];
  /** The assistant message streaming now. */
  partial: AssistantMessage | null;
  /** Live tool output (a running call's latest progress), by tool call id. */
  progress?: ReadonlyMap<string, unknown>;
  running: boolean;
  /** The client message id each user message was sent with, by its history index (known only for this tab's sends). */
  clientMessageIds?: ReadonlyMap<number, string>;
}

export interface PiRenderResult {
  messages: Message[];
  /** The turn message streaming now, if any. */
  streamingMessageId: string | null;
}

/** A message's id in the view: `rt:<its index>`, or for a turn, the index of its first message. */
export function runtimeMessageId(index: number): string {
  return `rt:${index}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function textOf(content: string | Part[] | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part?.type === "text" && typeof part.text === "string" ? part.text : "")).join("");
}

/** A tool call as the DO's live path describes it (a dynamicToolCall item). */
function toolItem(id: string, name: unknown, args: unknown, result?: PiToolResult): PiThreadItem {
  const tool = String(localToolName(name) || "tool");
  const argumentsValue = isRecord(args) ? args : {};
  if (!result) return { id, type: "dynamicToolCall", tool, arguments: argumentsValue, status: "inProgress" };
  const isError = result.isError === true;
  return {
    id,
    type: "dynamicToolCall",
    tool,
    arguments: argumentsValue,
    status: isError ? "failed" : "completed",
    isError,
    result: { content: result.content ?? [], details: result.details },
    contentItems: result.content ?? [],
  };
}

function toolResultBlock(id: string, item: PiThreadItem, result: PiToolResult): ToolResultBlock {
  // The status rides the call's input; the result's text is the tool's own.
  const { status: _status, ...withoutStatus } = item;
  const built = buildToolResultFromPiItem(withoutStatus as PiThreadItem);
  const isError = result.isError === true || built?.isError === true;
  const details = built?.details ?? (isRecord(result.details) ? result.details : undefined);
  return {
    type: "tool_result",
    tool_use_id: id,
    content: built?.content ?? "",
    ...(isError ? { is_error: true, status: "failed" as const } : { status: "succeeded" as const }),
    itemId: id,
    ...(details ? { details } : {}),
  };
}

/** A tool result waiting on a person: its call shows as running until the real result replaces it. */
function isInputPlaceholder(result: PiToolResult): boolean {
  return isRecord(result.details) && Boolean(result.details.inputRequired);
}

function errorBlock(message: string): ErrorBlock {
  return { type: "error", error: readableProviderError(message) };
}

/** An assistant message's blocks, each tool call followed by its result when there is one. */
function assistantBlocks(message: AssistantMessage, results: ReadonlyMap<string, PiToolResult>): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  for (const part of (message.content ?? []) as Part[]) {
    if (!part) continue;
    if (part.type === "text" && typeof part.text === "string") {
      if (part.text) blocks.push({ type: "text", text: part.text });
    } else if (part.type === "thinking") {
      if (part.redacted) blocks.push({ type: "redacted_thinking" });
      else if (part.thinking) blocks.push({ type: "thinking", thinking: part.thinking, ...(part.thinkingSignature ? { signature: part.thinkingSignature } : {}) });
    } else if (part.type === "toolCall" && typeof part.id === "string") {
      const result = results.get(part.id);
      const settled = result && !isInputPlaceholder(result) ? result : undefined;
      const item = toolItem(part.id, part.name, part.arguments, settled);
      const use = buildToolUseFromPiItem(item);
      blocks.push({ type: "tool_use", id: part.id, name: use?.name ?? String(item.tool), input: use?.input ?? {} });
      if (settled) blocks.push(toolResultBlock(part.id, item, settled));
    }
  }
  if (message.stopReason === "aborted") {
    blocks.push({ type: "text", text: STOPPED_BY_USER_TEXT, itemKind: "userStop" } as ContentBlock);
  } else if (message.stopReason === "error" && message.errorMessage) {
    blocks.push(errorBlock(message.errorMessage));
  }
  return blocks;
}

function timestampOf(message: unknown): number | undefined {
  const value = isRecord(message) ? message.timestamp : undefined;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Project a runtime thread's messages onto the chat's view model. */
export function piRender(input: PiRenderInput): PiRenderResult {
  const { threadId, messages, indexes } = input;
  const results = new Map<string, PiToolResult>();
  for (const message of messages) {
    if ((message as { role?: string }).role === "toolResult") {
      const result = message as unknown as PiToolResult;
      results.set(result.toolCallId, result);
    }
  }

  const view: Message[] = [];
  let turn: { message: Message; blocks: ContentBlock[]; startedAt: number | undefined } | null = null;
  let lastUserAt: number | undefined;
  const closeTurn = (settledAt: number | undefined) => {
    if (!turn) return;
    turn.message.content = turn.blocks;
    if (settledAt !== undefined) {
      turn.message.completedAtMs = settledAt;
      if (lastUserAt !== undefined && settledAt >= lastUserAt) turn.message.turnDurationMs = settledAt - lastUserAt;
    }
    view.push(turn.message);
    turn = null;
  };
  let lastAssistantAt: number | undefined;

  messages.forEach((message, position) => {
    const index = indexes[position] ?? position;
    const role = (message as { role?: string }).role;
    if (role === "user") {
      closeTurn(lastAssistantAt);
      const user = message as unknown as PiUser;
      lastUserAt = timestampOf(user);
      const clientMessageId = input.clientMessageIds?.get(index);
      view.push({
        id: runtimeMessageId(index),
        thread_id: threadId,
        role: "user",
        content: textOf(user.content),
        created_at: lastUserAt ?? 0,
        ...(user.from?.name ? { authorDisplayName: user.from.name } : {}),
        ...(clientMessageId ? { clientMessageId } : {}),
      });
      return;
    }
    if (role !== "assistant") return;
    const assistant = message as unknown as AssistantMessage;
    lastAssistantAt = timestampOf(assistant);
    if (!turn) {
      turn = {
        message: { id: runtimeMessageId(index), thread_id: threadId, role: "assistant", content: [], created_at: lastAssistantAt ?? 0 },
        blocks: [],
        startedAt: lastAssistantAt,
      };
    }
    turn.blocks.push(...assistantBlocks(assistant, results));
  });

  let streamingMessageId: string | null = null;
  if (input.partial || input.running) {
    const nextIndex = indexes.length > 0 ? indexes[indexes.length - 1] + 1 : 0;
    if (!turn) {
      // The turn has not finished a message yet: it takes the index its first one will.
      turn = {
        message: { id: runtimeMessageId(nextIndex), thread_id: threadId, role: "assistant", content: [], created_at: timestampOf(input.partial) ?? Date.now() },
        blocks: [],
        startedAt: undefined,
      };
    }
    if (input.partial) turn.blocks.push(...assistantBlocks(input.partial, results).filter((block) => block.type !== "error"));
    const current: { message: Message; blocks: ContentBlock[] } = turn;
    current.message.isStreaming = true;
    streamingMessageId = current.message.id;
    closeTurn(undefined);
  } else {
    closeTurn(lastAssistantAt);
  }

  if (input.progress && input.progress.size > 0 && streamingMessageId) {
    const live = new Map<string, string>();
    for (const [toolCallId, update] of input.progress) {
      const text = isRecord(update) ? textOf(update.content as Part[]) : typeof update === "string" ? update : "";
      if (text) live.set(toolCallId, text);
    }
    const at = view.findIndex((message) => message.id === streamingMessageId);
    if (at >= 0 && live.size > 0) view[at] = mergeLiveToolOutput(view[at], live);
  }
  return { messages: view, streamingMessageId };
}

/** The todo list of the thread's latest TodoWrite call, or null when it has none. */
export function latestRuntimeTodos(messages: readonly AgentMessage[]): Array<{ content: string; status: string; activeForm: string }> | null {
  for (let at = messages.length - 1; at >= 0; at--) {
    const message = messages[at] as { role?: string; content?: Part[] };
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (let part = message.content.length - 1; part >= 0; part--) {
      const block = message.content[part];
      if (block?.type !== "toolCall" || !isRecord(block.arguments)) continue;
      const name = String(localToolName(block.name));
      if (name !== "TodoWrite" && name !== "todo_write" && name !== "update_todo") continue;
      const list = Array.isArray(block.arguments.todos) ? block.arguments.todos : Array.isArray(block.arguments.items) ? block.arguments.items : [];
      return list.flatMap((item: unknown) => {
        if (!isRecord(item)) return [];
        const content = String(item.content ?? item.text ?? "").trim();
        if (!content) return [];
        const status = item.status === "completed" || item.status === "in_progress" ? item.status : item.status === "inProgress" ? "in_progress" : "pending";
        return [{ content, status, activeForm: String(item.activeForm ?? item.active_form ?? content) }];
      });
    }
  }
  return null;
}

/**
 * The share of the model's context the latest response used (input and cache
 * tokens over the window), or null without a window or a response.
 */
export function runtimeContextUsedPercent(messages: readonly AgentMessage[], contextWindow: number | null | undefined): number | null {
  if (!contextWindow || contextWindow <= 0) return null;
  for (let at = messages.length - 1; at >= 0; at--) {
    const message = messages[at] as { role?: string; usage?: { input?: number; cacheRead?: number; cacheWrite?: number } };
    if (message.role !== "assistant" || !message.usage) continue;
    const used = (message.usage.input ?? 0) + (message.usage.cacheRead ?? 0) + (message.usage.cacheWrite ?? 0);
    if (used <= 0) continue;
    return Math.max(0, Math.min(100, (used / contextWindow) * 100));
  }
  return null;
}
