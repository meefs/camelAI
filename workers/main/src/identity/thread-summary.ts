import type { ThreadCompletionSummaryStatus } from "../../../../src/types";

export function normalizeThreadCompletionSummaryStatus(
  value: unknown,
): ThreadCompletionSummaryStatus | null {
  return value === "pending" || value === "ready" || value === "failed"
    ? value
    : null;
}
