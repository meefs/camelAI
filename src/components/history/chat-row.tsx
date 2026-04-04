'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { MoreVertical, CheckSquare, Pencil, Trash2 } from 'lucide-react';
import type { Thread, Workspace } from '@/types';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { getContrastTextColor } from '@/lib/avatar';
import { cn } from '@/lib/utils';

interface ChatRowProps {
  thread: Thread;
  isSelecting: boolean;
  isSelected: boolean;
  workspace?: Workspace;
  showWorkspaceBadge?: boolean;
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

function getCreatorLabel(name?: string | null, email?: string | null): string | null {
  const trimmedName = name?.trim();
  if (trimmedName) return trimmedName;
  const trimmedEmail = email?.trim();
  return trimmedEmail || null;
}

function getInitials(label: string): string {
  const parts = label.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]?.slice(0, 2).toUpperCase() ?? '?';
  const first = parts[0]?.[0] ?? '';
  const last = parts[parts.length - 1]?.[0] ?? '';
  return `${first}${last}`.toUpperCase() || '?';
}

function normalizeTitleInput(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/^\s+/, '');
}

export function ChatRow({
  thread,
  isSelecting,
  isSelected,
  workspace,
  showWorkspaceBadge = false,
  onToggleSelect,
  onOpen,
  onRename,
  onDelete,
  onEnterSelectMode,
}: ChatRowProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(thread.title);
  const inputRef = useRef<HTMLInputElement>(null);
  const editContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isEditing) return;
    const timeout = window.setTimeout(() => {
      if (inputRef.current) {
        inputRef.current.focus();
        inputRef.current.select();
      }
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [isEditing]);

  const handleRowClick = (e: React.MouseEvent) => {
    if (isEditing) {
      return;
    }

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
    const normalizedTitle = normalizeTitleInput(editValue).trim();
    if (!normalizedTitle) {
      handleCancelRename();
      return;
    }
    if (normalizedTitle === thread.title) {
      setIsEditing(false);
      return;
    }
    onRename(thread.id, normalizedTitle);
    setIsEditing(false);
  };

  const handleCancelRename = useCallback(() => {
    setEditValue(thread.title);
    setIsEditing(false);
  }, [thread.title]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSaveRename();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      handleCancelRename();
    }
    e.stopPropagation();
  };

  useEffect(() => {
    if (!isEditing) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (editContainerRef.current?.contains(target)) return;
      handleCancelRename();
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => document.removeEventListener('pointerdown', handlePointerDown, true);
  }, [handleCancelRename, isEditing]);

  const creatorLabel = getCreatorLabel(thread.creator?.name, thread.creator?.email);
  const creatorInitials = creatorLabel ? getInitials(creatorLabel) : '?';
  const creatorAvatar = thread.creator?.avatar;
  const creatorFallbackStyle = creatorAvatar?.color
    ? {
        backgroundColor: creatorAvatar.color,
        color: getContrastTextColor(creatorAvatar.color),
      }
    : undefined;
  const creatorContent = creatorAvatar?.content ?? creatorInitials;
  const normalizedEditValue = normalizeTitleInput(editValue);
  const isSaveDisabled =
    normalizedEditValue.trim().length === 0 || normalizedEditValue.trim() === thread.title;
  const workspaceBadge = showWorkspaceBadge && workspace ? (
    <Badge
      variant="secondary"
      className="gap-1 pl-1 pr-2 text-[10px] text-muted-foreground max-w-[140px] min-w-0 shrink justify-start"
    >
      <Avatar size="xs">
        <AvatarFallback
          content={workspace.avatar.content}
          style={{
            backgroundColor: workspace.avatar.color,
            color: getContrastTextColor(workspace.avatar.color),
          }}
        >
          {workspace.avatar.content}
        </AvatarFallback>
      </Avatar>
      <span className="truncate min-w-0">{workspace.name}</span>
    </Badge>
  ) : null;
  const creatorAvatarNode = (
    <Avatar size="2xs">
      <AvatarFallback content={creatorContent} style={creatorFallbackStyle}>
        {creatorContent}
      </AvatarFallback>
    </Avatar>
  );
  const creatorWithTooltip = creatorLabel ? (
    <Tooltip>
      <TooltipTrigger asChild>
        {creatorAvatarNode}
      </TooltipTrigger>
      <TooltipContent side="top">
        {creatorLabel}
      </TooltipContent>
    </Tooltip>
  ) : (
    creatorAvatarNode
  );

  return (
    <div
      className={cn(
        "group/row relative flex items-center gap-3 rounded-lg cursor-pointer transition-colors",
        "pl-12 pr-3 py-3 sm:pl-3",
        "hover:bg-muted/50 group-has-[[data-state=open]]/row:bg-muted/50",
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
      {/* Checkbox - lives in a left gutter, no layout shift */}
      <div
        className={cn(
          "absolute left-4 sm:left-[-1rem] top-1/2 -translate-x-1/2 -translate-y-1/2",
          "z-10 transition-all duration-150",
          isSelecting
            ? "opacity-100 scale-100 pointer-events-auto"
            : "opacity-100 scale-100 pointer-events-auto sm:opacity-0 sm:scale-75 sm:pointer-events-none sm:group-hover/row:opacity-100 sm:group-hover/row:scale-100 sm:group-hover/row:pointer-events-auto sm:group-has-[:focus-visible]/row:opacity-100 sm:group-has-[:focus-visible]/row:scale-100 sm:group-has-[:focus-visible]/row:pointer-events-auto sm:group-active/row:opacity-100 sm:group-active/row:scale-100 sm:group-active/row:pointer-events-auto"
        )}
      >
        <Checkbox
          checked={isSelected}
          onCheckedChange={handleCheckboxChange}
          onClick={(e) => e.stopPropagation()}
          aria-label={`Select ${thread.title}`}
        />
      </div>

      {/* Content - padding never changes */}
      <div className="flex-1 min-w-0">
        {isEditing ? (
          <>
            <div ref={editContainerRef} className="flex items-center gap-2">
              <Input
                ref={inputRef}
                autoFocus
                value={editValue}
                onChange={(e) => setEditValue(normalizeTitleInput(e.target.value))}
                onKeyDown={handleKeyDown}
                onClick={(e) => e.stopPropagation()}
                className="h-7 text-sm flex-1"
              />
              <Button
                variant="secondary"
                size="xs"
                disabled={isSaveDisabled}
                onPointerDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  handleSaveRename();
                }}
              >
                Save
              </Button>
              <Button
                variant="ghost"
                size="xs"
                onPointerDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  handleCancelRename();
                }}
              >
                Cancel
              </Button>
            </div>
            <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
              {creatorWithTooltip}
              <span>{formatRelativeTime(thread.updated_at)}</span>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2 min-w-0">
              <p className="text-sm font-medium truncate text-foreground min-w-0">
                {thread.title || 'Untitled Chat'}
              </p>
              {workspaceBadge}
            </div>
            <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
              {creatorWithTooltip}
              <span>{formatRelativeTime(thread.updated_at)}</span>
            </div>
          </>
        )}
      </div>

      {/* Kebab Menu - visible on hover */}
      <div
        className={cn(
          "shrink-0 transition-opacity duration-150",
          "opacity-0 group-hover/row:opacity-100 group-has-[:focus-visible]/row:opacity-100 group-has-[[data-state=open]]/row:opacity-100",
          isEditing && "hidden"
        )}
      >
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="h-7 w-7 data-[state=open]:bg-accent data-[state=open]:text-accent-foreground"
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
              variant="destructive"
              onClick={() => onDelete(thread.id)}
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
