import { render, screen, within } from '@testing-library/react';
import type { ComponentProps, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MessageBubble } from '@/components/message-bubble';
import type { Message } from '@/types';

vi.mock('@/hooks/use-auth-data', () => ({
  useAuthData: () => ({ currentWorkspace: { id: 'ws-1' } }),
}));

vi.mock('@/components/markdown-renderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => (
    <div data-testid="markdown">{content}</div>
  ),
}));

vi.mock('@/components/tool-call', () => ({
  ThinkingBlock: () => null,
  ToolCall: () => null,
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
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock('@/components/chat/channel-logo', () => ({
  ChannelLogo: ({ channel, tooltip }: { channel: string; tooltip: string }) => (
    <span role="img" aria-label={tooltip} data-channel={channel} />
  ),
}));

function userMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'user-message',
    thread_id: 'thread-1',
    role: 'user',
    content: 'Hello',
    created_at: Date.UTC(2026, 6, 13, 3, 34),
    ...overrides,
  };
}

function renderBubble(message: Message) {
  return render(
    <div className="group">
      <MessageBubble
        message={message}
        messageTimeZone="America/Los_Angeles"
        onCopy={vi.fn()}
        copiedId={null}
      />
    </div>,
  );
}

describe('MessageBubble author stamp', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 6, 15, 5));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the exact compact author and older-date timestamp', () => {
    renderBubble(userMessage({ authorDisplayName: 'Illiana Reed' }));

    const actions = screen.getByLabelText('Message actions');
    expect(within(actions).getByText('Illiana Reed Jul 12, 8:34 PM')).toBeInTheDocument();
    expect(actions).not.toHaveTextContent('Sent by');
  });

  it('uses time-only formatting for a same-day message', () => {
    renderBubble(userMessage({
      authorDisplayName: 'Illiana Reed',
      created_at: Date.UTC(2026, 6, 15, 3, 34),
    }));

    expect(
      within(screen.getByLabelText('Message actions')).getByText(
        'Illiana Reed 8:34 PM',
      ),
    ).toBeInTheDocument();
  });

  it('cleans a legacy prefix and uses it when metadata is absent', () => {
    renderBubble(userMessage({
      content: '[web message from Legacy User (legacy@example.com)]: Hello',
    }));

    expect(screen.getByTestId('markdown')).toHaveTextContent('Hello');
    expect(screen.getByTestId('markdown')).not.toHaveTextContent('web message');
    expect(screen.getByLabelText('Message actions')).toHaveTextContent(
      'Legacy User Jul 12, 8:34 PM',
    );
  });

  it('prefers structured author/source metadata and keeps the channel logo fixed outside the faded subgroup', () => {
    renderBubble(userMessage({
      content: '[email message from Legacy User]: Hello',
      authorDisplayName: 'Illiana Reed',
      messageSource: 'slack',
    }));

    const actions = screen.getByLabelText('Message actions');
    expect(actions).toHaveTextContent('Illiana Reed Jul 12, 8:34 PM');
    expect(actions).not.toHaveTextContent('Legacy User');
    const logo = screen.getByRole('img', { name: 'Sent via Slack' });
    expect(logo).toHaveAttribute('data-channel', 'slack');
    expect(logo.parentElement).toBe(actions);
    expect(logo.previousElementSibling).toHaveClass('transition-opacity');
  });

  it('falls back to timestamp-only, author-only, or no stamp without invented copy', () => {
    const { rerender } = renderBubble(userMessage());
    let actions = screen.getByLabelText('Message actions');
    expect(actions).toHaveTextContent('Jul 12, 8:34 PM');
    expect(actions).not.toHaveTextContent(/Unknown|web|Sent by/);

    rerender(
      <div className="group">
        <MessageBubble
          message={userMessage({ authorDisplayName: 'Illiana Reed', created_at: 0 })}
          messageTimeZone="America/Los_Angeles"
          onCopy={vi.fn()}
          copiedId={null}
        />
      </div>,
    );
    actions = screen.getByLabelText('Message actions');
    expect(actions).toHaveTextContent('Illiana Reed');

    rerender(
      <div className="group">
        <MessageBubble
          message={userMessage({ created_at: 0 })}
          messageTimeZone="America/Los_Angeles"
          onCopy={vi.fn()}
          copiedId={null}
        />
      </div>,
    );
    actions = screen.getByLabelText('Message actions');
    expect(actions).not.toHaveTextContent(/Illiana|Unknown|web|Sent by|\bat\b/);
  });
});
