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

export interface UserProfile {
  id: string;
  email: string;
  name: string | null;
  created_at: number;
}

export interface UserOrg {
  org_id: string;
  role: 'admin' | 'member';
  joined_at: number;
}

export interface UserProject {
  org_id: string;
  project_id: string;
  created_at: number;
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

// Session Durable Object - one per session
export class SessionDO extends DurableObject<AuthEnv> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: AuthEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS session_data (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
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
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS profile (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS orgs (
        org_id TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        joined_at INTEGER NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        org_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (org_id, project_id)
      )
    `);
  }

  // Profile methods
  async getProfile(): Promise<UserProfile | null> {
    const rows = this.sql.exec('SELECT value FROM profile WHERE key = ?', 'data').toArray();
    if (rows.length === 0) return null;
    return JSON.parse((rows[0] as { value: string }).value) as UserProfile;
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
    const profile: UserProfile = { id, email, name, created_at: now };
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

  // Project index methods
  async getProjects(): Promise<UserProject[]> {
    return this.sql.exec(
      'SELECT org_id, project_id, created_at FROM projects ORDER BY created_at DESC'
    ).toArray() as unknown as UserProject[];
  }

  async addProject(orgId: string, projectId: string): Promise<void> {
    const now = Date.now();
    this.sql.exec(
      'INSERT OR REPLACE INTO projects (org_id, project_id, created_at) VALUES (?, ?, ?)',
      orgId,
      projectId,
      now
    );
  }

  async removeProject(orgId: string, projectId: string): Promise<void> {
    this.sql.exec('DELETE FROM projects WHERE org_id = ? AND project_id = ?', orgId, projectId);
  }
}

// Organization Durable Object - one per org
export class OrgDO extends DurableObject<AuthEnv> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: AuthEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
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
}
