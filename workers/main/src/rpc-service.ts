import { WorkerEntrypoint } from 'cloudflare:workers';
import type { AuthEnv, SessionData, UserProfile, OrgRole } from './auth';
import type { ChatEnv } from './durable-objects';
import { getWorkspaceContainer, getContainerIdForWorkspace, type WorkspaceContainerEnv } from './workspace-container';
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
}

function getIndexStub(env: DoRpcEnv, workspaceId: string) {
  return env.CHAT_INDEX.get(env.CHAT_INDEX.idFromName(workspaceId));
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

  // Session functions
  async getSession(sessionId: string): Promise<SessionData | null> {
    using stub = asDisposable(this.env.SESSION.get(this.env.SESSION.idFromName(sessionId)));
    const session = await stub.getData();
    if (!session) return null;
    if (!session.workspace_id) {
      const fallback = await this.ensureDefaultWorkspace(session.org_id, session.user_id);
      if (fallback) {
        await stub.switchWorkspace(fallback.id);
        session.workspace_id = fallback.id;
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

  async createSession(
    userId: string,
    orgId: string,
    workspaceId: string | null = null
  ): Promise<{ sessionId: string; sessionData: SessionData }> {
    const sessionId = crypto.randomUUID();
    const now = Date.now();
    const expiresAt = now + 30 * 24 * 60 * 60 * 1000;
    let resolvedWorkspaceId = workspaceId;
    if (!resolvedWorkspaceId) {
      const fallback = await this.ensureDefaultWorkspace(orgId, userId);
      resolvedWorkspaceId = fallback?.id ?? null;
    }

    const sessionData: SessionData = {
      user_id: userId,
      org_id: orgId,
      workspace_id: resolvedWorkspaceId,
      created_at: now,
      last_accessed: now,
      expires_at: expiresAt,
    };

    using stub = asDisposable(this.env.SESSION.get(this.env.SESSION.idFromName(sessionId)));
    await stub.setData(sessionData);
    if (resolvedWorkspaceId) {
      using userStub = asDisposable(this.env.USER.get(this.env.USER.idFromName(userId)));
      await userStub.setOrgLastWorkspace(orgId, resolvedWorkspaceId);
    }

    return { sessionId, sessionData };
  }

  async destroySession(sessionId: string): Promise<void> {
    using stub = asDisposable(this.env.SESSION.get(this.env.SESSION.idFromName(sessionId)));
    await stub.destroy();
  }

  async switchSessionOrg(sessionId: string, orgId: string, workspaceId: string | null = null): Promise<void> {
    using stub = asDisposable(this.env.SESSION.get(this.env.SESSION.idFromName(sessionId)));
    const session = await stub.getData();
    let resolvedWorkspaceId = workspaceId;
    if (!resolvedWorkspaceId && session) {
      const fallback = await this.ensureDefaultWorkspace(orgId, session.user_id);
      resolvedWorkspaceId = fallback?.id ?? null;
    }
    await stub.switchOrg(orgId);
    await stub.switchWorkspace(resolvedWorkspaceId);
    if (session?.user_id && resolvedWorkspaceId) {
      using userStub = asDisposable(this.env.USER.get(this.env.USER.idFromName(session.user_id)));
      await userStub.setOrgLastWorkspace(orgId, resolvedWorkspaceId);
    }
  }

  async switchSessionWorkspace(sessionId: string, workspaceId: string | null): Promise<void> {
    using stub = asDisposable(this.env.SESSION.get(this.env.SESSION.idFromName(sessionId)));
    await stub.switchWorkspace(workspaceId);
    const session = await stub.getData();
    if (session?.user_id && session.org_id && workspaceId) {
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

  async createUser(
    email: string,
    password: string,
    name: string | null
  ): Promise<{ userId: string; user: UserProfile }> {
    const userId = crypto.randomUUID();

    using stub = asDisposable(this.env.USER.get(this.env.USER.idFromName(userId)));
    const user = await stub.createUser(userId, email.toLowerCase(), password, name);

    await this.env.EMAIL_TO_USER.put(`email:${email.toLowerCase()}`, userId);

    return { userId, user };
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

    for (const { profile, orgs } of userDataResults) {
      if (!profile) continue;

      for (const org of orgs) {
        orgIds.add(org.org_id);
      }
      totalMemberships += orgs.length;

      users.push({
        id: profile.id,
        email: profile.email,
        name: profile.name,
        created_at: profile.created_at,
        is_superuser: profile.is_superuser,
        org_count: orgs.length,
      });
    }

    users.sort((a, b) => b.created_at - a.created_at);

    return {
      users,
      total_users: users.length,
      total_orgs: orgIds.size,
      total_memberships: totalMemberships,
    };
  }

  // Admin: Update user profile (name, is_superuser)
  async adminUpdateUser(
    userId: string,
    updates: { name?: string; is_superuser?: boolean }
  ): Promise<UserProfile | null> {
    using stub = asDisposable(this.env.USER.get(this.env.USER.idFromName(userId)));
    const profile = await stub.getProfile();
    if (!profile) return null;

    if (updates.name !== undefined) {
      profile.name = updates.name;
    }
    if (updates.is_superuser !== undefined) {
      profile.is_superuser = updates.is_superuser;
    }
    await stub.setProfile(profile);
    return profile;
  }

  // Admin: Get all organizations with details
  async adminGetAllOrgs(): Promise<Array<Organization & { member_count: number }>> {
    const orgIds = await this.collectAllOrgIds();

    // Fetch org details in parallel
    const orgResults = await Promise.all(
      Array.from(orgIds).map(async (orgId) => {
        using orgStub = asDisposable(this.env.ORG.get(this.env.ORG.idFromName(orgId)));
        const [info, memberCount] = await Promise.all([
          orgStub.getInfo(),
          orgStub.getMemberCount(),
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
          member_count: memberCount,
        };
      })
    );

    const orgs = orgResults.filter(
      (org): org is NonNullable<(typeof orgResults)[number]> => org !== null
    );
    orgs.sort((a, b) => b.created_at - a.created_at);
    return orgs;
  }

  // Admin: Get all threads across all orgs
  async adminGetAllThreads(): Promise<Array<Thread & { org_id: string; workspace_id: string }>> {
    const workspaces = await this.collectAllWorkspaceIds();

    // Fetch threads from all workspaces in parallel
    const threadResults = await Promise.all(
      workspaces.map(async ({ workspaceId, orgId }) => {
        using indexStub = asDisposable(getIndexStub(this.env, workspaceId));
        const threads = await indexStub.getThreads();
        return threads.map((thread) => ({ ...thread, org_id: orgId, workspace_id: workspaceId }));
      })
    );

    const allThreads = threadResults.flat();
    allThreads.sort((a, b) => b.updated_at - a.updated_at);
    return allThreads;
  }

  // Admin: Get thread with messages and preview workers
  async adminGetThreadWithMessages(
    threadId: string
  ): Promise<{ thread: Thread; messages: Message[]; org_id: string; workspace_id: string; preview_workers: string[] } | null> {
    const workspaces = await this.collectAllWorkspaceIds();

    // Search for thread in all workspaces in parallel
    const results = await Promise.all(
      workspaces.map(async ({ workspaceId, orgId }) => {
        using indexStub = asDisposable(getIndexStub(this.env, workspaceId));
        const thread = await indexStub.getThread(threadId);
        if (thread) {
          // Read messages from container and preview workers in parallel
          const [messages, preview_workers] = await Promise.all([
            this.getMessages(threadId, workspaceId),
            this.getThreadPreview(threadId),
          ]);
          return { thread, messages, org_id: orgId, workspace_id: workspaceId, preview_workers };
        }
        return null;
      })
    );

    return results.find((r) => r !== null) || null;
  }

  // Admin: Update thread
  async adminUpdateThread(
    threadId: string,
    updates: { title?: string }
  ): Promise<Thread | null> {
    const workspaces = await this.collectAllWorkspaceIds();

    // Search for thread in all workspaces in parallel
    const results = await Promise.all(
      workspaces.map(async ({ workspaceId }) => {
        using indexStub = asDisposable(getIndexStub(this.env, workspaceId));
        const thread = await indexStub.getThread(threadId);
        if (thread && updates.title !== undefined) {
          return indexStub.updateThread(threadId, updates.title);
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

    // Get all users first (we need the full list to know total)
    const overview = await this.getAdminOverview();
    const total = overview.users.length;

    // Apply pagination
    const items = overview.users.slice(offset, offset + limit);

    return { items, total, offset, limit };
  }

  // Admin: Get paginated organizations
  async adminGetOrgsPaginated(
    params: PaginationParams = {}
  ): Promise<PaginatedResult<Organization & { member_count: number }>> {
    const { offset = 0, limit = 50 } = params;

    // Get all orgs first
    const allOrgs = await this.adminGetAllOrgs();
    const total = allOrgs.length;

    // Apply pagination
    const items = allOrgs.slice(offset, offset + limit);

    return { items, total, offset, limit };
  }

  // Admin: Get paginated threads
  async adminGetThreadsPaginated(
    params: PaginationParams = {}
  ): Promise<PaginatedResult<Thread & { org_id: string; workspace_id: string }>> {
    const { offset = 0, limit = 50 } = params;

    // Get all threads first
    const allThreads = await this.adminGetAllThreads();
    const total = allThreads.length;

    // Apply pagination
    const items = allThreads.slice(offset, offset + limit);

    return { items, total, offset, limit };
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
    return stub.isMember(userId);
  }

  async isOrgAdmin(userId: string, orgId: string): Promise<boolean> {
    using stub = asDisposable(this.env.ORG.get(this.env.ORG.idFromName(orgId)));
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

  async updateOrgMemberRole(orgId: string, userId: string, role: OrgRole, actorId: string): Promise<void> {
    if (role === 'owner') {
      throw new Error('Use transferOwnership to assign owner role');
    }
    using orgStub = asDisposable(this.env.ORG.get(this.env.ORG.idFromName(orgId)));
    await orgStub.updateMemberRole(userId, role, actorId);

    using userStub = asDisposable(this.env.USER.get(this.env.USER.idFromName(userId)));
    await userStub.updateOrgRole(orgId, role);
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
    return invitations.map((inv) => ({
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
    const info = await workspaceStub.archive(actorId);
    if (!info) return null;

    using orgStub = asDisposable(this.env.ORG.get(this.env.ORG.idFromName(info.org_id)));
    await orgStub.archiveWorkspace(workspaceId);

    return this.toWorkspace(info);
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

  async archiveOrg(orgId: string, actorId: string): Promise<void> {
    using orgStub = asDisposable(this.env.ORG.get(this.env.ORG.idFromName(orgId)));
    const members = await orgStub.getMembers();
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
      members.map((member) => orgStub.removeMember(member.user_id, actorId))
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

  // Chat functions
  async getThreads(workspaceId: string): Promise<Thread[]> {
    using indexStub = asDisposable(getIndexStub(this.env, workspaceId));
    return indexStub.getThreads();
  }

  async getThreadsPaginated(
    workspaceId: string,
    params: PaginationParams = {}
  ): Promise<PaginatedResult<Thread>> {
    const offset = params.offset ?? 0;
    const limit = params.limit ?? 50;
    using indexStub = asDisposable(getIndexStub(this.env, workspaceId));
    return indexStub.getThreadsPaginated(offset, limit);
  }

  async createThread(
    workspaceId: string,
    title: string | undefined,
    createdBy?: string,
    sessionId?: string
  ): Promise<Thread> {
    using indexStub = asDisposable(getIndexStub(this.env, workspaceId));
    return indexStub.createThread(title, createdBy, sessionId);
  }

  async getThread(id: string, workspaceId: string): Promise<Thread | null> {
    using indexStub = asDisposable(getIndexStub(this.env, workspaceId));
    return indexStub.getThread(id);
  }

  async updateThread(id: string, title: string, workspaceId: string): Promise<Thread | null> {
    using indexStub = asDisposable(getIndexStub(this.env, workspaceId));
    return indexStub.updateThread(id, title);
  }

  async deleteThread(id: string, workspaceId: string): Promise<void> {
    // Messages are stored in container JSONL, not in the DO
    // Just delete from the index
    using indexStub = asDisposable(getIndexStub(this.env, workspaceId));
    await indexStub.deleteThread(id);
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
            if (firstContent?.type === 'tool_result') {
              const createdAt = event.timestamp ? new Date(event.timestamp).getTime() : Date.now();
              appendToolResult(event.message.content, createdAt);
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
