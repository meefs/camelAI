"use client";

import { useEffect, useRef } from "react";
import type { MouseEvent, ReactNode } from "react";
import { ExternalLink, MoreHorizontal, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  AUTOMATION_MANAGE_DISABLED_MESSAGE,
  formatCronExpression,
  statusDotKind,
  statusDotMessage,
  type AutomationListItem,
} from "@/lib/automations-shared";

function StatusDot({ automation }: { automation: AutomationListItem }) {
  const kind = statusDotKind(automation);
  if (!kind) return null;

  const message = statusDotMessage(automation);
  const color = {
    running: "bg-emerald-500",
    needs_input: "bg-amber-500",
    failed: "bg-red-500",
  }[kind];

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="relative inline-flex size-2 shrink-0" aria-label={message}>
          {kind === "running" ? (
            <span className="absolute inset-0 inline-flex animate-ping rounded-full bg-emerald-500 opacity-75" />
          ) : null}
          <span className={cn("relative inline-flex size-2 rounded-full", color)} />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">{message}</TooltipContent>
    </Tooltip>
  );
}

function RowAction({
  label,
  disabled,
  disabledReason,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  disabledReason?: string;
  onClick: (event: MouseEvent) => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
          >
            {children}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">{disabled ? disabledReason ?? label : label}</TooltipContent>
    </Tooltip>
  );
}

function ManagedMenuItem({
  disabled,
  variant,
  onSelect,
  children,
}: {
  disabled: boolean;
  variant?: "default" | "destructive";
  onSelect: () => void;
  children: ReactNode;
}) {
  const item = (
    <DropdownMenuItem
      variant={variant}
      disabled={disabled}
      onSelect={(event) => {
        event.stopPropagation();
        if (disabled) {
          event.preventDefault();
          return;
        }
        onSelect();
      }}
    >
      {children}
    </DropdownMenuItem>
  );

  if (!disabled) return item;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="block">{item}</span>
      </TooltipTrigger>
      <TooltipContent side="left">{AUTOMATION_MANAGE_DISABLED_MESSAGE}</TooltipContent>
    </Tooltip>
  );
}

interface AutomationRowProps {
  automation: AutomationListItem;
  isSelected: boolean;
  isRenaming: boolean;
  renameValue: string;
  onRenameValueChange: (value: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onSelect: () => void;
  onRun: () => void;
  onOpen: () => void;
  onStartRename: () => void;
  onDelete: () => void;
}

export function AutomationRow({
  automation,
  isSelected,
  isRenaming,
  renameValue,
  onRenameValueChange,
  onCommitRename,
  onCancelRename,
  onSelect,
  onRun,
  onOpen,
  onStartRename,
  onDelete,
}: AutomationRowProps) {
  const renameRef = useRef<HTMLDivElement | null>(null);
  const scheduleText = automation.enabled
    ? formatCronExpression(automation.cron_expression, {
        timezoneLabel: automation.timezone,
      })
    : "Paused";
  const openDisabled =
    automation.kind === "agent_task" && automation.thread_exists === false;
  const manageDisabled = !automation.can_manage;

  useEffect(() => {
    if (!isRenaming) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && renameRef.current?.contains(target)) return;
      onCommitRename();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [isRenaming, onCommitRename]);

  return (
    <div
      className={cn(
        "group/row relative flex cursor-pointer items-center gap-2 rounded-md px-3 py-3 transition-colors hover:bg-muted/50",
        isSelected && "bg-muted/70",
      )}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (isRenaming) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      {isRenaming ? (
        <div
          ref={renameRef}
          className="flex min-w-0 flex-1 items-center gap-2"
          onClick={(event) => event.stopPropagation()}
        >
          <Input
            value={renameValue}
            autoFocus
            className="h-7"
            onChange={(event) => onRenameValueChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                onCommitRename();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                onCancelRename();
              }
            }}
          />
          <Button
            type="button"
            size="sm"
            disabled={!renameValue.trim() || renameValue.trim() === automation.name}
            onClick={onCommitRename}
          >
            Save
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={onCancelRename}>
            Cancel
          </Button>
        </div>
      ) : (
        <>
          <StatusDot automation={automation} />
          <span className="min-w-0 flex-1 truncate text-sm">{automation.name}</span>
          <div className="relative flex h-7 min-w-[150px] items-center justify-end">
            <span
              className={cn(
                "absolute inset-0 flex items-center justify-end truncate text-sm text-muted-foreground transition-opacity duration-100 group-hover/row:opacity-0 group-focus-within/row:opacity-0",
                !automation.enabled && "text-muted-foreground",
              )}
            >
              {scheduleText}
            </span>
            <div className="absolute inset-0 flex items-center justify-end gap-0.5 opacity-0 transition-opacity duration-100 group-hover/row:opacity-100 group-focus-within/row:opacity-100">
              <RowAction
                label="Run now"
                disabled={manageDisabled}
                disabledReason={AUTOMATION_MANAGE_DISABLED_MESSAGE}
                onClick={(event) => {
                  event.stopPropagation();
                  onRun();
                }}
              >
                <Play />
              </RowAction>
              <RowAction
                label={automation.kind === "agent_task" ? "Open thread" : "Open in chat"}
                disabled={openDisabled}
                disabledReason="Original thread is unavailable"
                onClick={(event) => {
                  event.stopPropagation();
                  onOpen();
                }}
              >
                <ExternalLink />
              </RowAction>
              <DropdownMenu>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        aria-label="More"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                  </TooltipTrigger>
                  <TooltipContent side="top">More</TooltipContent>
                </Tooltip>
                <DropdownMenuContent align="end" className="w-36">
                  <ManagedMenuItem
                    disabled={manageDisabled}
                    onSelect={onStartRename}
                  >
                    Rename
                  </ManagedMenuItem>
                  <DropdownMenuSeparator />
                  <ManagedMenuItem
                    variant="destructive"
                    disabled={manageDisabled}
                    onSelect={onDelete}
                  >
                    Delete
                  </ManagedMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
