'use client';

import { useState } from 'react';
import type { GroupNewChatAttachmentCard } from '@/types';
import { FileCard } from '@/components/file-card';
import { ImageTile } from '@/components/image-tile';
import { AttachmentHoverCard } from '@/components/chat-file-preview/attachment-hover-card';
import { getAttachmentHoverKind } from '@/components/chat-file-preview/attachment-hover-preview';
import { encodePathSegments } from '@/components/chat-file-preview/file-preview-urls';
import { formatRelative } from '@/components/at-mention-menu/mention-target-hover-preview';

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
  const [thumbFailed, setThumbFailed] = useState(false);

  const imageUrl =
    workspaceId && kind === 'image'
      ? `/api/workspaces/${workspaceId}/uploads/${encodePathSegments(card.filename)}`
      : null;

  return (
    <AttachmentHoverCard
      workspaceId={workspaceId}
      uploadFilename={card.filename}
      displayName={displayName}
      filename={displayName}
      size={card.size}
      contentType={card.contentType}
      footer={
        <>
          {card.sourceTitle ? (
            <>From &ldquo;{card.sourceTitle}&rdquo;</>
          ) : (
            'Used'
          )}{' '}
          · {formatRelative(card.lastUsedAt)}
        </>
      }
    >
      {imageUrl && !thumbFailed ? (
        <ImageTile
          imageUrl={imageUrl}
          displayName={displayName}
          onSelect={() => onSelect(card)}
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
    </AttachmentHoverCard>
  );
}
