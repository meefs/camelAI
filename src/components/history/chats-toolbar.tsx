'use client';

import { Search, Trash2 } from 'lucide-react';
import type { ThreadCreator, User } from '@/types';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { generateDefaultAvatar, getContrastTextColor } from '@/lib/avatar';
import { cn } from '@/lib/utils';

interface ChatsToolbarProps {
  searchQuery: string;
  onSearchChange: (query: string) => void;
  scope: 'this-workspace' | 'all-workspaces';
  onScopeChange: (value: 'this-workspace' | 'all-workspaces') => void;
  creators: ThreadCreator[];
  currentUser: User | null;
  currentUserId: string;
  activeCreatorId: string | null;
  onCreatorChange: (userId: string | null) => void;
  totalCount: number;
  isSelecting: boolean;
  selectedCount: number;
  allSelected: boolean;
  onEnterSelectMode: () => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onDeleteSelected: () => void;
}

function getCreatorAvatar(
  name: string | null,
  email: string,
  avatar: ThreadCreator['avatar'] | User['avatar'] | null
) {
  return avatar ?? generateDefaultAvatar(name?.trim() || email);
}

function getCreatorTabLabel(creator: ThreadCreator): string {
  const trimmedName = creator.name?.trim();
  if (trimmedName) {
    return trimmedName.split(/\s+/)[0] || trimmedName;
  }

  return creator.email.split('@')[0] || creator.email;
}

export function ChatsToolbar({
  searchQuery,
  onSearchChange,
  scope,
  onScopeChange,
  creators,
  currentUser,
  currentUserId,
  activeCreatorId,
  onCreatorChange,
  totalCount,
  isSelecting,
  selectedCount,
  allSelected,
  onEnterSelectMode,
  onSelectAll,
  onClearSelection,
  onDeleteSelected,
}: ChatsToolbarProps) {
  const showCreatorTabs = creators.length > 1;
  const currentUserAvatar = getCreatorAvatar(
    currentUser?.name ?? null,
    currentUser?.email ?? 'you',
    currentUser?.avatar ?? null
  );
  const teammates = creators.filter((creator) => creator.userId !== currentUserId);

  return (
    <div className="sticky top-12 z-20 bg-background py-4 space-y-3 sm:-ml-6 sm:w-[calc(100%+1.5rem)] sm:pl-6">
      {/* Search Input */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          type="text"
          placeholder="Search chats..."
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          className="pl-9 h-10"
        />
      </div>

      <Tabs value={scope} onValueChange={(value) => onScopeChange(value as 'this-workspace' | 'all-workspaces')}>
        <TabsList variant="line">
          <TabsTrigger value="this-workspace">This workspace</TabsTrigger>
          <TabsTrigger value="all-workspaces">All workspaces</TabsTrigger>
        </TabsList>
      </Tabs>

      {/* Controls Row */}
      <div className="group/header relative flex items-center justify-between h-8 pl-12 pr-3 sm:pl-3 sm:pr-3">
        <div className="flex items-center gap-3">
          {/* Count label */}
          <span className="text-sm text-muted-foreground">
            {isSelecting && selectedCount > 0
              ? `${selectedCount} selected`
              : `${totalCount} chat${totalCount !== 1 ? 's' : ''}`}
          </span>
        </div>

        {/* Right side actions */}
        <div className="flex items-center gap-2">
          {isSelecting ? (
            <>
              {selectedCount > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onDeleteSelected}
                  className="text-destructive hover:text-destructive hover:bg-destructive/10"
                >
                  <Trash2 className="h-4 w-4 mr-1" />
                  Delete
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={onClearSelection}
              >
                Cancel
              </Button>
            </>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={onEnterSelectMode}
            >
              Select
            </Button>
          )}
        </div>

        {/* Select All Checkbox - lives in a left gutter, no layout shift */}
        <div
          className={cn(
            "absolute left-4 sm:left-[-1rem] top-1/2 -translate-x-1/2 -translate-y-1/2",
            "z-10 flex items-center gap-2 transition-all duration-150",
            isSelecting
              ? "opacity-100 scale-100 pointer-events-auto"
              : "opacity-100 scale-100 pointer-events-auto sm:opacity-0 sm:scale-75 sm:pointer-events-none sm:group-hover/header:opacity-100 sm:group-hover/header:scale-100 sm:group-hover/header:pointer-events-auto sm:focus-within:opacity-100 sm:focus-within:scale-100 sm:focus-within:pointer-events-auto"
          )}
        >
          <Checkbox
            id="select-all"
            checked={allSelected}
            onCheckedChange={onSelectAll}
            aria-label="Select all chats"
          />
          {isSelecting && (
            <label
              htmlFor="select-all"
              className="sr-only"
            >
              Select all
            </label>
          )}
        </div>
      </div>

      {showCreatorTabs ? (
        <Tabs
          value={activeCreatorId ?? 'all'}
          onValueChange={(value) => onCreatorChange(value === 'all' ? null : value)}
        >
          <div className="overflow-x-auto">
            <TabsList variant="line" className="min-w-max">
              <TabsTrigger value="all">All</TabsTrigger>
              <TabsTrigger value={currentUserId} className="gap-1.5">
                <Avatar size="2xs">
                  <AvatarFallback
                    content={currentUserAvatar.content}
                    style={{
                      backgroundColor: currentUserAvatar.color,
                      color: getContrastTextColor(currentUserAvatar.color),
                    }}
                  >
                    {currentUserAvatar.content}
                  </AvatarFallback>
                </Avatar>
                You
              </TabsTrigger>
              {teammates.map((creator) => {
                const creatorAvatar = getCreatorAvatar(
                  creator.name,
                  creator.email,
                  creator.avatar
                );

                return (
                  <TabsTrigger key={creator.userId} value={creator.userId} className="gap-1.5">
                    <Avatar size="2xs">
                      <AvatarFallback
                        content={creatorAvatar.content}
                        style={{
                          backgroundColor: creatorAvatar.color,
                          color: getContrastTextColor(creatorAvatar.color),
                        }}
                      >
                        {creatorAvatar.content}
                      </AvatarFallback>
                    </Avatar>
                    <span className="truncate max-w-[100px]">
                      {getCreatorTabLabel(creator)}
                    </span>
                  </TabsTrigger>
                );
              })}
            </TabsList>
          </div>
        </Tabs>
      ) : null}
    </div>
  );
}
