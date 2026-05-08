"use client";

import { useState } from "react";
import { Loader2, X } from "lucide-react";
import type { ChatGroupView, ThreadStatus } from "@/types";
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
import {
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

const THREAD_DRAG_MIME = "application/x-camelai-thread-id";

interface ChatGroupsListProps {
  groups: ChatGroupView[];
  activeGroupId: string | null;
  onSelectGroup: (groupId: string) => void;
  onCloseGroup: (groupId: string) => void;
  onMoveThreadToGroup?: (threadId: string, targetGroupId: string) => void;
}

export function ChatGroupRightSlot({
  status,
  count,
}: {
  status: ThreadStatus;
  count: number;
}) {
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
      <span className="tabular-nums" aria-label={`${count} chats`}>
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
      className="hidden size-4 cursor-pointer select-none place-items-center rounded bg-sidebar-accent text-[10px] font-medium text-sidebar-accent-foreground group-data-[collapsible=icon]:grid"
    >
      {letter}
    </span>
  );
}

export function ChatGroupsList({
  groups,
  activeGroupId,
  onSelectGroup,
  onCloseGroup,
  onMoveThreadToGroup,
}: ChatGroupsListProps) {
  const [confirmGroup, setConfirmGroup] = useState<ChatGroupView | null>(null);
  const [dragOverGroupId, setDragOverGroupId] = useState<string | null>(null);

  if (groups.length === 0) {
    return (
      <div className="px-2 py-1.5 text-xs text-muted-foreground">
        No groups yet
      </div>
    );
  }

  return (
    <>
      <SidebarMenu>
        {groups.map((group) => {
          const isActive = group.id === activeGroupId;
          const needsConfirm = group.member_count >= 2;
          return (
            <SidebarMenuItem key={group.id}>
              <SidebarMenuButton
                type="button"
                aria-label={group.name}
                isActive={isActive}
                tooltip={group.name}
                className={cn(
                  "group/chat-group h-7 cursor-pointer gap-2",
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
                  count={group.member_count}
                />
              </SidebarMenuButton>
              <SidebarMenuAction
                type="button"
                aria-label={`Close ${group.name}`}
                className="top-1/2 z-10 -translate-y-1/2 opacity-0 group-hover/menu-item:opacity-100"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  if (needsConfirm) {
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
          if (!open) setConfirmGroup(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Close "{confirmGroup?.name ?? "group"}"?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Its {confirmGroup?.member_count ?? 0} chats will be removed from
              this group. You can reopen any of them from Chat History.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (confirmGroup) onCloseGroup(confirmGroup.id);
                setConfirmGroup(null);
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
