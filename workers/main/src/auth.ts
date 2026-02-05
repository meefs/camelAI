import { DurableObject } from 'cloudflare:workers';
import { hashPassword, verifyPassword } from './password';
import { generateDefaultAvatar, validateAvatarContent } from '../../../src/lib/avatar';
import type { OrgRole, BillingStatus, User, Organization, Workspace } from '../../../src/types';
import { WorkspaceDO } from './workspace';

// Re-export for consumers that import from this module
export type { OrgRole, BillingStatus } from '../../../src/types';

// Environment bindings needed by auth Durable Objects
export interface DOEnv {
  USER: DurableObjectNamespace<UserDO>;
  ORG: DurableObjectNamespace<OrgDO>;
  WORKSPACE: DurableObjectNamespace<WorkspaceDO>;
  EMAIL_TO_USER: KVNamespace;
  APP_KV: KVNamespace; // Also used for spend tracking with prefix "spend:"
}

const SUPERUSER_EMAILS = new Set([
  'admin@example.com',
  '1033072+Vercantez@users.noreply.github.com',
]);

function isSuperuserEmail(email: string | null): boolean {
  if (!email) return false;
  return SUPERUSER_EMAILS.has(email.toLowerCase());
}

/**
 * Generate a URL-safe slug for an organization.
 * Format: {normalized-name}-{id-prefix}
 * e.g., "Acme Corp" with ID "85b12345..." becomes "acme-corp-85b"
 */
function generateOrgSlug(name: string, idPrefix: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 20) || 'org';
  return `${base}-${idPrefix}`;
}


export interface UserOrg {
  org_id: string;
  role: OrgRole;
  joined_at: number;
  last_workspace_id: string | null;
}

export type OAuthProvider = 'google' | 'github';

export interface UserOAuthProvider {
  provider: OAuthProvider;
  provider_id: string;
  linked_at: number;
}


export interface OrgMember {
  user_id: string;
  role: OrgRole;
  joined_at: number;
}

export interface OrgInvitation {
  id: string;
  email: string;
  role: OrgRole;
  invited_by: string;
  created_at: number;
  expires_at: number;
}

export interface OrgIntegrationRecord {
  id: string;
  integration_type: string;
  name: string;
  category: string;
  auth_method: string;
  config: string;
  credentials_encrypted: string;
  enabled: number;
  created_by: string;
  created_at: number;
  updated_at: number;
}

export type WorkerScriptPreviewStatus = 'pending' | 'ready' | 'failed';

export interface WorkerScript {
  script_name: string;
  workspace_id: string;
  created_by: string;
  created_at: number;
  updated_at: number;
  is_public: boolean;
  preview_key: string | null;
  preview_updated_at: number | null;
  preview_status: WorkerScriptPreviewStatus | null;
  preview_error: string | null;
  config_path: string | null;
}

export interface WorkerScriptPreviewUpdateInput {
  status: WorkerScriptPreviewStatus;
  preview_key?: string | null;
  preview_error?: string | null;
  preview_updated_at?: number;
  deploy_ts?: number;
}

export interface WorkerScriptPreviewUpdateResult {
  script: WorkerScript | null;
  updated: boolean;
  stale: boolean;
}

interface WorkerScriptRow {
  [key: string]: SqlStorageValue;
  script_name: string;
  workspace_id: string;
  created_by: string;
  created_at: number;
  updated_at: number;
  is_public: number;
  preview_key: string | null;
  preview_updated_at: number | null;
  preview_status: WorkerScriptPreviewStatus | null;
  preview_error: string | null;
  config_path: string | null;
}

export interface WorkerScriptAccess {
  script_name: string;
  workspace_id: string;
  org_id: string;
  is_public: boolean;
}

export interface OrgThread {
  id: string;
  workspace_id: string;
  title: string;
  created_by: string;
  created_at: number;
  updated_at: number;
}

export interface ProxyUsageInput {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface OpenRouterKeyRecord {
  key_hash: string; // First 8 chars of key for identification
  key_encrypted: string; // AES-GCM encrypted key
  name: string;
  limit: number | null; // Credits limit (null = unlimited)
  created_at: number;
  updated_at: number;
}

/**
 * Migration Pattern for Durable Objects
 * ======================================
 *
 * Each DO uses a `_schema_version` table to track schema version.
 * Migrations run in `blockConcurrencyWhile()` to prevent race conditions.
 *
 * To add a new migration:
 * 1. Add a new `if (version < N)` block in the `migrate()` method
 * 2. Put your schema changes inside the block
 * 3. End with: `this.sql.exec('INSERT OR REPLACE INTO _schema_version (version) VALUES (N)')`
 *
 * Example:
 *   if (version < 2) {
 *     this.sql.exec('ALTER TABLE foo ADD COLUMN bar TEXT');
 *     this.sql.exec('INSERT OR REPLACE INTO _schema_version (version) VALUES (2)');
 *   }
 *
 * Note: PRAGMA user_version is NOT supported by Cloudflare SQLite.
 */

// User Durable Object - one per user
export class UserDO extends DurableObject<DOEnv> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: DOEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;

    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
    });
  }

  private migrate() {
    // Create schema version table first (if not exists)
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS _schema_version (
        version INTEGER PRIMARY KEY
      )
    `);
    const rows = this.sql.exec<{ version: number }>('SELECT version FROM _schema_version LIMIT 1').toArray();
    const version = rows[0]?.version ?? 0;

    if (version < 1) {
      // V1: Fresh start
      this.sql.exec('DROP TABLE IF EXISTS profile');
      this.sql.exec('DROP TABLE IF EXISTS orgs');
      this.sql.exec('DROP TABLE IF EXISTS projects');
      this.sql.exec(`
        CREATE TABLE profile (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
      `);
      this.sql.exec(`
        CREATE TABLE orgs (
          org_id TEXT PRIMARY KEY,
          role TEXT NOT NULL,
          joined_at INTEGER NOT NULL,
          last_workspace_id TEXT
        )
      `);
      this.sql.exec(`
        CREATE TABLE projects (
          org_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (org_id, project_id)
        )
      `);
      this.sql.exec('INSERT INTO _schema_version (version) VALUES (1)');
    }

    if (version < 2) {
      const rows = this.sql.exec('SELECT value FROM profile WHERE key = ?', 'data').toArray();
      if (rows.length > 0) {
        const profile = JSON.parse((rows[0] as { value: string }).value) as User;
        const shouldBeSuperuser = isSuperuserEmail(profile.email);
        if (profile.is_superuser !== shouldBeSuperuser) {
          profile.is_superuser = shouldBeSuperuser;
          this.sql.exec(
            'INSERT OR REPLACE INTO profile (key, value) VALUES (?, ?)',
            'data',
            JSON.stringify(profile)
          );
        }
      }
      this.sql.exec('INSERT OR REPLACE INTO _schema_version (version) VALUES (2)');
    }

    if (version < 3) {
      // V3: Remove projects table - projects feature removed
      this.sql.exec('DROP TABLE IF EXISTS projects');
      this.sql.exec('INSERT OR REPLACE INTO _schema_version (version) VALUES (3)');
    }

    if (version < 4) {
      const rows = this.sql.exec('SELECT value FROM profile WHERE key = ?', 'data').toArray();
      if (rows.length > 0) {
        const profile = JSON.parse((rows[0] as { value: string }).value) as User;
        if (!profile.avatar) {
          profile.avatar = generateDefaultAvatar(profile.name || profile.email);
        }
        if (typeof profile.is_orphaned !== 'boolean') profile.is_orphaned = false;
        if (profile.orphaned_at === undefined) profile.orphaned_at = null;
        this.sql.exec(
          'INSERT OR REPLACE INTO profile (key, value) VALUES (?, ?)',
          'data',
          JSON.stringify(profile)
        );
      }
      this.sql.exec('INSERT OR REPLACE INTO _schema_version (version) VALUES (4)');
    }

    if (version < 5) {
      try {
        this.sql.exec('ALTER TABLE orgs ADD COLUMN last_workspace_id TEXT');
      } catch {
        // Column may already exist in fresh databases.
      }
      this.sql.exec('INSERT OR REPLACE INTO _schema_version (version) VALUES (5)');
    }

    if (version < 6) {
      // V6: Add oauth_providers table for OAuth sign-in support
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS oauth_providers (
          provider TEXT NOT NULL,
          provider_id TEXT NOT NULL,
          linked_at INTEGER NOT NULL,
          PRIMARY KEY (provider)
        )
      `);
      this.sql.exec('INSERT OR REPLACE INTO _schema_version (version) VALUES (6)');
    }
  }

  // Profile methods
  async getProfile(): Promise<User | null> {
    const rows = this.sql.exec('SELECT value FROM profile WHERE key = ?', 'data').toArray();
    if (rows.length === 0) return null;
    const profile = JSON.parse((rows[0] as { value: string }).value) as User;
    let changed = false;

    if (typeof profile.is_superuser !== 'boolean') {
      profile.is_superuser = isSuperuserEmail(profile.email);
      changed = true;
    }
    if (!profile.avatar) {
      profile.avatar = generateDefaultAvatar(profile.name || profile.email);
      changed = true;
    }
    if (typeof profile.is_orphaned !== 'boolean') {
      profile.is_orphaned = false;
      changed = true;
    }
    if (profile.orphaned_at === undefined) {
      profile.orphaned_at = null;
      changed = true;
    }

    if (changed) {
      await this.setProfile(profile);
    }
    return profile;
  }

  async setProfile(profile: User): Promise<void> {
    this.sql.exec(
      'INSERT OR REPLACE INTO profile (key, value) VALUES (?, ?)',
      'data',
      JSON.stringify(profile)
    );
  }

  async getPasswordHash(): Promise<string | null> {
    const rows = this.sql.exec('SELECT value FROM profile WHERE key = ?', 'password_hash').toArray();
    if (rows.length === 0) return null;
    return (rows[0] as { value: string }).value;
  }

  async setPasswordHash(hash: string): Promise<void> {
    this.sql.exec(
      'INSERT OR REPLACE INTO profile (key, value) VALUES (?, ?)',
      'password_hash',
      hash
    );
  }

  async verifyPassword(password: string): Promise<boolean> {
    const hash = await this.getPasswordHash();
    if (!hash) return false;
    return verifyPassword(password, hash);
  }

  async createUser(
    id: string,
    email: string,
    password: string,
    name: string | null
  ): Promise<User> {
    const now = Date.now();
    const avatar = generateDefaultAvatar(name || email);
    const profile: User = {
      id,
      email,
      name,
      created_at: now,
      is_superuser: isSuperuserEmail(email),
      avatar,
      is_orphaned: false,
      orphaned_at: null,
    };
    const passwordHash = await hashPassword(password);

    await this.setProfile(profile);
    await this.setPasswordHash(passwordHash);

    return profile;
  }

  async setOrphaned(isOrphaned: boolean): Promise<void> {
    const profile = await this.getProfile();
    if (!profile) return;
    profile.is_orphaned = isOrphaned;
    profile.orphaned_at = isOrphaned ? Date.now() : null;
    await this.setProfile(profile);
  }

  async updateProfile(updates: {
    name?: string | null;
    avatar?: { color?: string; content?: string };
    is_superuser?: boolean;
  }): Promise<User | null> {
    const profile = await this.getProfile();
    if (!profile) return null;

    let changed = false;

    if (updates.name !== undefined && updates.name !== profile.name) {
      profile.name = updates.name;
      changed = true;
    }

    if (updates.avatar?.color && updates.avatar.color !== profile.avatar.color) {
      profile.avatar.color = updates.avatar.color;
      changed = true;
    }

    if (updates.avatar?.content && updates.avatar.content !== profile.avatar.content) {
      const trimmed = updates.avatar.content.trim();
      if (!validateAvatarContent(trimmed)) {
        throw new Error('Invalid avatar content');
      }
      profile.avatar.content = trimmed;
      changed = true;
    }

    if (updates.is_superuser !== undefined && updates.is_superuser !== profile.is_superuser) {
      profile.is_superuser = updates.is_superuser;
      changed = true;
    }

    if (changed) {
      await this.setProfile(profile);
    }

    return profile;
  }

  // Org membership methods
  async getOrgs(): Promise<UserOrg[]> {
    return this.sql.exec('SELECT org_id, role, joined_at, last_workspace_id FROM orgs ORDER BY joined_at ASC')
      .toArray() as unknown as UserOrg[];
  }

  async addOrg(orgId: string, role: OrgRole, lastWorkspaceId: string | null = null): Promise<void> {
    const now = Date.now();
    this.sql.exec(
      'INSERT OR REPLACE INTO orgs (org_id, role, joined_at, last_workspace_id) VALUES (?, ?, ?, ?)',
      orgId,
      role,
      now,
      lastWorkspaceId
    );
  }

  async removeOrg(orgId: string): Promise<void> {
    this.sql.exec('DELETE FROM orgs WHERE org_id = ?', orgId);
  }

  async updateOrgRole(orgId: string, role: OrgRole): Promise<void> {
    this.sql.exec('UPDATE orgs SET role = ? WHERE org_id = ?', role, orgId);
  }

  async setOrgLastWorkspace(orgId: string, workspaceId: string | null): Promise<void> {
    this.sql.exec('UPDATE orgs SET last_workspace_id = ? WHERE org_id = ?', workspaceId, orgId);
  }

  async hasOrg(orgId: string): Promise<boolean> {
    const rows = this.sql.exec('SELECT 1 FROM orgs WHERE org_id = ?', orgId).toArray();
    return rows.length > 0;
  }

  async getOrgRole(orgId: string): Promise<OrgRole | null> {
    const rows = this.sql.exec('SELECT role FROM orgs WHERE org_id = ?', orgId).toArray();
    if (rows.length === 0) return null;
    return (rows[0] as { role: string }).role as OrgRole;
  }

  // OAuth provider methods
  async getOAuthProviders(): Promise<UserOAuthProvider[]> {
    return this.sql.exec('SELECT provider, provider_id, linked_at FROM oauth_providers ORDER BY linked_at ASC')
      .toArray() as unknown as UserOAuthProvider[];
  }

  async getOAuthProvider(provider: OAuthProvider): Promise<UserOAuthProvider | null> {
    const rows = this.sql.exec(
      'SELECT provider, provider_id, linked_at FROM oauth_providers WHERE provider = ?',
      provider
    ).toArray() as unknown as UserOAuthProvider[];
    return rows[0] || null;
  }

  async linkOAuthProvider(provider: OAuthProvider, providerId: string): Promise<UserOAuthProvider> {
    const now = Date.now();
    this.sql.exec(
      'INSERT OR REPLACE INTO oauth_providers (provider, provider_id, linked_at) VALUES (?, ?, ?)',
      provider,
      providerId,
      now
    );
    return { provider, provider_id: providerId, linked_at: now };
  }

  async unlinkOAuthProvider(provider: OAuthProvider): Promise<void> {
    this.sql.exec('DELETE FROM oauth_providers WHERE provider = ?', provider);
  }

  async hasOAuthProvider(provider: OAuthProvider): Promise<boolean> {
    const rows = this.sql.exec('SELECT 1 FROM oauth_providers WHERE provider = ?', provider).toArray();
    return rows.length > 0;
  }

  /**
   * Create a user from OAuth sign-in (no password required).
   */
  async createUserFromOAuth(
    id: string,
    email: string,
    name: string | null,
    provider: OAuthProvider,
    providerId: string
  ): Promise<User> {
    const now = Date.now();
    const avatar = generateDefaultAvatar(name || email);
    const profile: User = {
      id,
      email,
      name,
      created_at: now,
      is_superuser: isSuperuserEmail(email),
      avatar,
      is_orphaned: false,
      orphaned_at: null,
    };

    await this.setProfile(profile);
    await this.linkOAuthProvider(provider, providerId);

    return profile;
  }
}

// Organization Durable Object - one per org
export class OrgDO extends DurableObject<DOEnv> {
  private sql: SqlStorage;
  private workerScriptsHasPreviewColumns = true;

  constructor(ctx: DurableObjectState, env: DOEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;

    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
    });
  }

  private migrate() {
    // Create schema version table first (if not exists)
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS _schema_version (
        version INTEGER PRIMARY KEY
      )
    `);
    const rows = this.sql.exec<{ version: number }>('SELECT version FROM _schema_version LIMIT 1').toArray();
    const version = rows[0]?.version ?? 0;

    if (version < 1) {
      // V1: Fresh start
      this.sql.exec('DROP TABLE IF EXISTS org_info');
      this.sql.exec('DROP TABLE IF EXISTS members');
      this.sql.exec('DROP TABLE IF EXISTS invitations');
      this.sql.exec('DROP TABLE IF EXISTS integrations');
      this.sql.exec('DROP TABLE IF EXISTS workspaces');
      this.sql.exec('DROP TABLE IF EXISTS audit_log');
      this.sql.exec(`
        CREATE TABLE org_info (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
      `);
      this.sql.exec(`
        CREATE TABLE members (
          user_id TEXT PRIMARY KEY,
          role TEXT NOT NULL,
          joined_at INTEGER NOT NULL
        )
      `);
      this.sql.exec(`
        CREATE TABLE invitations (
          id TEXT PRIMARY KEY,
          email TEXT NOT NULL,
          role TEXT NOT NULL,
          invited_by TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        )
      `);
      this.sql.exec(`
        CREATE TABLE integrations (
          id TEXT PRIMARY KEY,
          integration_type TEXT NOT NULL,
          name TEXT NOT NULL,
          category TEXT NOT NULL,
          auth_method TEXT NOT NULL,
          config TEXT NOT NULL,
          credentials_encrypted TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_by TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      this.sql.exec('INSERT INTO _schema_version (version) VALUES (1)');
    }

    if (version < 2) {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS workspaces (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          archived INTEGER NOT NULL DEFAULT 0
        )
      `);
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS audit_log (
          id TEXT PRIMARY KEY,
          action TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          target_id TEXT,
          details TEXT,
          created_at INTEGER NOT NULL
        )
      `);
      const rows = this.sql.exec('SELECT value FROM org_info WHERE key = ?', 'data').toArray();
      if (rows.length > 0) {
        const info = JSON.parse((rows[0] as { value: string }).value) as Organization;
        if (!info.billing_status) info.billing_status = 'free';
        if (typeof info.archived !== 'boolean') info.archived = false;
        if (info.archived_at === undefined) info.archived_at = null;
        if (info.archived_by === undefined) info.archived_by = null;
        this.sql.exec(
          'INSERT OR REPLACE INTO org_info (key, value) VALUES (?, ?)',
          'data',
          JSON.stringify(info)
        );
      }
      this.sql.exec('UPDATE _schema_version SET version = 2');
    }

    if (version < 3) {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS worker_scripts (
          script_name TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          created_by TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      this.sql.exec('CREATE INDEX IF NOT EXISTS worker_scripts_workspace_id ON worker_scripts(workspace_id)');
      this.sql.exec('UPDATE _schema_version SET version = 3');
    }

    if (version < 4) {
      // V4: Add is_public column to worker_scripts (default false = private)
      try {
        this.sql.exec('ALTER TABLE worker_scripts ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0');
      } catch {
        // Column may already exist in fresh databases that ran V3 after this migration was added
      }
      this.sql.exec('UPDATE _schema_version SET version = 4');
    }

    if (version < 5) {
      // V5: Add threads table (consolidated from ChatIndexDO)
      // Threads are now stored per-org with workspace_id for filtering
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS threads (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          title TEXT NOT NULL,
          created_by TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      this.sql.exec('CREATE INDEX IF NOT EXISTS threads_workspace_id ON threads(workspace_id)');
      this.sql.exec('CREATE INDEX IF NOT EXISTS threads_updated_at ON threads(updated_at)');
      this.sql.exec('UPDATE _schema_version SET version = 5');
    }

    if (version < 6) {
      // V6: Ensure audit_log table exists (fix for DOs that may have skipped V2 migration)
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS audit_log (
          id TEXT PRIMARY KEY,
          action TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          target_id TEXT,
          details TEXT,
          created_at INTEGER NOT NULL
        )
      `);
      this.sql.exec('UPDATE _schema_version SET version = 6');
    }

    if (version < 7) {
      // V7: Add preview metadata fields to worker_scripts
      try {
        this.sql.exec('ALTER TABLE worker_scripts ADD COLUMN preview_key TEXT');
      } catch {
        // Column may already exist
      }
      try {
        this.sql.exec('ALTER TABLE worker_scripts ADD COLUMN preview_updated_at INTEGER');
      } catch {
        // Column may already exist
      }
      try {
        this.sql.exec("ALTER TABLE worker_scripts ADD COLUMN preview_status TEXT DEFAULT 'pending'");
      } catch {
        // Column may already exist
      }
      try {
        this.sql.exec('ALTER TABLE worker_scripts ADD COLUMN preview_error TEXT');
      } catch {
        // Column may already exist
      }
      try {
        this.sql.exec("UPDATE worker_scripts SET preview_status = 'pending' WHERE preview_status IS NULL");
      } catch {
        // Skip update if columns are unavailable (fallback queries will handle nulls)
      }
      this.sql.exec('UPDATE _schema_version SET version = 7');
    }
    if (version < 8) {
      // V8: Proxy usage rollups per user
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS proxy_usage (
          user_id TEXT PRIMARY KEY,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          total_tokens INTEGER NOT NULL DEFAULT 0,
          cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
          cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
          requests INTEGER NOT NULL DEFAULT 0,
          last_provider TEXT,
          last_model TEXT,
          last_token_id TEXT,
          updated_at INTEGER NOT NULL
        )
      `);
      this.sql.exec('UPDATE _schema_version SET version = 8');
    }

    if (version < 9) {
      // V9: Schema consistency fix - ensure all tables and columns exist
      // This fixes DOs that may have skipped migrations due to version conflicts

      // Ensure all core tables exist
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS org_info (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
      `);
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS members (
          user_id TEXT PRIMARY KEY,
          role TEXT NOT NULL,
          joined_at INTEGER NOT NULL
        )
      `);
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS invitations (
          id TEXT PRIMARY KEY,
          email TEXT NOT NULL,
          role TEXT NOT NULL,
          invited_by TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        )
      `);
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS integrations (
          id TEXT PRIMARY KEY,
          integration_type TEXT NOT NULL,
          name TEXT NOT NULL,
          category TEXT NOT NULL,
          auth_method TEXT NOT NULL,
          config TEXT NOT NULL,
          credentials_encrypted TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_by TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS workspaces (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          archived INTEGER NOT NULL DEFAULT 0
        )
      `);
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS audit_log (
          id TEXT PRIMARY KEY,
          action TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          target_id TEXT,
          details TEXT,
          created_at INTEGER NOT NULL
        )
      `);
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS worker_scripts (
          script_name TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          created_by TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      this.sql.exec('CREATE INDEX IF NOT EXISTS worker_scripts_workspace_id ON worker_scripts(workspace_id)');
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS threads (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          title TEXT NOT NULL,
          created_by TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      this.sql.exec('CREATE INDEX IF NOT EXISTS threads_workspace_id ON threads(workspace_id)');
      this.sql.exec('CREATE INDEX IF NOT EXISTS threads_updated_at ON threads(updated_at)');
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS proxy_usage (
          user_id TEXT PRIMARY KEY,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          total_tokens INTEGER NOT NULL DEFAULT 0,
          cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
          cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
          requests INTEGER NOT NULL DEFAULT 0,
          last_provider TEXT,
          last_model TEXT,
          last_token_id TEXT,
          updated_at INTEGER NOT NULL
        )
      `);

      // Ensure all columns exist on worker_scripts
      try {
        this.sql.exec('ALTER TABLE worker_scripts ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0');
      } catch {
        // Column already exists
      }
      try {
        this.sql.exec('ALTER TABLE worker_scripts ADD COLUMN preview_key TEXT');
      } catch {
        // Column already exists
      }
      try {
        this.sql.exec('ALTER TABLE worker_scripts ADD COLUMN preview_updated_at INTEGER');
      } catch {
        // Column already exists
      }
      try {
        this.sql.exec("ALTER TABLE worker_scripts ADD COLUMN preview_status TEXT DEFAULT 'pending'");
      } catch {
        // Column already exists
      }
      try {
        this.sql.exec('ALTER TABLE worker_scripts ADD COLUMN preview_error TEXT');
      } catch {
        // Column already exists
      }

      this.sql.exec('UPDATE _schema_version SET version = 9');
    }

    if (version < 10) {
      // V10: Add OpenRouter API key storage for per-org LLM access
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS openrouter_key (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          key_hash TEXT NOT NULL,
          key_encrypted TEXT NOT NULL,
          name TEXT NOT NULL,
          openrouter_key_id TEXT,
          limit_credits INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      this.sql.exec('UPDATE _schema_version SET version = 10');
    }

    if (version < 11) {
      // V11: Add config_path column to worker_scripts for tracking source directory
      try {
        this.sql.exec('ALTER TABLE worker_scripts ADD COLUMN config_path TEXT');
      } catch {
        // Column may already exist
      }
      this.sql.exec('UPDATE _schema_version SET version = 11');
    }

    if (version < 12) {
      // V12: Add slug to organization
      const rows = this.sql.exec('SELECT value FROM org_info WHERE key = ?', 'data').toArray();
      if (rows.length > 0) {
        const info = JSON.parse((rows[0] as { value: string }).value) as Organization;
        if (!info.slug) {
          info.slug = generateOrgSlug(info.name, info.id.slice(0, 3));
          this.sql.exec(
            'INSERT OR REPLACE INTO org_info (key, value) VALUES (?, ?)',
            'data',
            JSON.stringify(info)
          );
        }
      }
      this.sql.exec('UPDATE _schema_version SET version = 12');
    }

    this.workerScriptsHasPreviewColumns = this.detectWorkerScriptPreviewColumns();
    if (!this.workerScriptsHasPreviewColumns) {
      console.warn('[OrgDO] worker_scripts missing preview columns - preview updates will be skipped');
    }
  }

  private detectWorkerScriptPreviewColumns(): boolean {
    try {
      const rows = this.sql.exec<{ name: string }>('PRAGMA table_info(worker_scripts)').toArray();
      const names = new Set(rows.map((row) => row.name));
      return (
        names.has('preview_key') &&
        names.has('preview_updated_at') &&
        names.has('preview_status') &&
        names.has('preview_error')
      );
    } catch {
      return false;
    }
  }

  private execWorkerScriptsQuery(
    queryWithPreview: string,
    queryBase: string,
    params: Array<string | number>
  ): WorkerScriptRow[] {
    if (this.workerScriptsHasPreviewColumns) {
      try {
        return this.sql.exec<WorkerScriptRow>(queryWithPreview, ...params).toArray();
      } catch {
        this.workerScriptsHasPreviewColumns = false;
      }
    }
    return this.sql.exec<WorkerScriptRow>(queryBase, ...params).toArray();
  }

  private toWorkerScript(row: WorkerScriptRow): WorkerScript {
    return {
      script_name: row.script_name,
      workspace_id: row.workspace_id,
      created_by: row.created_by,
      created_at: row.created_at,
      updated_at: row.updated_at,
      is_public: row.is_public === 1,
      preview_key: row.preview_key ?? null,
      preview_updated_at: row.preview_updated_at ?? null,
      preview_status: row.preview_status ?? null,
      preview_error: row.preview_error ?? null,
      config_path: row.config_path ?? null,
    };
  }

  // Org info methods
  async getInfo(): Promise<Organization | null> {
    const rows = this.sql.exec('SELECT value FROM org_info WHERE key = ?', 'data').toArray();
    if (rows.length === 0) return null;
    const info = JSON.parse((rows[0] as { value: string }).value) as Organization;
    let changed = false;
    if (!info.billing_status) {
      info.billing_status = 'free';
      changed = true;
    }
    if (typeof info.archived !== 'boolean') {
      info.archived = false;
      changed = true;
    }
    if (info.archived_at === undefined) {
      info.archived_at = null;
      changed = true;
    }
    if (info.archived_by === undefined) {
      info.archived_by = null;
      changed = true;
    }
    if (!info.slug) {
      info.slug = generateOrgSlug(info.name, info.id.slice(0, 3));
      changed = true;
    }
    if (changed) {
      await this.setInfo(info);
    }
    return info;
  }

  /**
   * Get just the org slug (for contexts where we only need the slug).
   * Falls back to generating from name if not stored.
   */
  async getSlug(): Promise<string | null> {
    const info = await this.getInfo();
    return info?.slug ?? null;
  }

  async setInfo(info: Organization): Promise<void> {
    this.sql.exec(
      'INSERT OR REPLACE INTO org_info (key, value) VALUES (?, ?)',
      'data',
      JSON.stringify(info)
    );
  }

  async createOrg(id: string, name: string, createdBy: string): Promise<{ org: Organization; defaultWorkspaceId: string }> {
    const now = Date.now();
    const slug = generateOrgSlug(name, id.slice(0, 3));
    const info: Organization = {
      id,
      name,
      slug,
      created_at: now,
      created_by: createdBy,
      billing_status: 'free',
      archived: false,
      archived_at: null,
      archived_by: null,
    };
    await this.setInfo(info);

    // Add creator as owner
    await this.addMember(createdBy, 'owner', createdBy);
    this.log('org_created', createdBy, id, { name });

    // Create default workspace (WorkspaceDO.createWorkspace registers with org automatically)
    const workspaceId = crypto.randomUUID();
    const workspaceStub = this.env.WORKSPACE.get(
      this.env.WORKSPACE.idFromName(workspaceId)
    ) as unknown as WorkspaceDO;
    await workspaceStub.createWorkspace(
      workspaceId,
      id,
      'Default Workspace',
      createdBy,
      null
    );

    return { org: info, defaultWorkspaceId: workspaceId };
  }

  async updateName(name: string, actorId: string): Promise<void> {
    const info = await this.getInfo();
    if (info) {
      const previousName = info.name;
      info.name = name;
      await this.setInfo(info);
      if (previousName !== name) {
        this.log('org_updated', actorId, info.id, { previous_name: previousName, name });
      }
    }
  }

  // Member methods
  async getMembers(): Promise<OrgMember[]> {
    this.ensureOwnerExists('system');
    return this.sql.exec('SELECT user_id, role, joined_at FROM members ORDER BY joined_at ASC')
      .toArray() as unknown as OrgMember[];
  }

  async getMember(userId: string): Promise<OrgMember | null> {
    const rows = this.sql.exec(
      'SELECT user_id, role, joined_at FROM members WHERE user_id = ?',
      userId
    ).toArray() as unknown as OrgMember[];
    return rows[0] || null;
  }

  async addMember(userId: string, role: OrgRole, actorId: string): Promise<void> {
    const existing = await this.getMember(userId);
    const now = Date.now();
    this.sql.exec(
      'INSERT OR REPLACE INTO members (user_id, role, joined_at) VALUES (?, ?, ?)',
      userId,
      role,
      now
    );
    if (!existing) {
      this.log('member_added', actorId, userId, { role });
    }
  }

  async removeMember(userId: string, actorId: string): Promise<void> {
    const existing = await this.getMember(userId);
    if (existing?.role === 'owner') {
      throw new Error('Cannot remove the organization owner. Transfer ownership first.');
    }
    this.sql.exec('DELETE FROM members WHERE user_id = ?', userId);
    if (existing) {
      this.log('member_removed', actorId, userId, { role: existing.role });
    }
    this.ensureOwnerExists(actorId);
  }

  async updateMemberRole(userId: string, role: OrgRole, actorId: string): Promise<void> {
    const existing = await this.getMember(userId);
    if (role === 'owner') {
      throw new Error('Use transferOwnership to assign owner role');
    }
    if (existing?.role === 'owner') {
      throw new Error('Cannot change the owner role. Transfer ownership first.');
    }
    this.sql.exec('UPDATE members SET role = ? WHERE user_id = ?', role, userId);
    if (existing && existing.role !== role) {
      this.log('member_role_changed', actorId, userId, {
        old_role: existing.role,
        new_role: role,
      });
    }
    this.ensureOwnerExists(actorId);
  }

  async isMember(userId: string): Promise<boolean> {
    const rows = this.sql.exec('SELECT 1 FROM members WHERE user_id = ?', userId).toArray();
    return rows.length > 0;
  }

  async isAdmin(userId: string): Promise<boolean> {
    const rows = this.sql.exec(
      'SELECT 1 FROM members WHERE user_id = ? AND role IN (?, ?)',
      userId,
      'owner',
      'admin'
    ).toArray();
    return rows.length > 0;
  }

  async isOwner(userId: string): Promise<boolean> {
    const rows = this.sql.exec(
      'SELECT 1 FROM members WHERE user_id = ? AND role = ?',
      userId,
      'owner'
    ).toArray();
    return rows.length > 0;
  }

  async getMemberCount(): Promise<number> {
    const rows = this.sql.exec('SELECT COUNT(*) as count FROM members').toArray();
    return (rows[0] as { count: number }).count;
  }

  private ensureOwnerExists(actorId: string): void {
    const ownerRows = this.sql.exec(
      'SELECT user_id FROM members WHERE role = ? LIMIT 1',
      'owner'
    ).toArray() as Array<{ user_id: string }>;
    if (ownerRows.length > 0) return;

    const fallbackRows = this.sql.exec(
      `SELECT user_id, role, joined_at FROM members
       ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END, joined_at ASC
       LIMIT 1`
    ).toArray() as Array<{ user_id: string }>;
    const fallback = fallbackRows[0];
    if (!fallback) return;

    this.sql.exec('UPDATE members SET role = ? WHERE user_id = ?', 'owner', fallback.user_id);
    this.log('owner_recovered', actorId, fallback.user_id);
  }

  // Invitation methods
  async getInvitations(): Promise<OrgInvitation[]> {
    return this.sql.exec(
      'SELECT id, email, role, invited_by, created_at, expires_at FROM invitations ORDER BY created_at DESC'
    ).toArray() as unknown as OrgInvitation[];
  }

  async getInvitation(id: string): Promise<OrgInvitation | null> {
    const now = Date.now();
    const rows = this.sql.exec(
      'SELECT id, email, role, invited_by, created_at, expires_at FROM invitations WHERE id = ? AND expires_at > ?',
      id,
      now
    ).toArray() as unknown as OrgInvitation[];
    return rows[0] || null;
  }

  async getInvitationByEmail(email: string): Promise<OrgInvitation | null> {
    const now = Date.now();
    const rows = this.sql.exec(
      'SELECT id, email, role, invited_by, created_at, expires_at FROM invitations WHERE email = ? AND expires_at > ?',
      email.toLowerCase(),
      now
    ).toArray() as unknown as OrgInvitation[];
    return rows[0] || null;
  }

  async createInvitation(
    email: string,
    role: OrgRole,
    invitedBy: string
  ): Promise<OrgInvitation> {
    const id = crypto.randomUUID();
    const now = Date.now();
    const expiresAt = now + 7 * 24 * 60 * 60 * 1000; // 7 days

    const invitation: OrgInvitation = {
      id,
      email: email.toLowerCase(),
      role,
      invited_by: invitedBy,
      created_at: now,
      expires_at: expiresAt,
    };

    this.sql.exec(
      'INSERT INTO invitations (id, email, role, invited_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      id,
      email.toLowerCase(),
      role,
      invitedBy,
      now,
      expiresAt
    );

    return invitation;
  }

  async deleteInvitation(id: string): Promise<void> {
    this.sql.exec('DELETE FROM invitations WHERE id = ?', id);
  }

  async acceptInvitation(invitationId: string, userId: string): Promise<boolean> {
    const invitation = await this.getInvitation(invitationId);
    if (!invitation) return false;

    // Add user as member with invited role
    await this.addMember(userId, invitation.role, userId);

    // Delete the invitation (single use)
    await this.deleteInvitation(invitationId);

    return true;
  }

  // Integration methods
  /** @deprecated Integrations are workspace-scoped; migrate to WorkspaceDO. */
  async getIntegrations(): Promise<OrgIntegrationRecord[]> {
    return this.sql
      .exec(
        `SELECT id, integration_type, name, category, auth_method, config,
                credentials_encrypted, enabled, created_by, created_at, updated_at
         FROM integrations
         ORDER BY created_at DESC`
      )
      .toArray() as unknown as OrgIntegrationRecord[];
  }

  /** @deprecated Integrations are workspace-scoped; migrate to WorkspaceDO. */
  async getIntegration(id: string): Promise<OrgIntegrationRecord | null> {
    const rows = this.sql
      .exec(
        `SELECT id, integration_type, name, category, auth_method, config,
                credentials_encrypted, enabled, created_by, created_at, updated_at
         FROM integrations WHERE id = ?`,
        id
      )
      .toArray() as unknown as OrgIntegrationRecord[];
    return rows[0] || null;
  }

  /** @deprecated Integrations are workspace-scoped; migrate to WorkspaceDO. */
  async createIntegration(
    id: string,
    integrationType: string,
    name: string,
    category: string,
    authMethod: string,
    config: string,
    credentialsEncrypted: string,
    createdBy: string
  ): Promise<void> {
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO integrations
       (id, integration_type, name, category, auth_method, config, credentials_encrypted, enabled, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      id,
      integrationType,
      name,
      category,
      authMethod,
      config,
      credentialsEncrypted,
      createdBy,
      now,
      now
    );
  }

  /** @deprecated Integrations are workspace-scoped; migrate to WorkspaceDO. */
  async updateIntegration(
    id: string,
    updates: {
      name?: string;
      config?: string;
      credentialsEncrypted?: string;
      enabled?: boolean;
    }
  ): Promise<void> {
    const now = Date.now();
    const setClauses: string[] = ['updated_at = ?'];
    const params: (string | number)[] = [now];

    if (updates.name !== undefined) {
      setClauses.push('name = ?');
      params.push(updates.name);
    }
    if (updates.config !== undefined) {
      setClauses.push('config = ?');
      params.push(updates.config);
    }
    if (updates.credentialsEncrypted !== undefined) {
      setClauses.push('credentials_encrypted = ?');
      params.push(updates.credentialsEncrypted);
    }
    if (updates.enabled !== undefined) {
      setClauses.push('enabled = ?');
      params.push(updates.enabled ? 1 : 0);
    }

    params.push(id);
    this.sql.exec(`UPDATE integrations SET ${setClauses.join(', ')} WHERE id = ?`, ...params);
  }

  /** @deprecated Integrations are workspace-scoped; migrate to WorkspaceDO. */
  async deleteIntegration(id: string): Promise<void> {
    this.sql.exec('DELETE FROM integrations WHERE id = ?', id);
  }

  /** @deprecated Integrations are workspace-scoped; migrate to WorkspaceDO. */
  async dropLegacyIntegrations(): Promise<void> {
    this.sql.exec('DROP TABLE IF EXISTS integrations');
  }

  // Worker script methods
  async registerWorkerScript(
    scriptName: string,
    workspaceId: string,
    createdBy: string,
    configPath?: string
  ): Promise<WorkerScript> {
    const now = Date.now();
    const existing = await this.getWorkerScript(scriptName);

    if (existing) {
      // Check if script belongs to a different workspace - prevent name collisions
      if (existing.workspace_id !== workspaceId) {
        throw new Error(
          `Script name "${scriptName}" is already in use by another workspace in this organization. ` +
          `Please choose a different name.`
        );
      }

      // Same workspace - update the script (redeploy)
      this.sql.exec(
        'UPDATE worker_scripts SET updated_at = ?, config_path = ? WHERE script_name = ?',
        now,
        configPath ?? null,
        scriptName
      );
      this.log('worker_script_updated', createdBy, scriptName, { workspace_id: workspaceId, config_path: configPath });
      return {
        ...existing,
        updated_at: now,
        config_path: configPath ?? existing.config_path,
      };
    }

    this.sql.exec(
      'INSERT INTO worker_scripts (script_name, workspace_id, created_by, created_at, updated_at, is_public, config_path) VALUES (?, ?, ?, ?, ?, 1, ?)',
      scriptName,
      workspaceId,
      createdBy,
      now,
      now,
      configPath ?? null
    );
    this.log('worker_script_registered', createdBy, scriptName, { workspace_id: workspaceId, config_path: configPath });
    return {
      script_name: scriptName,
      workspace_id: workspaceId,
      created_by: createdBy,
      created_at: now,
      updated_at: now,
      is_public: true,
      preview_key: null,
      preview_updated_at: null,
      preview_status: 'pending',
      preview_error: null,
      config_path: configPath ?? null,
    };
  }

  async getWorkerScript(scriptName: string): Promise<WorkerScript | null> {
    const queryWithPreview = `SELECT script_name, workspace_id, created_by, created_at, updated_at, is_public,
                                     preview_key, preview_updated_at, preview_status, preview_error, config_path
                              FROM worker_scripts WHERE script_name = ?`;
    const queryBase = `SELECT script_name, workspace_id, created_by, created_at, updated_at, is_public,
                              NULL AS preview_key, NULL AS preview_updated_at, NULL AS preview_status, NULL AS preview_error, NULL AS config_path
                       FROM worker_scripts WHERE script_name = ?`;
    const rows = this.execWorkerScriptsQuery(queryWithPreview, queryBase, [scriptName]);
    if (rows.length === 0) return null;
    return this.toWorkerScript(rows[0]);
  }

  async listWorkerScripts(): Promise<WorkerScript[]> {
    const queryWithPreview = `SELECT script_name, workspace_id, created_by, created_at, updated_at, is_public,
                                     preview_key, preview_updated_at, preview_status, preview_error, config_path
                              FROM worker_scripts ORDER BY updated_at DESC`;
    const queryBase = `SELECT script_name, workspace_id, created_by, created_at, updated_at, is_public,
                              NULL AS preview_key, NULL AS preview_updated_at, NULL AS preview_status, NULL AS preview_error, NULL AS config_path
                       FROM worker_scripts ORDER BY updated_at DESC`;
    const rows = this.execWorkerScriptsQuery(queryWithPreview, queryBase, []);
    return rows.map((row) => this.toWorkerScript(row));
  }

  async listWorkerScriptsPaginated(
    offset: number,
    limit: number,
    search?: string
  ): Promise<{ items: WorkerScript[]; total: number }> {
    const normalized = search?.trim().toLowerCase();
    const whereClause = normalized ? 'WHERE lower(script_name) LIKE ?' : '';
    const params: Array<string | number> = [];
    if (normalized) {
      params.push(`%${normalized}%`);
    }

    const countRows = this.sql.exec(
      `SELECT COUNT(*) as count FROM worker_scripts ${whereClause}`,
      ...params
    ).toArray() as unknown as Array<{ count: number }>;
    const total = countRows[0]?.count ?? 0;

    const queryWithPreview = `SELECT script_name, workspace_id, created_by, created_at, updated_at, is_public,
                                     preview_key, preview_updated_at, preview_status, preview_error, config_path
                              FROM worker_scripts ${whereClause} ORDER BY updated_at DESC LIMIT ? OFFSET ?`;
    const queryBase = `SELECT script_name, workspace_id, created_by, created_at, updated_at, is_public,
                              NULL AS preview_key, NULL AS preview_updated_at, NULL AS preview_status, NULL AS preview_error, NULL AS config_path
                       FROM worker_scripts ${whereClause} ORDER BY updated_at DESC LIMIT ? OFFSET ?`;
    const items = this.execWorkerScriptsQuery(queryWithPreview, queryBase, [...params, limit, offset]);
    return {
      items: items.map((row) => this.toWorkerScript(row)),
      total,
    };
  }

  async listWorkerScriptsByWorkspace(workspaceId: string): Promise<WorkerScript[]> {
    const queryWithPreview = `SELECT script_name, workspace_id, created_by, created_at, updated_at, is_public,
                                     preview_key, preview_updated_at, preview_status, preview_error, config_path
                              FROM worker_scripts WHERE workspace_id = ? ORDER BY updated_at DESC`;
    const queryBase = `SELECT script_name, workspace_id, created_by, created_at, updated_at, is_public,
                              NULL AS preview_key, NULL AS preview_updated_at, NULL AS preview_status, NULL AS preview_error, NULL AS config_path
                       FROM worker_scripts WHERE workspace_id = ? ORDER BY updated_at DESC`;
    const rows = this.execWorkerScriptsQuery(queryWithPreview, queryBase, [workspaceId]);
    return rows.map((row) => this.toWorkerScript(row));
  }

  async updateWorkerScript(scriptName: string, actorId: string): Promise<WorkerScript | null> {
    const now = Date.now();
    this.sql.exec('UPDATE worker_scripts SET updated_at = ? WHERE script_name = ?', now, scriptName);
    const script = await this.getWorkerScript(scriptName);
    if (script) {
      this.log('worker_script_touched', actorId, scriptName);
    }
    return script;
  }

  async setWorkerScriptPublic(scriptName: string, isPublic: boolean, actorId: string): Promise<WorkerScript | null> {
    const existing = await this.getWorkerScript(scriptName);
    if (!existing) return null;
    const now = Date.now();
    this.sql.exec(
      'UPDATE worker_scripts SET is_public = ?, updated_at = ? WHERE script_name = ?',
      isPublic ? 1 : 0,
      now,
      scriptName
    );
    this.log('worker_script_visibility_changed', actorId, scriptName, { is_public: isPublic });
    return {
      ...existing,
      is_public: isPublic,
      updated_at: now,
    };
  }

  async updateWorkerScriptPreview(
    scriptName: string,
    input: WorkerScriptPreviewUpdateInput
  ): Promise<WorkerScriptPreviewUpdateResult> {
    const existing = await this.getWorkerScript(scriptName);
    if (!existing) {
      return { script: null, updated: false, stale: false };
    }

    if (!this.workerScriptsHasPreviewColumns) {
      return { script: existing, updated: false, stale: false };
    }

    if (input.deploy_ts && existing.updated_at > input.deploy_ts) {
      return { script: existing, updated: false, stale: true };
    }

    const previewUpdatedAt = input.preview_updated_at ?? Date.now();
    this.sql.exec(
      `UPDATE worker_scripts
       SET preview_status = ?, preview_key = ?, preview_error = ?, preview_updated_at = ?
       WHERE script_name = ?`,
      input.status,
      input.preview_key ?? null,
      input.preview_error ?? null,
      previewUpdatedAt,
      scriptName
    );

    const script = await this.getWorkerScript(scriptName);
    return { script, updated: true, stale: false };
  }

  async deleteWorkerScript(scriptName: string, actorId: string): Promise<boolean> {
    const existing = await this.getWorkerScript(scriptName);
    if (!existing) return false;
    this.sql.exec('DELETE FROM worker_scripts WHERE script_name = ?', scriptName);
    this.log('worker_script_deleted', actorId, scriptName, { workspace_id: existing.workspace_id });
    return true;
  }

  private log(
    action: string,
    actorId: string,
    targetId?: string,
    details?: Record<string, unknown>
  ): void {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.sql.exec(
      'INSERT INTO audit_log (id, action, actor_id, target_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      id,
      action,
      actorId,
      targetId ?? null,
      details ? JSON.stringify(details) : null,
      now
    );
  }

  async addWorkspace(workspaceId: string, name: string, createdAt: number, actorId: string): Promise<void> {
    this.sql.exec(
      'INSERT INTO workspaces (id, name, created_at, archived) VALUES (?, ?, ?, 0) ON CONFLICT(id) DO UPDATE SET name = excluded.name, created_at = excluded.created_at',
      workspaceId,
      name,
      createdAt
    );
    this.log('workspace_created', actorId, workspaceId, { name });
  }

  async archiveWorkspace(workspaceId: string): Promise<void> {
    this.sql.exec('UPDATE workspaces SET archived = 1 WHERE id = ?', workspaceId);
  }

  async getWorkspaces(): Promise<Array<{ id: string; name: string; created_at: number; archived: number }>> {
    return this.sql.exec('SELECT id, name, created_at, archived FROM workspaces ORDER BY created_at ASC')
      .toArray() as unknown as Array<{ id: string; name: string; created_at: number; archived: number }>;
  }

  async transferOwnership(actorId: string, newOwnerId: string): Promise<void> {
    const currentOwnerRows = this.sql.exec(
      'SELECT user_id FROM members WHERE role = ? LIMIT 1',
      'owner'
    ).toArray() as Array<{ user_id: string }>;
    const currentOwner = currentOwnerRows[0]?.user_id;
    if (!currentOwner) {
      throw new Error('No owner found');
    }
    if (currentOwner !== actorId) {
      throw new Error('Only the owner can transfer ownership');
    }

    const newOwnerRows = this.sql.exec(
      'SELECT 1 FROM members WHERE user_id = ?',
      newOwnerId
    ).toArray();
    if (newOwnerRows.length === 0) {
      throw new Error('New owner is not a member');
    }

    this.sql.exec('UPDATE members SET role = ? WHERE user_id = ?', 'owner', newOwnerId);
    this.sql.exec('UPDATE members SET role = ? WHERE user_id = ?', 'admin', currentOwner);
    this.log('ownership_transferred', actorId, newOwnerId, { from_user_id: currentOwner });
  }

  async adminTransferOwnership(actorId: string, newOwnerId: string): Promise<void> {
    const currentOwnerRows = this.sql.exec(
      'SELECT user_id FROM members WHERE role = ? LIMIT 1',
      'owner'
    ).toArray() as Array<{ user_id: string }>;
    const currentOwner = currentOwnerRows[0]?.user_id;
    if (!currentOwner) {
      throw new Error('No owner found');
    }

    const newOwnerRows = this.sql.exec(
      'SELECT 1 FROM members WHERE user_id = ?',
      newOwnerId
    ).toArray();
    if (newOwnerRows.length === 0) {
      throw new Error('New owner is not a member');
    }

    if (newOwnerId === currentOwner) {
      return;
    }

    this.sql.exec('UPDATE members SET role = ? WHERE user_id = ?', 'owner', newOwnerId);
    this.sql.exec('UPDATE members SET role = ? WHERE user_id = ?', 'admin', currentOwner);
    this.log('ownership_transferred', actorId, newOwnerId, { from_user_id: currentOwner });
  }

  async archiveOrg(actorId: string): Promise<void> {
    const info = await this.getInfo();
    if (!info) {
      throw new Error('Organization not found');
    }
    if (info.archived) return;
    info.archived = true;
    info.archived_at = Date.now();
    info.archived_by = actorId;
    await this.setInfo(info);
    this.log('org_archived', actorId);
  }

  async getAuditLog(limit = 100, offset = 0): Promise<Array<{ id: string; action: string; actor_id: string; target_id: string | null; details: string | null; created_at: number }>> {
    const resolvedLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    const resolvedOffset = Math.max(0, Math.floor(offset));
    return this.sql.exec(
      'SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ? OFFSET ?',
      resolvedLimit,
      resolvedOffset
    ).toArray() as unknown as Array<{ id: string; action: string; actor_id: string; target_id: string | null; details: string | null; created_at: number }>;
  }

  // Thread methods (consolidated from ChatIndexDO)

  /**
   * Get all threads across all workspaces in this org
   */
  getThreads(): OrgThread[] {
    return this.sql
      .exec('SELECT * FROM threads ORDER BY updated_at DESC')
      .toArray() as unknown as OrgThread[];
  }

  /**
   * Get threads for a specific workspace
   */
  getThreadsByWorkspace(workspaceId: string): OrgThread[] {
    return this.sql
      .exec('SELECT * FROM threads WHERE workspace_id = ? ORDER BY updated_at DESC', workspaceId)
      .toArray() as unknown as OrgThread[];
  }

  /**
   * Get threads with pagination (optionally filtered by workspace)
   */
  getThreadsPaginated(
    offset = 0,
    limit = 50,
    workspaceId?: string
  ): { items: OrgThread[]; total: number; offset: number; limit: number } {
    const resolvedOffset = Math.max(0, Math.floor(offset));
    const resolvedLimit = Math.max(1, Math.min(200, Math.floor(limit)));

    let items: OrgThread[];
    let total: number;

    if (workspaceId) {
      items = this.sql
        .exec(
          'SELECT * FROM threads WHERE workspace_id = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?',
          workspaceId,
          resolvedLimit,
          resolvedOffset
        )
        .toArray() as unknown as OrgThread[];
      const totalRows = this.sql
        .exec('SELECT COUNT(*) as count FROM threads WHERE workspace_id = ?', workspaceId)
        .toArray() as Array<{ count: number }>;
      total = Number(totalRows[0]?.count ?? 0);
    } else {
      items = this.sql
        .exec(
          'SELECT * FROM threads ORDER BY updated_at DESC LIMIT ? OFFSET ?',
          resolvedLimit,
          resolvedOffset
        )
        .toArray() as unknown as OrgThread[];
      const totalRows = this.sql
        .exec('SELECT COUNT(*) as count FROM threads')
        .toArray() as Array<{ count: number }>;
      total = Number(totalRows[0]?.count ?? 0);
    }

    return {
      items,
      total,
      offset: resolvedOffset,
      limit: resolvedLimit,
    };
  }

  /**
   * Get threads across specific workspaces with pagination.
   */
  getThreadsAllWorkspacesPaginated(
    workspaceIds: string[],
    offset = 0,
    limit = 50
  ): { items: OrgThread[]; total: number; offset: number; limit: number } {
    const resolvedOffset = Math.max(0, Math.floor(offset));
    const resolvedLimit = Math.max(1, Math.min(200, Math.floor(limit)));

    if (workspaceIds.length === 0) {
      return {
        items: [],
        total: 0,
        offset: resolvedOffset,
        limit: resolvedLimit,
      };
    }

    const placeholders = workspaceIds.map(() => '?').join(',');
    const items = this.sql
      .exec(
        `SELECT * FROM threads WHERE workspace_id IN (${placeholders}) ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
        ...workspaceIds,
        resolvedLimit,
        resolvedOffset
      )
      .toArray() as unknown as OrgThread[];

    const totalRows = this.sql
      .exec(`SELECT COUNT(*) as count FROM threads WHERE workspace_id IN (${placeholders})`, ...workspaceIds)
      .toArray() as Array<{ count: number }>;
    const total = Number(totalRows[0]?.count ?? 0);

    return {
      items,
      total,
      offset: resolvedOffset,
      limit: resolvedLimit,
    };
  }

  /**
   * Create a new thread with a server-generated UUID
   */
  createThread(workspaceId: string, title: string | undefined, createdBy?: string): OrgThread {
    const id = crypto.randomUUID();
    const now = Date.now();
    const t = title || 'New Chat';
    const creator = createdBy?.trim() || 'system';
    this.sql.exec(
      'INSERT INTO threads (id, workspace_id, title, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      id,
      workspaceId,
      t,
      creator,
      now,
      now
    );
    this.log('thread_created', creator, id, { workspace_id: workspaceId, title: t });
    return {
      id,
      workspace_id: workspaceId,
      title: t,
      created_by: creator,
      created_at: now,
      updated_at: now,
    };
  }

  /**
   * Get a thread by ID
   */
  getThread(id: string): OrgThread | null {
    const rows = this.sql
      .exec('SELECT * FROM threads WHERE id = ?', id)
      .toArray() as unknown as OrgThread[];
    return rows[0] || null;
  }

  /**
   * Update a thread's title
   */
  updateThread(id: string, title: string, actorId?: string): OrgThread | null {
    const existing = this.getThread(id);
    if (!existing) return null;
    const now = Date.now();
    this.sql.exec('UPDATE threads SET title = ?, updated_at = ? WHERE id = ?', title, now, id);
    if (actorId) {
      this.log('thread_updated', actorId, id, { title });
    }
    return {
      ...existing,
      title,
      updated_at: now,
    };
  }

  /**
   * Admin: Update thread with arbitrary fields
   */
  adminUpdateThread(id: string, updates: { title?: string; created_by?: string }, actorId?: string): OrgThread | null {
    const existing = this.getThread(id);
    if (!existing) return null;
    const now = Date.now();

    const setClauses: string[] = ['updated_at = ?'];
    const params: (string | number)[] = [now];

    if (updates.title !== undefined) {
      setClauses.push('title = ?');
      params.push(updates.title);
    }
    if (updates.created_by !== undefined) {
      setClauses.push('created_by = ?');
      params.push(updates.created_by);
    }

    params.push(id);
    this.sql.exec(`UPDATE threads SET ${setClauses.join(', ')} WHERE id = ?`, ...params);

    if (actorId) {
      this.log('thread_admin_updated', actorId, id, updates);
    }

    return {
      ...existing,
      title: updates.title ?? existing.title,
      created_by: updates.created_by ?? existing.created_by,
      updated_at: now,
    };
  }

  /**
   * Delete a thread
   */
  deleteThread(id: string, actorId?: string): boolean {
    const existing = this.getThread(id);
    if (!existing) return false;
    this.sql.exec('DELETE FROM threads WHERE id = ?', id);
    if (actorId) {
      this.log('thread_deleted', actorId, id, { workspace_id: existing.workspace_id });
    }
    return true;
  }

  /**
   * Touch a thread (update its updated_at timestamp)
   */
  touchThread(id: string): void {
    const now = Date.now();
    this.sql.exec('UPDATE threads SET updated_at = ? WHERE id = ?', now, id);
  }

  /**
   * Search threads by title across all workspaces in this org
   */
  searchThreads(query: string, limit = 50): OrgThread[] {
    const resolvedLimit = Math.max(1, Math.min(200, Math.floor(limit)));
    const searchPattern = `%${query}%`;
    return this.sql
      .exec(
        'SELECT * FROM threads WHERE title LIKE ? ORDER BY updated_at DESC LIMIT ?',
        searchPattern,
        resolvedLimit
      )
      .toArray() as unknown as OrgThread[];
  }

  /**
   * Record proxy usage for a user (rollup per user within the org).
   */
  recordProxyUsage(
    userId: string,
    usage: ProxyUsageInput,
    provider?: string | null,
    model?: string | null,
    tokenId?: string | null
  ): void {
    const now = Date.now();
    const inputTokens = Math.max(0, Math.floor(usage.input_tokens ?? 0));
    const outputTokens = Math.max(0, Math.floor(usage.output_tokens ?? 0));
    const totalTokens = Math.max(0, Math.floor(usage.total_tokens ?? inputTokens + outputTokens));
    const cacheCreationTokens = Math.max(0, Math.floor(usage.cache_creation_input_tokens ?? 0));
    const cacheReadTokens = Math.max(0, Math.floor(usage.cache_read_input_tokens ?? 0));

    this.sql.exec(
      `
      INSERT INTO proxy_usage (
        user_id,
        input_tokens,
        output_tokens,
        total_tokens,
        cache_creation_input_tokens,
        cache_read_input_tokens,
        requests,
        last_provider,
        last_model,
        last_token_id,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        input_tokens = input_tokens + excluded.input_tokens,
        output_tokens = output_tokens + excluded.output_tokens,
        total_tokens = total_tokens + excluded.total_tokens,
        cache_creation_input_tokens = cache_creation_input_tokens + excluded.cache_creation_input_tokens,
        cache_read_input_tokens = cache_read_input_tokens + excluded.cache_read_input_tokens,
        requests = requests + 1,
        last_provider = excluded.last_provider,
        last_model = excluded.last_model,
        last_token_id = excluded.last_token_id,
        updated_at = excluded.updated_at
      `,
      userId,
      inputTokens,
      outputTokens,
      totalTokens,
      cacheCreationTokens,
      cacheReadTokens,
      1,
      provider ?? null,
      model ?? null,
      tokenId ?? null,
      now
    );
  }

  // Spend tracking (writes to KV for rate limiting)

  /**
   * Record spend to KV. Called from proxy via RPC to ensure ordered writes.
   */
  async recordSpend(orgId: string, costCents: number): Promise<void> {
    const { recordSpendToKV } = await import('./lib/cost-calculation.js');
    await recordSpendToKV(this.env.APP_KV, orgId, costCents);
  }

  // OpenRouter API key methods

  /**
   * Get the OpenRouter API key for this org (encrypted).
   * Returns null if no key has been provisioned yet.
   */
  getOpenRouterKeyRecord(): OpenRouterKeyRecord | null {
    const rows = this.sql.exec(`
      SELECT key_hash, key_encrypted, name, limit_credits, created_at, updated_at
      FROM openrouter_key WHERE id = 1
    `).toArray() as unknown as Array<{
      key_hash: string;
      key_encrypted: string;
      name: string;
      limit_credits: number | null;
      created_at: number;
      updated_at: number;
    }>;
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      key_hash: row.key_hash,
      key_encrypted: row.key_encrypted,
      name: row.name,
      limit: row.limit_credits,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  /**
   * Store an OpenRouter API key for this org.
   * The key should already be encrypted before calling this method.
   */
  setOpenRouterKey(
    keyHash: string,
    keyEncrypted: string,
    name: string,
    openrouterKeyId: string | null,
    limitCredits: number | null
  ): void {
    const now = Date.now();
    this.sql.exec(`
      INSERT INTO openrouter_key (id, key_hash, key_encrypted, name, openrouter_key_id, limit_credits, created_at, updated_at)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        key_hash = excluded.key_hash,
        key_encrypted = excluded.key_encrypted,
        name = excluded.name,
        openrouter_key_id = excluded.openrouter_key_id,
        limit_credits = excluded.limit_credits,
        updated_at = excluded.updated_at
    `, keyHash, keyEncrypted, name, openrouterKeyId, limitCredits, now, now);
  }

  /**
   * Check if this org has an OpenRouter API key.
   */
  hasOpenRouterKey(): boolean {
    const rows = this.sql.exec('SELECT 1 FROM openrouter_key WHERE id = 1').toArray();
    return rows.length > 0;
  }

  /**
   * Delete the OpenRouter API key for this org.
   */
  deleteOpenRouterKey(): void {
    this.sql.exec('DELETE FROM openrouter_key WHERE id = 1');
  }
}
