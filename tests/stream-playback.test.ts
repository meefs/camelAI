import { describe, it, expect } from 'vitest';
import { applySdkEventToStreamingState } from '@/lib/streaming';
import type { ContentBlock } from '@/types';

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

    let state = { content: [] as ContentBlock[], isStreaming: false, blockOffset: 0 };
    for (const event of events) {
      state = applySdkEventToStreamingState(state, event);
    }

    expect(state.content).toEqual([
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

    let state = { content: [] as ContentBlock[], isStreaming: false, blockOffset: 0 };
    for (const event of events) {
      state = applySdkEventToStreamingState(state, event);
    }

    expect(state.content).toEqual([
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

    let state = { content: [] as ContentBlock[], isStreaming: false, blockOffset: 0 };
    for (const event of events) {
      state = applySdkEventToStreamingState(state, event);
    }

    expect(state.isStreaming).toBe(false);
    expect(state.content).toEqual([{ type: 'text', text: 'Done' }]);
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

    let state = { content: [] as ContentBlock[], isStreaming: false, blockOffset: 0 };
    for (const event of events) {
      state = applySdkEventToStreamingState(state, event);
    }

    expect(state.content).toEqual([
      { type: 'text', text: 'First message' },
      { type: 'text', text: 'Second message' },
    ]);
  });
});
