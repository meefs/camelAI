'use client';

import { Search, Trash2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';

interface ChatsToolbarProps {
  searchQuery: string;
  onSearchChange: (query: string) => void;
  totalCount: number;
  isSelecting: boolean;
  selectedCount: number;
  allSelected: boolean;
  onToggleSelectMode: () => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onDeleteSelected: () => void;
}

export function ChatsToolbar({
  searchQuery,
  onSearchChange,
  totalCount,
  isSelecting,
  selectedCount,
  allSelected,
  onToggleSelectMode,
  onSelectAll,
  onClearSelection,
  onDeleteSelected,
}: ChatsToolbarProps) {
  return (
    <div className="sticky top-12 z-20 bg-background py-4 space-y-3">
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

      {/* Controls Row */}
      <div className="flex items-center justify-between h-8">
        <div className="flex items-center gap-3">
          {/* Select All Checkbox - visible when selecting or on hover */}
          <div
            className={cn(
              "flex items-center gap-2 transition-opacity",
              isSelecting ? "opacity-100" : "opacity-0 hover:opacity-100"
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
                className="text-sm text-muted-foreground cursor-pointer select-none"
              >
                Select all
              </label>
            )}
          </div>

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
              onClick={onToggleSelectMode}
            >
              Select
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
