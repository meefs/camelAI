'use client';

import { useState, useRef, useEffect } from 'react';
import { MoreVertical, CheckSquare, Pencil, Trash2 } from 'lucide-react';
import type { Thread } from '@/types';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

interface ChatRowProps {
  thread: Thread;
  isSelecting: boolean;
  isSelected: boolean;
  onToggleSelect: (id: string) => void;
  onOpen: (id: string) => void;
  onRename: (id: string, newTitle: string) => void;
  onDelete: (id: string) => void;
  onEnterSelectMode: () => void;
}

function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;

  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return days === 1 ? 'Yesterday' : `${days} days ago`;
  }
  if (hours > 0) {
    return `${hours} hour${hours !== 1 ? 's' : ''} ago`;
  }
  if (minutes > 0) {
    return `${minutes} minute${minutes !== 1 ? 's' : ''} ago`;
  }
  return 'Just now';
}

export function ChatRow({
  thread,
  isSelecting,
  isSelected,
  onToggleSelect,
  onOpen,
  onRename,
  onDelete,
  onEnterSelectMode,
}: ChatRowProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(thread.title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const handleRowClick = (e: React.MouseEvent) => {
    // Don't navigate if clicking on interactive elements
    if ((e.target as HTMLElement).closest('button, input, [role="menuitem"]')) {
      return;
    }

    if (isSelecting) {
      onToggleSelect(thread.id);
    } else {
      onOpen(thread.id);
    }
  };

  const handleCheckboxChange = () => {
    onToggleSelect(thread.id);
  };

  const handleSelectFromMenu = () => {
    onEnterSelectMode();
    onToggleSelect(thread.id);
  };

  const handleStartRename = () => {
    setEditValue(thread.title);
    setIsEditing(true);
  };

  const handleSaveRename = () => {
    if (editValue.trim() && editValue !== thread.title) {
      onRename(thread.id, editValue.trim());
    }
    setIsEditing(false);
  };

  const handleCancelRename = () => {
    setEditValue(thread.title);
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSaveRename();
    } else if (e.key === 'Escape') {
      handleCancelRename();
    }
  };

  return (
    <div
      className={cn(
        "group relative flex items-center gap-3 px-3 py-3 rounded-lg cursor-pointer transition-colors",
        "hover:bg-muted/50",
        isSelected && "bg-muted/70"
      )}
      onClick={handleRowClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleRowClick(e as unknown as React.MouseEvent);
        }
      }}
    >
      {/* Checkbox - visible when selecting or on hover */}
      <div
        className={cn(
          "shrink-0 transition-all duration-150",
          isSelecting
            ? "opacity-100 w-5"
            : "opacity-0 w-0 group-hover:opacity-100 group-hover:w-5 group-focus-within:opacity-100 group-focus-within:w-5"
        )}
      >
        <Checkbox
          checked={isSelected}
          onCheckedChange={handleCheckboxChange}
          onClick={(e) => e.stopPropagation()}
          aria-label={`Select ${thread.title}`}
        />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        {isEditing ? (
          <Input
            ref={inputRef}
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={handleSaveRename}
            onKeyDown={handleKeyDown}
            onClick={(e) => e.stopPropagation()}
            className="h-7 text-sm"
          />
        ) : (
          <>
            <p className="text-sm font-medium truncate text-foreground">
              {thread.title || 'Untitled Chat'}
            </p>
            <p className="text-xs text-muted-foreground truncate">
              {formatRelativeTime(thread.updated_at)}
            </p>
          </>
        )}
      </div>

      {/* Kebab Menu - visible on hover */}
      <div
        className={cn(
          "shrink-0 transition-opacity duration-150",
          "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
          isEditing && "hidden"
        )}
      >
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="h-7 w-7"
              onClick={(e) => e.stopPropagation()}
            >
              <MoreVertical className="h-4 w-4" />
              <span className="sr-only">Chat options</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            <DropdownMenuItem onClick={handleSelectFromMenu}>
              <CheckSquare className="h-4 w-4 mr-2" />
              Select
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleStartRename}>
              <Pencil className="h-4 w-4 mr-2" />
              Rename
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => onDelete(thread.id)}
              className="text-destructive focus:text-destructive focus:bg-destructive/10"
            >
              <Trash2 className="h-4 w-4 mr-2" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
