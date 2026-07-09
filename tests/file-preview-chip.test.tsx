import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChatPreviewProvider } from '@/components/chat-preview/preview-context';
import { FilePreviewChip } from '@/components/chat-file-preview/file-preview-chip';

describe('FilePreviewChip', () => {
  it('renders image uploads with clickable card hover affordance', () => {
    render(
      <ChatPreviewProvider
        value={{
          openPreviewTarget: vi.fn(),
          clearPreviewTarget: vi.fn(),
          workspaceId: 'ws-1',
        }}
      >
        <FilePreviewChip
          filename="photo.png"
          previewUrl="/api/workspaces/ws-1/uploads/photo.png"
          previewTarget={{
            kind: 'file',
            source: 'upload',
            workspaceId: 'ws-1',
            path: 'photo.png',
            filename: 'photo.png',
          }}
        />
      </ChatPreviewProvider>,
    );

    const button = screen.getByRole('button', {
      name: 'Open preview for photo.png',
    });

    expect(button).toHaveClass('cursor-pointer');
    expect(button).toHaveClass('border');
    expect(button).toHaveClass('border-border');
    expect(button).toHaveClass('hover:border-ring');
    expect(button).toHaveClass('hover:shadow-md');
    expect(button).toHaveClass('focus-visible:ring-2');
    expect(screen.getByRole('img', { name: 'photo.png' })).toHaveAttribute(
      'src',
      '/api/workspaces/ws-1/uploads/photo.png',
    );
  });
});
