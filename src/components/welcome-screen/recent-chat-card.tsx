'use client';

import type { Thread } from '@/types';
import { cn } from '@/lib/utils';

interface RecentChatCardProps {
  thread: Thread;
  renderedAt: number;
  onClick: (threadId: string) => void;
}

function getRelativeTime(timestamp: number, referenceTime: number): string {
  const seconds = Math.max(0, Math.floor((referenceTime - timestamp) / 1000));
  if (seconds < 60) return 'Just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  return `${days} days ago`;
}

export function RecentChatCard({ thread, renderedAt, onClick }: RecentChatCardProps) {
  return (
    <button
      type="button"
      onClick={() => onClick(thread.id)}
      className={cn(
        'group relative flex flex-col gap-2 p-4 rounded-xl cursor-pointer',
        'border border-border bg-card',
        'text-left transition-all duration-200 ease-out',
        'hover:border-ring hover:shadow-md',
        'w-[260px] shrink-0'
      )}
    >
      <p className="text-sm font-medium text-foreground truncate min-w-0">
        {thread.title || 'Untitled Chat'}
      </p>
      {thread.first_user_message && (
        <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">
          {thread.first_user_message}
        </p>
      )}
      <div className="flex items-center gap-1.5 mt-auto pt-1">
        <span className="text-xs text-muted-foreground">
          {getRelativeTime(thread.updated_at, renderedAt)}
        </span>
      </div>
    </button>
  );
}
