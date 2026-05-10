/**
 * React tests for Chat component streaming functionality
 *
 * Run with: npx vitest tests/Chat.test.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { useState } from 'react';
import { isFileDrag } from '@/lib/file-drag';

// Mock the streaming state logic extracted from Chat.tsx
interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: string;
  tool_use_id?: string;
  thinking?: string;
}

interface SDKEvent {
  type: string;
  subtype?: string;
  message?: {
    content: ContentBlock[];
    stop_reason?: string | null;
  };
  result?: string;
}

interface StreamingState {
  content: ContentBlock[];
  isStreaming: boolean;
}

// This is the CORRECT streaming logic - replace, don't append
function processSDKEventCorrect(
  prev: StreamingState,
  sdkEvent: SDKEvent
): StreamingState {
  if (sdkEvent.type === 'system' && sdkEvent.subtype === 'init') {
    return { content: [], isStreaming: true };
  } else if (sdkEvent.type === 'assistant' && sdkEvent.message?.content) {
    // REPLACE content - partial messages contain cumulative content
    return {
      ...prev,
      content: sdkEvent.message.content,
      isStreaming: !sdkEvent.message.stop_reason,
    };
  } else if (sdkEvent.type === 'user' && sdkEvent.message?.content) {
    // User events (tool_result) should be appended after assistant content
    return {
      ...prev,
      content: [...prev.content, ...sdkEvent.message.content],
    };
  } else if (sdkEvent.type === 'result') {
    return { content: [], isStreaming: false };
  }
  return prev;
}

// This is the BUGGY logic currently in Chat.tsx - appending
function processSDKEventBuggy(
  prev: StreamingState,
  sdkEvent: SDKEvent
): StreamingState {
  if (sdkEvent.type === 'system' && sdkEvent.subtype === 'init') {
    return { content: [], isStreaming: true };
  } else if (sdkEvent.type === 'assistant' && sdkEvent.message?.content) {
    // BUG: Appending content instead of replacing
    return {
      ...prev,
      content: [...prev.content, ...sdkEvent.message.content],
      isStreaming: !sdkEvent.message.stop_reason,
    };
  } else if (sdkEvent.type === 'user' && sdkEvent.message?.content) {
    return {
      ...prev,
      content: [...prev.content, ...sdkEvent.message.content],
    };
  } else if (sdkEvent.type === 'result') {
    return { content: [], isStreaming: false };
  }
  return prev;
}

describe('Streaming State Logic - Partial Messages', () => {
  // Simulate partial message events as they come from SDK with includePartialMessages: true
  const partialMessageSequence: SDKEvent[] = [
    { type: 'system', subtype: 'init' },
    // First partial - "Hello"
    {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'Hello' }],
        stop_reason: null,
      },
    },
    // Second partial - "Hello world" (cumulative, not delta)
    {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'Hello world' }],
        stop_reason: null,
      },
    },
    // Third partial - "Hello world!" (cumulative)
    {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'Hello world!' }],
        stop_reason: 'end_turn',
      },
    },
  ];

  it('CORRECT: should replace content on each partial message (not append)', () => {
    let state: StreamingState = { content: [], isStreaming: false };

    for (const event of partialMessageSequence) {
      state = processSDKEventCorrect(state, event);
    }

    // Should have exactly 1 text block with final content
    expect(state.content).toHaveLength(1);
    expect(state.content[0].text).toBe('Hello world!');
    expect(state.isStreaming).toBe(false);
  });

  it('BUGGY: appending creates duplicate content blocks', () => {
    let state: StreamingState = { content: [], isStreaming: false };

    for (const event of partialMessageSequence) {
      state = processSDKEventBuggy(state, event);
    }

    // Bug: appending creates 3 text blocks instead of 1
    expect(state.content).toHaveLength(3);
    expect(state.content[0].text).toBe('Hello');
    expect(state.content[1].text).toBe('Hello world');
    expect(state.content[2].text).toBe('Hello world!');
  });

  it('should show incremental text updates during streaming', () => {
    let state: StreamingState = { content: [], isStreaming: false };

    // After init
    state = processSDKEventCorrect(state, partialMessageSequence[0]);
    expect(state.isStreaming).toBe(true);
    expect(state.content).toHaveLength(0);

    // After first partial
    state = processSDKEventCorrect(state, partialMessageSequence[1]);
    expect(state.isStreaming).toBe(true);
    expect(state.content).toHaveLength(1);
    expect(state.content[0].text).toBe('Hello');

    // After second partial - text grew
    state = processSDKEventCorrect(state, partialMessageSequence[2]);
    expect(state.isStreaming).toBe(true);
    expect(state.content).toHaveLength(1);
    expect(state.content[0].text).toBe('Hello world');

    // After final partial - streaming complete
    state = processSDKEventCorrect(state, partialMessageSequence[3]);
    expect(state.isStreaming).toBe(false);
    expect(state.content).toHaveLength(1);
    expect(state.content[0].text).toBe('Hello world!');
  });
});

describe('Chat file drag detection', () => {
  function dataTransfer(
    types: string[],
    items: Array<{ kind: string }> = [],
  ): DataTransfer {
    return { types, items } as unknown as DataTransfer;
  }

  it('ignores chat tab drags so the file upload overlay stays hidden', () => {
    expect(
      isFileDrag(dataTransfer(['application/x-camelai-thread-id'])),
    ).toBe(false);
  });

  it('accepts browser file drags by type or item kind', () => {
    expect(isFileDrag(dataTransfer(['Files']))).toBe(true);
    expect(isFileDrag(dataTransfer([], [{ kind: 'file' }]))).toBe(true);
  });
});

describe('Streaming State Logic - Tool Use Flow', () => {
  // Simulate a tool use flow with partial messages
  const toolUseSequence: SDKEvent[] = [
    { type: 'system', subtype: 'init' },
    // Partial text before tool
    {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'Let me check' }],
        stop_reason: null,
      },
    },
    // More text + tool_use
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Let me check the system.' },
          { type: 'tool_use', name: 'Bash', input: { command: 'uname -a' } },
        ],
        stop_reason: null,
      },
    },
    // Tool result comes from user event
    {
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'tool-123', content: 'Linux x86_64' },
        ],
      },
    },
    // Final response after tool
    {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'You are running Linux.' }],
        stop_reason: 'end_turn',
      },
    },
  ];

  it('should correctly handle tool use flow with partials', () => {
    let state: StreamingState = { content: [], isStreaming: false };

    // Process through tool_use
    for (let i = 0; i <= 2; i++) {
      state = processSDKEventCorrect(state, toolUseSequence[i]);
    }

    // Should have text + tool_use
    expect(state.content).toHaveLength(2);
    expect(state.content[0].type).toBe('text');
    expect(state.content[0].text).toBe('Let me check the system.');
    expect(state.content[1].type).toBe('tool_use');
    expect(state.content[1].name).toBe('Bash');

    // Process tool_result (user event - should append)
    state = processSDKEventCorrect(state, toolUseSequence[3]);
    expect(state.content).toHaveLength(3);
    expect(state.content[2].type).toBe('tool_result');
    expect(state.content[2].content).toBe('Linux x86_64');

    // Process final response (replaces, but after tool_result is saved to messages)
    state = processSDKEventCorrect(state, toolUseSequence[4]);
    expect(state.content).toHaveLength(1);
    expect(state.content[0].text).toBe('You are running Linux.');
    expect(state.isStreaming).toBe(false);
  });
});

// Test component that uses the streaming logic
function StreamingDisplay({ events }: { events: SDKEvent[] }) {
  const [state, setState] = useState<StreamingState>({ content: [], isStreaming: false });
  const [eventIndex, setEventIndex] = useState(0);

  // Process next event
  const processNext = () => {
    if (eventIndex < events.length) {
      setState(prev => processSDKEventCorrect(prev, events[eventIndex]));
      setEventIndex(i => i + 1);
    }
  };

  return (
    <div>
      <button onClick={processNext} data-testid="next-event">
        Next Event
      </button>
      <div data-testid="streaming-indicator">
        {state.isStreaming ? 'Streaming...' : 'Idle'}
      </div>
      <div data-testid="content-count">{state.content.length}</div>
      {state.content.map((block, i) => (
        <div key={i} data-testid={`block-${i}`}>
          {block.type === 'text' && <span data-testid={`text-${i}`}>{block.text}</span>}
          {block.type === 'tool_use' && <span data-testid={`tool-${i}`}>{block.name}</span>}
          {block.type === 'tool_result' && <span data-testid={`result-${i}`}>{block.content}</span>}
        </div>
      ))}
    </div>
  );
}

describe('StreamingDisplay Component', () => {
  const events: SDKEvent[] = [
    { type: 'system', subtype: 'init' },
    {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'H' }], stop_reason: null },
    },
    {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'He' }], stop_reason: null },
    },
    {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Hel' }], stop_reason: null },
    },
    {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Hell' }], stop_reason: null },
    },
    {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Hello' }], stop_reason: 'end_turn' },
    },
  ];

  it('should render streaming text incrementally', async () => {
    render(<StreamingDisplay events={events} />);

    // Initial state
    expect(screen.getByTestId('streaming-indicator')).toHaveTextContent('Idle');
    expect(screen.getByTestId('content-count')).toHaveTextContent('0');

    // Process init event
    await act(async () => {
      screen.getByTestId('next-event').click();
    });
    expect(screen.getByTestId('streaming-indicator')).toHaveTextContent('Streaming...');

    // Process partial events
    await act(async () => {
      screen.getByTestId('next-event').click();
    });
    expect(screen.getByTestId('content-count')).toHaveTextContent('1');
    expect(screen.getByTestId('text-0')).toHaveTextContent('H');

    await act(async () => {
      screen.getByTestId('next-event').click();
    });
    expect(screen.getByTestId('text-0')).toHaveTextContent('He');

    await act(async () => {
      screen.getByTestId('next-event').click();
    });
    expect(screen.getByTestId('text-0')).toHaveTextContent('Hel');

    await act(async () => {
      screen.getByTestId('next-event').click();
    });
    expect(screen.getByTestId('text-0')).toHaveTextContent('Hell');

    await act(async () => {
      screen.getByTestId('next-event').click();
    });
    expect(screen.getByTestId('text-0')).toHaveTextContent('Hello');
    expect(screen.getByTestId('streaming-indicator')).toHaveTextContent('Idle');

    // Should still only have 1 content block
    expect(screen.getByTestId('content-count')).toHaveTextContent('1');
  });
});
