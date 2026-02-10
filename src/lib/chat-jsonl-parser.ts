import type { Message } from '@/types';

function parseEventTimestamp(timestamp: unknown): number | null {
  if (typeof timestamp !== 'string') return null;
  const parsed = new Date(timestamp).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function toCreatedAt(timestamp: unknown): number {
  return parseEventTimestamp(timestamp) ?? Date.now();
}

function hasTextBlocks(content: unknown): boolean {
  return Array.isArray(content) && content.some(block => block?.type === 'text' && block.text);
}

function mergeContentBlocks(existing: unknown, incoming: unknown): unknown {
  if (!Array.isArray(existing) || !Array.isArray(incoming)) return incoming;

  const incomingHasText = hasTextBlocks(incoming);
  if (!incomingHasText) {
    const merged = [...existing];
    const existingKeys = new Map<string, number>();
    existing.forEach((block, index) => {
      const key = block?.type === 'tool_use'
        ? `tool_use:${block.id || block.name || index}`
        : `${block?.type}:${index}`;
      existingKeys.set(key, index);
    });
    incoming.forEach((block, index) => {
      const key = block?.type === 'tool_use'
        ? `tool_use:${block.id || block.name || index}`
        : `${block?.type}:${index}`;
      const existingIndex = existingKeys.get(key);
      if (existingIndex === undefined) {
        merged.push(block);
      } else {
        merged[existingIndex] = block;
      }
    });
    return merged;
  }

  const toolResults = existing.filter(block => block?.type === 'tool_result');
  if (toolResults.length === 0) return incoming;
  return [...toolResults, ...incoming];
}

export function parseClaudeJsonlMessages(fileContent: string, threadId: string): Message[] {
  const lines = fileContent.split('\n').filter((line: string) => line.trim());
  const messages: Message[] = [];

  // Assistant segment grouping - groups consecutive assistant messages into one.
  // `assistantGroupCreatedAt` always tracks the LATEST timestamp seen across all
  // events in the group (assistant events, tool results, result) so the final
  // message `created_at` reflects when the assistant *finished*, not when it started.
  let assistantSegments: Array<{ id: string; content: Message['content']; createdAt: number }> = [];
  let assistantGroupId: string | null = null;
  let assistantGroupCreatedAt: number | null = null;

  const flushAssistantGroup = () => {
    if (assistantSegments.length === 0) return;
    const content = assistantSegments.flatMap(segment =>
      Array.isArray(segment.content) ? segment.content : []
    );
    const id = assistantGroupId ?? assistantSegments[0]?.id ?? `assistant_${messages.length}`;
    const createdAt = assistantGroupCreatedAt ?? assistantSegments[0]?.createdAt ?? Date.now();
    messages.push({
      id,
      thread_id: threadId,
      role: 'assistant',
      content,
      created_at: createdAt,
    });
    assistantSegments = [];
    assistantGroupId = null;
    assistantGroupCreatedAt = null;
  };

  const upsertAssistantSegment = (id: string, content: Message['content'], createdAt: number) => {
    if (!assistantGroupId) {
      assistantGroupId = id;
    }
    // Always keep the latest timestamp
    if (assistantGroupCreatedAt === null || createdAt > assistantGroupCreatedAt) {
      assistantGroupCreatedAt = createdAt;
    }
    const lastSegment = assistantSegments[assistantSegments.length - 1];
    if (lastSegment && lastSegment.id === id) {
      lastSegment.content = mergeContentBlocks(lastSegment.content, content) as Message['content'];
      return;
    }
    assistantSegments.push({ id, content, createdAt });
  };

  const appendToolResult = (content: Message['content'], createdAt: number) => {
    if (assistantSegments.length === 0) {
      const id = `tool_result_${messages.length}`;
      upsertAssistantSegment(id, content, createdAt);
      return;
    }
    const lastSegment = assistantSegments[assistantSegments.length - 1];
    const existingBlocks = Array.isArray(lastSegment.content) ? lastSegment.content : [];
    const incomingBlocks = Array.isArray(content) ? content : [];
    lastSegment.content = [...existingBlocks, ...incomingBlocks];
    if (assistantGroupCreatedAt === null || createdAt > assistantGroupCreatedAt) {
      assistantGroupCreatedAt = createdAt;
    }
  };

  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (!event || typeof event !== 'object') continue;

      // Skip compact_boundary system events (transient; the summary replaces them)
      if (event.type === 'system' && event.subtype === 'compact_boundary') {
        continue;
      }

      // Handle user messages
      if (event.type === 'user' && event.message?.content) {
        // Extract meta info for Skill tool prompts and other injected content
        const isMeta = Boolean(
          event.isMeta ??
          event.is_meta ??
          event.message?.isMeta ??
          event.message?.is_meta
        );
        const sourceToolUseID = (
          event.sourceToolUseID ??
          event.sourceToolUseId ??
          event.source_tool_use_id ??
          event.parent_tool_use_id ??
          event.message?.sourceToolUseID ??
          event.message?.sourceToolUseId ??
          event.message?.source_tool_use_id ??
          event.message?.parent_tool_use_id
        );
        const resolvedToolUseId = typeof sourceToolUseID === 'string' ? sourceToolUseID : undefined;

        // Check if this is a tool_result message
        const firstContent = Array.isArray(event.message.content) ? event.message.content[0] : null;
        const isToolResult = firstContent?.type === 'tool_result';

        // Detect compact summary messages (system-generated context recap)
        const isCompactSummary = Boolean(event.isCompactSummary);
        const createdAt = toCreatedAt(event.timestamp);

        if (isToolResult) {
          // Tool results get appended to the current assistant segment
          appendToolResult(event.message.content, createdAt);
        } else if (isCompactSummary) {
          // Compact summaries are system-generated context recaps, not real user messages.
          flushAssistantGroup();
          const id = event.uuid || `compact_${messages.length}`;
          messages.push({
            id,
            thread_id: threadId,
            role: 'user',
            content: event.message.content,
            created_at: createdAt,
            isCompactSummary: true,
          });
        } else if (isMeta || resolvedToolUseId) {
          // Meta messages (like Skill prompts) are hidden but stored for skill sheet display
          const id = event.uuid || `meta_${resolvedToolUseId || messages.length}`;
          messages.push({
            id,
            thread_id: threadId,
            role: 'user',
            content: event.message.content,
            created_at: createdAt,
            isMeta: true,
            sourceToolUseID: resolvedToolUseId,
          });
        } else {
          // Regular user message - flush any pending assistant segments first
          flushAssistantGroup();
          const id = event.uuid || `user_${messages.length}`;
          messages.push({
            id,
            thread_id: threadId,
            role: 'user',
            content: event.message.content,
            created_at: createdAt,
          });
        }
        continue;
      }

      // Handle assistant messages - accumulate into segments
      if (event.type === 'assistant' && event.message?.content?.length > 0) {
        const id = event.message?.id || event.uuid || `assistant_${messages.length}`;
        const createdAt = toCreatedAt(event.timestamp);
        upsertAssistantSegment(id, event.message.content, createdAt);
      }

      // Result event marks the end of the assistant turn — use its timestamp
      if (event.type === 'result' && assistantSegments.length > 0) {
        const ts = parseEventTimestamp(event.timestamp);
        if (ts !== null && (assistantGroupCreatedAt === null || ts > assistantGroupCreatedAt)) {
          assistantGroupCreatedAt = ts;
        }
      }
    } catch {
      // Skip malformed lines
      continue;
    }
  }

  // Flush any remaining assistant segments
  flushAssistantGroup();
  return messages;
}
