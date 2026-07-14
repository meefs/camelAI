import {
  acquireUsageGuardOperationLease,
  ensureUsageGuardSchema,
  releaseUsageGuardOperationLease,
  type UsageGuardStatus,
} from "../../main/src/usage-guard-state.js";
import { evaluateUsage, estimatedSqliteCostUsd, USAGE_GUARD_POLICY_VERSION, type UsageWindow } from "./policy.js";
import { quarantineDispatchScript } from "./quarantine.js";
import { queryDurableObjectRows, scriptUsageKey } from "./telemetry.js";

interface Env {
  APP_DB: D1Database;
  APP_KV: KVNamespace;
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;
  CF_DISPATCH_NAMESPACE: string;
  USAGE_GUARD_MODE?: string;
  USAGE_GUARD_INGESTION_LAG_MINUTES?: string;
}

interface GuardStateRow {
  app_id: string;
  dispatch_script_name: string;
  org_id: string;
  workspace_id: string;
  script_name: string;
  status: UsageGuardStatus;
  eligible_script_version: string;
  eligible_at: number;
  probation_until: number | null;
  consecutive_over_limit: number;
  artifact_cache_key: string | null;
  reason_code: string | null;
  decision_json: string | null;
  quarantine_attempts: number;
  next_retry_at: number | null;
}

const WINDOWS = [15, 60, 1440] as const;
const LEASE_NAME = "usage-guard-cron";
const RETENTION_MS = 45 * 24 * 60 * 60 * 1000;
const MAX_QUARANTINE_ATTEMPTS = 3;

function guardMode(env: Env): "observe" | "warn" | "enforce" {
  const value = env.USAGE_GUARD_MODE?.trim().toLowerCase();
  return value === "enforce" || value === "warn" ? value : "observe";
}

async function acquireLease(db: D1Database, holder: string, now: number): Promise<boolean> {
  const result = await db.prepare(`
    INSERT INTO app_usage_guard_leases (name, holder, expires_at)
    VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at
    WHERE app_usage_guard_leases.expires_at < ?
  `).bind(LEASE_NAME, holder, now + 4 * 60 * 1000, now).run();
  return (result.meta.changes ?? 0) > 0;
}

async function releaseLease(db: D1Database, holder: string): Promise<void> {
  await db.prepare("DELETE FROM app_usage_guard_leases WHERE name = ? AND holder = ?").bind(LEASE_NAME, holder).run();
}

async function appendEvent(db: D1Database, appId: string, eventType: string, details: unknown, now: number): Promise<void> {
  await db.prepare(`
    INSERT INTO app_usage_guard_events (id, app_id, event_type, details_json, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).bind(crypto.randomUUID(), appId, eventType, JSON.stringify(details), now).run();
}

async function updateRegistry(env: Env, state: GuardStateRow, status: UsageGuardStatus, reason: string | null): Promise<void> {
  const key = `script:${state.dispatch_script_name}`;
  const stored = await env.APP_KV.get(key);
  if (!stored) throw new Error(`App registry entry is missing for ${state.dispatch_script_name}`);
  const parsed = JSON.parse(stored) as Record<string, unknown>;
  await env.APP_KV.put(key, JSON.stringify({
    ...parsed,
    usage_guard_status: status,
    usage_guard_reason: reason,
  }));
}

async function updateRegistryBestEffort(
  env: Env,
  state: GuardStateRow,
  status: UsageGuardStatus,
  reason: string | null,
  now: number,
): Promise<void> {
  try {
    await updateRegistry(env, state, status, reason);
  } catch (error) {
    await appendEvent(env.APP_DB, state.app_id, "quarantine_registry_update_failed", {
      status,
      error: error instanceof Error ? error.message : String(error),
    }, now);
  }
}

async function setState(input: {
  db: D1Database;
  appId: string;
  status: UsageGuardStatus;
  streak: number;
  reason?: string | null;
  decision?: unknown;
  eligibleVersion: string;
  now: number;
}): Promise<void> {
  await input.db.prepare(`
    UPDATE app_usage_guard_state
    SET status = ?, consecutive_over_limit = ?, reason_code = ?, decision_json = ?, updated_at = ?
    WHERE app_id = ? AND eligible_script_version = ?
  `).bind(
    input.status,
    input.streak,
    input.reason ?? null,
    input.decision === undefined ? null : JSON.stringify(input.decision),
    input.now,
    input.appId,
    input.eligibleVersion,
  ).run();
}

async function suspendApp(env: Env, state: GuardStateRow, reason: string, decision: unknown, now: number): Promise<void> {
  const operationLeaseHolder = crypto.randomUUID();
  if (!(await acquireUsageGuardOperationLease({
    db: env.APP_DB,
    appId: state.app_id,
    holder: operationLeaseHolder,
    now,
  }))) {
    await appendEvent(env.APP_DB, state.app_id, "enforcement_deferred_deploy_in_progress", { reason, decision }, now);
    return;
  }
  try {
    const attempt = state.quarantine_attempts + 1;
    const claim = await env.APP_DB.prepare(`
      UPDATE app_usage_guard_state
      SET status = 'suspending', consecutive_over_limit = ?, reason_code = ?,
          decision_json = ?, quarantine_attempts = ?, next_retry_at = NULL, updated_at = ?
      WHERE app_id = ? AND eligible_script_version = ?
    `).bind(
      state.consecutive_over_limit,
      reason,
      JSON.stringify(decision),
      attempt,
      now,
      state.app_id,
      state.eligible_script_version,
    ).run();
    if ((claim.meta.changes ?? 0) !== 1) {
      await appendEvent(env.APP_DB, state.app_id, "enforcement_deferred_stale_claim", { reason, decision }, now);
      return;
    }
    await updateRegistryBestEffort(env, state, "suspending", reason, now);
    try {
      const quarantineVersion = await quarantineDispatchScript({
        accountId: env.CF_ACCOUNT_ID,
        dispatchNamespace: env.CF_DISPATCH_NAMESPACE,
        scriptName: state.dispatch_script_name,
        apiToken: env.CF_API_TOKEN,
        expectedVersion: state.eligible_script_version,
      });
      await env.APP_DB.prepare(`
        UPDATE app_usage_guard_state
        SET status = 'suspended', suspended_at = ?, quarantine_version = ?,
            quarantine_attempts = 0, next_retry_at = NULL, updated_at = ?
        WHERE app_id = ? AND eligible_script_version = ?
      `).bind(now, quarantineVersion, now, state.app_id, state.eligible_script_version).run();
      await updateRegistryBestEffort(env, state, "suspended", reason, now);
      try {
        await appendEvent(env.APP_DB, state.app_id, "suspended", { reason, decision, quarantineVersion }, now);
      } catch (error) {
        console.error("Failed to append usage guard suspension event", error);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const retryDelay = Math.min(30 * 60_000, 60_000 * 2 ** Math.min(attempt - 1, 5));
      await env.APP_DB.prepare(`
        UPDATE app_usage_guard_state
        SET status = 'error', reason_code = ?, decision_json = ?,
            quarantine_attempts = ?, next_retry_at = ?, updated_at = ?
        WHERE app_id = ? AND eligible_script_version = ?
      `).bind(
        reason,
        JSON.stringify({ decision, error: errorMessage }),
        attempt,
        now + retryDelay,
        now,
        state.app_id,
        state.eligible_script_version,
      ).run();
      await updateRegistryBestEffort(env, state, "error", reason, now);
      await appendEvent(env.APP_DB, state.app_id, "quarantine_failed", {
        reason,
        attempt,
        retryAt: now + retryDelay,
        escalated: attempt >= MAX_QUARANTINE_ATTEMPTS,
        error: errorMessage,
      }, now);
    }
  } finally {
    await releaseUsageGuardOperationLease({ db: env.APP_DB, appId: state.app_id, holder: operationLeaseHolder });
  }
}

async function storeEvaluations(db: D1Database, appId: string, windows: UsageWindow[], now: number): Promise<void> {
  const nonZeroWindows = windows.filter((window) => window.rowsRead > 0 || window.rowsWritten > 0);
  if (nonZeroWindows.length === 0) return;
  await db.batch(nonZeroWindows.map((window) => db.prepare(`
    INSERT OR REPLACE INTO app_usage_guard_evaluations (
      app_id, window_minutes, window_end, rows_read, rows_written,
      estimated_cost_usd, query_run_id, policy_version, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    appId,
    window.windowMinutes,
    window.windowEnd,
    window.rowsRead,
    window.rowsWritten,
    window.estimatedCostUsd,
    window.runId,
    USAGE_GUARD_POLICY_VERSION,
    now,
  )));
}

export async function runUsageGuard(env: Env, now = Date.now()): Promise<void> {
  await ensureUsageGuardSchema(env.APP_DB);
  const holder = crypto.randomUUID();
  if (!(await acquireLease(env.APP_DB, holder, now))) return;
  try {
    await env.APP_DB.batch([
      env.APP_DB.prepare("DELETE FROM app_usage_guard_evaluations WHERE created_at < ?").bind(now - RETENTION_MS),
      env.APP_DB.prepare("DELETE FROM app_usage_guard_events WHERE created_at < ?").bind(now - RETENTION_MS),
    ]);
    const statesResult = await env.APP_DB.prepare(`
      SELECT app_id, dispatch_script_name, org_id, workspace_id, script_name, status,
             eligible_script_version, eligible_at, probation_until,
             consecutive_over_limit, artifact_cache_key, reason_code, decision_json,
             quarantine_attempts, next_retry_at
      FROM app_usage_guard_state
      WHERE eligible_script_version IS NOT NULL AND status != 'exempt'
    `).all<GuardStateRow>();
    const mode = guardMode(env);

    for (const state of statesResult.results) {
      if (
        mode === "enforce" &&
        (state.status === "suspending" || state.status === "error") &&
        (state.next_retry_at ?? 0) <= now
      ) {
        let priorDecision: unknown = {};
        try {
          priorDecision = state.decision_json ? JSON.parse(state.decision_json) : {};
        } catch {}
        await suspendApp(env, state, state.reason_code ?? "quarantine_retry", priorDecision, now);
      }
    }

    const lagMinutes = Math.max(1, Number.parseInt(env.USAGE_GUARD_INGESTION_LAG_MINUTES ?? "5", 10) || 5);
    const windowEnd = Math.floor((now - lagMinutes * 60_000) / 60_000) * 60_000;
    const queryResults = await Promise.all(WINDOWS.map(async (windowMinutes) => ({
      windowMinutes,
      from: windowEnd - windowMinutes * 60_000,
      result: await queryDurableObjectRows({
        accountId: env.CF_ACCOUNT_ID,
        apiToken: env.CF_API_TOKEN,
        from: windowEnd - windowMinutes * 60_000,
        to: windowEnd,
      }).then((result) => ({
        ...result,
        usageByScript: new Map(result.usage.map((usage) => [scriptUsageKey(usage.scriptName, usage.scriptVersion), usage])),
      })),
    })));

    for (const state of statesResult.results) {
      if (state.status === "suspended") continue;
      if (state.status === "suspending" || state.status === "error") {
        continue;
      }
      const windows: UsageWindow[] = [];
      for (const query of queryResults) {
        if (state.eligible_at > query.from) continue;
        const usage = query.result.usageByScript.get(
          scriptUsageKey(state.dispatch_script_name, state.eligible_script_version),
        ) ?? {
          scriptName: state.dispatch_script_name,
          scriptVersion: state.eligible_script_version,
          rowsRead: 0,
          rowsWritten: 0,
        };
        windows.push({
          ...usage,
          windowMinutes: query.windowMinutes,
          estimatedCostUsd: estimatedSqliteCostUsd(usage),
          runId: query.result.runId,
          windowEnd,
        });
      }
      await storeEvaluations(env.APP_DB, state.app_id, windows, now);
      const decision = evaluateUsage(windows);
      const probation = state.status === "probation" && (state.probation_until ?? 0) > now;

      if (decision.action === "none") {
        if (state.consecutive_over_limit > 0 || (state.status === "probation" && !probation) || state.status === "warned") {
          await setState({ db: env.APP_DB, appId: state.app_id, status: probation ? "probation" : "active", streak: 0, eligibleVersion: state.eligible_script_version, now });
        }
        continue;
      }

      await appendEvent(env.APP_DB, state.app_id, `${mode}_${decision.action}_candidate`, decision, now);
      if (mode === "observe") continue;
      if (decision.action === "warn") {
        await setState({ db: env.APP_DB, appId: state.app_id, status: probation ? "probation" : "warned", streak: 0, reason: decision.reason, decision, eligibleVersion: state.eligible_script_version, now });
        continue;
      }

      const nextStreak = state.consecutive_over_limit + 1;
      const shouldSuspend = mode === "enforce" && (decision.catastrophic || probation || nextStreak >= 2);
      if (!shouldSuspend) {
        await setState({ db: env.APP_DB, appId: state.app_id, status: probation ? "probation" : "warned", streak: nextStreak, reason: decision.reason, decision, eligibleVersion: state.eligible_script_version, now });
        continue;
      }
      await suspendApp(env, { ...state, consecutive_over_limit: nextStreak }, decision.reason, decision, now);
    }
  } finally {
    await releaseLease(env.APP_DB, holder);
  }
}

export default {
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const now = Date.now();
    await ensureUsageGuardSchema(env.APP_DB);
    await env.APP_DB.prepare(`
      INSERT INTO app_usage_guard_health (id, last_attempt_at)
      VALUES (1, ?)
      ON CONFLICT(id) DO UPDATE SET last_attempt_at = excluded.last_attempt_at
    `).bind(now).run();
    try {
      await runUsageGuard(env, now);
      await env.APP_DB.prepare(`
        UPDATE app_usage_guard_health SET last_success_at = ?, last_error = NULL WHERE id = 1
      `).bind(Date.now()).run();
    } catch (error) {
      await env.APP_DB.prepare(`
        UPDATE app_usage_guard_health SET last_error = ? WHERE id = 1
      `).bind(error instanceof Error ? error.message : String(error)).run();
      throw error;
    }
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      await ensureUsageGuardSchema(env.APP_DB);
      const health = await env.APP_DB.prepare(`
        SELECT last_attempt_at, last_success_at, last_error FROM app_usage_guard_health WHERE id = 1
      `).first<{ last_attempt_at: number | null; last_success_at: number | null; last_error: string | null }>();
      const failures = await env.APP_DB.prepare(`
        SELECT COUNT(*) AS count FROM app_usage_guard_state WHERE status IN ('suspending', 'error')
      `).first<{ count: number }>();
      const lastSuccessAt = health?.last_success_at ?? null;
      const ok = lastSuccessAt !== null && Date.now() - lastSuccessAt <= 20 * 60_000 && (failures?.count ?? 0) === 0;
      return Response.json(
        {
          ok,
          mode: guardMode(env),
          policyVersion: USAGE_GUARD_POLICY_VERSION,
          lastAttemptAt: health?.last_attempt_at ?? null,
          lastSuccessAt,
          lastError: health?.last_error ?? null,
          incompleteQuarantines: failures?.count ?? 0,
        },
        { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } },
      );
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
