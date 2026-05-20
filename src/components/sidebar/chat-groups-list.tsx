"use client";

import { useState } from "react";
import { Loader2, X } from "lucide-react";
import type { ChatGroupThreadSummary, ChatGroupView, ThreadStatus } from "@/types";
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
} from "@/components/ui/sidebar";
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
    <span className="ml-auto flex shrink-0 items-center gap-1.5 text-xs tabular-nums text-muted-foreground group-data-[collapsible=icon]:hidden">
      {status === "running" ? (
        <Loader2
          className="size-3 animate-spin text-blue-500 motion-reduce:animate-none"
          aria-label="Agent is working"
        />
      ) : status === "unread" ? (
        <span
          aria-label="Awaiting your review"
          className="size-1.5 rounded-full bg-red-500"
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

export function ChatGroupCollapsedIcon({ group }: { group: ChatGroupView }) {
  if (group.status === "running") {
    return (
      <Loader2
        className="hidden size-4 animate-spin text-blue-500 motion-reduce:animate-none group-data-[collapsible=icon]:block"
        aria-label="Agent is working"
      />
    );
  }
  if (group.status === "unread") {
    return (
      <span
        aria-label="Awaiting your review"
        className="hidden size-2 rounded-full bg-red-500 group-data-[collapsible=icon]:block"
      />
    );
  }
  const letter = (group.name?.trim()?.[0] ?? "?").toUpperCase();
  return (
    <span
      aria-hidden
      data-initial={letter}
      className="pointer-events-none hidden size-4 select-none place-items-center rounded bg-sidebar-accent text-[10px] font-medium leading-none text-sidebar-accent-foreground before:content-[attr(data-initial)] group-data-[collapsible=icon]:grid"
    />
  );
}

export function ChatGroupsList({
  groups,
  activeGroupId,
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

  if (groups.length === 0) {
    return (
      <div className="px-2 py-1.5 text-xs text-muted-foreground">
        No groups yet
      </div>
    );
  }

  const confirmChatCount = confirmGroup?.member_count ?? 0;
  const confirmChatNoun = confirmChatCount === 1 ? "chat" : "chats";

  return (
    <>
      <SidebarMenu>
        {groups.map((group) => {
          const isActive = group.id === activeGroupId;
          return (
            <SidebarMenuItem key={group.id}>
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
                    <ChatGroupCollapsedIcon group={group} />
                    <span className="min-w-0 flex-1 truncate text-left group-data-[collapsible=icon]:hidden">
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
