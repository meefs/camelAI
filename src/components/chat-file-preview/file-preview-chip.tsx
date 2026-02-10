'use client';

import { useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { getFileCategory, getFileIcon, isImageFile } from './file-type-utils';
import { FilePreviewPopover } from './file-preview-popover';
import type { PreviewTarget } from '@/types';
import { useChatPreviewContext } from '@/components/chat-preview/preview-context';

export interface FilePreviewChipProps {
  filename: string;
  previewUrl: string;
  contentType?: string;
  className?: string;
  previewTarget?: PreviewTarget;
}

export function FilePreviewChip({
  filename,
  previewUrl,
  contentType,
  className,
  previewTarget,
}: FilePreviewChipProps) {
  const [imageError, setImageError] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const previewContext = useChatPreviewContext();
  const category = useMemo(() => getFileCategory(filename, contentType), [filename, contentType]);
  const showImage = isImageFile(filename, contentType) && !imageError;
  const Icon = getFileIcon(category);
  const shouldUseChatPanel = Boolean(previewContext && previewTarget);

  const handleOpen = () => {
    if (previewContext && previewTarget) {
      previewContext.openPreviewTarget(previewTarget);
      return;
    }
    setPreviewOpen(true);
  };

  if (showImage) {
    return (
      <>
        <button
          type="button"
          onClick={handleOpen}
          className={cn(
            'h-[120px] w-[120px] overflow-hidden rounded-lg transition-opacity hover:opacity-90',
            className
          )}
          aria-label={`Open preview for ${filename}`}
        >
          <img
            src={previewUrl}
            alt={filename}
            loading="lazy"
            className="h-full w-full object-cover"
            onError={() => setImageError(true)}
          />
        </button>
        {!shouldUseChatPanel && (
          <FilePreviewPopover
            open={previewOpen}
            onOpenChange={setPreviewOpen}
            filename={filename}
            previewUrl={previewUrl}
            contentType={contentType}
          />
        )}
      </>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={handleOpen}
        className={cn(
          'flex w-[160px] flex-col gap-2 rounded-md border border-border bg-muted/50 p-2 text-left text-xs',
          'transition-colors hover:bg-muted/70',
          className
        )}
        aria-label={`Open preview for ${filename}`}
      >
        <div className="flex h-[80px] items-center justify-center overflow-hidden rounded-sm bg-muted/80">
          <Icon className="h-6 w-6 text-muted-foreground" />
        </div>
        <span className="truncate" title={filename}>
          {filename}
        </span>
      </button>
      {!shouldUseChatPanel && (
        <FilePreviewPopover
          open={previewOpen}
          onOpenChange={setPreviewOpen}
          filename={filename}
          previewUrl={previewUrl}
          contentType={contentType}
        />
      )}
    </>
  );
}
