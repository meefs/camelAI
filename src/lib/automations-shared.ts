import type { Avatar } from "@/types";

export type AutomationKind = "agent_task" | "workflow";
export type AutomationStatusDot = "running" | "needs_input" | "failed" | null;
export type AutomationRuntimeStatus = "idle" | "running" | "needs_input";
export type AutomationLastRunStatus =
  | "success"
  | "busy"
  | "question"
  | "error"
  | "started"
  | null;

export interface AutomationRunSummary {
  id: string;
  status: "started" | "success" | "error" | "question" | "busy";
  started_at: number;
  completed_at: number | null;
  trigger: "schedule" | "manual";
  message: string | null;
  thread_id?: string | null;
  instance_id?: string | null;
}

/**
 * One page of an automation's run history, returned by
 * `/api/automations/:id/runs`. `id`/`kind` echo the request so the client can
 * discard responses for an automation it has since navigated away from.
 * `fromCursor` is the cursor this page was requested with (null = first page),
 * and `cursor` is the cursor for the next (older) page (null = end of history).
 */
export interface AutomationRunsPage {
  id: string;
  kind: AutomationKind;
  fromCursor: string | null;
  runs: AutomationRunSummary[];
  cursor: string | null;
}

/**
 * Loading phase for the panel's "Previous runs" list: `"page"` while the first
 * page loads (render a skeleton), `"more"` while an additional page loads
 * (spinner inside the "Show older runs" button), `null` when idle.
 */
export type RunsLoadingState = "page" | "more" | null;

export interface AutomationListItem {
  id: string;
  kind: AutomationKind;
  name: string;
  cron_expression: string;
  timezone: "UTC";
  enabled: boolean;
  can_manage: boolean;
  body: string;
  body_label: "Prompt" | "Description";
  next_run_at: number | null;
  last_run_at: number | null;
  last_run_status: AutomationLastRunStatus;
  last_run_error: string | null;
  runtime_status: AutomationRuntimeStatus;
  runtime_message: string | null;
  runtime_updated_at: number | null;
  thread_id: string | null;
  thread_exists: boolean | null;
  created_by_id: string;
  created_by_name: string | null;
  created_by_avatar: Avatar | null;
  model: string | null;
  source_version: number | null;
}

export const AUTOMATION_MANAGE_DISABLED_MESSAGE =
  "You do not have permission to manage this automation";

const WEEKDAY_NAMES = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function formatHourMinute(hour: number, minute: number): string {
  const period = hour >= 12 ? "PM" : "AM";
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12}:${String(minute).padStart(2, "0")} ${period}`;
}

export function formatCronExpression(
  expr: string,
  options: { timezoneLabel?: string } = {},
): string {
  const normalized = expr.trim().replace(/\s+/g, " ");
  const parts = normalized.split(" ");
  if (parts.length !== 5) return normalized;

  const [minuteRaw, hourRaw, dayOfMonth, month, dayOfWeek] = parts;
  const timezoneLabel = options.timezoneLabel;
  const suffix = timezoneLabel ? ` ${timezoneLabel}` : "";

  if (dayOfMonth !== "*" || month !== "*") return normalized;

  if (minuteRaw === "0" && hourRaw === "*" && dayOfWeek === "*") {
    return "Hourly";
  }

  const minuteStep = minuteRaw.match(/^\*\/(\d+)$/);
  if (minuteStep && hourRaw === "*" && dayOfWeek === "*") {
    return `Every ${minuteStep[1]} min`;
  }

  const hourStep = hourRaw.match(/^\*\/(\d+)$/);
  if (minuteRaw === "0" && hourStep && dayOfWeek === "*") {
    return `Every ${hourStep[1]} hours`;
  }

  const minute = Number(minuteRaw);
  const hour = Number(hourRaw);
  if (
    !Number.isInteger(minute) ||
    !Number.isInteger(hour) ||
    minute < 0 ||
    minute > 59 ||
    hour < 0 ||
    hour > 23
  ) {
    return normalized;
  }

  const time = formatHourMinute(hour, minute);
  if (dayOfWeek === "*") {
    return `Daily at ${time}${suffix}`;
  }

  const weekdays = dayOfWeek.split(",").map((part) => Number(part));
  if (
    weekdays.length > 0 &&
    weekdays.every((day) => Number.isInteger(day) && day >= 0 && day <= 6)
  ) {
    if (weekdays.length === 1) {
      return `${WEEKDAY_NAMES[weekdays[0]]} at ${time}${suffix}`;
    }
    const labels = weekdays.map((day) => WEEKDAY_SHORT[day]);
    const joined =
      labels.length === 2
        ? labels.join(" & ")
        : `${labels.slice(0, -1).join(", ")} & ${labels.at(-1)}`;
    return `${joined} at ${time}${suffix}`;
  }

  return normalized;
}

export function statusDotKind(item: AutomationListItem): AutomationStatusDot {
  if (item.runtime_status === "needs_input" || item.last_run_status === "question") {
    return "needs_input";
  }
  if (item.last_run_status === "error" || item.last_run_status === "busy") {
    return "failed";
  }
  if (
    item.runtime_status === "running" ||
    item.last_run_status === "started"
  ) {
    return "running";
  }
  return null;
}

export function statusDotMessage(item: AutomationListItem): string {
  const kind = statusDotKind(item);
  if (kind === "needs_input") {
    return item.runtime_message ?? "Waiting for your input";
  }
  if (kind === "failed") {
    if (item.last_run_status === "busy") {
      return item.last_run_error?.split("\n")[0] ?? "Thread is busy with another run";
    }
    return item.last_run_error?.split("\n")[0] ?? "Most recent run failed";
  }
  if (kind === "running") {
    return item.runtime_message ?? "Running now";
  }
  return "";
}

export function sortAutomations(items: AutomationListItem[]): AutomationListItem[] {
  const rank = (item: AutomationListItem): number => {
    const kind = statusDotKind(item);
    if (kind === "needs_input") return 0;
    if (kind === "failed") return 1;
    if (kind === "running") return 2;
    return 3;
  };

  return [...items].sort((a, b) => {
    const rankDelta = rank(a) - rank(b);
    if (rankDelta !== 0) return rankDelta;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}
