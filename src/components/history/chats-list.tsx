'use client';

import type { Thread } from '@/types';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { ChatRow } from './chat-row';
import { MessagesSquare } from 'lucide-react';

interface ChatsListProps {
  threads: Thread[];
  loading: boolean;
  isSelecting: boolean;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onOpenThread: (id: string) => void;
  onRenameThread: (id: string, newTitle: string) => void;
  onDeleteThread: (id: string) => void;
  onEnterSelectMode: () => void;
}

function LoadingSkeleton() {
  return (
    <div className="space-y-2 py-2">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-3 py-3">
          <Skeleton className="h-5 w-5 rounded" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="rounded-full bg-muted p-4 mb-4">
        <MessagesSquare className="h-8 w-8 text-muted-foreground" />
      </div>
      <h3 className="text-lg font-medium text-foreground mb-1">No chats yet</h3>
      <p className="text-sm text-muted-foreground max-w-sm">
        Start a new conversation to see your chat history here.
      </p>
    </div>
  );
}

function NoResults() {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <h3 className="text-lg font-medium text-foreground mb-1">No results found</h3>
      <p className="text-sm text-muted-foreground max-w-sm">
        Try adjusting your search to find what you&apos;re looking for.
      </p>
    </div>
  );
}

export function ChatsList({
  threads,
  loading,
  isSelecting,
  selectedIds,
  onToggleSelect,
  onOpenThread,
  onRenameThread,
  onDeleteThread,
  onEnterSelectMode,
}: ChatsListProps) {
  if (loading) {
    return <LoadingSkeleton />;
  }

  if (threads.length === 0) {
    return <EmptyState />;
  }

  return (
    <ScrollArea className="flex-1 -mx-1">
      <div className="px-1 py-2 space-y-1">
        {threads.map((thread) => (
          <ChatRow
            key={thread.id}
            thread={thread}
            isSelecting={isSelecting}
            isSelected={selectedIds.has(thread.id)}
            onToggleSelect={onToggleSelect}
            onOpen={onOpenThread}
            onRename={onRenameThread}
            onDelete={onDeleteThread}
            onEnterSelectMode={onEnterSelectMode}
          />
        ))}
      </div>
    </ScrollArea>
  );
}
