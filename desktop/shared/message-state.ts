import type { ContentBlock, Message, ToolResultBlock } from '../../src/types';
import {
  applyStreamingEventToMessage,
  attachToolResultsToMessages,
  extractToolEventMetaInfo,
  finalizeStreamingMessage,
  type SDKEvent,
} from '../../src/lib/streaming';
import type { DesktopMessage, DesktopProvider } from './protocol';

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
        next.role === 'assistant' &&
        (
          (Array.isArray(current.content) && !Array.isArray(next.content)) ||
          (typeof current.content === 'string' &&
            typeof next.content === 'string' &&
            current.content.trim().length > 0 &&
            next.content.trim().length === 0 &&
            next.isStreaming)
        )
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

type CodexNotification = {
  method: string;
  params?: Record<string, unknown>;
};

type AgentOsNotification = {
  jsonrpc?: string;
  method?: string;
  params?: Record<string, unknown>;
  type?: string;
};

type AgentOsSessionUpdate = {
  sessionUpdate?: unknown;
  content?: unknown;
  toolCallId?: unknown;
  title?: unknown;
  rawInput?: unknown;
  rawOutput?: unknown;
  status?: unknown;
};

type CodexThreadItem = {
  id: string;
  type: string;
  [key: string]: unknown;
};

type CodexTodoStatus = 'pending' | 'in_progress' | 'completed';

type CodexTodoItem = {
  content: string;
  status: CodexTodoStatus;
  activeForm: string;
};

function isClaudeSdkEvent(event: unknown): event is SDKEvent {
  return Boolean(
    event &&
      typeof event === 'object' &&
      typeof (event as { type?: unknown }).type === 'string'
  );
}

function isCodexRuntimeEvent(event: unknown): event is CodexNotification {
  return Boolean(
    event &&
      typeof event === 'object' &&
      typeof (event as { method?: unknown }).method === 'string'
  );
}

function isAgentOsRuntimeEvent(event: unknown): event is AgentOsNotification {
  return Boolean(
    event &&
      typeof event === 'object' &&
      (
        typeof (event as { method?: unknown }).method === 'string' ||
        (event as { type?: unknown }).type === 'permission_request'
      )
  );
}

function isCodexThreadItem(item: unknown): item is CodexThreadItem {
  return Boolean(
    item &&
      typeof item === 'object' &&
      typeof (item as { id?: unknown }).id === 'string' &&
      typeof (item as { type?: unknown }).type === 'string'
  );
}

function normalizeAssistantContent(content: Message['content']): ContentBlock[] {
  if (Array.isArray(content)) {
    return [...content];
  }

  if (!content) {
    return [];
  }

  return [{ type: 'text', text: content }];
}

function getBlockItemId(block: ContentBlock): string | undefined {
  if ('itemId' in block && typeof block.itemId === 'string') {
    return block.itemId;
  }
  if (block.type === 'tool_use') {
    return block.id;
  }
  if (block.type === 'tool_result') {
    return block.tool_use_id;
  }
  return undefined;
}

function getReasoningContentItemId(itemId: string, contentIndex = 0): string {
  return `${itemId}:content:${contentIndex}`;
}

function getReasoningPrimaryItemId(itemId: string): string {
  return getReasoningContentItemId(itemId, 0);
}

function updateStreamingAssistantMessage(
  messages: Message[],
  threadId: string,
  streamingMessageIds: Record<string, string | null>,
  updater: (blocks: ContentBlock[]) => ContentBlock[],
  preferredId?: string
): Message[] {
  const ensured = ensureStreamingMessage(messages, threadId, streamingMessageIds, preferredId);
  return ensured.messages.map((message) => {
    if (message.id !== ensured.messageId) {
      return message;
    }
    return {
      ...message,
      content: updater(normalizeAssistantContent(message.content)),
      isStreaming: true,
    };
  });
}

function finalizeAssistantMessage(
  messages: Message[],
  threadId: string,
  streamingMessageIds: Record<string, string | null>
): Message[] {
  const currentStreamingId = resolveStreamingMessageId(messages, threadId, streamingMessageIds);
  streamingMessageIds[threadId] = null;
  if (!currentStreamingId) {
    return messages;
  }

  return messages.map((message) =>
    message.id === currentStreamingId ? { ...message, isStreaming: false } : message
  );
}

function findBlockIndex(
  blocks: ContentBlock[],
  predicate: (block: ContentBlock) => boolean
): number {
  return blocks.findIndex(predicate);
}

function upsertBlock(
  blocks: ContentBlock[],
  nextBlock: ContentBlock,
  predicate: (block: ContentBlock) => boolean,
  insertAfter?: (block: ContentBlock) => boolean
): ContentBlock[] {
  const nextBlocks = [...blocks];
  const existingIndex = findBlockIndex(nextBlocks, predicate);
  if (existingIndex >= 0) {
    nextBlocks[existingIndex] = nextBlock;
    return nextBlocks;
  }

  if (insertAfter) {
    const anchorIndex = findBlockIndex(nextBlocks, insertAfter);
    if (anchorIndex >= 0) {
      nextBlocks.splice(anchorIndex + 1, 0, nextBlock);
      return nextBlocks;
    }
  }

  nextBlocks.push(nextBlock);
  return nextBlocks;
}

function appendTextDeltaBlock(
  blocks: ContentBlock[],
  itemId: string,
  delta: string,
  itemKind: string
): ContentBlock[] {
  const existingIndex = findBlockIndex(
    blocks,
    (block) => block.type === 'text' && getBlockItemId(block) === itemId
  );
  if (existingIndex >= 0) {
    const nextBlocks = [...blocks];
    const existing = nextBlocks[existingIndex];
    if (existing.type === 'text') {
      nextBlocks[existingIndex] = {
        ...existing,
        text: `${existing.text}${delta}`,
        itemKind,
      };
    }
    return nextBlocks;
  }

  return [
    ...blocks,
    {
      type: 'text',
      text: delta,
      itemId,
      itemKind,
    },
  ];
}

function appendContiguousTextBlock(
  blocks: ContentBlock[],
  delta: string,
  itemKind: string,
  itemIdPrefix: string
): ContentBlock[] {
  const nextBlocks = [...blocks];
  const lastBlock = nextBlocks[nextBlocks.length - 1];
  if (lastBlock?.type === 'text') {
    nextBlocks[nextBlocks.length - 1] = {
      ...lastBlock,
      text: `${lastBlock.text}${delta}`,
      itemKind,
    };
    return nextBlocks;
  }

  const nextIndex = nextBlocks.filter((block) => block.type === 'text').length;
  nextBlocks.push({
    type: 'text',
    text: delta,
    itemId: `${itemIdPrefix}:${nextIndex}`,
    itemKind,
  });
  return nextBlocks;
}

function upsertTextBlock(
  blocks: ContentBlock[],
  itemId: string,
  text: string,
  itemKind: string
): ContentBlock[] {
  return upsertBlock(
    blocks,
    {
      type: 'text',
      text,
      itemId,
      itemKind,
    },
    (block) => block.type === 'text' && getBlockItemId(block) === itemId
  );
}

function appendThinkingDeltaBlock(
  blocks: ContentBlock[],
  itemId: string,
  delta: string,
  label: string,
  itemKind: string
): ContentBlock[] {
  const existingIndex = findBlockIndex(
    blocks,
    (block) => block.type === 'thinking' && getBlockItemId(block) === itemId
  );
  if (existingIndex >= 0) {
    const nextBlocks = [...blocks];
    const existing = nextBlocks[existingIndex];
    if (existing.type === 'thinking') {
      nextBlocks[existingIndex] = {
        ...existing,
        thinking: `${existing.thinking}${delta}`,
        label,
        itemKind,
        summaries: existing.summaries,
      };
    }
    return nextBlocks;
  }

  return [
    ...blocks,
    {
      type: 'thinking',
      thinking: delta,
      itemId,
      itemKind,
      label,
      summaries: [],
    },
  ];
}

function appendContiguousThinkingBlock(
  blocks: ContentBlock[],
  delta: string,
  label: string,
  itemKind: string,
  itemIdPrefix: string
): ContentBlock[] {
  const nextBlocks = [...blocks];
  const lastBlock = nextBlocks[nextBlocks.length - 1];
  if (lastBlock?.type === 'thinking') {
    nextBlocks[nextBlocks.length - 1] = {
      ...lastBlock,
      thinking: `${lastBlock.thinking}${delta}`,
      label,
      itemKind,
      summaries: lastBlock.summaries,
    };
    return nextBlocks;
  }

  const nextIndex = nextBlocks.filter((block) => block.type === 'thinking').length;
  nextBlocks.push({
    type: 'thinking',
    thinking: delta,
    itemId: `${itemIdPrefix}:${nextIndex}`,
    itemKind,
    label,
    summaries: [],
  });
  return nextBlocks;
}

function upsertThinkingBlock(
  blocks: ContentBlock[],
  itemId: string,
  thinking: string,
  label: string,
  itemKind: string
): ContentBlock[] {
  return upsertBlock(
    blocks,
    {
      type: 'thinking',
      thinking,
      itemId,
      itemKind,
      label,
      summaries:
        findBlockIndex(blocks, (block) => block.type === 'thinking' && getBlockItemId(block) === itemId) >= 0 &&
        blocks[findBlockIndex(blocks, (block) => block.type === 'thinking' && getBlockItemId(block) === itemId)]?.type === 'thinking'
          ? (blocks[findBlockIndex(blocks, (block) => block.type === 'thinking' && getBlockItemId(block) === itemId)] as Extract<ContentBlock, { type: 'thinking' }>).summaries ?? []
          : [],
    },
    (block) => block.type === 'thinking' && getBlockItemId(block) === itemId
  );
}

function appendReasoningSummaryDelta(
  blocks: ContentBlock[],
  itemId: string,
  summaryIndex: number,
  delta: string
): ContentBlock[] {
  const targetItemId = getReasoningPrimaryItemId(itemId);
  const nextBlocks = upsertThinkingBlock(
    blocks,
    targetItemId,
    '',
    'Reasoning',
    'reasoning'
  );
  const existingIndex = findBlockIndex(
    nextBlocks,
    (block) => block.type === 'thinking' && getBlockItemId(block) === targetItemId
  );
  if (existingIndex < 0) {
    return nextBlocks;
  }
  const existing = nextBlocks[existingIndex];
  if (existing.type !== 'thinking') {
    return nextBlocks;
  }
  const summaries = [...(existing.summaries ?? [])];
  summaries[summaryIndex] = `${summaries[summaryIndex] ?? ''}${delta}`;
  nextBlocks[existingIndex] = {
    ...existing,
    summaries,
  };
  return nextBlocks;
}

function ensureReasoningSummary(
  blocks: ContentBlock[],
  itemId: string,
  summaryIndex: number
): ContentBlock[] {
  const targetItemId = getReasoningPrimaryItemId(itemId);
  const nextBlocks = upsertThinkingBlock(
    blocks,
    targetItemId,
    '',
    'Reasoning',
    'reasoning'
  );
  const existingIndex = findBlockIndex(
    nextBlocks,
    (block) => block.type === 'thinking' && getBlockItemId(block) === targetItemId
  );
  if (existingIndex < 0) {
    return nextBlocks;
  }
  const existing = nextBlocks[existingIndex];
  if (existing.type !== 'thinking') {
    return nextBlocks;
  }
  const summaries = [...(existing.summaries ?? [])];
  summaries[summaryIndex] = summaries[summaryIndex] ?? '';
  nextBlocks[existingIndex] = {
    ...existing,
    summaries,
  };
  return nextBlocks;
}

function upsertReasoningSummaries(
  blocks: ContentBlock[],
  itemId: string,
  summaries: string[]
): ContentBlock[] {
  const targetItemId = getReasoningPrimaryItemId(itemId);
  const nextBlocks = upsertThinkingBlock(
    blocks,
    targetItemId,
    '',
    'Reasoning',
    'reasoning'
  );
  const existingIndex = findBlockIndex(
    nextBlocks,
    (block) => block.type === 'thinking' && getBlockItemId(block) === targetItemId
  );
  if (existingIndex < 0) {
    return nextBlocks;
  }
  const existing = nextBlocks[existingIndex];
  if (existing.type !== 'thinking') {
    return nextBlocks;
  }
  nextBlocks[existingIndex] = {
    ...existing,
    summaries,
  };
  return nextBlocks;
}

function upsertToolUseBlock(
  blocks: ContentBlock[],
  itemId: string,
  name: string,
  input: Record<string, unknown>,
  itemKind: string
): ContentBlock[] {
  return upsertBlock(
    blocks,
    {
      type: 'tool_use',
      id: itemId,
      name,
      input,
      itemKind,
    },
    (block) => block.type === 'tool_use' && block.id === itemId
  );
}

function getToolUseBlock(
  blocks: ContentBlock[],
  itemId: string
): Extract<ContentBlock, { type: 'tool_use' }> | null {
  const block = blocks.find(
    (candidate): candidate is Extract<ContentBlock, { type: 'tool_use' }> =>
      candidate.type === 'tool_use' && candidate.id === itemId
  );
  return block ?? null;
}

function upsertToolResultBlock(
  blocks: ContentBlock[],
  itemId: string,
  content: string | ContentBlock[],
  itemKind: string
): ContentBlock[] {
  return upsertBlock(
    blocks,
    {
      type: 'tool_result',
      tool_use_id: itemId,
      content,
      itemId,
      itemKind,
    },
    (block) => block.type === 'tool_result' && getBlockItemId(block) === itemId,
    (block) => block.type === 'tool_use' && block.id === itemId
  );
}

function appendToolResultText(
  blocks: ContentBlock[],
  itemId: string,
  delta: string,
  itemKind: string
): ContentBlock[] {
  const existingIndex = findBlockIndex(
    blocks,
    (block) => block.type === 'tool_result' && getBlockItemId(block) === itemId
  );
  if (existingIndex >= 0) {
    const nextBlocks = [...blocks];
    const existing = nextBlocks[existingIndex];
    if (existing.type === 'tool_result' && typeof existing.content === 'string') {
      nextBlocks[existingIndex] = {
        ...existing,
        content: `${existing.content}${delta}`,
        itemKind,
      };
      return nextBlocks;
    }
  }

  return upsertToolResultBlock(blocks, itemId, delta, itemKind);
}

function stringifyCodexValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function getAgentOsSessionUpdate(event: AgentOsNotification): AgentOsSessionUpdate | null {
  if (event.type === 'permission_request') {
    return null;
  }

  if (event.method !== 'session/update') {
    return null;
  }

  const params = event.params;
  if (!params || typeof params !== 'object') {
    return null;
  }

  const update = params.update;
  return update && typeof update === 'object'
    ? (update as AgentOsSessionUpdate)
    : null;
}

function extractAgentOsTextContent(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => extractAgentOsTextContent(entry)).filter(Boolean).join('');
  }

  if (!value || typeof value !== 'object') {
    return '';
  }

  const record = value as Record<string, unknown>;
  if (record.type === 'text' && typeof record.text === 'string') {
    return record.text;
  }
  if (record.type === 'content') {
    return extractAgentOsTextContent(record.content);
  }
  if (record.type === 'diff') {
    const path = typeof record.path === 'string' ? record.path : 'file';
    return `Updated ${path}`;
  }
  if ('content' in record) {
    return extractAgentOsTextContent(record.content);
  }
  return '';
}

function applyAgentOsRuntimeEvent(
  currentMessages: Message[],
  threadId: string,
  event: AgentOsNotification,
  streamingMessageIds: Record<string, string | null>
): Message[] {
  const update = getAgentOsSessionUpdate(event);
  if (!update) {
    return currentMessages;
  }

  const sessionUpdate = typeof update.sessionUpdate === 'string'
    ? update.sessionUpdate
    : null;

  if (sessionUpdate === 'agent_message_chunk') {
    const text = extractAgentOsTextContent(update.content);
    if (!text) return currentMessages;
    return updateStreamingAssistantMessage(
      currentMessages,
      threadId,
      streamingMessageIds,
      (blocks) => appendContiguousTextBlock(
        blocks,
        text,
        'agentos',
        'agentos:message'
      )
    );
  }

  if (sessionUpdate === 'agent_thought_chunk') {
    const text = extractAgentOsTextContent(update.content);
    if (!text) return currentMessages;
    return updateStreamingAssistantMessage(
      currentMessages,
      threadId,
      streamingMessageIds,
      (blocks) => appendContiguousThinkingBlock(
        blocks,
        text,
        'Thinking',
        'agentos',
        'agentos:thinking'
      )
    );
  }

  const toolCallId = typeof update.toolCallId === 'string' ? update.toolCallId : null;

  if (sessionUpdate === 'tool_call' && toolCallId) {
    const title = typeof update.title === 'string' && update.title.trim()
      ? update.title
      : 'tool';
    const rawInput =
      update.rawInput && typeof update.rawInput === 'object'
        ? (update.rawInput as Record<string, unknown>)
        : {};
    return updateStreamingAssistantMessage(
      currentMessages,
      threadId,
      streamingMessageIds,
      (blocks) => upsertToolUseBlock(blocks, toolCallId, title, rawInput, 'agentos')
    );
  }

  if (sessionUpdate === 'tool_call_update' && toolCallId) {
    const text = extractAgentOsTextContent(update.content) || extractAgentOsTextContent(update.rawOutput);
    const status = typeof update.status === 'string' ? update.status : '';
    const rawInput =
      update.rawInput && typeof update.rawInput === 'object'
        ? (update.rawInput as Record<string, unknown>)
        : null;
    const title = typeof update.title === 'string' && update.title.trim()
      ? update.title
      : null;
    return updateStreamingAssistantMessage(
      currentMessages,
      threadId,
      streamingMessageIds,
      (blocks) => {
        let nextBlocks = blocks;
        const existingToolUse = getToolUseBlock(nextBlocks, toolCallId);
        if (!existingToolUse) {
          nextBlocks = upsertToolUseBlock(
            nextBlocks,
            toolCallId,
            title ?? 'tool',
            rawInput ?? {},
            'agentos'
          );
        } else if (rawInput || title) {
          nextBlocks = upsertToolUseBlock(
            nextBlocks,
            toolCallId,
            title ?? existingToolUse.name,
            rawInput ?? existingToolUse.input,
            'agentos'
          );
        }
        if (text) {
          return appendToolResultText(nextBlocks, toolCallId, text, 'agentos');
        }
        if (status === 'failed') {
          return upsertToolResultBlock(nextBlocks, toolCallId, 'Tool failed.', 'agentos');
        }
        return nextBlocks;
      }
    );
  }

  return currentMessages;
}

function normalizeCodexTodoStatus(status: unknown): CodexTodoStatus {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'inProgress':
    case 'in_progress':
      return 'in_progress';
    default:
      return 'pending';
  }
}

function buildCodexTodos(plan: unknown): CodexTodoItem[] {
  if (!Array.isArray(plan)) {
    return [];
  }

  return plan.map((item) => {
    const content =
      item && typeof item === 'object' && typeof (item as { step?: unknown }).step === 'string'
        ? (item as { step: string }).step
        : 'Untitled task';
    return {
      content,
      status: normalizeCodexTodoStatus(
        item && typeof item === 'object' ? (item as { status?: unknown }).status : undefined
      ),
      activeForm: content,
    };
  });
}

function joinNonEmpty(parts: Array<string | null | undefined>, separator = '\n\n'): string {
  return parts.map((part) => part?.trim()).filter(Boolean).join(separator);
}

function formatReasoningText(item: CodexThreadItem): string {
  const content = Array.isArray(item.content)
    ? item.content.filter((value): value is string => typeof value === 'string').join('')
    : '';
  return content;
}

function formatReasoningSummaries(item: CodexThreadItem): string[] {
  if (!Array.isArray(item.summary)) {
    return [];
  }
  return item.summary.map((summary) => {
    if (typeof summary === 'string') {
      return summary;
    }
    if (
      summary &&
      typeof summary === 'object' &&
      typeof (summary as { text?: unknown }).text === 'string'
    ) {
      return (summary as { text: string }).text;
    }
    return stringifyCodexValue(summary);
  });
}

function formatCommandResult(item: CodexThreadItem): string {
  const output =
    typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput.trimEnd() : '';
  const metadata = [
    typeof item.exitCode === 'number' ? `exit code: ${item.exitCode}` : null,
    typeof item.durationMs === 'number' ? `duration: ${item.durationMs}ms` : null,
    typeof item.status === 'string' ? `status: ${item.status}` : null,
  ]
    .filter(Boolean)
    .join(', ');

  return joinNonEmpty([
    output,
    metadata ? `[${metadata}]` : '',
  ]);
}

function formatFileChangeResult(item: CodexThreadItem): string {
  const changes = Array.isArray(item.changes) ? item.changes : [];
  const renderedChanges = changes
    .map((change) => {
      if (!change || typeof change !== 'object') {
        return stringifyCodexValue(change);
      }
      const path =
        typeof (change as { path?: unknown }).path === 'string'
          ? (change as { path: string }).path
          : 'file';
      const kind =
        typeof (change as { kind?: unknown }).kind === 'string'
          ? (change as { kind: string }).kind
          : 'change';
      const diff =
        typeof (change as { diff?: unknown }).diff === 'string'
          ? (change as { diff: string }).diff
          : '';
      return joinNonEmpty([`${kind}: ${path}`, diff], '\n');
    })
    .filter(Boolean)
    .join('\n\n');

  return joinNonEmpty([
    typeof item.status === 'string' ? `status: ${item.status}` : '',
    renderedChanges,
  ]);
}

function formatMcpToolResult(item: CodexThreadItem): string {
  if (item.error != null) {
    return stringifyCodexValue(item.error);
  }
  if (item.result != null) {
    return stringifyCodexValue(item.result);
  }
  if (typeof item.status === 'string') {
    return `status: ${item.status}`;
  }
  return '';
}

function formatDynamicToolResult(item: CodexThreadItem): string {
  const parts: string[] = [];
  if (Array.isArray(item.contentItems)) {
    for (const contentItem of item.contentItems) {
      if (!contentItem || typeof contentItem !== 'object') {
        parts.push(stringifyCodexValue(contentItem));
        continue;
      }
      if (
        (contentItem as { type?: unknown }).type === 'inputText' &&
        typeof (contentItem as { text?: unknown }).text === 'string'
      ) {
        parts.push((contentItem as { text: string }).text);
        continue;
      }
      parts.push(stringifyCodexValue(contentItem));
    }
  }
  if (typeof item.success === 'boolean') {
    parts.push(`success: ${item.success}`);
  }
  if (typeof item.status === 'string') {
    parts.push(`status: ${item.status}`);
  }
  return parts.join('\n\n');
}

function formatCollabAgentResult(item: CodexThreadItem): string {
  return stringifyCodexValue({
    status: item.status,
    tool: item.tool,
    receiverThreadIds: item.receiverThreadIds,
    agentsStates: item.agentsStates,
  });
}

function formatWebSearchResult(item: CodexThreadItem): string {
  return joinNonEmpty([
    typeof item.query === 'string' ? item.query : '',
    item.action != null ? stringifyCodexValue(item.action) : '',
  ]);
}

function formatImageResult(item: CodexThreadItem): string {
  return joinNonEmpty([
    typeof item.savedPath === 'string' ? `saved to: ${item.savedPath}` : '',
    typeof item.result === 'string' ? item.result : '',
    typeof item.path === 'string' ? item.path : '',
    typeof item.revisedPrompt === 'string' ? `prompt: ${item.revisedPrompt}` : '',
  ]);
}

function buildToolUseFromCodexItem(item: CodexThreadItem): {
  name: string;
  input: Record<string, unknown>;
} | null {
  switch (item.type) {
    case 'commandExecution':
      return {
        name: 'Bash',
        input: {
          command: item.command,
          cwd: item.cwd,
          source: item.source,
          processId: item.processId,
          status: item.status,
          commandActions: item.commandActions,
        },
      };
    case 'fileChange':
      return {
        name: 'CodexFileChange',
        input: {
          status: item.status,
          changes: item.changes,
        },
      };
    case 'mcpToolCall':
      return {
        name: `mcp__${String(item.server ?? 'server')}__${String(item.tool ?? 'tool')}`,
        input: {
          arguments: item.arguments,
          status: item.status,
          durationMs: item.durationMs,
        },
      };
    case 'dynamicToolCall':
      return {
        name: typeof item.tool === 'string' ? item.tool : 'DynamicTool',
        input: {
          arguments: item.arguments,
          status: item.status,
          durationMs: item.durationMs,
        },
      };
    case 'collabAgentToolCall':
      return {
        name: 'Agent',
        input: {
          description: item.prompt,
          tool: item.tool,
          receiverThreadIds: item.receiverThreadIds,
          model: item.model,
          reasoningEffort: item.reasoningEffort,
          status: item.status,
        },
      };
    case 'webSearch':
      return {
        name: 'WebSearch',
        input: {
          query: item.query,
          action: item.action,
        },
      };
    case 'imageView':
      return {
        name: 'CodexImageView',
        input: {
          path: item.path,
        },
      };
    case 'imageGeneration':
      return {
        name: 'CodexImageGeneration',
        input: {
          status: item.status,
          revisedPrompt: item.revisedPrompt,
          savedPath: item.savedPath,
        },
      };
    case 'enteredReviewMode':
      return {
        name: 'CodexReviewMode',
        input: {
          action: 'enter',
          review: item.review,
        },
      };
    case 'exitedReviewMode':
      return {
        name: 'CodexReviewMode',
        input: {
          action: 'exit',
          review: item.review,
        },
      };
    case 'contextCompaction':
      return {
        name: 'CodexContextCompaction',
        input: {},
      };
    default:
      return {
        name: `Codex:${item.type}`,
        input: Object.fromEntries(
          Object.entries(item).filter(([key]) => key !== 'id' && key !== 'type')
        ),
      };
  }
}

function buildToolResultFromCodexItem(item: CodexThreadItem): string | null {
  switch (item.type) {
    case 'commandExecution':
      return formatCommandResult(item);
    case 'fileChange':
      return formatFileChangeResult(item);
    case 'mcpToolCall':
      return formatMcpToolResult(item);
    case 'dynamicToolCall':
      return formatDynamicToolResult(item);
    case 'collabAgentToolCall':
      return formatCollabAgentResult(item);
    case 'webSearch':
      return formatWebSearchResult(item);
    case 'imageView':
    case 'imageGeneration':
      return formatImageResult(item);
    case 'enteredReviewMode':
      return typeof item.review === 'string' ? item.review : 'Entered review mode.';
    case 'exitedReviewMode':
      return typeof item.review === 'string' ? item.review : 'Exited review mode.';
    case 'contextCompaction':
      return 'Context compacted.';
    default:
      return stringifyCodexValue(
        Object.fromEntries(
          Object.entries(item).filter(([key]) => key !== 'id' && key !== 'type')
        )
      );
  }
}

function applyCodexItemStarted(
  blocks: ContentBlock[],
  item: CodexThreadItem
): ContentBlock[] {
  switch (item.type) {
    case 'userMessage':
    case 'hookPrompt':
      return blocks;
    case 'agentMessage':
      return upsertTextBlock(blocks, item.id, typeof item.text === 'string' ? item.text : '', item.type);
    case 'plan':
      return upsertThinkingBlock(blocks, item.id, typeof item.text === 'string' ? item.text : '', 'Plan', item.type);
    case 'reasoning':
      return upsertThinkingBlock(
        blocks,
        getReasoningContentItemId(item.id),
        formatReasoningText(item),
        'Reasoning',
        item.type
      );
    default: {
      const tool = buildToolUseFromCodexItem(item);
      if (!tool) {
        return blocks;
      }
      return upsertToolUseBlock(blocks, item.id, tool.name, tool.input, item.type);
    }
  }
}

function applyCodexItemCompleted(
  blocks: ContentBlock[],
  item: CodexThreadItem
): ContentBlock[] {
  switch (item.type) {
    case 'userMessage':
    case 'hookPrompt':
      return blocks;
    case 'agentMessage':
      return upsertTextBlock(blocks, item.id, typeof item.text === 'string' ? item.text : '', item.type);
    case 'plan':
      return upsertThinkingBlock(blocks, item.id, typeof item.text === 'string' ? item.text : '', 'Plan', item.type);
    case 'reasoning':
      return upsertReasoningSummaries(
        upsertThinkingBlock(
          blocks,
          getReasoningPrimaryItemId(item.id),
          formatReasoningText(item),
          'Reasoning',
          item.type
        ),
        item.id,
        formatReasoningSummaries(item)
      );
    default: {
      let nextBlocks = blocks;
      const tool = buildToolUseFromCodexItem(item);
      if (tool) {
        nextBlocks = upsertToolUseBlock(nextBlocks, item.id, tool.name, tool.input, item.type);
      }
      const result = buildToolResultFromCodexItem(item);
      if (result) {
        nextBlocks = upsertToolResultBlock(nextBlocks, item.id, result, item.type);
      }
      return nextBlocks;
    }
  }
}

function applyCodexRuntimeEvent(
  currentMessages: Message[],
  threadId: string,
  event: CodexNotification,
  streamingMessageIds: Record<string, string | null>
): Message[] {
  const params = event.params ?? {};
  const itemId = typeof params.itemId === 'string' ? params.itemId : undefined;

  if (event.method === 'turn/completed') {
    return finalizeAssistantMessage(currentMessages, threadId, streamingMessageIds);
  }

  if (event.method === 'turn/plan/updated') {
    const todos = buildCodexTodos(params.plan);
    return updateStreamingAssistantMessage(
      currentMessages,
      threadId,
      streamingMessageIds,
      (blocks) =>
        upsertToolUseBlock(
          blocks,
          'turn:plan:todo',
          'TodoWrite',
          {
            explanation:
              typeof params.explanation === 'string' ? params.explanation : undefined,
            todos,
          },
          'turnPlan'
        ),
    );
  }

  if (event.method === 'item/started' && isCodexThreadItem(params.item)) {
    const item = params.item;
    return updateStreamingAssistantMessage(
      currentMessages,
      threadId,
      streamingMessageIds,
      (blocks) => applyCodexItemStarted(blocks, item),
    );
  }

  if (event.method === 'item/completed' && isCodexThreadItem(params.item)) {
    const item = params.item;
    return updateStreamingAssistantMessage(
      currentMessages,
      threadId,
      streamingMessageIds,
      (blocks) => applyCodexItemCompleted(blocks, item),
    );
  }

  if (event.method === 'item/agentMessage/delta' && itemId && typeof params.delta === 'string') {
    return updateStreamingAssistantMessage(
      currentMessages,
      threadId,
      streamingMessageIds,
      (blocks) => appendTextDeltaBlock(blocks, itemId, params.delta as string, 'agentMessage'),
    );
  }

  if (event.method === 'item/plan/delta' && itemId && typeof params.delta === 'string') {
    return updateStreamingAssistantMessage(
      currentMessages,
      threadId,
      streamingMessageIds,
      (blocks) => appendThinkingDeltaBlock(blocks, itemId, params.delta as string, 'Plan', 'plan'),
    );
  }

  if (
    event.method === 'item/reasoning/textDelta' &&
    itemId &&
    typeof params.delta === 'string'
  ) {
    const contentIndex =
      typeof params.contentIndex === 'number' ? params.contentIndex : 0;
    return updateStreamingAssistantMessage(
      currentMessages,
      threadId,
      streamingMessageIds,
      (blocks) =>
        appendThinkingDeltaBlock(
          blocks,
          getReasoningContentItemId(itemId, contentIndex),
          params.delta as string,
          'Reasoning',
          'reasoning'
        ),
    );
  }

  if (
    event.method === 'item/reasoning/summaryTextDelta' &&
    itemId &&
    typeof params.delta === 'string'
  ) {
    const summaryIndex =
      typeof params.summaryIndex === 'number' ? params.summaryIndex : 0;
    return updateStreamingAssistantMessage(
      currentMessages,
      threadId,
      streamingMessageIds,
      (blocks) =>
        appendReasoningSummaryDelta(
          blocks,
          itemId,
          summaryIndex,
          params.delta as string
        ),
    );
  }

  if (event.method === 'item/reasoning/summaryPartAdded' && itemId) {
    const summaryIndex =
      typeof params.summaryIndex === 'number' ? params.summaryIndex : 0;
    return updateStreamingAssistantMessage(
      currentMessages,
      threadId,
      streamingMessageIds,
      (blocks) => ensureReasoningSummary(blocks, itemId, summaryIndex),
    );
  }

  if (
    event.method === 'command/exec/outputDelta' &&
    itemId &&
    typeof params.delta === 'string'
  ) {
    return updateStreamingAssistantMessage(
      currentMessages,
      threadId,
      streamingMessageIds,
      (blocks) => appendToolResultText(blocks, itemId, params.delta as string, 'commandExecution'),
    );
  }

  if (
    event.method === 'item/commandExecution/outputDelta' &&
    itemId &&
    typeof params.delta === 'string'
  ) {
    return updateStreamingAssistantMessage(
      currentMessages,
      threadId,
      streamingMessageIds,
      (blocks) => appendToolResultText(blocks, itemId, params.delta as string, 'commandExecution'),
    );
  }

  if (
    event.method === 'item/commandExecution/terminalInteraction' &&
    itemId &&
    typeof params.input === 'string'
  ) {
    return updateStreamingAssistantMessage(
      currentMessages,
      threadId,
      streamingMessageIds,
      (blocks) =>
        appendToolResultText(
          blocks,
          itemId,
          `\n> ${params.input as string}\n`,
          'commandExecution'
        ),
    );
  }

  if (
    event.method === 'item/fileChange/outputDelta' &&
    itemId &&
    typeof params.delta === 'string'
  ) {
    return updateStreamingAssistantMessage(
      currentMessages,
      threadId,
      streamingMessageIds,
      (blocks) => appendToolResultText(blocks, itemId, params.delta as string, 'fileChange'),
    );
  }

  if (
    event.method === 'item/mcpToolCall/progress' &&
    itemId &&
    typeof params.message === 'string'
  ) {
    return updateStreamingAssistantMessage(
      currentMessages,
      threadId,
      streamingMessageIds,
      (blocks) => appendToolResultText(blocks, itemId, params.message as string, 'mcpToolCall'),
    );
  }

  return currentMessages;
}

export function applyRuntimeEventToMessages(
  currentMessages: Message[],
  threadId: string,
  provider: DesktopProvider,
  event: unknown,
  streamingMessageIds: Record<string, string | null>
): Message[] {
  if (provider === 'claude' && isClaudeSdkEvent(event)) {
    return applySdkEventToMessages(
      currentMessages,
      threadId,
      event,
      streamingMessageIds,
    );
  }

  if (provider === 'codex' && isCodexRuntimeEvent(event)) {
    return applyCodexRuntimeEvent(
      currentMessages,
      threadId,
      event,
      streamingMessageIds,
    );
  }

  if (provider === 'agentos' && isAgentOsRuntimeEvent(event)) {
    return applyAgentOsRuntimeEvent(
      currentMessages,
      threadId,
      event,
      streamingMessageIds,
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
