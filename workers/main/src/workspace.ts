import { DurableObject } from 'cloudflare:workers';
import { generateDefaultAvatar, validateAvatarContent } from '../../../src/lib/avatar';
import type {
  ThreadCompletionSummaryStatus,
  Workspace,
  WorkspaceModelPickerConfig,
} from '../../../src/types';
import type { OrgDO } from './auth';
import { dispatchAdminEvent } from './auth';
import { decryptCredentials, encryptCredentials } from '../../../src/lib/integration-crypto';
import { mintBigQueryAccessTokenFromServiceAccount } from './google-service-account';
import type { WorkspaceCronDO } from './workspace-cron';
import { generateEmailHandle } from '../../../src/lib/workspace-email';
import type { EmailHandleDO } from './email-handle-registry';
import {
  defaultWorkspaceModelPickerConfig,
  parseWorkspaceModelPickerConfig,
} from '../../../src/lib/model-picker-config';
import { refreshRemoteMcpOAuthToken } from './remote-mcp-oauth';

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
// Crash-cleanup horizon for detached turns. This should be much longer than a
// normal coding-agent turn so long-running work does not disappear from status.
const THREAD_STREAMING_STATUS_TTL_MS = 24 * 60 * 60 * 1000;
const WORKSPACE_STATUS_SOCKET_TAG = 'status';
type BroadcastThreadStatus = 'running' | 'idle' | 'unread';

export interface WorkspaceRunningThreadStatus {
  threadId: string;
  startedAt: number;
  updatedAt: number;
  latestActivityText: string | null;
  latestActivityAt: number | null;
}

function normalizeRunningActivityText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  return normalized.length > 240 ? `${normalized.slice(0, 237)}...` : normalized;
}

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
const WORKSPACE_MODEL_PICKER_CONFIG_KEY = 'model_picker_config';

export type WorkspaceAccessLevel = 'full' | 'none';
export type WorkspaceIntegrationAuthStatus =
  | 'connected'
  | 'needs_reauth'
  | 'missing_scopes'
  | 'setup_incomplete'
  | 'provider_error';

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
  auth_status: WorkspaceIntegrationAuthStatus | null;
  auth_error_code: string | null;
  auth_error_message: string | null;
  auth_checked_at: number | null;
  reauth_required_at: number | null;
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
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  CF_DISPATCH_NAMESPACE?: string;
  APP_KV?: KVNamespace;
  EMAIL_HANDLE?: DurableObjectNamespace<EmailHandleDO>;
  EMAIL_TO_USER?: KVNamespace;
  CHAT_THREAD?: DurableObjectNamespace;
  WORKSPACE_CRON?: DurableObjectNamespace<WorkspaceCronDO>;
  TOKEN_SIGNING_SECRET?: string;
}

/**
 * Workspace Durable Object - one per workspace.
 */
export class WorkspaceDO extends DurableObject<WorkspaceEnv> {
  private sql: SqlStorage;
  private lastThreadStatusBroadcasts = new Map<string, string>();

  constructor(ctx: DurableObjectState, env: WorkspaceEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;

    ctx.blockConcurrencyWhile(async () => {
      await this.migrate();
    });
  }

  private async migrate() {
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

    if (version < 4) {
      // V4: Backfill workspace members from org membership.
      // Previously setMemberAccess('full') deleted the row, so full-access
      // members were implicit. Now all members are stored explicitly.
      const rows = this.sql.exec('SELECT value FROM workspace_info WHERE key = ?', 'data').toArray();
      if (rows.length > 0) {
        const info = JSON.parse((rows[0] as { value: string }).value) as { org_id: string };
        const orgStub = this.env.ORG.get(this.env.ORG.idFromName(info.org_id)) as unknown as OrgDO;
        const orgMembers = await orgStub.getMembers();
        const now = Date.now();
        for (const m of orgMembers) {
          this.sql.exec(
            'INSERT OR IGNORE INTO members (user_id, access_level, granted_by, granted_at) VALUES (?, ?, ?, ?)',
            m.user_id,
            'full',
            'system-migration',
            now
          );
        }
      }
    }

    if (version < 5) {
      // V5: Persist low-volume chat streaming state for workspace-level status.
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS thread_streaming_status (
          thread_id TEXT PRIMARY KEY,
          started_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      this.sql.exec(
        'CREATE INDEX IF NOT EXISTS idx_thread_streaming_updated_at ON thread_streaming_status(updated_at)',
      );
    }

    if (version < 6) {
      // V6: Track integration auth health so stale OAuth/API credentials can
      // be surfaced to users and sandbox runtimes with a clear reauth path.
      this.sql.exec("ALTER TABLE integrations ADD COLUMN auth_status TEXT DEFAULT 'connected'");
      this.sql.exec('ALTER TABLE integrations ADD COLUMN auth_error_code TEXT');
      this.sql.exec('ALTER TABLE integrations ADD COLUMN auth_error_message TEXT');
      this.sql.exec('ALTER TABLE integrations ADD COLUMN auth_checked_at INTEGER');
      this.sql.exec('ALTER TABLE integrations ADD COLUMN reauth_required_at INTEGER');
      this.sql.exec("CREATE INDEX IF NOT EXISTS idx_integrations_auth_status ON integrations(auth_status) WHERE auth_status != 'connected' AND deleted_at IS NULL");
    }

    if (version < 7) {
      // V7: Track ephemeral running activity text for workspace status sockets.
      this.sql.exec('ALTER TABLE thread_streaming_status ADD COLUMN latest_activity_text TEXT');
      this.sql.exec('ALTER TABLE thread_streaming_status ADD COLUMN latest_activity_at INTEGER');
    }

    const CURRENT_SCHEMA_VERSION = 7;
    if (version < CURRENT_SCHEMA_VERSION) {
      this.ctx.storage.kv.put('schemaVersion', CURRENT_SCHEMA_VERSION);
    }
  }

  private pruneStaleStreamingRows(now = Date.now()): void {
    const staleRows = this.sql
      .exec<{ thread_id: string }>(
        'SELECT thread_id FROM thread_streaming_status WHERE updated_at < ?',
        now - THREAD_STREAMING_STATUS_TTL_MS,
      )
      .toArray();
    for (const row of staleRows) {
      this.lastThreadStatusBroadcasts.delete(row.thread_id);
    }
    this.sql.exec(
      'DELETE FROM thread_streaming_status WHERE updated_at < ?',
      now - THREAD_STREAMING_STATUS_TTL_MS,
    );
  }

  recordThreadStreaming(
    threadId: string,
    isStreaming: boolean,
    options?: {
      completedAt?: number;
      summaryStatus?: ThreadCompletionSummaryStatus | null;
      summary?: string | null;
      activityText?: string | null;
      activityAt?: number | null;
    },
  ): void {
    const normalizedThreadId = threadId.trim();
    if (!normalizedThreadId) return;
    const now = Date.now();
    const completedAt =
      typeof options?.completedAt === 'number' && Number.isFinite(options.completedAt)
        ? options.completedAt
        : null;
    const summaryStatus =
      options?.summaryStatus === 'pending' ||
      options?.summaryStatus === 'ready' ||
      options?.summaryStatus === 'failed'
        ? options.summaryStatus
        : null;
    const summary =
      typeof options?.summary === 'string' && options.summary.trim()
        ? options.summary.trim()
        : null;
    const hasActivityTextUpdate =
      options !== undefined &&
      Object.prototype.hasOwnProperty.call(options, 'activityText');
    const activityText = hasActivityTextUpdate
      ? normalizeRunningActivityText(options?.activityText)
      : undefined;
    const activityAt =
      hasActivityTextUpdate && activityText !== null
        ? typeof options?.activityAt === 'number' && Number.isFinite(options.activityAt)
          ? Math.floor(options.activityAt)
          : now
        : null;
    this.pruneStaleStreamingRows(now);
    if (isStreaming) {
      if (hasActivityTextUpdate) {
        // Activity-carrying updates ride a trailing debounce (and RPC retries)
        // in ChatThreadDO, so one can land AFTER the turn's terminal
        // isStreaming=false already deleted the row. Update-only: a late flush
        // must not resurrect a cleared turn as a phantom "running" row (it
        // would persist for the full TTL and pin sidebar/status UIs). Only the
        // un-debounced turn-start transition may create the row.
        const updated = this.sql.exec(
          `UPDATE thread_streaming_status SET
             updated_at = ?,
             latest_activity_text = ?,
             latest_activity_at = ?
           WHERE thread_id = ?`,
          now,
          activityText,
          activityAt,
          normalizedThreadId,
        ).rowsWritten;
        if (updated === 0) {
          return;
        }
      } else {
        this.sql.exec(
          `INSERT INTO thread_streaming_status (
             thread_id,
             started_at,
             updated_at,
             latest_activity_text,
             latest_activity_at
           )
           VALUES (?, ?, ?, NULL, NULL)
           ON CONFLICT(thread_id) DO UPDATE SET updated_at = excluded.updated_at`,
          normalizedThreadId,
          now,
          now,
        );
      }
    } else {
      const currentRunning = this.sql
        .exec<{ started_at: number }>(
          'SELECT started_at FROM thread_streaming_status WHERE thread_id = ?',
          normalizedThreadId,
        )
        .toArray()[0] ?? null;
      if (
        completedAt !== null &&
        currentRunning !== null &&
        currentRunning.started_at > completedAt
      ) {
        return;
      }
      this.sql.exec(
        'DELETE FROM thread_streaming_status WHERE thread_id = ?',
        normalizedThreadId,
      );
      this.lastThreadStatusBroadcasts.delete(normalizedThreadId);
    }
    const runningActivity = isStreaming
      ? this.sql
          .exec<{
            started_at: number;
            latest_activity_text: string | null;
            latest_activity_at: number | null;
          }>(
            `SELECT started_at, latest_activity_text, latest_activity_at
             FROM thread_streaming_status
             WHERE thread_id = ?`,
            normalizedThreadId,
          )
          .toArray()[0] ?? null
      : null;
    this.broadcastThreadStatus(
      normalizedThreadId,
      isStreaming ? 'running' : completedAt === null ? 'idle' : 'unread',
      completedAt,
      summaryStatus,
      summary,
      runningActivity?.latest_activity_text ?? null,
      runningActivity?.latest_activity_at ?? null,
      runningActivity?.started_at ?? null,
    );
  }

  listStreamingThreadStatuses(): WorkspaceRunningThreadStatus[] {
    this.pruneStaleStreamingRows();
    return this.sql
      .exec<{
        thread_id: string;
        started_at: number;
        updated_at: number;
        latest_activity_text: string | null;
        latest_activity_at: number | null;
      }>(
        `SELECT
           thread_id,
           started_at,
           updated_at,
           latest_activity_text,
           latest_activity_at
         FROM thread_streaming_status
         ORDER BY updated_at DESC`,
      )
      .toArray()
      .map((row) => ({
        threadId: row.thread_id,
        startedAt: row.started_at,
        updatedAt: row.updated_at,
        latestActivityText: row.latest_activity_text ?? null,
        latestActivityAt: row.latest_activity_at ?? null,
      }));
  }

  listStreamingThreadIds(): string[] {
    return this.listStreamingThreadStatuses().map((row) => row.threadId);
  }

  private broadcastThreadStatus(
    threadId: string,
    status: BroadcastThreadStatus,
    completedAt: number | null = null,
    summaryStatus: ThreadCompletionSummaryStatus | null = null,
    summary: string | null = null,
    runningActivityText: string | null = null,
    runningActivityAt: number | null = null,
    runningStartedAt: number | null = null,
  ): void {
    const dedupeKey = JSON.stringify([
      status,
      completedAt,
      summaryStatus,
      summary,
      runningActivityText,
      runningActivityAt,
      runningStartedAt,
    ]);
    if (this.lastThreadStatusBroadcasts.get(threadId) === dedupeKey) {
      return;
    }
    if (status === 'running') {
      this.lastThreadStatusBroadcasts.set(threadId, dedupeKey);
    } else {
      this.lastThreadStatusBroadcasts.delete(threadId);
    }
    const payload = JSON.stringify({
      type: 'thread_status',
      threadId,
      status,
      ...(completedAt === null ? {} : { completedAt }),
      ...(summaryStatus === null ? {} : { summaryStatus }),
      ...(summary === null ? {} : { summary }),
      runningActivityText,
      runningActivityAt,
      runningStartedAt,
    });
    for (const socket of this.ctx.getWebSockets(WORKSPACE_STATUS_SOCKET_TAG)) {
      if (socket.readyState !== WebSocket.OPEN) {
        continue;
      }
      try {
        socket.send(payload);
      } catch {}
    }
  }

  private sendThreadStatusSnapshot(socket: WebSocket): void {
    const runningThreads = this.listStreamingThreadStatuses();
    socket.send(
      JSON.stringify({
        type: 'thread_status_snapshot',
        runningThreadIds: runningThreads.map((thread) => thread.threadId),
        runningThreads: runningThreads.map((thread) => ({
          threadId: thread.threadId,
          startedAt: thread.startedAt,
          updatedAt: thread.updatedAt,
          runningActivityText: thread.latestActivityText,
          runningActivityAt: thread.latestActivityAt,
          latestActivityText: thread.latestActivityText,
          latestActivityAt: thread.latestActivityAt,
        })),
      }),
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/status' || request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Not found', { status: 404 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [WORKSPACE_STATUS_SOCKET_TAG]);
    server.serializeAttachment({ connectedAt: Date.now() });

    try {
      this.sendThreadStatusSnapshot(server);
    } catch {}

    return new Response(null, { status: 101, webSocket: client });
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

  private getActiveIntegrationCount(): number {
    try {
      const rawCount = this.sql.exec('SELECT COUNT(*) as count FROM integrations WHERE deleted_at IS NULL').next().value?.count;
      const count = typeof rawCount === 'number' ? rawCount : Number(rawCount ?? 0);
      return Number.isFinite(count) ? count : 0;
    } catch {
      // integrations table may not be available during early migration paths.
      return 0;
    }
  }

  private dispatchWorkspaceUpsert(info: Workspace): void {
    dispatchAdminEvent(this.ctx as any, this.env as any, {
      type: 'workspace_upsert',
      payload: {
        ...info,
        integration_count: this.getActiveIntegrationCount(),
      },
    });
  }

  private async disableScheduledPromptsForWorkspace(workspaceId: string, reason: string): Promise<void> {
    if (!this.env.WORKSPACE_CRON) return;
    try {
      const schedulerStub = this.env.WORKSPACE_CRON.get(
        this.env.WORKSPACE_CRON.idFromName(workspaceId)
      ) as DurableObjectStub<WorkspaceCronDO>;
      await schedulerStub.disableAllScheduledPrompts(workspaceId, reason);
    } catch (error) {
      console.warn('[WorkspaceDO] Failed to disable workspace scheduled prompts', {
        workspaceId,
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  async getInfo(): Promise<Workspace | null> {
    return await this.getStoredInfo();
  }

  private async getStoredInfo(): Promise<Workspace | null> {
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
    // Lazy migration: generate email handle if missing
    if (!info.email_handle) {
      info.email_handle = await this.claimEmailHandle(info.id);
      changed = true;
    }

    if (changed) {
      await this.setInfo(info);
    }
    return info;
  }

  private async claimEmailHandle(workspaceId: string): Promise<string> {
    const registry = this.env.EMAIL_HANDLE;
    for (let attempt = 0; attempt < 20; attempt++) {
      const handle = generateEmailHandle();
      if (registry) {
        const stub = registry.get(registry.idFromName(handle)) as unknown as EmailHandleDO;
        const result = await stub.claim(workspaceId);
        if (!result.ok) continue;
      }
      return handle;
    }
    // Fallback: append workspace ID fragment to guarantee uniqueness
    const suffix = workspaceId.replace(/-/g, '').slice(0, 12);
    const handle = `${generateEmailHandle()}-${suffix}`;
    if (registry) {
      const stub = registry.get(registry.idFromName(handle)) as unknown as EmailHandleDO;
      await stub.claim(workspaceId);
    }
    return handle;
  }

  async setInfo(info: Workspace): Promise<void> {
    this.sql.exec(
      'INSERT OR REPLACE INTO workspace_info (key, value) VALUES (?, ?)',
      'data',
      JSON.stringify(info)
    );
    const orgStub = this.env.ORG.get(
      this.env.ORG.idFromName(info.org_id)
    ) as unknown as OrgDO;
    await orgStub.upsertWorkspaceInfo(info);
    this.dispatchWorkspaceUpsert(info);
  }

  async syncWorkspaceInfoFromOrg(info: Workspace): Promise<void> {
    this.sql.exec(
      'INSERT OR REPLACE INTO workspace_info (key, value) VALUES (?, ?)',
      'data',
      JSON.stringify(info)
    );
  }

  async getModelPickerConfig(): Promise<WorkspaceModelPickerConfig> {
    const raw = this.ctx.storage.kv.get<unknown>(
      WORKSPACE_MODEL_PICKER_CONFIG_KEY
    );
    if (!raw) {
      return defaultWorkspaceModelPickerConfig();
    }
    return parseWorkspaceModelPickerConfig(raw);
  }

  async setModelPickerConfig(
    config: WorkspaceModelPickerConfig,
    audit?: {
      actorId?: string;
      action?: string;
      details?: Record<string, unknown>;
    }
  ): Promise<WorkspaceModelPickerConfig> {
    const previous = await this.getModelPickerConfig();
    const next = parseWorkspaceModelPickerConfig(config);

    this.ctx.storage.kv.put(WORKSPACE_MODEL_PICKER_CONFIG_KEY, next);

    if (audit?.actorId) {
      this.log(audit.action ?? 'model_picker_config_updated', audit.actorId, undefined, {
        ...audit.details,
        previous_use_org_defaults: previous.use_org_defaults,
        next_use_org_defaults: next.use_org_defaults,
        previous_default_model: previous.default_model,
        next_default_model: next.default_model,
        previous_model_count: previous.models.length,
        next_model_count: next.models.length,
      });
    }

    return next;
  }

  async createWorkspace(
    id: string,
    orgId: string,
    name: string,
    createdBy: string,
    description?: string | null
  ): Promise<Workspace> {
    const now = Date.now();

    // Register with the org first — this checks name uniqueness and throws
    // on duplicate names, preventing orphan workspace state + email handles.
    const orgStub = this.env.ORG.get(
      this.env.ORG.idFromName(orgId)
    ) as unknown as OrgDO;
    await orgStub.addWorkspace(id, name, now, createdBy);

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
      email_handle: await this.claimEmailHandle(id),
    };
    await this.setInfo(info);
    this.log('workspace_created', createdBy, undefined, { workspace_id: id, name });

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
      // Check case-insensitive uniqueness within the org
      const orgStub = this.env.ORG.get(
        this.env.ORG.idFromName(info.org_id)
      ) as unknown as OrgDO;
      await orgStub.updateWorkspaceName(info.id, updates.name);
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
    await this.disableScheduledPromptsForWorkspace(info.id, 'workspace_archived');
    this.log('workspace_archived', archivedBy, undefined, { workspace_id: info.id, name: info.name });
    return info;
  }

  /**
   * Permanently delete all workspace-scoped data from this Durable Object.
   * Used by superuser org reset tooling for test account cleanup.
   */
  async hardDeleteWorkspace(actorId: string): Promise<void> {
    const info = await this.getInfo();

    if (info) {
      await this.disableScheduledPromptsForWorkspace(info.id, 'workspace_deleted');
    }

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

  /**
   * Returns only members with explicit workspace-level access overrides
   * (e.g. access_level = 'none'). Members with default 'full' access are
   * NOT stored in this table and won't appear here.
   */
  async listRestrictedMembers(): Promise<WorkspaceMember[]> {
    return this.sql.exec(
      "SELECT user_id, access_level, granted_by, granted_at FROM members WHERE access_level != 'full' ORDER BY granted_at ASC"
    ).toArray() as unknown as WorkspaceMember[];
  }

  /**
   * Returns all workspace members with their effective access level.
   */
  async listMembers(): Promise<Array<{ user_id: string; access_level: WorkspaceAccessLevel }>> {
    return this.sql.exec(
      'SELECT user_id, access_level FROM members ORDER BY granted_at ASC'
    ).toArray() as unknown as Array<{ user_id: string; access_level: WorkspaceAccessLevel }>;
  }

  // Rate limit for sandbox email sending proxy (atomic check + record in single DO call)
  checkAndRecordEmailSendRateLimit(
    count: number,
    hourlyLimit: number,
    dailyLimit: number
  ): { allowed: boolean; reason?: string } {
    const now = Date.now();
    const key = 'email_send_proxy_rate_limit';
    const ONE_HOUR_MS = 60 * 60 * 1000;
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;

    const window: { timestamps: number[] } =
      (this.ctx.storage.kv.get(key) as { timestamps: number[] } | undefined) ?? { timestamps: [] };

    // Prune entries older than 24h
    window.timestamps = window.timestamps.filter((t) => now - t < ONE_DAY_MS);

    const hourlyCount = window.timestamps.filter((t) => now - t < ONE_HOUR_MS).length;
    const dailyCount = window.timestamps.length;

    if (hourlyCount + count > hourlyLimit) {
      return { allowed: false, reason: `Hourly email limit exceeded (${hourlyLimit}/hour)` };
    }
    if (dailyCount + count > dailyLimit) {
      return { allowed: false, reason: `Daily email limit exceeded (${dailyLimit}/day)` };
    }

    // Record the sends
    for (let i = 0; i < count; i++) {
      window.timestamps.push(now);
    }
    this.ctx.storage.kv.put(key, window);
    return { allowed: true };
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
    const [workspaceAccess, orgValidation] = await Promise.all([
      orgStub.getWorkspaceAccess(info.id, userId),
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

    if (workspaceAccess !== 'full') {
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
    const now = Date.now();

    if (!existing) {
      this.sql.exec(
        'INSERT INTO members (user_id, access_level, granted_by, granted_at) VALUES (?, ?, ?, ?)',
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

  async removeMember(userId: string, actorId: string): Promise<void> {
    const existing = await this.getMemberAccess(userId);
    if (existing) {
      this.sql.exec('DELETE FROM members WHERE user_id = ?', userId);
      this.log('member_removed', actorId, userId, { previous_level: existing.access_level });
    }
  }

  async getIntegrations(): Promise<WorkspaceIntegrationRecord[]> {
    return this.sql
      .exec(
        `SELECT id, integration_type, name, category, auth_method, config,
                credentials_encrypted, created_by, created_at, updated_at, deleted_at, token_expires_at,
                auth_status, auth_error_code, auth_error_message, auth_checked_at, reauth_required_at
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
                credentials_encrypted, created_by, created_at, updated_at, deleted_at, token_expires_at,
                auth_status, auth_error_code, auth_error_message, auth_checked_at, reauth_required_at
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
    const initialAuthStatus: WorkspaceIntegrationAuthStatus = resolvedCredentialsEncrypted
      ? 'connected'
      : 'setup_incomplete';
    const initialAuthErrorCode = initialAuthStatus === 'connected'
      ? null
      : 'AUTH_SETUP_INCOMPLETE';
    const initialAuthErrorMessage = initialAuthStatus === 'connected'
      ? null
      : 'Connection setup is incomplete; credentials are required before tools can be used.';
    this.sql.exec(
      `INSERT INTO integrations
       (id, integration_type, name, category, auth_method, config, credentials_encrypted, created_by, created_at, updated_at, deleted_at, token_expires_at,
        auth_status, auth_error_code, auth_error_message, auth_checked_at, reauth_required_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
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
      resolvedTokenExpiresAt,
      initialAuthStatus,
      initialAuthErrorCode,
      initialAuthErrorMessage,
      now,
      initialAuthStatus === 'connected' ? null : now
    );
    this.log('integration_created', createdBy, id, { integration_type: integrationType, name });

    // Schedule token refresh alarm when this integration has token expiry.
    if (resolvedTokenExpiresAt) {
      await this.scheduleNextTokenRefresh();
    }

    const info = await this.getInfo();
    if (info) {
      this.dispatchWorkspaceUpsert(info);
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
      setClauses.push(
        "auth_status = 'connected'",
        'auth_error_code = NULL',
        'auth_error_message = NULL',
        'auth_checked_at = ?',
        'reauth_required_at = NULL'
      );
      params.push(now);
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

  async updateIntegrationAuthStatus(
    id: string,
    authStatus: WorkspaceIntegrationAuthStatus,
    errorCode?: string | null,
    errorMessage?: string | null,
    actorId = 'system'
  ): Promise<void> {
    const now = Date.now();
    const requiresReauth = authStatus === 'needs_reauth'
      || authStatus === 'missing_scopes'
      || authStatus === 'setup_incomplete';
    this.sql.exec(
      `UPDATE integrations
       SET auth_status = ?,
           auth_error_code = ?,
           auth_error_message = ?,
           auth_checked_at = ?,
           reauth_required_at = ?,
           updated_at = ?
       WHERE id = ? AND deleted_at IS NULL`,
      authStatus,
      authStatus === 'connected' ? null : (errorCode ?? null),
      authStatus === 'connected' ? null : (errorMessage ?? null),
      now,
      requiresReauth ? now : null,
      now,
      id
    );
    this.log('integration_auth_status_updated', actorId, id, {
      auth_status: authStatus,
      error_code: authStatus === 'connected' ? null : (errorCode ?? null),
    });
  }

  async deleteIntegration(id: string, actorId: string): Promise<void> {
    const now = Date.now();
    this.sql.exec('UPDATE integrations SET deleted_at = ?, updated_at = ? WHERE id = ?', now, now, id);
    this.log('integration_deleted', actorId, id);

    const info = await this.getInfo();
    if (info) {
      this.dispatchWorkspaceUpsert(info);
    }
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
         AND (auth_method = 'oauth2' OR integration_type = ? OR integration_type = 'remote_mcp')`,
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
      // Find all integration tokens expiring within the batch window
      const expiringIntegrations = this.sql.exec(
        `SELECT id, integration_type, name, category, auth_method, config,
                credentials_encrypted, created_by, created_at, updated_at, deleted_at, token_expires_at,
                auth_status, auth_error_code, auth_error_message, auth_checked_at, reauth_required_at
         FROM integrations
         WHERE token_expires_at IS NOT NULL
           AND token_expires_at <= ?
           AND deleted_at IS NULL
           AND (auth_method = 'oauth2' OR integration_type = ? OR integration_type = 'remote_mcp')
         ORDER BY token_expires_at ASC`,
        batchCutoff,
        BIGQUERY_INTEGRATION_TYPE
      ).toArray() as unknown as WorkspaceIntegrationRecord[];

      if (expiringIntegrations.length > 0) {
        console.log(`[WorkspaceDO] Refreshing ${expiringIntegrations.length} expiring integration tokens`);

        for (const integration of expiringIntegrations) {
          try {
            await this.refreshIntegrationToken(integration);
          } catch (err) {
            console.error(`[WorkspaceDO] Failed to refresh token for ${integration.integration_type}:`, err);
            if (err instanceof PermanentRefreshError) {
              // Permanently invalid (e.g. revoked token) — stop retrying this integration
              const failureAt = Date.now();
              this.sql.exec(
                `UPDATE integrations
                 SET token_expires_at = NULL,
                     auth_status = 'needs_reauth',
                     auth_error_code = 'AUTH_REAUTH_REQUIRED',
                     auth_error_message = ?,
                     auth_checked_at = ?,
                     reauth_required_at = ?,
                     updated_at = ?
                 WHERE id = ?`,
                err.message,
                failureAt,
                failureAt,
                failureAt,
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

      // Schedule alarm for the next expiring token (overwrites fallback)
      await this.scheduleNextTokenRefresh();
    } catch (err) {
      // Log the error but don't rethrow - fallback alarm is already set
      console.error('[WorkspaceDO] Alarm handler failed, will retry in 1 hour:', err);
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
          throw new PermanentRefreshError(
            `No refresh token for Notion integration ${integration.id}`
          );
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

      case 'remote_mcp': {
        if ((credentials.auth_type as string | undefined) && credentials.auth_type !== 'oauth') {
          return;
        }
        ({ credentials: newCredentials, expiresAt: newExpiresAt } = await refreshRemoteMcpOAuthToken(credentials));
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
    const now = Date.now();

    this.sql.exec(
      `UPDATE integrations
       SET credentials_encrypted = ?,
           token_expires_at = ?,
           auth_status = 'connected',
           auth_error_code = NULL,
           auth_error_message = NULL,
           auth_checked_at = ?,
           reauth_required_at = NULL,
           updated_at = ?
       WHERE id = ?`,
      encrypted,
      newExpiresAt,
      now,
      now,
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
