import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AttachmentList, type Attachment } from '@/components/attachment-list';

describe('AttachmentList', () => {
  it('renders transcript attachments as chat tiles and removes them', async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    const attachments: Attachment[] = [
      {
        id: 'transcript-1',
        name: 'planning-chat-transcript.md',
        path: 'uploads/planning-chat-transcript.md',
        size: 1024,
        contentType: 'text/markdown',
        originalName: 'planning-chat-transcript.md',
        status: 'complete',
        kind: 'transcript',
        sourceThreadId: 'thread-source',
        sourceTitle: 'Planning chat',
        snippet: 'Plan the rollout',
      },
    ];

    render(<AttachmentList attachments={attachments} onRemove={onRemove} />);

    expect(screen.getByText('chat')).toBeInTheDocument();
    expect(screen.getByText('Planning chat')).toBeInTheDocument();
    expect(screen.getByText('Plan the rollout')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remove Planning chat' }));

    expect(onRemove).toHaveBeenCalledWith('transcript-1');
  });
});
