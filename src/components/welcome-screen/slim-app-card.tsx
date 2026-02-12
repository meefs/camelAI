'use client';

import { useEffect, useState } from 'react';
import { ArrowRight, Image } from 'lucide-react';
import type { WorkerScriptWithCreator } from '@/types';
import { cn } from '@/lib/utils';

interface SlimAppCardProps {
  app: WorkerScriptWithCreator;
  renderedAt: number;
  onStartChat: (app: WorkerScriptWithCreator) => void;
}

function getRelativeTime(timestamp: number, referenceTime: number): string {
  const seconds = Math.max(0, Math.floor((referenceTime - timestamp) / 1000));
  if (seconds < 60) return 'Just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  }
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  return `${days} days ago`;
}

export function SlimAppCard({ app, renderedAt, onStartChat }: SlimAppCardProps) {
  const previewVersion = app.preview_updated_at ?? app.updated_at;
  const previewUrl = app.preview_status === 'ready' && app.preview_key
    ? `/api/apps/${encodeURIComponent(app.script_name)}/preview?v=${previewVersion}`
    : null;
  const [previewFailed, setPreviewFailed] = useState(false);

  useEffect(() => {
    setPreviewFailed(false);
  }, [previewUrl]);

  return (
    <button
      type="button"
      onClick={() => onStartChat(app)}
      className={cn(
        'group relative aspect-video overflow-hidden rounded-xl',
        'border border-border cursor-pointer',
        'transition-all duration-200 ease-out',
        'hover:border-ring',
        'hover:shadow-md',
        'w-[260px] shrink-0'
      )}
    >
      <div className="absolute inset-0">
        {previewUrl && !previewFailed ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={previewUrl}
            alt={app.script_name}
            className="w-full h-full object-cover transition-transform duration-[250ms] ease-in-out group-hover:scale-105"
            onError={() => setPreviewFailed(true)}
          />
        ) : (
          <div className="flex items-center justify-center h-full bg-gradient-to-br from-muted/60 to-muted">
            <Image className="size-6 text-muted-foreground/40" />
          </div>
        )}
      </div>

      <div
        className={cn(
          'absolute bottom-3 left-3 right-3',
          'bg-background/65 backdrop-blur-md border border-white/10',
          'rounded-lg px-3 py-2 flex items-center justify-between',
          'transition-colors duration-[250ms] ease-in-out',
          'group-hover:bg-background/75'
        )}
      >
        <div className="min-w-0">
          <p className="font-medium text-sm truncate text-foreground">{app.script_name}</p>
          <div className="flex items-center gap-1.5">
            <div className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />
            <span className="text-xs text-muted-foreground">
              {getRelativeTime(app.updated_at, renderedAt)}
            </span>
          </div>
        </div>
        <ArrowRight
          className={cn(
            'size-4 text-muted-foreground shrink-0',
            'transition-all duration-[250ms] ease-in-out',
            'opacity-0 translate-x-2',
            'group-hover:opacity-100 group-hover:translate-x-0'
          )}
        />
      </div>
    </button>
  );
}
