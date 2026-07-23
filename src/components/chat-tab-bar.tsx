"use client";

import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate } from "react-router";
import {
  CircleFadingPlus,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  X,
} from "lucide-react";
import type { Avatar, ChatGroup, LlmModel, ThreadStatus } from "@/types";
import { ChatGroupAvatar } from "@/components/avatar/chat-group-avatar";
import { CamelLoader } from "@/components/camel-loader/camel-loader";
import { ModelLogo } from "@/components/model-logo";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  CloseChatGroupDialog,
  readCloseGroupConfirmationSuppressed,
} from "@/components/close-chat-group-dialog";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SidebarTrigger } from "@/components/ui/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const THREAD_DRAG_MIME = "application/x-camelai-thread-id";
const LazyRenameChatGroupDialog = lazy(() =>
  import("@/components/avatar/rename-chat-group-dialog").then((module) => ({
    default: module.RenameChatGroupDialog,
  })),
);
// Soft UI limit only: reopening closed chats can still take a group past this.
export const MAX_OPEN_CHAT_TABS_PER_GROUP = 10;

interface ChatTab {
  threadId: string;
  title: string;
  model: LlmModel;
  status?: ThreadStatus;
}

interface ChatTabBarProps {
  groupId: string;
  groupName: string;
  groupAvatar: Avatar;
  groupPinnedAt: number | null;
  groupMemberCount: number;
  openTabs: ChatTab[];
  closedTabs: ChatTab[];
  activeThreadId: string | null;
  moveGroups: readonly ChatGroup[];
  onSelectTab?: (threadId: string) => void;
  onCloseTab: (threadId: string) => void;
  onRenameTab: (threadId: string, name: string) => void;
  onReorderTabs: (orderedThreadIds: string[]) => void;
  onNewTab: () => void;
  onReopenClosedTab: (threadId: string) => void;
  onRenameGroup: (next: { name: string; avatar?: Avatar }) => void;
  onTogglePin: () => void;
  onCloseGroup: () => void;
  onMoveTabToGroup: (threadId: string, targetGroupId: string | "new") => void;
}

interface ChatTabBarLocalState {
  renamingThreadId: string | null;
  draftName: string;
  contextMenuResetVersion: number;
}

function displayThreadTitle(title: string): string {
  return title.trim() || "New chat";
}

export function TabRightSlot({
  status,
  model,
}: {
  status: ThreadStatus;
  model: LlmModel;
}) {
  if (status === "running") {
    return (
      <span className="text-muted-foreground">
        <CamelLoader size={16} ariaLabel="Agent is working" />
      </span>
    );
  }
  if (status === "unread") {
    return (
      <span
        aria-label="Awaiting your review"
        className="size-2.5 rounded-full bg-amber-500"
      />
    );
  }
  return <ModelLogo model={model} size={16} className="opacity-80" />;
}

export function ChatTabBar({
  groupId,
  groupName,
  groupAvatar,
  groupPinnedAt,
  groupMemberCount,
  openTabs,
  closedTabs,
  activeThreadId,
  moveGroups,
  onSelectTab,
  onCloseTab,
  onRenameTab,
  onReorderTabs,
  onNewTab,
  onReopenClosedTab,
  onRenameGroup,
  onTogglePin,
  onCloseGroup,
  onMoveTabToGroup,
}: ChatTabBarProps) {
  const navigate = useNavigate();
  const [localState, setLocalState] = useState<ChatTabBarLocalState>({
    renamingThreadId: null,
    draftName: "",
    contextMenuResetVersion: 0,
  });
  const { renamingThreadId, draftName, contextMenuResetVersion } = localState;
  const [isRenameGroupOpen, setIsRenameGroupOpen] = useState(false);
  const [isCloseGroupConfirmOpen, setIsCloseGroupConfirmOpen] = useState(false);
  const [hasOpenedRenameGroupDialog, setHasOpenedRenameGroupDialog] =
    useState(false);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const preventNextContextMenuFocusRestoreRef = useRef(false);
  const pendingContextMenuRenameTimeoutRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);

  useEffect(() => {
    return () => {
      if (pendingContextMenuRenameTimeoutRef.current !== null) {
        clearTimeout(pendingContextMenuRenameTimeoutRef.current);
      }
    };
  }, []);

  useLayoutEffect(() => {
    if (pendingContextMenuRenameTimeoutRef.current !== null) {
      clearTimeout(pendingContextMenuRenameTimeoutRef.current);
      pendingContextMenuRenameTimeoutRef.current = null;
    }
    setLocalState((prev) => ({
      renamingThreadId: null,
      draftName: "",
      contextMenuResetVersion: prev.contextMenuResetVersion + 1,
    }));
  }, [groupId]);

  useEffect(() => {
    if (!renamingThreadId) return;
    const timeout = setTimeout(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }, 0);
    return () => clearTimeout(timeout);
  }, [renamingThreadId]);

  const otherGroups = useMemo(
    () => moveGroups.filter((group) => group.id !== groupId),
    [groupId, moveGroups],
  );
  const isNewTabDisabled = openTabs.length >= MAX_OPEN_CHAT_TABS_PER_GROUP;
  const selectTab = (threadId: string) => {
    if (onSelectTab) {
      onSelectTab(threadId);
      return;
    }
    navigate(`/chat/${threadId}`, { preventScrollReset: true });
  };

  const submitThreadRename = (threadId: string) => {
    const nextName = draftName.trim();
    if (nextName) onRenameTab(threadId, nextName);
    setLocalState((prev) => ({
      ...prev,
      renamingThreadId: null,
      draftName: "",
    }));
  };

  const startThreadRename = (
    threadId: string,
    title: string,
    options: { fromContextMenu?: boolean } = {},
  ) => {
    if (options.fromContextMenu) {
      preventNextContextMenuFocusRestoreRef.current = true;
      if (pendingContextMenuRenameTimeoutRef.current !== null) {
        clearTimeout(pendingContextMenuRenameTimeoutRef.current);
      }
      pendingContextMenuRenameTimeoutRef.current = setTimeout(() => {
        pendingContextMenuRenameTimeoutRef.current = null;
        setLocalState((prev) => ({
          ...prev,
          draftName: title,
          renamingThreadId: threadId,
        }));
      }, 0);
      return;
    }
    setLocalState((prev) => ({
      ...prev,
      draftName: title,
      renamingThreadId: threadId,
    }));
  };

  return (
    <div className="shrink-0 [--safe-area-padding-top:5px] pt-safe">
      <div className="relative flex h-9 items-end gap-0 bg-muted/20 pl-2 pr-1 shadow-[inset_0_-1px_0_0_var(--border)]">
      <div className="mr-1 flex h-9 shrink-0 items-center pb-0.5 md:hidden">
        <SidebarTrigger />
      </div>
      <div className="flex min-w-0 flex-1 items-end gap-0 overflow-x-auto whitespace-nowrap">
        {openTabs.map((tab, index) => {
          const isActive = tab.threadId === activeThreadId;
          const isRenaming = renamingThreadId === tab.threadId;
          const tabTitle = displayThreadTitle(tab.title);
          const tabStatus =
            isActive && tab.status === "unread" ? "idle" : tab.status ?? "idle";
          return (
            <ContextMenu key={`${tab.threadId}:${contextMenuResetVersion}`}>
              <ContextMenuTrigger asChild>
                <div
                  role="button"
                  tabIndex={0}
                  aria-label={`Open ${tabTitle}`}
                  draggable
                  onClick={() => selectTab(tab.threadId)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      selectTab(tab.threadId);
                    }
                  }}
                  onDragStart={(event) => {
                    event.dataTransfer.setData(THREAD_DRAG_MIME, tab.threadId);
                    event.dataTransfer.effectAllowed = "move";
                  }}
                  onDragOver={(event) => {
                    if (event.dataTransfer.types.includes(THREAD_DRAG_MIME)) {
                      event.preventDefault();
                    }
                  }}
                  onDrop={(event) => {
                    const draggedThreadId =
                      event.dataTransfer.getData(THREAD_DRAG_MIME);
                    if (!draggedThreadId || draggedThreadId === tab.threadId) return;
                    event.preventDefault();
                    const nextOrder = openTabs
                      .map((entry) => entry.threadId)
                      .filter((threadId) => threadId !== draggedThreadId);
                    nextOrder.splice(index, 0, draggedThreadId);
                    onReorderTabs(nextOrder);
                  }}
                  className={cn(
                    "group/tab relative flex w-44 shrink-0 cursor-pointer items-center gap-2 rounded-t-md pl-2 pr-2 text-xs outline-none transition-[height,background-color,color] duration-150",
                    isActive
                      ? "z-10 h-9 border border-b-0 bg-background pb-0.5 font-medium text-foreground"
                      : "h-9 bg-transparent pb-0.5 text-muted-foreground hover:text-foreground",
                  )}
                >
                  <span className="grid size-4 shrink-0 place-items-center">
                    <TabRightSlot
                      status={tabStatus}
                      model={tab.model}
                    />
                  </span>
                  {isRenaming ? (
                    <Input
                      ref={renameInputRef}
                      autoFocus
                      value={draftName}
                      onChange={(event) =>
                        setLocalState((prev) => ({
                          ...prev,
                          draftName: event.target.value,
                        }))
                      }
                      onClick={(event) => event.stopPropagation()}
                      onKeyDown={(event) => {
                        event.stopPropagation();
                        if (event.key === "Enter") submitThreadRename(tab.threadId);
                        if (event.key === "Escape") {
                          setLocalState((prev) => ({
                            ...prev,
                            renamingThreadId: null,
                          }));
                        }
                      }}
                      onBlur={() => submitThreadRename(tab.threadId)}
                      className="h-6 min-w-0 flex-1"
                    />
                  ) : (
                    <span className="min-w-0 flex-1 truncate text-left">
                      {tabTitle}
                    </span>
                  )}
                  {!isRenaming ? (
                    <>
                      <span
                        aria-hidden
                        className={cn(
                          "pointer-events-none absolute inset-y-px right-0 w-12 rounded-tr-[calc(var(--radius-md)-1px)] opacity-0 transition-opacity group-hover/tab:opacity-100 focus-within:opacity-100",
                          isActive
                            ? "bg-background"
                            : "bg-[color-mix(in_srgb,var(--muted)_20%,var(--background))]",
                        )}
                      />
                      <span
                        aria-hidden
                        className={cn(
                          "pointer-events-none absolute inset-y-px right-12 w-2.5 opacity-0 transition-opacity group-hover/tab:opacity-100 focus-within:opacity-100",
                          isActive
                            ? "bg-gradient-to-l from-background to-transparent"
                            : "bg-gradient-to-l from-[color-mix(in_srgb,var(--muted)_20%,var(--background))] to-transparent",
                        )}
                      />
                      <span className="absolute inset-y-0 right-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover/tab:opacity-100 focus-within:opacity-100">
                        <button
                          type="button"
                          aria-label={`Rename ${tabTitle}`}
                          className="grid size-5 place-items-center rounded-sm text-muted-foreground hover:text-foreground"
                          onClick={(event) => {
                            event.stopPropagation();
                            startThreadRename(tab.threadId, tabTitle);
                          }}
                        >
                          <Pencil className="size-3" />
                        </button>
                        <button
                          type="button"
                          aria-label={`Close ${tabTitle}`}
                          className="grid size-5 place-items-center rounded-sm text-muted-foreground hover:text-foreground"
                          onClick={(event) => {
                            event.stopPropagation();
                            onCloseTab(tab.threadId);
                          }}
                        >
                          <X className="size-3" />
                        </button>
                      </span>
                    </>
                  ) : null}
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent
                onCloseAutoFocus={(event) => {
                  if (!preventNextContextMenuFocusRestoreRef.current) return;
                  preventNextContextMenuFocusRestoreRef.current = false;
                  event.preventDefault();
                }}
              >
                <ContextMenuItem onSelect={() => onCloseTab(tab.threadId)}>
                  Close tab
                </ContextMenuItem>
                <ContextMenuItem
                  onPointerDown={(event) => {
                    if (event.button !== 0) return;
                    startThreadRename(tab.threadId, tabTitle, {
                      fromContextMenu: true,
                    });
                  }}
                  onSelect={() => {
                    startThreadRename(tab.threadId, tabTitle, {
                      fromContextMenu: true,
                    });
                  }}
                >
                  Rename chat
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuSub>
                  <ContextMenuSubTrigger>Move to group</ContextMenuSubTrigger>
                  <ContextMenuSubContent className="max-h-72 overflow-y-auto">
                    {otherGroups.map((group) => (
                      <ContextMenuItem
                        key={group.id}
                        onSelect={() => {
                          setLocalState((prev) => ({
                            ...prev,
                            contextMenuResetVersion:
                              prev.contextMenuResetVersion + 1,
                          }));
                          onMoveTabToGroup(tab.threadId, group.id);
                        }}
                      >
                        <ChatGroupAvatar
                          avatar={group.avatar}
                          fallbackName={group.name}
                          size="sm"
                        />
                        <span className="min-w-0 truncate">
                          {group.name || "Untitled group"}
                        </span>
                      </ContextMenuItem>
                    ))}
                    {otherGroups.length > 0 ? <ContextMenuSeparator /> : null}
                    <ContextMenuItem
                      onSelect={() => {
                        setLocalState((prev) => ({
                          ...prev,
                          contextMenuResetVersion:
                            prev.contextMenuResetVersion + 1,
                        }));
                        onMoveTabToGroup(tab.threadId, "new");
                      }}
                    >
                      New group
                    </ContextMenuItem>
                  </ContextMenuSubContent>
                </ContextMenuSub>
              </ContextMenuContent>
            </ContextMenu>
          );
        })}
        {isNewTabDisabled ? (
          <Button
            type="button"
            aria-label="New chat in this group"
            variant="ghost"
            size="icon-sm"
            className="mb-0.5 ml-0.5 h-8 w-8 shrink-0 rounded-t-md text-muted-foreground"
            disabled
            onClick={onNewTab}
          >
            <Plus className="size-4" />
          </Button>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                aria-label="New chat in this group"
                variant="ghost"
                size="icon-sm"
                className="mb-0.5 ml-0.5 h-8 w-8 shrink-0 rounded-t-md text-muted-foreground hover:text-foreground"
                onClick={onNewTab}
              >
                <Plus className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>New chat</TooltipContent>
          </Tooltip>
        )}
      </div>
      <div className="mb-0.5 ml-1 flex shrink-0 items-center gap-0">
        {closedTabs.length > 0 ? (
          <Popover>
            <Tooltip>
              <TooltipTrigger asChild>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    aria-label="Closed chat tabs"
                    variant="ghost"
                    size="icon-xs"
                    className="h-8 w-8 rounded-t-md"
                  >
                    <CircleFadingPlus className="size-4" />
                  </Button>
                </PopoverTrigger>
              </TooltipTrigger>
              <TooltipContent>Closed chats</TooltipContent>
            </Tooltip>
            <PopoverContent align="end" className="w-64 p-1">
              <Command>
                <CommandInput placeholder="Search closed chats" />
                <CommandList>
                  <CommandEmpty>No closed chats</CommandEmpty>
                  <CommandGroup>
                    {closedTabs.map((tab) => (
                      <CommandItem
                        key={tab.threadId}
                        value={displayThreadTitle(tab.title)}
                        onSelect={() => onReopenClosedTab(tab.threadId)}
                      >
                        <span className="truncate">
                          {displayThreadTitle(tab.title)}
                        </span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        ) : null}
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  aria-label="Group options"
                  variant="ghost"
                  size="icon-xs"
                  className="h-8 w-8 rounded-t-md"
                >
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>Settings</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem onSelect={onTogglePin}>
              {groupPinnedAt !== null ? <PinOff /> : <Pin />}
              {groupPinnedAt !== null ? "Unpin group" : "Pin group"}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => {
                setHasOpenedRenameGroupDialog(true);
                setIsRenameGroupOpen(true);
              }}
            >
              <Pencil />
              Rename group
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => {
                if (readCloseGroupConfirmationSuppressed()) {
                  onCloseGroup();
                } else {
                  setIsCloseGroupConfirmOpen(true);
                }
              }}
            >
              <X />
              Close group
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {hasOpenedRenameGroupDialog ? (
        <Suspense fallback={null}>
          <LazyRenameChatGroupDialog
            open={isRenameGroupOpen}
            onOpenChange={setIsRenameGroupOpen}
            initialName={groupName}
            initialAvatar={groupAvatar}
            onSubmit={onRenameGroup}
          />
        </Suspense>
      ) : null}
      <CloseChatGroupDialog
        open={isCloseGroupConfirmOpen}
        onOpenChange={setIsCloseGroupConfirmOpen}
        groupName={groupName}
        chatCount={groupMemberCount}
        onConfirm={onCloseGroup}
      />
      </div>
    </div>
  );
}
