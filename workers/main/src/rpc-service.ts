import { WorkerEntrypoint } from 'cloudflare:workers';
import type {
  AuthEnv,
  UserProfile,
  OrgRole,
  WorkerScript,
  WorkerScriptAccess,
  OrgThread,
  WorkerScriptPreviewUpdateInput,
  WorkerScriptPreviewUpdateResult,
} from './auth';
import {
  createAuthState,
  validateAndConsumeAuthState,
  createWorkerAuthToken,
  validateAndConsumeAuthToken,
  createDispatcherSession,
  getDispatcherSession,
  touchDispatcherSession,
  destroyDispatcherSession,
  type WorkerAuthState,
  type WorkerAuthToken,
  type DispatcherSession,
} from './worker-auth';
import type { ChatEnv } from './durable-objects';
import { getWorkspaceContainer, getContainerIdForWorkspace, type WorkspaceContainerEnv } from './workspace-container';
import {
  getSession as getSessionKV,
  updateSession as updateSessionKV,
  destroySession as destroySessionKV,
  type SessionData,
} from './session-kv';

import type {
  WorkspaceDO,
  WorkspaceInfo,
  WorkspaceIntegrationRecord,
  WorkspaceMember as WorkspaceMemberRecord,
} from './workspace';
import type {
  Message,
  Organization,
  OrgMembership,
  SandboxFileListing,
  WorkspaceFileEntry,
  WorkspaceListResponse,
  Workspace,
  WorkspaceWithAccess,
  WorkspaceAccessLevel,
  Thread,
  User,
  AuditLogEntry,
  Integration,
  CreateIntegrationInput,
  UpdateIntegrationInput,
  CreateApiTokenInput,
  AdminOverview,
  AdminUserSummary,
  AdminWorkspaceSummary,
  AdminWorkspaceDetail,
  AdminThreadWithContext,
  AdminAppSummary,
  AdminAppDetail,
  AdminInvitation,
  PaginatedResult,
  PaginationParams,
} from '../../../src/types';
import { getIntegrationDefinition } from '../../../src/lib/integration-registry';
import { encryptCredentials, decryptCredentials } from '../../../src/lib/integration-crypto';
import {
  createApiToken,
  validateApiToken as validateApiTokenKV,
  deleteApiToken,
  type ApiTokenData,
} from './api-tokens';

/**
 * Maps integration type + credential fields to ENV var names.
 * All vars are prefixed with INT_ to avoid overriding platform keys (e.g., ANTHROPIC_API_KEY).
 * Returns a Record where keys are ENV var names and values are the credential values.
 */
function mapCredentialsToEnvVars(
  integrationType: string,
  credentials: Record<string, unknown>,
  config: Record<string, unknown>
): Record<string, string> {
  const env: Record<string, string> = {};

  // Helper to safely get string value
  const str = (val: unknown): string | null => {
    if (val === undefined || val === null || val === '') return null;
    return String(val);
  };

  // Helper to set env var with INT_ prefix
  const set = (name: string, value: string) => {
    env[`INT_${name}`] = value;
  };

  switch (integrationType) {
    case 'stripe':
      if (str(credentials.api_key)) set('STRIPE_API_KEY', str(credentials.api_key)!);
      if (str(credentials.api_key)) set('STRIPE_SECRET_KEY', str(credentials.api_key)!);
      break;

    case 'openai':
      if (str(credentials.api_key)) set('OPENAI_API_KEY', str(credentials.api_key)!);
      break;

    case 'anthropic':
      if (str(credentials.api_key)) set('ANTHROPIC_API_KEY', str(credentials.api_key)!);
      break;

    case 'github':
      if (str(credentials.api_key)) set('GITHUB_TOKEN', str(credentials.api_key)!);
      break;

    case 'notion':
      if (str(credentials.api_key)) set('NOTION_API_KEY', str(credentials.api_key)!);
      break;

    case 'slack':
      if (str(credentials.api_key)) set('SLACK_BOT_TOKEN', str(credentials.api_key)!);
      break;

    case 'linear':
      if (str(credentials.api_key)) set('LINEAR_API_KEY', str(credentials.api_key)!);
      break;

    case 'sendgrid':
      if (str(credentials.api_key)) set('SENDGRID_API_KEY', str(credentials.api_key)!);
      break;

    case 'twilio':
      if (str(credentials.account_sid)) set('TWILIO_ACCOUNT_SID', str(credentials.account_sid)!);
      if (str(credentials.auth_token)) set('TWILIO_AUTH_TOKEN', str(credentials.auth_token)!);
      break;

    case 'salesforce':
      if (str(credentials.access_token)) set('SALESFORCE_ACCESS_TOKEN', str(credentials.access_token)!);
      if (str(config.instance_url)) set('SALESFORCE_INSTANCE_URL', str(config.instance_url)!);
      break;

    case 'airtable':
      if (str(credentials.api_key)) set('AIRTABLE_API_KEY', str(credentials.api_key)!);
      break;

    case 'hubspot':
      if (str(credentials.api_key)) set('HUBSPOT_API_KEY', str(credentials.api_key)!);
      break;

    case 'aws':
      if (str(credentials.access_key_id)) set('AWS_ACCESS_KEY_ID', str(credentials.access_key_id)!);
      if (str(credentials.secret_access_key)) set('AWS_SECRET_ACCESS_KEY', str(credentials.secret_access_key)!);
      if (str(config.region)) set('AWS_REGION', str(config.region)!);
      break;

    case 'postgres': {
      // Build DATABASE_URL from config + credentials
      const host = str(config.host);
      const port = str(config.port) || '5432';
      const database = str(config.database);
      const user = str(credentials.username);
      const password = str(credentials.password);
      const sslMode = str(config.ssl_mode) || 'require';
      if (host && database && user && password) {
        const url = `postgresql://${user}:${encodeURIComponent(password)}@${host}:${port}/${database}?sslmode=${sslMode}`;
        set('DATABASE_URL', url);
        set('POSTGRES_URL', url);
      }
      break;
    }

    case 'mysql': {
      // Build MYSQL_URL from config + credentials
      const host = str(config.host);
      const port = str(config.port) || '3306';
      const database = str(config.database);
      const user = str(credentials.username);
      const password = str(credentials.password);
      if (host && database && user && password) {
        const url = `mysql://${user}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
        set('MYSQL_URL', url);
        set('DATABASE_URL', url);
      }
      break;
    }

    case 'bigquery':
      // BigQuery uses service account JSON
      if (str(credentials.service_account_json)) {
        set('GOOGLE_APPLICATION_CREDENTIALS_JSON', str(credentials.service_account_json)!);
      }
      if (str(config.project_id)) set('BIGQUERY_PROJECT_ID', str(config.project_id)!);
      break;

    default:
      // Generic fallback: use integration type as prefix
      const prefix = integrationType.toUpperCase().replace(/-/g, '_');
      if (str(credentials.api_key)) set(`${prefix}_API_KEY`, str(credentials.api_key)!);
      break;
  }

  return env;
}

interface DoRpcEnv extends AuthEnv, ChatEnv, WorkspaceContainerEnv {
  WORKSPACE: DurableObjectNamespace<WorkspaceDO>;
  INTEGRATION_SECRET_KEY: string;
  SESSIONS: KVNamespace;
}

function getOrgStub(env: DoRpcEnv, orgId: string) {
  return env.ORG.get(env.ORG.idFromName(orgId));
}

function getThreadStub(env: DoRpcEnv, threadId: string) {
  return env.CHAT_THREAD.get(env.CHAT_THREAD.idFromName(threadId));
}

interface WorkspaceListOptions {
  path?: string;
  recursive?: boolean;
  includeHidden?: boolean;
}

function normalizeWorkspacePath(input?: string): string {
  if (!input) return '/';
  let raw = input.trim();
  if (!raw.startsWith('/')) raw = `/${raw}`;

  const segments: string[] = [];
  for (const part of raw.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (segments.length === 0) {
        throw new Error('Path escapes workspace root');
      }
      segments.pop();
      continue;
    }
    segments.push(part);
  }
  return `/${segments.join('/')}`;
}

function joinWorkspacePath(base: string, child: string): string {
  const basePath = normalizeWorkspacePath(base);
  if (!child || child === '.' || child === './') {
    return basePath;
  }
  const childPath = child.startsWith('/') ? child : `/${child}`;
  return normalizeWorkspacePath(`${basePath}${childPath}`);
}

function resolveWorkspacePath(workspaceRoot: string, workspacePath: string): string {
  const normalized = normalizeWorkspacePath(workspacePath);
  const root = workspaceRoot.replace(/\/$/, '');
  if (normalized === '/') return root || '/';
  return `${root}${normalized}`;
}

type RpcDisposable<T> = T & { [Symbol.dispose](): void };

function asDisposable<T extends object>(value: T): RpcDisposable<T> {
  const withSymbols = value as T & { [Symbol.dispose]?: () => void };
  if (typeof withSymbols[Symbol.dispose] === 'function') {
    return withSymbols as RpcDisposable<T>;
  }

  const disposeFn = () => {};

  if (Object.isExtensible(withSymbols)) {
    try {
      withSymbols[Symbol.dispose] = disposeFn;
      return withSymbols as RpcDisposable<T>;
    } catch {
      // Fall through to wrapper.
    }
  }

  const wrapper = Object.create(withSymbols) as RpcDisposable<T>;
  Object.defineProperty(wrapper, Symbol.dispose, { value: disposeFn });
  return wrapper;
}

const WORKSPACE_SYNC_DEBOUNCE_MS = 5000;

type WorkspaceSyncState = {
  nextSyncAt: number;
  sequence: number;
  running: boolean;
  promise: Promise<void> | null;
};

const workspaceSyncState = new Map<string, WorkspaceSyncState>();

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export class DoRpcService extends WorkerEntrypoint<DoRpcEnv> {
  private hasR2Config(): boolean {
    return Boolean(
      this.env.R2_BUCKET_NAME &&
      this.env.R2_ACCOUNT_ID &&
      this.env.R2_API_TOKEN &&
      this.env.R2_PARENT_ACCESS_KEY_ID
    );
  }

  private isR2ReadOnly(): boolean {
    const value = this.env.R2_MOUNT_READONLY;
    if (!value) return false;
    return ['1', 'true'].includes(String(value).toLowerCase());
  }

  private getWorkspaceRoot(): string {
    return this.env.R2_MOUNT_DIR || '/home/claude';
  }

  private async getWorkspaceInfo(workspaceId: string): Promise<WorkspaceInfo | null> {
    using stub = asDisposable(this.env.WORKSPACE.get(this.env.WORKSPACE.idFromName(workspaceId)));
    const info = await stub.getInfo();
    if (!info || info.archived) return null;
    return info;
  }

  private async requireWorkspaceInfo(workspaceId: string): Promise<WorkspaceInfo> {
    const info = await this.getWorkspaceInfo(workspaceId);
    if (!info) {
      throw new Error('Workspace not found');
    }
    return info;
  }

  private toWorkspace(info: WorkspaceInfo): Workspace {
    return {
      id: info.id,
      org_id: info.org_id,
      name: info.name,
      description: info.description,
      created_by: info.created_by,
      created_at: info.created_at,
      avatar: {
        color: info.avatar_color,
        content: info.avatar_content,
      },
      archived: info.archived,
      archived_at: info.archived_at,
    };
  }

  private async getWorkspaceAccessLevel(workspaceId: string, userId: string): Promise<WorkspaceAccessLevel> {
    using workspaceStub = asDisposable(this.env.WORKSPACE.get(this.env.WORKSPACE.idFromName(workspaceId)));
    const info = await workspaceStub.getInfo();
    if (!info || info.archived) return 'none';

    const isMember = await this.isOrgMember(userId, info.org_id);
    if (!isMember) return 'none';

    const access = await workspaceStub.getMemberAccess(userId);
    return access?.access_level ?? 'full';
  }

  private async ensureDefaultWorkspace(orgId: string, actorId: string): Promise<Workspace | null> {
    const existing = await this.listOrgWorkspaces(orgId);
    if (existing.length > 0) return existing[0];

    using orgStub = asDisposable(this.env.ORG.get(this.env.ORG.idFromName(orgId)));
    const orgInfo = await orgStub.getInfo();
    if (!orgInfo || orgInfo.archived) return null;

    const workspaceId = orgId;
    using workspaceStub = asDisposable(this.env.WORKSPACE.get(this.env.WORKSPACE.idFromName(workspaceId)));
    let info = await workspaceStub.getInfo();
    if (!info) {
      const createdBy = orgInfo.created_by || actorId;
      info = await workspaceStub.createWorkspace(
        workspaceId,
        orgId,
        'Default Workspace',
        createdBy
      );
    }

    await orgStub.addWorkspace(workspaceId, info.name, info.created_at, actorId);
    return this.toWorkspace(info);
  }

  /**
   * Ensure container is running for a workspace.
   * R2 sync happens automatically in the container entrypoint.
   */
  private async ensureContainerRunning(workspaceId: string): Promise<WorkspaceInfo> {
    const info = await this.requireWorkspaceInfo(workspaceId);
    const container = getWorkspaceContainer(this.env, workspaceId);
    await container.startForWorkspace(workspaceId, info.org_id);
    return info;
  }

  private async uploadWorkspaceSnapshot(workspaceId: string): Promise<void> {
    if (!this.hasR2Config() || this.isR2ReadOnly()) return;

    const info = await this.requireWorkspaceInfo(workspaceId);
    const container = getWorkspaceContainer(this.env, workspaceId);
    const workspaceRoot = this.getWorkspaceRoot();

    // Ensure container is running before exec
    await container.startForWorkspace(workspaceId, info.org_id);

    // Container entrypoint already synced R2 on startup, just trigger upload
    const syncResult = await container.exec(`node /app/sync.mjs upload ${workspaceRoot}`, {
      timeout: 120000,
    });

    if (!syncResult.success) {
      console.error(
        `[workspace-sync] Upload failed for ${workspaceId}: ${syncResult.stderr || syncResult.stdout || 'unknown error'}`
      );
    }
  }

  private async runWorkspaceSyncLoop(
    workspaceId: string,
    state: WorkspaceSyncState
  ): Promise<void> {
    try {
      while (true) {
        const waitMs = Math.max(0, state.nextSyncAt - Date.now());
        if (waitMs > 0) {
          await sleep(waitMs);
          continue;
        }

        const sequenceAtStart = state.sequence;
        await this.uploadWorkspaceSnapshot(workspaceId);

        if (state.sequence !== sequenceAtStart) {
          continue;
        }
        break;
      }
    } catch (error) {
      console.error('[workspace-sync] Unexpected sync error', error);
    } finally {
      state.running = false;
      state.promise = null;
      workspaceSyncState.delete(workspaceId);
    }
  }

  private scheduleWorkspaceUpload(workspaceId: string): void {
    if (!this.hasR2Config() || this.isR2ReadOnly()) return;
    const now = Date.now();
    let state = workspaceSyncState.get(workspaceId);
    if (!state) {
      state = {
        nextSyncAt: now + WORKSPACE_SYNC_DEBOUNCE_MS,
        sequence: 0,
        running: false,
        promise: null,
      };
      workspaceSyncState.set(workspaceId, state);
    }

    state.sequence += 1;
    state.nextSyncAt = now + WORKSPACE_SYNC_DEBOUNCE_MS;

    if (!state.running) {
      state.running = true;
      state.promise = this.runWorkspaceSyncLoop(workspaceId, state);
    }

    if (state.promise) {
      this.ctx.waitUntil(state.promise);
    }
  }

  // Session functions (using KV storage)
  async getSession(sessionId: string): Promise<SessionData | null> {
    const session = await getSessionKV(this.env.SESSIONS, sessionId);
    if (!session) return null;

    let resolvedWorkspaceId = session.workspace_id;
    if (resolvedWorkspaceId) {
      const info = await this.getWorkspaceInfo(resolvedWorkspaceId);
      if (!info || info.org_id !== session.org_id) {
        resolvedWorkspaceId = null;
      }
    }
    if (!resolvedWorkspaceId) {
      const fallback = await this.ensureDefaultWorkspace(session.org_id, session.user_id);
      resolvedWorkspaceId = fallback?.id ?? null;
    }
    if (resolvedWorkspaceId !== session.workspace_id) {
      session.workspace_id = resolvedWorkspaceId;
      await updateSessionKV(this.env.SESSIONS, sessionId, session);
      if (resolvedWorkspaceId) {
        using userStub = asDisposable(this.env.USER.get(this.env.USER.idFromName(session.user_id)));
        await userStub.setOrgLastWorkspace(session.org_id, resolvedWorkspaceId);
      }
    }
    return session;
  }

  async getSessionWithUser(
    sessionId: string
  ): Promise<{ session: SessionData; user: UserProfile } | null> {
    const session = await this.getSession(sessionId);
    if (!session) return null;

    using userStub = asDisposable(this.env.USER.get(this.env.USER.idFromName(session.user_id)));
    const user = await userStub.getProfile();
    if (!user) return null;

    return { session, user };
  }

  async destroySession(sessionId: string): Promise<void> {
    await destroySessionKV(this.env.SESSIONS, sessionId);
  }

  async switchSessionOrg(sessionId: string, orgId: string, workspaceId: string | null = null): Promise<void> {
    const session = await getSessionKV(this.env.SESSIONS, sessionId);
    if (!session) return;

    let resolvedWorkspaceId = workspaceId;
    if (!resolvedWorkspaceId) {
      const fallback = await this.ensureDefaultWorkspace(orgId, session.user_id);
      resolvedWorkspaceId = fallback?.id ?? null;
    }

    session.org_id = orgId;
    session.workspace_id = resolvedWorkspaceId;
    await updateSessionKV(this.env.SESSIONS, sessionId, session);

    if (resolvedWorkspaceId) {
      using userStub = asDisposable(this.env.USER.get(this.env.USER.idFromName(session.user_id)));
      await userStub.setOrgLastWorkspace(orgId, resolvedWorkspaceId);
    }
  }

  async switchSessionWorkspace(sessionId: string, workspaceId: string | null): Promise<void> {
    const session = await getSessionKV(this.env.SESSIONS, sessionId);
    if (!session) return;

    session.workspace_id = workspaceId;
    await updateSessionKV(this.env.SESSIONS, sessionId, session);

    if (workspaceId) {
      using userStub = asDisposable(this.env.USER.get(this.env.USER.idFromName(session.user_id)));
      await userStub.setOrgLastWorkspace(session.org_id, workspaceId);
    }
  }

  // User functions
  async getUserByEmail(email: string): Promise<{ userId: string; user: UserProfile } | null> {
    const userId = await this.env.EMAIL_TO_USER.get(`email:${email.toLowerCase()}`);
    if (!userId) return null;

    using stub = asDisposable(this.env.USER.get(this.env.USER.idFromName(userId)));
    const user = await stub.getProfile();
    if (!user) return null;

    return { userId, user };
  }

  async getUserById(userId: string): Promise<UserProfile | null> {
    using stub = asDisposable(this.env.USER.get(this.env.USER.idFromName(userId)));
    return stub.getProfile();
  }

  async getUsersByIds(userIds: string[]): Promise<UserProfile[]> {
    const uniqueIds = Array.from(
      new Set(
        userIds
          .map((id) => id?.trim())
          .filter((id): id is string => Boolean(id))
      )
    );
    if (uniqueIds.length === 0) return [];

    const users = await Promise.all(
      uniqueIds.map(async (id) => {
        using stub = asDisposable(this.env.USER.get(this.env.USER.idFromName(id)));
        return stub.getProfile();
      })
    );
    return users.filter(Boolean) as UserProfile[];
  }

  async updateUserProfile(
    userId: string,
    updates: { name?: string | null; avatar?: { color: string; content: string } }
  ): Promise<UserProfile | null> {
    using stub = asDisposable(this.env.USER.get(this.env.USER.idFromName(userId)));
    return stub.updateProfile({
      name: updates.name,
      avatar_color: updates.avatar?.color,
      avatar_content: updates.avatar?.content,
    });
  }

  async createUser(
    email: string,
    password: string,
    name: string | null
  ): Promise<{ userId: string; user: UserProfile }> {
    const normalizedEmail = email.toLowerCase();
    const kvKey = `email:${normalizedEmail}`;

    // Check if email already exists (defense against race condition)
    const existingUserId = await this.env.EMAIL_TO_USER.get(kvKey);
    if (existingUserId) {
      throw new Error("An account with this email already exists");
    }

    const userId = crypto.randomUUID();

    // Write KV first to "claim" the email
    // This minimizes the race window (though KV doesn't support atomic put-if-absent)
    await this.env.EMAIL_TO_USER.put(kvKey, userId);

    // Verify we still own the email (detect if someone else wrote after us)
    const verifyUserId = await this.env.EMAIL_TO_USER.get(kvKey);
    if (verifyUserId !== userId) {
      // Someone else won the race, abort
      throw new Error("An account with this email already exists");
    }

    // Now create the user - we've claimed the email
    try {
      using stub = asDisposable(this.env.USER.get(this.env.USER.idFromName(userId)));
      const user = await stub.createUser(userId, normalizedEmail, password, name);
      return { userId, user };
    } catch (error) {
      // If user creation fails, clean up the KV entry to avoid orphaned claims
      await this.env.EMAIL_TO_USER.delete(kvKey);
      throw error;
    }
  }

  async verifyUserPassword(userId: string, password: string): Promise<boolean> {
    using stub = asDisposable(this.env.USER.get(this.env.USER.idFromName(userId)));
    return stub.verifyPassword(password);
  }

  async getUserOrgs(userId: string): Promise<OrgMembership[]> {
    using userStub = asDisposable(this.env.USER.get(this.env.USER.idFromName(userId)));
    const userOrgs = await userStub.getOrgs();

    const memberships: OrgMembership[] = [];
    for (const uo of userOrgs) {
      using orgStub = asDisposable(this.env.ORG.get(this.env.ORG.idFromName(uo.org_id)));
      const orgInfo = await orgStub.getInfo();
      if (orgInfo && !orgInfo.archived) {
        memberships.push({
          org_id: uo.org_id,
          org_name: orgInfo.name,
          role: uo.role,
          joined_at: uo.joined_at,
          last_workspace_id: uo.last_workspace_id ?? null,
        });
      }
    }

    return memberships;
  }

  async addUserToOrg(userId: string, orgId: string, role: OrgRole): Promise<void> {
    const workspaces = await this.listOrgWorkspaces(orgId);
    const lastWorkspaceId = workspaces[0]?.id ?? null;
    using userStub = asDisposable(this.env.USER.get(this.env.USER.idFromName(userId)));
    await userStub.addOrg(orgId, role, lastWorkspaceId);
  }

  async removeUserFromOrg(userId: string, orgId: string): Promise<void> {
    using userStub = asDisposable(this.env.USER.get(this.env.USER.idFromName(userId)));
    await userStub.removeOrg(orgId);
  }

  // Admin functions
  async getAdminOverview(): Promise<AdminOverview> {
    const orgIds = new Set<string>();
    const seenUserIds = new Set<string>();
    const allKeys: string[] = [];
    let cursor: string | undefined;

    // Step 1: Collect all email keys
    while (true) {
      const list = await this.env.EMAIL_TO_USER.list({ prefix: 'email:', cursor });
      for (const key of list.keys) {
        allKeys.push(key.name);
      }
      if (list.list_complete || !list.cursor) break;
      cursor = list.cursor;
    }

    // Step 2: Batch fetch all user IDs in parallel
    const userIdResults = await Promise.all(
      allKeys.map((key) => this.env.EMAIL_TO_USER.get(key))
    );
    const userIds = userIdResults.filter((id): id is string => {
      if (!id || seenUserIds.has(id)) return false;
      seenUserIds.add(id);
      return true;
    });

    // Step 3: Batch fetch all profiles and orgs in parallel
    const userDataResults = await Promise.all(
      userIds.map(async (userId) => {
        using userStub = asDisposable(this.env.USER.get(this.env.USER.idFromName(userId)));
        const [profile, orgs] = await Promise.all([
          userStub.getProfile(),
          userStub.getOrgs(),
        ]);
        return { profile, orgs };
      })
    );

    // Step 4: Process results
    const users: AdminUserSummary[] = [];
    let totalMemberships = 0;
    let orphanedUsers = 0;

    for (const { profile, orgs } of userDataResults) {
      if (!profile) continue;

      for (const org of orgs) {
        orgIds.add(org.org_id);
      }
      totalMemberships += orgs.length;
      if (profile.is_orphaned) {
        orphanedUsers += 1;
      }

      users.push({
        id: profile.id,
        email: profile.email,
        name: profile.name,
        created_at: profile.created_at,
        is_superuser: profile.is_superuser,
        org_count: orgs.length,
        avatar: {
          color: profile.avatar_color,
          content: profile.avatar_content,
        },
        is_orphaned: profile.is_orphaned,
      });
    }

    users.sort((a, b) => b.created_at - a.created_at);

    const orgIdList = Array.from(orgIds);
    const workspaceIds = new Set<string>();
    if (orgIdList.length > 0) {
      const workspaceEntries = await Promise.all(
        orgIdList.map(async (orgId) => {
          using orgStub = asDisposable(this.env.ORG.get(this.env.ORG.idFromName(orgId)));
          const workspaces = await orgStub.getWorkspaces();
          return workspaces.map((workspace) => workspace.id);
        })
      );
      for (const entries of workspaceEntries) {
        for (const workspaceId of entries) {
          workspaceIds.add(workspaceId);
        }
      }
    }

    const workspaceIdList = Array.from(workspaceIds);
    const integrationCounts = await Promise.all(
      workspaceIdList.map(async (workspaceId) => {
        using workspaceStub = asDisposable(
          this.env.WORKSPACE.get(this.env.WORKSPACE.idFromName(workspaceId))
        );
        const integrations = await workspaceStub.getIntegrations();
        return integrations.length;
      })
    );
    const totalIntegrations = integrationCounts.reduce((sum, count) => sum + count, 0);

    return {
      users,
      total_users: users.length,
      total_orgs: orgIds.size,
      total_memberships: totalMemberships,
      total_workspaces: workspaceIds.size,
      total_integrations: totalIntegrations,
      orphaned_users: orphanedUsers,
    };
  }

  // Admin: Update user profile (name, is_superuser)
  async adminUpdateUser(
    userId: string,
    updates: { name?: string | null; is_superuser?: boolean; avatar?: { color: string; content: string } }
  ): Promise<UserProfile | null> {
    using stub = asDisposable(this.env.USER.get(this.env.USER.idFromName(userId)));
    let profile = await stub.getProfile();
    if (!profile) return null;

    if (updates.name !== undefined || updates.avatar) {
      const updated = await stub.updateProfile({
        name: updates.name,
        avatar_color: updates.avatar?.color,
        avatar_content: updates.avatar?.content,
      });
      if (updated) {
        profile = updated;
      }
    }
    if (updates.is_superuser !== undefined && updates.is_superuser !== profile.is_superuser) {
      profile.is_superuser = updates.is_superuser;
      await stub.setProfile(profile);
    }
    return profile;
  }

  // Admin: Get all organizations with details
  async adminGetAllOrgs(): Promise<Array<Organization & { member_count: number; workspace_count: number }>> {
    const orgIds = await this.collectAllOrgIds();

    // Fetch org details in parallel
    const orgResults = await Promise.all(
      Array.from(orgIds).map(async (orgId) => {
        using orgStub = asDisposable(this.env.ORG.get(this.env.ORG.idFromName(orgId)));
        const [info, memberCount, workspaces] = await Promise.all([
          orgStub.getInfo(),
          orgStub.getMemberCount(),
          orgStub.getWorkspaces(),
        ]);
        if (!info) return null;
        return {
          id: info.id,
          name: info.name,
          created_at: info.created_at,
          created_by: info.created_by,
          billing_status: info.billing_status,
          archived: info.archived,
          archived_at: info.archived_at,
          archived_by: info.archived_by,
          member_count: memberCount,
          workspace_count: workspaces.length,
        };
      })
    );

    const orgs = orgResults.filter(
      (org): org is NonNullable<(typeof orgResults)[number]> => org !== null
    );
    orgs.sort((a, b) => b.created_at - a.created_at);
    return orgs;
  }

  // Admin: Get all threads across all orgs (threads are stored in OrgDO)
  async adminGetAllThreads(): Promise<AdminThreadWithContext[]> {
    const orgIds = await this.collectAllOrgIds();
    const workspaceNameById = new Map<string, string>();

    // Fetch org info and threads in parallel for each org
    const threadResults = await Promise.all(
      Array.from(orgIds).map(async (orgId) => {
        using orgStub = asDisposable(getOrgStub(this.env, orgId));
        const [info, threads] = await Promise.all([orgStub.getInfo(), orgStub.getThreads()]);
        const orgName = info?.name ?? orgId;

        // Get workspace names for threads (batch per org)
        const workspaceIds = [...new Set(threads.map((t) => t.workspace_id))];
        const workspaceInfos = await Promise.all(
          workspaceIds.map(async (wsId) => {
            if (workspaceNameById.has(wsId)) return null;
            using wsStub = asDisposable(this.env.WORKSPACE.get(this.env.WORKSPACE.idFromName(wsId)));
            const wsInfo = await wsStub.getInfo();
            return { wsId, name: wsInfo?.name ?? wsId };
          })
        );
        for (const wsInfo of workspaceInfos) {
          if (wsInfo) workspaceNameById.set(wsInfo.wsId, wsInfo.name);
        }

        return threads.map((thread) => ({
          ...this.toThread(thread),
          org_id: orgId,
          org_name: orgName,
          workspace_id: thread.workspace_id,
          workspace_name: workspaceNameById.get(thread.workspace_id) ?? thread.workspace_id,
        }));
      })
    );

    const allThreads = threadResults.flat();
    allThreads.sort((a, b) => b.updated_at - a.updated_at);
    return allThreads;
  }

  // Admin: Get thread with messages and preview workers (threads stored in OrgDO)
  async adminGetThreadWithMessages(
    threadId: string
  ): Promise<{
    thread: Thread;
    messages: Message[];
    org_id: string;
    org_name: string;
    workspace_id: string;
    workspace_name: string;
    preview_workers: string[];
  } | null> {
    const orgIds = await this.collectAllOrgIds();

    // Search for thread in all orgs in parallel
    const results = await Promise.all(
      Array.from(orgIds).map(async (orgId) => {
        using orgStub = asDisposable(getOrgStub(this.env, orgId));
        const thread = await orgStub.getThread(threadId);
        if (thread) {
          // Read messages from container and preview workers in parallel
          const [messages, preview_workers, workspaceInfo, orgInfo] = await Promise.all([
            this.getMessages(threadId, thread.workspace_id),
            this.getThreadPreview(threadId),
            this.getWorkspaceInfo(thread.workspace_id),
            orgStub.getInfo(),
          ]);
          return {
            thread: this.toThread(thread),
            messages,
            org_id: orgId,
            org_name: orgInfo?.name ?? orgId,
            workspace_id: thread.workspace_id,
            workspace_name: workspaceInfo?.name ?? thread.workspace_id,
            preview_workers,
          };
        }
        return null;
      })
    );

    return results.find((r) => r !== null) || null;
  }

  // Admin: Get app with context (worker scripts stored in OrgDO)
  async adminGetAppDetail(scriptName: string): Promise<AdminAppDetail | null> {
    const normalized = scriptName.trim();
    if (!normalized) return null;

    const fetchFromOrg = async (orgId: string): Promise<AdminAppDetail | null> => {
      using orgStub = asDisposable(getOrgStub(this.env, orgId));
      const script = await orgStub.getWorkerScript(normalized);
      if (!script) return null;

      const [info, workspaces] = await Promise.all([
        orgStub.getInfo(),
        orgStub.getWorkspaces(),
      ]);
      const workspace = workspaces.find((entry) => entry.id === script.workspace_id);
      const orgName = info?.name ?? orgId;
      const workspaceName = workspace?.name ?? script.workspace_id;
      const creator = script.created_by.startsWith('system:')
        ? null
        : await this.getUserById(script.created_by);

      return {
        script_name: script.script_name,
        workspace_id: script.workspace_id,
        workspace_name: workspaceName,
        org_id: orgId,
        org_name: orgName,
        created_by: script.created_by,
        created_by_name: creator?.name ?? null,
        created_by_email: creator?.email ?? null,
        created_at: script.created_at,
        updated_at: script.updated_at,
        is_public: script.is_public,
        preview_status: script.preview_status ?? null,
        preview_error: script.preview_error ?? null,
      };
    };

    const indexData = await this.env.API_TOKENS.get(`script_org:${normalized}`);
    const indexedOrgId = indexData
      ? (JSON.parse(indexData) as { org_id: string }).org_id
      : null;

    if (indexedOrgId) {
      const result = await fetchFromOrg(indexedOrgId);
      if (result) return result;
    }

    const orgIds = await this.collectAllOrgIds();
    for (const orgId of orgIds) {
      if (orgId === indexedOrgId) continue;
      const result = await fetchFromOrg(orgId);
      if (result) return result;
    }

    return null;
  }

  // Admin: Get workspace with related data (threads stored in OrgDO)
  async adminGetWorkspaceDetail(workspaceId: string): Promise<AdminWorkspaceDetail | null> {
    const info = await this.getWorkspaceInfo(workspaceId);
    if (!info) return null;

    using orgStub = asDisposable(getOrgStub(this.env, info.org_id));
    const orgInfo = await orgStub.getInfo();
    if (!orgInfo) return null;

    const [threads, integrations, members] = await Promise.all([
      (async () => {
        const orgThreads = await orgStub.getThreadsByWorkspace(workspaceId);
        return orgThreads.map((t) => this.toThread(t));
      })(),
      this.getWorkspaceIntegrations(workspaceId),
      (async () => {
        using workspaceStub = asDisposable(
          this.env.WORKSPACE.get(this.env.WORKSPACE.idFromName(workspaceId))
        );
        return workspaceStub.listMembers();
      })(),
    ]);

    return {
      workspace: this.toWorkspace(info),
      org: {
        id: orgInfo.id,
        name: orgInfo.name,
        created_at: orgInfo.created_at,
        created_by: orgInfo.created_by,
        billing_status: orgInfo.billing_status,
        archived: orgInfo.archived,
        archived_at: orgInfo.archived_at,
        archived_by: orgInfo.archived_by,
      },
      threads,
      integrations,
      members,
    };
  }

  async adminUpdateWorkspace(
    workspaceId: string,
    updates: { name?: string; description?: string | null; avatar?: { color: string; content: string } },
    actorId: string
  ): Promise<Workspace | null> {
    return this.updateWorkspace(workspaceId, updates, actorId);
  }

  async adminArchiveWorkspace(workspaceId: string, actorId: string): Promise<Workspace | null> {
    return this.archiveWorkspace(workspaceId, actorId);
  }

  // Admin: Update thread (threads stored in OrgDO)
  async adminUpdateThread(
    threadId: string,
    updates: { title?: string; created_by?: string }
  ): Promise<Thread | null> {
    const orgIds = await this.collectAllOrgIds();

    // Search for thread in all orgs in parallel
    const results = await Promise.all(
      Array.from(orgIds).map(async (orgId) => {
        using orgStub = asDisposable(getOrgStub(this.env, orgId));
        const thread = await orgStub.getThread(threadId);
        if (thread && (updates.title !== undefined || updates.created_by !== undefined)) {
          const updated = await orgStub.adminUpdateThread(threadId, updates, 'admin-cli');
          return updated ? this.toThread(updated) : null;
        }
        return null;
      })
    );

    return results.find((r) => r !== null) || null;
  }

  // Helper: Collect all org IDs from user memberships (parallelized)
  private async collectAllOrgIds(): Promise<Set<string>> {
    const allKeys: string[] = [];
    let cursor: string | undefined;

    // Step 1: Collect all email keys
    while (true) {
      const list = await this.env.EMAIL_TO_USER.list({ prefix: 'email:', cursor });
      for (const key of list.keys) {
        allKeys.push(key.name);
      }
      if (list.list_complete || !list.cursor) break;
      cursor = list.cursor;
    }

    // Step 2: Batch fetch all user IDs in parallel
    const userIds = (
      await Promise.all(allKeys.map((key) => this.env.EMAIL_TO_USER.get(key)))
    ).filter((id): id is string => id !== null);

    // Step 3: Batch fetch all orgs in parallel
    const orgsResults = await Promise.all(
      userIds.map((userId) => {
        using userStub = asDisposable(this.env.USER.get(this.env.USER.idFromName(userId)));
        return userStub.getOrgs();
      })
    );

    // Step 4: Collect unique org IDs
    const orgIds = new Set<string>();
    for (const orgs of orgsResults) {
      for (const org of orgs) {
        orgIds.add(org.org_id);
      }
    }

    return orgIds;
  }

  private async collectAllWorkspaceIds(): Promise<Array<{ workspaceId: string; orgId: string }>> {
    const orgIds = await this.collectAllOrgIds();
    const workspacePairs: Array<{ workspaceId: string; orgId: string }> = [];

    await Promise.all(
      Array.from(orgIds).map(async (orgId) => {
        using orgStub = asDisposable(this.env.ORG.get(this.env.ORG.idFromName(orgId)));
        const workspaces = await orgStub.getWorkspaces();
        for (const workspace of workspaces) {
          workspacePairs.push({ workspaceId: workspace.id, orgId });
        }
      })
    );

    return workspacePairs;
  }

  // Admin: Get paginated users
  async adminGetUsersPaginated(
    params: PaginationParams = {}
  ): Promise<PaginatedResult<AdminUserSummary>> {
    const { offset = 0, limit = 50 } = params;
    const search = params.search?.trim().toLowerCase();

    // Get all users first (we need the full list to know total)
    const overview = await this.getAdminOverview();
    const allUsers = overview.users;
    const filtered = search
      ? allUsers.filter((user) => {
        const haystack = `${user.id} ${user.email} ${user.name ?? ''}`.toLowerCase();
        return haystack.includes(search);
      })
      : allUsers;
    const total = filtered.length;

    // Apply pagination
    const items = filtered.slice(offset, offset + limit);

    return { items, total, offset, limit };
  }

  // Admin: Get paginated organizations
  async adminGetOrgsPaginated(
    params: PaginationParams = {}
  ): Promise<PaginatedResult<Organization & { member_count: number; workspace_count: number }>> {
    const { offset = 0, limit = 50 } = params;
    const search = params.search?.trim().toLowerCase();

    // Get all orgs first
    const allOrgs = await this.adminGetAllOrgs();
    const filtered = search
      ? allOrgs.filter((org) => {
        const haystack = `${org.id} ${org.name}`.toLowerCase();
        return haystack.includes(search);
      })
      : allOrgs;
    const total = filtered.length;

    // Apply pagination
    const items = filtered.slice(offset, offset + limit);

    return { items, total, offset, limit };
  }

  // Admin: Get paginated workspaces (threads stored in OrgDO)
  async adminGetWorkspacesPaginated(
    params: PaginationParams = {}
  ): Promise<PaginatedResult<AdminWorkspaceSummary>> {
    const { offset = 0, limit = 50 } = params;
    const search = params.search?.trim().toLowerCase();
    const workspaces = await this.collectAllWorkspaceIds();
    const orgNameById = new Map<string, string>();
    const threadCountByWorkspace = new Map<string, number>();

    const orgIds = Array.from(new Set(workspaces.map((workspace) => workspace.orgId)));

    // Fetch org info and thread counts in parallel
    await Promise.all(
      orgIds.map(async (orgId) => {
        using orgStub = asDisposable(getOrgStub(this.env, orgId));
        const [info, threads] = await Promise.all([orgStub.getInfo(), orgStub.getThreads()]);
        orgNameById.set(orgId, info?.name ?? orgId);

        // Count threads by workspace
        for (const thread of threads) {
          const count = threadCountByWorkspace.get(thread.workspace_id) ?? 0;
          threadCountByWorkspace.set(thread.workspace_id, count + 1);
        }
      })
    );

    const summaries = await Promise.all(
      workspaces.map(async ({ workspaceId, orgId }) => {
        using workspaceStub = asDisposable(
          this.env.WORKSPACE.get(this.env.WORKSPACE.idFromName(workspaceId))
        );
        const [info, integrations] = await Promise.all([
          workspaceStub.getInfo(),
          workspaceStub.getIntegrations(),
        ]);
        if (!info) return null;

        return {
          ...this.toWorkspace(info),
          org_id: info.org_id,
          org_name: orgNameById.get(orgId) ?? orgId,
          thread_count: threadCountByWorkspace.get(workspaceId) ?? 0,
          integration_count: integrations.length,
        };
      })
    );

    const allItems = summaries.filter(
      (summary): summary is AdminWorkspaceSummary => summary !== null
    );
    allItems.sort((a, b) => b.created_at - a.created_at);
    const filtered = search
      ? allItems.filter((workspace) => {
        const haystack = `${workspace.id} ${workspace.name} ${workspace.org_name} ${workspace.description ?? ''}`.toLowerCase();
        return haystack.includes(search);
      })
      : allItems;
    const total = filtered.length;
    const items = filtered.slice(offset, offset + limit);

    return { items, total, offset, limit };
  }

  // Admin: Get paginated threads
  async adminGetThreadsPaginated(
    params: PaginationParams = {}
  ): Promise<PaginatedResult<AdminThreadWithContext>> {
    const { offset = 0, limit = 50 } = params;
    const search = params.search?.trim().toLowerCase();

    // Get all threads first
    const allThreads = await this.adminGetAllThreads();
    const filtered = search
      ? allThreads.filter((thread) => {
        const haystack = `${thread.id} ${thread.title} ${thread.org_name} ${thread.workspace_name}`.toLowerCase();
        return haystack.includes(search);
      })
      : allThreads;
    const total = filtered.length;

    // Apply pagination
    const items = filtered.slice(offset, offset + limit);

    return { items, total, offset, limit };
  }

  async adminGetAppsPaginated(
    params: PaginationParams = {}
  ): Promise<PaginatedResult<AdminAppSummary>> {
    const { offset = 0, limit = 50 } = params;
    const search = params.search?.trim().toLowerCase();
    const orgIds = await this.collectAllOrgIds();

    const appResults = await Promise.all(
      Array.from(orgIds).map(async (orgId) => {
        using orgStub = asDisposable(getOrgStub(this.env, orgId));
        const [info, scripts, workspaces] = await Promise.all([
          orgStub.getInfo(),
          orgStub.listWorkerScripts(),
          orgStub.getWorkspaces(),
        ]);
        const orgName = info?.name ?? orgId;
        const workspaceNameById = new Map(
          workspaces.map((workspace) => [workspace.id, workspace.name])
        );

        return scripts.map((script) => ({
          script,
          org_id: orgId,
          org_name: orgName,
          workspace_name: workspaceNameById.get(script.workspace_id) ?? script.workspace_id,
        }));
      })
    );

    const entries = appResults.flat();
    const creatorIds = entries
      .map((entry) => entry.script.created_by)
      .filter((id) => id && !id.startsWith('system:'));
    const creators = await this.getUsersByIds(creatorIds);
    const creatorMap = new Map(creators.map((creator) => [creator.id, creator]));

    const allApps = entries.map((entry) => {
      const creator = creatorMap.get(entry.script.created_by);
      return {
        script_name: entry.script.script_name,
        workspace_id: entry.script.workspace_id,
        workspace_name: entry.workspace_name,
        org_id: entry.org_id,
        org_name: entry.org_name,
        created_by: entry.script.created_by,
        created_by_name: creator?.name ?? null,
        created_by_email: creator?.email ?? null,
        created_at: entry.script.created_at,
        updated_at: entry.script.updated_at,
        is_public: entry.script.is_public,
        preview_status: entry.script.preview_status ?? null,
        preview_error: entry.script.preview_error ?? null,
      };
    });

    const filtered = search
      ? allApps.filter((app) => {
        const haystack = [
          app.script_name,
          app.org_name,
          app.workspace_name,
          app.created_by,
          app.created_by_name ?? '',
          app.created_by_email ?? '',
        ]
          .join(' ')
          .toLowerCase();
        return haystack.includes(search);
      })
      : allApps;
    const sorted = filtered.sort((a, b) => b.updated_at - a.updated_at);
    const total = sorted.length;
    const items = sorted.slice(offset, offset + limit);

    return { items, total, offset, limit };
  }

  async adminGetAppCount(): Promise<number> {
    const orgIds = await this.collectAllOrgIds();
    const counts = await Promise.all(
      Array.from(orgIds).map(async (orgId) => {
        using orgStub = asDisposable(getOrgStub(this.env, orgId));
        const scripts = await orgStub.listWorkerScripts();
        return scripts.length;
      })
    );
    return counts.reduce((total, count) => total + count, 0);
  }

  async adminGetInvitationsPaginated(
    params: PaginationParams = {}
  ): Promise<PaginatedResult<AdminInvitation>> {
    const { offset = 0, limit = 50 } = params;
    const search = params.search?.trim().toLowerCase();
    const orgIds = await this.collectAllOrgIds();

    const orgResults = await Promise.all(
      Array.from(orgIds).map(async (orgId) => {
        using orgStub = asDisposable(this.env.ORG.get(this.env.ORG.idFromName(orgId)));
        const [info, invitations] = await Promise.all([
          orgStub.getInfo(),
          orgStub.getInvitations(),
        ]);
        if (!info) return null;
        return {
          org_id: orgId,
          org_name: info.name,
          invitations,
        };
      })
    );

    const entries: Array<{
      id: string;
      email: string;
      role: OrgRole;
      org_id: string;
      org_name: string;
      invited_by: string;
      created_at: number;
      expires_at: number;
    }> = [];
    const inviterIds = new Set<string>();

    for (const entry of orgResults) {
      if (!entry) continue;
      for (const invitation of entry.invitations) {
        inviterIds.add(invitation.invited_by);
        entries.push({
          id: invitation.id,
          email: invitation.email,
          role: invitation.role,
          org_id: entry.org_id,
          org_name: entry.org_name,
          invited_by: invitation.invited_by,
          created_at: invitation.created_at,
          expires_at: invitation.expires_at,
        });
      }
    }

    const inviterProfiles = await Promise.all(
      Array.from(inviterIds).map(async (userId) => {
        using userStub = asDisposable(this.env.USER.get(this.env.USER.idFromName(userId)));
        const profile = await userStub.getProfile();
        return { userId, profile };
      })
    );
    const inviterMap = new Map<string, { email: string; name: string | null }>();
    for (const { userId, profile } of inviterProfiles) {
      if (!profile) continue;
      inviterMap.set(userId, { email: profile.email, name: profile.name });
    }

    const allInvitations = entries.map((entry) => {
      const inviter = inviterMap.get(entry.invited_by);
      return {
        id: entry.id,
        email: entry.email,
        role: entry.role,
        org_id: entry.org_id,
        org_name: entry.org_name,
        invited_by: entry.invited_by,
        inviter_email: inviter?.email ?? entry.invited_by,
        inviter_name: inviter?.name ?? null,
        created_at: entry.created_at,
        expires_at: entry.expires_at,
      };
    });

    const filtered = search
      ? allInvitations.filter((invitation) => {
        const haystack = `${invitation.id} ${invitation.email} ${invitation.org_name}`.toLowerCase();
        return haystack.includes(search);
      })
      : allInvitations;
    const sorted = filtered.sort((a, b) => b.created_at - a.created_at);
    const total = sorted.length;
    const items = sorted.slice(offset, offset + limit);

    return { items, total, offset, limit };
  }

  async adminDeleteInvitation(orgId: string, invitationId: string): Promise<void> {
    using stub = asDisposable(this.env.ORG.get(this.env.ORG.idFromName(orgId)));
    await stub.deleteInvitation(invitationId);
  }

  // Organization functions
  async getOrg(orgId: string): Promise<Organization | null> {
    using stub = asDisposable(this.env.ORG.get(this.env.ORG.idFromName(orgId)));
    const info = await stub.getInfo();
    if (!info) return null;

    return {
      id: info.id,
      name: info.name,
      created_at: info.created_at,
      created_by: info.created_by,
      billing_status: info.billing_status,
      archived: info.archived,
      archived_at: info.archived_at,
      archived_by: info.archived_by,
    };
  }

  async createOrg(name: string, createdBy: string): Promise<Organization> {
    const orgId = crypto.randomUUID();

    using orgStub = asDisposable(this.env.ORG.get(this.env.ORG.idFromName(orgId)));
    const orgInfo = await orgStub.createOrg(orgId, name, createdBy);

    const workspaceId = crypto.randomUUID();
    using workspaceStub = asDisposable(this.env.WORKSPACE.get(this.env.WORKSPACE.idFromName(workspaceId)));
    const workspaceInfo = await workspaceStub.createWorkspace(
      workspaceId,
      orgId,
      'Default Workspace',
      createdBy
    );
    await orgStub.addWorkspace(workspaceId, workspaceInfo.name, workspaceInfo.created_at, createdBy);

    using userStub = asDisposable(this.env.USER.get(this.env.USER.idFromName(createdBy)));
    await userStub.addOrg(orgId, 'owner', workspaceId);

    return {
      id: orgInfo.id,
      name: orgInfo.name,
      created_at: orgInfo.created_at,
      created_by: orgInfo.created_by,
      billing_status: orgInfo.billing_status,
      archived: orgInfo.archived,
      archived_at: orgInfo.archived_at,
      archived_by: orgInfo.archived_by,
    };
  }

  async updateOrgName(orgId: string, name: string, actorId: string): Promise<void> {
    using stub = asDisposable(this.env.ORG.get(this.env.ORG.idFromName(orgId)));
    await stub.updateName(name, actorId);
  }

  async getOrgMembers(
    orgId: string
  ): Promise<Array<{ user: User; role: OrgRole; joined_at: number }>> {
    using orgStub = asDisposable(this.env.ORG.get(this.env.ORG.idFromName(orgId)));
    const members = await orgStub.getMembers();

    const result: Array<{ user: User; role: OrgRole; joined_at: number }> = [];
    for (const m of members) {
      const user = await this.getUserById(m.user_id);
      if (user) {
        result.push({
          user: {
            id: user.id,
            email: user.email,
            name: user.name,
            created_at: user.created_at,
            is_superuser: user.is_superuser,
            avatar: {
              color: user.avatar_color,
              content: user.avatar_content,
            },
            is_orphaned: user.is_orphaned,
          },
          role: m.role,
          joined_at: m.joined_at,
        });
      }
    }

    return result;
  }

  async isOrgMember(userId: string, orgId: string): Promise<boolean> {
    using stub = asDisposable(this.env.ORG.get(this.env.ORG.idFromName(orgId)));
    const info = await stub.getInfo();
    if (!info || info.archived) return false;
    return stub.isMember(userId);
  }

  async isOrgAdmin(userId: string, orgId: string): Promise<boolean> {
    using stub = asDisposable(this.env.ORG.get(this.env.ORG.idFromName(orgId)));
    const info = await stub.getInfo();
    if (!info || info.archived) return false;
    return stub.isAdmin(userId);
  }

  async removeOrgMember(orgId: string, userId: string, actorId: string): Promise<void> {
    using orgStub = asDisposable(this.env.ORG.get(this.env.ORG.idFromName(orgId)));
    const member = await orgStub.getMember(userId);
    if (member?.role === 'owner') {
      throw new Error('Cannot remove organization owner');
    }
    await orgStub.removeMember(userId, actorId);

    using userStub = asDisposable(this.env.USER.get(this.env.USER.idFromName(userId)));
    await userStub.removeOrg(orgId);

    const remaining = await userStub.getOrgs();
    if (remaining.length === 0) {
      await userStub.setOrphaned(true);
    }
  }

  async tryRemoveOrgMember(
    orgId: string,
    userId: string,
    actorId: string
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      await this.removeOrgMember(orgId, userId, actorId);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async updateOrgMemberRole(orgId: string, userId: string, role: OrgRole, actorId: string): Promise<void> {
    if (role === 'owner') {
      throw new Error('Use transferOwnership to assign owner role');
    }
    using orgStub = asDisposable(this.env.ORG.get(this.env.ORG.idFromName(orgId)));
    const existing = await orgStub.getMember(userId);
    if (existing?.role === 'owner') {
      throw new Error('Cannot change the owner role. Transfer ownership first.');
    }
    await orgStub.updateMemberRole(userId, role, actorId);

    using userStub = asDisposable(this.env.USER.get(this.env.USER.idFromName(userId)));
    await userStub.updateOrgRole(orgId, role);
  }

  async tryUpdateOrgMemberRole(
    orgId: string,
    userId: string,
    role: OrgRole,
    actorId: string
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      await this.updateOrgMemberRole(orgId, userId, role, actorId);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  // Invitation functions
  async createInvitation(
    orgId: string,
    email: string,
    role: OrgRole,
    invitedBy: string
  ): Promise<{ id: string; expires_at: number }> {
    if (role === 'owner') {
      throw new Error('Cannot invite as owner');
    }
    using stub = asDisposable(this.env.ORG.get(this.env.ORG.idFromName(orgId)));
    const invitation = await stub.createInvitation(email, role, invitedBy);
    return { id: invitation.id, expires_at: invitation.expires_at };
  }

  async getInvitation(
    orgId: string,
    invitationId: string
  ): Promise<{ id: string; email: string; role: OrgRole; org: Organization } | null> {
    using orgStub = asDisposable(this.env.ORG.get(this.env.ORG.idFromName(orgId)));
    const invitation = await orgStub.getInvitation(invitationId);
    if (!invitation) return null;

    const orgInfo = await orgStub.getInfo();
    if (!orgInfo) return null;

    return {
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      org: {
        id: orgInfo.id,
        name: orgInfo.name,
        created_at: orgInfo.created_at,
        created_by: orgInfo.created_by,
        billing_status: orgInfo.billing_status,
        archived: orgInfo.archived,
        archived_at: orgInfo.archived_at,
        archived_by: orgInfo.archived_by,
      },
    };
  }

  async acceptInvitation(orgId: string, invitationId: string, userId: string): Promise<boolean> {
    using orgStub = asDisposable(this.env.ORG.get(this.env.ORG.idFromName(orgId)));
    const invitation = await orgStub.getInvitation(invitationId);
    if (!invitation) return false;

    const accepted = await orgStub.acceptInvitation(invitationId, userId);
    if (!accepted) return false;

    const workspaces = await this.listOrgWorkspaces(orgId);
    const lastWorkspaceId = workspaces[0]?.id ?? null;
    using userStub = asDisposable(this.env.USER.get(this.env.USER.idFromName(userId)));
    await userStub.addOrg(orgId, invitation.role, lastWorkspaceId);
    await userStub.setOrphaned(false);

    return true;
  }

  async getOrgInvitations(orgId: string): Promise<Array<{
    id: string;
    email: string;
    role: OrgRole;
    created_at: number;
    expires_at: number;
  }>> {
    using stub = asDisposable(this.env.ORG.get(this.env.ORG.idFromName(orgId)));
    const invitations = await stub.getInvitations();
    const now = Date.now();
    return invitations.filter((inv) => inv.expires_at > now).map((inv) => ({
      id: inv.id,
      email: inv.email,
      role: inv.role,
      created_at: inv.created_at,
      expires_at: inv.expires_at,
    }));
  }

  async deleteInvitation(orgId: string, invitationId: string): Promise<void> {
    using stub = asDisposable(this.env.ORG.get(this.env.ORG.idFromName(orgId)));
    await stub.deleteInvitation(invitationId);
  }

  // Workspace functions
  async createWorkspace(
    orgId: string,
    name: string,
    createdBy: string,
    description?: string | null
  ): Promise<Workspace> {
    const workspaceId = crypto.randomUUID();
    using workspaceStub = asDisposable(this.env.WORKSPACE.get(this.env.WORKSPACE.idFromName(workspaceId)));
    const info = await workspaceStub.createWorkspace(workspaceId, orgId, name, createdBy, description ?? null);

    using orgStub = asDisposable(this.env.ORG.get(this.env.ORG.idFromName(orgId)));
    await orgStub.addWorkspace(workspaceId, info.name, info.created_at, createdBy);

    return this.toWorkspace(info);
  }

  async getWorkspace(workspaceId: string): Promise<Workspace | null> {
    const info = await this.getWorkspaceInfo(workspaceId);
    if (!info) return null;
    return this.toWorkspace(info);
  }

  async updateWorkspace(
    workspaceId: string,
    updates: {
      name?: string;
      description?: string | null;
      avatar?: { color: string; content: string };
    },
    actorId: string
  ): Promise<Workspace | null> {
    using workspaceStub = asDisposable(this.env.WORKSPACE.get(this.env.WORKSPACE.idFromName(workspaceId)));
    const info = await workspaceStub.updateWorkspace(
      {
        name: updates.name,
        description: updates.description,
        avatar_color: updates.avatar?.color,
        avatar_content: updates.avatar?.content,
      },
      actorId
    );
    if (!info) return null;

    using orgStub = asDisposable(this.env.ORG.get(this.env.ORG.idFromName(info.org_id)));
    await orgStub.addWorkspace(workspaceId, info.name, info.created_at, actorId);

    return this.toWorkspace(info);
  }

  async archiveWorkspace(workspaceId: string, actorId: string): Promise<Workspace | null> {
    using workspaceStub = asDisposable(this.env.WORKSPACE.get(this.env.WORKSPACE.idFromName(workspaceId)));
    const info = await workspaceStub.getInfo();
    if (!info) return null;

    using orgStub = asDisposable(this.env.ORG.get(this.env.ORG.idFromName(info.org_id)));
    const orgWorkspaces = await orgStub.getWorkspaces();
    const activeWorkspaces = orgWorkspaces.filter((entry) => !entry.archived);
    const isActiveTarget = activeWorkspaces.some((entry) => entry.id === workspaceId);
    if (isActiveTarget && activeWorkspaces.length <= 1) {
      throw new Error('Cannot archive the only workspace in an organization');
    }

    const archivedInfo = await workspaceStub.archive(actorId);
    if (!archivedInfo) return null;
    await orgStub.archiveWorkspace(workspaceId);

    const members = await orgStub.getMembers();
    await Promise.all(
      members.map(async (member) => {
        using userStub = asDisposable(this.env.USER.get(this.env.USER.idFromName(member.user_id)));
        const orgs = await userStub.getOrgs();
        const membership = orgs.find((org) => org.org_id === info.org_id);
        if (membership?.last_workspace_id === workspaceId) {
          await userStub.setOrgLastWorkspace(info.org_id, null);
        }
      })
    );

    return this.toWorkspace(archivedInfo);
  }

  async tryArchiveWorkspace(
    workspaceId: string,
    actorId: string
  ): Promise<{ ok: true; workspace: Workspace | null } | { ok: false; error: string }> {
    try {
      const workspace = await this.archiveWorkspace(workspaceId, actorId);
      return { ok: true, workspace };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async listOrgWorkspaces(orgId: string): Promise<Workspace[]> {
    using orgStub = asDisposable(this.env.ORG.get(this.env.ORG.idFromName(orgId)));
    const entries = await orgStub.getWorkspaces();

    const infos = await Promise.all(
      entries.map(async (entry) => {
        using workspaceStub = asDisposable(this.env.WORKSPACE.get(this.env.WORKSPACE.idFromName(entry.id)));
        return workspaceStub.getInfo();
      })
    );

    const workspaces: Workspace[] = [];
    for (const info of infos) {
      if (!info || info.archived || info.org_id !== orgId) continue;
      workspaces.push(this.toWorkspace(info));
    }
    workspaces.sort((a, b) => a.created_at - b.created_at);
    return workspaces;
  }

  async listUserWorkspaces(userId: string, orgId: string): Promise<WorkspaceWithAccess[]> {
    let orgWorkspaces = await this.listOrgWorkspaces(orgId);
    if (orgWorkspaces.length === 0) {
      const fallback = await this.ensureDefaultWorkspace(orgId, userId);
      if (fallback) {
        orgWorkspaces = [fallback];
      }
    }
    const results: WorkspaceWithAccess[] = [];
    for (const workspace of orgWorkspaces) {
      const accessLevel = await this.getWorkspaceAccessLevel(workspace.id, userId);
      if (accessLevel === 'none') continue;
      results.push({ ...workspace, access_level: accessLevel });
    }
    return results;
  }

  async getWorkspaceAccess(workspaceId: string, userId: string): Promise<WorkspaceAccessLevel> {
    return this.getWorkspaceAccessLevel(workspaceId, userId);
  }

  async setWorkspaceAccess(
    workspaceId: string,
    userId: string,
    accessLevel: WorkspaceAccessLevel,
    actorId: string
  ): Promise<void> {
    using workspaceStub = asDisposable(this.env.WORKSPACE.get(this.env.WORKSPACE.idFromName(workspaceId)));
    await workspaceStub.setMemberAccess(userId, accessLevel, actorId);
  }

  async listWorkspaceMembers(workspaceId: string): Promise<WorkspaceMemberRecord[]> {
    using workspaceStub = asDisposable(this.env.WORKSPACE.get(this.env.WORKSPACE.idFromName(workspaceId)));
    return workspaceStub.listMembers();
  }

  async transferOrgOwnership(orgId: string, newOwnerId: string, actorId: string): Promise<void> {
    using orgStub = asDisposable(this.env.ORG.get(this.env.ORG.idFromName(orgId)));
    const members = await orgStub.getMembers();
    const currentOwner = members.find((member) => member.role === 'owner');
    if (!currentOwner) {
      throw new Error('Organization has no owner');
    }

    await orgStub.transferOwnership(actorId, newOwnerId);

    using newOwnerStub = asDisposable(this.env.USER.get(this.env.USER.idFromName(newOwnerId)));
    await newOwnerStub.updateOrgRole(orgId, 'owner');

    using oldOwnerStub = asDisposable(this.env.USER.get(this.env.USER.idFromName(currentOwner.user_id)));
    await oldOwnerStub.updateOrgRole(orgId, 'admin');
  }

  async adminTransferOrgOwnership(orgId: string, newOwnerId: string, actorId: string): Promise<void> {
    using orgStub = asDisposable(this.env.ORG.get(this.env.ORG.idFromName(orgId)));
    const members = await orgStub.getMembers();
    const currentOwner = members.find((member) => member.role === 'owner');
    if (!currentOwner) {
      throw new Error('Organization has no owner');
    }

    await orgStub.adminTransferOwnership(actorId, newOwnerId);

    using newOwnerStub = asDisposable(this.env.USER.get(this.env.USER.idFromName(newOwnerId)));
    await newOwnerStub.updateOrgRole(orgId, 'owner');

    using oldOwnerStub = asDisposable(this.env.USER.get(this.env.USER.idFromName(currentOwner.user_id)));
    await oldOwnerStub.updateOrgRole(orgId, 'admin');
  }

  async adminForceOrphanUser(userId: string, actorId: string): Promise<void> {
    using userStub = asDisposable(this.env.USER.get(this.env.USER.idFromName(userId)));
    const orgs = await userStub.getOrgs();
    if (orgs.length === 0) {
      await userStub.setOrphaned(true);
      return;
    }

    const ownerMemberships = orgs.filter((org) => org.role === 'owner');
    if (ownerMemberships.length > 0) {
      const ownerOrgs = ownerMemberships.map((org) => org.org_id).join(', ');
      throw new Error(`Transfer ownership before orphaning user (owner of: ${ownerOrgs})`);
    }

    for (const org of orgs) {
      using orgStub = asDisposable(this.env.ORG.get(this.env.ORG.idFromName(org.org_id)));
      await orgStub.removeMember(userId, actorId);
      await userStub.removeOrg(org.org_id);
    }

    await userStub.setOrphaned(true);
  }

  async adminAddOrgMember(
    orgId: string,
    userId: string,
    role: 'admin' | 'member',
    actorId: string
  ): Promise<void> {
    // Validate user exists before adding membership
    const user = await this.getUserById(userId);
    if (!user) {
      throw new Error('User not found');
    }

    // Add user to org
    using orgStub = asDisposable(this.env.ORG.get(this.env.ORG.idFromName(orgId)));
    await orgStub.addMember(userId, role, actorId);

    // Get first workspace to set as lastWorkspaceId
    const workspaces = await orgStub.getWorkspaces();
    const firstWorkspace = workspaces[0] ?? null;

    // Add org to user
    using userStub = asDisposable(this.env.USER.get(this.env.USER.idFromName(userId)));
    await userStub.addOrg(orgId, role, firstWorkspace?.id ?? null);

    // Clear orphaned status if set
    await userStub.setOrphaned(false);
  }

  async archiveOrg(orgId: string, actorId: string): Promise<void> {
    using orgStub = asDisposable(this.env.ORG.get(this.env.ORG.idFromName(orgId)));
    const members = await orgStub.getMembers();
    const nonOwners = members.filter((member) => member.role !== 'owner');
    await orgStub.archiveOrg(actorId);

    const workspaces = await orgStub.getWorkspaces();
    await Promise.all(
      workspaces.map(async (workspace) => {
        using workspaceStub = asDisposable(
          this.env.WORKSPACE.get(this.env.WORKSPACE.idFromName(workspace.id))
        );
        await workspaceStub.archive(actorId);
        await orgStub.archiveWorkspace(workspace.id);
      })
    );

    await Promise.all(
      members.map(async (member) => {
        using userStub = asDisposable(this.env.USER.get(this.env.USER.idFromName(member.user_id)));
        await userStub.removeOrg(orgId);
        const remaining = await userStub.getOrgs();
        if (remaining.length === 0) {
          await userStub.setOrphaned(true);
        }
      })
    );

    await Promise.all(
      nonOwners.map((member) => orgStub.removeMember(member.user_id, actorId))
    );
  }

  async checkUserOrphaned(userId: string): Promise<boolean> {
    using userStub = asDisposable(this.env.USER.get(this.env.USER.idFromName(userId)));
    const profile = await userStub.getProfile();
    if (!profile) return false;

    const orgs = await userStub.getOrgs();
    const hasMemberships = orgs.length > 0;
    if (!hasMemberships && !profile.is_orphaned) {
      await userStub.setOrphaned(true);
      return true;
    }
    if (hasMemberships && profile.is_orphaned) {
      await userStub.setOrphaned(false);
      return false;
    }
    return profile.is_orphaned;
  }

  async handleOrphanedUserLogin(userId: string): Promise<{
    org: Organization;
    workspace: WorkspaceWithAccess;
  } | null> {
    using userStub = asDisposable(this.env.USER.get(this.env.USER.idFromName(userId)));
    const profile = await userStub.getProfile();
    if (!profile?.is_orphaned) return null;

    const baseName = profile.name?.trim() || 'My';
    const orgName = `${baseName}'s Organization`;
    const org = await this.createOrg(orgName, userId);

    const workspaces = await this.listUserWorkspaces(userId, org.id);
    const workspace = workspaces[0];
    if (!workspace) {
      throw new Error('Failed to create default workspace');
    }

    await userStub.setOrphaned(false);

    return { org, workspace };
  }

  async getOrgAuditLog(orgId: string, limit = 100, offset = 0): Promise<AuditLogEntry[]> {
    using orgStub = asDisposable(this.env.ORG.get(this.env.ORG.idFromName(orgId)));
    const entries = await orgStub.getAuditLog(limit, offset);
    return entries.map((entry) => ({
      id: entry.id,
      action: entry.action,
      actor_id: entry.actor_id,
      target_id: entry.target_id,
      details: entry.details ? JSON.parse(entry.details) : null,
      created_at: entry.created_at,
    }));
  }

  async getWorkspaceAuditLog(workspaceId: string, limit = 100, offset = 0): Promise<AuditLogEntry[]> {
    using workspaceStub = asDisposable(this.env.WORKSPACE.get(this.env.WORKSPACE.idFromName(workspaceId)));
    const entries = await workspaceStub.getAuditLog(limit, offset);
    return entries.map((entry) => ({
      id: entry.id,
      action: entry.action,
      actor_id: entry.actor_id,
      target_id: entry.target_id,
      details: entry.details ? JSON.parse(entry.details) : null,
      created_at: entry.created_at,
    }));
  }

  // Worker script registry functions
  async registerWorkerScript(
    orgId: string,
    scriptName: string,
    workspaceId: string,
    userId: string
  ): Promise<WorkerScript> {
    using orgStub = asDisposable(this.env.ORG.get(this.env.ORG.idFromName(orgId)));
    const script = await orgStub.registerWorkerScript(scriptName, workspaceId, userId);
    // Update global script→org index for dispatcher lookups (denormalized for fast access)
    await this.env.API_TOKENS.put(
      `script_org:${scriptName}`,
      JSON.stringify({ org_id: orgId, is_public: script.is_public })
    );
    return script;
  }

  async getWorkerScript(orgId: string, scriptName: string): Promise<WorkerScript | null> {
    using orgStub = asDisposable(this.env.ORG.get(this.env.ORG.idFromName(orgId)));
    return orgStub.getWorkerScript(scriptName);
  }

  async listWorkerScripts(orgId: string): Promise<WorkerScript[]> {
    using orgStub = asDisposable(this.env.ORG.get(this.env.ORG.idFromName(orgId)));
    return orgStub.listWorkerScripts();
  }

  async listWorkerScriptsByWorkspace(workspaceId: string): Promise<WorkerScript[]> {
    const info = await this.requireWorkspaceInfo(workspaceId);
    using orgStub = asDisposable(this.env.ORG.get(this.env.ORG.idFromName(info.org_id)));
    return orgStub.listWorkerScriptsByWorkspace(workspaceId);
  }

  async deleteWorkerScript(orgId: string, scriptName: string, actorId: string): Promise<boolean> {
    using orgStub = asDisposable(this.env.ORG.get(this.env.ORG.idFromName(orgId)));
    const result = await orgStub.deleteWorkerScript(scriptName, actorId);
    if (result) {
      // Remove from global script→org index
      await this.env.API_TOKENS.delete(`script_org:${scriptName}`);
    }
    return result;
  }

  async setWorkerScriptPublic(
    orgId: string,
    scriptName: string,
    isPublic: boolean,
    actorId: string
  ): Promise<WorkerScript | null> {
    using orgStub = asDisposable(this.env.ORG.get(this.env.ORG.idFromName(orgId)));
    const script = await orgStub.setWorkerScriptPublic(scriptName, isPublic, actorId);
    if (script) {
      // Update the denormalized KV index
      await this.env.API_TOKENS.put(
        `script_org:${scriptName}`,
        JSON.stringify({ org_id: orgId, is_public: script.is_public })
      );
    }
    return script;
  }

  async updateWorkerScriptPreview(
    orgId: string,
    scriptName: string,
    input: WorkerScriptPreviewUpdateInput
  ): Promise<WorkerScriptPreviewUpdateResult> {
    using orgStub = asDisposable(this.env.ORG.get(this.env.ORG.idFromName(orgId)));
    return orgStub.updateWorkerScriptPreview(scriptName, input);
  }

  /**
   * Get worker access info by script name (searches global index).
   * Used by the dispatcher to check if a worker is public/private and get its org.
   * This uses only KV lookup (no DO query) for fast access on every request.
   */
  async getWorkerAccessInfo(scriptName: string): Promise<WorkerScriptAccess | null> {
    // Look up from denormalized global index (single KV read, no DO query)
    const data = await this.env.API_TOKENS.get(`script_org:${scriptName}`);
    if (!data) return null;

    const { org_id, is_public } = JSON.parse(data) as { org_id: string; is_public: boolean };
    return {
      script_name: scriptName,
      workspace_id: '', // Not needed for access check, avoids DO lookup
      org_id,
      is_public,
    };
  }

  /**
   * Update the global script→org index.
   * Called after registerWorkerScript to maintain the index.
   */
  async updateWorkerScriptIndex(scriptName: string, orgId: string, isPublic: boolean = false): Promise<void> {
    await this.env.API_TOKENS.put(
      `script_org:${scriptName}`,
      JSON.stringify({ org_id: orgId, is_public: isPublic })
    );
  }

  // Worker cross-domain auth functions
  async createWorkerAuthStateRpc(
    returnUrl: string,
    scriptName: string,
    requiredOrgId: string
  ): Promise<string> {
    return createAuthState(this.env.API_TOKENS, {
      return_url: returnUrl,
      script_name: scriptName,
      required_org_id: requiredOrgId,
    });
  }

  async validateAndConsumeAuthStateRpc(state: string): Promise<WorkerAuthState | null> {
    return validateAndConsumeAuthState(this.env.API_TOKENS, state);
  }

  async createWorkerAuthTokenRpc(
    userId: string,
    orgId: string,
    state: string,
    scriptName: string
  ): Promise<string> {
    return createWorkerAuthToken(this.env.API_TOKENS, {
      user_id: userId,
      org_id: orgId,
      state,
      script_name: scriptName,
    });
  }

  async validateAndConsumeAuthTokenRpc(token: string): Promise<WorkerAuthToken | null> {
    return validateAndConsumeAuthToken(this.env.API_TOKENS, token);
  }

  async createDispatcherSessionRpc(
    userId: string,
    orgId: string
  ): Promise<{ sessionId: string; session: DispatcherSession }> {
    return createDispatcherSession(this.env.SESSIONS, userId, orgId);
  }

  async getDispatcherSessionRpc(sessionId: string): Promise<DispatcherSession | null> {
    return getDispatcherSession(this.env.SESSIONS, sessionId);
  }

  async touchDispatcherSessionRpc(sessionId: string): Promise<DispatcherSession | null> {
    return touchDispatcherSession(this.env.SESSIONS, sessionId);
  }

  async destroyDispatcherSessionRpc(sessionId: string): Promise<void> {
    return destroyDispatcherSession(this.env.SESSIONS, sessionId);
  }

  // Chat functions - threads are stored in OrgDO with workspace_id for filtering

  private toThread(orgThread: OrgThread): Thread {
    return {
      id: orgThread.id,
      workspace_id: orgThread.workspace_id,
      title: orgThread.title,
      created_by: orgThread.created_by,
      created_at: orgThread.created_at,
      updated_at: orgThread.updated_at,
    };
  }

  async getThreads(workspaceId: string): Promise<Thread[]> {
    const info = await this.requireWorkspaceInfo(workspaceId);
    using orgStub = asDisposable(getOrgStub(this.env, info.org_id));
    const threads = await orgStub.getThreadsByWorkspace(workspaceId);
    return threads.map((t) => this.toThread(t));
  }

  async getThreadsPaginated(
    workspaceId: string,
    params: PaginationParams = {}
  ): Promise<PaginatedResult<Thread>> {
    const offset = params.offset ?? 0;
    const limit = params.limit ?? 50;
    const info = await this.requireWorkspaceInfo(workspaceId);
    using orgStub = asDisposable(getOrgStub(this.env, info.org_id));
    const result = await orgStub.getThreadsPaginated(offset, limit, workspaceId);
    return {
      items: result.items.map((t) => this.toThread(t)),
      total: result.total,
      offset: result.offset,
      limit: result.limit,
    };
  }

  async getThreadsAllWorkspaces(
    workspaceIds: string[],
    params: PaginationParams = {}
  ): Promise<PaginatedResult<Thread>> {
    const offset = params.offset ?? 0;
    const limit = params.limit ?? 50;
    if (workspaceIds.length === 0) {
      return {
        items: [],
        total: 0,
        offset,
        limit,
      };
    }
    const info = await this.requireWorkspaceInfo(workspaceIds[0]);
    using orgStub = asDisposable(getOrgStub(this.env, info.org_id));
    const result = await orgStub.getThreadsAllWorkspacesPaginated(workspaceIds, offset, limit);
    return {
      items: result.items.map((t) => this.toThread(t)),
      total: result.total,
      offset: result.offset,
      limit: result.limit,
    };
  }

  async createThread(
    workspaceId: string,
    title: string | undefined,
    createdBy?: string
  ): Promise<Thread> {
    const info = await this.requireWorkspaceInfo(workspaceId);
    using orgStub = asDisposable(getOrgStub(this.env, info.org_id));
    const thread = await orgStub.createThread(workspaceId, title, createdBy);
    return this.toThread(thread);
  }

  async getThread(id: string, workspaceId: string): Promise<Thread | null> {
    const info = await this.requireWorkspaceInfo(workspaceId);
    using orgStub = asDisposable(getOrgStub(this.env, info.org_id));
    const thread = await orgStub.getThread(id);
    if (!thread) return null;
    // Verify the thread belongs to this workspace
    if (thread.workspace_id !== workspaceId) return null;
    return this.toThread(thread);
  }

  async updateThread(id: string, title: string, workspaceId: string): Promise<Thread | null> {
    const info = await this.requireWorkspaceInfo(workspaceId);
    using orgStub = asDisposable(getOrgStub(this.env, info.org_id));
    // Verify the thread belongs to this workspace first
    const existing = await orgStub.getThread(id);
    if (!existing || existing.workspace_id !== workspaceId) return null;
    const thread = await orgStub.updateThread(id, title);
    if (!thread) return null;
    return this.toThread(thread);
  }

  async deleteThread(id: string, workspaceId: string): Promise<void> {
    // Messages are stored in container JSONL, not in the DO
    // Just delete from the index
    const info = await this.requireWorkspaceInfo(workspaceId);
    using orgStub = asDisposable(getOrgStub(this.env, info.org_id));
    // Verify the thread belongs to this workspace first
    const existing = await orgStub.getThread(id);
    if (!existing || existing.workspace_id !== workspaceId) return;
    await orgStub.deleteThread(id);
  }

  async generateAndUpdateThreadTitle(
    threadId: string,
    workspaceId: string,
    message: string
  ): Promise<void> {
    try {
      const response = await this.env.AI.run('@cf/google/gemma-3-12b-it', {
        messages: [
          { role: 'system', content: 'Summarize the message into a simple chat thread topic title. Respond with only the title, no quotes or extra punctuation.' },
          { role: 'user', content: message },
        ],
        temperature: 1,
        max_tokens: 50,
      });

      const title = (response as { response?: string })?.response?.trim()?.slice(0, 100);
      if (!title) return;

      // Update title in OrgDO
      const info = await this.requireWorkspaceInfo(workspaceId);
        using orgStub = asDisposable(getOrgStub(this.env, info.org_id));
      await orgStub.updateThread(threadId, title);

      // Broadcast via ChatThreadDO
      const threadStub = this.env.CHAT_THREAD.get(this.env.CHAT_THREAD.idFromName(threadId));
      await threadStub.setTitle(title);
    } catch (e) {
      console.error('[generateAndUpdateThreadTitle] Error:', e);
    }
  }

  async getMessages(threadId: string, workspaceId: string): Promise<Message[]> {
    // Messages are read from container's Claude JSONL file
    // threadId is the Claude session_id
    try {
      const info = await this.requireWorkspaceInfo(workspaceId);
      const container = getWorkspaceContainer(this.env, workspaceId);

      // Ensure container is running (R2 sync happens in entrypoint)
      await container.startForWorkspace(workspaceId, info.org_id);

      // Claude stores conversations at ~/.claude/projects/{project-path}/{session_id}.jsonl
      const jsonlPath = `/home/claude/.claude/projects/-home-claude/${threadId}.jsonl`;

      // Check if file exists
      const exists = await container.exists(jsonlPath);
      if (!exists.exists) {
        return [];
      }

      // Read the JSONL file
      const file = await container.readFile(jsonlPath);
      if (!file.success || !file.content?.trim()) {
        return [];
      }

      const lines = file.content.split('\n').filter((line: string) => line.trim());
      const messages: Message[] = [];

      const hasTextBlocks = (content: unknown) =>
        Array.isArray(content) && content.some(block => block?.type === 'text' && block.text);

      const mergeContentBlocks = (existing: unknown, incoming: unknown): unknown => {
        if (!Array.isArray(existing) || !Array.isArray(incoming)) return incoming;

        const incomingHasText = hasTextBlocks(incoming);
        if (!incomingHasText) {
          const merged = [...existing];
          const existingKeys = new Map<string, number>();
          existing.forEach((block, index) => {
            const key = block?.type === 'tool_use'
              ? `tool_use:${block.id || block.name || index}`
              : `${block?.type}:${index}`;
            existingKeys.set(key, index);
          });
          incoming.forEach((block, index) => {
            const key = block?.type === 'tool_use'
              ? `tool_use:${block.id || block.name || index}`
              : `${block?.type}:${index}`;
            const existingIndex = existingKeys.get(key);
            if (existingIndex === undefined) {
              merged.push(block);
            } else {
              merged[existingIndex] = block;
            }
          });
          return merged;
        }

        const toolResults = existing.filter(block => block?.type === 'tool_result');
        if (toolResults.length === 0) return incoming;
        return [...toolResults, ...incoming];
      };

      let assistantSegments: Array<{ id: string; content: Message['content']; createdAt: number }> = [];
      let assistantGroupId: string | null = null;
      let assistantGroupCreatedAt: number | null = null;

      const flushAssistantGroup = () => {
        if (assistantSegments.length === 0) return;
        const content = assistantSegments.flatMap(segment =>
          Array.isArray(segment.content) ? segment.content : []
        );
        const id = assistantGroupId || assistantSegments[0]?.id || `assistant_${messages.length}`;
        const createdAt = assistantGroupCreatedAt || assistantSegments[0]?.createdAt || Date.now();
        messages.push({
          id,
          thread_id: threadId,
          role: 'assistant',
          content,
          created_at: createdAt,
        });
        assistantSegments = [];
        assistantGroupId = null;
        assistantGroupCreatedAt = null;
      };

      const upsertAssistantSegment = (id: string, content: Message['content'], createdAt: number) => {
        if (!assistantGroupId) {
          assistantGroupId = id;
          assistantGroupCreatedAt = createdAt;
        }
        const lastSegment = assistantSegments[assistantSegments.length - 1];
        if (lastSegment && lastSegment.id === id) {
          lastSegment.content = mergeContentBlocks(lastSegment.content, content) as Message['content'];
          return;
        }
        assistantSegments.push({ id, content, createdAt });
      };

      const appendToolResult = (content: Message['content'], createdAt: number) => {
        if (assistantSegments.length === 0) {
          const id = `tool_result_${messages.length}`;
          upsertAssistantSegment(id, content, createdAt);
          return;
        }
        const lastSegment = assistantSegments[assistantSegments.length - 1];
        const existingBlocks = Array.isArray(lastSegment.content) ? lastSegment.content : [];
        const incomingBlocks = Array.isArray(content) ? content : [];
        lastSegment.content = [...existingBlocks, ...incomingBlocks];
      };

      for (const line of lines) {
        try {
          const event = JSON.parse(line);

          if (event.type === 'user' && event.message?.content) {
            const firstContent = event.message.content[0];
            const isMeta = Boolean(
              event.isMeta ??
              event.is_meta ??
              event.message?.isMeta ??
              event.message?.is_meta
            );
            const sourceToolUseID = (
              event.sourceToolUseID ??
              event.sourceToolUseId ??
              event.source_tool_use_id ??
              event.parent_tool_use_id ??
              event.message?.sourceToolUseID ??
              event.message?.sourceToolUseId ??
              event.message?.source_tool_use_id ??
              event.message?.parent_tool_use_id
            );
            const resolvedToolUseId = typeof sourceToolUseID === 'string' ? sourceToolUseID : undefined;

            if (firstContent?.type === 'tool_result') {
              const createdAt = event.timestamp ? new Date(event.timestamp).getTime() : Date.now();
              appendToolResult(event.message.content, createdAt);
            } else if (isMeta || resolvedToolUseId) {
              const createdAt = event.timestamp ? new Date(event.timestamp).getTime() : Date.now();
              const id = event.uuid || `meta_${resolvedToolUseId || messages.length}`;
              messages.push({
                id,
                thread_id: threadId,
                role: 'user',
                content: event.message.content,
                created_at: createdAt,
                isMeta: true,
                sourceToolUseID: resolvedToolUseId,
              });
            } else {
              flushAssistantGroup();
              const id = event.uuid || `user_${messages.length}`;
              messages.push({
                id,
                thread_id: threadId,
                role: 'user',
                content: event.message.content,
                created_at: event.timestamp ? new Date(event.timestamp).getTime() : Date.now(),
              });
            }
            continue;
          }

          if (event.type === 'assistant' && event.message?.content?.length > 0) {
            const id = event.message?.id || event.uuid || `assistant_${messages.length}`;
            upsertAssistantSegment(
              id,
              event.message.content,
              event.timestamp ? new Date(event.timestamp).getTime() : Date.now()
            );
          }
        } catch {
          // Skip malformed lines
        }
      }

      flushAssistantGroup();
      return messages;
    } catch (e) {
      // Container may not be running - return empty
      console.error('[getMessages] Error:', e);
      return [];
    }
  }

  async listWorkspaceFiles(workspaceId: string): Promise<SandboxFileListing> {
    const info = await this.requireWorkspaceInfo(workspaceId);
    const container = getWorkspaceContainer(this.env, workspaceId);
    const workspaceRoot = this.getWorkspaceRoot();
    await container.startForWorkspace(workspaceId, info.org_id);

    const listing = await container.listFiles(workspaceRoot, {
      recursive: true,
      includeHidden: true,
    });
    const files = [...listing.files].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    return {
      path: listing.path,
      files,
      count: listing.count,
      timestamp: listing.timestamp || new Date().toISOString(),
    };
  }

  async listWorkspaceEntries(
    workspaceId: string,
    options: WorkspaceListOptions = {}
  ): Promise<WorkspaceListResponse> {
    const info = await this.requireWorkspaceInfo(workspaceId);
    const container = getWorkspaceContainer(this.env, workspaceId);
    const workspaceRoot = this.getWorkspaceRoot();
    await container.startForWorkspace(workspaceId, info.org_id);

    const workspacePath = normalizeWorkspacePath(options.path);
    const listPath = resolveWorkspacePath(workspaceRoot, workspacePath);
    const recursive = options.recursive ?? false;
    const includeHidden = options.includeHidden ?? true;

    const listing = await container.listFiles(listPath, { recursive, includeHidden });
    const entries: WorkspaceFileEntry[] = [];

    for (const file of listing.files) {
      if (!file.relativePath || file.relativePath === '.') continue;
      entries.push({
        path: joinWorkspacePath(workspacePath, file.relativePath),
        name: file.name,
        type: file.type,
        size: file.size,
        modifiedAt: file.modifiedAt,
      });
    }

    entries.sort((a, b) => a.path.localeCompare(b.path));

    return {
      path: workspacePath,
      entries,
      count: entries.length,
      timestamp: listing.timestamp || new Date().toISOString(),
      recursive,
    };
  }

  async readWorkspaceFile(workspaceId: string, path: string) {
    const info = await this.requireWorkspaceInfo(workspaceId);
    const container = getWorkspaceContainer(this.env, workspaceId);
    const workspaceRoot = this.getWorkspaceRoot();
    await container.startForWorkspace(workspaceId, info.org_id);

    const workspacePath = normalizeWorkspacePath(path);
    const absolutePath = resolveWorkspacePath(workspaceRoot, workspacePath);
    const exists = await container.exists(absolutePath);
    if (!exists.exists) return null;

    const result = await container.readFile(absolutePath);
    if (!result.success) {
      throw new Error(`Failed to read ${workspacePath}`);
    }
    return { workspacePath, result };
  }

  async writeWorkspaceFile(workspaceId: string, path: string, content: string) {
    const info = await this.requireWorkspaceInfo(workspaceId);
    const container = getWorkspaceContainer(this.env, workspaceId);
    const workspaceRoot = this.getWorkspaceRoot();
    await container.startForWorkspace(workspaceId, info.org_id);

    const workspacePath = normalizeWorkspacePath(path);
    const absolutePath = resolveWorkspacePath(workspaceRoot, workspacePath);
    const result = await container.writeFile(absolutePath, content);
    if (!result.success) {
      throw new Error(`Failed to write ${workspacePath}`);
    }
    this.scheduleWorkspaceUpload(workspaceId);
    return { workspacePath, result };
  }

  async mkdirWorkspacePath(workspaceId: string, path: string) {
    const info = await this.requireWorkspaceInfo(workspaceId);
    const container = getWorkspaceContainer(this.env, workspaceId);
    const workspaceRoot = this.getWorkspaceRoot();
    await container.startForWorkspace(workspaceId, info.org_id);

    const workspacePath = normalizeWorkspacePath(path);
    const absolutePath = resolveWorkspacePath(workspaceRoot, workspacePath);
    const result = await container.mkdir(absolutePath, { recursive: true });
    if (!result.success) {
      throw new Error(`Failed to create directory ${workspacePath}`);
    }
    this.scheduleWorkspaceUpload(workspaceId);
    return { workspacePath, result };
  }

  async createWorkspaceFile(workspaceId: string, path: string, content = '') {
    const info = await this.requireWorkspaceInfo(workspaceId);
    const container = getWorkspaceContainer(this.env, workspaceId);
    const workspaceRoot = this.getWorkspaceRoot();
    await container.startForWorkspace(workspaceId, info.org_id);

    const workspacePath = normalizeWorkspacePath(path);
    const absolutePath = resolveWorkspacePath(workspaceRoot, workspacePath);
    const exists = await container.exists(absolutePath);
    if (exists.exists) {
      throw new Error('Workspace path already exists');
    }

    const result = await container.writeFile(absolutePath, content);
    if (!result.success) {
      throw new Error(`Failed to write ${workspacePath}`);
    }
    this.scheduleWorkspaceUpload(workspaceId);
    return { workspacePath, result };
  }

  async moveWorkspacePath(workspaceId: string, from: string, to: string) {
    const info = await this.requireWorkspaceInfo(workspaceId);
    const container = getWorkspaceContainer(this.env, workspaceId);
    const workspaceRoot = this.getWorkspaceRoot();
    await container.startForWorkspace(workspaceId, info.org_id);

    const fromPath = normalizeWorkspacePath(from);
    const toPath = normalizeWorkspacePath(to);
    const sourcePath = resolveWorkspacePath(workspaceRoot, fromPath);
    const destinationPath = resolveWorkspacePath(workspaceRoot, toPath);
    const result = await container.moveFile(sourcePath, destinationPath);
    if (!result.success) {
      throw new Error(`Failed to move ${fromPath} to ${toPath}`);
    }
    this.scheduleWorkspaceUpload(workspaceId);
    return { fromPath, toPath, result };
  }

  async deleteWorkspacePath(workspaceId: string, path: string) {
    const info = await this.requireWorkspaceInfo(workspaceId);
    const container = getWorkspaceContainer(this.env, workspaceId);
    const workspaceRoot = this.getWorkspaceRoot();
    await container.startForWorkspace(workspaceId, info.org_id);

    const workspacePath = normalizeWorkspacePath(path);
    if (workspacePath === '/') {
      throw new Error('Refusing to delete workspace root');
    }
    const absolutePath = resolveWorkspacePath(workspaceRoot, workspacePath);
    const result = await container.deleteFile(absolutePath);
    if (!result.success) {
      throw new Error(`Failed to delete ${workspacePath}`);
    }
    this.scheduleWorkspaceUpload(workspaceId);
    return { workspacePath, result };
  }

  // Preview functions (ChatThreadDO)
  async setThreadPreview(threadId: string, workers: string[]): Promise<string[]> {
    using stub = asDisposable(this.env.CHAT_THREAD.get(this.env.CHAT_THREAD.idFromName(threadId)));
    const response = await stub.fetch(new Request('http://internal/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workers }),
    }));
    const data = await response.json() as { workers: string[] };
    return data.workers;
  }

  async getThreadPreview(threadId: string): Promise<string[]> {
    using stub = asDisposable(this.env.CHAT_THREAD.get(this.env.CHAT_THREAD.idFromName(threadId)));
    const response = await stub.fetch(new Request('http://internal/preview', {
      method: 'GET',
    }));
    const data = await response.json() as { workers: string[] };
    return data.workers;
  }

  // Integration functions
  private recordToIntegration(record: WorkspaceIntegrationRecord): Integration {
    return {
      id: record.id,
      integration_type: record.integration_type,
      name: record.name,
      category: record.category as Integration['category'],
      auth_method: record.auth_method as Integration['auth_method'],
      config: JSON.parse(record.config),
      enabled: record.enabled === 1,
      created_by: record.created_by,
      created_at: record.created_at,
      updated_at: record.updated_at,
      has_credentials: record.credentials_encrypted.length > 0,
    };
  }

  async getWorkspaceIntegrations(workspaceId: string): Promise<Integration[]> {
    using stub = asDisposable(this.env.WORKSPACE.get(this.env.WORKSPACE.idFromName(workspaceId)));
    const records = await stub.getIntegrations();
    return records.map((r) => this.recordToIntegration(r));
  }

  async getWorkspaceIntegration(workspaceId: string, integrationId: string): Promise<Integration | null> {
    using stub = asDisposable(this.env.WORKSPACE.get(this.env.WORKSPACE.idFromName(workspaceId)));
    const record = await stub.getIntegration(integrationId);
    if (!record) return null;
    return this.recordToIntegration(record);
  }

  async createWorkspaceIntegration(
    workspaceId: string,
    userId: string,
    input: CreateIntegrationInput
  ): Promise<Integration> {
    const definition = getIntegrationDefinition(input.integration_type);
    if (!definition) {
      throw new Error(`Unknown integration type: ${input.integration_type}`);
    }

    const id = crypto.randomUUID();
    const encryptedCreds = await encryptCredentials(input.credentials, this.env.INTEGRATION_SECRET_KEY);

    using stub = asDisposable(this.env.WORKSPACE.get(this.env.WORKSPACE.idFromName(workspaceId)));
    await stub.createIntegration(
      id,
      input.integration_type,
      input.name.trim(),
      definition.category,
      definition.authMethod,
      JSON.stringify(input.config),
      encryptedCreds,
      userId
    );

    const record = await stub.getIntegration(id);
    if (!record) {
      throw new Error('Failed to create integration');
    }
    return this.recordToIntegration(record);
  }

  async updateWorkspaceIntegration(
    workspaceId: string,
    integrationId: string,
    actorId: string,
    input: UpdateIntegrationInput
  ): Promise<Integration | null> {
    using stub = asDisposable(this.env.WORKSPACE.get(this.env.WORKSPACE.idFromName(workspaceId)));
    const existing = await stub.getIntegration(integrationId);
    if (!existing) return null;

    const updates: {
      name?: string;
      config?: string;
      credentialsEncrypted?: string;
      enabled?: boolean;
    } = {};

    if (input.name !== undefined) {
      updates.name = input.name;
    }
    if (input.config !== undefined) {
      updates.config = JSON.stringify(input.config);
    }
    if (input.credentials !== undefined) {
      updates.credentialsEncrypted = await encryptCredentials(
        input.credentials,
        this.env.INTEGRATION_SECRET_KEY
      );
    }
    if (input.enabled !== undefined) {
      updates.enabled = input.enabled;
    }

    await stub.updateIntegration(integrationId, updates, actorId);

    const record = await stub.getIntegration(integrationId);
    if (!record) return null;
    return this.recordToIntegration(record);
  }

  async deleteWorkspaceIntegration(workspaceId: string, integrationId: string, actorId: string): Promise<void> {
    using stub = asDisposable(this.env.WORKSPACE.get(this.env.WORKSPACE.idFromName(workspaceId)));
    await stub.deleteIntegration(integrationId, actorId);
  }

  async getWorkspaceIntegrationEnvVars(workspaceId: string): Promise<Record<string, string>> {
    using stub = asDisposable(this.env.WORKSPACE.get(this.env.WORKSPACE.idFromName(workspaceId)));
    const records = await stub.getIntegrations();
    const envVars: Record<string, string> = {};

    for (const record of records) {
      if (record.enabled !== 1) continue;
      const credentials = await decryptCredentials(record.credentials_encrypted, this.env.INTEGRATION_SECRET_KEY);
      const config = JSON.parse(record.config) as Record<string, unknown>;
      Object.assign(envVars, mapCredentialsToEnvVars(record.integration_type, credentials, config));
    }
    return envVars;
  }

  // API Token functions (direct KV access)
  async createOrgApiToken(
    orgId: string,
    userId: string,
    input: CreateApiTokenInput
  ): Promise<{ tokenId: string; tokenData: ApiTokenData }> {
    const scopes = input.scopes || ['proxy'];
    const expiresAt = input.expires_in_days
      ? Date.now() + input.expires_in_days * 24 * 60 * 60 * 1000
      : null;

    return createApiToken(this.env.API_TOKENS, {
      orgId,
      userId,
      name: input.name,
      scopes,
      integrationId: input.integration_id || null,
      expiresAt,
    });
  }

  async validateApiToken(tokenId: string): Promise<ApiTokenData | null> {
    return validateApiTokenKV(this.env.API_TOKENS, tokenId);
  }

  async deleteApiToken(tokenId: string): Promise<void> {
    await deleteApiToken(this.env.API_TOKENS, tokenId);
  }

  async resetWorkspaceContainer(workspaceId: string): Promise<{ success: boolean; containerId: string }> {
    const containerId = getContainerIdForWorkspace(workspaceId);
    using stub = asDisposable(this.env.SANDBOX.get(this.env.SANDBOX.idFromName(containerId)));
    await stub.destroy();
    return { success: true, containerId };
  }

  /**
   * Get enabled integration credentials as ENV vars for an org's default workspace.
   * Called when syncing dispatch script secrets.
   */
  async getOrgIntegrationEnvVars(orgId: string): Promise<Record<string, string>> {
    const workspaces = await this.listOrgWorkspaces(orgId);
    if (workspaces.length === 0) return {};
    return this.getWorkspaceIntegrationEnvVars(workspaces[0].id);
  }

  /**
   * Restart the container for an org.
   * Called when integrations are created/updated/deleted to pick up new credentials.
   * TODO: Implement container restart - currently containers restart on next connection
   */
  async restartOrgContainers(_orgId: string): Promise<{ restarted: number; failed: number }> {
    // With one container per org, we'd need to kill the sandbox process
    // For now, the container will pick up new env vars on next WebSocket connection
    console.log('[RPC] restartOrgContainers not yet implemented for new architecture');
    return { restarted: 0, failed: 0 };
  }
}
