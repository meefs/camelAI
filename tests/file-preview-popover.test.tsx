import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FilePreviewPopover } from '@/components/chat-file-preview/file-preview-popover';

describe('FilePreviewPopover', () => {
  it('clears copied filename state when the preview target changes', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      writable: true,
      value: {
        writeText,
      },
    });

    const { rerender } = render(
      <FilePreviewPopover
        open
        onOpenChange={() => {}}
        filename="first.bin"
        previewUrl="/files/first.bin"
        contentType="application/octet-stream"
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /first\.bin/i }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('first.bin');
      expect(screen.getByText('Copied!')).toBeInTheDocument();
    });

    rerender(
      <FilePreviewPopover
        open
        onOpenChange={() => {}}
        filename="second.bin"
        previewUrl="/files/second.bin"
        contentType="application/octet-stream"
      />
    );

    expect(screen.queryByText('Copied!')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /second\.bin/i })).toBeInTheDocument();
  });
});
