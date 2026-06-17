'use client';

import { Loader2 } from 'lucide-react';
import { INITIAL_TEXT_PREVIEW_BYTE_LIMIT } from '@/lib/file-preview-limits';
import { formatBytes } from '@/lib/tool-activity-tool-utils';
import { cn } from '@/lib/utils';

type PreviewTruncationReason = 'lines' | 'bytes';

export interface PreviewTruncationFooterProps {
  shownLines: number;
  totalLines: number | null;
  truncatedBy?: PreviewTruncationReason;
  canLoadFull: boolean;
  status: 'idle' | 'loading' | 'error' | 'unavailable';
  onLoadFull: () => void;
  sizeBytes?: number;
  downloadUrl?: string;
  downloadFilename?: string;
  className?: string;
  hint?: string;
}

const linkClasses = cn(
  'cursor-pointer rounded-sm underline underline-offset-2 transition-colors',
  'hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
  'disabled:cursor-default disabled:no-underline disabled:opacity-70'
);

function formatPreviewByteLimit(bytes: number): string {
  if (bytes >= 1_000_000 && bytes % 1_000_000 === 0) {
    return `${bytes / 1_000_000} MB`;
  }
  if (bytes >= 1_000 && bytes % 1_000 === 0) {
    return `${bytes / 1_000} KB`;
  }
  return formatBytes(bytes);
}

function getStatusText({
  shownLines,
  totalLines,
  truncatedBy,
}: Pick<PreviewTruncationFooterProps, 'shownLines' | 'totalLines' | 'truncatedBy'>) {
  if (truncatedBy === 'bytes') {
    return `Showing first ${formatPreviewByteLimit(INITIAL_TEXT_PREVIEW_BYTE_LIMIT)} of this file`;
  }
  if (totalLines != null) {
    return `Showing first ${shownLines.toLocaleString()} of ${totalLines.toLocaleString()} lines`;
  }
  return `Showing first ${shownLines.toLocaleString()} lines`;
}

export function PreviewTruncationFooter({
  shownLines,
  totalLines,
  truncatedBy = 'lines',
  canLoadFull,
  status,
  onLoadFull,
  sizeBytes,
  downloadUrl,
  downloadFilename,
  className,
  hint,
}: PreviewTruncationFooterProps) {
  const statusText = getStatusText({ shownLines, totalLines, truncatedBy });

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-x-1.5 gap-y-1',
        'border-t border-border/60 px-3 py-2',
        'text-[11px] text-muted-foreground',
        className
      )}
    >
      <span>
        {statusText}.
        {hint ? ` ${hint}` : ''}
      </span>

      {canLoadFull ? (
        status === 'loading' ? (
          <button
            type="button"
            disabled
            className={cn(linkClasses, 'inline-flex items-center gap-1')}
          >
            <Loader2 className="size-3 animate-spin" />
            Loading all lines...
          </button>
        ) : status === 'error' ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="text-destructive" aria-live="polite">
              Couldn&apos;t load the full file.
            </span>
            <button type="button" onClick={onLoadFull} className={linkClasses}>
              Try again
            </button>
          </span>
        ) : status === 'unavailable' ? (
          <span className="inline-flex items-center gap-1.5">
            <span aria-live="polite">Too large to show in full.</span>
            {downloadUrl ? (
              <a
                href={downloadUrl}
                download={downloadFilename}
                className={linkClasses}
              >
                Download
              </a>
            ) : null}
          </span>
        ) : (
          <button type="button" onClick={onLoadFull} className={linkClasses}>
            Show all lines{sizeBytes != null ? ` (${formatBytes(sizeBytes)})` : ''}
          </button>
        )
      ) : null}
    </div>
  );
}
