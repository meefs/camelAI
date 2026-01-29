'use client';

import { useEffect, useState } from 'react';
import { Image } from 'lucide-react';
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
        'group flex flex-col overflow-hidden rounded-xl',
        'border border-border bg-card',
        'hover:shadow-md transition-all duration-200',
        'w-[180px] shrink-0'
      )}
    >
      <div className="relative aspect-video bg-gradient-to-br from-muted/60 to-muted overflow-hidden">
        {previewUrl && !previewFailed ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={previewUrl}
            alt={app.script_name}
            className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
            onError={() => setPreviewFailed(true)}
          />
        ) : (
          <div className="flex items-center justify-center h-full">
            <Image className="size-6 text-muted-foreground/40" />
          </div>
        )}
      </div>

      <div className="p-3">
        <p className="font-medium text-sm truncate">{app.script_name}</p>
        <div className="flex items-center gap-1.5 mt-1">
          <div className="w-1.5 h-1.5 rounded-full bg-green-500" />
          <span className="text-xs text-muted-foreground">
            {getRelativeTime(app.updated_at, renderedAt)}
          </span>
        </div>
      </div>
    </button>
  );
}
