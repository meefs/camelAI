"use client";

import {
  Code2,
  ExternalLink,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  Play,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import { MODEL_CATALOG } from "@/lib/model-catalog";
import type { LlmModel } from "@/types";
import { ModelLogo } from "@/components/model-logo";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { generateDefaultAvatar, getContrastTextColor } from "@/lib/avatar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  AUTOMATION_MANAGE_DISABLED_MESSAGE,
  formatCronExpression,
  type AutomationListItem,
  type AutomationRunSummary,
  type RunsLoadingState,
} from "@/lib/automations-shared";
import { cn } from "@/lib/utils";

const TYPE_COPY = {
  agent_task:
    "An agent task is a scheduled prompt that wakes up a chat thread on a cadence. The agent runs in a thread you can join, nudge, or correct.",
  workflow:
    "A workflow is deterministic JavaScript that runs on a schedule. It executes exactly the same way every time. Good for retries, exports, and integrations.",
} as const;

const RELATIVE_TIME_FORMATTER = new Intl.RelativeTimeFormat(undefined, {
  numeric: "auto",
});

const ABSOLUTE_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "UTC",
  timeZoneName: "short",
});

function formatRelativeTime(timestamp: number | null, now: number): string {
  if (!timestamp) return "Never";
  const deltaMs = timestamp - now;
  const absMs = Math.abs(deltaMs);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["day", 86_400_000],
    ["hour", 3_600_000],
    ["minute", 60_000],
  ];
  for (const [unit, size] of units) {
    if (absMs >= size) {
      return RELATIVE_TIME_FORMATTER.format(Math.round(deltaMs / size), unit);
    }
  }
  return "just now";
}

function formatAbsoluteTime(timestamp: number | null): string {
  if (!timestamp) return "Never";
  return ABSOLUTE_TIME_FORMATTER.format(new Date(timestamp));
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_1fr] gap-3 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right text-foreground">{children}</dd>
    </div>
  );
}

function CreatedBy({ automation }: { automation: AutomationListItem }) {
  const label = automation.created_by_name ?? "Unknown";
  const avatar =
    automation.created_by_avatar ??
    generateDefaultAvatar(automation.created_by_name ?? automation.created_by_id);
  return (
    <span className="inline-flex items-center justify-end gap-1.5">
      <Avatar size="xs">
        <AvatarFallback
          content={avatar.content}
          style={{
            backgroundColor: avatar.color,
            color: getContrastTextColor(avatar.color),
          }}
        >
          {avatar.content}
        </AvatarFallback>
      </Avatar>
      <span className="truncate">{label}</span>
    </span>
  );
}

function runLabel(run: AutomationRunSummary): string {
  if (run.status === "success") return "Completed";
  if (run.status === "error") return "Failed";
  if (run.status === "question") return "Asked a question";
  if (run.status === "busy") return "Blocked";
  if (run.status === "started") return "Running";
  return "Running";
}

function RunDot({ status }: { status: AutomationRunSummary["status"] }) {
  if (status === "started") {
    return (
      <span className="relative inline-flex size-1.5 shrink-0">
        <span className="absolute inset-0 inline-flex animate-ping rounded-full bg-emerald-500 opacity-75" />
        <span className="relative inline-flex size-1.5 rounded-full bg-emerald-500" />
      </span>
    );
  }
  const color =
    status === "success"
      ? "bg-emerald-500"
      : status === "error" || status === "busy"
        ? "bg-red-500"
        : status === "question"
          ? "bg-amber-500"
          : "bg-muted-foreground";
  return <span className={cn("size-1.5 shrink-0 rounded-full", color)} />;
}

function PreviousRunsSkeleton() {
  return (
    <div className="space-y-2" aria-busy="true">
      {[0, 1, 2, 3].map((index) => (
        <div key={index} className="flex items-center gap-2">
          <Skeleton className="size-1.5 shrink-0 rounded-full" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-12 shrink-0" />
        </div>
      ))}
    </div>
  );
}

function PreviousRuns({
  runs,
  now,
  loading,
  hasMore,
  onLoadMore,
}: {
  runs: AutomationRunSummary[];
  now: number;
  loading: RunsLoadingState;
  hasMore: boolean;
  onLoadMore: () => void;
}) {
  if (loading === "page") {
    return <PreviousRunsSkeleton />;
  }
  if (runs.length === 0) {
    return <p className="text-sm text-muted-foreground">No previous runs.</p>;
  }
  return (
    <div className="space-y-2">
      {runs.map((run) => (
        <div key={run.id} className="flex items-center gap-2 text-sm">
          <RunDot status={run.status} />
          <span className="min-w-0 flex-1 truncate">{run.message ?? runLabel(run)}</span>
          <span className="shrink-0 text-muted-foreground">
            {formatRelativeTime(run.completed_at ?? run.started_at, now)}
          </span>
        </div>
      ))}
      {hasMore ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mt-1 h-8 w-full justify-center text-xs font-normal text-muted-foreground hover:text-foreground"
          disabled={loading === "more"}
          onClick={onLoadMore}
        >
          {loading === "more" ? (
            <>
              <Loader2 className="size-3.5 animate-spin" />
              Loading…
            </>
          ) : (
            "Show older runs"
          )}
        </Button>
      ) : null}
    </div>
  );
}

function AutomationTypeChip({ automation }: { automation: AutomationListItem }) {
  const Icon = automation.kind === "agent_task" ? MessageSquare : Code2;
  const label = automation.kind === "agent_task" ? "Agent task" : "Workflow";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-background/40 px-2.5 py-1 text-xs font-normal text-muted-foreground">
          <Icon className="size-3.5" />
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-72">
        {TYPE_COPY[automation.kind]}
      </TooltipContent>
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

interface AutomationPanelProps {
  automation: AutomationListItem;
  now: number;
  runs: AutomationRunSummary[];
  runsLoading: RunsLoadingState;
  hasMoreRuns: boolean;
  onLoadMoreRuns: () => void;
  onClose: () => void;
  onRun: (automation: AutomationListItem) => void;
  onOpen: (automation: AutomationListItem) => void;
  onToggleEnabled: (automation: AutomationListItem, enabled: boolean) => void;
  onStartRename: (automation: AutomationListItem) => void;
  onDelete: (automation: AutomationListItem) => void;
}

export function AutomationPanel({
  automation,
  now,
  runs,
  runsLoading,
  hasMoreRuns,
  onLoadMoreRuns,
  onClose,
  onRun,
  onOpen,
  onToggleEnabled,
  onStartRename,
  onDelete,
}: AutomationPanelProps) {
  const staleThread =
    automation.kind === "agent_task" && automation.thread_exists === false;
  const model =
    automation.model && automation.model in MODEL_CATALOG
      ? (automation.model as LlmModel)
      : null;
  const manageDisabled = !automation.can_manage;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex shrink-0 items-center justify-between gap-3 px-6 py-5">
        <AutomationTypeChip automation={automation} />
        <div className="flex items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="ghost" size="icon" aria-label="More">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-36">
              <ManagedMenuItem
                disabled={manageDisabled}
                onSelect={() => onStartRename(automation)}
              >
                Rename
              </ManagedMenuItem>
              <DropdownMenuSeparator />
              <ManagedMenuItem
                variant="destructive"
                disabled={manageDisabled}
                onSelect={() => onDelete(automation)}
              >
                Delete
              </ManagedMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button type="button" variant="ghost" size="icon" aria-label="Close" onClick={onClose}>
            <X />
          </Button>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-7 px-6 py-6">
          <div>
            <h2 className="text-2xl font-semibold leading-tight">{automation.name}</h2>
          </div>

          <section>
            <h3 className="text-xs font-medium uppercase text-muted-foreground">
              {automation.body_label}
            </h3>
            <p className="mt-2 whitespace-pre-wrap text-sm leading-6">{automation.body}</p>
          </section>

          <div className="flex flex-wrap items-center gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={staleThread}
                    onClick={() => onOpen(automation)}
                  >
                    <ExternalLink />
                    {automation.kind === "agent_task" ? "Open thread" : "Open in chat"}
                  </Button>
                </span>
              </TooltipTrigger>
              {staleThread ? (
                <TooltipContent>Original thread is unavailable</TooltipContent>
              ) : null}
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={manageDisabled}
                    onClick={() => onRun(automation)}
                  >
                    <Play />
                    Run now
                  </Button>
                </span>
              </TooltipTrigger>
              {manageDisabled ? (
                <TooltipContent>{AUTOMATION_MANAGE_DISABLED_MESSAGE}</TooltipContent>
              ) : null}
            </Tooltip>
            <div className="ml-auto flex items-center gap-2 text-sm leading-none">
              <span className="text-muted-foreground">
                {automation.enabled ? "Active" : "Paused"}
              </span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex items-center">
                    <Switch
                      checked={automation.enabled}
                      disabled={manageDisabled}
                      onCheckedChange={(checked) => onToggleEnabled(automation, checked)}
                      aria-label={automation.enabled ? "Pause automation" : "Resume automation"}
                      className="data-checked:bg-emerald-500"
                      thumbClassName="dark:data-checked:bg-foreground"
                    />
                  </span>
                </TooltipTrigger>
                {manageDisabled ? (
                  <TooltipContent>{AUTOMATION_MANAGE_DISABLED_MESSAGE}</TooltipContent>
                ) : null}
              </Tooltip>
            </div>
          </div>

          {staleThread ? (
            <p className="text-sm text-muted-foreground">
              Original thread is unavailable. Run now will create a replacement thread.
            </p>
          ) : null}

          <section>
            <h3 className="mb-3 text-xs font-medium uppercase text-muted-foreground">
              Schedule
            </h3>
            <dl className="space-y-2">
              <DetailRow label="Repeats">
                {formatCronExpression(automation.cron_expression, {
                  timezoneLabel: automation.timezone,
                })}
              </DetailRow>
              <DetailRow label="Next run">
                {automation.enabled ? formatAbsoluteTime(automation.next_run_at) : "Paused"}
              </DetailRow>
              <DetailRow label="Last ran">
                {formatRelativeTime(automation.last_run_at, now)}
              </DetailRow>
            </dl>
          </section>

          {automation.last_run_status === "error" && automation.last_run_error ? (
            <section>
              <h3 className="mb-3 text-xs font-medium uppercase text-muted-foreground">
                Last error
              </h3>
              <pre className="max-h-36 overflow-auto rounded-md border border-destructive/30 bg-destructive/10 p-3 font-mono text-xs text-destructive">
                {automation.last_run_error}
              </pre>
            </section>
          ) : null}

          <section>
            <h3 className="mb-3 text-xs font-medium uppercase text-muted-foreground">
              Details
            </h3>
            <dl className="space-y-2">
              {automation.kind === "agent_task" ? (
                <DetailRow label="Model">
                  {model ? (
                    <span className="inline-flex items-center justify-end gap-1.5">
                      <ModelLogo model={model} size={14} />
                      <span className="truncate">{automation.model}</span>
                    </span>
                  ) : (
                    automation.model ?? "Unknown"
                  )}
                </DetailRow>
              ) : (
                <DetailRow label="Source version">
                  {automation.source_version ?? "Unknown"}
                </DetailRow>
              )}
              <DetailRow label="Created by">
                <CreatedBy automation={automation} />
              </DetailRow>
            </dl>
          </section>

          <section>
            <h3 className="mb-3 text-xs font-medium uppercase text-muted-foreground">
              Previous runs
            </h3>
            <PreviousRuns
              runs={runs}
              now={now}
              loading={runsLoading}
              hasMore={hasMoreRuns}
              onLoadMore={onLoadMoreRuns}
            />
          </section>
        </div>
      </ScrollArea>
    </div>
  );
}
