import { render, screen } from '@testing-library/react';
import type { ComponentProps, ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { MessageBubble } from '@/components/message-bubble';
import type { ContentBlock, Message } from '@/types';

vi.mock('@/hooks/use-auth-data', () => ({
  useAuthData: () => ({
    currentWorkspace: { id: 'ws-1' },
  }),
}));

vi.mock('@/components/markdown-renderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>,
}));

vi.mock('@/components/tool-call', () => ({
  ThinkingBlock: ({
    thinking,
    isStreaming,
  }: {
    thinking: string;
    isStreaming?: boolean;
  }) => (
    <div
      data-testid="thinking-block"
      data-thinking={thinking}
      data-streaming={isStreaming ? 'true' : 'false'}
    />
  ),
  ToolCall: () => <div data-testid="tool-call" />,
}));

vi.mock('@/components/tool-call/teammate-message', () => ({
  TeammateMessage: () => <div data-testid="teammate-message" />,
}));

vi.mock('@/components/tool-call/task-notification', () => ({
  TaskNotification: () => <div data-testid="task-notification" />,
}));

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: ComponentProps<'button'>) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

function createAssistantMessage(content: ContentBlock[], isStreaming = true): Message {
  return {
    id: 'assistant-message',
    thread_id: 'thread-1',
    role: 'assistant',
    created_at: Date.now(),
    content,
    isStreaming,
  };
}

describe('MessageBubble thinking continuation', () => {
  it('marks a thinking block followed by text as inactive while the message streams', () => {
    render(
      <MessageBubble
        message={createAssistantMessage([
          { type: 'thinking', thinking: 'First thought' },
          { type: 'text', text: 'Done' },
        ])}
        onCopy={vi.fn()}
        copiedId={null}
      />,
    );

    expect(screen.getByTestId('thinking-block')).toHaveAttribute('data-streaming', 'false');
  });

  it('marks the final thinking block as streaming while the message streams', () => {
    render(
      <MessageBubble
        message={createAssistantMessage([
          { type: 'text', text: 'Starting' },
          { type: 'thinking', thinking: 'Still thinking' },
        ])}
        onCopy={vi.fn()}
        copiedId={null}
      />,
    );

    expect(screen.getByTestId('thinking-block')).toHaveAttribute('data-streaming', 'true');
  });

  it('marks a thinking block followed by a tool call as inactive while the message streams', () => {
    render(
      <MessageBubble
        message={createAssistantMessage([
          { type: 'thinking', thinking: 'Need to inspect files' },
          { type: 'tool_use', id: 'tool_1', name: 'Read', input: {} },
        ])}
        onCopy={vi.fn()}
        copiedId={null}
      />,
    );

    expect(screen.getByTestId('thinking-block')).toHaveAttribute('data-streaming', 'false');
  });

  it('groups thinking rows followed by tool calls in the same compact trace section', () => {
    render(
      <MessageBubble
        message={createAssistantMessage([
          { type: 'thinking', thinking: 'Need to inspect files' },
          { type: 'tool_use', id: 'tool_1', name: 'Read', input: {} },
        ])}
        onCopy={vi.fn()}
        copiedId={null}
      />,
    );

    expect(screen.getByTestId('thinking-block').closest('.space-y-1')).toBe(
      screen.getByTestId('tool-call').closest('.space-y-1'),
    );
  });

  it('marks thinking blocks in non-streaming messages as inactive', () => {
    render(
      <MessageBubble
        message={createAssistantMessage([
          { type: 'thinking', thinking: 'Completed thought' },
        ], false)}
        onCopy={vi.fn()}
        copiedId={null}
      />,
    );

    expect(screen.getByTestId('thinking-block')).toHaveAttribute('data-streaming', 'false');
  });
});
