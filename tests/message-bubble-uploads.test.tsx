import { fireEvent, render, screen } from '@testing-library/react';
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
  MarkdownRenderer: ({ content }: { content: string }) => (
    <div data-testid="markdown">{content}</div>
  ),
}));

vi.mock('@/components/chat-file-preview', () => ({
  FilePreviewChip: ({ filename }: { filename: string }) => (
    <div data-testid="file-preview-chip">{filename}</div>
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

function userMessage(content: string | ContentBlock[]): Message {
  return {
    id: 'user-message',
    thread_id: 'thread-1',
    role: 'user',
    content,
    created_at: 1710000000000,
  };
}

describe('MessageBubble upload references', () => {
  it('keeps string user upload markers hidden and renders the attachment chip', () => {
    render(
      <MessageBubble
        message={userMessage(
          'can you see this?\n\n(user uploaded file to uploads/report-1710000000-abcd.csv)',
        )}
        onCopy={vi.fn()}
        copiedId={null}
      />,
    );

    expect(screen.queryByText(/user uploaded file/)).toBeNull();
    expect(screen.getByText('can you see this?')).toBeInTheDocument();
    expect(screen.getByTestId('file-preview-chip')).toHaveTextContent('report.csv');
  });

  it('hides upload markers from reconciled ContentBlock user messages and renders the attachment chip', () => {
    render(
      <MessageBubble
        message={userMessage([
          {
            type: 'text',
            text: 'can you see this?\n\n(user uploaded file to uploads/report-1710000000-abcd.csv)',
          },
        ])}
        onCopy={vi.fn()}
        copiedId={null}
      />,
    );

    expect(screen.queryByText(/user uploaded file/)).toBeNull();
    expect(screen.getByText('can you see this?')).toBeInTheDocument();
    expect(screen.getByTestId('file-preview-chip')).toHaveTextContent('report.csv');
  });

  it('renders file-only ContentBlock user messages as attachment chips without visible markers', () => {
    render(
      <MessageBubble
        message={userMessage([
          {
            type: 'text',
            text: '(user uploaded file to uploads/data-1710000000-abcd.json)',
          },
        ])}
        onCopy={vi.fn()}
        copiedId={null}
      />,
    );

    expect(screen.queryByText(/user uploaded file/)).toBeNull();
    expect(screen.getAllByTestId('file-preview-chip')).toHaveLength(1);
    expect(screen.getByTestId('file-preview-chip')).toHaveTextContent('data.json');
  });

  it('copies cleaned ContentBlock user text without upload markers', () => {
    const onCopy = vi.fn();
    render(
      <MessageBubble
        message={userMessage([
          {
            type: 'text',
            text: 'can you see this?\n\n(user uploaded file to uploads/report-1710000000-abcd.csv)',
          },
        ])}
        onCopy={onCopy}
        copiedId={null}
      />,
    );

    fireEvent.click(screen.getByRole('button'));

    expect(onCopy).toHaveBeenCalledWith('user-message', 'can you see this?');
  });
});
