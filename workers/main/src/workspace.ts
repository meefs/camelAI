import { DurableObject } from 'cloudflare:workers';
import { generateDefaultAvatar, validateAvatarContent } from '../../../src/lib/avatar';
import type { Workspace } from '../../../src/types';
import type { OrgDO } from './auth';
import { decryptCredentials, encryptCredentials } from '../../../src/lib/integration-crypto';
import { syncAllWorkspaceWorkerSecrets, type CfApiProxyEnv } from './cf-api-proxy';
import { mintBigQueryAccessTokenFromServiceAccount } from './google-service-account';
import {
  WorkspaceContainer,
  type WorkspaceContainerEnv,
} from './workspace-container';

// Buffer time before token expiry to trigger refresh (10 minutes)
const TOKEN_REFRESH_BUFFER_MS = 10 * 60 * 1000;
// When refreshing, also refresh tokens expiring within this window (15 minutes)
const TOKEN_BATCH_WINDOW_MS = 15 * 60 * 1000;
// Fallback alarm delay if the alarm handler fails catastrophically (1 hour)
const TOKEN_REFRESH_FALLBACK_MS = 60 * 60 * 1000;
// Retry delay for transient token refresh failures (15 minutes)
const TOKEN_REFRESH_RETRY_MS = 15 * 60 * 1000;
// Minimum retry delay to avoid tight loops on malformed retry hints
const TOKEN_REFRESH_RETRY_MIN_MS = 30 * 1000;
// Maximum retry delay to avoid effectively disabling refresh for too long
const TOKEN_REFRESH_RETRY_MAX_MS = 60 * 60 * 1000;
// Fallback when rate-limited but provider omits Retry-After
const TOKEN_REFRESH_RATE_LIMIT_DEFAULT_MS = 2 * 60 * 1000;

/**
 * Thrown when a token refresh fails permanently (e.g. revoked token, invalid_grant).
 * The integration's token_expires_at should be cleared so the alarm stops retrying.
 */
class PermanentRefreshError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentRefreshError';
  }
}

/**
 * Thrown when a refresh failure is transient and provides a specific retry timestamp.
 * Alarm handling can use retryAtMs to avoid both tight loops and overly long backoffs.
 */
class RetryableRefreshError extends Error {
  retryAtMs: number;

  constructor(message: string, retryAtMs: number) {
    super(message);
    this.name = 'RetryableRefreshError';
    this.retryAtMs = retryAtMs;
  }
}

function parseRetryAfterToRetryAtMs(retryAfterHeader: string | null, nowMs: number): number | null {
  if (!retryAfterHeader) return null;
  const trimmed = retryAfterHeader.trim();
  if (!trimmed) return null;

  // RFC 9110: Retry-After can be delay-seconds or HTTP-date.
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return nowMs + Math.floor(seconds * 1000);
  }

  const absolute = Date.parse(trimmed);
  if (Number.isFinite(absolute)) {
    return absolute;
  }

  return null;
}

function clampRetryAtMs(retryAtMs: number, nowMs: number): number {
  const min = nowMs + TOKEN_REFRESH_RETRY_MIN_MS;
  const max = nowMs + TOKEN_REFRESH_RETRY_MAX_MS;
  return Math.max(min, Math.min(max, Math.floor(retryAtMs)));
}
const BIGQUERY_INTEGRATION_TYPE = 'bigquery';

export type WorkspaceAccessLevel = 'full' | 'none';

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
  created_by: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  token_expires_at: number | null;
}

export interface WorkspaceAuditLogEntry {
  id: string;
  action: string;
  actor_id: string;
  target_id: string | null;
  details: string | null;
  created_at: number;
}

export type ChatThreadAccessResult =
  | {
      ok: true;
      orgId: string;
      orgSlug: string;
      workspaceId: string;
      threadId: string;
    }
  | {
      ok: false;
      reason:
        | 'workspace_not_found'
        | 'workspace_org_mismatch'
        | 'org_not_found'
        | 'forbidden'
        | 'thread_not_found';
    };

export interface WorkspaceEnv {
  WORKSPACE: DurableObjectNamespace<WorkspaceDO>;
  ORG: DurableObjectNamespace<OrgDO>;
  INTEGRATION_SECRET_KEY: string;
  // OAuth credentials for token refresh
  NOTION_CLIENT_ID?: string;
  NOTION_CLIENT_SECRET?: string;
  SLACK_CLIENT_ID?: string;
  SLACK_CLIENT_SECRET?: string;
  // Cloudflare API config for syncing secrets to deployed workers
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  CF_DISPATCH_NAMESPACE?: string;
  // KV for APP_KV lookups (needed by syncAllWorkspaceWorkerSecrets)
  APP_KV?: KVNamespace;
  EMAIL_TO_USER?: KVNamespace;
  CHAT_THREAD?: DurableObjectNamespace;
  TOKEN_SIGNING_SECRET?: string;
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
    // Read version from sync KV, falling back to legacy SQL table for existing DOs.
    let version = this.ctx.storage.kv.get<number>('schemaVersion') ?? null;
    if (version === null) {
      try {
        const rows = this.sql.exec<{ version: number }>('SELECT MAX(version) AS version FROM _schema_version').toArray();
        version = rows[0]?.version ?? 0;
      } catch {
        version = 0;
      }
    }

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
    }

    if (version < 3) {
      // V3: Add token_expires_at column for OAuth token refresh scheduling
      this.sql.exec('ALTER TABLE integrations ADD COLUMN token_expires_at INTEGER');
      this.sql.exec('CREATE INDEX IF NOT EXISTS idx_integrations_token_expires ON integrations(token_expires_at) WHERE token_expires_at IS NOT NULL AND deleted_at IS NULL');
    }

    const CURRENT_SCHEMA_VERSION = 3;
    if (version < CURRENT_SCHEMA_VERSION) {
      this.ctx.storage.kv.put('schemaVersion', CURRENT_SCHEMA_VERSION);
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

  async getInfo(): Promise<Workspace | null> {
    const rows = this.sql.exec('SELECT value FROM workspace_info WHERE key = ?', 'data').toArray();
    if (rows.length === 0) return null;
    const info = JSON.parse((rows[0] as { value: string }).value) as Workspace;
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

  async setInfo(info: Workspace): Promise<void> {
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
  ): Promise<Workspace> {
    const now = Date.now();
    const avatar = generateDefaultAvatar(name);
    const info: Workspace = {
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
  ): Promise<Workspace | null> {
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

  async archive(archivedBy: string): Promise<Workspace | null> {
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

  /**
   * Permanently delete all workspace-scoped data from this Durable Object.
   * Used by superuser org reset tooling for test account cleanup.
   */
  async hardDeleteWorkspace(actorId: string): Promise<void> {
    const info = await this.getInfo();

    // Stop any pending token refresh alarms before clearing tables.
    await this.ctx.storage.deleteAlarm();

    this.sql.exec('DELETE FROM workspace_info WHERE key = ?', 'data');
    this.sql.exec('DELETE FROM members');
    this.sql.exec('DELETE FROM integrations');
    this.sql.exec('DELETE FROM audit_log');

    if (info) {
      // Write a best-effort trail to worker logs before data is gone.
      console.log('[WorkspaceDO] hard deleted workspace', {
        workspaceId: info.id,
        orgId: info.org_id,
        actorId,
      });
    }
  }

  async getMemberAccess(userId: string): Promise<WorkspaceMember | null> {
    const rows = this.sql.exec(
      'SELECT user_id, access_level, granted_by, granted_at FROM members WHERE user_id = ?',
      userId
    ).toArray() as unknown as WorkspaceMember[];
    return rows[0] || null;
  }

  async getInfoAndMemberAccess(userId: string): Promise<{
    info: Workspace | null;
    memberAccess: WorkspaceMember | null;
  }> {
    const [info, memberAccess] = await Promise.all([
      this.getInfo(),
      this.getMemberAccess(userId),
    ]);
    return { info, memberAccess };
  }

  async listMembers(): Promise<WorkspaceMember[]> {
    return this.sql.exec(
      'SELECT user_id, access_level, granted_by, granted_at FROM members ORDER BY granted_at ASC'
    ).toArray() as unknown as WorkspaceMember[];
  }

  async validateChatThreadAccess(
    userId: string,
    expectedOrgId: string,
    threadId: string
  ): Promise<ChatThreadAccessResult> {
    const info = await this.getInfo();
    if (!info || info.archived) {
      return { ok: false, reason: 'workspace_not_found' };
    }

    if (info.org_id !== expectedOrgId) {
      return { ok: false, reason: 'workspace_org_mismatch' };
    }

    const orgStub = this.env.ORG.get(this.env.ORG.idFromName(info.org_id)) as unknown as OrgDO;
    const [memberAccess, orgValidation] = await Promise.all([
      this.getMemberAccess(userId),
      orgStub.validateChatThreadAccess(userId, info.id, threadId),
    ]);

    if (!orgValidation.ok) {
      switch (orgValidation.reason) {
        case 'org_not_found':
          return { ok: false, reason: 'org_not_found' };
        case 'thread_not_found':
          return { ok: false, reason: 'thread_not_found' };
        case 'forbidden':
        default:
          return { ok: false, reason: 'forbidden' };
      }
    }

    if ((memberAccess?.access_level ?? 'full') !== 'full') {
      return { ok: false, reason: 'forbidden' };
    }

    return {
      ok: true,
      orgId: orgValidation.orgId,
      orgSlug: orgValidation.orgSlug,
      workspaceId: info.id,
      threadId: orgValidation.threadId,
    };
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
                credentials_encrypted, created_by, created_at, updated_at, deleted_at, token_expires_at
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
                credentials_encrypted, created_by, created_at, updated_at, deleted_at, token_expires_at
         FROM integrations WHERE id = ? AND deleted_at IS NULL`,
        id
      )
      .toArray() as unknown as WorkspaceIntegrationRecord[];
    return rows[0] || null;
  }

  /**
   * Check if an integration name already exists for a given type.
   * Names must be unique within the same integration type to avoid env var conflicts.
   */
  async integrationNameExists(integrationType: string, name: string, excludeId?: string): Promise<boolean> {
    const query = excludeId
      ? `SELECT 1 FROM integrations WHERE integration_type = ? AND name = ? AND deleted_at IS NULL AND id != ? LIMIT 1`
      : `SELECT 1 FROM integrations WHERE integration_type = ? AND name = ? AND deleted_at IS NULL LIMIT 1`;
    const args = excludeId ? [integrationType, name, excludeId] : [integrationType, name];
    const rows = this.sql.exec(query, ...args).toArray();
    return rows.length > 0;
  }

  /**
   * BigQuery integrations are configured with service account JSON, but runtime
   * should receive short-lived access tokens instead of raw private key JSON.
   */
  private async hydrateBigQueryCredentials(
    credentialsEncrypted: string
  ): Promise<{ credentialsEncrypted: string; tokenExpiresAt: number }> {
    const credentials = await decryptCredentials(credentialsEncrypted, this.env.INTEGRATION_SECRET_KEY);
    const serviceAccountJson = credentials.service_account_json;
    if (typeof serviceAccountJson !== 'string' || serviceAccountJson.trim().length === 0) {
      throw new Error('BigQuery integration requires service_account_json');
    }

    const token = await mintBigQueryAccessTokenFromServiceAccount(serviceAccountJson);
    const hydratedCredentials: Record<string, unknown> = {
      ...credentials,
      access_token: token.accessToken,
      token_type: token.tokenType,
      expires_at: token.expiresAt,
    };

    const encrypted = await encryptCredentials(hydratedCredentials, this.env.INTEGRATION_SECRET_KEY);
    return { credentialsEncrypted: encrypted, tokenExpiresAt: token.expiresAt };
  }

  async createIntegration(
    id: string,
    integrationType: string,
    name: string,
    category: string,
    authMethod: string,
    config: string,
    credentialsEncrypted: string,
    createdBy: string,
    tokenExpiresAt?: number | null
  ): Promise<void> {
    // Check for duplicate name within the same integration type
    if (await this.integrationNameExists(integrationType, name)) {
      throw new Error(`An integration named "${name}" already exists for type "${integrationType}". Please choose a different name.`);
    }

    let resolvedCredentialsEncrypted = credentialsEncrypted;
    let resolvedTokenExpiresAt = tokenExpiresAt ?? null;

    if (integrationType === BIGQUERY_INTEGRATION_TYPE) {
      const hydrated = await this.hydrateBigQueryCredentials(credentialsEncrypted);
      resolvedCredentialsEncrypted = hydrated.credentialsEncrypted;
      resolvedTokenExpiresAt = hydrated.tokenExpiresAt;
    }

    const now = Date.now();
    this.sql.exec(
      `INSERT INTO integrations
       (id, integration_type, name, category, auth_method, config, credentials_encrypted, created_by, created_at, updated_at, deleted_at, token_expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      id,
      integrationType,
      name,
      category,
      authMethod,
      config,
      resolvedCredentialsEncrypted,
      createdBy,
      now,
      now,
      resolvedTokenExpiresAt
    );
    this.log('integration_created', createdBy, id, { integration_type: integrationType, name });

    // Schedule token refresh alarm when this integration has token expiry.
    if (resolvedTokenExpiresAt) {
      await this.scheduleNextTokenRefresh();
    }
  }

  async updateIntegration(
    id: string,
    updates: {
      name?: string;
      config?: string;
      credentialsEncrypted?: string;
      tokenExpiresAt?: number | null;
    },
    actorId: string
  ): Promise<void> {
    const existing = await this.getIntegration(id);

    // If renaming, check for duplicate name within the same integration type
    if (updates.name !== undefined) {
      if (existing && await this.integrationNameExists(existing.integration_type, updates.name, id)) {
        throw new Error(`An integration named "${updates.name}" already exists for type "${existing.integration_type}". Please choose a different name.`);
      }
    }

    if (
      updates.credentialsEncrypted !== undefined &&
      existing?.integration_type === BIGQUERY_INTEGRATION_TYPE
    ) {
      const hydrated = await this.hydrateBigQueryCredentials(updates.credentialsEncrypted);
      updates.credentialsEncrypted = hydrated.credentialsEncrypted;
      updates.tokenExpiresAt = hydrated.tokenExpiresAt;
    }

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
    if (updates.tokenExpiresAt !== undefined) {
      setClauses.push('token_expires_at = ?');
      params.push(updates.tokenExpiresAt);
    }

    params.push(id);
    this.sql.exec(`UPDATE integrations SET ${setClauses.join(', ')} WHERE id = ?`, ...params);
    this.log('integration_updated', actorId, id, { changes: Object.keys(updates) });

    // Reschedule token refresh alarm if expiry changed
    if (updates.tokenExpiresAt !== undefined) {
      await this.scheduleNextTokenRefresh();
    }
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

  // =============================================================================
  // Integration Token Refresh
  // =============================================================================

  /**
   * Schedule alarm for the next token that needs refreshing.
   * Uses single-alarm pattern: finds earliest expiring token and sets alarm for it.
   */
  private async scheduleNextTokenRefresh(): Promise<void> {
    // Find the earliest expiring managed integration token
    const rows = this.sql.exec(
      `SELECT MIN(token_expires_at) as token_expires_at
       FROM integrations
       WHERE token_expires_at IS NOT NULL
         AND deleted_at IS NULL
         AND (auth_method = 'oauth2' OR integration_type = ?)`,
      BIGQUERY_INTEGRATION_TYPE
    ).toArray() as { token_expires_at: number | null }[];

    const nextExpiry = rows[0]?.token_expires_at ?? null;

    if (!nextExpiry) {
      // No managed tokens with expiry, clear any existing alarm
      await this.ctx.storage.deleteAlarm();
      return;
    }

    // Schedule alarm 10 minutes before expiry
    const alarmTime = nextExpiry - TOKEN_REFRESH_BUFFER_MS;
    const now = Date.now();

    // If already past the alarm time, trigger immediately
    if (alarmTime <= now) {
      await this.ctx.storage.setAlarm(now + 1000); // 1 second from now
    } else {
      await this.ctx.storage.setAlarm(alarmTime);
    }
  }

  /**
   * Durable Object alarm handler - refreshes expiring managed tokens
   *
   * Uses a "dead man's switch" pattern: immediately schedules a fallback alarm
   * before doing any work. If everything succeeds, the fallback is overwritten
   * with the correct next alarm time. If anything fails catastrophically,
   * we'll retry in 1 hour.
   */
  async alarm(): Promise<void> {
    const now = Date.now();

    // Dead man's switch: schedule fallback alarm immediately
    // This ensures we retry even if the handler throws unexpectedly
    await this.ctx.storage.setAlarm(now + TOKEN_REFRESH_FALLBACK_MS);

    try {
      const batchCutoff = now + TOKEN_BATCH_WINDOW_MS;
      let needsSync = false;

      // Find all integration tokens expiring within the batch window
      const expiringIntegrations = this.sql.exec(
        `SELECT id, integration_type, name, category, auth_method, config,
                credentials_encrypted, created_by, created_at, updated_at, deleted_at, token_expires_at
         FROM integrations
         WHERE token_expires_at IS NOT NULL
           AND token_expires_at <= ?
           AND deleted_at IS NULL
           AND (auth_method = 'oauth2' OR integration_type = ?)
         ORDER BY token_expires_at ASC`,
        batchCutoff,
        BIGQUERY_INTEGRATION_TYPE
      ).toArray() as unknown as WorkspaceIntegrationRecord[];

      if (expiringIntegrations.length > 0) {
        console.log(`[WorkspaceDO] Refreshing ${expiringIntegrations.length} expiring integration tokens`);

        for (const integration of expiringIntegrations) {
          try {
            await this.refreshIntegrationToken(integration);
            needsSync = true;
          } catch (err) {
            console.error(`[WorkspaceDO] Failed to refresh token for ${integration.integration_type}:`, err);
            if (err instanceof PermanentRefreshError) {
              // Permanently invalid (e.g. revoked token) — stop retrying this integration
              this.sql.exec(
                `UPDATE integrations SET token_expires_at = NULL, updated_at = ? WHERE id = ?`,
                Date.now(),
                integration.id
              );
              console.warn(`[WorkspaceDO] Disabled token refresh for ${integration.integration_type} integration ${integration.id} (permanent failure). User must re-authorize.`);
            } else {
              // Transient failure — push retry into the future to avoid tight loops.
              const retryAtMs = err instanceof RetryableRefreshError
                ? clampRetryAtMs(err.retryAtMs, now)
                : now + TOKEN_REFRESH_RETRY_MS;
              this.sql.exec(
                `UPDATE integrations SET token_expires_at = ?, updated_at = ? WHERE id = ?`,
                retryAtMs,
                Date.now(),
                integration.id
              );
              const retryDelaySec = Math.round((retryAtMs - now) / 1000);
              console.warn(`[WorkspaceDO] Will retry ${integration.integration_type} integration ${integration.id} in ${retryDelaySec}s`);
            }
          }
        }
      }

      // If any tokens were refreshed, sync credentials to both runtime targets:
      // 1) running workspace container env vars
      // 2) deployed Cloudflare workers in this workspace
      if (needsSync) {
        await this.syncIntegrationEnvVarsToContainer();
        await this.syncSecretsToDeployedWorkers();
      }

      // Schedule alarm for the next expiring token (overwrites fallback)
      await this.scheduleNextTokenRefresh();
    } catch (err) {
      // Log the error but don't rethrow - fallback alarm is already set
      console.error('[WorkspaceDO] Alarm handler failed, will retry in 1 hour:', err);
    }
  }

  /**
   * Sync integration secrets to all deployed workers in this workspace.
   * Called after token refresh to ensure workers have up-to-date credentials.
   */
  private async syncSecretsToDeployedWorkers(): Promise<void> {
    // Get workspace info to find orgId
    const info = await this.getInfo();
    if (!info) {
      console.warn('[WorkspaceDO] Cannot sync secrets: workspace info not found');
      return;
    }

    // Check if we have the required Cloudflare API config
    if (!this.env.CF_API_TOKEN || !this.env.CF_ACCOUNT_ID || !this.env.CF_DISPATCH_NAMESPACE) {
      console.warn('[WorkspaceDO] Cannot sync secrets: missing CF API config');
      return;
    }

    try {
      // Build the env object needed by syncAllWorkspaceWorkerSecrets
      const cfEnv: CfApiProxyEnv = {
        CF_API_TOKEN: this.env.CF_API_TOKEN,
        CF_ACCOUNT_ID: this.env.CF_ACCOUNT_ID,
        CF_DISPATCH_NAMESPACE: this.env.CF_DISPATCH_NAMESPACE,
        INTEGRATION_SECRET_KEY: this.env.INTEGRATION_SECRET_KEY,
        TOKEN_SIGNING_SECRET: this.env.TOKEN_SIGNING_SECRET ?? '',
        WORKSPACE: this.env.WORKSPACE,
        ORG: this.env.ORG,
        EMAIL_TO_USER: this.env.EMAIL_TO_USER!,
        APP_KV: this.env.APP_KV!,
        CHAT_THREAD: this.env.CHAT_THREAD!,
      };

      const result = await syncAllWorkspaceWorkerSecrets(cfEnv, info.id, info.org_id);
      console.log(`[WorkspaceDO] Synced secrets to ${result.synced} workers (${result.failed} failed)`);
    } catch (err) {
      console.error('[WorkspaceDO] Failed to sync secrets to deployed workers:', err);
    }
  }

  /**
   * Push refreshed integration env vars to the running workspace container.
   * This keeps active chat sessions in sync with newly rotated tokens.
   */
  private async syncIntegrationEnvVarsToContainer(): Promise<void> {
    const info = await this.getInfo();
    if (!info) {
      console.warn('[WorkspaceDO] Cannot sync container env vars: workspace info not found');
      return;
    }

    try {
      const container = new WorkspaceContainer(
        this.env as unknown as WorkspaceContainerEnv,
        info.id,
        info.org_id
      );
      const success = await container.refreshIntegrationEnvVars();
      if (!success) {
        console.warn('[WorkspaceDO] Container env refresh skipped or failed', { workspaceId: info.id });
      }
    } catch (err) {
      console.error('[WorkspaceDO] Failed to refresh container integration env vars:', err);
    }
  }

  /**
   * Refresh managed token for a specific integration
   */
  private async refreshIntegrationToken(integration: WorkspaceIntegrationRecord): Promise<void> {
    const credentials = await decryptCredentials(
      integration.credentials_encrypted,
      this.env.INTEGRATION_SECRET_KEY
    );

    let newCredentials: Record<string, unknown>;
    let newExpiresAt: number;

    switch (integration.integration_type) {
      case 'notion': {
        const refreshToken = credentials.refresh_token as string | undefined;
        if (!refreshToken) {
          console.warn(`[WorkspaceDO] No refresh token for Notion integration ${integration.id}`);
          return;
        }
        ({ credentials: newCredentials, expiresAt: newExpiresAt } = await this.refreshNotionToken(refreshToken));
        break;
      }

      case BIGQUERY_INTEGRATION_TYPE: {
        const serviceAccountJson = credentials.service_account_json;
        if (typeof serviceAccountJson !== 'string' || serviceAccountJson.trim().length === 0) {
          console.warn(`[WorkspaceDO] Missing service_account_json for BigQuery integration ${integration.id}`);
          return;
        }

        const token = await mintBigQueryAccessTokenFromServiceAccount(serviceAccountJson);
        newCredentials = {
          ...credentials,
          access_token: token.accessToken,
          token_type: token.tokenType,
          expires_at: token.expiresAt,
        };
        newExpiresAt = token.expiresAt;
        break;
      }

      // Add other OAuth providers here as needed
      // case 'slack':
      //   Slack bot tokens don't expire, so no refresh needed
      //   break;

      default:
        console.warn(`[WorkspaceDO] Unknown integration type for token refresh: ${integration.integration_type}`);
        return;
    }

    // Encrypt and save new credentials
    const encrypted = await encryptCredentials(newCredentials, this.env.INTEGRATION_SECRET_KEY);

    this.sql.exec(
      `UPDATE integrations
       SET credentials_encrypted = ?, token_expires_at = ?, updated_at = ?
       WHERE id = ?`,
      encrypted,
      newExpiresAt,
      Date.now(),
      integration.id
    );

    this.log('token_refreshed', 'system', integration.id, { integration_type: integration.integration_type });
    console.log(`[WorkspaceDO] Refreshed token for ${integration.integration_type} integration ${integration.id}`);
  }

  /**
   * Refresh Notion OAuth token
   */
  private async refreshNotionToken(refreshToken: string): Promise<{
    credentials: Record<string, unknown>;
    expiresAt: number;
  }> {
    if (!this.env.NOTION_CLIENT_ID || !this.env.NOTION_CLIENT_SECRET) {
      throw new Error('Notion OAuth credentials not configured');
    }

    const basicAuth = btoa(`${this.env.NOTION_CLIENT_ID}:${this.env.NOTION_CLIENT_SECRET}`);
    const response = await fetch('https://api.notion.com/v1/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${basicAuth}`,
      },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    });

    if (!response.ok) {
      const now = Date.now();
      const errorText = await response.text();
      const message = `Notion token refresh failed: ${response.status} ${errorText}`;
      // Most 4xx are permanent (invalid_grant, revoked token, bad credentials).
      // 429 is rate limiting and should be retried as transient.
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        throw new PermanentRefreshError(message);
      }
      if (response.status === 429) {
        const retryAfter = parseRetryAfterToRetryAtMs(response.headers.get('Retry-After'), now);
        const retryAtMs = clampRetryAtMs(
          retryAfter ?? (now + TOKEN_REFRESH_RATE_LIMIT_DEFAULT_MS),
          now
        );
        throw new RetryableRefreshError(message, retryAtMs);
      }
      throw new Error(message);
    }

    const data = (await response.json()) as {
      access_token: string;
      expires_in: number;
      refresh_token?: string;
      token_type: string;
      bot_id?: string;
      workspace_id?: string;
      workspace_name?: string;
      owner?: {
        type: string;
        user?: {
          id: string;
          name?: string;
          person?: { email?: string };
        };
      };
    };

    const expiresAt = Date.now() + data.expires_in * 1000;

    return {
      credentials: {
        access_token: data.access_token,
        // Use new refresh token if provided, otherwise keep the old one
        refresh_token: data.refresh_token || refreshToken,
        expires_at: expiresAt,
        token_type: data.token_type,
        bot_id: data.bot_id,
        notion_workspace_id: data.workspace_id,
        notion_workspace_name: data.workspace_name,
        owner_user_id: data.owner?.user?.id,
        owner_user_name: data.owner?.user?.name,
        owner_user_email: data.owner?.user?.person?.email,
      },
      expiresAt,
    };
  }

}
