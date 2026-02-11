'use client';

import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { isImageFile } from '@/components/chat-file-preview/file-type-utils';
import { FileCard } from '@/components/file-card';

export interface Attachment {
  id: string;
  name: string;
  path: string;
  size: number;
  contentType?: string;
  originalName?: string;
  progress?: number;
  status: 'uploading' | 'complete' | 'error';
  error?: string;
  /** Client-side blob URL for image preview in the input field */
  previewUrl?: string;
}

interface AttachmentListProps {
  attachments: Attachment[];
  onRemove: (id: string) => void;
  className?: string;
}

export function AttachmentList({ attachments, onRemove, className }: AttachmentListProps) {
  if (attachments.length === 0) return null;

  return (
    <div className={cn('flex flex-wrap gap-2 px-3 pb-2', className)}>
      {attachments.map((attachment) => {
        const isImage = isImageFile(attachment.name, attachment.contentType);

        // Image attachments that are fully uploaded get a square thumbnail preview
        if (isImage && attachment.previewUrl && attachment.status === 'complete') {
          return (
            <div key={attachment.id} className="group/card relative outline-none" tabIndex={0}>
              <div className="h-[88px] w-[88px] overflow-hidden rounded-lg border border-border bg-muted/30">
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
