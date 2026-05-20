"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { ChatGroupThreadSummary, ChatGroupView } from "@/types";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import {
  formatHoverRelativeTime,
  formatRunningElapsed,
} from "@/lib/chat-group-hover-time";
import { cn } from "@/lib/utils";

interface ChatGroupHoverCardProps {
  group: ChatGroupView;
  onSelectThread: (thread: ChatGroupThreadSummary) => void | Promise<void>;
}

interface RowProps {
  thread: ChatGroupThreadSummary;
  onSelect: (thread: ChatGroupThreadSummary) => void | Promise<void>;
  isPending?: boolean;
}

function getInProgressUserMessageSortAt(thread: ChatGroupThreadSummary): number {
  return (
    thread.latest_user_message_at ??
    thread.running_started_at ??
    thread.updated_at
  );
}

export function splitThreadsBySection(group: ChatGroupView) {
  const all = [...group.open_threads, ...group.closed_threads];
  const inProgress = all
    .filter((thread) => thread.status === "running")
    .sort(
      (a, b) =>
        getInProgressUserMessageSortAt(b) - getInProgressUserMessageSortAt(a),
    );
  const completed = all
    .filter((thread) => thread.status === "unread")
    .sort(
      (a, b) =>
        (b.last_assistant_completed_at ?? b.updated_at) -
        (a.last_assistant_completed_at ?? a.updated_at),
    );
  const quiet = all
    .filter((thread) => thread.status === "idle")
    .sort((a, b) => b.last_active_at - a.last_active_at);

  return { inProgress, completed, quiet };
}

export function ChatGroupHoverCard({
  group,
  onSelectThread,
}: ChatGroupHoverCardProps) {
  const sections = useMemo(() => splitThreadsBySection(group), [group]);
  const [pendingThreadId, setPendingThreadId] = useState<string | null>(null);
  const total = group.member_count;
  const noun = total === 1 ? "chat" : "chats";

  const handleSelectThread = async (thread: ChatGroupThreadSummary) => {
    setPendingThreadId(thread.id);
    try {
      await onSelectThread(thread);
    } finally {
      setPendingThreadId(null);
    }
  };

  return (
    <div className="flex flex-col">
      <div className="flex items-baseline justify-between gap-3 px-3 pt-3 pb-2">
        <div className="min-w-0 flex-1 truncate text-sm font-semibold text-popover-foreground">
          {group.name}
        </div>
        <div className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {total} {noun}
        </div>
      </div>

      <ScrollArea
        className="max-h-[26rem]"
        viewportClassName="px-1 pb-2 [&>div]:!block [&>div]:!w-full"
      >
        {sections.inProgress.length > 0 && (
          <HoverSection label="In progress">
            {sections.inProgress.map((thread) => (
              <InProgressRow
                key={thread.id}
                thread={thread}
                onSelect={handleSelectThread}
                isPending={pendingThreadId === thread.id}
              />
            ))}
          </HoverSection>
        )}
        {sections.completed.length > 0 && (
          <HoverSection label="Completed">
            {sections.completed.map((thread) => (
              <CompletedRow
                key={thread.id}
                thread={thread}
                onSelect={handleSelectThread}
                isPending={pendingThreadId === thread.id}
              />
            ))}
          </HoverSection>
        )}
        {sections.quiet.length > 0 && (
          <HoverSection label="Quiet">
            {sections.quiet.map((thread) => (
              <QuietRow
                key={thread.id}
                thread={thread}
                onSelect={handleSelectThread}
                isPending={pendingThreadId === thread.id}
              />
            ))}
          </HoverSection>
        )}
        {total === 0 && (
          <div className="px-2 py-3 text-xs text-muted-foreground">
            No chats in this group yet.
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

function HoverSection({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="px-2 pt-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="flex flex-col">{children}</div>
    </div>
  );
}

function HoverRow({
  onClick,
  isPending,
  children,
}: {
  onClick: () => void;
  isPending?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isPending}
      className={cn(
        "group/hover-row flex w-full min-w-0 max-w-full flex-col gap-0.5 overflow-hidden rounded-md px-2 py-1.5 text-left",
        "transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none",
        isPending && "opacity-60",
      )}
    >
      {children}
    </button>
  );
}

function InProgressRow({ thread, onSelect, isPending }: RowProps) {
  const activityText =
    thread.running_activity_text?.trim() || thread.latest_user_message?.trim() || "";

  return (
    <HoverRow onClick={() => void onSelect(thread)} isPending={isPending}>
      <div className="flex w-full min-w-0 max-w-full items-center gap-2">
        <StatusDot status="running" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-popover-foreground">
          {thread.title || "New chat"}
        </span>
        <RunningTimerSlot startedAt={thread.running_started_at} />
      </div>
      {activityText && (
        <div className="w-full min-w-0 max-w-full truncate text-xs text-muted-foreground">
          {activityText}
        </div>
      )}
    </HoverRow>
  );
}

function CompletedRow({ thread, onSelect, isPending }: RowProps) {
  const timestamp = thread.last_assistant_completed_at ?? thread.updated_at;
  return (
    <HoverRow onClick={() => void onSelect(thread)} isPending={isPending}>
      <div className="flex w-full min-w-0 max-w-full items-center gap-2">
        <StatusDot status="unread" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-popover-foreground">
          {thread.title || "New chat"}
        </span>
        <time
          dateTime={new Date(timestamp).toISOString()}
          className="shrink-0 text-xs tabular-nums text-muted-foreground"
        >
          {formatHoverRelativeTime(timestamp)}
        </time>
      </div>
      <CompletedRowSubheader thread={thread} />
    </HoverRow>
  );
}

function CompletedRowSubheader({ thread }: { thread: ChatGroupThreadSummary }) {
  const text = thread.last_assistant_summary?.trim() ?? "";
  if (text) {
    return (
      <div className="line-clamp-2 w-full min-w-0 max-w-full break-words text-xs leading-snug text-muted-foreground">
        {thread.last_assistant_summary}
      </div>
    );
  }

  if (thread.last_assistant_summary_status === "pending") {
    return (
      <div
        role="status"
        aria-label="Generating summary"
        className="flex min-h-[2.0625rem] w-full min-w-0 max-w-full flex-col justify-center gap-1.5"
      >
        <Skeleton className="h-2.5 w-full motion-reduce:animate-none" />
        <Skeleton className="h-2.5 w-3/5 motion-reduce:animate-none" />
      </div>
    );
  }

  return null;
}

function QuietRow({ thread, onSelect, isPending }: RowProps) {
  return (
    <HoverRow onClick={() => void onSelect(thread)} isPending={isPending}>
      <div className="flex w-full min-w-0 max-w-full items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {thread.title || "New chat"}
        </span>
        <time
          dateTime={new Date(thread.last_active_at).toISOString()}
          className="shrink-0 text-xs tabular-nums text-muted-foreground"
        >
          {formatHoverRelativeTime(thread.last_active_at)}
        </time>
      </div>
    </HoverRow>
  );
}

function StatusDot({ status }: { status: "running" | "unread" }) {
  if (status === "running") {
    return (
      <span
        aria-label="Agent is working"
        className="size-1.5 shrink-0 rounded-full bg-blue-500"
      />
    );
  }
  return (
    <span
      aria-label="Awaiting your review"
      className="size-1.5 shrink-0 rounded-full bg-red-500"
    />
  );
}

function RunningTimerSlot({ startedAt }: { startedAt: number | null }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (startedAt === null) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [startedAt]);

  return (
    <span
      aria-hidden="true"
      className="shrink-0 text-xs tabular-nums text-muted-foreground"
      style={{ minWidth: "3.25rem", textAlign: "right" }}
    >
      {startedAt === null ? <>&mdash;</> : formatRunningElapsed(startedAt, now)}
    </span>
  );
}
