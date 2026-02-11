'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';
import { isImageFile } from './file-type-utils';
import { FilePreviewPopover } from './file-preview-popover';
import type { PreviewTarget } from '@/types';
import { useChatPreviewContext } from '@/components/chat-preview/preview-context';
import { FileCard } from '@/components/file-card';

export interface FilePreviewChipProps {
  filename: string;
  previewUrl: string;
  contentType?: string;
  className?: string;
  previewTarget?: PreviewTarget;
  fileSize?: number;
}

export function FilePreviewChip({
  filename,
  previewUrl,
  contentType,
  className,
  previewTarget,
  fileSize,
}: FilePreviewChipProps) {
  const [imageError, setImageError] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const previewContext = useChatPreviewContext();
  const showImage = isImageFile(filename, contentType) && !imageError;
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
            'h-[88px] w-[88px] overflow-hidden rounded-lg transition-opacity hover:opacity-90',
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
      <FileCard
        filename={filename}
        fileSize={fileSize}
        contentType={contentType}
        onClick={handleOpen}
        className={className}
      />
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
