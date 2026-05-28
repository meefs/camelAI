import { render, screen } from '@testing-library/react';
import type { ComponentProps, ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { MessageBubble } from '@/components/message-bubble';
import type { Message } from '@/types';

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

vi.mock('@/components/tool-call', () => ({
  ThinkingBlock: ({ thinking }: { thinking: string }) => <div>{thinking}</div>,
  ToolCall: () => <div data-testid="tool-call" />,
}));

vi.mock('@/components/tool-call/teammate-message', () => ({
  TeammateMessage: () => null,
}));

vi.mock('@/components/tool-call/task-notification', () => ({
  TaskNotification: () => null,
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

describe('MessageBubble user stop rendering', () => {
  it('renders tagged Pi stop messages as muted status text without actions', () => {
    const message: Message = {
      id: 'assistant-stop',
      thread_id: 'thread-1',
      role: 'assistant',
      content: [{ type: 'text', text: 'Stopped by user', itemKind: 'userStop' }],
      created_at: Date.now(),
      isStreaming: false,
    };

    render(
      <MessageBubble
        message={message}
        onCopy={vi.fn()}
        copiedId={null}
        onFork={vi.fn()}
      />,
    );

    expect(screen.getByText('Stopped by user')).toHaveClass('italic');
    expect(screen.queryByLabelText('Message actions')).toBeNull();
  });

  it('keeps literal assistant text as a normal assistant message', () => {
    const message: Message = {
      id: 'assistant-literal',
      thread_id: 'thread-1',
      role: 'assistant',
      content: [{ type: 'text', text: 'Stopped by user' }],
      created_at: Date.now(),
      isStreaming: false,
    };

    render(
      <div className="group">
        <MessageBubble
          message={message}
          onCopy={vi.fn()}
          copiedId={null}
          onFork={vi.fn()}
        />
      </div>,
    );

    expect(screen.getByTestId('markdown')).toHaveTextContent('Stopped by user');
    expect(screen.getByLabelText('Message actions')).toBeInTheDocument();
  });
});
