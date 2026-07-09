'use client';

import { X, AlertCircle, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
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
  /**
   * Renders a hover/focus X button in the icon slot.
   * Do not combine with onClick, which would nest a button inside a button.
   */
  onRemove?: () => void;
  /** Called when the card is clicked (e.g., to open a preview). */
  onClick?: () => void;
  /** Swap the category icon for a Plus on hover (cards that add on click). */
  showAddOnHover?: boolean;
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
  showAddOnHover,
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
    <CardElement
      {...(onClick ? { type: 'button' as const, onClick } : {})}
      className={cn(
        // Fixed square + layout
        'group/card relative flex h-[88px] w-[88px] flex-col justify-between overflow-hidden rounded-lg border p-2 text-left',
        // Default styling
        'border-border bg-card',
        // Hover (non-error)
        !isError &&
          'transition-all duration-200 ease-out hover:border-ring hover:shadow-md',
        // Error styling
        isError && 'border-destructive/40 bg-destructive/5',
        // Cursor: hand when the card itself is clickable, arrow otherwise
        onClick ? 'cursor-pointer' : 'cursor-default select-none',
        className,
      )}
      aria-label={`${filename}${isError ? ' (upload failed)' : ''}`}
    >
      {/* Top zone: extension badge + action slot */}
      <div className="flex items-start justify-between">
        <Badge variant="outline" className="h-5 px-1.5 text-[10px] uppercase leading-none">
          {ext}
        </Badge>
        <span className="relative flex h-5 w-5 shrink-0 items-center justify-center">
          {isError ? (
            <AlertCircle
              aria-hidden
              className={cn(
                'h-3.5 w-3.5 text-destructive',
                showRemove &&
                  'transition-opacity group-hover/card:opacity-0 group-focus-within/card:opacity-0',
              )}
            />
          ) : (
            <Icon
              aria-hidden
              className={cn(
                'h-3.5 w-3.5 text-muted-foreground',
                showAddOnHover && 'group-hover/card:hidden',
                showRemove &&
                  'transition-opacity group-hover/card:opacity-0 group-focus-within/card:opacity-0',
              )}
            />
          )}
          {showAddOnHover && !isError ? (
            <Plus
              aria-hidden
              className="absolute hidden h-3.5 w-3.5 text-muted-foreground group-hover/card:block"
            />
          ) : null}
          {showRemove ? (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onRemove?.();
              }}
              aria-label={`Remove ${filename}`}
              className="absolute inset-0 flex cursor-pointer items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover/card:opacity-100 group-focus-within/card:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </span>
      </div>

      {/* Bottom zone: filename + size/progress */}
      <div className="min-w-0">
        <p
          className={cn(
            'truncate text-[11px] font-semibold leading-tight text-foreground',
            isUploading && 'opacity-60',
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
  );
}
