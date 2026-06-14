CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT,
  avatar_color TEXT,
  avatar_content TEXT,
  created_at INTEGER NOT NULL,
  is_superuser INTEGER NOT NULL DEFAULT 0,
  is_orphaned INTEGER NOT NULL DEFAULT 0,
  org_count INTEGER NOT NULL DEFAULT 0,
  signup_ip TEXT
);

CREATE TABLE IF NOT EXISTS orgs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT,
  created_at INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  billing_status TEXT,
  created_by TEXT,
  member_count INTEGER NOT NULL DEFAULT 0,
  workspace_count INTEGER NOT NULL DEFAULT 0,
  llm_provider TEXT,
  llm_provider_updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  org_id TEXT NOT NULL,
  description TEXT,
  avatar_color TEXT,
  avatar_content TEXT,
  created_at INTEGER NOT NULL,
  created_by TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  archived_at INTEGER,
  archived_by TEXT,
  compute_tier TEXT NOT NULL DEFAULT 'standard',
  thread_count INTEGER NOT NULL DEFAULT 0,
  integration_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  title TEXT,
  model TEXT,
  org_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  created_by TEXT
);

CREATE TABLE IF NOT EXISTS apps (
  app_id TEXT PRIMARY KEY,
  script_name TEXT NOT NULL,
  org_id TEXT,
  workspace_id TEXT NOT NULL,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  is_public INTEGER NOT NULL DEFAULT 0,
  preview_status TEXT,
  preview_error TEXT
);

CREATE TABLE IF NOT EXISTS invitations (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL,
  invited_by TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS deleted_users (
  id TEXT PRIMARY KEY,
  deleted_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS blocked_signup_ips (
  ip TEXT PRIMARY KEY,
  blocked_at INTEGER NOT NULL,
  blocked_by TEXT,
  reason TEXT
);

CREATE TABLE IF NOT EXISTS org_memberships (
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, user_id)
);

CREATE TABLE IF NOT EXISTS app_index_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS d1_migration_import_rows (
  namespace TEXT NOT NULL,
  object_id TEXT NOT NULL,
  table_name TEXT NOT NULL,
  row_key TEXT NOT NULL,
  row_json TEXT NOT NULL,
  imported_at INTEGER NOT NULL,
  scan_id TEXT,
  PRIMARY KEY (namespace, object_id, table_name, row_key)
);

CREATE TABLE IF NOT EXISTS d1_migration_import_metadata (
  namespace TEXT NOT NULL,
  object_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  imported_at INTEGER NOT NULL,
  PRIMARY KEY (namespace, object_id)
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_orgs_created_at ON orgs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orgs_llm_provider_created_at ON orgs(llm_provider, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workspaces_org_created_at ON workspaces(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_threads_org_updated_at ON threads(org_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_threads_workspace_updated_at ON threads(workspace_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_apps_org_updated_at ON apps(org_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_apps_workspace_updated_at ON apps(workspace_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_org_memberships_user_id ON org_memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_org_memberships_org_joined_at ON org_memberships(org_id, joined_at DESC);
