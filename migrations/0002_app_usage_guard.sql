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
