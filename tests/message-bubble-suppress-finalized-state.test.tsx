import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ComponentProps, ReactNode } from 'react';
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

describe('MessageBubble suppressFinalizedState', () => {
  function createAssistantToolMessage(): Message {
    return {
      id: 'assistant-tool-msg',
      thread_id: 'thread-1',
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: 'tool-1',
        name: 'Bash',
        input: { command: 'echo hello' },
      }],
      created_at: Date.now(),
      isStreaming: false,
    };
  }

  it('keeps tool calls in streaming state and hides assistant hover actions when suppression is enabled', () => {
    render(
      <div className="group">
        <MessageBubble
          message={createAssistantToolMessage()}
          onCopy={vi.fn()}
          copiedId={null}
          suppressFinalizedState
        />
      </div>
    );

    expect(screen.getByTestId('tool-call')).toHaveAttribute('data-streaming', 'true');
    expect(screen.queryByLabelText('Message actions')).not.toBeInTheDocument();
  });

  it('shows finalized assistant state when suppression is disabled', () => {
    render(
      <div className="group">
        <MessageBubble
          message={createAssistantToolMessage()}
          onCopy={vi.fn()}
          copiedId={null}
          suppressFinalizedState={false}
        />
      </div>
    );

    expect(screen.getByTestId('tool-call')).toHaveAttribute('data-streaming', 'false');
    expect(screen.getByLabelText('Message actions')).toBeInTheDocument();
  });
});
