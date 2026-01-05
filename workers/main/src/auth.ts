import { DurableObject } from 'cloudflare:workers';
import { hashPassword, verifyPassword } from './password';

// Auth-specific environment bindings
export interface AuthEnv {
  SESSION: DurableObjectNamespace<SessionDO>;
  USER: DurableObjectNamespace<UserDO>;
  ORG: DurableObjectNamespace<OrgDO>;
  EMAIL_TO_USER: KVNamespace;
}

// Types
export interface SessionData {
  user_id: string;
  org_id: string;
  created_at: number;
  last_accessed: number;
  expires_at: number;
}

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
}

export interface UserOrg {
  org_id: string;
  role: 'admin' | 'member';
  joined_at: number;
}

export interface OrgInfo {
  id: string;
  name: string;
  created_at: number;
  created_by: string;
}

export interface OrgMember {
  user_id: string;
  role: 'admin' | 'member';
  joined_at: number;
}

export interface OrgInvitation {
  id: string;
  email: string;
  role: 'admin' | 'member';
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

// Session Durable Object - one per session
export class SessionDO extends DurableObject<AuthEnv> {
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
      this.sql.exec('DROP TABLE IF EXISTS session_data');
      this.sql.exec(`
        CREATE TABLE session_data (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
      `);
      this.sql.exec('INSERT INTO _schema_version (version) VALUES (1)');
    }
  }

  async getData(): Promise<SessionData | null> {
    const rows = this.sql.exec('SELECT value FROM session_data WHERE key = ?', 'data').toArray();
    if (rows.length === 0) return null;

    const data = JSON.parse((rows[0] as { value: string }).value) as SessionData;

    // Check expiration
    if (data.expires_at < Date.now()) {
      await this.destroy();
      return null;
    }

    return data;
  }

  async setData(data: SessionData): Promise<void> {
    this.sql.exec(
      'INSERT OR REPLACE INTO session_data (key, value) VALUES (?, ?)',
      'data',
      JSON.stringify(data)
    );
  }

  async updateLastAccessed(): Promise<void> {
    const data = await this.getData();
    if (data) {
      data.last_accessed = Date.now();
      await this.setData(data);
    }
  }

  async switchOrg(orgId: string): Promise<void> {
    const data = await this.getData();
    if (data) {
      data.org_id = orgId;
      await this.setData(data);
    }
  }

  async destroy(): Promise<void> {
    this.sql.exec('DELETE FROM session_data');
  }
}

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
          joined_at INTEGER NOT NULL
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
  }

  // Profile methods
  async getProfile(): Promise<UserProfile | null> {
    const rows = this.sql.exec('SELECT value FROM profile WHERE key = ?', 'data').toArray();
    if (rows.length === 0) return null;
    const profile = JSON.parse((rows[0] as { value: string }).value) as UserProfile;
    if (typeof profile.is_superuser !== 'boolean') {
      profile.is_superuser = isSuperuserEmail(profile.email);
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
    const profile: UserProfile = {
      id,
      email,
      name,
      created_at: now,
      is_superuser: isSuperuserEmail(email),
    };
    const passwordHash = await hashPassword(password);

    await this.setProfile(profile);
    await this.setPasswordHash(passwordHash);

    return profile;
  }

  // Org membership methods
  async getOrgs(): Promise<UserOrg[]> {
    return this.sql.exec('SELECT org_id, role, joined_at FROM orgs ORDER BY joined_at ASC')
      .toArray() as unknown as UserOrg[];
  }

  async addOrg(orgId: string, role: 'admin' | 'member'): Promise<void> {
    const now = Date.now();
    this.sql.exec(
      'INSERT OR REPLACE INTO orgs (org_id, role, joined_at) VALUES (?, ?, ?)',
      orgId,
      role,
      now
    );
  }

  async removeOrg(orgId: string): Promise<void> {
    this.sql.exec('DELETE FROM orgs WHERE org_id = ?', orgId);
  }

  async updateOrgRole(orgId: string, role: 'admin' | 'member'): Promise<void> {
    this.sql.exec('UPDATE orgs SET role = ? WHERE org_id = ?', role, orgId);
  }

  async hasOrg(orgId: string): Promise<boolean> {
    const rows = this.sql.exec('SELECT 1 FROM orgs WHERE org_id = ?', orgId).toArray();
    return rows.length > 0;
  }

  async getOrgRole(orgId: string): Promise<'admin' | 'member' | null> {
    const rows = this.sql.exec('SELECT role FROM orgs WHERE org_id = ?', orgId).toArray();
    if (rows.length === 0) return null;
    return (rows[0] as { role: string }).role as 'admin' | 'member';
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
  }

  // Org info methods
  async getInfo(): Promise<OrgInfo | null> {
    const rows = this.sql.exec('SELECT value FROM org_info WHERE key = ?', 'data').toArray();
    if (rows.length === 0) return null;
    return JSON.parse((rows[0] as { value: string }).value) as OrgInfo;
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
    const info: OrgInfo = { id, name, created_at: now, created_by: createdBy };
    await this.setInfo(info);

    // Add creator as admin
    await this.addMember(createdBy, 'admin');

    return info;
  }

  async updateName(name: string): Promise<void> {
    const info = await this.getInfo();
    if (info) {
      info.name = name;
      await this.setInfo(info);
    }
  }

  // Member methods
  async getMembers(): Promise<OrgMember[]> {
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

  async addMember(userId: string, role: 'admin' | 'member'): Promise<void> {
    const now = Date.now();
    this.sql.exec(
      'INSERT OR REPLACE INTO members (user_id, role, joined_at) VALUES (?, ?, ?)',
      userId,
      role,
      now
    );
  }

  async removeMember(userId: string): Promise<void> {
    this.sql.exec('DELETE FROM members WHERE user_id = ?', userId);
  }

  async updateMemberRole(userId: string, role: 'admin' | 'member'): Promise<void> {
    this.sql.exec('UPDATE members SET role = ? WHERE user_id = ?', role, userId);
  }

  async isMember(userId: string): Promise<boolean> {
    const rows = this.sql.exec('SELECT 1 FROM members WHERE user_id = ?', userId).toArray();
    return rows.length > 0;
  }

  async isAdmin(userId: string): Promise<boolean> {
    const rows = this.sql.exec(
      'SELECT 1 FROM members WHERE user_id = ? AND role = ?',
      userId,
      'admin'
    ).toArray();
    return rows.length > 0;
  }

  async getMemberCount(): Promise<number> {
    const rows = this.sql.exec('SELECT COUNT(*) as count FROM members').toArray();
    return (rows[0] as { count: number }).count;
  }

  // Invitation methods
  async getInvitations(): Promise<OrgInvitation[]> {
    // Clean up expired invitations first
    const now = Date.now();
    this.sql.exec('DELETE FROM invitations WHERE expires_at < ?', now);

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
    role: 'admin' | 'member',
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
    await this.addMember(userId, invitation.role);

    // Delete the invitation (single use)
    await this.deleteInvitation(invitationId);

    return true;
  }

  // Integration methods
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

  async deleteIntegration(id: string): Promise<void> {
    this.sql.exec('DELETE FROM integrations WHERE id = ?', id);
  }
}
