import type { ContentBlock, Message } from '../types';
import { finalizeStreamingMessage } from './streaming';

type RuntimeMessage = {
  id: string;
  threadId: string;
  role: 'user' | 'assistant' | 'system';
  content: string | ContentBlock[];
  createdAt: number;
  status: 'done' | 'streaming' | 'error';
  isMeta?: boolean;
  sourceToolUseID?: string;
  sentDuringStreaming?: boolean;
};

/**
 * Overlay the server's wholesale current-turn snapshot onto a base list.
 *
 * The server builds the active turn's messages whole and the browser replaces
 * (not accumulates) its overlay on every Agent-state update, so a streaming
 * message that gets re-id'd at turn/completed simply replaces its earlier entry
 * here instead of duplicating it. Matching keys on id/clientMessageId; the
 * overlay entry wins.
 *
 * New overlay entries (the live assistant turn) are inserted *above* any
 * optimistic steering echoes — the trailing run of `sentDuringStreaming` user
 * messages the browser appended while the turn was streaming. Those echoes were
 * sent to steer the in-flight assistant, so they must render below it, not
 * above. The overlay never carries user messages, so this only repositions the
 * assistant turn relative to the client-side echoes; it also keeps the turn-end
 * fold consistent (the finalized assistant lands above the echoes too).
 */
export function mergeOverlay(base: Message[], overlay: Message[]): Message[] {
  if (overlay.length === 0) return base;
  const next = [...base];
  const additions: Message[] = [];
  for (const message of overlay) {
    const index = next.findIndex(
      (existing) =>
        existing.id === message.id ||
        (message.clientMessageId &&
          existing.clientMessageId === message.clientMessageId)
    );
    if (index === -1) {
      additions.push(message);
    } else {
      next[index] = { ...next[index], ...message };
    }
  }
  if (additions.length === 0) return next;

  let insertAt = next.length;
  while (insertAt > 0 && next[insertAt - 1].sentDuringStreaming === true) {
    insertAt -= 1;
  }
  next.splice(insertAt, 0, ...additions);
  return next;
}

function toUiRole(role: RuntimeMessage['role']): Message['role'] {
  return role === 'assistant' ? 'assistant' : 'user';
}

export function runtimeMessageToUiMessage(message: RuntimeMessage): Message {
  return {
    id: message.id,
    thread_id: message.threadId,
    role: toUiRole(message.role),
    content: message.content,
    created_at: message.createdAt,
    isStreaming: message.status === 'streaming',
    isMeta: message.isMeta,
    sourceToolUseID: message.sourceToolUseID,
    sentDuringStreaming: message.sentDuringStreaming,
  };
}

export function uiMessageToRuntimeMessage(message: Message, previous?: RuntimeMessage): RuntimeMessage {
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
    sentDuringStreaming: message.sentDuringStreaming,
  };
}

export function uiMessagesToRuntimeMessages(
  messages: Message[],
  previousMessages: RuntimeMessage[] = []
): RuntimeMessage[] {
  const previousById = new Map(previousMessages.map((message) => [message.id, message]));
  return messages.map((message) => uiMessageToRuntimeMessage(message, previousById.get(message.id)));
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
  snapshotMessages: RuntimeMessage[],
  threadId: string,
  streamingMessageIds: Record<string, string | null>
): Message[] {
  const existing = existingMessages ?? [];
  const existingById = new Map(existing.map((message) => [message.id, message]));
  const snapshotIds = new Set(snapshotMessages.map((message) => message.id));

  const merged = snapshotMessages.map((message) => {
    const current = existingById.get(message.id);
    const next = runtimeMessageToUiMessage(message);
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

type PiNotification = {
  method: string;
  params?: Record<string, unknown>;
};

type PiThreadItem = {
  id: string;
  type: string;
  [key: string]: unknown;
};

type RuntimeToolResult = {
  content: string | ContentBlock[];
  isError: boolean;
};

type PiTodoStatus = 'pending' | 'in_progress' | 'completed';

type PiTodoItem = {
  content: string;
  status: PiTodoStatus;
  activeForm: string;
};

function isPiRuntimeEvent(event: unknown): event is PiNotification {
  return Boolean(
    event &&
      typeof event === 'object' &&
      typeof (event as { method?: unknown }).method === 'string'
  );
}

function isPiThreadItem(item: unknown): item is PiThreadItem {
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
  streamingMessageIds: Record<string, string | null>,
  forkEntryId?: string
): Message[] {
  const currentStreamingId = resolveStreamingMessageId(messages, threadId, streamingMessageIds);
  streamingMessageIds[threadId] = null;
  if (!currentStreamingId) {
    return messages;
  }

  return messages.map((message) =>
    message.id === currentStreamingId
      ? {
          ...message,
          id: forkEntryId || message.id,
          forkEntryId: forkEntryId || message.forkEntryId,
          isStreaming: false,
        }
      : message
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
  let existingIndex = -1;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block.type === 'text' && getBlockItemId(block) === itemId) {
      existingIndex = index;
      break;
    }
  }
  if (existingIndex >= 0) {
    const nextBlocks = [...blocks];
    const existing = nextBlocks[existingIndex];
    const hasLaterBlocks = existingIndex < nextBlocks.length - 1;
    if (existing.type === 'text' && !hasLaterBlocks) {
      nextBlocks[existingIndex] = {
        ...existing,
        text: `${existing.text}${delta}`,
        itemKind,
      };
      return nextBlocks;
    }
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

  const thinkingBlock: ContentBlock = {
    type: 'thinking',
    thinking: delta,
    itemId,
    itemKind,
    label,
    summaries: [],
  };
  return [...blocks, thinkingBlock];
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
  const existingIndex = findBlockIndex(
    blocks,
    (block) => block.type === 'thinking' && getBlockItemId(block) === itemId
  );
  const existing = existingIndex >= 0 ? blocks[existingIndex] : undefined;
  const nextBlock: ContentBlock = {
    type: 'thinking',
    thinking,
    itemId,
    itemKind,
    label,
    summaries:
      existing?.type === 'thinking'
        ? existing.summaries ?? []
        : [],
  };

  if (existingIndex >= 0) {
    const nextBlocks = [...blocks];
    nextBlocks[existingIndex] = nextBlock;
    return nextBlocks;
  }

  return [...blocks, nextBlock];
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
    'Thinking',
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
    'Thinking',
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
    'Thinking',
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
  const existing = getToolUseBlock(blocks, itemId);
  const mergedInput = existing ? { ...existing.input, ...input } : input;
  return upsertBlock(
    blocks,
    {
      type: 'tool_use',
      id: itemId,
      name,
      input: mergedInput,
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
  itemKind: string,
  options: { isError?: boolean } = {}
): ContentBlock[] {
  return upsertBlock(
    blocks,
    {
      type: 'tool_result',
      tool_use_id: itemId,
      content,
      ...(options.isError === true
        ? { is_error: true, status: 'failed' as const }
        : { status: 'succeeded' as const }),
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
  itemKind: string,
  options: { isError?: boolean } = {}
): ContentBlock[] {
  const existingIndex = findBlockIndex(
    blocks,
    (block) => block.type === 'tool_result' && getBlockItemId(block) === itemId
  );
  if (existingIndex >= 0) {
    const nextBlocks = [...blocks];
    const existing = nextBlocks[existingIndex];
    if (existing.type === 'tool_result' && typeof existing.content === 'string') {
      const isError =
        options.isError === true ||
        existing.is_error === true ||
        existing.status === 'failed';
      nextBlocks[existingIndex] = {
        ...existing,
        content: `${existing.content}${delta}`,
        ...(isError
          ? { is_error: true, status: 'failed' as const }
          : { status: 'succeeded' as const }),
        itemKind,
      };
      return nextBlocks;
    }
  }

  return upsertToolResultBlock(blocks, itemId, delta, itemKind, options);
}

function stringifyPiValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function normalizePiTodoStatus(status: unknown): PiTodoStatus {
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

function buildPiTodos(plan: unknown): PiTodoItem[] {
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
      status: normalizePiTodoStatus(
        item && typeof item === 'object' ? (item as { status?: unknown }).status : undefined
      ),
      activeForm: content,
    };
  });
}

function joinNonEmpty(parts: Array<string | null | undefined>, separator = '\n\n'): string {
  return parts.map((part) => part?.trim()).filter(Boolean).join(separator);
}

function formatReasoningText(item: PiThreadItem): string {
  const content = Array.isArray(item.content)
    ? item.content.filter((value): value is string => typeof value === 'string').join('')
    : '';
  return content;
}

function formatReasoningSummaries(item: PiThreadItem): string[] {
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
    return stringifyPiValue(summary);
  });
}

function formatCommandResult(item: PiThreadItem): string {
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

function formatFileChangeResult(item: PiThreadItem): string {
  const changes = Array.isArray(item.changes) ? item.changes : [];
  const renderedChanges = changes
    .map((change) => {
      if (!change || typeof change !== 'object') {
        return stringifyPiValue(change);
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

function formatMcpToolResult(item: PiThreadItem): string {
  if (item.error != null) {
    return stringifyPiValue(item.error);
  }
  if (item.result != null) {
    return stringifyPiValue(item.result);
  }
  if (typeof item.status === 'string') {
    return `status: ${item.status}`;
  }
  return '';
}

function formatDynamicToolResult(item: PiThreadItem): string {
  const parts: string[] = [];
  if (Array.isArray(item.contentItems)) {
    for (const contentItem of item.contentItems) {
      if (!contentItem || typeof contentItem !== 'object') {
        parts.push(stringifyPiValue(contentItem));
        continue;
      }
      if (
        (contentItem as { type?: unknown }).type === 'inputText' &&
        typeof (contentItem as { text?: unknown }).text === 'string'
      ) {
        parts.push((contentItem as { text: string }).text);
        continue;
      }
      parts.push(stringifyPiValue(contentItem));
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

function formatCollabAgentResult(item: PiThreadItem): string {
  return stringifyPiValue({
    status: item.status,
    tool: item.tool,
    receiverThreadIds: item.receiverThreadIds,
    agentsStates: item.agentsStates,
  });
}

function formatWebSearchResult(item: PiThreadItem): string {
  return joinNonEmpty([
    typeof item.query === 'string' ? item.query : '',
    item.action != null ? stringifyPiValue(item.action) : '',
  ]);
}

function formatImageResult(item: PiThreadItem): string {
  return joinNonEmpty([
    typeof item.savedPath === 'string' ? `saved to: ${item.savedPath}` : '',
    typeof item.result === 'string' ? item.result : '',
    typeof item.path === 'string' ? item.path : '',
    typeof item.revisedPrompt === 'string' ? `prompt: ${item.revisedPrompt}` : '',
  ]);
}

function isFailedRuntimeItem(item: PiThreadItem): boolean {
  const status = typeof item.status === 'string' ? item.status : '';
  const result = item.result && typeof item.result === 'object'
    ? item.result as { details?: unknown }
    : null;
  const details = result?.details && typeof result.details === 'object'
    ? result.details as { success?: unknown; exitCode?: unknown }
    : null;
  return (
    item.isError === true ||
    status === 'failed' ||
    status === 'error' ||
    item.error != null ||
    item.success === false ||
    details?.success === false ||
    (typeof details?.exitCode === 'number' && details.exitCode !== 0) ||
    (
      item.type === 'commandExecution' &&
      typeof item.exitCode === 'number' &&
      item.exitCode !== 0
    )
  );
}

function buildRuntimeToolResult(
  item: PiThreadItem,
  content: string | ContentBlock[]
): RuntimeToolResult | null {
  if (typeof content === 'string' && content.length === 0) {
    return null;
  }
  if (Array.isArray(content) && content.length === 0) {
    return null;
  }
  return {
    content,
    isError: isFailedRuntimeItem(item),
  };
}

function canonicalizeDynamicToolName(tool: unknown): string {
  if (typeof tool !== 'string') return 'DynamicTool';
  const name = tool.trim();
  if (!name) return 'DynamicTool';

  switch (name) {
    case 'ask_user_question':
      return 'AskUserQuestion';
    case 'todo_write':
    case 'update_todo':
      return 'TodoWrite';
    case 'agent':
      return 'Agent';
    case 'Explore':
    case 'explore':
      return 'Agent';
    case 'web_search':
      return 'WebSearch';
    case 'web_fetch':
      return 'WebFetch';
    case 'js_exec':
      return 'JavaScript';
    case 'list_apps':
      return 'ListApps';
    case 'set_app_visibility':
      return 'SetAppVisibility';
    case 'get_latest_logs':
      return 'GetLatestLogs';
    case 'list_scheduled_prompts':
      return 'ListScheduledPrompts';
    case 'create_scheduled_prompt':
      return 'CreateScheduledPrompt';
    case 'update_scheduled_prompt':
      return 'UpdateScheduledPrompt';
    case 'delete_scheduled_prompt':
      return 'DeleteScheduledPrompt';
    case 'run_scheduled_prompt_now':
      return 'RunScheduledPrompt';
    case 'list_workflows':
    case 'list_deterministic_automations':
      return 'ListWorkflows';
    case 'validate_workflow':
    case 'validate_deterministic_automation':
      return 'ValidateWorkflow';
    case 'create_workflow':
    case 'create_deterministic_automation':
      return 'CreateWorkflow';
    case 'update_workflow':
    case 'update_deterministic_automation':
      return 'UpdateWorkflow';
    case 'delete_workflow':
    case 'delete_deterministic_automation':
      return 'DeleteWorkflow';
    case 'run_workflow_now':
    case 'run_deterministic_automation_now':
      return 'RunWorkflow';
    case 'list_integrations':
      return 'ListConnections';
    case 'list_integration_types':
      return 'ListConnectionTypes';
    case 'create_integration':
      return 'CreateConnection';
    case 'prompt_connection_setup':
      return 'PromptConnectionSetup';
    case 'get_custom_domain':
      return 'GetCustomDomain';
    case 'set_custom_domain':
      return 'SetCustomDomain';
    case 'remove_custom_domain':
      return 'RemoveCustomDomain';
    case 'retry_custom_domain_hostnames':
      return 'RetryCustomDomains';
    case 'connections_list':
      return 'ListConnections';
    case 'connections_get':
      return 'GetConnection';
    case 'connections_tools':
      return 'ListConnectionTools';
    case 'connections_methods':
      return 'ListConnectionMethods';
    case 'read':
      return 'Read';
    case 'write':
      return 'Write';
    case 'edit':
      return 'Edit';
    case 'ls':
      return 'LS';
    case 'bash':
      return 'Bash';
    case 'grep':
      return 'Grep';
    case 'find':
      return 'Find';
    case 'glob':
      return 'Glob';
    default:
      return name;
  }
}

function normalizeEditArguments(args: Record<string, unknown>): Record<string, unknown> {
  const next = { ...args };

  if (typeof next.old_string !== 'string' && typeof next.oldText === 'string') {
    next.old_string = next.oldText;
  }
  if (typeof next.new_string !== 'string' && typeof next.newText === 'string') {
    next.new_string = next.newText;
  }

  if (Array.isArray(next.edits)) {
    next.edits = next.edits.map((edit) => {
      if (!edit || typeof edit !== 'object' || Array.isArray(edit)) return edit;
      const editRecord = edit as Record<string, unknown>;
      return {
        ...editRecord,
        old_string:
          typeof editRecord.old_string === 'string'
            ? editRecord.old_string
            : editRecord.oldText,
        new_string:
          typeof editRecord.new_string === 'string'
            ? editRecord.new_string
            : editRecord.newText,
      };
    });
  }

  return next;
}

function omitUndefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined)
  );
}

function buildDynamicToolInput(item: PiThreadItem): Record<string, unknown> {
  const args =
    item.arguments && typeof item.arguments === 'object' && !Array.isArray(item.arguments)
      ? normalizeEditArguments(item.arguments as Record<string, unknown>)
      : {};
  const rawToolName = typeof item.tool === 'string' ? item.tool : undefined;

  return omitUndefined({
    ...args,
    arguments: item.arguments,
    status: item.status,
    durationMs: item.durationMs,
    rawToolName,
  });
}

function buildToolUseFromPiItem(item: PiThreadItem): {
  name: string;
  input: Record<string, unknown>;
} | null {
  switch (item.type) {
    case 'commandExecution':
      return {
        name: 'Bash',
        input: omitUndefined({
          command: item.command,
          description: item.description,
          cwd: item.cwd,
          source: item.source,
          processId: item.processId,
          status: item.status,
          commandActions: item.commandActions,
        }),
      };
    case 'fileChange':
      return {
        name: 'PiFileChange',
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
        name: canonicalizeDynamicToolName(item.tool),
        input: buildDynamicToolInput(item),
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
        name: 'PiImageView',
        input: {
          path: item.path,
        },
      };
    case 'imageGeneration':
      return {
        name: 'PiImageGeneration',
        input: {
          status: item.status,
          revisedPrompt: item.revisedPrompt,
          savedPath: item.savedPath,
        },
      };
    case 'enteredReviewMode':
      return {
        name: 'PiReviewMode',
        input: {
          action: 'enter',
          review: item.review,
        },
      };
    case 'exitedReviewMode':
      return {
        name: 'PiReviewMode',
        input: {
          action: 'exit',
          review: item.review,
        },
      };
    case 'contextCompaction':
      return {
        name: 'PiContextCompaction',
        input: {},
      };
    default:
      return {
        name: `Pi:${item.type}`,
        input: Object.fromEntries(
          Object.entries(item).filter(([key]) => key !== 'id' && key !== 'type')
        ),
      };
  }
}

function buildToolResultFromPiItem(item: PiThreadItem): RuntimeToolResult | null {
  switch (item.type) {
    case 'commandExecution':
      return buildRuntimeToolResult(item, formatCommandResult(item));
    case 'fileChange':
      return buildRuntimeToolResult(item, formatFileChangeResult(item));
    case 'mcpToolCall':
      return buildRuntimeToolResult(item, formatMcpToolResult(item));
    case 'dynamicToolCall':
      return buildRuntimeToolResult(item, formatDynamicToolResult(item));
    case 'collabAgentToolCall':
      return buildRuntimeToolResult(item, formatCollabAgentResult(item));
    case 'webSearch':
      return buildRuntimeToolResult(item, formatWebSearchResult(item));
    case 'imageView':
    case 'imageGeneration':
      return buildRuntimeToolResult(item, formatImageResult(item));
    case 'enteredReviewMode':
      return buildRuntimeToolResult(
        item,
        typeof item.review === 'string' ? item.review : 'Entered review mode.'
      );
    case 'exitedReviewMode':
      return buildRuntimeToolResult(
        item,
        typeof item.review === 'string' ? item.review : 'Exited review mode.'
      );
    case 'contextCompaction':
      return buildRuntimeToolResult(item, 'Context compacted.');
    default:
      return buildRuntimeToolResult(
        item,
        stringifyPiValue(
          Object.fromEntries(
            Object.entries(item).filter(([key]) => key !== 'id' && key !== 'type')
          )
        )
      );
  }
}

function applyPiItemStarted(
  blocks: ContentBlock[],
  item: PiThreadItem
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
        'Thinking',
        item.type
      );
    default: {
      const tool = buildToolUseFromPiItem(item);
      if (!tool) {
        return blocks;
      }
      return upsertToolUseBlock(blocks, item.id, tool.name, tool.input, item.type);
    }
  }
}

function applyPiItemCompleted(
  blocks: ContentBlock[],
  item: PiThreadItem
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
          'Thinking',
          item.type
        ),
        item.id,
        formatReasoningSummaries(item)
      );
    default: {
      let nextBlocks = blocks;
      const tool = buildToolUseFromPiItem(item);
      if (tool) {
        nextBlocks = upsertToolUseBlock(nextBlocks, item.id, tool.name, tool.input, item.type);
      }
      const result = buildToolResultFromPiItem(item);
      if (result) {
        nextBlocks = upsertToolResultBlock(
          nextBlocks,
          item.id,
          result.content,
          item.type,
          { isError: result.isError }
        );
      }
      return nextBlocks;
    }
  }
}

function applyPiRuntimeEvent(
  currentMessages: Message[],
  threadId: string,
  event: PiNotification,
  streamingMessageIds: Record<string, string | null>
): Message[] {
  const params = event.params ?? {};
  const itemId = typeof params.itemId === 'string' ? params.itemId : undefined;

  if (event.method === 'turn/completed') {
    const forkEntryId =
      typeof params.forkEntryId === 'string' && params.forkEntryId.trim()
        ? params.forkEntryId.trim()
        : undefined;
    return finalizeAssistantMessage(
      currentMessages,
      threadId,
      streamingMessageIds,
      forkEntryId,
    );
  }

  if (event.method === 'turn/plan/updated') {
    const todos = buildPiTodos(params.plan);
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

  if (event.method === 'item/started' && isPiThreadItem(params.item)) {
    const item = params.item;
    return updateStreamingAssistantMessage(
      currentMessages,
      threadId,
      streamingMessageIds,
      (blocks) => applyPiItemStarted(blocks, item),
    );
  }

  if (event.method === 'item/completed' && isPiThreadItem(params.item)) {
    const item = params.item;
    return updateStreamingAssistantMessage(
      currentMessages,
      threadId,
      streamingMessageIds,
      (blocks) => applyPiItemCompleted(blocks, item),
    );
  }

  if (event.method === 'item/agentMessage/delta' && itemId && typeof params.delta === 'string') {
    const itemKind =
      typeof params.itemKind === 'string' && params.itemKind.trim()
        ? params.itemKind.trim()
        : 'agentMessage';
    return updateStreamingAssistantMessage(
      currentMessages,
      threadId,
      streamingMessageIds,
      (blocks) => appendTextDeltaBlock(blocks, itemId, params.delta as string, itemKind),
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
          'Thinking',
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
  event: unknown,
  streamingMessageIds: Record<string, string | null>
): Message[] {
  if (!isPiRuntimeEvent(event)) {
    return currentMessages;
  }

  return applyPiRuntimeEvent(
    currentMessages,
    threadId,
    event,
    streamingMessageIds,
  );
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
    if (block.type === 'error') {
      parts.push(block.error);
      continue;
    }
    if (block.type === 'redacted_thinking') {
      parts.push('[Thinking redacted]');
    }
  }

  return parts.join('\n').trim();
}
