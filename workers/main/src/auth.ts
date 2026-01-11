import { DurableObject } from 'cloudflare:workers';
import { hashPassword, verifyPassword } from './password';
import { generateDefaultAvatar, validateAvatarContent } from '../../../src/lib/avatar';

// Auth-specific environment bindings
export interface AuthEnv {
  USER: DurableObjectNamespace<UserDO>;
  ORG: DurableObjectNamespace<OrgDO>;
  EMAIL_TO_USER: KVNamespace;
}

export type OrgRole = 'owner' | 'admin' | 'member' | 'viewer';
export type BillingStatus = 'free' | 'paying';

const SUPERUSER_EMAILS = new Set([
  'admin@example.com',
  '1033072+Vercantez@users.noreply.github.com',
]);

function isSuperuserEmail(email: string | null): boolean {
  if (!email) return false;
  return SUPERUSER_EMAILS.has(email.toLowerCase());
}

export interface UserProfile {
  id: string;
  email: string;
  name: string | null;
  created_at: number;
  is_superuser: boolean;
  avatar_color: string;
  avatar_content: string;
  is_orphaned: boolean;
  orphaned_at: number | null;
}

export interface UserOrg {
  org_id: string;
  role: OrgRole;
  joined_at: number;
  last_workspace_id: string | null;
}

export interface OrgInfo {
  id: string;
  name: string;
  created_at: number;
  created_by: string;
  billing_status: BillingStatus;
  archived: boolean;
  archived_at: number | null;
  archived_by: string | null;
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

export interface WorkerScript {
  script_name: string;
  workspace_id: string;
  created_by: string;
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
export class UserDO extends DurableObject<AuthEnv> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: AuthEnv) {
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
        const profile = JSON.parse((rows[0] as { value: string }).value) as UserProfile;
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
        const profile = JSON.parse((rows[0] as { value: string }).value) as UserProfile;
        const avatar = generateDefaultAvatar(profile.name || profile.email);
        if (!profile.avatar_color) profile.avatar_color = avatar.color;
        if (!profile.avatar_content) profile.avatar_content = avatar.content;
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
  }

  // Profile methods
  async getProfile(): Promise<UserProfile | null> {
    const rows = this.sql.exec('SELECT value FROM profile WHERE key = ?', 'data').toArray();
    if (rows.length === 0) return null;
    const profile = JSON.parse((rows[0] as { value: string }).value) as UserProfile;
    let changed = false;
    if (typeof profile.is_superuser !== 'boolean') {
      profile.is_superuser = isSuperuserEmail(profile.email);
      changed = true;
    }
    if (!profile.avatar_color || !profile.avatar_content) {
      const avatar = generateDefaultAvatar(profile.name || profile.email);
      if (!profile.avatar_color) profile.avatar_color = avatar.color;
      if (!profile.avatar_content) profile.avatar_content = avatar.content;
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

  async setProfile(profile: UserProfile): Promise<void> {
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
  ): Promise<UserProfile> {
    const now = Date.now();
    const avatar = generateDefaultAvatar(name || email);
    const profile: UserProfile = {
      id,
      email,
      name,
      created_at: now,
      is_superuser: isSuperuserEmail(email),
      avatar_color: avatar.color,
      avatar_content: avatar.content,
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
    avatar_color?: string;
    avatar_content?: string;
  }): Promise<UserProfile | null> {
    const profile = await this.getProfile();
    if (!profile) return null;

    let changed = false;

    if (updates.name !== undefined && updates.name !== profile.name) {
      profile.name = updates.name;
      changed = true;
    }

    if (updates.avatar_color && updates.avatar_color !== profile.avatar_color) {
      profile.avatar_color = updates.avatar_color;
      changed = true;
    }

    if (updates.avatar_content && updates.avatar_content !== profile.avatar_content) {
      const trimmed = updates.avatar_content.trim();
      if (!validateAvatarContent(trimmed)) {
        throw new Error('Invalid avatar content');
      }
      profile.avatar_content = trimmed;
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
}

// Organization Durable Object - one per org
export class OrgDO extends DurableObject<AuthEnv> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: AuthEnv) {
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
        const info = JSON.parse((rows[0] as { value: string }).value) as OrgInfo;
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
  }

  // Org info methods
  async getInfo(): Promise<OrgInfo | null> {
    const rows = this.sql.exec('SELECT value FROM org_info WHERE key = ?', 'data').toArray();
    if (rows.length === 0) return null;
    const info = JSON.parse((rows[0] as { value: string }).value) as OrgInfo;
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
    if (changed) {
      await this.setInfo(info);
    }
    return info;
  }

  async setInfo(info: OrgInfo): Promise<void> {
    this.sql.exec(
      'INSERT OR REPLACE INTO org_info (key, value) VALUES (?, ?)',
      'data',
      JSON.stringify(info)
    );
  }

  async createOrg(id: string, name: string, createdBy: string): Promise<OrgInfo> {
    const now = Date.now();
    const info: OrgInfo = {
      id,
      name,
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

    return info;
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
    createdBy: string
  ): Promise<WorkerScript> {
    const now = Date.now();
    const existing = await this.getWorkerScript(scriptName);

    if (existing) {
      this.sql.exec(
        'UPDATE worker_scripts SET workspace_id = ?, updated_at = ? WHERE script_name = ?',
        workspaceId,
        now,
        scriptName
      );
      this.log('worker_script_updated', createdBy, scriptName, { workspace_id: workspaceId });
      return {
        script_name: scriptName,
        workspace_id: workspaceId,
        created_by: existing.created_by,
        created_at: existing.created_at,
        updated_at: now,
      };
    }

    this.sql.exec(
      'INSERT INTO worker_scripts (script_name, workspace_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      scriptName,
      workspaceId,
      createdBy,
      now,
      now
    );
    this.log('worker_script_registered', createdBy, scriptName, { workspace_id: workspaceId });
    return {
      script_name: scriptName,
      workspace_id: workspaceId,
      created_by: createdBy,
      created_at: now,
      updated_at: now,
    };
  }

  async getWorkerScript(scriptName: string): Promise<WorkerScript | null> {
    const rows = this.sql.exec(
      'SELECT script_name, workspace_id, created_by, created_at, updated_at FROM worker_scripts WHERE script_name = ?',
      scriptName
    ).toArray() as unknown as WorkerScript[];
    return rows[0] || null;
  }

  async listWorkerScripts(): Promise<WorkerScript[]> {
    return this.sql.exec(
      'SELECT script_name, workspace_id, created_by, created_at, updated_at FROM worker_scripts ORDER BY updated_at DESC'
    ).toArray() as unknown as WorkerScript[];
  }

  async listWorkerScriptsByWorkspace(workspaceId: string): Promise<WorkerScript[]> {
    return this.sql.exec(
      'SELECT script_name, workspace_id, created_by, created_at, updated_at FROM worker_scripts WHERE workspace_id = ? ORDER BY updated_at DESC',
      workspaceId
    ).toArray() as unknown as WorkerScript[];
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
}
