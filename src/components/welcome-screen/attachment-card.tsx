'use client';

import { useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import type { GroupNewChatAttachmentCard } from '@/types';
import { FileCard } from '@/components/file-card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@/components/ui/hover-card';
import {
  buildTextPreviewUrls,
  encodePathSegments,
} from '@/components/chat-file-preview/file-preview-urls';
import { cn } from '@/lib/utils';
import {
  AttachmentHoverPreview,
  getAttachmentHoverKind,
  type AttachmentPreviewState,
} from './attachment-hover-preview';

function ImageTile({
  imageUrl,
  displayName,
  onClick,
  onError,
}: {
  imageUrl: string;
  displayName: string;
  onClick: () => void;
  onError: () => void;
}) {
  const [loaded, setLoaded] = useState(false);

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Add ${displayName} to chat`}
      className="group/thumb relative h-[88px] w-[88px] cursor-pointer overflow-hidden rounded-lg border border-border bg-muted/30 transition-all duration-200 ease-out hover:border-ring hover:shadow-md"
    >
      {!loaded ? <Skeleton className="absolute inset-0 rounded-none" /> : null}
      <img
        src={imageUrl}
        alt=""
        className={cn(
          'h-full w-full object-cover transition-opacity duration-150',
          loaded ? 'opacity-100' : 'opacity-0',
        )}
        onLoad={() => setLoaded(true)}
        onError={onError}
      />
      <span
        aria-hidden
        className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-background/80 opacity-0 shadow-sm transition-opacity group-hover/thumb:opacity-100 group-focus-visible/thumb:opacity-100"
      >
        <Plus className="h-3 w-3 text-foreground" />
      </span>
    </button>
  );
}

export function RecentAttachmentCard({
  card,
  workspaceId,
  onSelect,
}: {
  card: GroupNewChatAttachmentCard;
  workspaceId: string | null;
  onSelect: (card: GroupNewChatAttachmentCard) => void;
}) {
  const displayName = card.originalName || card.filename;
  const kind = workspaceId
    ? getAttachmentHoverKind(displayName, card.contentType)
    : 'metadata';
  const [state, setState] = useState<AttachmentPreviewState>({ status: 'idle' });
  const [thumbFailed, setThumbFailed] = useState(false);
  const fetchStartedRef = useRef(false);

  const imageUrl =
    workspaceId && kind === 'image'
      ? `/api/workspaces/${workspaceId}/uploads/${encodePathSegments(card.filename)}`
      : null;

  const handleOpenChange = (open: boolean) => {
    if (!open || fetchStartedRef.current || !workspaceId) return;
    if (kind !== 'table' && kind !== 'markdown' && kind !== 'text') return;

    fetchStartedRef.current = true;
    setState({ status: 'loading' });

    const { initialUrl } = buildTextPreviewUrls(
      { workspaceId, source: 'upload', path: card.filename },
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

  return (
    <HoverCard openDelay={200} closeDelay={100} onOpenChange={handleOpenChange}>
      <HoverCardTrigger asChild>
        <div className="w-fit">
          {imageUrl && !thumbFailed ? (
            <ImageTile
              imageUrl={imageUrl}
              displayName={displayName}
              onClick={() => onSelect(card)}
              onError={() => setThumbFailed(true)}
            />
          ) : (
            <FileCard
              filename={displayName}
              fileSize={card.size}
              contentType={card.contentType}
              onClick={() => onSelect(card)}
              showAddOnHover
            />
          )}
        </div>
      </HoverCardTrigger>
      <HoverCardContent
        side="bottom"
        align="start"
        collisionPadding={12}
        className="w-80 overflow-hidden p-0"
      >
        <AttachmentHoverPreview
          card={card}
          kind={kind}
          imageUrl={imageUrl}
          state={state}
        />
      </HoverCardContent>
    </HoverCard>
  );
}
