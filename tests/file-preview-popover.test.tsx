import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FilePreviewPopover } from '@/components/chat-file-preview/file-preview-popover';

describe('FilePreviewPopover', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

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

  it('forwards text preview URLs into the preview content', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        text: 'hello from text preview',
        truncated: false,
        totalLines: 1,
        maxLines: 1000,
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <FilePreviewPopover
        open
        onOpenChange={() => {}}
        filename="notes.txt"
        previewUrl="/files/notes.txt"
        textPreviewUrl="/api/workspaces/ws-1/file-preview/text?source=workspace&path=notes.txt&mode=initial&maxLines=1000"
        fullTextPreviewUrl="/api/workspaces/ws-1/file-preview/text?source=workspace&path=notes.txt&mode=full"
        contentType="text/plain"
      />
    );

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/workspaces/ws-1/file-preview/text?source=workspace&path=notes.txt&mode=initial&maxLines=1000',
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
    });
  });
});
