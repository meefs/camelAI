'use client';

import { X, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  getFileExtension,
  getFileCategory,
  getFileIcon,
} from '@/components/chat-file-preview/file-type-utils';

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface FileCardProps {
  /** Display filename (used for extension extraction and display) */
  filename: string;
  /** File size in bytes — shown as human-readable (e.g., "14 KB") */
  fileSize?: number;
  /** Content type hint for category detection */
  contentType?: string;
  /** Upload progress 0-100. When present, card is in "uploading" state. */
  uploadProgress?: number;
  /** Upload status. Omit for read-only (in-chat) usage. */
  uploadStatus?: 'uploading' | 'complete' | 'error';
  /** Error message for failed uploads */
  uploadError?: string;
  /** Called when the remove button is clicked. Only rendered when provided. */
  onRemove?: () => void;
  /** Called when the card is clicked (e.g., to open a preview). */
  onClick?: () => void;
  className?: string;
}

export function FileCard({
  filename,
  fileSize,
  contentType,
  uploadProgress,
  uploadStatus,
  uploadError,
  onRemove,
  onClick,
  className,
}: FileCardProps) {
  const ext = getFileExtension(filename).toUpperCase() || 'FILE';
  const category = getFileCategory(filename, contentType);
  const Icon = getFileIcon(category);
  const isUploading = uploadStatus === 'uploading';
  const isError = uploadStatus === 'error';
  const showRemove = Boolean(onRemove) && !isUploading;

  const CardElement = onClick ? 'button' : 'div';

  return (
    <div className="group/card relative outline-none" tabIndex={showRemove ? 0 : undefined}>
      <CardElement
        {...(onClick ? { type: 'button' as const, onClick } : {})}
        className={cn(
          // Fixed square + layout
          'relative flex h-[88px] w-[88px] flex-col justify-between overflow-hidden rounded-lg border p-2 text-left',
          // Default styling
          'border-border bg-muted/30',
          // Hover (non-error)
          !isError &&
            'transition-colors duration-150 hover:border-border/80 hover:bg-muted/50',
          // Error styling
          isError && 'border-destructive/40 bg-destructive/5',
          // Clickable cursor
          onClick && 'cursor-pointer',
          className
        )}
        aria-label={`${filename}${isError ? ' (upload failed)' : ''}`}
      >
        {/* Top zone: extension badge + category icon */}
        <div className="flex items-start justify-between">
          <span className="rounded-sm bg-foreground/8 px-1.5 py-0.5 text-[10px] font-bold leading-none text-foreground">
            {ext}
          </span>
          {isError ? (
            <AlertCircle className="h-3.5 w-3.5 text-destructive" />
          ) : (
            <Icon className="h-3.5 w-3.5 text-muted-foreground/50" />
          )}
        </div>

        {/* Bottom zone: filename + size/progress */}
        <div className="min-w-0">
          <p
            className={cn(
              'truncate text-[11px] font-semibold leading-tight text-foreground',
              isUploading && 'opacity-60'
            )}
          >
            {filename}
          </p>
          <p className="text-[10px] leading-tight text-muted-foreground tabular-nums">
            {isError ? (
              <span className="text-destructive">Error</span>
            ) : isUploading ? (
              `${Math.round(uploadProgress ?? 0)}%`
            ) : fileSize != null ? (
              formatFileSize(fileSize)
            ) : null}
          </p>
        </div>

        {/* Progress bar (uploading only) */}
        {isUploading && (
          <div className="absolute inset-x-0 bottom-0 h-0.5 bg-muted">
            <div
              className="h-full bg-foreground transition-all duration-300 ease-out"
              style={{
                width: `${Math.max(0, Math.min(100, uploadProgress ?? 0))}%`,
              }}
            />
          </div>
        )}
      </CardElement>

      {/* Remove button (hover-only, input field context) */}
      {showRemove && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove?.();
          }}
          className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-foreground/80 text-background opacity-0 transition-opacity group-hover/card:opacity-100 group-focus-within/card:opacity-100"
          aria-label={`Remove ${filename}`}
        >
          <X className="h-2.5 w-2.5" />
        </button>
      )}
    </div>
  );
}
