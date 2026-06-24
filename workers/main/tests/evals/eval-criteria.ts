export type EvalCriterionStatus = "passed" | "failed";

export interface EvalPassFailCriterion {
  id: string;
  label: string;
  status: EvalCriterionStatus;
  reason?: string;
  details?: unknown;
}

export interface EvalScoreCriterion {
  id: string;
  label: string;
  points: number;
  maxPoints: number;
  reason?: string;
  details?: unknown;
}

export interface EvalCriteriaSummary {
  passFail: {
    passed: boolean;
    total: number;
    failed: number;
    criteria: EvalPassFailCriterion[];
  };
  scorecard: {
    points: number;
    maxPoints: number;
    percentage: number;
    criteria: EvalScoreCriterion[];
  };
}

export interface SignalEfficiencyTier {
  maxAssistantTurns: number;
  maxBadToolCalls: number;
  points: number;
}

export interface SignalEfficiencyOptions {
  id?: string;
  label?: string;
  maxPoints: number;
  tiers: SignalEfficiencyTier[];
  fallbackPoints?: number;
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function finiteNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number`);
  }
  return value;
}

function withOptionalFields<T extends Record<string, unknown>>(
  base: T,
  input: { reason?: string; details?: unknown },
): T & { reason?: string; details?: unknown } {
  return {
    ...base,
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
    ...(input.details !== undefined ? { details: input.details } : {}),
  };
}

function validatePassFailCriterion(
  criterion: EvalPassFailCriterion,
): EvalPassFailCriterion {
  nonEmptyString(criterion.id, "pass/fail criterion id");
  nonEmptyString(criterion.label, "pass/fail criterion label");
  if (criterion.status !== "passed" && criterion.status !== "failed") {
    throw new Error(
      `pass/fail criterion ${criterion.id} has invalid status ${String(criterion.status)}`,
    );
  }
  return criterion;
}

function validateScoreCriterion(criterion: EvalScoreCriterion): EvalScoreCriterion {
  nonEmptyString(criterion.id, "score criterion id");
  nonEmptyString(criterion.label, "score criterion label");
  const points = finiteNumber(criterion.points, `score criterion ${criterion.id} points`);
  const maxPoints = finiteNumber(
    criterion.maxPoints,
    `score criterion ${criterion.id} maxPoints`,
  );
  if (maxPoints < 0) {
    throw new Error(`score criterion ${criterion.id} maxPoints must be >= 0`);
  }
  if (points < 0 || points > maxPoints) {
    throw new Error(
      `score criterion ${criterion.id} points must be between 0 and maxPoints`,
    );
  }
  return criterion;
}

export function passFailCriterion(input: {
  id: string;
  label: string;
  passed: boolean;
  reason?: string;
  details?: unknown;
}): EvalPassFailCriterion {
  const criterion = withOptionalFields(
    {
      id: nonEmptyString(input.id, "pass/fail criterion id"),
      label: nonEmptyString(input.label, "pass/fail criterion label"),
      status: input.passed ? "passed" as const : "failed" as const,
    },
    input,
  );
  return validatePassFailCriterion(criterion);
}

export function scoreCriterion(input: {
  id: string;
  label: string;
  points: number;
  maxPoints: number;
  reason?: string;
  details?: unknown;
}): EvalScoreCriterion {
  const criterion = withOptionalFields(
    {
      id: nonEmptyString(input.id, "score criterion id"),
      label: nonEmptyString(input.label, "score criterion label"),
      points: finiteNumber(input.points, "score criterion points"),
      maxPoints: finiteNumber(input.maxPoints, "score criterion maxPoints"),
    },
    input,
  );
  return validateScoreCriterion(criterion);
}

export function buildEvalCriteriaSummary(input: {
  passFail: EvalPassFailCriterion[];
  scorecard: EvalScoreCriterion[];
}): EvalCriteriaSummary {
  if (!Array.isArray(input.passFail)) {
    throw new Error("passFail criteria must be an array");
  }
  if (!Array.isArray(input.scorecard)) {
    throw new Error("scorecard criteria must be an array");
  }
  const passFail = input.passFail.map(validatePassFailCriterion);
  const scorecard = input.scorecard.map(validateScoreCriterion);
  const failed = passFail.filter((criterion) => criterion.status === "failed").length;
  const points = scorecard.reduce((total, criterion) => total + criterion.points, 0);
  const maxPoints = scorecard.reduce(
    (total, criterion) => total + criterion.maxPoints,
    0,
  );
  return {
    passFail: {
      passed: failed === 0,
      total: passFail.length,
      failed,
      criteria: passFail,
    },
    scorecard: {
      points,
      maxPoints,
      percentage: maxPoints > 0 ? Math.round((points / maxPoints) * 100) : 0,
      criteria: scorecard,
    },
  };
}

export function assertPassFailCriteria(summary: EvalCriteriaSummary): void {
  const failed = summary.passFail.criteria.filter(
    (criterion) => criterion.status === "failed",
  );
  if (failed.length === 0) return;
  throw new Error(
    [
      `Eval pass/fail criteria failed (${failed.length}/${summary.passFail.total}):`,
      ...failed.map((criterion) => {
        const reason = criterion.reason ? `: ${criterion.reason}` : "";
        return `- ${criterion.label} (${criterion.id})${reason}`;
      }),
    ].join("\n"),
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function lowerJson(value: unknown): string {
  try {
    return JSON.stringify(value).toLowerCase();
  } catch {
    return String(value).toLowerCase();
  }
}

function eventTexts(events: unknown): string[] {
  return Array.isArray(events) ? events.map(lowerJson) : [];
}

function numberFromRecord(record: Record<string, unknown> | undefined, key: string): number {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : Number.NaN;
}

export function scoreSignalEfficiency(
  signal: unknown,
  options: SignalEfficiencyOptions,
): EvalScoreCriterion {
  const record = asRecord(signal);
  const assistantTurnCount = numberFromRecord(record, "assistantTurnCount");
  const badToolCallCount = numberFromRecord(record, "badToolCallCount");
  if (!Number.isFinite(assistantTurnCount) || !Number.isFinite(badToolCallCount)) {
    return scoreCriterion({
      id: options.id ?? "agent_efficiency",
      label: options.label ?? "Agent efficiency / signal",
      points: 0,
      maxPoints: options.maxPoints,
      reason: "Signal summary was missing assistant turn or bad tool call counts.",
    });
  }

  const tier = options.tiers.find(
    (candidate) =>
      assistantTurnCount <= candidate.maxAssistantTurns &&
      badToolCallCount <= candidate.maxBadToolCalls,
  );
  const points = tier?.points ?? options.fallbackPoints ?? 0;
  return scoreCriterion({
    id: options.id ?? "agent_efficiency",
    label: options.label ?? "Agent efficiency / signal",
    points,
    maxPoints: options.maxPoints,
    reason: `${assistantTurnCount} assistant turn(s), ${badToolCallCount} bad tool call(s).`,
    details: {
      assistantTurnCount,
      badToolCallCount,
      tiers: options.tiers,
    },
  });
}

export function scoreLatestPreview(events: unknown): EvalScoreCriterion {
  let finalDeployIndex = -1;
  let finalPreviewIndex = -1;
  eventTexts(events).forEach((text, index) => {
    if (/\b(?:bun\s+run\s+deploy|wrangler\s+deploy)\b/.test(text)) {
      finalDeployIndex = index;
    }
    if (text.includes("set_preview")) {
      finalPreviewIndex = index;
    }
  });

  if (finalPreviewIndex === -1) {
    return scoreCriterion({
      id: "previewed_latest_app",
      label: "Previewed the latest deployed app",
      points: 0,
      maxPoints: 5,
      reason: "No set_preview call was found.",
    });
  }
  if (finalDeployIndex === -1 || finalPreviewIndex < finalDeployIndex) {
    return scoreCriterion({
      id: "previewed_latest_app",
      label: "Previewed the latest deployed app",
      points: 2,
      maxPoints: 5,
      reason: "A set_preview call was found, but not after the final deploy command.",
      details: { finalDeployIndex, finalPreviewIndex },
    });
  }
  return scoreCriterion({
    id: "previewed_latest_app",
    label: "Previewed the latest deployed app",
    points: 5,
    maxPoints: 5,
    reason: "set_preview was called after the final deploy command.",
    details: { finalDeployIndex, finalPreviewIndex },
  });
}

export function buildSessionCompletedCriterion(result: unknown): EvalPassFailCriterion {
  const record = asRecord(result);
  const status = record?.status;
  const error = record?.error;
  return passFailCriterion({
    id: "agent_session_completed",
    label: "Agent session completed",
    passed: status === "completed",
    reason:
      status === "completed"
        ? undefined
        : `Agent status was ${String(status)}${
            error ? `: ${String(error)}` : ""
          }`,
    details: { status, error },
  });
}

export function buildNoAssistantErrorCriterion(
  transcriptText: string,
): EvalPassFailCriterion {
  const hasAssistantError = transcriptText.toLowerCase().includes("assistant error");
  return passFailCriterion({
    id: "no_assistant_error",
    label: "No assistant error",
    passed: !hasAssistantError,
    reason: hasAssistantError
      ? 'Transcript contains the string "assistant error".'
      : undefined,
  });
}

export function buildRuntimeEventsCriterion(result: unknown): EvalPassFailCriterion {
  const events = asRecord(result)?.events;
  const hasRuntimeEvent = Array.isArray(events) &&
    events.some((event) => asRecord(event)?.type === "runtime_event");
  return passFailCriterion({
    id: "runtime_events_exist",
    label: "Runtime events exist",
    passed: hasRuntimeEvent,
    reason: hasRuntimeEvent ? undefined : "No runtime_event entries were captured.",
  });
}

export function buildResultEventCriterion(result: unknown): EvalPassFailCriterion {
  const events = asRecord(result)?.events;
  const hasResultEvent = Array.isArray(events) &&
    events.some((event) => asRecord(event)?.type === "result");
  return passFailCriterion({
    id: "final_result_event_exists",
    label: "Final result event exists",
    passed: hasResultEvent,
    reason: hasResultEvent ? undefined : "No final result event was captured.",
  });
}
