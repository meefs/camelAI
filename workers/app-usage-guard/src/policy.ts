import type { ScriptUsage } from "./telemetry.js";

export const USAGE_GUARD_POLICY_VERSION = "2026-07-13-v1";

export interface UsageWindow extends ScriptUsage {
  windowMinutes: 15 | 60 | 1440;
  estimatedCostUsd: number;
  runId: string | null;
  windowEnd: number;
}

export type PolicyDecision =
  | { action: "none" }
  | { action: "warn"; reason: string; window: UsageWindow }
  | { action: "suspend"; catastrophic: boolean; reason: string; window: UsageWindow };

const THRESHOLDS = {
  15: { warn: 0.5, suspend: 1, catastrophic: 5 },
  60: { warn: 1, suspend: 2, catastrophic: 10 },
  1440: { warn: 2.5, suspend: 5, catastrophic: 25 },
} as const;

export function estimatedSqliteCostUsd(usage: Pick<ScriptUsage, "rowsRead" | "rowsWritten">): number {
  return usage.rowsWritten / 1_000_000 + usage.rowsRead / 1_000_000 * 0.001;
}

export function evaluateUsage(windows: UsageWindow[]): PolicyDecision {
  let warning: UsageWindow | null = null;
  let suspension: UsageWindow | null = null;
  let catastrophic: UsageWindow | null = null;

  for (const window of windows) {
    const thresholds = THRESHOLDS[window.windowMinutes];
    if (window.estimatedCostUsd >= thresholds.warn && (!warning || window.estimatedCostUsd > warning.estimatedCostUsd)) {
      warning = window;
    }
    const rawWriteLimit = window.windowMinutes === 15 && window.rowsWritten >= 1_000_000;
    if ((window.estimatedCostUsd >= thresholds.suspend || rawWriteLimit) && (!suspension || window.estimatedCostUsd > suspension.estimatedCostUsd)) {
      suspension = window;
    }
    if (window.estimatedCostUsd >= thresholds.catastrophic && (!catastrophic || window.estimatedCostUsd > catastrophic.estimatedCostUsd)) {
      catastrophic = window;
    }
  }

  if (catastrophic) {
    return { action: "suspend", catastrophic: true, reason: "catastrophic_sqlite_usage", window: catastrophic };
  }
  if (suspension) {
    return { action: "suspend", catastrophic: false, reason: "sustained_sqlite_usage", window: suspension };
  }
  if (warning) return { action: "warn", reason: "elevated_sqlite_usage", window: warning };
  return { action: "none" };
}
