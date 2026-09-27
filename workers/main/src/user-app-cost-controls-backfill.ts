import type { DeploySideEffectsInfo } from "./cf-api-proxy.js";
import {
  rollbackWorkerDeployFromArtifactCache,
  type DirectDispatchDeployEnv,
} from "./direct-dispatch-deploy.js";
import { ensureUsageGuardSchema, operationLeaseName } from "./usage-guard-state.js";
import {
  classifyCostControlsBackfill,
  readDispatchScriptEntrypoint,
  readDispatchScriptSettings,
  scriptNeedsAlarmGuard,
  userAppCostControlsConfig,
  type CostControlsBackfillGuardState,
  type CostControlsBackfillSkipReason,
} from "./user-app-cost-controls-policy.js";

// Server half of scripts/backfill-user-app-cost-controls.ts: re-applies the
// current cost controls to one live app by replaying its latest cached deploy
// artifact through the normal rollback path. Replaying uploads a new script
// version, which restarts the app's Durable Object instances.

export interface CostControlsBackfillEnv extends DirectDispatchDeployEnv {
  WORKER_BASE_URL?: string;
}

export type CostControlsBackfillResult =
  | {
      status: "applied";
      dispatchScriptName: string;
      artifactCacheKey: string;
      scriptVersion?: string;
    }
  | {
      status: "skipped";
      dispatchScriptName: string;
      reason: CostControlsBackfillSkipReason;
    };

export async function readCostControlsBackfillGuardState(
  db: D1Database,
  dispatchScriptName: string,
): Promise<{ guardState: CostControlsBackfillGuardState | null; leaseExpiresAt: number | null }> {
  const guardState = await db.prepare(`
    SELECT app_id, org_id, workspace_id, script_name, status, artifact_cache_key
    FROM app_usage_guard_state
    WHERE dispatch_script_name = ?
  `).bind(dispatchScriptName).first<CostControlsBackfillGuardState>();
  if (!guardState) return { guardState: null, leaseExpiresAt: null };
  const lease = await db.prepare("SELECT expires_at FROM app_usage_guard_leases WHERE name = ?")
    .bind(operationLeaseName(guardState.app_id))
    .first<{ expires_at: number }>();
  return { guardState, leaseExpiresAt: lease?.expires_at ?? null };
}

export async function backfillUserAppCostControls(
  env: CostControlsBackfillEnv,
  dispatchScriptName: string,
  options: {
    fetcher?: typeof fetch;
    onDeploySideEffects?: (info: DeploySideEffectsInfo) => Promise<void>;
    now?: number;
  } = {},
): Promise<CostControlsBackfillResult> {
  const apiToken = env.CF_API_TOKEN?.trim();
  const accountId = env.CF_ACCOUNT_ID?.trim();
  const dispatchNamespace = env.CF_DISPATCH_NAMESPACE?.trim();
  if (!apiToken || !accountId || !dispatchNamespace) {
    throw new Error("CF_API_TOKEN, CF_ACCOUNT_ID and CF_DISPATCH_NAMESPACE are required for the cost-controls backfill");
  }
  if (!env.APP_DB) throw new Error("APP_DB is required for the cost-controls backfill");
  const fetcher = options.fetcher ?? fetch;
  const skipped = (reason: CostControlsBackfillSkipReason): CostControlsBackfillResult =>
    ({ status: "skipped", dispatchScriptName, reason });

  await ensureUsageGuardSchema(env.APP_DB);
  const { guardState, leaseExpiresAt } = await readCostControlsBackfillGuardState(env.APP_DB, dispatchScriptName);
  const api = { accountId, dispatchNamespace, scriptName: dispatchScriptName, apiToken, fetcher };
  const settings = await readDispatchScriptSettings(api);
  const entrypoint = settings && scriptNeedsAlarmGuard(settings) ? await readDispatchScriptEntrypoint(api) : null;
  const decision = classifyCostControlsBackfill({
    live: settings !== null,
    guardState,
    leaseExpiresAt,
    settings: settings ?? undefined,
    entrypoint,
    config: userAppCostControlsConfig(env),
    now: options.now ?? Date.now(),
  });
  if (decision.action === "skip") return skipped(decision.reason);
  const state = guardState!;
  const artifactCacheKey = state.artifact_cache_key!;

  let hostname = "camelai.dev";
  try {
    hostname = new URL(env.WORKER_BASE_URL || "https://camelai.dev").hostname;
  } catch {}
  let deploy;
  try {
    deploy = await rollbackWorkerDeployFromArtifactCache(env, {
      artifactCacheKey,
      hostname,
      expected: { orgId: state.org_id, workspaceId: state.workspace_id, scriptName: state.script_name },
    }, { fetcher, onDeploySideEffects: options.onDeploySideEffects });
  } catch (error) {
    // The rollback path takes the same per-app operation lease as deploys and
    // the usage guard; losing that race is a skip, not a failure.
    if (error instanceof Error && /temporarily busy/.test(error.message)) return skipped("lease-held");
    throw error;
  }
  if (!deploy.success) {
    throw new Error(`Re-upload of ${dispatchScriptName} failed with HTTP ${deploy.status}: ${deploy.error ?? "unknown error"}`);
  }
  return {
    status: "applied",
    dispatchScriptName,
    artifactCacheKey,
    ...(deploy.sideEffects.scriptVersion ? { scriptVersion: deploy.sideEffects.scriptVersion } : {}),
  };
}
