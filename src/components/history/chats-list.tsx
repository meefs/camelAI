'use client';

import type { RefObject } from 'react';
import type { Thread, WorkspaceWithAccess } from '@/types';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { Separator } from '@/components/ui/separator';
import { ChatRow } from './chat-row';
import { MessagesSquare } from 'lucide-react';

interface ChatsListProps {
  threads: Thread[];
  loading: boolean;
  loadingMore?: boolean;
  hasMore?: boolean;
  loadMoreRef?: RefObject<HTMLDivElement | null>;
  scrollViewportRef?: RefObject<HTMLDivElement | null>;
  isSelecting: boolean;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onOpenThread: (id: string) => void;
  onRenameThread: (id: string, newTitle: string) => void;
  onDeleteThread: (id: string) => void;
  onEnterSelectMode: () => void;
  workspaceMap?: Map<string, WorkspaceWithAccess>;
  currentWorkspaceId?: string | null;
  showWorkspaceBadges?: boolean;
}

function LoadingSkeleton() {
  return (
    <div className="space-y-2 py-2">
      {Array.from({ length: 5 }).map((_, i) => (
        <div
          key={i}
          className="relative flex items-center gap-3 rounded-lg pl-12 pr-3 py-3 sm:pl-3"
        >
          <div className="absolute left-4 sm:left-[-1rem] top-1/2 -translate-x-1/2 -translate-y-1/2">
            <Skeleton className="h-5 w-5 rounded" />
          </div>
          <div className="flex-1 min-w-0 space-y-2">
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

export function ChatsList({
  threads,
  loading,
  loadingMore = false,
  hasMore = false,
  loadMoreRef,
  scrollViewportRef,
  isSelecting,
  selectedIds,
  onToggleSelect,
  onOpenThread,
  onRenameThread,
  onDeleteThread,
  onEnterSelectMode,
  workspaceMap,
  currentWorkspaceId,
  showWorkspaceBadges = false,
}: ChatsListProps) {
  if (loading) {
    return (
      <ScrollArea className="flex-1 min-h-0 sm:-ml-6 sm:w-[calc(100%+1.5rem)]">
        <div className="sm:pl-6">
          <LoadingSkeleton />
        </div>
      </ScrollArea>
    );
  }

  if (threads.length === 0) {
    return <EmptyState />;
  }

  return (
    <ScrollArea
      className="flex-1 min-h-0 sm:-ml-6 sm:w-[calc(100%+1.5rem)]"
      viewportRef={scrollViewportRef}
    >
      <div className="py-2 sm:pl-6">
        {threads.map((thread, index) => (
          <div key={thread.id}>
            <ChatRow
              thread={thread}
              isSelecting={isSelecting}
              isSelected={selectedIds.has(thread.id)}
              workspace={workspaceMap?.get(thread.workspace_id)}
              showWorkspaceBadge={
                Boolean(
                  showWorkspaceBadges &&
                    currentWorkspaceId &&
                    thread.workspace_id !== currentWorkspaceId
                )
              }
              onToggleSelect={onToggleSelect}
              onOpen={onOpenThread}
              onRename={onRenameThread}
              onDelete={onDeleteThread}
              onEnterSelectMode={onEnterSelectMode}
            />
            {index < threads.length - 1 && (
              <Separator />
            )}
          </div>
        ))}
        {hasMore && (
          <div ref={loadMoreRef} className="py-6 flex items-center justify-center">
            {loadingMore ? (
              <div className="w-full max-w-xs space-y-2">
                <Skeleton className="h-4 w-3/4 mx-auto" />
                <Skeleton className="h-3 w-1/2 mx-auto" />
              </div>
            ) : (
              <span className="text-xs text-muted-foreground">Loading more chats…</span>
            )}
          </div>
        )}
      </div>
    </ScrollArea>
  );
}
