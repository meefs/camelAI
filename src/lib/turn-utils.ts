import type { ContentBlock, Message } from "@/types";
import { stripMentionAnnotations } from "@/lib/connection-mentions";

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

export function countTurnSteps(messages: Message[]): number {
  let count = 0;
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    const toolUseIds = new Set(
      message.content
        .filter((block): block is ContentBlock & { type: "tool_use" } => block.type === "tool_use")
        .map((block) => block.id),
    );

    for (const block of message.content) {
      if (block.type === "tool_use") {
        count += 1;
      } else if (isVisibleThinkingBlock(block)) {
        count += 1;
      } else if (block.type === "tool_result" && !toolUseIds.has(block.tool_use_id)) {
        count += 1;
      } else if (
        block.type === "teammate_message" ||
        block.type === "task_notification"
      ) {
        count += 1;
      }
    }
  }
  return count;
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
      return block.type !== "text";
    }
    return block.type === "text" || block.type === "error";
  });
}

export function hasFinalOutput(messages: Message[]): boolean {
  return messages.some((message) => {
    if (typeof message.content === "string") {
      return stripSystemMessageTags(message.content).length > 0;
    }
    return message.content.some((block) => {
      if (block.type === "error") return true;
      return block.type === "text" && stripSystemMessageTags(block.text).length > 0;
    });
  });
}

export function buildFinalOutputMessageView(
  messages: Message[],
  actionMessageId: string,
): Message | null {
  if (messages.length === 0) return null;

  const outputBlocks: ContentBlock[] = [];
  for (const message of messages) {
    if (typeof message.content === "string") {
      const visibleText = stripSystemMessageTags(message.content);
      if (visibleText) {
        outputBlocks.push({ type: "text", text: message.content });
      }
      continue;
    }

    for (const block of message.content) {
      if (block.type === "text") {
        const visibleText = stripSystemMessageTags(block.text);
        if (visibleText) {
          outputBlocks.push(block);
        }
      } else if (block.type === "error") {
        outputBlocks.push(block);
      }
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
