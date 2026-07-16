import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AttachmentList, type Attachment } from '@/components/attachment-list';

describe('AttachmentList', () => {
  it('renders transcript attachments as chat tiles and removes them', async () => {
    const user = userEvent.setup({ skipHover: true });
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

    render(<AttachmentList attachments={attachments} onRemove={onRemove} workspaceId="ws_1" />);

    expect(screen.getByText('chat')).toBeInTheDocument();
    expect(screen.getByText('Planning chat')).toBeInTheDocument();
    expect(screen.getByText('Plan the rollout')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remove Planning chat' }));

    expect(onRemove).toHaveBeenCalledWith('transcript-1');
  });

  it('renders file attachments and removes them from the icon slot', async () => {
    const user = userEvent.setup({ skipHover: true });
    const onRemove = vi.fn();
    const attachments: Attachment[] = [
      {
        id: 'file-1',
        name: 'data.csv',
        path: 'uploads/data-123-ab.csv',
        size: 2048,
        contentType: 'text/csv',
        status: 'complete',
      },
    ];

    render(<AttachmentList attachments={attachments} onRemove={onRemove} workspaceId="ws_1" />);

    expect(screen.getByText('data.csv')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remove data.csv' }));

    expect(onRemove).toHaveBeenCalledWith('file-1');
  });

  it('renders image attachments with blob thumbnails and remove badges', async () => {
    const user = userEvent.setup({ skipHover: true });
    const onRemove = vi.fn();
    const attachments: Attachment[] = [
      {
        id: 'image-1',
        name: 'photo.png',
        path: 'uploads/photo.png',
        contentType: 'image/png',
        status: 'complete',
        previewUrl: 'blob:http://localhost/photo-preview',
      },
    ];

    render(<AttachmentList attachments={attachments} onRemove={onRemove} workspaceId="ws_1" />);

    expect(screen.getByRole('img', { name: 'photo.png' })).toHaveAttribute(
      'src',
      'blob:http://localhost/photo-preview',
    );

    await user.click(screen.getByRole('button', { name: 'Remove photo.png' }));

    expect(onRemove).toHaveBeenCalledWith('image-1');
  });

  it('renders group-added images from the uploads endpoint when no blob preview exists', () => {
    const onRemove = vi.fn();
    const attachments: Attachment[] = [
      {
        id: 'image-2',
        name: 'photo.png',
        path: 'uploads/stored photo.png',
        contentType: 'image/png',
        originalName: 'photo.png',
        status: 'complete',
      },
    ];

    render(<AttachmentList attachments={attachments} onRemove={onRemove} workspaceId="ws_1" />);

    const image = screen.getByRole('img', { name: 'photo.png' });
    expect(image.getAttribute('src')).toContain('/api/workspaces/ws_1/uploads/');
    expect(image.getAttribute('src')).toContain('stored%20photo.png');
  });

  it('does not render remove buttons for uploading attachments', () => {
    const onRemove = vi.fn();
    const attachments: Attachment[] = [
      {
        id: 'upload-1',
        name: 'upload.txt',
        path: 'uploads/upload.txt',
        contentType: 'text/plain',
        status: 'uploading',
        progress: 42,
      },
    ];

    render(<AttachmentList attachments={attachments} onRemove={onRemove} workspaceId="ws_1" />);

    expect(screen.getByText('upload.txt')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove upload.txt' })).not.toBeInTheDocument();
  });

  it('renders tiles and remove buttons when workspaceId is unavailable', async () => {
    const user = userEvent.setup({ skipHover: true });
    const onRemove = vi.fn();
    const attachments: Attachment[] = [
      {
        id: 'file-2',
        name: 'notes.md',
        path: 'uploads/notes.md',
        contentType: 'text/markdown',
        status: 'complete',
      },
    ];

    render(<AttachmentList attachments={attachments} onRemove={onRemove} workspaceId={null} />);

    expect(screen.getByText('notes.md')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remove notes.md' }));

    expect(onRemove).toHaveBeenCalledWith('file-2');
  });
});
