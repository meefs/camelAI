import type { ThreadStatus } from "@/types";

export function threadStatusPriority(status: ThreadStatus): number {
  if (status === "running") return 2;
  if (status === "unread") return 1;
  return 0;
}

export function maxThreadStatus(statuses: ThreadStatus[]): ThreadStatus {
  return statuses.reduce<ThreadStatus>(
    (current, next) =>
      threadStatusPriority(next) > threadStatusPriority(current)
        ? next
        : current,
    "idle",
  );
}
