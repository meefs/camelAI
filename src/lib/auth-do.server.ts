/**
 * Server-side auth-do functions that accept React Router AppLoadContext.
 * These functions wrap the auth-do module to use context-passed environment.
 */
import type { AppLoadContext } from "react-router";
import type {
  User,
  Organization,
  OrgMembership,
  OrgRole,
  WorkspaceWithAccess,
  AuditLogEntry,
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
  Thread,
  Message,
  PreviewTarget,
} from "@/types";
import { getEnv, type CloudflareEnv } from "./cloudflare.server";
import { type AuthEnv, getAuthEnv } from "./auth-helpers";
import * as authDO from "./auth-do";
import {
  getMessages as getThreadMessages,
  getThreadPreviewTarget,
} from "./chat-do.server";
import { deriveCheapRecentActivityCounts } from "./admin-recent-activity";
import { deleteDispatchScript } from "../../workers/main/src/cf-api-proxy";
import {
  WorkspaceContainer,
  type WorkspaceContainerEnv,
} from "../../workers/main/src/workspace-container";
import {
  type BanRecord,
  type BanScope,
  getOrgBanById,
  getUserBanById,
  putBanRecord,
} from "../../workers/main/src/ban-list";

// Helper: Collect all user IDs from KV
async function collectAllUserIds(env: CloudflareEnv): Promise<string[]> {
  const allKeys: string[] = [];
  let cursor: string | undefined;

  while (true) {
    const list = await env.EMAIL_TO_USER.list({ prefix: "email:", cursor });
    for (const key of list.keys) {
      allKeys.push(key.name);
    }
    if (list.list_complete || !list.cursor) break;
    cursor = list.cursor;
  }

  const userIdResults = await Promise.all(
    allKeys.map((key) => env.EMAIL_TO_USER.get(key)),
  );
  return userIdResults.filter(
    (id): id is string => id !== null && !id.startsWith("{"),
  );
}

// Helper: Collect all org IDs from user memberships
async function collectAllOrgIds(env: CloudflareEnv): Promise<Set<string>> {
  const authEnv = getAuthEnv(env);
  const userIds = await collectAllUserIds(env);
  const orgIds = new Set<string>();

  await Promise.all(
    userIds.map(async (userId) => {
      try {
        const orgs = await authDO.getUserOrgs(authEnv, userId);
        for (const org of orgs) {
          orgIds.add(org.org_id);
        }
      } catch {
        // User may not exist
      }
    }),
  );

  return orgIds;
}

// Helper: Collect all org IDs from raw user membership rows, including archived orgs.
async function collectAllOrgIdsIncludingArchived(
  env: CloudflareEnv,
): Promise<Set<string>> {
  const authEnv = getAuthEnv(env);
  const userIds = await collectAllUserIds(env);
  const orgIds = new Set<string>();

  await Promise.all(
    userIds.map(async (userId) => {
      try {
        const userOrgs = await authEnv.USER.get(
          authEnv.USER.idFromName(userId),
        ).getOrgs();
        for (const org of userOrgs) {
          orgIds.add(org.org_id);
        }
      } catch {
        // User may not exist
      }
    }),
  );

  return orgIds;
}

async function collectOrgIdsFromOrgIndex(
  env: CloudflareEnv,
): Promise<Set<string>> {
  const orgIds = new Set<string>();
  let cursor: string | undefined;

  while (true) {
    const list = await env.APP_KV.list({ prefix: ORG_INDEX_PREFIX, cursor });
    for (const key of list.keys) {
      const orgId = key.name.slice(ORG_INDEX_PREFIX.length);
      if (orgId) {
        orgIds.add(orgId);
      }
    }
    if (list.list_complete || !list.cursor) break;
    cursor = list.cursor;
  }

  return orgIds;
}

const SCRIPT_PREFIX = "script:";
const SCRIPT_ORG_PREFIX_LEGACY = "script_org:";
const SPEND_PREFIX = "spend:";
const ORG_INDEX_PREFIX = "org_index:";
const API_TOKEN_PREFIX = "tok_";
const SESSION_PREFIX = "session:";
const WORKER_SESSION_PREFIX = "worker_session:";
const SCREENSHOT_SESSION_PREFIX = "screenshot_session:";
const ADMIN_INDEX_SYNC_KEY = "admin_index_synced";
const ADMIN_INDEX_SYNC_READY = "1";
const ADMIN_INDEX_SYNC_IN_PROGRESS = "syncing";
const ADMIN_INDEX_SYNC_WAIT_MS = 10_000;
const ADMIN_INDEX_SYNC_POLL_MS = 200;
const SCREENSHOT_TOKEN_PREFIX = "screenshot_token:";
const WORKER_AUTH_STATE_PREFIX = "wauth_state:";
const WORKER_AUTH_TOKEN_PREFIX = "wauth_token:";
const PREVIEW_PREFIX = "app-previews/";
const ORG_MEMBERSHIP_PROBE_CONCURRENCY = 20;
const ORG_MEMBERSHIP_MUTATION_CONCURRENCY = 8;
const BAN_PURGE_JOB_PREFIX = "ban_purge_job:";

export interface BanPurgeJobRecord {
  id: string;
  scope: BanScope;
  target_id: string;
  reason: string;
  created_at: number;
  created_by: string;
  status: "pending" | "running" | "completed" | "failed";
  completed_at: number | null;
  error: string | null;
}

function getBanPurgeJobKey(jobId: string): string {
  return `${BAN_PURGE_JOB_PREFIX}${jobId}`;
}

async function saveBanPurgeJob(
  env: CloudflareEnv,
  job: BanPurgeJobRecord,
): Promise<void> {
  await env.APP_KV.put(getBanPurgeJobKey(job.id), JSON.stringify(job));
}

async function getBanRecordByScope(
  env: CloudflareEnv,
  scope: BanScope,
  targetId: string,
): Promise<BanRecord | null> {
  return scope === "user"
    ? getUserBanById(env.APP_KV, targetId)
    : getOrgBanById(env.APP_KV, targetId);
}

async function updateBanRecordPurgeStatus(
  env: CloudflareEnv,
  scope: BanScope,
  targetId: string,
  update: Partial<
    Pick<
      BanRecord,
      | "purge_status"
      | "purge_job_id"
      | "purge_started_at"
      | "purge_completed_at"
      | "purge_error"
    >
  >,
): Promise<void> {
  const existing = await getBanRecordByScope(env, scope, targetId);
  if (!existing) return;
  await putBanRecord(env.APP_KV, {
    ...existing,
    ...update,
  });
}

function parseJsonSafely(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}

function sanitizeStorageName(value: string): string {
  return (
    value
      .replace(/[^a-zA-Z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .slice(0, 20) || "x"
  );
}

function isMissingRpcMethodError(error: unknown, methodName: string): boolean {
  return (
    error instanceof TypeError &&
    error.message.includes(`does not implement "${methodName}"`)
  );
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];

  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  const runWorker = async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  };

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

async function deleteKvEntriesWithPrefix(
  kv: KVNamespace,
  prefix: string,
  shouldDelete: (key: string, value: string | null) => boolean,
): Promise<number> {
  let cursor: string | undefined;
  let deleted = 0;

  while (true) {
    const listed = await kv.list({ prefix, cursor });
    const keys = listed.keys.map((entry) => entry.name);
    if (keys.length > 0) {
      const values = await Promise.all(keys.map((key) => kv.get(key)));
      const keysToDelete: string[] = [];

      for (let index = 0; index < keys.length; index += 1) {
        if (shouldDelete(keys[index], values[index])) {
          keysToDelete.push(keys[index]);
        }
      }

      await Promise.all(keysToDelete.map((key) => kv.delete(key)));
      deleted += keysToDelete.length;
    }

    if (listed.list_complete || !listed.cursor) {
      break;
    }
    cursor = listed.cursor;
  }

  return deleted;
}

async function collectOrgIdsForUserFromKvPrefix(
  kv: KVNamespace,
  prefix: string,
  userId: string,
): Promise<Set<string>> {
  const orgIds = new Set<string>();
  let cursor: string | undefined;

  while (true) {
    const listed = await kv.list({ prefix, cursor });
    const keys = listed.keys.map((entry) => entry.name);
    if (keys.length > 0) {
      const values = await Promise.all(keys.map((key) => kv.get(key)));
      for (const value of values) {
        const parsed = parseJsonSafely(value);
        if (parsed?.user_id !== userId) {
          continue;
        }
        if (typeof parsed?.org_id === "string" && parsed.org_id.length > 0) {
          orgIds.add(parsed.org_id);
        }
      }
    }

    if (listed.list_complete || !listed.cursor) {
      break;
    }
    cursor = listed.cursor;
  }

  return orgIds;
}

async function deleteR2Prefix(
  bucket: R2Bucket,
  prefix: string,
): Promise<number> {
  let cursor: string | undefined;
  let deleted = 0;

  while (true) {
    const listed = await bucket.list({ prefix, cursor });
    if (listed.objects.length > 0) {
      await Promise.all(listed.objects.map((obj) => bucket.delete(obj.key)));
      deleted += listed.objects.length;
    }

    if (!listed.truncated || !listed.cursor) {
      break;
    }
    cursor = listed.cursor;
  }

  return deleted;
}

// Admin overview functions
function getAdminIndex(env: CloudflareEnv) {
  const namespace = (env as any).ADMIN_INDEX;
  if (!namespace) {
    throw new Error("ADMIN_INDEX binding is not configured");
  }
  return namespace.get(namespace.idFromName("admin_index")) as any;
}

async function waitForAdminIndexSync(authEnv: AuthEnv): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < ADMIN_INDEX_SYNC_WAIT_MS) {
    const syncState = await authEnv.APP_KV.get(ADMIN_INDEX_SYNC_KEY);
    if (syncState === ADMIN_INDEX_SYNC_READY) {
      return;
    }
    if (syncState !== ADMIN_INDEX_SYNC_IN_PROGRESS) {
      return;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, ADMIN_INDEX_SYNC_POLL_MS),
    );
  }
}

async function performInitialAdminSync(env: CloudflareEnv) {
  const authEnv = getAuthEnv(env);
  const syncState = await authEnv.APP_KV.get(ADMIN_INDEX_SYNC_KEY);
  if (syncState === ADMIN_INDEX_SYNC_READY) {
    return;
  }
  if (syncState === ADMIN_INDEX_SYNC_IN_PROGRESS) {
    await waitForAdminIndexSync(authEnv);
    return;
  }

  await authEnv.APP_KV.put(ADMIN_INDEX_SYNC_KEY, ADMIN_INDEX_SYNC_IN_PROGRESS, {
    expirationTtl: 300,
  });

  try {
    const adminIndex = getAdminIndex(env);
    const userIds = await collectAllUserIds(env);

    // Process users
    for (const userId of userIds) {
      const profile = await authEnv.USER.get(
        authEnv.USER.idFromName(userId),
      ).getProfile();
      if (!profile) {
        continue;
      }
      const orgs = await authDO.getUserOrgs(authEnv, userId);
      await adminIndex.handleEvent({
        type: "user_upsert",
        payload: {
          ...profile,
          org_count: orgs.length,
        },
      });
    }

    // Process orgs
    const orgIds = await collectAllOrgIds(env);
    for (const orgId of orgIds) {
      const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(orgId));
      const [info, members, workspaces, scripts, threads, invitations] =
        await Promise.all([
          authDO.getOrg(authEnv, orgId),
          authDO.getOrgMembers(authEnv, orgId),
          authDO.listOrgWorkspaces(authEnv, orgId),
          orgStub.listWorkerScripts(),
          orgStub.getThreads(),
          authDO.getOrgInvitations(authEnv, orgId),
        ]);

      if (info) {
        await adminIndex.handleEvent({
          type: "org_upsert",
          payload: {
            ...info,
            member_count: members.length,
            workspace_count: workspaces.length,
          },
        });
      }

      for (const member of members) {
        await adminIndex.handleEvent({
          type: 'org_membership_upsert',
          payload: {
            org_id: orgId,
            user_id: member.user.id,
            role: member.role,
            joined_at: member.joined_at,
          },
        });
      }

      const integrationCounts = await Promise.all(
        workspaces.map(
          async (ws) =>
            [
              ws.id,
              (await authDO.listWorkspaceIntegrations(authEnv, ws.id)).length,
            ] as const,
        ),
      );
      const integrationCountByWorkspace = new Map<string, number>(
        integrationCounts,
      );

      for (const ws of workspaces) {
        await adminIndex.handleEvent({
          type: "workspace_upsert",
          payload: {
            ...ws,
            integration_count: integrationCountByWorkspace.get(ws.id) ?? 0,
          },
        });
      }

      for (const script of scripts) {
        await adminIndex.handleEvent({
          type: "app_upsert",
          payload: { ...script, org_id: orgId },
        });
      }

      for (const thread of threads) {
        await adminIndex.handleEvent({
          type: "thread_upsert",
          payload: { ...thread, org_id: orgId },
        });
      }

      for (const inv of invitations) {
        await adminIndex.handleEvent({
          type: "invitation_upsert",
          payload: { ...inv, org_id: orgId },
        });
      }
    }

    await authEnv.APP_KV.put(ADMIN_INDEX_SYNC_KEY, ADMIN_INDEX_SYNC_READY);
  } catch (err) {
    await authEnv.APP_KV.delete(ADMIN_INDEX_SYNC_KEY);
    throw err;
  }
}

export async function ensureAdminIndexReady(env: CloudflareEnv): Promise<void> {
  const authEnv = getAuthEnv(env);
  const syncState = await authEnv.APP_KV.get(ADMIN_INDEX_SYNC_KEY);
  if (syncState === ADMIN_INDEX_SYNC_READY) {
    return;
  }

  await performInitialAdminSync(env);

  const postSyncState = await authEnv.APP_KV.get(ADMIN_INDEX_SYNC_KEY);
  if (postSyncState !== ADMIN_INDEX_SYNC_READY) {
    await waitForAdminIndexSync(authEnv);
  }
}

export async function getAdminOverview(
  context: AppLoadContext,
): Promise<AdminOverview> {
  const env = getEnv(context);

  await ensureAdminIndexReady(env);
  return getAdminIndex(env).getOverview();
}

export async function adminGetAllThreads(
  context: AppLoadContext,
): Promise<AdminThreadWithContext[]> {
  const env = getEnv(context);
  await ensureAdminIndexReady(env);
  return getAdminIndex(env).getAllThreads() as Promise<
    AdminThreadWithContext[]
  >;
}

export async function adminGetAppCount(
  context: AppLoadContext,
): Promise<number> {
  const env = getEnv(context);
  await ensureAdminIndexReady(env);
  return getAdminIndex(env).getAppCount();
}

// Paginated admin functions
export async function adminGetUsersPaginated(
  context: AppLoadContext,
  params: PaginationParams = {},
): Promise<PaginatedResult<AdminUserSummary>> {
  const overview = await getAdminOverview(context);
  const { offset = 0, limit = 50, search } = params;

  let items = overview.users;

  // Apply search filter
  if (search) {
    const lowerSearch = search.toLowerCase();
    items = items.filter(
      (u) =>
        u.email.toLowerCase().includes(lowerSearch) ||
        u.name?.toLowerCase().includes(lowerSearch),
    );
  }

  // Sort by created_at descending
  items.sort((a, b) => b.created_at - a.created_at);

  const total = items.length;
  const paged = items.slice(offset, offset + limit);

  return { items: paged, total, offset, limit };
}

export async function adminGetOrgsPaginated(
  context: AppLoadContext,
  params: PaginationParams = {},
): Promise<
  PaginatedResult<
    Organization & { member_count: number; workspace_count: number }
  >
> {
  const env = getEnv(context);
  const { offset = 0, limit = 50, search } = params;
  await ensureAdminIndexReady(env);
  return getAdminIndex(env).getOrgsPaginated(
    offset,
    limit,
    search,
  ) as Promise<any>;
}

export async function adminGetWorkspacesPaginated(
  context: AppLoadContext,
  params: PaginationParams = {},
): Promise<PaginatedResult<AdminWorkspaceSummary>> {
  const env = getEnv(context);
  const { offset = 0, limit = 50, search } = params;
  await ensureAdminIndexReady(env);
  return getAdminIndex(env).getWorkspacesPaginated(
    offset,
    limit,
    search,
  ) as Promise<any>;
}

export async function adminGetWorkspacesByOrg(
  context: AppLoadContext,
  orgId: string,
): Promise<AdminWorkspaceSummary[]> {
  const env = getEnv(context);
  await ensureAdminIndexReady(env);
  return getAdminIndex(env).getWorkspacesByOrg(orgId) as Promise<any>;
}

export async function adminGetThreadsPaginated(
  context: AppLoadContext,
  params: PaginationParams = {},
): Promise<PaginatedResult<AdminThreadWithContext>> {
  const env = getEnv(context);
  const { offset = 0, limit = 50, search } = params;
  await ensureAdminIndexReady(env);
  return getAdminIndex(env).getThreadsPaginated(
    offset,
    limit,
    search,
  ) as Promise<any>;
}

export async function adminGetAppsPaginated(
  context: AppLoadContext,
  params: PaginationParams = {},
): Promise<PaginatedResult<AdminAppSummary>> {
  const env = getEnv(context);
  const { offset = 0, limit = 50, search } = params;
  await ensureAdminIndexReady(env);
  const paged = await (getAdminIndex(env).getAppsPaginated(
    offset,
    limit,
    search,
  ) as Promise<PaginatedResult<AdminAppSummary>>);
  const missingSlugOrgIds = Array.from(
    new Set(
      paged.items
        .filter((app) => !app.org_slug)
        .map((app) => app.org_id)
        .filter(
          (orgId): orgId is string =>
            typeof orgId === "string" && orgId.length > 0,
        ),
    ),
  );
  if (missingSlugOrgIds.length === 0) {
    return paged;
  }

  const authEnv = getAuthEnv(env);
  const slugEntries = await Promise.all(
    missingSlugOrgIds.map(async (orgId) => {
      try {
        const org = await authDO.getOrg(authEnv, orgId);
        return [orgId, org?.slug ?? null] as const;
      } catch {
        return [orgId, null] as const;
      }
    }),
  );
  const orgSlugById = new Map<string, string | null>(slugEntries);

  return {
    ...paged,
    items: paged.items.map((app) => ({
      ...app,
      org_slug: app.org_slug ?? orgSlugById.get(app.org_id) ?? null,
    })),
  };
}

export async function adminGetThreadContextById(
  context: AppLoadContext,
  threadId: string,
): Promise<AdminThreadWithContext | null> {
  const env = getEnv(context);
  await ensureAdminIndexReady(env);
  return getAdminIndex(env).getThreadContextById(threadId) as Promise<any>;
}

export async function adminGetOrgRecentActivity(
  context: AppLoadContext,
  orgId: string,
  options: {
    threadLimit?: number;
    appLimit?: number;
    includeCounts?: boolean | "cheap";
  } = {},
): Promise<{
  threads: AdminThreadWithContext[];
  apps: AdminAppSummary[];
  threadCount: number | null;
  appCount: number | null;
}> {
  const env = getEnv(context);
  await ensureAdminIndexReady(env);

  const threadLimit = Math.max(
    1,
    Math.min(100, Math.floor(options.threadLimit ?? 10)),
  );
  const appLimit = Math.max(
    1,
    Math.min(100, Math.floor(options.appLimit ?? 10)),
  );
  const includeCounts = options.includeCounts ?? "cheap";

  if (includeCounts === false) {
    return getAdminIndex(env).getOrgRecentActivity(
      orgId,
      threadLimit,
      appLimit,
      false,
    ) as Promise<any>;
  }

  if (includeCounts === true) {
    return getAdminIndex(env).getOrgRecentActivity(
      orgId,
      threadLimit,
      appLimit,
      true,
    ) as Promise<any>;
  }

  const recent = (await getAdminIndex(env).getOrgRecentActivity(
    orgId,
    threadLimit,
    appLimit,
    false,
  )) as {
    threads: AdminThreadWithContext[];
    apps: AdminAppSummary[];
  };
  const cheapCounts = deriveCheapRecentActivityCounts({
    recentThreadCount: recent.threads.length,
    threadLimit,
    recentAppCount: recent.apps.length,
    appLimit,
  });

  return {
    threads: recent.threads,
    apps: recent.apps,
    threadCount: cheapCounts.threadCount,
    appCount: cheapCounts.appCount,
  };
}

export async function adminGetInvitationsPaginated(
  context: AppLoadContext,
  params: PaginationParams = {},
): Promise<PaginatedResult<AdminInvitation>> {
  const env = getEnv(context);
  const { offset = 0, limit = 50, search } = params;
  await ensureAdminIndexReady(env);
  return getAdminIndex(env).getInvitationsPaginated(
    offset,
    limit,
    search,
  ) as Promise<any>;
}

// Admin detail functions
export async function adminGetThreadWithMessages(
  context: AppLoadContext,
  threadId: string,
): Promise<{
  thread: { id: string; title: string; model: Thread['model']; created_by: string; created_at: number; updated_at: number };
  messages: Message[];
  org_id: string;
  workspace_id: string;
  org_name: string;
  workspace_name: string;
  preview_target: PreviewTarget | null;
} | null> {
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const threadContext = await adminGetThreadContextById(context, threadId);
  if (!threadContext) return null;

  const orgId = threadContext.org_id;
  const thread = await authEnv.ORG.get(authEnv.ORG.idFromName(orgId)).getThread(
    threadId,
  );
  if (!thread || thread.workspace_id !== threadContext.workspace_id) {
    return null;
  }

  const [messages, preview_target] = await Promise.all([
    getThreadMessages(context, threadId, thread.workspace_id),
    getThreadPreviewTarget(context, threadId),
  ]);

  return {
    thread: {
      id: thread.id,
      title: thread.title || 'Untitled',
      model: thread.model,
      created_by: thread.created_by,
      created_at: thread.created_at,
      updated_at: thread.updated_at,
    },
    messages,
    org_id: orgId,
    workspace_id: thread.workspace_id,
    org_name: threadContext.org_name || "Unknown",
    workspace_name: threadContext.workspace_name || "Unknown",
    preview_target,
  };
}

export async function adminGetWorkspaceDetail(
  context: AppLoadContext,
  workspaceId: string,
): Promise<AdminWorkspaceDetail | null> {
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);

  const workspace = await authDO.getWorkspace(authEnv, workspaceId);
  if (!workspace) return null;

  const [org, orgThreads, integrations, members] = await Promise.all([
    authDO.getOrg(authEnv, workspace.org_id),
    authEnv.ORG.get(authEnv.ORG.idFromName(workspace.org_id)).getThreads(),
    authDO.listWorkspaceIntegrations(authEnv, workspaceId),
    authEnv.WORKSPACE.get(
      authEnv.WORKSPACE.idFromName(workspaceId),
    ).listRestrictedMembers(),
  ]);

  if (!org) return null;

  // Filter threads to this workspace and map to Thread type
  const threads: Thread[] = orgThreads
    .filter((t) => t.workspace_id === workspaceId)
    .map((t) => ({
      id: t.id,
      workspace_id: t.workspace_id,
      title: t.title,
      provider: t.provider ?? 'claude',
      model: t.model,
      created_by: t.created_by,
      created_at: t.created_at,
      updated_at: t.updated_at,
      user_message_count: t.user_message_count ?? 0,
      first_user_message: t.first_user_message ?? null,
    }));

  return {
    workspace,
    org,
    threads,
    integrations,
    members,
  };
}

export async function adminGetAppDetail(
  context: AppLoadContext,
  scriptName: string,
): Promise<AdminAppDetail | null> {
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const orgIds = await collectAllOrgIds(env);

  for (const orgId of orgIds) {
    try {
      const scripts = await authEnv.ORG.get(
        authEnv.ORG.idFromName(orgId),
      ).listWorkerScripts();
      const script = scripts.find((s) => s.script_name === scriptName);

      if (script) {
        const [orgInfo, workspaces, creator] = await Promise.all([
          authDO.getOrg(authEnv, orgId),
          authDO.listOrgWorkspaces(authEnv, orgId),
          authEnv.USER.get(
            authEnv.USER.idFromName(script.created_by),
          ).getProfile(),
        ]);

        const workspaceMap = new Map(workspaces.map((ws) => [ws.id, ws.name]));

        return {
          ...script,
          org_id: orgId,
          org_name: orgInfo?.name || "Unknown",
          org_slug: orgInfo?.slug ?? null,
          workspace_name: workspaceMap.get(script.workspace_id) || "Unknown",
          created_by_name: creator?.name ?? null,
          created_by_email: creator?.email ?? null,
        };
      }
    } catch {
      // Continue searching
    }
  }

  return null;
}

export interface AdminHardDeleteOrgResult {
  deleted_workspaces: number;
  deleted_apps: number;
  removed_memberships: number;
  warnings: string[];
}

/**
 * Permanently delete an organization and all related records.
 * This is superuser-only and intended for test account resets.
 */
export async function hardDeleteAdminOrg(
  context: AppLoadContext,
  orgId: string,
  actorId = "system-admin",
): Promise<AdminHardDeleteOrgResult> {
  return hardDeleteAdminOrgWithEnv(getEnv(context), orgId, actorId);
}

export async function hardDeleteAdminOrgWithEnv(
  env: CloudflareEnv,
  orgId: string,
  actorId = "system-admin",
): Promise<AdminHardDeleteOrgResult> {
  const authEnv = getAuthEnv(env);
  const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(orgId));
  const warnings: string[] = [];

  const [orgInfo, workspaceRows, workerScripts] = await Promise.all([
    orgStub.getInfo(),
    orgStub.getWorkspaces(),
    orgStub.listWorkerScripts(),
  ]);

  if (!orgInfo) {
    throw new Error("Organization not found");
  }

  const workspaceIdSet = new Set(
    workspaceRows.map((workspace) => workspace.id),
  );
  for (const script of workerScripts) {
    workspaceIdSet.add(script.workspace_id);
  }
  const workspaceIds = Array.from(workspaceIdSet);
  const scriptNames = workerScripts.map((script) => script.script_name);

  // Delete deployed dispatch scripts first to avoid orphaned public apps.
  if (scriptNames.length > 0) {
    const accountId = env.CF_ACCOUNT_ID;
    const dispatchNamespace = env.CF_DISPATCH_NAMESPACE;
    const apiToken = env.CF_API_TOKEN;

    if (!accountId || !dispatchNamespace || !apiToken) {
      throw new Error(
        "Cannot delete org with deployed apps: missing Cloudflare dispatch credentials",
      );
    }

    const failedDeletes: string[] = [];
    await Promise.all(
      scriptNames.map(async (scriptName) => {
        const candidateScriptNames = new Set<string>([
          `${orgInfo.slug}--${scriptName}`,
          scriptName,
        ]);

        for (const candidateScriptName of candidateScriptNames) {
          const ok = await deleteDispatchScript(
            accountId,
            dispatchNamespace,
            candidateScriptName,
            apiToken,
          );
          if (!ok) {
            failedDeletes.push(candidateScriptName);
          }
        }
      }),
    );

    if (failedDeletes.length > 0) {
      throw new Error(
        `Failed to delete ${failedDeletes.length} dispatch script(s): ${failedDeletes.slice(0, 3).join(", ")}`,
      );
    }
  }

  // Purge each workspace sandbox and then hard-delete the WorkspaceDO.
  for (const workspaceId of workspaceIds) {
    const container = new WorkspaceContainer(
      env as unknown as WorkspaceContainerEnv,
      workspaceId,
      orgId,
    );
    const purgeResult = await container.purgeWorkspace("admin_org_delete");
    if (!purgeResult.success) {
      throw new Error(
        `Failed to purge workspace sandbox ${workspaceId.slice(0, 8)}: ${purgeResult.error ?? "unknown error"}`,
      );
    }

    const workspaceStub = authEnv.WORKSPACE.get(
      authEnv.WORKSPACE.idFromName(workspaceId),
    );
    try {
      await workspaceStub.hardDeleteWorkspace(actorId);
    } catch (error) {
      if (isMissingRpcMethodError(error, "hardDeleteWorkspace")) {
        throw new Error(
          "Workspace Durable Object is running old code (missing hardDeleteWorkspace). Restart `bun run dev` or deploy the latest main worker, then retry delete.",
        );
      }
      throw error;
    }
  }

  // Remove org memberships from all users to prevent stale user->org links.
  const allUserIds = await collectAllUserIds(env);
  const membershipResults = await Promise.all(
    allUserIds.map(async (userId) => {
      const userStub = authEnv.USER.get(authEnv.USER.idFromName(userId));
      const hasOrg = await userStub.hasOrg(orgId);
      if (!hasOrg) return false;

      await userStub.removeOrg(orgId);

      const remainingOrgs = await userStub.getOrgs();
      const isOrphaned = remainingOrgs.length === 0;
      await userStub.setOrphaned(isOrphaned);

      // For test-account reset flows, clear onboarding when a user has no orgs left.
      if (isOrphaned) {
        try {
          await authDO.resetOnboardingForUser(authEnv, userId);
        } catch (error) {
          warnings.push(
            `Failed to reset onboarding for user ${userId.slice(0, 8)}: ${toErrorMessage(error)}`,
          );
        }
      }

      return true;
    }),
  );
  const removedMemberships = membershipResults.filter(Boolean).length;

  // Finally, wipe org DO state and release slug ownership.
  try {
    await orgStub.hardDeleteOrg(actorId);
  } catch (error) {
    if (isMissingRpcMethodError(error, "hardDeleteOrg")) {
      throw new Error(
        "Organization Durable Object is running old code (missing hardDeleteOrg). Restart `bun run dev` or deploy the latest main worker, then retry delete.",
      );
    }
    throw error;
  }

  // Best-effort cleanup of related KV indexes and sessions.
  const dispatchNames = scriptNames.map(
    (scriptName) => `${orgInfo.slug}--${scriptName}`,
  );
  await Promise.all([
    authEnv.APP_KV.delete(`${SPEND_PREFIX}${orgId}`),
    ...dispatchNames.map((dispatchName) =>
      authEnv.APP_KV.delete(`${SCRIPT_PREFIX}${dispatchName}`),
    ),
    ...scriptNames.map((scriptName) =>
      authEnv.APP_KV.delete(`${SCRIPT_ORG_PREFIX_LEGACY}${scriptName}`),
    ),
  ]);

  try {
    await deleteKvEntriesWithPrefix(
      authEnv.APP_KV,
      SCRIPT_PREFIX,
      (_key, value) => {
        const parsed = parseJsonSafely(value);
        return parsed?.org_id === orgId;
      },
    );
  } catch (error) {
    warnings.push(
      `Failed to clean script ownership index: ${toErrorMessage(error)}`,
    );
  }

  try {
    await deleteKvEntriesWithPrefix(
      authEnv.APP_KV,
      SCRIPT_ORG_PREFIX_LEGACY,
      (_key, value) => {
        if (!value) return false;
        if (value === orgId) return true;
        const parsed = parseJsonSafely(value);
        return parsed?.org_id === orgId;
      },
    );
  } catch (error) {
    warnings.push(
      `Failed to clean legacy script index: ${toErrorMessage(error)}`,
    );
  }

  try {
    await deleteKvEntriesWithPrefix(
      authEnv.APP_KV,
      API_TOKEN_PREFIX,
      (_key, value) => {
        const parsed = parseJsonSafely(value);
        return parsed?.org_id === orgId;
      },
    );
  } catch (error) {
    warnings.push(`Failed to clean API tokens: ${toErrorMessage(error)}`);
  }

  try {
    await deleteKvEntriesWithPrefix(
      authEnv.APP_KV,
      SCREENSHOT_TOKEN_PREFIX,
      (_key, value) => {
        const parsed = parseJsonSafely(value);
        return parsed?.org_id === orgId;
      },
    );
  } catch (error) {
    warnings.push(
      `Failed to clean screenshot tokens: ${toErrorMessage(error)}`,
    );
  }

  try {
    await deleteKvEntriesWithPrefix(
      authEnv.APP_KV,
      WORKER_AUTH_STATE_PREFIX,
      (_key, value) => {
        const parsed = parseJsonSafely(value);
        return parsed?.required_org_id === orgId;
      },
    );
  } catch (error) {
    warnings.push(
      `Failed to clean worker auth state: ${toErrorMessage(error)}`,
    );
  }

  try {
    await deleteKvEntriesWithPrefix(
      authEnv.APP_KV,
      WORKER_AUTH_TOKEN_PREFIX,
      (_key, value) => {
        const parsed = parseJsonSafely(value);
        return parsed?.org_id === orgId;
      },
    );
  } catch (error) {
    warnings.push(
      `Failed to clean worker auth tokens: ${toErrorMessage(error)}`,
    );
  }

  try {
    await deleteKvEntriesWithPrefix(
      authEnv.SESSIONS,
      SESSION_PREFIX,
      (_key, value) => {
        const parsed = parseJsonSafely(value);
        return parsed?.org_id === orgId;
      },
    );
  } catch (error) {
    warnings.push(`Failed to clean user sessions: ${toErrorMessage(error)}`);
  }

  try {
    await deleteKvEntriesWithPrefix(
      authEnv.SESSIONS,
      WORKER_SESSION_PREFIX,
      (_key, value) => {
        const parsed = parseJsonSafely(value);
        return parsed?.org_id === orgId;
      },
    );
  } catch (error) {
    warnings.push(`Failed to clean worker sessions: ${toErrorMessage(error)}`);
  }

  try {
    await deleteKvEntriesWithPrefix(
      authEnv.SESSIONS,
      SCREENSHOT_SESSION_PREFIX,
      (_key, value) => {
        const parsed = parseJsonSafely(value);
        return parsed?.org_id === orgId;
      },
    );
  } catch (error) {
    warnings.push(
      `Failed to clean screenshot sessions: ${toErrorMessage(error)}`,
    );
  }

  // Best-effort cleanup of R2 artifacts (uploads/outputs/previews/workspace storage).
  try {
    await deleteR2Prefix(env.R2_BUCKET, `${PREVIEW_PREFIX}${orgId}/`);
  } catch (error) {
    warnings.push(
      `Failed to clean app previews in R2: ${toErrorMessage(error)}`,
    );
  }

  try {
    await deleteR2Prefix(env.R2_BUCKET, `${orgId}/`);
  } catch (error) {
    warnings.push(
      `Failed to clean workspace uploads/outputs in R2: ${toErrorMessage(error)}`,
    );
  }

  try {
    const orgSafe = sanitizeStorageName(orgId);
    for (const workspaceId of workspaceIds) {
      const wsSafe = sanitizeStorageName(workspaceId);
      await deleteR2Prefix(env.R2_BUCKET, `chiridion-${orgSafe}-${wsSafe}/`);
    }
  } catch (error) {
    warnings.push(
      `Failed to clean workspace storage in R2: ${toErrorMessage(error)}`,
    );
  }

  return {
    deleted_workspaces: workspaceIds.length,
    deleted_apps: scriptNames.length,
    removed_memberships: removedMemberships,
    warnings,
  };
}

// User hard delete
// ---------------------------------------------------------------------------

export interface AdminHardDeleteUserResult {
  removed_org_memberships: number;
  warnings: string[];
}

/**
 * Permanently delete a user and all related records.
 * This is superuser-only and intended for test account cleanup.
 *
 * Steps:
 *  1. Fetch user profile + OAuth providers for cleanup key discovery.
 *  2. Build org probe candidates from org registry + user-scoped hints,
 *     and backfill missing org registry entries from legacy membership data.
 *  3. Fail early if the user still owns any organizations.
 *  4. Verify UserDO hard-delete capability before cross-DO mutations.
 *  5. Remove user from every org membership found in OrgDO.
 *  6. Wipe the UserDO Durable Object storage.
 *  7. Delete EMAIL_TO_USER KV entries (email + oauth provider keys).
 *  8. Delete user sessions from SESSIONS KV and user-bound screenshot sessions.
 *  9. Delete workspace-level ACL rows for this user across all org workspaces.
 *  10. Delete user-scoped worker auth one-time tokens from APP_KV.
 */
export async function hardDeleteAdminUser(
  context: AppLoadContext,
  userId: string,
  actorId = "system-admin",
): Promise<AdminHardDeleteUserResult> {
  return hardDeleteAdminUserWithEnv(getEnv(context), userId, actorId);
}

export async function hardDeleteAdminUserWithEnv(
  env: CloudflareEnv,
  userId: string,
  actorId = "system-admin",
): Promise<AdminHardDeleteUserResult> {
  const authEnv = getAuthEnv(env);
  const userStub = authEnv.USER.get(authEnv.USER.idFromName(userId));
  const warnings: string[] = [];

  // 1. Fetch user data for cleanup keys.
  const [profile, oauthProviders, userOrgs] = await Promise.all([
    userStub.getProfile(),
    userStub.getOAuthProviders(),
    userStub.getOrgs(),
  ]);

  if (!profile) {
    throw new Error("User not found");
  }

  // 2. Build candidate org IDs without relying solely on UserDO<->OrgDO sync.
  const userScopedOrgHints = new Set<string>(userOrgs.map((org) => org.org_id));
  const [
    sessionOrgHints,
    workerSessionOrgHints,
    workerAuthTokenOrgHints,
    indexedOrgIds,
    legacyOrgIds,
  ] = await Promise.all([
    collectOrgIdsForUserFromKvPrefix(authEnv.SESSIONS, SESSION_PREFIX, userId),
    collectOrgIdsForUserFromKvPrefix(
      authEnv.SESSIONS,
      WORKER_SESSION_PREFIX,
      userId,
    ),
    collectOrgIdsForUserFromKvPrefix(
      authEnv.APP_KV,
      WORKER_AUTH_TOKEN_PREFIX,
      userId,
    ),
    collectOrgIdsFromOrgIndex(env),
    collectAllOrgIdsIncludingArchived(env),
  ]);

  for (const orgId of sessionOrgHints) userScopedOrgHints.add(orgId);
  for (const orgId of workerSessionOrgHints) userScopedOrgHints.add(orgId);
  for (const orgId of workerAuthTokenOrgHints) userScopedOrgHints.add(orgId);

  const missingIndexedOrgIds = Array.from(legacyOrgIds).filter(
    (orgId) => !indexedOrgIds.has(orgId),
  );
  if (missingIndexedOrgIds.length > 0) {
    try {
      await Promise.all(
        missingIndexedOrgIds.map((orgId) =>
          authEnv.APP_KV.put(`${ORG_INDEX_PREFIX}${orgId}`, "1"),
        ),
      );
      for (const orgId of missingIndexedOrgIds) {
        indexedOrgIds.add(orgId);
      }
    } catch (error) {
      warnings.push(
        `Failed to backfill org index entries: ${toErrorMessage(error)}`,
      );
    }
  }

  const allProbeOrgIds = new Set<string>(indexedOrgIds);
  for (const orgId of legacyOrgIds) {
    allProbeOrgIds.add(orgId);
  }
  for (const orgId of userScopedOrgHints) {
    allProbeOrgIds.add(orgId);
  }

  const orgMemberships: Array<{ org_id: string; role: OrgRole }> = [];
  const orgMembershipProbeErrors: string[] = [];
  const orgProbeResults = await mapWithConcurrency(
    Array.from(allProbeOrgIds),
    ORG_MEMBERSHIP_PROBE_CONCURRENCY,
    async (orgId) => {
      try {
        const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(orgId));
        const member = await orgStub.getMember(userId);
        if (!member) {
          return null;
        }
        return { org_id: orgId, role: member.role } as {
          org_id: string;
          role: OrgRole;
        };
      } catch (error) {
        return `${orgId.slice(0, 8)}: ${toErrorMessage(error)}`;
      }
    },
  );

  for (const result of orgProbeResults) {
    if (!result) continue;
    if (typeof result === "string") {
      orgMembershipProbeErrors.push(result);
      continue;
    }
    orgMemberships.push(result);
  }
  if (orgMembershipProbeErrors.length > 0) {
    const preview = orgMembershipProbeErrors.slice(0, 3).join("; ");
    const suffix =
      orgMembershipProbeErrors.length > 3
        ? `; and ${orgMembershipProbeErrors.length - 3} more`
        : "";
    throw new Error(
      `Failed to verify org memberships in ${orgMembershipProbeErrors.length} org(s) (${preview}${suffix}). User was not deleted.`,
    );
  }

  // 3. Fail early if the user owns any orgs — removing an owner via
  // removeMember throws, and proceeding would leave a dangling owner
  // reference in the OrgDO after the UserDO is wiped.
  const ownedOrgIds = orgMemberships
    .filter((o) => o.role === "owner")
    .map((o) => o.org_id);
  if (ownedOrgIds.length > 0) {
    const preview = ownedOrgIds
      .slice(0, 3)
      .map((id) => id.slice(0, 8))
      .join(", ");
    const suffix =
      ownedOrgIds.length > 3 ? ` and ${ownedOrgIds.length - 3} more` : "";
    throw new Error(
      `User owns ${ownedOrgIds.length} org(s) (${preview}${suffix}). Transfer ownership or delete those orgs before deleting this user.`,
    );
  }

  // 4. Ensure the target UserDO has the hard-delete RPC before mutating org state.
  try {
    await userStub.canHardDeleteUser();
  } catch (error) {
    if (
      isMissingRpcMethodError(error, "canHardDeleteUser") ||
      isMissingRpcMethodError(error, "hardDeleteUser")
    ) {
      throw new Error(
        "User Durable Object is running old code (missing hardDeleteUser). Restart `bun run dev` or deploy the latest main worker, then retry delete.",
      );
    }
    throw error;
  }

  // 5. Remove user from all orgs first. If any membership cleanup fails,
  // stop before wiping the user record to avoid orphaned org membership rows.
  const removedOrgMemberships: Array<{ org_id: string; role: OrgRole }> = [];
  const orgRemovalErrors: string[] = [];
  const removalResults = await mapWithConcurrency(
    orgMemberships,
    ORG_MEMBERSHIP_MUTATION_CONCURRENCY,
    async (org) => {
      try {
        const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(org.org_id));
        await orgStub.removeMember(userId, actorId);
        return { ok: true as const, org };
      } catch (error) {
        return {
          ok: false as const,
          error: `${org.org_id.slice(0, 8)}: ${toErrorMessage(error)}`,
        };
      }
    },
  );

  for (const result of removalResults) {
    if (result.ok) {
      removedOrgMemberships.push({
        org_id: result.org.org_id,
        role: result.org.role,
      });
      continue;
    }
    orgRemovalErrors.push(result.error);
  }
  if (orgRemovalErrors.length > 0) {
    const rollbackErrors: string[] = [];
    for (const membership of removedOrgMemberships) {
      try {
        const orgStub = authEnv.ORG.get(
          authEnv.ORG.idFromName(membership.org_id),
        );
        await orgStub.addMember(userId, membership.role, actorId);
      } catch (rollbackError) {
        rollbackErrors.push(
          `${membership.org_id.slice(0, 8)}: ${toErrorMessage(rollbackError)}`,
        );
      }
    }

    const preview = orgRemovalErrors.slice(0, 3).join("; ");
    const suffix =
      orgRemovalErrors.length > 3
        ? `; and ${orgRemovalErrors.length - 3} more`
        : "";
    const rollbackSummary =
      rollbackErrors.length > 0
        ? ` Also failed to restore ${rollbackErrors.length} removed membership(s) (${rollbackErrors.slice(0, 3).join("; ")}${rollbackErrors.length > 3 ? `; and ${rollbackErrors.length - 3} more` : ""}). Manual repair required.`
        : "";
    throw new Error(
      `Failed to remove user from ${orgRemovalErrors.length} org(s) (${preview}${suffix}). User was not deleted. Resolve membership cleanup and retry.${rollbackSummary}`,
    );
  }

  // 6. Wipe UserDO state. If this fails, restore removed org memberships.
  try {
    await userStub.hardDeleteUser();
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const membership of removedOrgMemberships) {
      try {
        const orgStub = authEnv.ORG.get(
          authEnv.ORG.idFromName(membership.org_id),
        );
        await orgStub.addMember(userId, membership.role, actorId);
      } catch (rollbackError) {
        rollbackErrors.push(
          `${membership.org_id.slice(0, 8)}: ${toErrorMessage(rollbackError)}`,
        );
      }
    }

    const rollbackSummary =
      rollbackErrors.length > 0
        ? `Also failed to restore ${rollbackErrors.length} org membership(s) (${rollbackErrors.slice(0, 3).join("; ")}${rollbackErrors.length > 3 ? `; and ${rollbackErrors.length - 3} more` : ""}). Manual repair required.`
        : "Removed org memberships were restored.";

    if (isMissingRpcMethodError(error, "hardDeleteUser")) {
      throw new Error(
        `User Durable Object is running old code (missing hardDeleteUser). Restart \`bun run dev\` or deploy the latest main worker, then retry delete. ${rollbackSummary}`,
      );
    }
    throw new Error(
      `Failed to wipe UserDO state: ${toErrorMessage(error)} ${rollbackSummary}`,
    );
  }

  // Keep AdminIndexDO aligned with UserDO + EMAIL_TO_USER cleanup.
  try {
    await getAdminIndex(env).handleEvent({
      type: "user_delete",
      payload: { id: userId },
    });
  } catch (error) {
    warnings.push(
      `Failed to remove user from admin index: ${toErrorMessage(error)}`,
    );
  }

  // 7. Delete EMAIL_TO_USER KV entries.
  const kvKeysToDelete: string[] = [`email:${profile.email.toLowerCase()}`];
  for (const provider of oauthProviders) {
    kvKeysToDelete.push(`oauth:${provider.provider}:${provider.provider_id}`);
  }
  await Promise.all(
    kvKeysToDelete.map(async (key) => {
      try {
        await authEnv.EMAIL_TO_USER.delete(key);
      } catch (error) {
        warnings.push(
          `Failed to delete EMAIL_TO_USER key "${key}": ${toErrorMessage(error)}`,
        );
      }
    }),
  );

  // Purge any stale oauth:* indexes that still point to this user (covers
  // partial signup/login failures where UserDO provider rows were not written).
  try {
    await deleteKvEntriesWithPrefix(
      authEnv.EMAIL_TO_USER,
      "oauth:",
      (_key, value) => {
        if (value === userId) {
          return true;
        }
        const parsed = parseJsonSafely(value);
        return parsed?.user_id === userId;
      },
    );
  } catch (error) {
    warnings.push(
      `Failed to clean oauth:* EMAIL_TO_USER mappings: ${toErrorMessage(error)}`,
    );
  }

  // 8. Best-effort cleanup of user sessions.
  // Screenshot sessions may be org-scoped and shared across users. Only
  // delete screenshot sessions explicitly bound to this user_id.
  const screenshotSessionOrgIds = new Set<string>(
    orgMemberships.map((org) => org.org_id),
  );
  const sessionPrefixes = [SESSION_PREFIX, WORKER_SESSION_PREFIX] as const;
  for (const prefix of sessionPrefixes) {
    try {
      await deleteKvEntriesWithPrefix(
        authEnv.SESSIONS,
        prefix,
        (_key, value) => {
          const parsed = parseJsonSafely(value);
          if (parsed?.user_id !== userId) {
            return false;
          }
          if (typeof parsed?.org_id === "string") {
            screenshotSessionOrgIds.add(parsed.org_id);
          }
          return true;
        },
      );
    } catch (error) {
      warnings.push(
        `Failed to clean ${prefix}* sessions: ${toErrorMessage(error)}`,
      );
    }
  }

  try {
    await deleteKvEntriesWithPrefix(
      authEnv.SESSIONS,
      SCREENSHOT_SESSION_PREFIX,
      (_key, value) => {
        const parsed = parseJsonSafely(value);
        return parsed?.user_id === userId;
      },
    );
  } catch (error) {
    warnings.push(
      `Failed to clean user-bound ${SCREENSHOT_SESSION_PREFIX}* sessions: ${toErrorMessage(error)}`,
    );
  }

  // 9. Best-effort cleanup of workspace member rows for this user.
  const workspaceAclOrgIds = new Set<string>(
    orgMemberships.map((org) => org.org_id),
  );
  for (const orgId of screenshotSessionOrgIds) {
    workspaceAclOrgIds.add(orgId);
  }
  for (const orgId of userScopedOrgHints) {
    workspaceAclOrgIds.add(orgId);
  }

  for (const orgId of workspaceAclOrgIds) {
    try {
      const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(orgId));
      const workspaces = await orgStub.getWorkspaces(true);
      await Promise.all(
        workspaces.map(async (workspace) => {
          const workspaceStub = authEnv.WORKSPACE.get(
            authEnv.WORKSPACE.idFromName(workspace.id),
          );
          await workspaceStub.removeMember(userId, actorId);
        }),
      );
    } catch (error) {
      warnings.push(
        `Failed to clean workspace member rows in org ${orgId.slice(0, 8)}: ${toErrorMessage(error)}`,
      );
    }
  }

  // 10. Best-effort cleanup of pending worker auth tokens to prevent
  // post-delete token exchange into fresh worker sessions.
  try {
    await deleteKvEntriesWithPrefix(
      authEnv.APP_KV,
      WORKER_AUTH_TOKEN_PREFIX,
      (_key, value) => {
        const parsed = parseJsonSafely(value);
        return parsed?.user_id === userId;
      },
    );
  } catch (error) {
    warnings.push(
      `Failed to clean worker auth tokens: ${toErrorMessage(error)}`,
    );
  }

  return {
    removed_org_memberships: removedOrgMemberships.length,
    warnings,
  };
}

export interface StartAdminBanAndPurgeOptions {
  reason: string;
  actorId?: string;
}

export async function getBanPurgeJobById(
  context: AppLoadContext,
  jobId: string,
): Promise<BanPurgeJobRecord | null> {
  return getBanPurgeJobByIdWithEnv(getEnv(context), jobId);
}

export async function getBanPurgeJobByIdWithEnv(
  env: CloudflareEnv,
  jobId: string,
): Promise<BanPurgeJobRecord | null> {
  const raw = await env.APP_KV.get(getBanPurgeJobKey(jobId));
  return raw ? (JSON.parse(raw) as BanPurgeJobRecord) : null;
}

export async function startAdminOrgBanAndPurgeWithEnv(
  env: CloudflareEnv,
  orgId: string,
  options: StartAdminBanAndPurgeOptions,
): Promise<BanPurgeJobRecord> {
  const authEnv = getAuthEnv(env);
  const actorId = options.actorId ?? "system-admin";
  const reason = options.reason.trim();
  if (!reason) {
    throw new Error("Ban reason is required");
  }
  const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(orgId));
  const orgInfo = await orgStub.getInfo();
  if (!orgInfo) {
    throw new Error("Organization not found");
  }

  const now = Date.now();
  const existingBan = await getOrgBanById(env.APP_KV, orgId);
  const jobId = crypto.randomUUID();
  const record: BanRecord = {
    scope: "org",
    target_id: orgId,
    email: null,
    org_slug: orgInfo.slug ?? null,
    reason,
    created_at: existingBan?.created_at ?? now,
    created_by: existingBan?.created_by ?? actorId,
    status: "active",
    purge_status: "pending",
    purge_job_id: jobId,
    purge_started_at: null,
    purge_completed_at: null,
    purge_error: null,
  };
  await putBanRecord(env.APP_KV, record);

  const members = await orgStub.getMembers();
  await Promise.all(
    members.map(async (member) => {
      try {
        await authEnv.USER.get(
          authEnv.USER.idFromName(member.user_id),
        ).invalidateSessions();
      } catch {
        // best effort
      }
    }),
  );

  const job: BanPurgeJobRecord = {
    id: jobId,
    scope: "org",
    target_id: orgId,
    reason: record.reason,
    created_at: now,
    created_by: actorId,
    status: "pending",
    completed_at: null,
    error: null,
  };
  await saveBanPurgeJob(env, job);
  return job;
}

export async function runAdminOrgBanAndPurgeWithEnv(
  env: CloudflareEnv,
  job: BanPurgeJobRecord,
  actorId = "system-admin",
): Promise<void> {
  const runningJob: BanPurgeJobRecord = {
    ...job,
    status: "running",
    error: null,
  };
  await saveBanPurgeJob(env, runningJob);
  await updateBanRecordPurgeStatus(env, "org", job.target_id, {
    purge_status: "running",
    purge_job_id: job.id,
    purge_started_at: Date.now(),
    purge_completed_at: null,
    purge_error: null,
  });

  try {
    await hardDeleteAdminOrgWithEnv(env, job.target_id, actorId);
    const completedAt = Date.now();
    await saveBanPurgeJob(env, {
      ...runningJob,
      status: "completed",
      completed_at: completedAt,
    });
    await updateBanRecordPurgeStatus(env, "org", job.target_id, {
      purge_status: "completed",
      purge_job_id: job.id,
      purge_completed_at: completedAt,
      purge_error: null,
    });
  } catch (error) {
    const message = toErrorMessage(error);
    await saveBanPurgeJob(env, {
      ...runningJob,
      status: "failed",
      error: message,
      completed_at: Date.now(),
    });
    await updateBanRecordPurgeStatus(env, "org", job.target_id, {
      purge_status: "failed",
      purge_job_id: job.id,
      purge_completed_at: Date.now(),
      purge_error: message,
    });
    throw error;
  }
}

export async function startAdminUserBanAndPurgeWithEnv(
  env: CloudflareEnv,
  userId: string,
  options: StartAdminBanAndPurgeOptions,
): Promise<BanPurgeJobRecord> {
  const authEnv = getAuthEnv(env);
  const actorId = options.actorId ?? "system-admin";
  const reason = options.reason.trim();
  if (!reason) {
    throw new Error("Ban reason is required");
  }
  const userStub = authEnv.USER.get(authEnv.USER.idFromName(userId));
  const profile = await userStub.getProfile();
  if (!profile) {
    throw new Error("User not found");
  }

  const now = Date.now();
  const existingBan = await getUserBanById(env.APP_KV, userId);
  const jobId = crypto.randomUUID();
  const record: BanRecord = {
    scope: "user",
    target_id: userId,
    email: profile.email.toLowerCase(),
    org_slug: null,
    reason,
    created_at: existingBan?.created_at ?? now,
    created_by: existingBan?.created_by ?? actorId,
    status: "active",
    purge_status: "pending",
    purge_job_id: jobId,
    purge_started_at: null,
    purge_completed_at: null,
    purge_error: null,
  };
  await putBanRecord(env.APP_KV, record);

  try {
    await userStub.invalidateSessions();
  } catch {
    // best effort
  }

  const job: BanPurgeJobRecord = {
    id: jobId,
    scope: "user",
    target_id: userId,
    reason: record.reason,
    created_at: now,
    created_by: actorId,
    status: "pending",
    completed_at: null,
    error: null,
  };
  await saveBanPurgeJob(env, job);
  return job;
}

export async function runAdminUserBanAndPurgeWithEnv(
  env: CloudflareEnv,
  job: BanPurgeJobRecord,
  actorId = "system-admin",
): Promise<void> {
  const authEnv = getAuthEnv(env);
  const runningJob: BanPurgeJobRecord = {
    ...job,
    status: "running",
    error: null,
  };
  await saveBanPurgeJob(env, runningJob);
  await updateBanRecordPurgeStatus(env, "user", job.target_id, {
    purge_status: "running",
    purge_job_id: job.id,
    purge_started_at: Date.now(),
    purge_completed_at: null,
    purge_error: null,
  });

  try {
    const userStub = authEnv.USER.get(authEnv.USER.idFromName(job.target_id));
    const userOrgs = await userStub.getOrgs();
    const ownedOrgIds = userOrgs
      .filter((org) => org.role === "owner")
      .map((org) => org.org_id);

    for (const ownedOrgId of ownedOrgIds) {
      const orgJob = await startAdminOrgBanAndPurgeWithEnv(env, ownedOrgId, {
        reason: `Cascade from banned user ${job.target_id}: ${job.reason}`,
        actorId,
      });
      await runAdminOrgBanAndPurgeWithEnv(env, orgJob, actorId);
    }

    await hardDeleteAdminUserWithEnv(env, job.target_id, actorId);
    const completedAt = Date.now();
    await saveBanPurgeJob(env, {
      ...runningJob,
      status: "completed",
      completed_at: completedAt,
    });
    await updateBanRecordPurgeStatus(env, "user", job.target_id, {
      purge_status: "completed",
      purge_job_id: job.id,
      purge_completed_at: completedAt,
      purge_error: null,
    });
  } catch (error) {
    const message = toErrorMessage(error);
    await saveBanPurgeJob(env, {
      ...runningJob,
      status: "failed",
      error: message,
      completed_at: Date.now(),
    });
    await updateBanRecordPurgeStatus(env, "user", job.target_id, {
      purge_status: "failed",
      purge_job_id: job.id,
      purge_completed_at: Date.now(),
      purge_error: message,
    });
    throw error;
  }
}

// Admin org member functions
export async function addAdminOrgMember(
  context: AppLoadContext,
  orgId: string,
  userId: string,
  role: "admin" | "member",
): Promise<void> {
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  // Use a system actor ID for admin operations
  const actorId = "system-admin";
  await authDO.adminAddOrgMember(authEnv, orgId, userId, role, actorId);
}

export async function updateAdminOrgMemberRole(
  context: AppLoadContext,
  orgId: string,
  userId: string,
  role: OrgRole,
): Promise<void> {
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  // Use a system actor ID for admin operations
  const actorId = "system-admin";
  await authDO.updateOrgMemberRole(authEnv, orgId, userId, role, actorId);
}
