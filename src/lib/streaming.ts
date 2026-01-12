import type { ContentBlock, Message } from '@/types';

export interface SDKEvent {
  type: string;
  subtype?: string;
  isMeta?: boolean;
  is_meta?: boolean;
  sourceToolUseID?: string;
  sourceToolUseId?: string;
  source_tool_use_id?: string;
  parent_tool_use_id?: string;
  message?: {
    content: ContentBlock[];
    stop_reason?: string | null;
    isMeta?: boolean;
    is_meta?: boolean;
    sourceToolUseID?: string;
    sourceToolUseId?: string;
    source_tool_use_id?: string;
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
    };
    content_block?: {
      type: string;
      text?: string;
      id?: string;
      name?: string;
    };
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
    if (block?.type === 'thinking') {
      newContent[index] = { type: 'thinking', thinking: (block as { thinking?: string }).thinking || '' };
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
  }

  if (evt?.type === 'content_block_stop') {
    const newContent = content.map(block => {
      if (block.type === 'tool_use' && (block as ContentBlock & { _inputJson?: string })._inputJson) {
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
    // Clear internal offset when streaming completes
    const rest = { ...message };
    delete (rest as { _blockOffset?: number })._blockOffset;
    return { ...rest, isStreaming: false };
  }

  if (evt?.type === 'message_stop') {
    // Clear internal offset when streaming completes
    const rest = { ...message };
    delete (rest as { _blockOffset?: number })._blockOffset;
    return { ...rest, isStreaming: false };
  }

  return message;
}
