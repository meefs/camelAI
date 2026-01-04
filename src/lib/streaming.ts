import type { ContentBlock } from '@/types';

export interface SDKEvent {
  type: string;
  subtype?: string;
  message?: {
    content: ContentBlock[];
    stop_reason?: string | null;
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

export interface StreamingState {
  content: ContentBlock[];
  isStreaming: boolean;
  blockOffset: number;
}

export function applySdkEventToStreamingState(prev: StreamingState, sdkEvent: SDKEvent): StreamingState {
  if (sdkEvent.type === 'system' && sdkEvent.subtype === 'init') {
    return { content: [], isStreaming: true, blockOffset: 0 };
  }

  if (sdkEvent.type !== 'stream_event') {
    return prev;
  }

  const evt = sdkEvent.event;
  if (evt?.type === 'message_start') {
    return { ...prev, isStreaming: true, blockOffset: prev.content.length };
  }

  if (evt?.type === 'content_block_start') {
    const block = evt.content_block;
    const baseOffset = Number.isFinite(prev.blockOffset) ? prev.blockOffset : 0;
    const index = typeof evt.index === 'number' ? baseOffset + evt.index : prev.content.length;
    const newContent = [...prev.content];
    if (block?.type === 'tool_use') {
      newContent[index] = {
        type: 'tool_use' as const,
        id: block.id || '',
        name: block.name || '',
        input: {},
      };
      return { ...prev, isStreaming: true, content: newContent };
    }
    if (block?.type === 'text') {
      newContent[index] = { type: 'text', text: block.text || '' };
      return { ...prev, isStreaming: true, content: newContent };
    }
    if (block?.type === 'thinking') {
      newContent[index] = { type: 'thinking', thinking: (block as { thinking?: string }).thinking || '' };
      return { ...prev, isStreaming: true, content: newContent };
    }
    return { ...prev, isStreaming: true };
  }

  if (evt?.type === 'content_block_delta') {
    if (evt.delta?.type === 'text_delta' && evt.delta.text) {
      const newContent = [...prev.content];
      const baseOffset = Number.isFinite(prev.blockOffset) ? prev.blockOffset : 0;
      const index = typeof evt.index === 'number' ? baseOffset + evt.index : newContent.length - 1;
      const target = newContent[index];
      if (target?.type === 'text') {
        newContent[index] = {
          ...target,
          text: (target.text || '') + evt.delta.text,
        };
      } else {
        newContent[index] = { type: 'text', text: evt.delta.text };
      }
      return { ...prev, content: newContent };
    }

    if (evt.delta?.type === 'input_json_delta' && evt.delta.partial_json) {
      const newContent = [...prev.content];
      const baseOffset = Number.isFinite(prev.blockOffset) ? prev.blockOffset : 0;
      const index = typeof evt.index === 'number' ? baseOffset + evt.index : newContent.length - 1;
      const target = newContent[index];
      if (target && target.type === 'tool_use') {
        const currentInput = (target as ContentBlock & { _inputJson?: string })._inputJson || '';
        newContent[index] = {
          ...target,
          _inputJson: currentInput + evt.delta.partial_json,
        } as ContentBlock & { _inputJson?: string };
      }
      return { ...prev, content: newContent };
    }
  }

  if (evt?.type === 'content_block_stop') {
    const newContent = prev.content.map(block => {
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
    return { ...prev, content: newContent };
  }

  if (evt?.type === 'message_delta' && evt.delta?.stop_reason) {
    return { ...prev, isStreaming: false };
  }

  if (evt?.type === 'message_stop') {
    return { ...prev, isStreaming: false };
  }

  return prev;
}
