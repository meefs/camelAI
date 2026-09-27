import type { WorkerBinding } from "./cf-api-proxy.js";
import { USAGE_GUARD_QUARANTINE_MARKER } from "./usage-guard-config.js";

export const USER_APP_GUARD_ENTRY_MODULE = "__camelai_entry.js";
export const USER_APP_ALARM_GUARD_MODULE = "__camelai_alarm_guard.js";

// A self-rearming 200 ms alarm loop cost one app $135/week, so alarms are
// clamped to 30 s apart: 150x fewer invocations for that loop while still
// leaving room for Discord gateway heartbeats (~41 s) and minute schedulers.
export const DEFAULT_USER_APP_ALARM_MIN_INTERVAL_MS = 30_000;
// Backstop on alarm invocations per object per UTC day, retries included. One
// object alarming every 30 s all day is 2,880; a bit of headroom above that
// keeps a steady-state chain alive and only trips on runaway retry storms or
// setAlarm paths that bypass the clamp.
export const DEFAULT_USER_APP_ALARM_DAILY_BUDGET = 3_000;
// Cloudflare's default is 30 s per invocation. 1 s is ~100x typical request
// CPU for generated apps but stops an alarm from burning tens of seconds of
// CPU on every tick. SQLite time counts: a 2M-row scan (~0.4 s) passes, a
// 10M-row scan is killed. A killed alarm is retried 6 times, then dropped.
export const DEFAULT_USER_APP_CPU_MS = 1_000;

export interface UserAppCostControlsEnv {
  USER_APP_ALARM_MIN_INTERVAL_MS?: string;
  USER_APP_ALARM_DAILY_BUDGET?: string;
  USER_APP_CPU_MS?: string;
}

export interface UserAppCostControlsConfig {
  alarmMinIntervalMs: number;
  alarmDailyBudget: number;
  cpuMs: number;
}

function nonNegativeInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

// "0" disables a control.
export function userAppCostControlsConfig(env: UserAppCostControlsEnv): UserAppCostControlsConfig {
  return {
    alarmMinIntervalMs: nonNegativeInteger(env.USER_APP_ALARM_MIN_INTERVAL_MS, DEFAULT_USER_APP_ALARM_MIN_INTERVAL_MS),
    alarmDailyBudget: nonNegativeInteger(env.USER_APP_ALARM_DAILY_BUDGET, DEFAULT_USER_APP_ALARM_DAILY_BUDGET),
    cpuMs: nonNegativeInteger(env.USER_APP_CPU_MS, DEFAULT_USER_APP_CPU_MS),
  };
}

// Durable Object classes this script defines itself (bindings to another
// script's classes carry script_name).
export function localDurableObjectClassNames(bindings: WorkerBinding[] | undefined): string[] {
  const names = (bindings ?? []).flatMap((binding) => {
    const record = binding as Record<string, unknown>;
    if (record.type !== "durable_object_namespace" || typeof record.class_name !== "string" || record.script_name) return [];
    return [record.class_name];
  });
  return [...new Set(names)];
}


export interface DispatchScriptSettingsView {
  limits?: { cpu_ms?: number } | null;
  bindings?: Array<Record<string, unknown>>;
}

/**
 * Whether a live script already carries the current cost controls. `entrypoint`
 * is the script's main module (the `cf-entrypoint` header of the content API)
 * and only matters when the script declares its own Durable Object classes.
 */
export function hasCurrentCostControls(
  settings: DispatchScriptSettingsView,
  entrypoint: string | null,
  config: UserAppCostControlsConfig,
): boolean {
  if (config.cpuMs > 0 && settings.limits?.cpu_ms !== config.cpuMs) return false;
  const alarmGuardEnabled = config.alarmMinIntervalMs > 0 || config.alarmDailyBudget > 0;
  if (!alarmGuardEnabled || !scriptNeedsAlarmGuard(settings)) return true;
  return entrypoint === USER_APP_GUARD_ENTRY_MODULE;
}

export function scriptNeedsAlarmGuard(settings: DispatchScriptSettingsView): boolean {
  return localDurableObjectClassNames(settings.bindings as WorkerBinding[] | undefined).length > 0;
}

export function isUsageGuardQuarantined(settings: DispatchScriptSettingsView): boolean {
  return (settings.bindings ?? []).some((binding) =>
    binding.name === USAGE_GUARD_QUARANTINE_MARKER && binding.type === "plain_text"
  );
}

export interface CostControlsBackfillGuardState {
  app_id: string;
  org_id: string;
  workspace_id: string;
  script_name: string;
  status: string;
  artifact_cache_key: string | null;
}

export type CostControlsBackfillSkipReason =
  | "not-live"
  | "no-artifact-record"
  | "suspended"
  | "quarantined"
  | "lease-held"
  | "already-applied";

export type CostControlsBackfillDecision =
  | { action: "apply" }
  | { action: "skip"; reason: CostControlsBackfillSkipReason };

const SUSPENDED_USAGE_GUARD_STATUSES = new Set(["suspending", "suspended", "error"]);

/**
 * Decides whether replaying an app's latest cached artifact would re-apply
 * cost controls. Pass `settings: undefined` to run only the checks that need
 * no per-script Cloudflare API reads; the result is then "apply" only in the
 * sense of "worth fetching settings for".
 */
export function classifyCostControlsBackfill(input: {
  live: boolean;
  guardState: CostControlsBackfillGuardState | null;
  leaseExpiresAt: number | null;
  settings?: DispatchScriptSettingsView;
  entrypoint?: string | null;
  config: UserAppCostControlsConfig;
  now: number;
}): CostControlsBackfillDecision {
  if (!input.live) return { action: "skip", reason: "not-live" };
  if (!input.guardState?.artifact_cache_key) return { action: "skip", reason: "no-artifact-record" };
  if (SUSPENDED_USAGE_GUARD_STATUSES.has(input.guardState.status)) return { action: "skip", reason: "suspended" };
  if (input.leaseExpiresAt !== null && input.leaseExpiresAt > input.now) return { action: "skip", reason: "lease-held" };
  if (!input.settings) return { action: "apply" };
  if (isUsageGuardQuarantined(input.settings)) return { action: "skip", reason: "quarantined" };
  if (hasCurrentCostControls(input.settings, input.entrypoint ?? null, input.config)) {
    return { action: "skip", reason: "already-applied" };
  }
  return { action: "apply" };
}

export interface DispatchScriptApiInput {
  accountId: string;
  dispatchNamespace: string;
  scriptName: string;
  apiToken: string;
  fetcher?: typeof fetch;
}

function dispatchScriptUrl(input: DispatchScriptApiInput): string {
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(input.accountId)}` +
    `/workers/dispatch/namespaces/${encodeURIComponent(input.dispatchNamespace)}` +
    `/scripts/${encodeURIComponent(input.scriptName)}`;
}

/** Live script settings, or null when the script is not deployed. */
export async function readDispatchScriptSettings(input: DispatchScriptApiInput): Promise<DispatchScriptSettingsView | null> {
  const response = await (input.fetcher ?? fetch)(`${dispatchScriptUrl(input)}/settings`, {
    headers: { Authorization: `Bearer ${input.apiToken}` },
  });
  if (response.status === 404) {
    await response.body?.cancel();
    return null;
  }
  const body = await response.json() as { result?: DispatchScriptSettingsView | null };
  if (!response.ok || !body.result) throw new Error(`Failed to read script settings for ${input.scriptName}: HTTP ${response.status}`);
  return body.result;
}

/** The live script's main module name; the content API reports it as a header. */
export async function readDispatchScriptEntrypoint(input: DispatchScriptApiInput): Promise<string | null> {
  const response = await (input.fetcher ?? fetch)(`${dispatchScriptUrl(input)}/content`, {
    headers: { Authorization: `Bearer ${input.apiToken}` },
  });
  const entrypoint = response.headers.get("cf-entrypoint");
  await response.body?.cancel();
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Failed to read script content for ${input.scriptName}: HTTP ${response.status}`);
  return entrypoint;
}
