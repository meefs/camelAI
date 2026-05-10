import type { ContentBlock } from "@/types";

function safeJsonStringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function isContentBlock(value: unknown): value is ContentBlock {
  if (!value || typeof value !== "object" || !("type" in value)) return false;
  const type = (value as { type?: string }).type;
  return (
    type === "text" ||
    type === "tool_use" ||
    type === "tool_result" ||
    type === "thinking" ||
    type === "redacted_thinking" ||
    type === "teammate_message" ||
    type === "task_notification"
  );
}

function coerceContentBlocks(value: unknown): ContentBlock[] | null {
  if (Array.isArray(value) && value.every(isContentBlock)) return value;
  if (isContentBlock(value)) return [value];
  return null;
}

export function parseMessageContent(
  content: string | ContentBlock[],
): string | ContentBlock[] {
  const directBlocks = coerceContentBlocks(content);
  if (directBlocks) return directBlocks;

  if (typeof content !== "string") return safeJsonStringify(content);

  const trimmed = content.trim();
  if (
    (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
    (trimmed.startsWith("{") && trimmed.endsWith("}"))
  ) {
    try {
      const parsed = JSON.parse(trimmed);
      const parsedBlocks = coerceContentBlocks(parsed);
      if (parsedBlocks) return parsedBlocks;
    } catch {
      // Plain string content.
    }
  }

  return content;
}

