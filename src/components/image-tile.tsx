'use client';

import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

interface ImageTileProps {
  imageUrl: string;
  displayName: string;
  /** Add mode: whole tile is a button; hover shows a Plus badge. */
  onSelect?: () => void;
  /** Remove mode: tile is inert; hover/focus shows an X badge button. */
  onRemove?: () => void;
  onError?: () => void;
  className?: string;
}

export function ImageTile({
  imageUrl,
  displayName,
  onSelect,
  onRemove,
  onError,
  className,
}: ImageTileProps) {
  const [loaded, setLoaded] = useState(false);

  const image = (
    <>
      {!loaded ? <Skeleton className="absolute inset-0 rounded-none" /> : null}
      <img
        src={imageUrl}
        alt={onSelect ? '' : displayName}
        className={cn(
          'h-full w-full object-cover transition-opacity duration-150',
          loaded ? 'opacity-100' : 'opacity-0',
        )}
        onLoad={() => setLoaded(true)}
        onError={onError}
      />
    </>
  );

  if (onSelect) {
    return (
      <button
        type="button"
        onClick={onSelect}
        aria-label={`Add ${displayName} to chat`}
        className={cn(
          'group/thumb relative h-[88px] w-[88px] cursor-pointer overflow-hidden rounded-lg border border-border bg-muted/30 transition-all duration-200 ease-out hover:border-ring hover:shadow-md',
          className,
        )}
      >
        {image}
        <span
          aria-hidden
          className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-background/80 opacity-0 shadow-sm transition-opacity group-hover/thumb:opacity-100 group-focus-visible/thumb:opacity-100"
        >
          <Plus className="h-3 w-3 text-foreground" />
        </span>
      </button>
    );
  }

  return (
    <div
      className={cn(
        'group/thumb relative h-[88px] w-[88px] cursor-default overflow-hidden rounded-lg border border-border bg-muted/30 transition-all duration-200 ease-out hover:border-ring hover:shadow-md',
        className,
      )}
    >
      {image}
      {onRemove ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
          aria-label={`Remove ${displayName}`}
          className="absolute right-1 top-1 flex h-5 w-5 cursor-pointer items-center justify-center rounded-full bg-background/80 text-foreground opacity-0 shadow-sm transition-opacity group-hover/thumb:opacity-100 group-focus-within/thumb:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="h-3 w-3" />
        </button>
      ) : null}
    </div>
  );
}
