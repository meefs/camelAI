"use client";

import { lazy, Suspense, useRef, useState, type ReactNode } from "react";
import { MoreHorizontal, Pencil, Pin, PinOff, X } from "lucide-react";
import type { ChatGroupThreadSummary, ChatGroupView, ThreadStatus } from "@/types";
import { ChatGroupAvatar } from "@/components/avatar/chat-group-avatar";
import { CamelLoader } from "@/components/camel-loader/camel-loader";
import {
  CloseChatGroupDialog,
  readCloseGroupConfirmationSuppressed,
} from "@/components/close-chat-group-dialog";
import { ChatGroupHoverCard } from "@/components/sidebar/chat-group-hover-card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import {
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
} from "@/components/ui/sidebar";
import { useFlipList } from "@/hooks/use-flip-list";
import type { ChatGroupRenameInput } from "@/lib/chat-group-rename.client";
import { cn } from "@/lib/utils";

const THREAD_DRAG_MIME = "application/x-camelai-thread-id";
const LazyRenameChatGroupDialog = lazy(() =>
  import("@/components/avatar/rename-chat-group-dialog").then((module) => ({
    default: module.RenameChatGroupDialog,
  })),
);

interface ChatGroupsListProps {
  groups: ChatGroupView[];
  activeGroupId: string | null;
  isLoading?: boolean;
  skeletonCount?: number;
  emptyState?: ReactNode | null;
  onSelectGroup: (groupId: string) => void;
  onCloseGroup: (groupId: string) => void;
  onTogglePinGroup: (group: ChatGroupView) => void;
  onRenameGroup: (groupId: string, next: ChatGroupRenameInput) => void;
  openHoverGroupId: string | null;
  onOpenHoverGroupIdChange: (groupId: string | null) => void;
  openMenuGroupId: string | null;
  onOpenMenuGroupIdChange: (groupId: string | null) => void;
  onSelectThread?: (
    groupId: string,
    thread: ChatGroupThreadSummary,
  ) => void | Promise<void>;
  onMoveThreadToGroup?: (threadId: string, targetGroupId: string) => void;
}

export function ChatGroupRightSlot({
  status,
  count,
}: {
  status: ThreadStatus;
  count: number;
}) {
  const countLabel = `${count} open ${count === 1 ? "chat" : "chats"}`;
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1.5 text-xs tabular-nums text-muted-foreground starting:opacity-0 transition-[display,opacity] transition-discrete duration-100 ease-linear group-data-[collapsible=icon]:hidden group-data-[collapsible=icon]:opacity-0 motion-reduce:transition-none">
      {status === "running" ? (
        <span aria-hidden className="text-muted-foreground">
          <CamelLoader size={16} ariaLabel="Agent is working" />
        </span>
      ) : status === "unread" ? (
        <span
          aria-hidden
          className="size-2 rounded-full bg-amber-500"
        />
      ) : null}
      <span
        className="tabular-nums transition-opacity group-hover/menu-item:opacity-0 group-has-[[data-state=open]]/menu-item:opacity-0"
        aria-label={countLabel}
      >
        {count}
      </span>
    </span>
  );
}

export function ChatGroupIcon({ group }: { group: ChatGroupView }) {
  const isRunning = group.status === "running";
  const isUnread = group.status === "unread";
  const statusLabel = isRunning
    ? "Agent is working"
    : isUnread
      ? "Awaiting your review"
      : null;
  // Both avatar sizes stay mounted, stacked in one grid cell, so the collapse
  // toggle is a pure-opacity cross-fade while the wrapper morphs 20px -> 24px
  // on the sidebar shell's 200ms/linear timeline.
  return (
    <span className="relative grid size-5 shrink-0 grid-cols-[100%] grid-rows-[100%] place-items-center transition-[width,height] duration-200 ease-linear group-data-[collapsible=icon]:size-6 motion-reduce:transition-none">
      <ChatGroupAvatar
        avatar={group.avatar}
        fallbackName={group.name}
        size="sm"
        className="col-start-1 row-start-1 transition-opacity duration-100 ease-linear group-data-[collapsible=icon]:opacity-0 motion-reduce:transition-none"
      />
      <span aria-hidden className="col-start-1 row-start-1 relative size-6 opacity-0 transition-opacity duration-100 ease-linear group-data-[collapsible=icon]:opacity-100 group-data-[collapsible=icon]:delay-100 motion-reduce:transition-none">
        <ChatGroupAvatar
          avatar={group.avatar}
          fallbackName={group.name}
          size="md"
        />
        {isRunning ? (
          <span className="absolute inset-0 grid place-items-center rounded-[28%] bg-background/65 text-foreground">
            <CamelLoader size={16} ariaLabel="Agent is working" />
          </span>
        ) : isUnread ? (
          <span
            className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full bg-amber-500 ring-2 ring-sidebar"
          />
        ) : null}
      </span>
      {statusLabel ? (
        <span role="status" className="sr-only">
          {statusLabel}
        </span>
      ) : null}
    </span>
  );
}

export function ChatGroupCollapsedIcon({ group }: { group: ChatGroupView }) {
  return (
    <ChatGroupAvatar
      avatar={group.avatar}
      fallbackName={group.name}
      size="md"
      className="hidden group-data-[collapsible=icon]:flex"
    />
  );
}

export function ChatGroupsList({
  groups,
  activeGroupId,
  isLoading = false,
  skeletonCount = 5,
  emptyState,
  onSelectGroup,
  onCloseGroup,
  onTogglePinGroup,
  onRenameGroup,
  openHoverGroupId,
  onOpenHoverGroupIdChange,
  openMenuGroupId,
  onOpenMenuGroupIdChange,
  onSelectThread,
  onMoveThreadToGroup,
}: ChatGroupsListProps) {
  const [confirmGroup, setConfirmGroup] = useState<ChatGroupView | null>(null);
  const [renameTarget, setRenameTarget] = useState<ChatGroupView | null>(null);
  const [isRenameOpen, setIsRenameOpen] = useState(false);
  const [dragOverGroupId, setDragOverGroupId] = useState<string | null>(null);
  const menuRef = useRef<HTMLUListElement | null>(null);
  useFlipList(menuRef, groups.map((group) => group.id).join("\n"));

  const requestCloseGroup = (group: ChatGroupView) => {
    if (readCloseGroupConfirmationSuppressed()) {
      onCloseGroup(group.id);
    } else {
      setConfirmGroup(group);
    }
  };

  if (isLoading && groups.length === 0) {
    return (
      <SidebarMenu>
        {Array.from({
          length: Math.max(0, Math.floor(skeletonCount)),
        }).map((_, index) => (
          <SidebarMenuItem key={index}>
            <SidebarMenuSkeleton showIcon />
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    );
  }

  if (groups.length === 0) {
    if (emptyState === null) return null;
    if (emptyState !== undefined) return emptyState;
    return (
      <div className="px-2 py-1.5 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
        No groups yet
      </div>
    );
  }

  return (
    <>
      <SidebarMenu ref={menuRef}>
        {groups.map((group) => {
          const isActive = group.id === activeGroupId;
          return (
            <SidebarMenuItem key={group.id} data-flip-id={group.id}>
              <HoverCard
                open={
                  openHoverGroupId === group.id && openMenuGroupId === null
                }
                onOpenChange={(open) =>
                  onOpenHoverGroupIdChange(open ? group.id : null)
                }
                openDelay={250}
                closeDelay={150}
              >
                <HoverCardTrigger asChild>
                  <SidebarMenuButton
                    type="button"
                    aria-label={group.name}
                    isActive={isActive}
                    size="sm"
                    className={cn(
                      "group/chat-group cursor-pointer gap-2 !pr-2 select-none group-hover/menu-item:bg-sidebar-accent group-hover/menu-item:text-sidebar-accent-foreground group-has-[[data-state=open]]/menu-item:bg-sidebar-accent group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:[&_*]:pointer-events-none group-data-[collapsible=icon]:[&_*]:cursor-pointer",
                      dragOverGroupId === group.id && "bg-sidebar-accent/50",
                      dragOverGroupId === group.id &&
                        "group-data-[collapsible=icon]:bg-sidebar-accent group-data-[collapsible=icon]:ring-2 group-data-[collapsible=icon]:ring-blue-500 group-data-[collapsible=icon]:ring-offset-1",
                    )}
                    onClick={() => onSelectGroup(group.id)}
                    onDragOver={(event) => {
                      if (!onMoveThreadToGroup) return;
                      if (event.dataTransfer.types.includes(THREAD_DRAG_MIME)) {
                        event.preventDefault();
                        setDragOverGroupId(group.id);
                      }
                    }}
                    onDragLeave={() => setDragOverGroupId(null)}
                    onDrop={(event) => {
                      if (!onMoveThreadToGroup) return;
                      const threadId = event.dataTransfer.getData(THREAD_DRAG_MIME);
                      setDragOverGroupId(null);
                      if (!threadId) return;
                      event.preventDefault();
                      onMoveThreadToGroup(threadId, group.id);
                    }}
                  >
                    <ChatGroupIcon group={group} />
                    <span className="min-w-0 flex-1 truncate text-left starting:opacity-0 transition-[display,opacity] transition-discrete duration-100 ease-linear group-data-[collapsible=icon]:hidden group-data-[collapsible=icon]:opacity-0 motion-reduce:transition-none">
                      {group.name}
                    </span>
                    <ChatGroupRightSlot
                      status={group.status}
                      count={group.open_threads.length}
                    />
                  </SidebarMenuButton>
                </HoverCardTrigger>
                <HoverCardContent
                  side="right"
                  align="start"
                  sideOffset={8}
                  collisionPadding={8}
                  className="w-[20rem] p-0"
                >
                  <ChatGroupHoverCard
                    group={group}
                    onSelectThread={async (thread) => {
                      onOpenHoverGroupIdChange(null);
                      await onSelectThread?.(group.id, thread);
                    }}
                  />
                </HoverCardContent>
              </HoverCard>
              <span
                aria-hidden
                className="pointer-events-none absolute inset-y-0 right-0 w-12 rounded-r-md bg-sidebar-accent opacity-0 transition-opacity group-hover/menu-item:opacity-100 group-has-[[data-state=open]]/menu-item:opacity-100 group-data-[collapsible=icon]:hidden"
              />
              <span
                aria-hidden
                className="pointer-events-none absolute inset-y-0 right-12 w-2.5 bg-gradient-to-l from-sidebar-accent to-transparent opacity-0 transition-opacity group-hover/menu-item:opacity-100 group-has-[[data-state=open]]/menu-item:opacity-100 group-data-[collapsible=icon]:hidden"
              />
              <DropdownMenu
                onOpenChange={(open) => {
                  onOpenMenuGroupIdChange(open ? group.id : null);
                  onOpenHoverGroupIdChange(null);
                }}
              >
                <DropdownMenuTrigger asChild>
                  <SidebarMenuAction
                    type="button"
                    aria-label={`Group options for ${group.name}`}
                    className="right-6.5 opacity-0 transition-opacity group-hover/menu-item:opacity-100 group-has-[[data-state=open]]/menu-item:opacity-100 focus-visible:opacity-100"
                  >
                    <MoreHorizontal className="size-3" />
                  </SidebarMenuAction>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  side="right"
                  align="start"
                  sideOffset={8}
                  collisionPadding={8}
                  className="w-56"
                >
                  <DropdownMenuItem
                    onSelect={() => onTogglePinGroup(group)}
                  >
                    {group.pinned_at !== null ? <PinOff /> : <Pin />}
                    {group.pinned_at !== null ? "Unpin group" : "Pin group"}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => {
                      setRenameTarget(group);
                      setIsRenameOpen(true);
                    }}
                  >
                    <Pencil />
                    Rename group
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onSelect={() => requestCloseGroup(group)}
                  >
                    <X />
                    Close group
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <SidebarMenuAction
                type="button"
                aria-label={`Close ${group.name}`}
                className="opacity-0 transition-opacity group-hover/menu-item:opacity-100 group-has-[[data-state=open]]/menu-item:opacity-100 focus-visible:opacity-100"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  requestCloseGroup(group);
                }}
              >
                <X className="size-3" />
              </SidebarMenuAction>
            </SidebarMenuItem>
          );
        })}
      </SidebarMenu>

      <CloseChatGroupDialog
        open={confirmGroup !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmGroup(null);
        }}
        groupName={confirmGroup?.name ?? "group"}
        chatCount={confirmGroup?.member_count ?? 0}
        onConfirm={() => {
          if (confirmGroup) onCloseGroup(confirmGroup.id);
        }}
      />
      {renameTarget ? (
        <Suspense fallback={null}>
          <LazyRenameChatGroupDialog
            key={renameTarget.id}
            open={isRenameOpen}
            onOpenChange={setIsRenameOpen}
            initialName={renameTarget.name}
            initialAvatar={renameTarget.avatar}
            onSubmit={(next) => onRenameGroup(renameTarget.id, next)}
          />
        </Suspense>
      ) : null}
    </>
  );
}
