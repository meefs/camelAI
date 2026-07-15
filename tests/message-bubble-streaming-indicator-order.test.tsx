import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type React from 'react';
import type { Message } from '@/types';
import { MessageBubble } from '@/components/message-bubble';

vi.mock('@/hooks/use-auth-data', () => ({
  useAuthData: () => ({
    currentWorkspace: { id: 'ws-1' },
  }),
}));

vi.mock('@/components/markdown-renderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => (
    <div data-testid="markdown">{content}</div>
  ),
}));

vi.mock('@/components/loading-dots', () => ({
  LoadingDots: () => <div data-testid="loading-dots" />,
}));

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: React.ComponentProps<'button'>) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

describe('MessageBubble streaming indicator order', () => {
  it('hides the action row while streaming and shows the completion time afterward', () => {
    const completedAt = Date.UTC(2024, 0, 2, 20, 5);
    const streamingMessage: Message = {
      id: 'assistant-timestamp',
      thread_id: 'thread-1',
      role: 'assistant',
      content: [{ type: 'text', text: 'Streaming response' }],
      created_at: 0,
      isStreaming: true,
    };
    const { rerender } = render(
      <div className="group">
        <MessageBubble
          message={streamingMessage}
          onCopy={vi.fn()}
          copiedId={null}
          messageTimeZone="America/Los_Angeles"
        />
      </div>
    );

    expect(screen.queryByLabelText('Message actions')).toBeNull();

    rerender(
      <div className="group">
        <MessageBubble
          message={{
            ...streamingMessage,
            created_at: completedAt,
            completedAtMs: completedAt,
            isStreaming: false,
          }}
          onCopy={vi.fn()}
          copiedId={null}
          messageTimeZone="UTC"
        />
      </div>
    );

    const expectedCompletionTime = new Date(completedAt).toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: 'UTC',
    });
    expect(screen.getByLabelText('Message actions')).toHaveTextContent(
      expectedCompletionTime,
    );
  });

  it('renders loading dots without an action row while streaming', () => {
    const message: Message = {
      id: 'assistant-1',
      thread_id: 'thread-1',
      role: 'assistant',
      content: [{ type: 'text', text: 'Streaming response' }],
      created_at: Date.now(),
      isStreaming: true,
    };

    render(
      <div className="group">
        <MessageBubble
          message={message}
          onCopy={vi.fn()}
          copiedId={null}
          showStreamingIndicator
        />
      </div>
    );

    expect(screen.queryByLabelText('Message actions')).toBeNull();
    expect(screen.getByTestId('loading-dots')).toBeTruthy();
  });

  it('still renders loading dots when streaming message has no visible content', () => {
    const message: Message = {
      id: 'assistant-2',
      thread_id: 'thread-1',
      role: 'assistant',
      content: [],
      created_at: Date.now(),
      isStreaming: true,
    };

    render(
      <MessageBubble
        message={message}
        onCopy={vi.fn()}
        copiedId={null}
        showStreamingIndicator
      />
    );

    expect(screen.queryByLabelText('Message actions')).toBeNull();
    expect(screen.getByTestId('loading-dots')).toBeTruthy();
  });
});
