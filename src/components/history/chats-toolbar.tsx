'use client';

import { Search, Trash2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';

interface ChatsToolbarProps {
  searchQuery: string;
  onSearchChange: (query: string) => void;
  filter: 'this-workspace' | 'all-workspaces';
  onFilterChange: (value: 'this-workspace' | 'all-workspaces') => void;
  totalCount: number;
  isSelecting: boolean;
  selectedCount: number;
  allSelected: boolean;
  onEnterSelectMode: () => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onDeleteSelected: () => void;
}

export function ChatsToolbar({
  searchQuery,
  onSearchChange,
  filter,
  onFilterChange,
  totalCount,
  isSelecting,
  selectedCount,
  allSelected,
  onEnterSelectMode,
  onSelectAll,
  onClearSelection,
  onDeleteSelected,
}: ChatsToolbarProps) {
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

      <Tabs value={filter} onValueChange={(value) => onFilterChange(value as 'this-workspace' | 'all-workspaces')}>
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
    </div>
  );
}
