export type UsageGuardStatus =
  | "unmonitored"
  | "active"
  | "warned"
  | "suspending"
  | "suspended"
  | "probation"
  | "error"
  | "exempt";

export const USAGE_GUARD_PROBATION_MS = 60 * 60 * 1000;

export interface UsageGuardRegistryFields {
  usage_guard_status?: UsageGuardStatus;
  usage_guard_eligible_version?: string;
  usage_guard_eligible_at?: number;
  usage_guard_probation_until?: number | null;
  usage_guard_reason?: string | null;
}

export async function ensureUsageGuardSchema(db: D1Database): Promise<void> {
  const statements = `
    CREATE TABLE IF NOT EXISTS app_usage_guard_state (
      app_id TEXT PRIMARY KEY,
      dispatch_script_name TEXT NOT NULL UNIQUE,
      org_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      script_name TEXT NOT NULL,
      status TEXT NOT NULL,
      eligible_script_version TEXT,
      eligible_at INTEGER,
      trace_audited_at INTEGER,
      probation_until INTEGER,
      consecutive_over_limit INTEGER NOT NULL DEFAULT 0,
      reason_code TEXT,
      decision_json TEXT,
      artifact_cache_key TEXT,
      suspended_at INTEGER,
      quarantine_version TEXT,
      quarantine_attempts INTEGER NOT NULL DEFAULT 0,
      next_retry_at INTEGER,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_usage_guard_evaluations (
      app_id TEXT NOT NULL,
      window_minutes INTEGER NOT NULL,
      window_end INTEGER NOT NULL,
      rows_read INTEGER NOT NULL,
      rows_written INTEGER NOT NULL,
      estimated_cost_usd REAL NOT NULL,
      query_run_id TEXT,
      policy_version TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (app_id, window_minutes, window_end, policy_version)
    );
    CREATE TABLE IF NOT EXISTS app_usage_guard_events (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      details_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_usage_guard_leases (
      name TEXT PRIMARY KEY,
      holder TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_usage_guard_health (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_attempt_at INTEGER,
      last_success_at INTEGER,
      last_error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_usage_guard_status ON app_usage_guard_state(status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_usage_guard_eval_retention ON app_usage_guard_evaluations(created_at);
    CREATE INDEX IF NOT EXISTS idx_usage_guard_events_app ON app_usage_guard_events(app_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_usage_guard_events_retention ON app_usage_guard_events(created_at);
  `;
  await db.batch(
    statements
      .split(";")
      .map((statement) => statement.trim())
      .filter(Boolean)
      .map((statement) => db.prepare(statement)),
  );
  const columns = await db.prepare("PRAGMA table_info(app_usage_guard_state)").all<{ name: string }>();
  const columnNames = new Set(columns.results.map((column) => column.name));
  const upgrades: D1PreparedStatement[] = [];
  if (!columnNames.has("quarantine_attempts")) {
    upgrades.push(db.prepare("ALTER TABLE app_usage_guard_state ADD COLUMN quarantine_attempts INTEGER NOT NULL DEFAULT 0"));
  }
  if (!columnNames.has("next_retry_at")) {
    upgrades.push(db.prepare("ALTER TABLE app_usage_guard_state ADD COLUMN next_retry_at INTEGER"));
  }
  if (upgrades.length > 0) await db.batch(upgrades);
}

function operationLeaseName(appId: string): string {
  return `app-operation:${appId}`;
}

export async function acquireUsageGuardOperationLease(input: {
  db: D1Database;
  appId: string;
  holder: string;
  now?: number;
  ttlMs?: number;
}): Promise<boolean> {
  const now = input.now ?? Date.now();
  await ensureUsageGuardSchema(input.db);
  const result = await input.db.prepare(`
    INSERT INTO app_usage_guard_leases (name, holder, expires_at)
    VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at
    WHERE app_usage_guard_leases.expires_at < ?
  `).bind(operationLeaseName(input.appId), input.holder, now + (input.ttlMs ?? 15 * 60 * 1000), now).run();
  return (result.meta.changes ?? 0) > 0;
}

export async function releaseUsageGuardOperationLease(input: {
  db: D1Database;
  appId: string;
  holder: string;
}): Promise<void> {
  await input.db.prepare("DELETE FROM app_usage_guard_leases WHERE name = ? AND holder = ?")
    .bind(operationLeaseName(input.appId), input.holder)
    .run();
}

export async function markUsageGuardEligible(input: {
  db: D1Database;
  appId: string;
  dispatchScriptName: string;
  orgId: string;
  workspaceId: string;
  scriptName: string;
  scriptVersion: string;
  artifactCacheKey?: string;
  recovering: boolean;
  now?: number;
}): Promise<{ status: "active" | "probation"; probationUntil: number | null }> {
  const now = input.now ?? Date.now();
  await ensureUsageGuardSchema(input.db);
  const prior = await input.db.prepare("SELECT status FROM app_usage_guard_state WHERE app_id = ?")
    .bind(input.appId)
    .first<{ status: UsageGuardStatus }>();
  const recovering = input.recovering || isUsageGuardRecovery(prior?.status);
  const status = recovering ? "probation" : "active";
  const probationUntil = recovering ? now + USAGE_GUARD_PROBATION_MS : null;
  await input.db.prepare(`
    INSERT INTO app_usage_guard_state (
      app_id, dispatch_script_name, org_id, workspace_id, script_name, status,
      eligible_script_version, eligible_at, trace_audited_at, probation_until,
      consecutive_over_limit, reason_code, decision_json, artifact_cache_key,
      suspended_at, quarantine_version, quarantine_attempts, next_retry_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?, NULL, NULL, 0, NULL, ?)
    ON CONFLICT(app_id) DO UPDATE SET
      dispatch_script_name = excluded.dispatch_script_name,
      org_id = excluded.org_id,
      workspace_id = excluded.workspace_id,
      script_name = excluded.script_name,
      status = excluded.status,
      eligible_script_version = excluded.eligible_script_version,
      eligible_at = excluded.eligible_at,
      trace_audited_at = excluded.trace_audited_at,
      probation_until = excluded.probation_until,
      consecutive_over_limit = 0,
      reason_code = NULL,
      decision_json = NULL,
      artifact_cache_key = COALESCE(excluded.artifact_cache_key, app_usage_guard_state.artifact_cache_key),
      suspended_at = NULL,
      quarantine_version = NULL,
      quarantine_attempts = 0,
      next_retry_at = NULL,
      updated_at = excluded.updated_at
  `).bind(
    input.appId,
    input.dispatchScriptName,
    input.orgId,
    input.workspaceId,
    input.scriptName,
    status,
    input.scriptVersion,
    now,
    now,
    probationUntil,
    input.artifactCacheKey ?? null,
    now,
  ).run();
  return { status, probationUntil };
}

export function isUsageGuardRecovery(status: unknown): boolean {
  return status === "suspending" || status === "suspended" || status === "error";
}
