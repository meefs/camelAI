import {
  classifyCostControlsBackfill,
  scriptNeedsAlarmGuard,
  type CostControlsBackfillGuardState,
  type CostControlsBackfillSkipReason,
  type DispatchScriptSettingsView,
  type UserAppCostControlsConfig,
} from "../../workers/main/src/user-app-cost-controls-policy";

// Planning and bookkeeping for scripts/backfill-user-app-cost-controls.ts, kept
// free of I/O so it can be unit-tested.

export type BackfillEnvironment = "staging" | "prod";
export type BackfillOrder = "name" | "alarm-spend";

export interface BackfillArgs {
  env: BackfillEnvironment;
  apply: boolean;
  scripts: string[] | null;
  limit: number | null;
  order: BackfillOrder;
  delayMs: number;
}

export const BACKFILL_USAGE = `Usage: bun scripts/backfill-user-app-cost-controls.ts --env staging|prod [options]

Re-applies user-app cost controls (alarm guard + CPU limit) by replaying each
live app's latest cached deploy artifact. Dry run unless --apply is passed.

Options:
  --env staging|prod     Target environment (required)
  --apply                Actually redeploy (default: dry run, read-only)
  --scripts a,b,c        Only consider these dispatch script names
  --limit N              Stop after N apps would be / were redeployed
  --order name|alarm-spend
                         alarm-spend: most last-7-day alarm invocations first
  --delay-ms N           Pause between redeploys (default 2000)
`;

function positiveInteger(flag: string, value: string | undefined, allowZero = false): number {
  const parsed = Number(value);
  if (!value || !Number.isInteger(parsed) || parsed < (allowZero ? 0 : 1)) {
    throw new Error(`${flag} expects a ${allowZero ? "non-negative" : "positive"} integer`);
  }
  return parsed;
}

export function parseBackfillArgs(argv: string[]): BackfillArgs {
  const args: Partial<BackfillArgs> & { apply: boolean } = {
    apply: false,
    scripts: null,
    limit: null,
    order: "name",
    delayMs: 2_000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const [flag, inline] = argv[index]!.split(/=(.*)/s, 2) as [string, string | undefined];
    const value = () => inline ?? argv[++index];
    switch (flag) {
      case "--apply":
        args.apply = true;
        break;
      case "--env": {
        const env = value();
        if (env !== "staging" && env !== "prod") throw new Error("--env must be staging or prod");
        args.env = env;
        break;
      }
      case "--scripts": {
        const scripts = (value() ?? "").split(",").map((name) => name.trim()).filter(Boolean);
        if (scripts.length === 0) throw new Error("--scripts expects a comma-separated list");
        args.scripts = [...new Set(scripts)];
        break;
      }
      case "--limit":
        args.limit = positiveInteger("--limit", value());
        break;
      case "--order": {
        const order = value();
        if (order !== "name" && order !== "alarm-spend") throw new Error("--order must be name or alarm-spend");
        args.order = order;
        break;
      }
      case "--delay-ms":
        args.delayMs = positiveInteger("--delay-ms", value(), true);
        break;
      default:
        throw new Error(`Unknown argument: ${argv[index]}`);
    }
  }
  if (!args.env) throw new Error("--env staging|prod is required");
  return args as BackfillArgs;
}

export interface AlarmInvocationGroup {
  dimensions: { scriptName: string; type: string };
  sum: { requests: number };
}

export function alarmInvocationsByScript(groups: AlarmInvocationGroup[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const group of groups) {
    if (group.dimensions.type !== "alarm") continue;
    totals.set(group.dimensions.scriptName, (totals.get(group.dimensions.scriptName) ?? 0) + group.sum.requests);
  }
  return totals;
}

/**
 * Orders the live scripts to consider. An allowlist narrows the set; allowlisted
 * names that are not live are returned separately so they can be reported.
 */
export function selectBackfillCandidates(
  liveScripts: string[],
  args: Pick<BackfillArgs, "scripts" | "order">,
  alarmsByScript: Map<string, number> = new Map(),
): { candidates: string[]; notLive: string[] } {
  const live = new Set(liveScripts);
  const pool = args.scripts ? args.scripts.filter((name) => live.has(name)) : [...live];
  const notLive = args.scripts ? args.scripts.filter((name) => !live.has(name)) : [];
  const byName = (a: string, b: string) => a.localeCompare(b);
  const candidates = args.order === "alarm-spend"
    ? pool.sort((a, b) => (alarmsByScript.get(b) ?? 0) - (alarmsByScript.get(a) ?? 0) || byName(a, b))
    : pool.sort(byName);
  return { candidates, notLive };
}

export type BackfillOutcome =
  | { dispatchScriptName: string; result: "applied"; scriptVersion?: string }
  | { dispatchScriptName: string; result: "would-apply" }
  | { dispatchScriptName: string; result: "skipped"; reason: CostControlsBackfillSkipReason }
  | { dispatchScriptName: string; result: "failed"; error: string };

export interface BackfillSummary {
  applied: number;
  wouldApply: number;
  failed: number;
  skipped: Partial<Record<CostControlsBackfillSkipReason, number>>;
}

export function summarizeBackfill(outcomes: BackfillOutcome[]): BackfillSummary {
  const summary: BackfillSummary = { applied: 0, wouldApply: 0, failed: 0, skipped: {} };
  for (const outcome of outcomes) {
    if (outcome.result === "applied") summary.applied += 1;
    else if (outcome.result === "would-apply") summary.wouldApply += 1;
    else if (outcome.result === "failed") summary.failed += 1;
    else summary.skipped[outcome.reason] = (summary.skipped[outcome.reason] ?? 0) + 1;
  }
  return summary;
}

export function formatBackfillOutcome(outcome: BackfillOutcome): string {
  switch (outcome.result) {
    case "applied":
      return `applied      ${outcome.dispatchScriptName}${outcome.scriptVersion ? ` (version ${outcome.scriptVersion})` : ""}`;
    case "would-apply":
      return `would-apply  ${outcome.dispatchScriptName}`;
    case "skipped":
      return `skipped      ${outcome.dispatchScriptName} (${outcome.reason})`;
    case "failed":
      return `FAILED       ${outcome.dispatchScriptName}: ${outcome.error}`;
  }
}

export interface BackfillDeps {
  guardStates: Map<string, CostControlsBackfillGuardState>;
  leaseExpiresAt: (appId: string) => number | null;
  readSettings: (dispatchScriptName: string) => Promise<DispatchScriptSettingsView | null>;
  readEntrypoint: (dispatchScriptName: string) => Promise<string | null>;
  applyOne: (dispatchScriptName: string) => Promise<
    | { status: "applied"; scriptVersion?: string }
    | { status: "skipped"; reason: CostControlsBackfillSkipReason }
  >;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
  now: () => number;
}

/**
 * Walks candidates in order, sequentially. Cheap checks (usage-guard state,
 * leases) run before per-script Cloudflare reads; --limit counts redeploys
 * (would-apply in a dry run, applied or failed otherwise).
 */
export async function runBackfill(
  candidates: string[],
  args: Pick<BackfillArgs, "apply" | "limit" | "delayMs">,
  config: UserAppCostControlsConfig,
  deps: BackfillDeps,
): Promise<BackfillOutcome[]> {
  const outcomes: BackfillOutcome[] = [];
  let redeploys = 0;
  const record = (outcome: BackfillOutcome) => {
    outcomes.push(outcome);
    deps.log(formatBackfillOutcome(outcome));
  };
  for (const dispatchScriptName of candidates) {
    if (args.limit !== null && redeploys >= args.limit) break;
    const guardState = deps.guardStates.get(dispatchScriptName) ?? null;
    const base = {
      live: true,
      guardState,
      leaseExpiresAt: guardState ? deps.leaseExpiresAt(guardState.app_id) : null,
      config,
    };
    const cheap = classifyCostControlsBackfill({ ...base, now: deps.now() });
    if (cheap.action === "skip") {
      record({ dispatchScriptName, result: "skipped", reason: cheap.reason });
      continue;
    }
    try {
      const settings = await deps.readSettings(dispatchScriptName);
      const entrypoint = settings && scriptNeedsAlarmGuard(settings) ? await deps.readEntrypoint(dispatchScriptName) : null;
      const decision = classifyCostControlsBackfill({
        ...base,
        live: settings !== null,
        settings: settings ?? undefined,
        entrypoint,
        now: deps.now(),
      });
      if (decision.action === "skip") {
        record({ dispatchScriptName, result: "skipped", reason: decision.reason });
        continue;
      }
      if (!args.apply) {
        redeploys += 1;
        record({ dispatchScriptName, result: "would-apply" });
        continue;
      }
      if (redeploys > 0 && args.delayMs > 0) await deps.sleep(args.delayMs);
      redeploys += 1;
      const result = await deps.applyOne(dispatchScriptName);
      record(result.status === "applied"
        ? { dispatchScriptName, result: "applied", ...(result.scriptVersion ? { scriptVersion: result.scriptVersion } : {}) }
        : { dispatchScriptName, result: "skipped", reason: result.reason });
    } catch (error) {
      record({ dispatchScriptName, result: "failed", error: error instanceof Error ? error.message : String(error) });
    }
  }
  return outcomes;
}
