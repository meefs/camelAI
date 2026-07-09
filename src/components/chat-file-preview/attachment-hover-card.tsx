'use client';

import type { ReactNode } from 'react';
import { useRef, useState } from 'react';
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@/components/ui/hover-card';
import {
  AttachmentHoverPreview,
  getAttachmentHoverKind,
  type AttachmentPreviewState,
} from '@/components/chat-file-preview/attachment-hover-preview';
import {
  buildTextPreviewUrls,
  encodePathSegments,
} from '@/components/chat-file-preview/file-preview-urls';

interface AttachmentHoverCardProps {
  workspaceId: string | null;
  /** Stored filename under uploads/ used for preview fetches; null -> metadata-only. */
  uploadFilename: string | null;
  displayName: string;
  filename: string;
  size?: number;
  contentType?: string;
  /** Optional image override (composer blob URL). Defaults to the uploads URL. */
  imageUrl?: string | null;
  footer?: ReactNode;
  side?: 'top' | 'bottom';
  /** Render children with no hover card at all, for example uploading/error attachments. */
  disabled?: boolean;
  children: ReactNode;
}

export function AttachmentHoverCard({
  workspaceId,
  uploadFilename,
  displayName,
  filename,
  size,
  contentType,
  imageUrl,
  footer,
  side = 'bottom',
  disabled,
  children,
}: AttachmentHoverCardProps) {
  const [state, setState] = useState<AttachmentPreviewState>({ status: 'idle' });
  const fetchStartedRef = useRef(false);
  const kind =
    workspaceId && uploadFilename
      ? getAttachmentHoverKind(filename, contentType)
      : 'metadata';
  const resolvedImageUrl =
    imageUrl ?? (
      kind === 'image' && workspaceId && uploadFilename
        ? `/api/workspaces/${workspaceId}/uploads/${encodePathSegments(uploadFilename)}`
        : null
    );

  const handleOpenChange = (open: boolean) => {
    if (!open || fetchStartedRef.current || !workspaceId || !uploadFilename) return;
    if (kind !== 'table' && kind !== 'markdown' && kind !== 'text') return;

    fetchStartedRef.current = true;
    setState({ status: 'loading' });

    const { initialUrl } = buildTextPreviewUrls(
      { workspaceId, source: 'upload', path: uploadFilename },
      { maxLines: kind === 'table' ? 12 : 24 },
    );

    fetch(initialUrl)
      .then(async (response) => {
        if (!response.ok) {
          throw Object.assign(new Error('preview failed'), { status: response.status });
        }
        const data = (await response.json()) as { text: string; truncated: boolean };
        setState({
          status: 'ready',
          text: data.text,
          truncated: data.truncated,
        });
      })
      .catch((error) => {
        const status = (error as { status?: number })?.status;
        setState({
          status: 'error',
          message:
            status === 404 || status === 410
              ? 'This file is no longer available.'
              : status === 415
                ? 'No preview for this file type.'
                : 'Preview unavailable.',
        });
      });
  };

  if (disabled) {
    return <>{children}</>;
  }

  return (
    <HoverCard openDelay={200} closeDelay={100} onOpenChange={handleOpenChange}>
      <HoverCardTrigger asChild>
        <div className="w-fit">{children}</div>
      </HoverCardTrigger>
      <HoverCardContent
        side={side}
        align="start"
        collisionPadding={12}
        className="w-80 overflow-hidden p-0"
      >
        <AttachmentHoverPreview
          displayName={displayName}
          filename={filename}
          size={size}
          contentType={contentType}
          kind={kind}
          imageUrl={resolvedImageUrl}
          state={state}
          footer={footer}
        />
      </HoverCardContent>
    </HoverCard>
  );
}
