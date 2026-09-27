import alarmGuardRuntimeSource from "./user-app-alarm-guard-runtime.js?raw";

import type { WorkerBinding } from "./cf-api-proxy.js";
import {
  USER_APP_ALARM_GUARD_MODULE,
  USER_APP_GUARD_ENTRY_MODULE,
  localDurableObjectClassNames,
  type UserAppCostControlsConfig,
} from "./user-app-cost-controls-policy.js";

export * from "./user-app-cost-controls-policy.js";

// Deploy-time cost controls applied to every user app uploaded to the dispatch
// namespace: a CPU limit in the upload metadata (covers fetch, Durable Object
// requests and alarms) and an alarm throttle wrapped around each Durable Object
// class the app declares. Defaults and config live in
// user-app-cost-controls-policy.ts, which stays free of bundler-only imports so
// the backfill script can share it.

interface CostControlledModule {
  name: string;
  contentType: string;
}

interface CostControlledMetadata {
  main_module: string;
  bindings?: WorkerBinding[];
  [key: string]: unknown;
}

function isIdentifier(value: string): boolean {
  return /^[$A-Z_a-z][$\w]*$/.test(value);
}

function isJavaScriptModule(module: CostControlledModule): boolean {
  return module.contentType.split(";")[0]!.trim() === "application/javascript+module";
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
