'use client';

import { useState } from 'react';
import { AlertCircle, MessageSquare, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { isImageFile } from '@/components/chat-file-preview/file-type-utils';
import { FileCard } from '@/components/file-card';
import { Badge } from '@/components/ui/badge';
import { ImageTile } from '@/components/image-tile';
import { AttachmentHoverCard } from '@/components/chat-file-preview/attachment-hover-card';
import { encodePathSegments } from '@/components/chat-file-preview/file-preview-urls';
import {
  USER_UPLOAD_MOUNT_PREFIX,
  isUserUploadMountPath,
} from '@/lib/chat-attachment-refs';

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
  workspaceId?: string | null;
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
    <div
      className={cn(
        'group/card relative flex h-[88px] w-[184px] cursor-default select-none flex-col justify-between overflow-hidden rounded-lg border p-2 text-left',
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
            <MessageSquare
              aria-hidden
              className={cn(
                'h-3.5 w-3.5 text-muted-foreground',
                showRemove &&
                  'transition-opacity group-hover/card:opacity-0 group-focus-within/card:opacity-0',
              )}
            />
          )}
          {showRemove ? (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onRemove();
              }}
              aria-label={`Remove ${title}`}
              className="absolute inset-0 flex cursor-pointer items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover/card:opacity-100 group-focus-within/card:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </span>
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
  );
}

function AttachmentTile({
  attachment,
  workspaceId,
  onRemove,
}: {
  attachment: Attachment;
  workspaceId: string | null;
  onRemove: () => void;
}) {
  const [thumbFailed, setThumbFailed] = useState(false);
  const isTranscript = attachment.kind === 'transcript';
  const displayName = isTranscript
    ? attachment.sourceTitle || attachment.originalName || attachment.name
    : attachment.originalName || attachment.name;
  const uploadFilename =
    attachment.status === 'complete' && isUserUploadMountPath(attachment.path)
      ? attachment.path.slice(USER_UPLOAD_MOUNT_PREFIX.length)
      : null;
  const isImage = isImageFile(attachment.name, attachment.contentType);
  const serverImageUrl =
    isImage && workspaceId && uploadFilename
      ? `/api/workspaces/${workspaceId}/uploads/${encodePathSegments(uploadFilename)}`
      : null;
  const tileImageUrl = attachment.previewUrl ?? serverImageUrl;

  const tile = isTranscript ? (
    <TranscriptAttachmentCard attachment={attachment} onRemove={onRemove} />
  ) : isImage && tileImageUrl && attachment.status === 'complete' && !thumbFailed ? (
    <ImageTile
      imageUrl={tileImageUrl}
      displayName={displayName}
      onRemove={onRemove}
      onError={() => setThumbFailed(true)}
    />
  ) : (
    <FileCard
      filename={attachment.name}
      fileSize={attachment.size}
      contentType={attachment.contentType}
      uploadStatus={attachment.status}
      uploadProgress={attachment.progress}
      uploadError={attachment.error}
      onRemove={onRemove}
    />
  );

  return (
    <AttachmentHoverCard
      workspaceId={workspaceId}
      uploadFilename={uploadFilename}
      displayName={displayName}
      filename={attachment.name}
      size={attachment.size}
      contentType={attachment.contentType}
      imageUrl={attachment.previewUrl ?? undefined}
      footer={
        attachment.sourceTitle ? <>From &ldquo;{attachment.sourceTitle}&rdquo;</> : undefined
      }
      side="top"
      disabled={attachment.status !== 'complete'}
    >
      {tile}
    </AttachmentHoverCard>
  );
}

export function AttachmentList({
  attachments,
  onRemove,
  workspaceId = null,
  className,
}: AttachmentListProps) {
  if (attachments.length === 0) return null;

  return (
    <div className={cn('flex flex-wrap gap-2 px-3 pb-2', className)}>
      {attachments.map((attachment) => (
        <AttachmentTile
          key={attachment.id}
          attachment={attachment}
          workspaceId={workspaceId}
          onRemove={() => onRemove(attachment.id)}
        />
      ))}
    </div>
  );
}
