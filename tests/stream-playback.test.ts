import { describe, it, expect } from 'vitest';
import { applyStreamingEventToMessage, finalizeStreamingMessage } from '@/lib/streaming';
import type { Message } from '@/types';

function createMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'test-msg',
    thread_id: 'test-thread',
    role: 'assistant',
    content: [],
    created_at: Date.now(),
    isStreaming: false,
    ...overrides,
  };
}

describe('Stream playback - streaming reducer', () => {
  it('builds text and tool_use blocks from stream events', () => {
    const events = [
      { type: 'system', subtype: 'init' },
      {
        type: 'stream_event',
        event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      },
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello ' } },
      },
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'world' } },
      },
      {
        type: 'stream_event',
        event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tool-1', name: 'Bash' } },
      },
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' } },
      },
      {
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 1 },
      },
    ];

    let message = createMessage();
    for (const event of events) {
      message = applyStreamingEventToMessage(message, event);
    }

    expect(message.content).toEqual([
      { type: 'text', text: 'Hello world' },
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls' } },
    ]);
  });

  it('starts a new text block when index advances', () => {
    const events = [
      { type: 'system', subtype: 'init' },
      {
        type: 'stream_event',
        event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      },
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'First' } },
      },
      {
        type: 'stream_event',
        event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      },
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Second' } },
      },
    ];

    let message = createMessage();
    for (const event of events) {
      message = applyStreamingEventToMessage(message, event);
    }

    expect(message.content).toEqual([
      { type: 'text', text: 'First' },
      { type: 'text', text: 'Second' },
    ]);
  });

  it('keeps content intact through message_stop', () => {
    const events = [
      { type: 'system', subtype: 'init' },
      {
        type: 'stream_event',
        event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      },
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done' } },
      },
      {
        type: 'stream_event',
        event: { type: 'message_stop' },
      },
    ];

    let message = createMessage();
    for (const event of events) {
      message = applyStreamingEventToMessage(message, event);
    }

    expect(message.isStreaming).toBe(false);
    expect(message.content).toEqual([{ type: 'text', text: 'Done' }]);
  });

  it('appends blocks across multiple message_start segments', () => {
    const events = [
      { type: 'system', subtype: 'init' },
      {
        type: 'stream_event',
        event: { type: 'message_start' },
      },
      {
        type: 'stream_event',
        event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      },
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'First message' } },
      },
      {
        type: 'stream_event',
        event: { type: 'message_stop' },
      },
      {
        type: 'stream_event',
        event: { type: 'message_start' },
      },
      {
        type: 'stream_event',
        event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      },
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Second message' } },
      },
      {
        type: 'stream_event',
        event: { type: 'message_stop' },
      },
    ];

    let message = createMessage();
    for (const event of events) {
      message = applyStreamingEventToMessage(message, event);
    }

    expect(message.content).toEqual([
      { type: 'text', text: 'First message' },
      { type: 'text', text: 'Second message' },
    ]);
  });

  it('accumulates thinking blocks from thinking_delta events', () => {
    const events = [
      { type: 'system', subtype: 'init' },
      {
        type: 'stream_event',
        event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
      },
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Let me ' } },
      },
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'analyze this' } },
      },
      {
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 0 },
      },
      {
        type: 'stream_event',
        event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      },
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Here is my response' } },
      },
    ];

    let message = createMessage();
    for (const event of events) {
      message = applyStreamingEventToMessage(message, event);
    }

    expect(message.content).toEqual([
      { type: 'thinking', thinking: 'Let me analyze this' },
      { type: 'text', text: 'Here is my response' },
    ]);
  });

  it('filters empty thinking blocks on message_stop', () => {
    const events = [
      { type: 'system', subtype: 'init' },
      {
        type: 'stream_event',
        event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
      },
      {
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 0 },
      },
      {
        type: 'stream_event',
        event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      },
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Response' } },
      },
      {
        type: 'stream_event',
        event: { type: 'message_stop' },
      },
    ];

    let message = createMessage();
    for (const event of events) {
      message = applyStreamingEventToMessage(message, event);
    }

    expect(message.content).toEqual([
      { type: 'text', text: 'Response' },
    ]);
    expect(message.isStreaming).toBe(false);
  });

  it('preserves non-empty thinking blocks on message_stop', () => {
    const events = [
      { type: 'system', subtype: 'init' },
      {
        type: 'stream_event',
        event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
      },
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Reasoning here' } },
      },
      {
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 0 },
      },
      {
        type: 'stream_event',
        event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      },
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Response' } },
      },
      {
        type: 'stream_event',
        event: { type: 'message_stop' },
      },
    ];

    let message = createMessage();
    for (const event of events) {
      message = applyStreamingEventToMessage(message, event);
    }

    expect(message.content).toEqual([
      { type: 'thinking', thinking: 'Reasoning here' },
      { type: 'text', text: 'Response' },
    ]);
    expect(message.isStreaming).toBe(false);
  });

  it('finalizeStreamingMessage removes empty thinking blocks and clears streaming state', () => {
    const message: Message = {
      id: 'test',
      thread_id: 'thread',
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '' },
        { type: 'thinking', thinking: 'Real thought' },
        { type: 'text', text: 'Response' },
      ],
      created_at: Date.now(),
      isStreaming: true,
      _blockOffset: 5,
    };

    const result = finalizeStreamingMessage(message);

    expect(result.content).toEqual([
      { type: 'thinking', thinking: 'Real thought' },
      { type: 'text', text: 'Response' },
    ]);
    expect(result.isStreaming).toBe(false);
    expect((result as Message & { _blockOffset?: number })._blockOffset).toBeUndefined();
  });

  it('handles redacted_thinking content_block_start without errors', () => {
    const events = [
      { type: 'system', subtype: 'init' },
      {
        type: 'stream_event',
        event: { type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking' } },
      },
      {
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 0 },
      },
      {
        type: 'stream_event',
        event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      },
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Response' } },
      },
      {
        type: 'stream_event',
        event: { type: 'message_stop' },
      },
    ];

    let message = createMessage();
    for (const event of events) {
      message = applyStreamingEventToMessage(message, event);
    }

    expect(message.content).toEqual([
      { type: 'text', text: 'Response' },
    ]);
    expect(message.isStreaming).toBe(false);
  });
});
