import type { ContentBlock, Message, ToolResultBlock } from '../../src/types';
import {
  applyStreamingEventToMessage,
  attachToolResultsToMessages,
  extractToolEventMetaInfo,
  finalizeStreamingMessage,
  type SDKEvent,
} from '../../src/lib/streaming';
import type { DesktopMessage } from './protocol';

function toUiRole(role: DesktopMessage['role']): Message['role'] {
  return role === 'assistant' ? 'assistant' : 'user';
}

export function desktopMessageToUiMessage(message: DesktopMessage): Message {
  return {
    id: message.id,
    thread_id: message.threadId,
    role: toUiRole(message.role),
    content: message.content,
    created_at: message.createdAt,
    isStreaming: message.status === 'streaming',
    isMeta: message.isMeta,
    sourceToolUseID: message.sourceToolUseID,
  };
}

export function uiMessageToDesktopMessage(message: Message, previous?: DesktopMessage): DesktopMessage {
  return {
    id: message.id,
    threadId: message.thread_id,
    role: message.role,
    content: message.content,
    createdAt: message.created_at,
    status: previous?.status === 'error'
      ? 'error'
      : message.isStreaming
        ? 'streaming'
        : 'done',
    isMeta: message.isMeta,
    sourceToolUseID: message.sourceToolUseID,
  };
}

export function uiMessagesToDesktopMessages(
  messages: Message[],
  previousMessages: DesktopMessage[] = []
): DesktopMessage[] {
  const previousById = new Map(previousMessages.map((message) => [message.id, message]));
  return messages.map((message) => uiMessageToDesktopMessage(message, previousById.get(message.id)));
}

function getLastToolUseId(message?: Message): string | undefined {
  if (!message || !Array.isArray(message.content)) return undefined;
  for (let i = message.content.length - 1; i >= 0; i -= 1) {
    const block = message.content[i];
    if (block?.type === 'tool_use' && block.id) {
      return block.id;
    }
  }
  return undefined;
}

function getLastToolUseIdFromMessages(messages: Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const id = getLastToolUseId(messages[i]);
    if (id) return id;
  }
  return undefined;
}

function getAssistantStreamingId(messages: Message[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role === 'assistant' && message.isStreaming) {
      return message.id;
    }
  }
  return null;
}

function resolveStreamingMessageId(
  messages: Message[],
  threadId: string,
  streamingMessageIds: Record<string, string | null>
): string | null {
  const currentId = streamingMessageIds[threadId];
  if (currentId && messages.some((message) => message.id === currentId)) {
    return currentId;
  }

  const fallbackId = getAssistantStreamingId(messages);
  streamingMessageIds[threadId] = fallbackId;
  return fallbackId;
}

function ensureStreamingMessage(
  messages: Message[],
  threadId: string,
  streamingMessageIds: Record<string, string | null>,
  preferredId?: string
): { messageId: string; messages: Message[] } {
  const existingId = resolveStreamingMessageId(messages, threadId, streamingMessageIds);
  if (existingId) {
    return { messageId: existingId, messages };
  }

  const nextMessageId = preferredId || `stream_${Date.now()}`;
  const nextMessage: Message = {
    id: nextMessageId,
    thread_id: threadId,
    role: 'assistant',
    content: [],
    created_at: Date.now(),
    isStreaming: true,
  };
  const nextMessages = [...messages, nextMessage];
  streamingMessageIds[threadId] = nextMessageId;
  return { messageId: nextMessageId, messages: nextMessages };
}

export function mergeSnapshotMessages(
  existingMessages: Message[] | undefined,
  snapshotMessages: DesktopMessage[],
  threadId: string,
  streamingMessageIds: Record<string, string | null>
): Message[] {
  const existing = existingMessages ?? [];
  const existingById = new Map(existing.map((message) => [message.id, message]));
  const snapshotIds = new Set(snapshotMessages.map((message) => message.id));

  const merged = snapshotMessages.map((message) => {
    const current = existingById.get(message.id);
    const next = desktopMessageToUiMessage(message);
    if (!current) {
      return next;
    }
    return {
      ...current,
      ...next,
      content:
        current.role === 'assistant' &&
        Array.isArray(current.content) &&
        next.role === 'assistant' &&
        !Array.isArray(next.content)
          ? current.content
          : next.content,
    };
  });

  const extras = existing.filter((message) => !snapshotIds.has(message.id));
  const nextMessages = [...merged, ...extras].sort((left, right) => left.created_at - right.created_at);
  streamingMessageIds[threadId] = getAssistantStreamingId(nextMessages);
  return nextMessages;
}

export function applySdkEventToMessages(
  currentMessages: Message[],
  threadId: string,
  sdkEvent: SDKEvent,
  streamingMessageIds: Record<string, string | null>
): Message[] {
  if (sdkEvent.type === 'system' && sdkEvent.subtype === 'init') {
    streamingMessageIds[threadId] = getAssistantStreamingId(currentMessages);
    return currentMessages;
  }

  if (sdkEvent.type === 'stream_event') {
    const streamEvent = sdkEvent.event;
    if (streamEvent?.type === 'message_start') {
      const preferredId = streamEvent.message?.id;
      const ensured = ensureStreamingMessage(currentMessages, threadId, streamingMessageIds, preferredId);
      return ensured.messages.map((message) =>
        message.id === ensured.messageId ? applyStreamingEventToMessage(message, sdkEvent) : message
      );
    }

    const currentStreamingId = resolveStreamingMessageId(currentMessages, threadId, streamingMessageIds);
    if (!currentStreamingId) {
      return currentMessages;
    }

    return currentMessages.map((message) =>
      message.id === currentStreamingId ? applyStreamingEventToMessage(message, sdkEvent) : message
    );
  }

  if (sdkEvent.type === 'assistant' && Array.isArray(sdkEvent.message?.content)) {
    const currentStreamingId = resolveStreamingMessageId(currentMessages, threadId, streamingMessageIds);
    if (currentStreamingId) {
      return currentMessages;
    }

    const fallbackId = (sdkEvent as { uuid?: string }).uuid;
    const ensured = ensureStreamingMessage(currentMessages, threadId, streamingMessageIds, fallbackId);
    return ensured.messages;
  }

  if (sdkEvent.type === 'user' && Array.isArray(sdkEvent.message?.content)) {
    const contentBlocks = sdkEvent.message.content;
    const isToolResultEvent =
      contentBlocks.length > 0 &&
      contentBlocks.every((block): block is ToolResultBlock => block?.type === 'tool_result');
    const { sourceToolUseID } = extractToolEventMetaInfo(sdkEvent);

    if (!isToolResultEvent) {
      const currentStreamingId = resolveStreamingMessageId(currentMessages, threadId, streamingMessageIds);
      const streamingMessage = currentStreamingId
        ? currentMessages.find((message) => message.id === currentStreamingId)
        : undefined;
      const fallbackToolUseId = !sourceToolUseID
        ? getLastToolUseId(streamingMessage) || getLastToolUseIdFromMessages(currentMessages)
        : undefined;

      return [
        ...currentMessages,
        {
          id: `meta_${sourceToolUseID ?? fallbackToolUseId ?? Date.now()}_${Date.now()}`,
          thread_id: threadId,
          role: 'user',
          content: contentBlocks,
          created_at: Date.now(),
          isMeta: true,
          sourceToolUseID: sourceToolUseID ?? fallbackToolUseId,
        },
      ];
    }

    const toolUseResult = sdkEvent.toolUseResult ?? sdkEvent.tool_use_result;
    const parentToolPrompt = typeof toolUseResult?.prompt === 'string' ? toolUseResult.prompt : undefined;
    return attachToolResultsToMessages(currentMessages, contentBlocks, {
      threadId,
      parentToolUseId: sourceToolUseID,
      parentToolPrompt,
    });
  }

  if (sdkEvent.type === 'result') {
    const currentStreamingId = resolveStreamingMessageId(currentMessages, threadId, streamingMessageIds);
    streamingMessageIds[threadId] = null;
    if (!currentStreamingId) {
      return currentMessages;
    }

    return currentMessages.map((message) =>
      message.id === currentStreamingId ? finalizeStreamingMessage(message) : message
    );
  }

  return currentMessages;
}

export function extractTextContent(content: string | ContentBlock[]): string {
  if (typeof content === 'string') {
    return content;
  }

  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'text') {
      parts.push(block.text);
      continue;
    }
    if (block.type === 'thinking') {
      parts.push(block.thinking);
      continue;
    }
    if (block.type === 'tool_use') {
      parts.push(`[Tool: ${block.name}]`);
      continue;
    }
    if (block.type === 'tool_result') {
      parts.push(extractTextContent(block.content));
      continue;
    }
    if (block.type === 'teammate_message') {
      parts.push(block.content);
      continue;
    }
    if (block.type === 'task_notification') {
      parts.push(block.summary);
      continue;
    }
    if (block.type === 'redacted_thinking') {
      parts.push('[Thinking redacted]');
    }
  }

  return parts.join('\n').trim();
}
