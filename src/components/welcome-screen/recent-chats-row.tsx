'use client';

import type { Thread } from '@/types';
import { RecentChatCard } from './recent-chat-card';

interface RecentChatsRowProps {
  threads: Thread[];
  renderedAt: number;
  onOpenThread: (threadId: string) => void;
}

export function RecentChatsRow({ threads, renderedAt, onOpenThread }: RecentChatsRowProps) {
  return (
    <div className="flex gap-4 overflow-x-auto pb-2 no-scrollbar">
      {threads.map((thread) => (
        <RecentChatCard
          key={thread.id}
          thread={thread}
          renderedAt={renderedAt}
          onClick={onOpenThread}
        />
      ))}
    </div>
  );
}
