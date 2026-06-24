import type { ContentBlock, CondensedTranscript, Message } from "@/types";
import {
  buildFinalOutputMessageView,
  countTurnSteps,
  stripSystemMessageTags,
} from "@/lib/turn-utils";
import { normalizeThreadUserMessageText } from "@/lib/thread-preview";

type TranscriptSourceMessage = {
  id: string;
  thread_id: string;
  role: "user" | "assistant";
  content: unknown;
  created_at: number;
  forkEntryId?: string;
  sentDuringStreaming?: boolean;
  isMeta?: boolean;
  sourceToolUseID?: string;
  isCompactSummary?: boolean;
};

function isContentBlock(value: unknown): value is ContentBlock {
  if (!value || typeof value !== "object") return false;
  const type = (value as { type?: unknown }).type;
  return (
    type === "text" ||
    type === "tool_use" ||
    type === "tool_result" ||
    type === "thinking" ||
    type === "redacted_thinking" ||
    type === "teammate_message" ||
    type === "task_notification" ||
    type === "error"
  );
}

function contentToMessageContent(content: unknown): Message["content"] {
  if (typeof content === "string") return content;
  if (Array.isArray(content) && content.every(isContentBlock)) {
    return content;
  }
  if (isContentBlock(content)) {
    return [content];
  }
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function toMessage(message: TranscriptSourceMessage): Message {
  return {
    id: message.id,
    thread_id: message.thread_id,
    role: message.role,
    content: contentToMessageContent(message.content),
    created_at: message.created_at,
    forkEntryId: message.forkEntryId,
    sentDuringStreaming: message.sentDuringStreaming,
    isMeta: message.isMeta,
    sourceToolUseID: message.sourceToolUseID,
    isCompactSummary: message.isCompactSummary,
  };
}

export function userFacingAssistantContentToString(
  content: Message["content"],
): string {
  if (typeof content === "string") {
    return stripSystemMessageTags(content).trim();
  }
  return content
    .map((block) => {
      if (block.type === "text") {
        return stripSystemMessageTags(block.text).trim();
      }
      if (block.type === "error") {
        return stripSystemMessageTags(block.error).trim();
      }
      return "";
    })
    .filter(Boolean)
    .join("\n\n");
}

export function buildCondensedTranscript(
  args: {
    threadId: string;
    title: string;
    messages: TranscriptSourceMessage[];
  },
): CondensedTranscript {
  const turns: CondensedTranscript["turns"] = [];
  let currentUser: Message | null = null;
  let assistantMessages: Message[] = [];

  const flushTurn = () => {
    if (!currentUser || assistantMessages.length === 0) {
      currentUser = null;
      assistantMessages = [];
      return;
    }

    const user = normalizeThreadUserMessageText(currentUser.content);
    const actionMessage = assistantMessages[assistantMessages.length - 1];
    const finalMessage = actionMessage
      ? buildFinalOutputMessageView(assistantMessages, actionMessage.id)
      : null;
    const assistantFinal = finalMessage
      ? userFacingAssistantContentToString(finalMessage.content)
      : "";

    if (user && assistantFinal) {
      turns.push({
        user,
        assistantFinal,
        omittedCount: countTurnSteps(assistantMessages),
      });
    }

    currentUser = null;
    assistantMessages = [];
  };

  for (const sourceMessage of args.messages) {
    const message = toMessage(sourceMessage);
    if (message.isMeta || message.isCompactSummary) {
      continue;
    }

    if (message.role === "user") {
      flushTurn();
      currentUser = message;
      assistantMessages = [];
      continue;
    }

    if (message.role === "assistant" && currentUser) {
      assistantMessages.push(message);
    }
  }

  flushTurn();

  return {
    threadId: args.threadId,
    title: args.title,
    turns,
  };
}

export function condensedTranscriptToMarkdown(
  transcript: CondensedTranscript,
): string {
  const lines: string[] = [
    `# ${transcript.title || "Chat"} transcript`,
    "",
    `Source thread: ${transcript.threadId}`,
  ];

  transcript.turns.forEach((turn, index) => {
    lines.push(
      "",
      `## Turn ${index + 1}`,
      "",
      "### User",
      "",
      turn.user,
      "",
      "### Assistant",
      "",
    );
    if (turn.omittedCount > 0) {
      lines.push(`_[${turn.omittedCount} messages omitted]_`, "");
    }
    lines.push(turn.assistantFinal);
  });

  return `${lines.join("\n").trim()}\n`;
}
