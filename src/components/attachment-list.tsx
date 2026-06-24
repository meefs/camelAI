'use client';

import { AlertCircle, MessageSquare, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { isImageFile } from '@/components/chat-file-preview/file-type-utils';
import { FileCard } from '@/components/file-card';
import { Badge } from '@/components/ui/badge';

export interface Attachment {
  id: string;
  name: string;
  path: string;
  size?: number;
  contentType?: string;
  originalName?: string;
  progress?: number;
  status: 'uploading' | 'complete' | 'error';
  error?: string;
  /** Client-side blob URL for image preview in the input field */
  previewUrl?: string;
  kind?: 'transcript';
  sourceThreadId?: string;
  sourceTitle?: string;
  snippet?: string;
}

interface AttachmentListProps {
  attachments: Attachment[];
  onRemove: (id: string) => void;
  className?: string;
}

function TranscriptAttachmentCard({
  attachment,
  onRemove,
}: {
  attachment: Attachment;
  onRemove: () => void;
}) {
  const isUploading = attachment.status === 'uploading';
  const isError = attachment.status === 'error';
  const showRemove = !isUploading;
  const title = attachment.sourceTitle || attachment.originalName || attachment.name;
  const snippet = attachment.snippet || attachment.name;

  return (
    <div className="group/card relative outline-none" tabIndex={showRemove ? 0 : undefined}>
      <div
        className={cn(
          'relative flex h-[88px] w-[184px] flex-col justify-between overflow-hidden rounded-lg border p-2 text-left',
          'border-border bg-card',
          !isError && 'transition-all duration-200 ease-out hover:border-ring hover:shadow-md',
          isError && 'border-destructive/40 bg-destructive/5',
        )}
        aria-label={`${title}${isError ? ' (upload failed)' : ''}`}
      >
        <div className="flex items-start justify-between gap-2">
          <Badge variant="outline" className="h-5 px-1.5 text-[10px] uppercase leading-none">
            chat
          </Badge>
          {isError ? (
            <AlertCircle className="size-3.5 shrink-0 text-destructive" aria-hidden />
          ) : (
            <MessageSquare className="size-3.5 shrink-0 text-muted-foreground/50" aria-hidden />
          )}
        </div>

        <div className="min-w-0">
          <p
            className={cn(
              'truncate text-[11px] font-semibold leading-tight text-foreground',
              isUploading && 'opacity-60',
            )}
          >
            {title}
          </p>
          <p className="line-clamp-2 text-[10px] leading-tight text-muted-foreground">
            {isError ? (
              <span className="text-destructive">Error</span>
            ) : isUploading ? (
              `${Math.round(attachment.progress ?? 0)}%`
            ) : (
              snippet
            )}
          </p>
        </div>

        {isUploading && (
          <div className="absolute inset-x-0 bottom-0 h-0.5 bg-muted">
            <div
              className="h-full bg-foreground transition-all duration-300 ease-out"
              style={{ width: `${Math.max(0, Math.min(100, attachment.progress ?? 0))}%` }}
            />
          </div>
        )}
      </div>

      {showRemove && (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
          className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-foreground/80 text-background opacity-0 transition-opacity group-hover/card:opacity-100 group-focus-within/card:opacity-100"
          aria-label={`Remove ${title}`}
        >
          <X className="h-2.5 w-2.5" />
        </button>
      )}
    </div>
  );
}

export function AttachmentList({ attachments, onRemove, className }: AttachmentListProps) {
  if (attachments.length === 0) return null;

  return (
    <div className={cn('flex flex-wrap gap-2 px-3 pb-2', className)}>
      {attachments.map((attachment) => {
        if (attachment.kind === 'transcript') {
          return (
            <TranscriptAttachmentCard
              key={attachment.id}
              attachment={attachment}
              onRemove={() => onRemove(attachment.id)}
            />
          );
        }

        const isImage = isImageFile(attachment.name, attachment.contentType);

        // Image attachments that are fully uploaded get a square thumbnail preview
        if (isImage && attachment.previewUrl && attachment.status === 'complete') {
          return (
            <div key={attachment.id} className="group/card relative outline-none" tabIndex={0}>
              <div className="h-[88px] w-[88px] overflow-hidden rounded-lg border border-border bg-card transition-all duration-200 ease-out hover:border-ring hover:shadow-md">
                <img
                  src={attachment.previewUrl}
                  alt={attachment.name}
                  className="h-full w-full object-cover"
                />
              </div>
              <button
                type="button"
                onClick={() => onRemove(attachment.id)}
                className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-foreground/80 text-background opacity-0 transition-opacity group-hover/card:opacity-100 group-focus-within/card:opacity-100"
                aria-label={`Remove ${attachment.name}`}
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </div>
          );
        }

        // Non-image files (and images still uploading) use FileCard
        return (
          <FileCard
            key={attachment.id}
            filename={attachment.name}
            fileSize={attachment.size}
            contentType={attachment.contentType}
            uploadStatus={attachment.status}
            uploadProgress={attachment.progress}
            uploadError={attachment.error}
            onRemove={() => onRemove(attachment.id)}
          />
        );
      })}
    </div>
  );
}
