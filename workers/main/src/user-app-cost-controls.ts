import alarmGuardRuntimeSource from "./user-app-alarm-guard-runtime.js?raw";

import type { WorkerBinding } from "./cf-api-proxy.js";

// Deploy-time cost controls applied to every user app uploaded to the dispatch
// namespace: a CPU limit in the upload metadata (covers fetch, Durable Object
// requests and alarms) and an alarm throttle wrapped around each Durable Object
// class the app declares.

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

interface CostControlledModule {
  name: string;
  contentType: string;
}

interface CostControlledMetadata {
  main_module: string;
  bindings?: WorkerBinding[];
  [key: string]: unknown;
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

function isIdentifier(value: string): boolean {
  return /^[$A-Z_a-z][$\w]*$/.test(value);
}

function isJavaScriptModule(module: CostControlledModule): boolean {
  return module.contentType.split(";")[0]!.trim() === "application/javascript+module";
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

export function alarmGuardEntryModule(
  mainModule: string,
  classNames: string[],
  config: Pick<UserAppCostControlsConfig, "alarmMinIntervalMs" | "alarmDailyBudget">,
): string {
  for (const className of classNames) {
    if (!isIdentifier(className) || className === "default") throw new Error(`Unsafe Durable Object class name: ${className}`);
  }
  const specifier = JSON.stringify(`./${mainModule}`);
  const options = JSON.stringify({ minIntervalMs: config.alarmMinIntervalMs, dailyBudget: config.alarmDailyBudget });
  // Local exports shadow the matching names from `export *`.
  return [
    `import * as app from ${specifier};`,
    `import { guardDurableObjectClass } from ${JSON.stringify(`./${USER_APP_ALARM_GUARD_MODULE}`)};`,
    `export * from ${specifier};`,
    `export default app.default;`,
    `const options = ${options};`,
    ...classNames.map((className) => `export const ${className} = guardDurableObjectClass(app.${className}, options);`),
    "",
  ].join("\n");
}

/**
 * Applies the platform cost controls to an upload. Idempotent: an artifact that
 * already carries the alarm guard (e.g. a rollback of a guarded deploy) keeps
 * its modules and only gets the current CPU limit.
 */
export function withUserAppCostControls<
  Metadata extends CostControlledMetadata,
  Module extends CostControlledModule,
>(
  metadata: Metadata,
  modules: Module[],
  config: UserAppCostControlsConfig,
  toModule: (name: string, source: string) => Module,
): { metadata: Metadata; modules: Module[] } {
  const limits = metadata.limits && typeof metadata.limits === "object" && !Array.isArray(metadata.limits)
    ? metadata.limits as Record<string, unknown>
    : {};
  const nextMetadata: Metadata = config.cpuMs > 0
    ? { ...metadata, limits: { ...limits, cpu_ms: config.cpuMs } }
    : { ...metadata };

  const alreadyGuarded = metadata.main_module === USER_APP_GUARD_ENTRY_MODULE ||
    modules.some((module) => module.name === USER_APP_ALARM_GUARD_MODULE);
  const alarmGuardEnabled = config.alarmMinIntervalMs > 0 || config.alarmDailyBudget > 0;
  const mainModule = modules.find((module) => module.name === metadata.main_module);
  const classNames = localDurableObjectClassNames(metadata.bindings);
  if (alreadyGuarded || !alarmGuardEnabled || !mainModule || !isJavaScriptModule(mainModule) || classNames.length === 0) {
    return { metadata: nextMetadata, modules };
  }
  return {
    metadata: { ...nextMetadata, main_module: USER_APP_GUARD_ENTRY_MODULE },
    modules: [
      ...modules,
      toModule(USER_APP_ALARM_GUARD_MODULE, alarmGuardRuntimeSource),
      toModule(USER_APP_GUARD_ENTRY_MODULE, alarmGuardEntryModule(metadata.main_module, classNames, config)),
    ],
  };
}
