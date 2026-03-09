import type {
  ContentBlock,
  Message,
  TaskNotificationBlock,
  TeammateMessageBlock,
  ToolResultBlock,
  ToolUseBlock,
} from '@/types';
import { parseTeammateMessage } from '@/lib/teammate-message';
import { parseTaskNotificationFromContent } from '@/lib/task-notification';

export interface SDKEvent {
  type: string;
  timestamp?: string;
  subtype?: string;
  isMeta?: boolean;
  is_meta?: boolean;
  sourceToolUseID?: string;
  sourceToolUseId?: string;
  source_tool_use_id?: string;
  parentToolUseID?: string;
  parentToolUseId?: string;
  parent_tool_use_id?: string;
  toolUseResult?: {
    prompt?: unknown;
  };
  tool_use_result?: {
    prompt?: unknown;
  };
  message?: {
    content: ContentBlock[];
    stop_reason?: string | null;
    isMeta?: boolean;
    is_meta?: boolean;
    sourceToolUseID?: string;
    sourceToolUseId?: string;
    source_tool_use_id?: string;
    parentToolUseID?: string;
    parentToolUseId?: string;
    parent_tool_use_id?: string;
  };
  event?: {
    type: string;
    index?: number;
    message?: {
      id?: string;
    };
    delta?: {
      type?: string;
      text?: string;
      stop_reason?: string;
      partial_json?: string;
      /** Compaction summary content (delivered as a single chunk) */
      content?: string;
      /** Thinking block text chunk (thinking_delta) */
      thinking?: string;
      /** Thinking block signature (signature_delta) */
      signature?: string;
    };
    content_block?: {
      type: string;
      text?: string;
      id?: string;
      name?: string;
      thinking?: string;
      signature?: string;
    };
  };
}

function firstStringValue(
  record: Record<string, unknown>,
  keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string') {
      return value;
    }
  }
  return undefined;
}

export function extractToolEventMetaInfo(
  event: SDKEvent
): { isMeta: boolean; sourceToolUseID?: string } {
  const record = event as unknown as Record<string, unknown>;
  const messageRecord = (event.message ?? {}) as unknown as Record<string, unknown>;
  const sourceToolUseKeys = [
    'sourceToolUseID',
    'sourceToolUseId',
    'source_tool_use_id',
    'parentToolUseID',
    'parentToolUseId',
    'parent_tool_use_id',
  ];
  const sourceToolUseID = firstStringValue(record, sourceToolUseKeys)
    ?? firstStringValue(messageRecord, sourceToolUseKeys);
  const isMeta = Boolean(
    record.isMeta ??
    record.is_meta ??
    messageRecord.isMeta ??
    messageRecord.is_meta
  );
  return { isMeta, sourceToolUseID };
}

function isContentBlockLike(value: unknown): value is ContentBlock {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof (value as { type?: unknown }).type === 'string'
  );
}

function sanitizeContentBlocks(content: Message['content']): ContentBlock[] {
  if (!Array.isArray(content)) return [];
  return content.filter(isContentBlockLike);
}

function sanitizeMessageContentForRender(message: Message): Message {
  if (!Array.isArray(message.content)) return message;
  const sanitizedContent = sanitizeContentBlocks(message.content);
  if (sanitizedContent.length === message.content.length) {
    return message;
  }
  return {
    ...message,
    content: sanitizedContent,
  };
}

/**
 * Apply an SDK event to a message's content, returning the updated message.
 * Uses message._blockOffset to track content block indices across streaming turns.
 */
export function applyStreamingEventToMessage(
  message: Message,
  sdkEvent: SDKEvent
): Message {
  // Ensure content is an array
  const content: ContentBlock[] = Array.isArray(message.content)
    ? message.content
    : [];

  if (sdkEvent.type === 'system' && sdkEvent.subtype === 'init') {
    return { ...message, content: [], isStreaming: true, _blockOffset: 0 };
  }

  if (sdkEvent.type !== 'stream_event') {
    return message;
  }

  const evt = sdkEvent.event;
  const blockOffset = message._blockOffset ?? 0;

  if (evt?.type === 'message_start') {
    return { ...message, isStreaming: true, _blockOffset: content.length };
  }

  if (evt?.type === 'content_block_start') {
    const block = evt.content_block;
    const index = typeof evt.index === 'number' ? blockOffset + evt.index : content.length;
    const newContent = [...content];

    if (block?.type === 'tool_use') {
      newContent[index] = {
        type: 'tool_use' as const,
        id: block.id || '',
        name: block.name || '',
        input: {},
      };
      return { ...message, content: newContent, isStreaming: true };
    }
    if (block?.type === 'text') {
      newContent[index] = { type: 'text', text: block.text || '' };
      return { ...message, content: newContent, isStreaming: true };
    }
    if (block?.type === 'thinking' || block?.type === 'redacted_thinking') {
      const thinkingBlock: ContentBlock = {
        type: 'thinking',
        thinking: block.thinking || '',
      };
      if (block.signature) {
        thinkingBlock.signature = block.signature;
      }
      newContent[index] = thinkingBlock;
      return { ...message, content: newContent, isStreaming: true };
    }
    return { ...message, isStreaming: true };
  }

  if (evt?.type === 'content_block_delta') {
    if (evt.delta?.type === 'text_delta' && evt.delta.text) {
      const newContent = [...content];
      const index = typeof evt.index === 'number' ? blockOffset + evt.index : newContent.length - 1;
      const target = newContent[index];
      if (target?.type === 'text') {
        newContent[index] = {
          ...target,
          text: (target.text || '') + evt.delta.text,
        };
      } else {
        newContent[index] = { type: 'text', text: evt.delta.text };
      }
      return { ...message, content: newContent };
    }

    if (evt.delta?.type === 'input_json_delta' && evt.delta.partial_json) {
      const newContent = [...content];
      const index = typeof evt.index === 'number' ? blockOffset + evt.index : newContent.length - 1;
      const target = newContent[index];
      if (target && target.type === 'tool_use') {
        const currentInput = (target as ContentBlock & { _inputJson?: string })._inputJson || '';
        newContent[index] = {
          ...target,
          _inputJson: currentInput + evt.delta.partial_json,
        } as ContentBlock & { _inputJson?: string };
      }
      return { ...message, content: newContent };
    }

    if (evt.delta?.type === 'thinking_delta' && evt.delta.thinking) {
      const newContent = [...content];
      const index = typeof evt.index === 'number' ? blockOffset + evt.index : newContent.length - 1;
      const target = newContent[index];
      if (target?.type === 'thinking') {
        newContent[index] = {
          ...target,
          thinking: (target.thinking || '') + evt.delta.thinking,
        };
      }
      return { ...message, content: newContent };
    }

    if (evt.delta?.type === 'signature_delta' && evt.delta.signature) {
      const newContent = [...content];
      const index = typeof evt.index === 'number' ? blockOffset + evt.index : newContent.length - 1;
      const target = newContent[index];
      if (target?.type === 'thinking') {
        newContent[index] = {
          ...target,
          signature: (target.signature || '') + evt.delta.signature,
        };
      }
      return { ...message, content: newContent };
    }
  }

  if (evt?.type === 'content_block_stop') {
    const newContent = content.map(block => {
      if (
        isContentBlockLike(block) &&
        block.type === 'tool_use' &&
        (block as ContentBlock & { _inputJson?: string })._inputJson
      ) {
        try {
          const input = JSON.parse((block as ContentBlock & { _inputJson?: string })._inputJson || '');
          const rest = { ...(block as ContentBlock & { _inputJson?: string }) };
          delete (rest as { _inputJson?: string })._inputJson;
          return { ...rest, input };
        } catch {
          return block;
        }
      }
      return block;
    });
    return { ...message, content: newContent };
  }

  if (evt?.type === 'message_delta' && evt.delta?.stop_reason) {
    return finalizeStreamingMessage(message);
  }

  if (evt?.type === 'message_stop') {
    return finalizeStreamingMessage(message);
  }

  return message;
}

/**
 * Finalize a streaming message: remove empty thinking blocks, clear internal
 * offset tracking, and mark as no longer streaming.
 */
export function finalizeStreamingMessage(message: Message): Message {
  const content = sanitizeContentBlocks(message.content);
  const cleanedContent = content.filter(
    block => block.type !== 'thinking' || block.thinking.trim().length > 0
  );
  const rest = { ...message };
  delete (rest as { _blockOffset?: number })._blockOffset;
  return { ...rest, content: cleanedContent, isStreaming: false };
}

function isToolResultBlock(block: ContentBlock | null | undefined): block is ToolResultBlock {
  return block?.type === 'tool_result';
}

interface ToolUseIndexEntry {
  messageIndex: number;
  tool: ToolUseBlock;
}

function buildToolUseIndex(messages: Message[]): Map<string, ToolUseIndexEntry> {
  const index = new Map<string, ToolUseIndexEntry>();
  messages.forEach((message, messageIndex) => {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) return;
    sanitizeContentBlocks(message.content).forEach(block => {
      if (block.type !== 'tool_use' || !block.id) return;
      index.set(block.id, { messageIndex, tool: block });
    });
  });
  return index;
}

function isSubAgentTool(name?: string): boolean {
  return name === 'Task' || name === 'Agent';
}

function findTaskToolUseIdByPrompt(messages: Message[], prompt?: string): string | undefined {
  if (!prompt) return undefined;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!isContentBlockLike(block)) continue;
      if (block.type !== 'tool_use' || !isSubAgentTool(block.name)) continue;
      const blockPrompt = typeof block.input?.prompt === 'string' ? block.input.prompt : '';
      if (blockPrompt && blockPrompt === prompt) {
        return block.id;
      }
    }
  }
  return undefined;
}

function coerceMessageContent(content: Message['content']): ContentBlock[] {
  if (Array.isArray(content)) return content;
  if (typeof content === 'string' && content.trim()) {
    return [{ type: 'text', text: content }];
  }
  return [];
}

function findLastAssistantIndex(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'assistant') return i;
  }
  return -1;
}

export function attachToolResultsToMessages(
  messages: Message[],
  toolResults: ToolResultBlock[],
  options: {
    threadId?: string;
    createdAt?: number;
    parentToolUseId?: string;
    parentToolPrompt?: string;
  } = {}
): Message[] {
  if (toolResults.length === 0) return messages;

  const next = [...messages];
  const toolUseIndex = buildToolUseIndex(next);
  const createdAt = options.createdAt ?? Date.now();
  const promptMatchedId = findTaskToolUseIdByPrompt(next, options.parentToolPrompt);
  const parentToolUseId = options.parentToolUseId ?? promptMatchedId;
  const parentEntry = parentToolUseId ? toolUseIndex.get(parentToolUseId) : undefined;
  const parentIsTask = isSubAgentTool(parentEntry?.tool.name);

  const appendToIndex = (index: number, toolResult: ToolResultBlock) => {
    const target = next[index];
    const content = Array.isArray(target.content)
      ? target.content.slice()
      : coerceMessageContent(target.content);
    content.push(toolResult);
    next[index] = {
      ...target,
      content,
    };
  };

  toolResults.forEach((toolResult, index) => {
    const directEntry = toolUseIndex.get(toolResult.tool_use_id);
    // When the parent is a sub-agent tool (Agent/Task), always group results under
    // the parent — even if the sub-agent's tool_use blocks were mixed into the main
    // message via streaming and would otherwise match directly.
    const resolvedToolUseId = (parentIsTask && parentToolUseId)
      ? parentToolUseId
      : directEntry
        ? toolResult.tool_use_id
        : toolResult.tool_use_id;
    const resolvedEntry = (parentIsTask && parentEntry)
      ? parentEntry
      : directEntry ?? (resolvedToolUseId === parentToolUseId ? parentEntry : undefined);
    const targetIndex = resolvedEntry?.messageIndex ?? findLastAssistantIndex(next);
    const resolvedResult = resolvedToolUseId === toolResult.tool_use_id
      ? toolResult
      : { ...toolResult, tool_use_id: resolvedToolUseId, isTaskUpdate: true };

    if (targetIndex >= 0) {
      appendToIndex(targetIndex, resolvedResult);
      return;
    }

    const threadId = options.threadId ?? messages[0]?.thread_id ?? '';
    next.push({
      id: `tool_result_${createdAt}_${index}`,
      thread_id: threadId,
      role: 'assistant',
      content: [resolvedResult],
      created_at: createdAt,
    });
  });

  return next;
}

export function normalizeToolResultMessages(messages: Message[]): Message[] {
  let normalized: Message[] = [];
  let changed = false;

  messages.forEach(message => {
    const contentBlocks = Array.isArray(message.content)
      ? sanitizeContentBlocks(message.content)
      : null;
    const isToolResultMessage = message.role === 'user' &&
      contentBlocks &&
      contentBlocks.length > 0 &&
      contentBlocks.every(isToolResultBlock);

    if (!isToolResultMessage || !contentBlocks) {
      const sanitizedMessage = sanitizeMessageContentForRender(message);
      if (sanitizedMessage !== message) {
        changed = true;
      }
      normalized.push(sanitizedMessage);
      return;
    }

    const toolResults = contentBlocks.filter(isToolResultBlock);
    normalized = attachToolResultsToMessages(normalized, toolResults, {
      threadId: message.thread_id,
      createdAt: message.created_at,
      parentToolUseId: message.sourceToolUseID,
    });
    changed = true;
  });

  return changed ? normalized : messages;
}

/**
 * Merge teammate messages into the preceding assistant message.
 *
 * Teammate messages arrive as `role: "user"` messages containing
 * `<teammate-message>` XML. This function detects them, removes them
 * from the message list, and appends a `teammate_message` content block
 * to the preceding assistant message — so they render inline with the
 * assistant's tool calls and text, with identical spacing.
 */
export function mergeTeammateMessages(messages: Message[]): Message[] {
  const result: Message[] = [];
  let changed = false;

  for (const msg of messages) {
    if (msg.role !== 'user') {
      result.push(msg);
      continue;
    }

    // Extract raw text to check for teammate message
    const rawText = typeof msg.content === 'string'
      ? msg.content
      : msg.content
          .map(block => (block.type === 'text' ? block.text : ''))
          .filter(Boolean)
          .join('\n');

    const parsed = parseTeammateMessage(rawText);
    if (!parsed) {
      result.push(msg);
      continue;
    }

    // Find the last assistant message to attach to
    let lastAssistantIndex = -1;
    for (let i = result.length - 1; i >= 0; i -= 1) {
      if (result[i].role === 'assistant') {
        lastAssistantIndex = i;
        break;
      }
    }

    if (lastAssistantIndex === -1) {
      // No preceding assistant message — keep as-is (fallback)
      result.push(msg);
      continue;
    }

    // Append teammate block to the assistant message's content
    const assistantMsg = result[lastAssistantIndex];
    const existingContent: ContentBlock[] = Array.isArray(assistantMsg.content)
      ? assistantMsg.content
      : [{ type: 'text' as const, text: assistantMsg.content }];

    const teammateBlock: TeammateMessageBlock = {
      type: 'teammate_message',
      teammateId: parsed.teammateId,
      content: parsed.content,
    };

    result[lastAssistantIndex] = {
      ...assistantMsg,
      content: [...existingContent, teammateBlock],
    };
    changed = true;
  }

  return changed ? result : messages;
}

/**
 * Merge task notifications into assistant content so they render as tool-call rows.
 *
 * Task notifications arrive as `role: "user"` messages containing
 * `<task-notification>` XML. This function removes those messages and appends
 * a `task_notification` block to the assistant message that owns the referenced
 * tool use (`sourceToolUseID`) when available, otherwise to the nearest
 * preceding assistant message. If no assistant message exists yet, it creates
 * a synthetic assistant message so raw XML is never shown in the transcript.
 */
export function mergeTaskNotifications(messages: Message[]): Message[] {
  const result: Message[] = [];
  let changed = false;
  const fullToolUseIndex = buildToolUseIndex(messages);
  const resultAssistantIndexBySourceIndex = new Map<number, number>();
  const queuedByAssistantSourceIndex = new Map<
    number,
    Array<{ sourceMessage: Message; taskBlock: TaskNotificationBlock }>
  >();

  const appendTaskBlockToAssistant = (assistantResultIndex: number, taskBlock: TaskNotificationBlock) => {
    const assistantMsg = result[assistantResultIndex];
    const existingContent = coerceMessageContent(assistantMsg.content);
    result[assistantResultIndex] = {
      ...assistantMsg,
      content: [...existingContent, taskBlock],
    };
  };

  const enqueueForAssistant = (
    assistantSourceIndex: number,
    sourceMessage: Message,
    taskBlock: TaskNotificationBlock
  ) => {
    const existing = queuedByAssistantSourceIndex.get(assistantSourceIndex);
    if (existing) {
      existing.push({ sourceMessage, taskBlock });
      return;
    }
    queuedByAssistantSourceIndex.set(assistantSourceIndex, [{ sourceMessage, taskBlock }]);
  };

  const flushQueuedForAssistant = (assistantSourceIndex: number, assistantResultIndex: number) => {
    const queued = queuedByAssistantSourceIndex.get(assistantSourceIndex);
    if (!queued || queued.length === 0) return;

    queued.forEach(({ taskBlock }) => {
      appendTaskBlockToAssistant(assistantResultIndex, taskBlock);
    });
    queuedByAssistantSourceIndex.delete(assistantSourceIndex);
  };

  for (const [sourceIndex, msg] of messages.entries()) {
    if (msg.role !== 'user') {
      result.push(msg);
      if (msg.role === 'assistant') {
        const assistantResultIndex = result.length - 1;
        resultAssistantIndexBySourceIndex.set(sourceIndex, assistantResultIndex);
        flushQueuedForAssistant(sourceIndex, assistantResultIndex);
      }
      continue;
    }

    const parsed = parseTaskNotificationFromContent(msg.content);
    if (!parsed) {
      result.push(msg);
      continue;
    }

    const taskBlock: TaskNotificationBlock = {
      type: 'task_notification',
      taskId: parsed.taskId,
      outputFile: parsed.outputFile,
      status: parsed.status,
      summary: parsed.summary,
    };

    const sourceToolUseId = msg.sourceToolUseID;
    const sourceToolEntry = sourceToolUseId
      ? fullToolUseIndex.get(sourceToolUseId)
      : undefined;

    if (typeof sourceToolEntry?.messageIndex === 'number') {
      const resolvedAssistantResultIndex = resultAssistantIndexBySourceIndex.get(sourceToolEntry.messageIndex);
      if (typeof resolvedAssistantResultIndex === 'number') {
        appendTaskBlockToAssistant(resolvedAssistantResultIndex, taskBlock);
      } else {
        enqueueForAssistant(sourceToolEntry.messageIndex, msg, taskBlock);
      }
      changed = true;
      continue;
    }

    const targetAssistantIndex = findLastAssistantIndex(result);

    if (targetAssistantIndex === -1) {
      result.push({
        id: `task_notification_${msg.id}`,
        thread_id: msg.thread_id,
        role: 'assistant',
        content: [taskBlock],
        created_at: msg.created_at,
      });
      changed = true;
      continue;
    }

    appendTaskBlockToAssistant(targetAssistantIndex, taskBlock);
    changed = true;
  }

  if (queuedByAssistantSourceIndex.size > 0) {
    queuedByAssistantSourceIndex.forEach(queued => {
      queued.forEach(({ sourceMessage, taskBlock }) => {
        result.push({
          id: `task_notification_${sourceMessage.id}`,
          thread_id: sourceMessage.thread_id,
          role: 'assistant',
          content: [taskBlock],
          created_at: sourceMessage.created_at,
        });
      });
    });
    changed = true;
  }

  return changed ? result : messages;
}
