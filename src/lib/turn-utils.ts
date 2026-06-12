import type { ContentBlock, Message } from "@/types";
import { stripMentionAnnotations } from "@/lib/mentions";

export type MessageRenderMode = "full" | "trace-only" | "final-text-only";

const SYSTEM_MESSAGE_TAG_REGEX =
  /<camelai system message>[\s\S]*?<\/camelai system message>/g;

export function stripSystemMessageTags(text: string): string {
  return stripMentionAnnotations(text.replace(SYSTEM_MESSAGE_TAG_REGEX, "")).trim();
}

export function isRedactedThinkingBlock(block: ContentBlock): boolean {
  if (block.type === "redacted_thinking") return true;
  if (block.type !== "thinking") return false;

  const rawBlock = block as ContentBlock & {
    redacted?: boolean;
    thinkingSignature?: string;
  };
  return (
    rawBlock.redacted === true ||
    rawBlock.thinkingSignature?.startsWith("openrouter.reasoning:") === true ||
    block.signature?.startsWith("openrouter.reasoning:") === true ||
    block.thinking.trim() === "[Reasoning redacted]"
  );
}

export function isVisibleThinkingBlock(block: ContentBlock): boolean {
  if (block.type !== "thinking" || isRedactedThinkingBlock(block)) {
    return false;
  }
  if (block.thinking.trim().length > 0) {
    return true;
  }
  return Array.isArray(block.summaries)
    ? block.summaries.some((summary) => summary.trim().length > 0)
    : false;
}

function isVisibleTextBlock(block: ContentBlock): boolean {
  return block.type === "text" && stripSystemMessageTags(block.text).length > 0;
}

function isTraceWorkBlock(block: ContentBlock): boolean {
  return (
    block.type === "tool_use" ||
    block.type === "tool_result" ||
    isVisibleThinkingBlock(block) ||
    block.type === "teammate_message" ||
    block.type === "task_notification"
  );
}

function isTraceTextBoundaryBlock(block: ContentBlock): boolean {
  return (
    block.type === "tool_use" ||
    block.type === "tool_result" ||
    isVisibleThinkingBlock(block)
  );
}

function isTraceTextBlock(
  block: ContentBlock,
  blockIndex: number,
  lastTraceTextBoundaryBlockIndex: number,
): boolean {
  return (
    blockIndex < lastTraceTextBoundaryBlockIndex &&
    isVisibleTextBlock(block)
  );
}

function toTextBlock(text: string): ContentBlock {
  return { type: "text", text };
}

function getTurnContentBlocks(messages: Message[]): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  for (const message of messages) {
    if (typeof message.content === "string") {
      blocks.push(toTextBlock(message.content));
      continue;
    }
    blocks.push(...message.content);
  }
  return blocks;
}

function getLastTraceTextBoundaryBlockIndex(blocks: ContentBlock[]): number {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    if (isTraceTextBoundaryBlock(blocks[index])) {
      return index;
    }
  }
  return -1;
}

export function countTurnSteps(messages: Message[]): number {
  let count = 0;
  const blocks = getTurnContentBlocks(messages);
  const lastTraceTextBoundaryBlockIndex = getLastTraceTextBoundaryBlockIndex(blocks);
  const turnToolUseIds = new Set<string>();

  for (const block of blocks) {
    if (block.type === "tool_use") {
      turnToolUseIds.add(block.id);
    }
  }

  for (const [index, block] of blocks.entries()) {
    if (block.type === "tool_use") {
      count += 1;
    } else if (isVisibleThinkingBlock(block)) {
      count += 1;
    } else if (isTraceTextBlock(block, index, lastTraceTextBoundaryBlockIndex)) {
      count += 1;
    } else if (block.type === "tool_result" && !turnToolUseIds.has(block.tool_use_id)) {
      count += 1;
    } else if (
      block.type === "teammate_message" ||
      block.type === "task_notification"
    ) {
      count += 1;
    }
  }
  return count;
}

function isTraceContentBlock(block: ContentBlock): boolean {
  return isTraceWorkBlock(block);
}

export function formatTurnDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function formatTurnDurationForScreenReader(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds} seconds`;
  if (seconds === 0) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  return `${minutes} minute${minutes === 1 ? "" : "s"} ${seconds} second${seconds === 1 ? "" : "s"}`;
}

export function filterContentForRenderMode(
  content: string | ContentBlock[],
  renderMode: MessageRenderMode,
): string | ContentBlock[] {
  if (renderMode === "full") return content;
  if (typeof content === "string") {
    return renderMode === "final-text-only" ? content : [];
  }
  return content.filter((block) => {
    if (renderMode === "trace-only") {
      return isTraceContentBlock(block);
    }
    return block.type === "text" || block.type === "error";
  });
}

export function hasFinalOutput(messages: Message[]): boolean {
  const actionMessage = messages[messages.length - 1];
  if (!actionMessage) return false;
  return buildFinalOutputMessageView(messages, actionMessage.id) !== null;
}

export function buildTraceMessageView(
  messages: Message[],
  actionMessageId: string,
): Message | null {
  if (messages.length === 0) return null;

  const traceBlocks: ContentBlock[] = [];
  const blocks = getTurnContentBlocks(messages);
  const lastTraceTextBoundaryBlockIndex = getLastTraceTextBoundaryBlockIndex(blocks);
  for (const [index, block] of blocks.entries()) {
    if (
      isTraceWorkBlock(block) ||
      isTraceTextBlock(block, index, lastTraceTextBoundaryBlockIndex)
    ) {
      traceBlocks.push(block);
    }
  }

  if (traceBlocks.length === 0) return null;

  const lastAssistantMessage = messages[messages.length - 1];
  const actionMessage =
    messages.find((message) => message.id === actionMessageId) ??
    lastAssistantMessage;

  return {
    ...lastAssistantMessage,
    id: actionMessageId,
    forkEntryId: actionMessage.forkEntryId,
    content: traceBlocks,
    isStreaming: false,
  };
}

export function buildFinalOutputMessageView(
  messages: Message[],
  actionMessageId: string,
): Message | null {
  if (messages.length === 0) return null;

  const outputBlocks: ContentBlock[] = [];
  const blocks = getTurnContentBlocks(messages);
  const lastTraceTextBoundaryBlockIndex = getLastTraceTextBoundaryBlockIndex(blocks);
  for (const [index, block] of blocks.entries()) {
    if (block.type === "text") {
      if (!isTraceTextBlock(block, index, lastTraceTextBoundaryBlockIndex) && isVisibleTextBlock(block)) {
        outputBlocks.push(block);
      }
      continue;
    }

    if (block.type === "error") {
      outputBlocks.push(block);
    }
  }

  if (outputBlocks.length === 0) return null;

  const lastAssistantMessage = messages[messages.length - 1];
  const actionMessage =
    messages.find((message) => message.id === actionMessageId) ??
    lastAssistantMessage;

  return {
    ...lastAssistantMessage,
    id: actionMessageId,
    forkEntryId: actionMessage.forkEntryId,
    content: outputBlocks,
    isStreaming: false,
  };
}
