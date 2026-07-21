"use client";

import { useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import type { ChatGroupThreadSummary, ChatGroupView, ThreadStatus } from "@/types";
import { ChatGroupAvatar } from "@/components/avatar/chat-group-avatar";
import { CamelLoader } from "@/components/camel-loader/camel-loader";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { ChatGroupHoverCard } from "@/components/sidebar/chat-group-hover-card";
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
import { cn } from "@/lib/utils";

const THREAD_DRAG_MIME = "application/x-camelai-thread-id";
export const CLOSE_CHAT_GROUP_CONFIRMATION_SUPPRESSED_KEY =
  "camelai:close-chat-group-confirmation-suppressed:v1";

function readCloseGroupConfirmationSuppressed() {
  if (typeof window === "undefined") return false;
  try {
    return (
      window.localStorage.getItem(
        CLOSE_CHAT_GROUP_CONFIRMATION_SUPPRESSED_KEY,
      ) === "true"
    );
  } catch {
    return false;
  }
}

function writeCloseGroupConfirmationSuppressed() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      CLOSE_CHAT_GROUP_CONFIRMATION_SUPPRESSED_KEY,
      "true",
    );
  } catch {
    // Closing should still succeed if the browser rejects local storage writes.
  }
}

interface ChatGroupsListProps {
  groups: ChatGroupView[];
  activeGroupId: string | null;
  isLoading?: boolean;
  skeletonCount?: number;
  emptyState?: ReactNode | null;
  onSelectGroup: (groupId: string) => void;
  onCloseGroup: (groupId: string) => void;
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
  onSelectThread,
  onMoveThreadToGroup,
}: ChatGroupsListProps) {
  const [suppressCloseConfirmation, setSuppressCloseConfirmation] = useState(
    readCloseGroupConfirmationSuppressed,
  );
  const [confirmGroup, setConfirmGroup] = useState<ChatGroupView | null>(null);
  const [rememberSuppression, setRememberSuppression] = useState(false);
  const [dragOverGroupId, setDragOverGroupId] = useState<string | null>(null);
  const [openHoverGroupId, setOpenHoverGroupId] = useState<string | null>(null);
  const menuRef = useRef<HTMLUListElement | null>(null);
  useFlipList(menuRef, groups.map((group) => group.id).join("\n"));

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

  const confirmChatCount = confirmGroup?.member_count ?? 0;
  const confirmChatNoun = confirmChatCount === 1 ? "chat" : "chats";

  return (
    <>
      <SidebarMenu ref={menuRef}>
        {groups.map((group) => {
          const isActive = group.id === activeGroupId;
          return (
            <SidebarMenuItem key={group.id} data-flip-id={group.id}>
              <HoverCard
                open={openHoverGroupId === group.id}
                onOpenChange={(open) => setOpenHoverGroupId(open ? group.id : null)}
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
                      "group/chat-group cursor-pointer gap-2 !pr-2 select-none group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:[&_*]:pointer-events-none group-data-[collapsible=icon]:[&_*]:cursor-pointer",
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
                      setOpenHoverGroupId(null);
                      await onSelectThread?.(group.id, thread);
                    }}
                  />
                </HoverCardContent>
              </HoverCard>
              <SidebarMenuAction
                type="button"
                aria-label={`Close ${group.name}`}
                className="opacity-0 group-hover/menu-item:opacity-100"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  if (!suppressCloseConfirmation) {
                    setRememberSuppression(false);
                    setConfirmGroup(group);
                  } else {
                    onCloseGroup(group.id);
                  }
                }}
              >
                <X className="size-3" />
              </SidebarMenuAction>
            </SidebarMenuItem>
          );
        })}
      </SidebarMenu>

      <AlertDialog
        open={confirmGroup !== null}
        onOpenChange={(open) => {
          if (!open) {
            setConfirmGroup(null);
            setRememberSuppression(false);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Close "{confirmGroup?.name ?? "group"}"?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Its {confirmChatCount} {confirmChatNoun} will be removed from
              this group. You can reopen any of them from Chat History.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex items-center gap-2 pt-1">
            <Checkbox
              id="close-chat-group-confirmation-suppressed"
              checked={rememberSuppression}
              onCheckedChange={(checked) =>
                setRememberSuppression(checked === true)
              }
            />
            <label
              htmlFor="close-chat-group-confirmation-suppressed"
              className="text-sm leading-none text-muted-foreground"
            >
              Do not show again
            </label>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (rememberSuppression) {
                  setSuppressCloseConfirmation(true);
                  writeCloseGroupConfirmationSuppressed();
                }
                if (confirmGroup) onCloseGroup(confirmGroup.id);
                setConfirmGroup(null);
                setRememberSuppression(false);
              }}
            >
              Close group
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
