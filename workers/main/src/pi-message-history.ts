import type { AgentMessage } from "@mariozechner/pi-agent-core";

export interface PiMessageHistoryRepairStats {
  droppedToolResults: number;
  syntheticToolResults: number;
  trimmedAssistantBlocks: number;
}

export interface PiMessageHistoryRepairResult {
  messages: AgentMessage[];
  stats: PiMessageHistoryRepairStats;
  repairedCount: number;
}

const INTERRUPTED_TOOL_RESULT_TEXT = "Tool call interrupted; no result was recorded.";

export function repairPiMessageHistoryForReplay(
  messages: AgentMessage[],
): PiMessageHistoryRepairResult {
  const repaired: AgentMessage[] = [];
  let pendingToolCallIds: Map<string, number> | null = null;
  let pendingToolCallNames: Map<string, string> | null = null;
  let droppedToolResults = 0;
  let syntheticToolResults = 0;
  let trimmedAssistantBlocks = 0;

  const flushUnmatchedToolCalls = () => {
    if (!pendingToolCallIds) return;
    for (const [id, remaining] of pendingToolCallIds.entries()) {
      for (let i = 0; i < remaining; i++) {
        repaired.push({
          role: "toolResult",
          toolCallId: id,
          toolName: pendingToolCallNames?.get(id) ?? "",
          content: [
            {
              type: "text",
              text: INTERRUPTED_TOOL_RESULT_TEXT,
            },
          ],
          isError: true,
          timestamp: Date.now(),
        } as unknown as AgentMessage);
        syntheticToolResults += 1;
      }
    }
    pendingToolCallIds = null;
    pendingToolCallNames = null;
  };

  for (const message of messages) {
    const record = message as unknown as Record<string, unknown>;
    if (record.role === "assistant") {
      flushUnmatchedToolCalls();
      const trimmed = trimAssistantContentAfterLastToolCall(message);
      trimmedAssistantBlocks += trimmed.removedBlocks;
      repaired.push(trimmed.message);
      const collected = collectToolCalls(trimmed.message);
      pendingToolCallIds = collected?.ids ?? null;
      pendingToolCallNames = collected?.names ?? null;
      continue;
    }

    if (record.role === "toolResult") {
      const toolCallId = typeof record.toolCallId === "string"
        ? record.toolCallId.trim()
        : "";
      const remaining = toolCallId && pendingToolCallIds
        ? pendingToolCallIds.get(toolCallId) ?? 0
        : 0;
      if (remaining > 0) {
        pendingToolCallIds?.set(toolCallId, remaining - 1);
        repaired.push(message);
      } else {
        droppedToolResults += 1;
      }
      continue;
    }

    flushUnmatchedToolCalls();
    repaired.push(message);
  }

  flushUnmatchedToolCalls();

  const repairedCount = droppedToolResults + syntheticToolResults + trimmedAssistantBlocks;
  return {
    messages: repairedCount > 0 ? repaired : messages,
    stats: {
      droppedToolResults,
      syntheticToolResults,
      trimmedAssistantBlocks,
    },
    repairedCount,
  };
}

function collectToolCalls(
  message: AgentMessage,
): { ids: Map<string, number>; names: Map<string, string> } | null {
  const record = message as unknown as Record<string, unknown>;
  if (record.role !== "assistant" || !Array.isArray(record.content)) return null;

  const ids = new Map<string, number>();
  const names = new Map<string, string>();
  for (const part of record.content) {
    if (!part || typeof part !== "object") continue;
    const item = part as Record<string, unknown>;
    if (item.type !== "toolCall" || typeof item.id !== "string" || !item.id.trim()) {
      continue;
    }
    const id = item.id.trim();
    ids.set(id, (ids.get(id) ?? 0) + 1);
    if (typeof item.name === "string" && !names.has(id)) {
      names.set(id, item.name);
    }
  }
  return ids.size > 0 ? { ids, names } : null;
}

function trimAssistantContentAfterLastToolCall(
  message: AgentMessage,
): { message: AgentMessage; removedBlocks: number } {
  const record = message as unknown as Record<string, unknown>;
  if (record.role !== "assistant" || !Array.isArray(record.content)) {
    return { message, removedBlocks: 0 };
  }

  let lastToolCallIndex = -1;
  for (let index = record.content.length - 1; index >= 0; index--) {
    const part = record.content[index];
    if (part && typeof part === "object" && (part as Record<string, unknown>).type === "toolCall") {
      lastToolCallIndex = index;
      break;
    }
  }

  if (lastToolCallIndex < 0 || lastToolCallIndex === record.content.length - 1) {
    return { message, removedBlocks: 0 };
  }

  return {
    message: {
      ...record,
      content: record.content.slice(0, lastToolCallIndex + 1),
    } as unknown as AgentMessage,
    removedBlocks: record.content.length - lastToolCallIndex - 1,
  };
}
