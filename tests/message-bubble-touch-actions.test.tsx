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
  ToolCall: ({ isStreaming }: { isStreaming?: boolean }) => (
    <div data-testid="tool-call" data-streaming={isStreaming ? 'true' : 'false'} />
  ),
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

describe('MessageBubble touch action classes', () => {
  const assistantMessage: Message = {
    id: 'assistant-message',
    thread_id: 'thread-1',
    role: 'assistant',
    content: 'Assistant response',
    created_at: Date.now(),
    isStreaming: false,
  };

  it('keeps assistant actions visible and comfortably sized on coarse pointers', () => {
    render(
      <div className="group">
        <MessageBubble
          message={assistantMessage}
          onCopy={vi.fn()}
          copiedId={null}
          onFork={vi.fn()}
        />
      </div>
    );

    const actionRow = screen.getByLabelText('Message actions');
    expect(actionRow).toHaveClass('pointer-coarse:opacity-100');
    expect(actionRow).toHaveClass('pointer-coarse:gap-1');

    const actionButtons = screen.getAllByRole('button');
    expect(actionButtons).toHaveLength(2);
    actionButtons.forEach(button => {
      expect(button).toHaveClass('pointer-coarse:size-9');
      expect(button).toHaveClass("pointer-coarse:[&_svg:not([class*='size-'])]:size-4");
    });
  });
});
