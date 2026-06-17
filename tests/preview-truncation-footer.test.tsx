import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PreviewTruncationFooter } from '@/components/chat-file-preview/preview-truncation-footer';

describe('PreviewTruncationFooter', () => {
  it('renders known totals and calls the load-full handler', () => {
    const onLoadFull = vi.fn();
    render(
      <PreviewTruncationFooter
        shownLines={1000}
        totalLines={12430}
        canLoadFull
        status="idle"
        onLoadFull={onLoadFull}
        sizeBytes={2048}
      />
    );

    expect(screen.getByText('Showing first 1,000 of 12,430 lines.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Show all lines/ }));
    expect(onLoadFull).toHaveBeenCalledTimes(1);
  });

  it('renders unknown totals without an action when full loading is unavailable', () => {
    render(
      <PreviewTruncationFooter
        shownLines={1000}
        totalLines={null}
        canLoadFull={false}
        status="idle"
        onLoadFull={() => {}}
      />
    );

    expect(screen.getByText('Showing first 1,000 lines.')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders byte-oriented copy for byte-truncated previews', () => {
    render(
      <PreviewTruncationFooter
        shownLines={1000}
        totalLines={null}
        truncatedBy="bytes"
        canLoadFull={false}
        status="idle"
        onLoadFull={() => {}}
      />
    );

    expect(screen.getByText('Showing first 1 MB of this file.')).toBeInTheDocument();
    expect(screen.queryByText('Showing first 1,000 lines.')).not.toBeInTheDocument();
  });

  it('renders loading and error states', () => {
    const { rerender } = render(
      <PreviewTruncationFooter
        shownLines={1000}
        totalLines={1000}
        canLoadFull
        status="loading"
        onLoadFull={() => {}}
      />
    );

    expect(screen.getByRole('button', { name: /Loading/ })).toBeDisabled();

    rerender(
      <PreviewTruncationFooter
        shownLines={1000}
        totalLines={1000}
        canLoadFull
        status="error"
        onLoadFull={() => {}}
      />
    );

    expect(screen.getByText("Couldn't load the full file.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
  });

  it('renders unavailable state with a download link', () => {
    render(
      <PreviewTruncationFooter
        shownLines={1000}
        totalLines={null}
        canLoadFull
        status="unavailable"
        onLoadFull={() => {}}
        downloadUrl="/api/workspaces/ws_1/fs/content/large.txt"
        downloadFilename="large.txt"
      />
    );

    expect(screen.getByText('Too large to show in full.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Download' })).toHaveAttribute(
      'href',
      '/api/workspaces/ws_1/fs/content/large.txt'
    );
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });
});
