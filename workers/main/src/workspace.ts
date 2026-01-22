import { DurableObject } from 'cloudflare:workers';
import { generateDefaultAvatar, validateAvatarContent } from '../../../src/lib/avatar';
import type { OrgDO } from './auth';

export interface WorkspaceInfo {
  id: string;
  org_id: string;
  name: string;
  description: string | null;
  created_by: string;
  created_at: number;
  avatar: { color: string; content: string };
  archived: boolean;
  archived_at: number | null;
  archived_by: string | null;
  compute_tier: 'standard';
}

export type WorkspaceAccessLevel = 'full' | 'read_only' | 'none';

export interface WorkspaceMember {
  user_id: string;
  access_level: WorkspaceAccessLevel;
  granted_by: string;
  granted_at: number;
}

export interface WorkspaceIntegrationRecord {
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
  deleted_at: number | null;
}

export interface WorkspaceAuditLogEntry {
  id: string;
  action: string;
  actor_id: string;
  target_id: string | null;
  details: string | null;
  created_at: number;
}

export interface WorkspaceEnv {
  WORKSPACE: DurableObjectNamespace<WorkspaceDO>;
  ORG: DurableObjectNamespace<OrgDO>;
}

/**
 * Workspace Durable Object - one per workspace.
 */
export class WorkspaceDO extends DurableObject<WorkspaceEnv> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: WorkspaceEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;

    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
    });
  }

  private migrate() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS _schema_version (
        version INTEGER PRIMARY KEY
      )
    `);
    const rows = this.sql.exec<{ version: number }>('SELECT version FROM _schema_version LIMIT 1').toArray();
    const version = rows[0]?.version ?? 0;

    if (version < 1) {
      this.sql.exec('DROP TABLE IF EXISTS workspace_info');
      this.sql.exec('DROP TABLE IF EXISTS members');
      this.sql.exec('DROP TABLE IF EXISTS integrations');
      this.sql.exec('DROP TABLE IF EXISTS audit_log');

      this.sql.exec(`
        CREATE TABLE workspace_info (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
      `);
      this.sql.exec(`
        CREATE TABLE members (
          user_id TEXT PRIMARY KEY,
          access_level TEXT NOT NULL,
          granted_by TEXT NOT NULL,
          granted_at INTEGER NOT NULL
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
          updated_at INTEGER NOT NULL,
          deleted_at INTEGER
        )
      `);
      this.sql.exec(`
        CREATE TABLE audit_log (
          id TEXT PRIMARY KEY,
          action TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          target_id TEXT,
          details TEXT,
          created_at INTEGER NOT NULL
        )
      `);
      this.sql.exec('INSERT INTO _schema_version (version) VALUES (1)');
    }

    if (version < 2) {
      // V2: Ensure audit_log table exists (fix for DOs that may have been created with incomplete V1)
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
      this.sql.exec('UPDATE _schema_version SET version = 2');
    }
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

  async getInfo(): Promise<WorkspaceInfo | null> {
    const rows = this.sql.exec('SELECT value FROM workspace_info WHERE key = ?', 'data').toArray();
    if (rows.length === 0) return null;
    const info = JSON.parse((rows[0] as { value: string }).value) as WorkspaceInfo;
    let changed = false;

    // Normalize avatar for old data that may not have it
    if (!info.avatar) {
      info.avatar = generateDefaultAvatar(info.name);
      changed = true;
    }
    // Normalize compute_tier for old data
    if (!info.compute_tier) {
      info.compute_tier = 'standard';
      changed = true;
    }

    if (changed) {
      await this.setInfo(info);
    }
    return info;
  }

  async setInfo(info: WorkspaceInfo): Promise<void> {
    this.sql.exec(
      'INSERT OR REPLACE INTO workspace_info (key, value) VALUES (?, ?)',
      'data',
      JSON.stringify(info)
    );
  }

  async createWorkspace(
    id: string,
    orgId: string,
    name: string,
    createdBy: string,
    description?: string | null
  ): Promise<WorkspaceInfo> {
    const now = Date.now();
    const avatar = generateDefaultAvatar(name);
    const info: WorkspaceInfo = {
      id,
      org_id: orgId,
      name,
      description: description ?? null,
      created_by: createdBy,
      created_at: now,
      avatar,
      archived: false,
      archived_at: null,
      archived_by: null,
      compute_tier: 'standard',
    };
    await this.setInfo(info);
    this.log('workspace_created', createdBy, undefined, { workspace_id: id, name });

    // Register workspace with the org
    const orgStub = this.env.ORG.get(
      this.env.ORG.idFromName(orgId)
    ) as unknown as OrgDO;
    await orgStub.addWorkspace(id, name, now, createdBy);

    return info;
  }

  async updateWorkspace(
    updates: {
      name?: string;
      description?: string | null;
      avatar?: { color?: string; content?: string };
    },
    actorId: string
  ): Promise<WorkspaceInfo | null> {
    const info = await this.getInfo();
    if (!info) return null;

    const changes: Record<string, [unknown, unknown]> = {};

    if (typeof updates.name === 'string' && updates.name.trim() && updates.name !== info.name) {
      changes.name = [info.name, updates.name];
      info.name = updates.name;
    }
    if (updates.description !== undefined && updates.description !== info.description) {
      changes.description = [info.description, updates.description];
      info.description = updates.description ?? null;
    }
    if (updates.avatar?.color && updates.avatar.color !== info.avatar.color) {
      changes.avatar_color = [info.avatar.color, updates.avatar.color];
      info.avatar.color = updates.avatar.color;
    }
    if (updates.avatar?.content && updates.avatar.content !== info.avatar.content) {
      if (!validateAvatarContent(updates.avatar.content)) {
        throw new Error('Invalid avatar content');
      }
      changes.avatar_content = [info.avatar.content, updates.avatar.content];
      info.avatar.content = updates.avatar.content;
    }

    await this.setInfo(info);
    if (Object.keys(changes).length > 0) {
      this.log('workspace_updated', actorId, undefined, { changes });
    }
    return info;
  }

  async archive(archivedBy: string): Promise<WorkspaceInfo | null> {
    const info = await this.getInfo();
    if (!info) return null;
    if (info.archived) return info;
    info.archived = true;
    info.archived_at = Date.now();
    info.archived_by = archivedBy;
    await this.setInfo(info);
    this.log('workspace_archived', archivedBy, undefined, { workspace_id: info.id, name: info.name });
    return info;
  }

  async getMemberAccess(userId: string): Promise<WorkspaceMember | null> {
    const rows = this.sql.exec(
      'SELECT user_id, access_level, granted_by, granted_at FROM members WHERE user_id = ?',
      userId
    ).toArray() as unknown as WorkspaceMember[];
    return rows[0] || null;
  }

  async listMembers(): Promise<WorkspaceMember[]> {
    return this.sql.exec(
      'SELECT user_id, access_level, granted_by, granted_at FROM members ORDER BY granted_at ASC'
    ).toArray() as unknown as WorkspaceMember[];
  }

  async setMemberAccess(
    userId: string,
    accessLevel: WorkspaceAccessLevel,
    actorId: string
  ): Promise<void> {
    const existing = await this.getMemberAccess(userId);

    if (accessLevel === 'full') {
      if (existing) {
        this.sql.exec('DELETE FROM members WHERE user_id = ?', userId);
        this.log('access_revoked', actorId, userId, { previous_level: existing.access_level });
      }
      return;
    }

    const now = Date.now();
    if (!existing) {
      this.sql.exec(
        'INSERT OR REPLACE INTO members (user_id, access_level, granted_by, granted_at) VALUES (?, ?, ?, ?)',
        userId,
        accessLevel,
        actorId,
        now
      );
      this.log('access_granted', actorId, userId, { access_level: accessLevel });
      return;
    }

    if (existing.access_level !== accessLevel) {
      this.sql.exec(
        'UPDATE members SET access_level = ?, granted_by = ?, granted_at = ? WHERE user_id = ?',
        accessLevel,
        actorId,
        now,
        userId
      );
      this.log('access_changed', actorId, userId, {
        old_level: existing.access_level,
        new_level: accessLevel,
      });
    }
  }

  async getIntegrations(): Promise<WorkspaceIntegrationRecord[]> {
    return this.sql
      .exec(
        `SELECT id, integration_type, name, category, auth_method, config,
                credentials_encrypted, enabled, created_by, created_at, updated_at, deleted_at
         FROM integrations
         WHERE deleted_at IS NULL
         ORDER BY created_at DESC`
      )
      .toArray() as unknown as WorkspaceIntegrationRecord[];
  }

  async getIntegration(id: string): Promise<WorkspaceIntegrationRecord | null> {
    const rows = this.sql
      .exec(
        `SELECT id, integration_type, name, category, auth_method, config,
                credentials_encrypted, enabled, created_by, created_at, updated_at, deleted_at
         FROM integrations WHERE id = ? AND deleted_at IS NULL`,
        id
      )
      .toArray() as unknown as WorkspaceIntegrationRecord[];
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
       (id, integration_type, name, category, auth_method, config, credentials_encrypted, enabled, created_by, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, NULL)`,
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
    this.log('integration_created', createdBy, id, { integration_type: integrationType, name });
  }

  async updateIntegration(
    id: string,
    updates: {
      name?: string;
      config?: string;
      credentialsEncrypted?: string;
      enabled?: boolean;
    },
    actorId: string
  ): Promise<void> {
    const now = Date.now();
    const setClauses: string[] = ['updated_at = ?'];
    const params: (string | number | null)[] = [now];

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
    this.log('integration_updated', actorId, id, { changes: Object.keys(updates) });
  }

  async deleteIntegration(id: string, actorId: string): Promise<void> {
    const now = Date.now();
    this.sql.exec('UPDATE integrations SET deleted_at = ?, updated_at = ? WHERE id = ?', now, now, id);
    this.log('integration_deleted', actorId, id);
  }

  async getAuditLog(limit = 100, offset = 0): Promise<WorkspaceAuditLogEntry[]> {
    const resolvedLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    const resolvedOffset = Math.max(0, Math.floor(offset));
    return this.sql.exec(
      'SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ? OFFSET ?',
      resolvedLimit,
      resolvedOffset
    ).toArray() as unknown as WorkspaceAuditLogEntry[];
  }
}
